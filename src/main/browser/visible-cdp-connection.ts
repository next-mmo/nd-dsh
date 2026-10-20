import type { BrowserState } from '../../shared/contracts.js'
import { guardExpression, pageGuardFromMessage, type PageDriver } from './page-driver.js'

const CDP_CONNECT_TIMEOUT_MS = 5_000
const CDP_CALL_TIMEOUT_MS = 15_000

interface CdpTarget {
  id?: string
  url?: string
  webSocketDebuggerUrl?: string
}

interface CdpResponse {
  id?: number
  result?: {
    result?: { value?: unknown; objectId?: string }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }
  error?: { message?: string }
}

interface PendingCdpCall {
  resolve: (value: CdpResponse['result']) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** The BrowserController surface needed to reach a tab over loopback CDP. */
export interface CdpBrowserHost {
  ensureAgentReady(): Promise<void>
  state(): Pick<BrowserState, 'cdpPort' | 'targetId'>
}

export interface VisibleCdpConnectOptions {
  /** Pin to a CDP target captured at turn start instead of whichever tab is active now. */
  targetId?: string | undefined
  /** Origins every evaluation must run on; empty disables the in-page guard. */
  allowedOrigins?: readonly string[]
}

/**
 * CDP transport for ND's visible browser pane. It only talks to the loopback
 * DevTools endpoint ND itself opened, only to the pinned page target, and
 * wraps every evaluation in an in-page origin guard.
 */
export class VisibleCdpConnection implements PageDriver {
  readonly kind = 'cdp' as const
  private nextId = 1
  private readonly pending = new Map<number, PendingCdpCall>()

  private constructor(
    private readonly socket: WebSocket,
    private readonly allowedOrigins: readonly string[],
  ) {
    socket.onmessage = (event) => {
      let parsed: CdpResponse
      try { parsed = JSON.parse(String(event.data)) as CdpResponse } catch { return }
      if (parsed.id === undefined) return
      const pending = this.pending.get(parsed.id)
      if (!pending) return
      this.pending.delete(parsed.id)
      clearTimeout(pending.timer)
      if (parsed.error?.message) {
        pending.reject(new Error(parsed.error.message))
        return
      }
      const exception = parsed.result?.exceptionDetails
      if (exception) {
        const message = exception.exception?.description ?? exception.text ?? 'CDP Runtime.evaluate failed'
        pending.reject(pageGuardFromMessage(message) ?? new Error(message))
        return
      }
      pending.resolve(parsed.result)
    }
    socket.onclose = () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('Visible browser CDP connection closed'))
      }
      this.pending.clear()
    }
  }

  static async connect(browser: CdpBrowserHost, options: VisibleCdpConnectOptions = {}): Promise<VisibleCdpConnection> {
    await browser.ensureAgentReady()
    const state = browser.state()
    const targetId = options.targetId ?? state.targetId
    if (!targetId) throw new Error('ND visible browser has no CDP target id')
    const port = state.cdpPort
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('ND visible browser has no loopback CDP port')
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(CDP_CONNECT_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`ND visible browser CDP target list failed (${response.status})`)
    const targets = await response.json() as CdpTarget[]
    const target = Array.isArray(targets) ? targets.find((candidate) => candidate.id === targetId) : undefined
    if (!target?.webSocketDebuggerUrl) throw new Error('ND visible browser target is not available through loopback CDP')
    const socketUrl = assertLoopbackSocketUrl(target.webSocketDebuggerUrl, port)
    const socket = new WebSocket(socketUrl)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { socket.close() } catch { /* not open yet */ }
        reject(new Error('Timed out connecting to ND visible browser CDP'))
      }, CDP_CONNECT_TIMEOUT_MS)
      socket.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error('Could not connect to ND visible browser CDP'))
      }
    })
    return new VisibleCdpConnection(socket, options.allowedOrigins ?? [])
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.call('Runtime.evaluate', {
      expression: guardExpression(expression, this.allowedOrigins),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    return result?.result?.value as T
  }

  /** Assign real files to a page file input through Chromium's DOM domain. */
  async setFilesOnInput(expression: string, files: string[]): Promise<boolean> {
    const result = await this.call('Runtime.evaluate', {
      expression: guardExpression(expression, this.allowedOrigins),
      returnByValue: false,
      awaitPromise: true,
      userGesture: true,
    })
    const objectId = result?.result?.objectId
    if (!objectId) return false
    await this.call('DOM.setFileInputFiles', { files, objectId })
    return true
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Visible browser CDP connection closed'))
    }
    this.pending.clear()
    try { this.socket.close() } catch { /* already closed */ }
  }

  private async call(method: string, params: Record<string, unknown>): Promise<CdpResponse['result']> {
    const id = this.nextId++
    const promise = new Promise<CdpResponse['result']>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Visible browser CDP call timed out after ${CDP_CALL_TIMEOUT_MS}ms`))
      }, CDP_CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
    })
    try {
      this.socket.send(JSON.stringify({ id, method, params }))
    } catch (error) {
      const pending = this.pending.get(id)
      if (pending) clearTimeout(pending.timer)
      this.pending.delete(id)
      throw error
    }
    return await promise
  }
}

/** Only accept the DevTools socket ND opened: ws:// on loopback, on ND's port. */
export function assertLoopbackSocketUrl(value: string, port: number): string {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('ND visible browser returned an invalid CDP socket URL') }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'
  if (parsed.protocol !== 'ws:' || !loopback || parsed.port !== String(port) || !parsed.pathname.startsWith('/devtools/page/')) {
    throw new Error('ND visible browser CDP socket is not on ND\'s loopback endpoint')
  }
  return parsed.toString()
}
