import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import type {
  DshEventFrame,
  GatewayRpcResult,
  SessionEventEnvelope,
} from '../../shared/contracts.js'

/** One frame delivered by a `session/follow` stream. */
export interface SessionStreamFrame {
  type: 'snapshot' | 'event' | 'error' | 'end'
  /** Snapshot only: the inclusive log cut the opening window covers. */
  cursor?: number
  /** Snapshot only: the opening journal window. */
  records?: unknown[]
  /** Event frames only. */
  event?: { type: string; seq: number; time?: number; data?: unknown; surfaceOp?: unknown }
  /** Error frames only. */
  message?: string
}

export interface FollowHandle {
  /** Resolves once the opening snapshot frame arrived; rejects if the stream errors first. */
  ready: Promise<void>
  close(): void
}

/** Snapshot window requested per follow stream (matches the renderer's history read). */
const FOLLOW_WINDOW = 50

const GATEWAY_RPC_TIMEOUT_MS = 15_000
const GATEWAY_AUTH_TIMEOUT_MS = 10_000

/**
 * Loopback client for the DeepSeek Harness web-plane gateway.
 *
 * Wire protocol (owned by @deepseek-ai/dsh-host-apiproxy):
 * - Unary RPC: POST /api/<method> with a `client-request` envelope
 *   `{ type, rpcId, method, payload }`; the response body is a
 *   `server-response` envelope whose `result` is `{ ok, value | error }`.
 * - Answerable frames (approvals, questions): POST /api/respond with a
 *   `client-response` envelope echoing the frame's rpcId; the body is a
 *   `{ accepted }` receipt.
 * - Live events: legacy downlinks at /api/events.mux and /api/events.host.
 *   The server only pushes `server-request` frames; client messages close the
 *   socket, so no opener is sent.
 * - Remote face (0.1.2+ runtimes): slash endpoints with named-argument
 *   envelopes (see remoteRequest), plus the /api/remote.mux WebSocket that
 *   carries both the forwarded host-event stream ($events) and per-session
 *   `session/follow` journal streams (see followSession).
 * - Remote-face answerables: the runtime delivers approvals and user
 *   questions as `waterfall` items on the $events stream (`approval/request`,
 *   `user-questions/request`). Each carries an `eventId` and MUST be answered
 *   through the `$events/result` RPC with the opening `ready` frame's
 *   `clientId` — an unanswered waterfall blocks the agent's turn forever.
 */
export class GatewayClient {
  private readonly sockets = new Set<WebSocket>()
  private closed = false
  private remoteProtocol = false
  private followSocket: WebSocket | undefined
  private readonly followEntries = new Map<string, FollowEntry>()
  private readonly followByStream = new Map<string, FollowEntry>()
  private followReconnect: NodeJS.Timeout | undefined
  private followSeq = 0
  /** The opening $events frame's client identity; required for every waterfall reply. */
  private remoteClientId: string | undefined
  /** Answerable $events waterfalls keyed by the rpcId ND minted for them. */
  private readonly waterfallPending = new Map<string, WaterfallPending>()
  private waterfallSession: (() => string | undefined) | undefined

  constructor(
    private readonly baseUrl: string,
    private readonly cookie?: string,
  ) {}

  /**
   * Attribute incoming waterfall asks to a session. The runtime's approval and
   * question payloads do not carry a session id, so the caller (HarnessService)
   * supplies its active/running session; without it the renderer cannot render
   * an answerable card.
   */
  setWaterfallSessionResolver(resolve: (() => string | undefined) | undefined): void {
    this.waterfallSession = resolve
  }

