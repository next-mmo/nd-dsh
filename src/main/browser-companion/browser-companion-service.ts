import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import {
  BROWSER_COMPANION_PROTOCOL_VERSION,
  type BrowserCompanionBrowser,
  type BrowserCompanionLeaseScope,
  type BrowserCompanionState,
  type BrowserTabLease,
} from '../../shared/browser-companion.js'
import { BrowserConnectionStore } from './browser-connection-store.js'
import { BrowserTabLeaseStore } from './browser-tab-leases.js'

const MAX_LINE_BYTES = 8 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 20_000

type ClientKind = 'native-host' | 'agent'

interface ClientState {
  socket: Socket
  buffer: string
  authenticated: boolean
  kind?: ClientKind
  connectionId?: string
}

interface PendingRequest {
  connectionId: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export interface BrowserCompanionServiceOptions {
  dataPath: string
  discoveryPath?: string
  endpoint?: string
  runtimePath?: string
}

export class BrowserCompanionService {
  private readonly discoveryPath: string
  private readonly endpoint: string
  private readonly token = randomBytes(32).toString('hex')
  private readonly connections: BrowserConnectionStore
  private readonly runtimePath: string | undefined
  private readonly leases = new BrowserTabLeaseStore()
  private readonly clients = new Set<ClientState>()
  private readonly nativeByConnection = new Map<string, ClientState>()
  private readonly pending = new Map<string, PendingRequest>()
  private server: Server | undefined
  private listener: ((state: BrowserCompanionState) => void) | undefined
  private agentDispatcher: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined

  constructor(options: BrowserCompanionServiceOptions) {
    const runtimeDir = join(homedir(), '.nd-dsh')
    this.discoveryPath = options.discoveryPath ?? join(runtimeDir, 'browser-companion.json')
    this.endpoint = options.endpoint ?? defaultEndpoint(dirname(this.discoveryPath), options.discoveryPath ?? homedir())
    this.runtimePath = options.runtimePath
    this.connections = new BrowserConnectionStore(join(options.dataPath, 'browser-companion-connections.json'))
  }

