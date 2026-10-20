import type { Readable, Writable } from 'node:stream'
import type { EngineModelOption } from '../../../shared/contracts.js'

/**
 * ND-owned JSON-RPC line client for the official Codex app-server stdio
 * protocol (pinned vendored payload, currently 0.147.0). The wire owns
 * framing, request correlation, the fixed handshake, and the app-server-owned
 * ChatGPT OAuth bootstrap. Thread/turn state and product policy live in
 * {@link CodexCliEngine}.
 */

export type JsonObject = Record<string, unknown>

const REQUEST_TIMEOUT_MS = 120_000
/** Keep the client wait aligned with app-server v0.147's browser-login timeout. */
const LOGIN_TIMEOUT_MS = 10 * 60_000

export interface CodexWireHandlers {
  /** Product notifications such as `turn/started`, `item/*`, `turn/completed`. */
  onNotification(method: string, params: JsonObject): void
  /** Server-initiated requests such as approval elicitation; resolve with the result object. */
  onServerRequest(method: string, params: JsonObject): Promise<unknown>
  /** Fatal protocol failure. The wire rejects outstanding requests afterwards. */
  onProtocolError(error: Error): void
  /** Test/embedding seam. Production defaults to Electron's system-browser opener. */
  onAuthUrl?: (url: string) => Promise<void>
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface LoginCompletion {
  success: boolean
  error?: string
}

interface PendingLogin {
  resolve: (value: LoginCompletion) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function asRecord(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`Codex app-server returned an invalid ${label}`)
  return value
}

export function asText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Codex app-server returned an invalid ${label}`)
  return value
}

/** One live connection to `codex app-server --stdio`. */
export class CodexAppServerWire {
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly pendingLogins = new Map<string, PendingLogin>()
  /** Login completion can race the promise continuation for login/start. */
  private readonly completedLogins = new Map<string, LoginCompletion>()
  private unclaimedLoginCompletion: LoginCompletion | undefined
  private loginStartInFlight = false
  private buffer = ''
  private closed = false
  private readonly nativeModels = new Map<string, string>()

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly handlers: CodexWireHandlers,
  ) {
    this.input.setEncoding('utf8')
    this.input.on('data', (chunk: string) => this.consume(chunk))
    this.input.on('error', (error: Error) => this.fail(error))
    this.input.on('end', () => this.fail(new Error('Codex app-server protocol stream closed')))
    this.output.on('error', (error: Error) => this.fail(error))
  }

  async start(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'nd-dsh', title: 'ND-DSH', version: '0.0.1' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    }).then((result) => {
      asRecord(result, 'initialize response')
      this.send({ method: 'initialized' })
    }, (error: Error) => { this.fail(error); throw error })
    await this.ensureChatGptAuthenticated()
  }

  /** Create a thread and return its id. */
  async startThread(params: { cwd: string; approvalPolicy: string; sandbox?: string }): Promise<string> {
    const response = asRecord(await this.request('thread/start', {
      ...params,
      ephemeral: false,
    }), 'thread/start response')
    const thread = asRecord(response.thread, 'thread/start thread')
    const threadId = asText(thread.id, 'thread/start thread id')
    if (typeof response.model === 'string' && response.model) this.nativeModels.set(threadId, response.model)
    return threadId
  }

  /** Discover picker-visible model slugs using the native paginated catalog. */
  async listModels(): Promise<EngineModelOption[]> {
    const models = new Map<string, EngineModelOption>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const response = asRecord(await this.request('model/list', {
        limit: 100, includeHidden: false, ...(cursor === undefined ? {} : { cursor }),
      }), 'model/list response')
      if (!Array.isArray(response.data)) throw new Error('Codex app-server returned an invalid model list')
      for (const item of response.data) {
        if (!isObject(item) || item.hidden === true) continue
        const id = asText(item.model, 'model slug')
        models.set(id, { id, ...(typeof item.displayName === 'string' && item.displayName ? { name: item.displayName } : {}) })
      }
      cursor = typeof response.nextCursor === 'string' && response.nextCursor ? response.nextCursor : undefined
      if (cursor !== undefined) {
        if (cursors.has(cursor)) throw new Error('Codex model catalog repeated a page cursor')
        cursors.add(cursor)
      }
    } while (cursor !== undefined)
    return [...models.values()]
  }

  /** Submit one user turn and return the turn id. */
  async startTurn(threadId: string, texts: readonly string[], selectedModel?: string, imagePaths: readonly string[] = []): Promise<string> {
    // turn/start overrides persist; explicitly restore the original native
    // model when the picker returns to Native default.
    const model = selectedModel ?? this.nativeModels.get(threadId)
    const input: Array<Record<string, unknown>> = texts.map((text) => ({ type: 'text', text, text_elements: [] }))
    for (const path of imagePaths) input.push({ type: 'localImage', path })
    const response = asRecord(await this.request('turn/start', {
      threadId,
      ...(model === undefined ? {} : { model }),
      input,
    }), 'turn/start response')
    const turn = asRecord(response.turn, 'turn/start turn')
    return asText(turn.id, 'turn/start turn id')
  }

  /** Best-effort remote cancellation of the active turn. */
  interrupt(threadId: string, turnId: string): void {
    void this.request('turn/interrupt', { threadId, turnId }).catch(() => {})
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex app-server connection closed'))
    }
    this.pending.clear()
    for (const pending of this.pendingLogins.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex app-server connection closed during ChatGPT sign-in'))
    }
    this.pendingLogins.clear()
    this.completedLogins.clear()
    this.unclaimedLoginCompletion = undefined
    this.loginStartInFlight = false
    this.nativeModels.clear()
  }

  /**
   * Let the official app-server own credential storage and refresh. ND only
   * checks whether an account exists, starts the managed ChatGPT login when it
   * does not, opens the returned URL, then waits for app-server completion.
   */
  private async ensureChatGptAuthenticated(): Promise<void> {
    const initial = await this.readAccount()
    if (initial.account !== null && initial.account !== undefined) return
    if (initial.requiresOpenaiAuth !== true) return

    this.loginStartInFlight = true
    let login: JsonObject
    try {
      login = asRecord(await this.request('account/login/start', {
        type: 'chatgpt',
        appBrand: 'chatgpt',
        codexStreamlinedLogin: true,
        useHostedLoginSuccessPage: true,
      }), 'account/login/start response')
    } finally {
      this.loginStartInFlight = false
    }
    if (login.type !== 'chatgpt') throw new Error('Codex app-server did not start a ChatGPT OAuth login')
    const loginId = asText(login.loginId, 'ChatGPT login id')
    const authUrl = asText(login.authUrl, 'ChatGPT authorization URL')
    const completion = this.waitForLogin(loginId)

    try {
      await this.openAuthUrl(authUrl)
    } catch (error: unknown) {
      this.abandonLogin(loginId)
      this.cancelLogin(loginId)
      throw error
    }

    const result = await completion
    if (!result.success) throw new Error(result.error ?? 'ChatGPT sign-in was not completed')

    const authenticated = await this.readAccount()
    if (authenticated.account === null || authenticated.account === undefined) {
      throw new Error('ChatGPT sign-in completed but Codex returned no authenticated account')
    }
  }

  private async readAccount(): Promise<JsonObject> {
    const response = asRecord(await this.request('account/read', {}), 'account/read response')
    if (typeof response.requiresOpenaiAuth !== 'boolean') {
      throw new Error('Codex app-server returned an invalid account/read response')
    }
    return response
  }

  private waitForLogin(loginId: string): Promise<LoginCompletion> {
    const completed = this.completedLogins.get(loginId)
    if (completed) {
      this.completedLogins.delete(loginId)
      return Promise.resolve(completed)
    }
    if (this.unclaimedLoginCompletion) {
      const result = this.unclaimedLoginCompletion
      this.unclaimedLoginCompletion = undefined
      return Promise.resolve(result)
    }
    if (this.pendingLogins.has(loginId)) throw new Error(`Codex ChatGPT login is already pending: ${loginId}`)
    return new Promise<LoginCompletion>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingLogins.delete(loginId)
        this.cancelLogin(loginId)
        reject(new Error('ChatGPT sign-in timed out'))
      }, LOGIN_TIMEOUT_MS)
      this.pendingLogins.set(loginId, { resolve, reject, timer })
    })
  }

  private resolveLogin(params: JsonObject): void {
    const result: LoginCompletion = {
      success: params.success === true,
      ...(typeof params.error === 'string' && params.error ? { error: params.error } : {}),
    }
    const explicitId = typeof params.loginId === 'string' && params.loginId ? params.loginId : undefined
    const loginId = explicitId ?? (this.pendingLogins.size === 1 ? this.pendingLogins.keys().next().value as string | undefined : undefined)
    if (!loginId) {
      if (this.loginStartInFlight) this.unclaimedLoginCompletion = result
      return
    }
    const pending = this.pendingLogins.get(loginId)
    if (!pending) {
      if (this.loginStartInFlight) this.completedLogins.set(loginId, result)
      return
    }
    this.pendingLogins.delete(loginId)
    clearTimeout(pending.timer)
    pending.resolve(result)
  }

  private abandonLogin(loginId: string): void {
    const pending = this.pendingLogins.get(loginId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingLogins.delete(loginId)
    }
    this.completedLogins.delete(loginId)
    this.unclaimedLoginCompletion = undefined
  }

  private cancelLogin(loginId: string): void {
    void this.request('account/login/cancel', { loginId }).catch(() => {})
  }

  private async openAuthUrl(value: string): Promise<void> {
    let authUrl: URL
    try {
      authUrl = new URL(value)
    } catch {
      throw new Error('Codex app-server returned an invalid ChatGPT authorization URL')
    }
    if (authUrl.protocol !== 'https:') throw new Error('Codex ChatGPT authorization URL must use HTTPS')
    if (this.handlers.onAuthUrl) {
      await this.handlers.onAuthUrl(authUrl.toString())
      return
    }
    const { shell } = await import('electron')
    await shell.openExternal(authUrl.toString())
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.handleLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    let message: JsonObject
    try {
      const parsed: unknown = JSON.parse(line)
      message = asRecord(parsed, 'protocol frame')
    } catch (error: unknown) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    try {
      this.dispatch(message)
    } catch (error: unknown) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private dispatch(message: JsonObject): void {
    if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error !== undefined) {
        const error = asRecord(message.error, 'protocol error payload')
        pending.reject(new Error(`Codex app-server request failed: ${String(error.message ?? error.code ?? 'unknown error')}`))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (typeof message.method === 'string' && typeof message.id === 'number' && message.result === undefined) {
      // Server-initiated request; keep the correlation id for the responder.
      const requestId = message.id
      const method = message.method
      const params = isObject(message.params) ? message.params : {}
      void this.handlers.onServerRequest(method, params).then(
        (result) => {
          if (!this.closed) this.send({ id: requestId, result })
        },
        (error: unknown) => {
          if (!this.closed) {
            this.send({
              id: requestId,
              error: { code: 'nd_dsh_engine_error', message: error instanceof Error ? error.message : String(error) },
            })
          }
        },
      )
      return
    }
    if (typeof message.method === 'string') {
      const params = isObject(message.params) ? message.params : {}
      if (message.method === 'account/login/completed') this.resolveLogin(params)
      this.handlers.onNotification(message.method, params)
    }
  }

  private send(payload: JsonObject): void {
    if (this.closed) return
    try {
      this.output.write(`${JSON.stringify(payload)}\n`)
    } catch (error: unknown) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex app-server connection closed'))
    const id = this.nextRequestId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ id, method, params })
    })
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.close()
    this.handlers.onProtocolError(error)
  }
}

/** Decisions Codex offers for interactive approvals, grouped by polarity. */
export const POSITIVE_DECISIONS = ['accepted', 'accept', 'approved', 'approve', 'allow', 'allowed'] as const
export const NEGATIVE_DECISIONS = ['declined', 'decline', 'denied', 'deny', 'rejected', 'reject', 'cancel', 'cancelled'] as const

/**
 * Pick the concrete decision string Codex offered for the intended polarity.
 * Falls back to the safest well-known value when the offer is unparseable.
 */
export function pickDecision(availableDecisions: unknown, allow: boolean): string {
  const offered = Array.isArray(availableDecisions) ? availableDecisions.filter((item): item is string => typeof item === 'string') : []
  const preferred = allow ? POSITIVE_DECISIONS : NEGATIVE_DECISIONS
  for (const candidate of preferred) {
    if (offered.includes(candidate)) return candidate
  }
  if (!allow && offered.includes('cancel')) return 'cancel'
  return allow ? (offered[0] ?? 'accepted') : 'decline'
}

export { isObject }