  /** Exchange DSH's one-time launch URL for the authority-bound session cookie. */
  static async authenticate(authenticatedUrl: string): Promise<GatewayClient> {
    const url = new URL(authenticatedUrl)
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(GATEWAY_AUTH_TIMEOUT_MS) })
    if (response.status !== 303) {
      throw new Error(`DSH web authentication failed: HTTP ${response.status}`)
    }
    const setCookie = response.headers.get('set-cookie')
    const cookie = setCookie?.split(';', 1)[0]?.trim()
    if (!cookie) throw new Error('DSH web authentication returned no session cookie')
    return new GatewayClient(url.origin, cookie)
  }

  get origin(): string {
    return new URL(this.baseUrl).origin
  }

  /** Whether the runtime serves the SRC remote face (slash endpoints + stream mux). */
  get remote(): boolean {
    return this.remoteProtocol
  }

  /**
   * Subscribe to one session's live journal through the remote stream mux
   * (`session/follow`). The opening snapshot frame covers the session's
   * current log window; later frames are the appended events, so a consumer
   * that adopts the snapshot silently and emits only newer sequences sees
   * exactly the turns that start after it subscribed. The socket reconnects
   * transparently and reopens the stream (a fresh snapshot re-arrives).
   */
  followSession(sessionId: string, onFrame: (frame: SessionStreamFrame) => void): FollowHandle {
    if (this.closed) {
      return { ready: Promise.reject(new Error('Runtime event stream was closed')), close: () => {} }
    }
    const existing = this.followEntries.get(sessionId)
    if (existing) return { ready: existing.ready, close: () => this.closeFollowEntry(existing) }
    let resolveReady!: () => void
    let rejectReady!: (cause: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const entry: FollowEntry = { sessionId, onFrame, ready, resolveReady, rejectReady, settled: false, streamId: undefined }
    this.followEntries.set(sessionId, entry)
    this.ensureFollowSocket()
    // A reused socket has already emitted open; start this entry immediately.
    // Connecting sockets open all queued entries from their open handler.
    this.openFollowStream(entry)
    return { ready, close: () => this.closeFollowEntry(entry) }
  }

  async rpc(method: string, payload: unknown = {}, timeoutMs = GATEWAY_RPC_TIMEOUT_MS): Promise<GatewayRpcResult> {
    const endpoint = this.remoteProtocol ? remoteRequest(method, payload) : { method, payload }
    const rpcId = randomUUID()
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/${endpoint.method}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ type: 'client-request', rpcId, ...endpoint }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      // The runtime child exited or is restarting between calls. Transport
      // failures are structured results, never raw TypeErrors through IPC.
      return {
        ok: false,
        error: {
          code: 'gateway-unreachable',
          message: `gateway ${method}: ${error instanceof Error ? error.message : String(error)}`,
        },
      }
    }
    if (response.status === 404 && !this.remoteProtocol && method === 'session.list') {
      this.remoteProtocol = true
      const result = await this.rpc(method, payload, timeoutMs)
      // Both route trees can be temporarily absent while an older runtime
      // mounts. Only retain negotiation once the new endpoint exists.
      if (result.error?.code === 'gateway-http' && result.error.message.endsWith('HTTP 404')) this.remoteProtocol = false
      return result
    }
    if (!response.ok) {
      return { ok: false, error: { code: 'gateway-http', message: `gateway ${method}: HTTP ${response.status}` } }
    }
    let frame: ServerResponseFrame
    try {
      frame = (await response.json()) as ServerResponseFrame
    } catch {
      return { ok: false, error: { code: 'gateway-protocol', message: `gateway ${method}: unreadable response body` } }
    }
    if (
      !frame || frame.type !== 'server-response' ||
      !frame.result || typeof frame.result !== 'object' ||
      typeof frame.result.ok !== 'boolean'
    ) {
      return { ok: false, error: { code: 'gateway-protocol', message: `gateway ${method}: unexpected response shape` } }
    }
    if (frame.result.ok) {
      return { ok: true, value: frame.result.value }
    }
    return { ok: false, error: normalizeError(frame.result.error) }
  }

  /**
   * Answer a pending askable frame. Remote-face waterfalls answer through
   * `$events/result` with the stream's clientId; legacy runtimes keep the
   * /api/respond pass-through.
   */
  async respond(rpcId: string, value: unknown, timeoutMs = GATEWAY_RPC_TIMEOUT_MS): Promise<void> {
    const pending = this.waterfallPending.get(rpcId)
    if (pending) {
      this.waterfallPending.delete(rpcId)
      const outcome = waterfallOutcome(pending.kind, value)
      await this.postEventResult(pending.clientId, pending.eventId, { kind: 'result', value: outcome }, timeoutMs)
      return
    }
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/respond`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new Error(`gateway respond: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new Error(`gateway respond: HTTP ${response.status}`)
    const receipt = (await response.json()) as { accepted?: boolean; reason?: string }
    if (receipt?.accepted !== true) {
      throw new Error(`gateway respond rejected: ${receipt?.reason ?? 'unknown reason'}`)
    }
  }

  /** Post one $events result outcome for a delivered waterfall. */
  private async postEventResult(
    clientId: string,
    eventId: string,
    outcome: EventResultOutcome,
    timeoutMs: number,
  ): Promise<void> {
    const result = await this.rpc('$events/result', { clientId, eventId, outcome }, timeoutMs)
    if (!result.ok) {
      throw new Error(`gateway $events/result: ${result.error?.message ?? 'result delivery failed'}`)
    }
  }

  openEvents(onFrame: (frame: DshEventFrame) => void): void {
    if (this.remoteProtocol) {
      this.openRemoteEvents(onFrame)
      return
    }
    this.openSocket('/api/events.mux', onFrame)
    this.openSocket('/api/events.host', onFrame)
  }

  close(): void {
    this.closed = true
    if (this.followReconnect !== undefined) {
      clearTimeout(this.followReconnect)
      this.followReconnect = undefined
    }
    this.closeFollowSocket()
    this.waterfallPending.clear()
    this.remoteClientId = undefined
    for (const entry of [...this.followEntries.values()]) this.failFollowEntry(entry, 'Runtime event stream was closed')
    this.followEntries.clear()
    for (const socket of this.sockets) {
      try {
        socket.close()
      } catch {
        // The socket may already be torn down.
      }
    }
    this.sockets.clear()
  }

  private openSocket(path: string, onFrame: (frame: DshEventFrame) => void): void {
    if (this.closed) return
    const base = new URL(this.baseUrl)
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${base.origin}${path}`, {
      ...(this.cookie ? { headers: { cookie: this.cookie } } : {}),
    })
    this.sockets.add(socket)
    socket.on('error', () => {})
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as ServerRequestFrame
        if (!message || message.type !== 'server-request') return
        const frame = translateFrame(message)
        if (frame) onFrame(frame)
      } catch {
        // A malformed frame is dropped; the downlink stays open.
      }
    })
    socket.addEventListener('close', () => {
      this.sockets.delete(socket)
      if (!this.closed) {
        setTimeout(() => this.openSocket(path, onFrame), 1_000)
      }
    })
  }

  private openRemoteEvents(onFrame: (frame: DshEventFrame) => void): void {
    if (this.closed) return
    const url = new URL('/api/remote.mux', this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url, { headers: this.headers() })
    this.sockets.add(socket)
    socket.on('error', () => {})
    socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId: 'host', endpoint: '$events', payload: { args: {} } })))
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(String(data))
        if (message.type === 'error') {
          onFrame({ kind: 'stream-error', message: message.error?.message ?? 'Runtime event stream failed' })
          return
        }
        if (message.type !== 'item') return
        const value = message.value
        if (!value || typeof value !== 'object') return
        if (value.type === 'ready' && typeof value.clientId === 'string') {
          this.remoteClientId = value.clientId
          return
        }
        if (value.type === 'waterfall') {
          this.deliverWaterfall(value, onFrame)
          return
        }
        if (value.type === 'cancel' && typeof value.eventId === 'string') {
          this.withdrawWaterfall(value.eventId, onFrame)
          return
        }
        if (value.type !== 'emit') return
        const { event, args } = value
        if (!Array.isArray(args)) return
        const sessionId = asString(args[0])
        if (event === 'api-session/status' && sessionId) onFrame({ kind: 'session-status', sessionId, running: args[1] === true })
        if (event === 'api-session/error' && sessionId) onFrame({ kind: 'agent-error', sessionId, message: String(args[1]) })
        if (event === 'api-session/removed' && sessionId) onFrame({ kind: 'session-removed', sessionId })
        if (event === 'api-session/added') onFrame({ kind: 'session-added', meta: args[0] })
      } catch {
        // Ignore malformed transport frames.
      }
    })
    socket.on('close', () => {
      this.sockets.delete(socket)
      // The Host rejects still-pending waterfalls when their source ends; drop
      // ND's mirror so replies can never target a dead generation's clientId.
      this.waterfallPending.clear()
      this.remoteClientId = undefined
      if (!this.closed) setTimeout(() => this.openRemoteEvents(onFrame), 1_000)
    })
  }

  /**
   * Translate one answerable $events waterfall into the renderer frame
   * vocabulary and remember how to reply. The runtime's payloads carry no
   * session id, so attribution comes from the caller-provided resolver.
   */
  private deliverWaterfall(
    value: { event?: unknown; eventId?: unknown; request?: unknown },
    onFrame: (frame: DshEventFrame) => void,
  ): void {
    const eventId = typeof value.eventId === 'string' ? value.eventId : undefined
    const event = typeof value.event === 'string' ? value.event : undefined
    const request = (value.request ?? {}) as Record<string, unknown>
    if (!eventId || !event || this.remoteClientId === undefined) return
    const sessionId = this.waterfallSession?.()
    const rpcId = `wf-${eventId}`
    if (event === 'approval/request') {
      this.waterfallPending.set(rpcId, { clientId: this.remoteClientId, eventId, kind: 'approval', sessionId })
      onFrame({
        kind: 'approval-requested',
        ...(sessionId === undefined ? {} : { sessionId }),
        approvalId: rpcId,
        rpcId,
        ...(typeof request.toolName === 'string' ? { toolName: request.toolName } : {}),
        ...(typeof request.callId === 'string' ? { callId: request.callId } : {}),
        ...(typeof request.reason === 'string' ? { reason: request.reason } : {}),
      })
      return
    }
    if (event === 'user-questions/request') {
      this.waterfallPending.set(rpcId, { clientId: this.remoteClientId, eventId, kind: 'question', sessionId })
      onFrame({
        kind: 'question-requested',
        ...(sessionId === undefined ? {} : { sessionId }),
        questions: request.questions,
        rpcId,
      })
    }
  }

  /** Drop a withdrawn waterfall and tell the renderer its card is gone. */
  private withdrawWaterfall(eventId: string, onFrame: (frame: DshEventFrame) => void): void {
    const rpcId = `wf-${eventId}`
    const pending = this.waterfallPending.get(rpcId)
    if (!pending) return
    this.waterfallPending.delete(rpcId)
    onFrame({
      kind: pending.kind === 'approval' ? 'approval-resolved' : 'question-resolved',
      ...(pending.sessionId === undefined ? {} : { sessionId: pending.sessionId }),
      outcome: 'cancelled',
      rpcId,
    })
  }

  /** Open (or reuse) the dedicated follow-stream mux socket. */
  private ensureFollowSocket(): void {
    if (this.followSocket !== undefined || this.closed) return
    const base = new URL(this.baseUrl)
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${base.origin}/api/remote.mux`, {
      ...(this.cookie ? { headers: { cookie: this.cookie } } : {}),
    })
    this.followSocket = socket
    socket.on('error', (cause) => {
      console.warn('[nd-dsh-follow] socket error:', cause instanceof Error ? cause.message : String(cause))
    })
    socket.on('unexpected-response', (_request, response) => {
      console.warn('[nd-dsh-follow] upgrade rejected: HTTP', response.statusCode)
    })
    socket.on('open', () => {
      console.warn('[nd-dsh-follow] socket open; entries:', this.followEntries.size)
      if (this.followSocket !== socket) return
      for (const entry of [...this.followEntries.values()]) this.openFollowStream(entry)
    })
    socket.on('message', (data) => {
      if (this.followSocket !== socket) return
      try {
        this.routeFollowFrame(JSON.parse(String(data)))
      } catch {
        // A malformed mux frame is dropped; the stream stays open.
      }
    })
    socket.on('close', (code, reason) => {
      console.warn('[nd-dsh-follow] socket closed:', code, String(reason))
      // A replaced socket can finish closing after its successor has opened.
      // Only the current transport may reset routing or schedule a reconnect.
      if (this.followSocket !== socket) return
      this.followSocket = undefined
      this.followByStream.clear()
      for (const entry of this.followEntries.values()) entry.streamId = undefined
      if (!this.closed && this.followEntries.size > 0 && this.followReconnect === undefined) {
        this.followReconnect = setTimeout(() => {
          this.followReconnect = undefined
          this.ensureFollowSocket()
        }, 1_000)
      }
    })
  }

  private openFollowStream(entry: FollowEntry): void {
    const socket = this.followSocket
    if (!socket || socket.readyState !== WebSocket.OPEN || entry.streamId !== undefined) return
    const streamId = `follow-${String(++this.followSeq)}`
    entry.streamId = streamId
    this.followByStream.set(streamId, entry)
    console.warn(`[nd-dsh-follow] opening stream ${streamId} for ${entry.sessionId} (readyState ${socket.readyState})`)
    socket.send(JSON.stringify({
      type: 'open',
      streamId,
      endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: entry.sessionId }, maxMessages: FOLLOW_WINDOW } } },
    }))
  }

  private routeFollowFrame(message: {
    type?: unknown
    streamId?: unknown
    value?: unknown
    error?: unknown
  }): void {
    if (typeof message.streamId !== 'string') {
      console.warn('[nd-dsh-follow] frame without stream id:', JSON.stringify(message).slice(0, 200))
      return
    }
    const entry = this.followByStream.get(message.streamId)
    if (!entry) {
      console.warn('[nd-dsh-follow] frame for unknown stream', message.streamId, ':', JSON.stringify(message).slice(0, 200))
      return
    }
    if (message.type === 'item') {
      const frame = asStreamFrame(message.value)
      if (frame === undefined) {
        console.warn('[nd-dsh-follow] unparsed item on', message.streamId, ':', JSON.stringify(message.value).slice(0, 200))
        return
      }
      if (frame.type === 'snapshot' && !entry.settled) {
        entry.settled = true
        entry.resolveReady()
      }
      entry.onFrame(frame)
      return
    }
    if (message.type === 'error') {
      const error = (message.error ?? {}) as { message?: unknown }
      this.failFollowEntry(entry, asString(error.message) ?? 'Session event stream failed')
      return
    }
    if (message.type === 'end') {
      this.followByStream.delete(message.streamId)
      entry.streamId = undefined
      if (!entry.settled) {
        entry.settled = true
        entry.rejectReady(new Error('Session event stream ended before its snapshot'))
      }
      this.closeFollowEntry(entry)
      entry.onFrame({ type: 'end' })
    }
  }

  private closeFollowEntry(entry: FollowEntry): void {
    if (this.followEntries.get(entry.sessionId) === entry) this.followEntries.delete(entry.sessionId)
    if (entry.streamId !== undefined) {
      this.followByStream.delete(entry.streamId)
      const socket = this.followSocket
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: 'cancel', streamId: entry.streamId }))
        } catch {
          // The socket may already be torn down.
        }
      }
      entry.streamId = undefined
    }
    if (!entry.settled) {
      entry.settled = true
      entry.rejectReady(new Error('Session event stream was closed before its snapshot'))
    }
    if (this.followEntries.size === 0) this.closeFollowSocket()
  }

  private failFollowEntry(entry: FollowEntry, message: string): void {
    if (entry.streamId !== undefined) {
      this.followByStream.delete(entry.streamId)
      entry.streamId = undefined
    }
    if (!entry.settled) {
      entry.settled = true
      entry.rejectReady(new Error(message))
    }
    // Terminal streams must not leave a cached rejected handle behind.
    this.closeFollowEntry(entry)
    entry.onFrame({ type: 'error', message })
  }

  private closeFollowSocket(): void {
    if (this.followReconnect !== undefined) {
      clearTimeout(this.followReconnect)
      this.followReconnect = undefined
    }
    const socket = this.followSocket
    this.followSocket = undefined
    if (!socket) return
    try {
      socket.close()
    } catch {
      // The socket may already be torn down.
    }
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.cookie ? { cookie: this.cookie } : {}),
    }
  }
}