  async start(): Promise<void> {
    if (this.server) return
    await this.connections.markAllDisconnected()
    await fs.mkdir(dirname(this.discoveryPath), { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await fs.rm(this.endpoint, { force: true }).catch(() => undefined)

    const server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(this.endpoint, () => {
        server.off('error', onError)
        resolve()
      })
    })

    this.server = server
    const discovery = {
      version: BROWSER_COMPANION_PROTOCOL_VERSION,
      endpoint: this.endpoint,
      token: this.token,
      pid: process.pid,
      updatedAt: Date.now(),
    }
    await fs.writeFile(this.discoveryPath, `${JSON.stringify(discovery, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    process.env.ND_BROWSER_COMPANION_DISCOVERY = this.discoveryPath
    if (this.runtimePath) process.env.ND_BROWSER_COMPANION_RUNTIME = this.runtimePath
    await this.emit()
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    for (const client of this.clients) client.socket.destroy()
    this.clients.clear()
    this.nativeByConnection.clear()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Browser companion is shutting down'))
    }
    this.pending.clear()
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await this.connections.markAllDisconnected()
    await fs.rm(this.discoveryPath, { force: true }).catch(() => undefined)
    if (process.platform !== 'win32') await fs.rm(this.endpoint, { force: true }).catch(() => undefined)
  }

  setListener(listener: ((state: BrowserCompanionState) => void) | undefined): void {
    this.listener = listener
    if (listener) void this.state().then(listener).catch(() => undefined)
  }

  setAgentDispatcher(dispatcher: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined): void {
    this.agentDispatcher = dispatcher
  }

  async state(): Promise<BrowserCompanionState> {
    return {
      connections: await this.connections.list(),
      leases: this.leases.list(),
      discoveryPath: this.discoveryPath,
    }
  }

  async connectedConnections(): Promise<BrowserCompanionState['connections']> {
    return (await this.connections.list()).filter((item) => item.connected)
  }

  async command(connectionId: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const resolved = await this.resolveConnectionId(connectionId)
    return this.requestBrowser(resolved, method, params)
  }

  acquireLease(connectionId: string, tabId: number, ownerId: string, scope?: BrowserCompanionLeaseScope): BrowserTabLease {
    const lease = this.leases.acquire(connectionId, tabId, ownerId, scope)
    void this.emit()
    return lease
  }

  releaseLease(leaseId: string): boolean {
    const released = this.leases.release(leaseId)
    if (released) void this.emit()
    return released
  }

  private accept(socket: Socket): void {
    socket.setEncoding('utf8')
    const state: ClientState = { socket, buffer: '', authenticated: false }
    this.clients.add(state)
    socket.on('data', (chunk: string) => this.onData(state, chunk))
    socket.on('error', () => undefined)
    socket.on('close', () => { void this.onClose(state) })
  }

  private onData(client: ClientState, chunk: string): void {
    client.buffer += chunk
    if (Buffer.byteLength(client.buffer, 'utf8') > MAX_LINE_BYTES) {
      client.socket.destroy(new Error('Browser companion frame exceeded the maximum size'))
      return
    }
    let newline = client.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = client.buffer.slice(0, newline).trim()
      client.buffer = client.buffer.slice(newline + 1)
      if (line) void this.onLine(client, line)
      newline = client.buffer.indexOf('\n')
    }
  }

  private async onLine(client: ClientState, line: string): Promise<void> {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      client.socket.destroy(new Error('Browser companion received invalid JSON'))
      return
    }

    if (!client.authenticated) {
      if (message.version !== BROWSER_COMPANION_PROTOCOL_VERSION || message.kind !== 'auth'
        || message.token !== this.token || (message.client !== 'native-host' && message.client !== 'agent')) {
        client.socket.destroy(new Error('Browser companion authentication failed'))
        return
      }
      client.authenticated = true
      client.kind = message.client as ClientKind
      this.write(client, { version: BROWSER_COMPANION_PROTOCOL_VERSION, kind: 'auth.ok' })
      return
    }

    if (client.kind === 'native-host') await this.handleNativeHost(client, message)
    else if (client.kind === 'agent') await this.handleAgent(client, message)
  }

  private async handleNativeHost(client: ClientState, message: Record<string, unknown>): Promise<void> {
    if (message.kind === 'browser.hello') {
      const browser = browserKind(message.browser)
      const connection = await this.connections.upsertConnected({
        installationId: text(message.installationId, 'installation id', 256),
        browser,
        profileLabel: typeof message.profileLabel === 'string' ? message.profileLabel : browser,
        extensionVersion: typeof message.extensionVersion === 'string' ? message.extensionVersion : '0',
      })
      if (client.connectionId && client.connectionId !== connection.id) {
        this.nativeByConnection.delete(client.connectionId)
      }
      const replaced = this.nativeByConnection.get(connection.id)
      if (replaced && replaced !== client) {
        this.rejectPending(connection.id, 'Browser companion reconnected during request')
        replaced.socket.destroy()
      }
      client.connectionId = connection.id
      this.nativeByConnection.set(connection.id, client)
      this.write(client, { version: BROWSER_COMPANION_PROTOCOL_VERSION, kind: 'browser.hello.ok', connectionId: connection.id })
      await this.emit()
      return
    }

    if (message.kind === 'response' && typeof message.id === 'string') {
      const pending = this.pending.get(message.id)
      if (!pending || pending.connectionId !== client.connectionId) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error && typeof message.error === 'object') {
        const error = message.error as { code?: unknown; message?: unknown }
        const code = typeof error.code === 'string' ? `${error.code}: ` : ''
        pending.reject(new Error(`${code}${typeof error.message === 'string' ? error.message : 'Browser command failed'}`))
      } else {
        pending.resolve(message.result)
      }
      if (client.connectionId) await this.connections.touch(client.connectionId)
      return
    }

    if (message.kind === 'event' && client.connectionId) {
      if (message.event === 'tab.closed' && typeof message.tabId === 'number' && Number.isInteger(message.tabId) && message.tabId >= 0) {
        this.leases.releaseTab(client.connectionId, message.tabId)
      }
      await this.connections.touch(client.connectionId)
      await this.emit()
    }
  }

  private async handleAgent(client: ClientState, message: Record<string, unknown>): Promise<void> {
    if (message.kind !== 'request' || typeof message.id !== 'string' || typeof message.method !== 'string') return
    try {
      const params = objectParams(message.params)
      const result = this.agentDispatcher
        ? await this.agentDispatcher(message.method, params)
        : await this.dispatchAgent(message.method, params)
      this.write(client, { version: BROWSER_COMPANION_PROTOCOL_VERSION, kind: 'response', id: message.id, result })
    } catch (cause) {
      this.write(client, {
        version: BROWSER_COMPANION_PROTOCOL_VERSION,
        kind: 'response',
        id: message.id,
        error: { code: 'BROWSER_COMPANION_ERROR', message: cause instanceof Error ? cause.message : String(cause) },
      })
    }
  }

  private async dispatchAgent(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'browser.connections') return (await this.state()).connections
    if (method === 'browser.attach') {
      const connectionId = await this.resolveConnectionId(params.connectionId)
      const tabId = int(params.tabId, 'tabId')
      const ownerId = randomUUID()
      const lease = this.acquireLease(connectionId, tabId, ownerId)
      return { lease }
    }
    if (method === 'browser.detach') return { released: this.releaseLease(text(params.leaseId, 'lease id', 128)) }

    const connectionId = await this.resolveConnectionId(params.connectionId)
    if (method === 'browser.tabs') return this.requestBrowser(connectionId, 'tabs.list', {})

    const tabId = int(params.tabId, 'tabId')
    if (method === 'browser.snapshot') return this.requestBrowser(connectionId, 'page.snapshot', { tabId })
    if (method === 'browser.screenshot') return this.requestBrowser(connectionId, 'page.screenshot', { tabId })

    const leaseId = text(params.leaseId, 'lease id', 128)
    this.leases.assert(leaseId, connectionId, tabId)
    switch (method) {
      case 'browser.navigate':
        return this.requestBrowser(connectionId, 'page.navigate', { tabId, url: text(params.url, 'url', 16_384) })
      case 'browser.click':
        return this.requestBrowser(connectionId, 'page.click', { tabId, ref: text(params.ref, 'ref', 128), revision: int(params.revision, 'revision') })
      case 'browser.fill':
        return this.requestBrowser(connectionId, 'page.fill', { tabId, ref: text(params.ref, 'ref', 128), revision: int(params.revision, 'revision'), text: String(params.text ?? '').slice(0, 100_000) })
      case 'browser.press':
        return this.requestBrowser(connectionId, 'page.press', { tabId, ref: text(params.ref, 'ref', 128), revision: int(params.revision, 'revision'), key: text(params.key, 'key', 64) })
      case 'browser.scroll':
        return this.requestBrowser(connectionId, 'page.scroll', { tabId, deltaX: finite(params.deltaX), deltaY: finite(params.deltaY) })
      default:
        throw new Error(`Unknown browser companion method: ${method}`)
    }
  }

  private async resolveConnectionId(value: unknown): Promise<string> {
    if (typeof value === 'string' && value.trim()) {
      const id = value.trim()
      const connection = (await this.connections.list()).find((item) => item.id === id && item.connected)
      if (!connection) throw new Error('Requested browser connection is not connected')
      return id
    }
    const connected = (await this.connections.list()).filter((item) => item.connected)
    if (connected.length !== 1) throw new Error('Specify connectionId when zero or multiple browser companions are connected')
    return connected[0]!.id
  }

  private requestBrowser(connectionId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const client = this.nativeByConnection.get(connectionId)
    if (!client || client.socket.destroyed) return Promise.reject(new Error('Browser companion is disconnected'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Browser companion ${method} timed out`))
      }, REQUEST_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(id, { connectionId, resolve, reject, timer })
      this.write(client, { version: BROWSER_COMPANION_PROTOCOL_VERSION, kind: 'command', id, method, params })
    })
  }

  private write(client: ClientState, message: unknown): void {
    if (!client.socket.destroyed) client.socket.write(`${JSON.stringify(message)}\n`)
  }

  private async onClose(client: ClientState): Promise<void> {
    this.clients.delete(client)
    if (!client.connectionId) return
    // A fast MV3/native-host reconnect can replace this socket before the old
    // process finishes closing. Only the currently registered socket is
    // authoritative for connection/lease teardown.
    if (this.nativeByConnection.get(client.connectionId) !== client) return
    this.nativeByConnection.delete(client.connectionId)
    await this.connections.markDisconnected(client.connectionId)
    this.leases.releaseConnection(client.connectionId)
    this.rejectPending(client.connectionId, 'Browser companion disconnected during request')
    await this.emit()
  }

  private rejectPending(connectionId: string, message: string): void {
    for (const [id, pending] of [...this.pending]) {
      if (pending.connectionId !== connectionId) continue
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
    }
  }

  private async emit(): Promise<void> {
    if (!this.listener) return
    this.listener(await this.state())
  }
}

function defaultEndpoint(runtimeDir: string, identity: string): string {
  if (process.platform === 'win32') {
    const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 16)
    return `\\\\.\\pipe\\nd-dsh-browser-${suffix}`
  }
  return join(runtimeDir, 'browser-companion.sock')
}

function objectParams(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`Browser companion ${label} is required`)
  const clean = value.trim()
  if (!clean || clean.length > max) throw new Error(`Browser companion ${label} is invalid`)
  return clean
}

function int(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`Browser companion ${label} is invalid`)
  return value
}

function finite(value: unknown): number {
  const result = Number(value ?? 0)
  if (!Number.isFinite(result) || Math.abs(result) > 1_000_000) throw new Error('Browser companion numeric argument is invalid')
  return result
}

function browserKind(value: unknown): BrowserCompanionBrowser {
  if (value === 'edge' || value === 'brave' || value === 'chromium') return value
  return 'chrome'
}