/** Reserve a loopback port for the runtime; released before the child binds. */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => {
        if (typeof port === 'number' && port > 0) resolve(port)
        else reject(new Error('No free loopback port available'))
      })
    })
  })
}

interface ServerResponseFrame {
  type: 'server-response'
  rpcId: string
  result: { ok: true; value: unknown } | { ok: false; error: unknown }
}

interface FollowEntry {
  readonly sessionId: string
  readonly onFrame: (frame: SessionStreamFrame) => void
  readonly ready: Promise<void>
  readonly resolveReady: () => void
  readonly rejectReady: (cause: Error) => void
  settled: boolean
  streamId: string | undefined
}

interface WaterfallPending {
  readonly clientId: string
  readonly eventId: string
  readonly kind: 'approval' | 'question'
  readonly sessionId: string | undefined
}

/** The subset of RemoteEventResult outcomes ND sends back for one waterfall. */
type EventResultOutcome =
  | { readonly kind: 'result'; readonly value?: unknown }
  | { readonly kind: 'rejected'; readonly error: { readonly name: string; readonly message: string } }

/**
 * Map a renderer answer onto the runtime's waterfall result value. The
 * runtime's approval vocabulary is closed (`allowed-once | rejected |
 * cancelled | unavailable`), so an unrecognized outcome fails closed.
 */
function waterfallOutcome(kind: 'approval' | 'question', value: unknown): unknown {
  const payload = (value ?? {}) as Record<string, unknown>
  if (kind === 'approval') {
    return payload.outcome === 'allowed-once' ? 'allowed-once' : 'rejected'
  }
  return payload.answer ?? { answers: [] }
}

/** Leniently normalize one mux stream item into a session stream frame. */
function asStreamFrame(value: unknown): SessionStreamFrame | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.type === 'snapshot') {
    const cursor = typeof record.cursor === 'number' ? record.cursor : undefined
    return {
      type: 'snapshot',
      ...(cursor === undefined ? {} : { cursor }),
      ...(Array.isArray(record.records) ? { records: record.records } : {}),
    }
  }
  if (record.type === 'event') {
    const event = record.event as Record<string, unknown> | undefined
    if (!event || typeof event.type !== 'string' || typeof event.seq !== 'number') return undefined
    return {
      type: 'event',
      event: {
        type: event.type,
        seq: event.seq,
        ...(typeof event.time === 'number' ? { time: event.time } : {}),
        ...(event.data !== undefined ? { data: event.data } : {}),
        ...(event.surfaceOp !== undefined ? { surfaceOp: event.surfaceOp } : {}),
      },
    }
  }
  return undefined
}

interface ServerRequestFrame {
  type: 'server-request'
  rpcId: string
  method: string
  payload: unknown
}

function translateFrame(message: ServerRequestFrame): DshEventFrame | undefined {
  const payload = (message.payload ?? {}) as Record<string, unknown>
  const sessionId = asString(payload.sessionId)
  const withSession = sessionId === undefined ? {} : { sessionId }
  switch (payload.type) {
    case 'session/event':
      return { kind: 'session-event', ...withSession, event: payload.event as SessionEventEnvelope }
    case 'approval/requested': {
      const approvalId = asString(payload.approvalId)
      const toolName = asString(payload.toolName)
      const callId = asString(payload.callId)
      const reason = asString(payload.reason)
      return {
        kind: 'approval-requested',
        ...withSession,
        ...(approvalId === undefined ? {} : { approvalId }),
        ...(toolName === undefined ? {} : { toolName }),
        ...(callId === undefined ? {} : { callId }),
        ...(reason === undefined ? {} : { reason }),
        rpcId: message.rpcId,
      }
    }
    case 'approval/resolved': {
      const approvalId = asString(payload.approvalId)
      const outcome = asString(payload.outcome)
      return {
        kind: 'approval-resolved',
        ...withSession,
        ...(approvalId === undefined ? {} : { approvalId }),
        ...(outcome === undefined ? {} : { outcome }),
      }
    }
    case 'question/requested':
      return { kind: 'question-requested', ...withSession, questions: payload.questions, rpcId: message.rpcId }
    case 'question/resolved': {
      const outcome = asString(payload.outcome)
      return {
        kind: 'question-resolved',
        ...withSession,
        ...(outcome === undefined ? {} : { outcome }),
        rpcId: message.rpcId,
      }
    }
    case 'host/session-status':
      return { kind: 'session-status', ...withSession, running: payload.running === true }
    case 'host/session-added':
      return { kind: 'session-added', ...withSession, meta: payload }
    case 'host/session-removed':
      return { kind: 'session-removed', ...withSession }
    case 'host/agent-error':
      return { kind: 'agent-error', ...withSession, message: asString(payload.message) ?? 'Agent error' }
    case 'stream/error': {
      const error = (payload.error ?? {}) as { message?: unknown }
      return { kind: 'stream-error', message: asString(error.message) ?? 'Event stream error' }
    }
    default:
      return { kind: 'other', ...withSession, meta: payload }
  }
}

/**
 * Wire-args convention per Remote method, defaulting to one enclosing
 * `request` object named after the source parameter. A method that takes no
 * parameters or names its parameters individually cannot use that envelope:
 * the gateway rejects the unexpected field.
 */
const REMOTE_ARGS: Record<string, (payload: unknown) => unknown> = {
  'session.list': (payload) => ({ _request: payload }),
  'session.models': () => ({}),
  'agentPreset.list': () => ({}),
  'settings.update': (payload) => payload,
  // The result endpoint takes the fully-shaped result as its args, not a
  // request wrapper.
  '$events/result': (payload) => payload,
}

/**
 * Remote-face paths that are not the dotted name with its dot slashed. The
 * preset roster is served as `agentPreset.list` on the dotted face, while the
 * remote face names the endpoint after its plural service namespace.
 */
const REMOTE_ENDPOINTS: Record<string, string> = {
  'session.models': 'session/modelCatalog',
  'agentPreset.list': 'agentPresets/list',
}

function remoteRequest(method: string, payload: unknown): { method: string; payload: unknown } {
  const endpoint = REMOTE_ENDPOINTS[method] ?? method.replace('.', '/')
  const toArgs = REMOTE_ARGS[method] ?? ((request: unknown) => ({ request }))
  return { method: endpoint, payload: { args: toArgs(payload) } }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function normalizeError(error: unknown): { code: string; message: string } {
  const record = (error ?? {}) as Record<string, unknown>
  return {
    code: typeof record.code === 'string' ? record.code : 'internal',
    message: typeof record.message === 'string' ? record.message : 'Gateway request failed',
  }
}
