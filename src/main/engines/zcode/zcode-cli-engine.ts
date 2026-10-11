import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { stripWorkspaceContext } from '../../../shared/workspace-context.js'
import type {
  DshEventFrame,
  EngineSessionSummary,
  EngineSessionTranscript,
  SessionEventEnvelope,
} from '../../../shared/contracts.js'
import { ZCODE_CLI_ENGINE_ID } from '../../../shared/coding-engines.js'
import { zcodeBinPath } from '../../app-paths.js'
import { engineEnvironment, spawnCliCommand } from '../agent-cli/agent-cli-support.js'
import { isSessionNotFound, ZcodeAppServerWire, type ZcodeJsonObject } from './zcode-wire.js'

/**
 * ND-owned direct ZCode engine. One long-lived `zcode app-server` child hosts
 * one native session per ND session; `session/event` notifications are
 * translated into the shared `DshEventFrame` vocabulary so the organization
 * orchestrator and the renderer consume it exactly like primary-runtime
 * events. ZCode authentication, model, and permission-mode configuration stay
 * native; ND routes ZCode permission prompts through its own approval gate
 * and fails closed in unattended runs. A child death is healed on the next
 * run by resuming the persisted native session by id.
 */

export type ZcodeRunMode = 'interactive' | 'unattended'

/** ND never grants the `yolo` mode; unattended runs additionally auto-deny prompts. */
const RUN_MODE_ZCODE_MODE: Record<ZcodeRunMode, string> = {
  interactive: 'build',
  unattended: 'build',
}

const TRANSCRIPT_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'agent/reasoning', 'tool/call', 'tool/result'])
const LOCAL_TRANSCRIPT_EVENTS = 32
const RESULT_SNIPPET_MAX_CHARS = 4_000

interface TurnOutcome {
  status: string
  failureMessage?: string
}

interface ZcodePartState {
  kind: 'text' | 'reasoning' | 'tool'
  text: string
  toolName?: string
  callId?: string
  toolRecorded?: boolean
  toolSettled?: boolean
}

interface ZcodeSession {
  sessionId: string
  nativeSessionId?: string
  /** Which app-server child knows this native session; stale ids are resumed lazily. */
  childGeneration: number
  cwd?: string
  mode: ZcodeRunMode
  title: string
  /** ND owns the title until ZCode generates one; prompts only seed an untouched title. */
  titleFromPrompt: boolean
  createdAt: number
  updatedAt: number
  running: boolean
  activeTurnId?: string
  sequence: number
  transcript: SessionEventEnvelope[]
  turnSettled?: Deferred<TurnOutcome>
  /** Live message parts by partId, so deltas can append to the right row. */
  parts: Map<string, ZcodePartState>
}

/** Minimal single-shot deferred: turns settle exactly once via notification. */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolveRef) => { resolve = resolveRef })
  return { promise, resolve }
}

interface PendingApproval {
  resolve: (result: ZcodeJsonObject) => void
}

export interface ZcodeCliEngineOptions {
  /** Diagnostic sink for app-server stderr and lifecycle warnings. */
  log?: (line: string) => void
  /** Test seam: process spawner (defaults to node:child_process.spawn). */
  spawnProcess?: typeof spawn
}

export class ZcodeCliEngine {
  private child: ChildProcess | undefined
  private wire: ZcodeAppServerWire | undefined
  private startPromise: Promise<void> | undefined
  private stopping = false
  /** Bumped every time a fresh app-server child is spawned; native sessions from an older generation are resumed lazily. */
  private generation = 0
  private readonly sessions = new Map<string, ZcodeSession>()
  private readonly sessionsByNative = new Map<string, ZcodeSession>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private onEvent: ((frame: DshEventFrame) => void) | undefined

  constructor(private readonly options: ZcodeCliEngineOptions = {}) {}

  /** Frames translated into the shared event vocabulary leave through here. */
  setEmitter(emit: (frame: DshEventFrame) => void): void {
    this.onEvent = emit
  }

  ready(): boolean {
    return zcodeBinPath() !== undefined
  }

  /** Whether a session id belongs to this engine (run routing). */
  ownsSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** Whether an approval rpcId is pending on this engine (respond routing). */
  handlesApproval(rpcId: string): boolean {
    return this.pendingApprovals.has(rpcId)
  }

  listSessions(): EngineSessionSummary[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => ({
        sessionId: session.sessionId,
        engineId: ZCODE_CLI_ENGINE_ID,
        title: session.title,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        running: session.running,
      }))
  }

  transcript(sessionId: string): EngineSessionTranscript {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown ${ZCODE_CLI_ENGINE_ID} session: ${sessionId}`)
    return { sessionId, engineId: ZCODE_CLI_ENGINE_ID, events: [...session.transcript] }
  }

  /**
   * Model configuration stays native to ZCode; ND exposes no per-session
   * picker. ND does provide the provider-setup GUI that writes ZCode's own
   * `~/.zcode/cli/config.json` (see zcode-config.ts), so a missing model
   * provider can be fixed without leaving the app.
   */
  async listModels(): Promise<never[]> {
    return []
  }

  async createSession(input: { cwd?: string; mode?: ZcodeRunMode } = {}): Promise<{ sessionId: string }> {
    const sessionId = `zcode-${randomUUID()}`
    const now = Date.now()
    const session: ZcodeSession = {
      sessionId,
      childGeneration: 0,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      mode: input.mode ?? 'interactive',
      title: 'New ZCode chat',
      titleFromPrompt: true,
      createdAt: now,
      updatedAt: now,
      running: false,
      sequence: 0,
      transcript: [],
      parts: new Map(),
    }
    this.sessions.set(sessionId, session)
    this.emitFrame({ kind: 'session-added', sessionId, meta: { engineId: ZCODE_CLI_ENGINE_ID } })
    return { sessionId }
  }

  /**
   * Submit one prompt to a ZCode-backed session (created lazily when no id is
   * given). Progress streams out as frames; the promise settles with the turn.
   */
  async run(prompt: string, options: { sessionId?: string; cwd?: string } = {}): Promise<{ sessionId: string }> {
    const cleaned = prompt.trim()
    if (!cleaned) throw new Error('Prompt cannot be empty')
    if (cleaned.length > 100_000) throw new Error('Prompt exceeds the 100,000 character limit')

    let session = options.sessionId !== undefined ? this.sessions.get(options.sessionId) : undefined
    if (options.sessionId !== undefined && !session) throw new Error(`Unknown ${ZCODE_CLI_ENGINE_ID} session: ${options.sessionId}`)
    if (!session) {
      const created = await this.createSession(options.cwd === undefined ? {} : { cwd: options.cwd })
      session = this.sessions.get(created.sessionId)
    }
    if (!session) throw new Error(`${ZCODE_CLI_ENGINE_ID} session could not be created`)
    const activeSession = session
    if (activeSession.running) throw new Error('This ZCode chat already has an active turn')
    if (options.cwd !== undefined) {
      if (activeSession.cwd !== undefined && normalizeWorkspaceRoot(activeSession.cwd) !== normalizeWorkspaceRoot(options.cwd)) {
        throw new Error('ZCode session workspace is immutable; create a new session for a different task workspace')
      }
      if (activeSession.cwd === undefined) activeSession.cwd = options.cwd
    }

    const settled = deferred<TurnOutcome>()
    activeSession.turnSettled = settled
    activeSession.parts.clear()
    try {
      const userPrompt = stripWorkspaceContext(cleaned)
      this.recordUserMessage(activeSession, userPrompt)
      if (activeSession.titleFromPrompt && activeSession.title === 'New ZCode chat') {
        activeSession.title = userPrompt.slice(0, 80)
        activeSession.titleFromPrompt = false
      }
      // Native sessions are durable. If the app-server child restarted since
      // this session was created (or the server lost the session), resume the
      // persisted conversation instead of failing the run. ensureStarted runs
      // first so a lazy restart is visible in the generation check.
      await this.ensureStarted()
      if (activeSession.nativeSessionId === undefined || activeSession.childGeneration !== this.generation) {
        await this.attachNativeSession(activeSession)
      }
      try {
        await this.sendPrompt(activeSession, cleaned)
      } catch (error: unknown) {
        if (!isSessionNotFound(error)) throw error
        await this.attachNativeSession(activeSession)
        await this.sendPrompt(activeSession, cleaned)
      }
      activeSession.running = true
      activeSession.updatedAt = Date.now()
      this.emitFrame({ kind: 'session-status', sessionId: activeSession.sessionId, running: true })
      const terminal = await settled.promise
      this.finishTurn(activeSession)
      if (terminal.status === 'failed') {
        const message = terminal.failureMessage ?? 'ZCode turn failed'
        this.emitFrame({ kind: 'agent-error', sessionId: activeSession.sessionId, message })
        throw new Error(message)
      }
      return { sessionId: activeSession.sessionId }
    } catch (error: unknown) {
      // The turn never published (startup/attach failure): clean up here.
      if (activeSession.turnSettled === settled) {
        this.finishTurn(activeSession)
        const message = error instanceof Error ? error.message : String(error)
        this.emitFrame({ kind: 'agent-error', sessionId: activeSession.sessionId, message })
      }
      throw error
    }
  }

  /** Interrupt the active turn of one ZCode-backed session (or every session). */
  async stop(sessionId?: string): Promise<void> {
    const targets = sessionId !== undefined
      ? [this.sessions.get(sessionId)]
      : [...this.sessions.values()].filter((item) => item.running)
    for (const session of targets) {
      if (!session?.running || session.nativeSessionId === undefined) continue
      await this.wire?.request('session/stop', { sessionId: session.nativeSessionId }).catch(() => {})
    }
  }

  /**
   * Answer a pending interactive permission prompt. The value mirrors the
   * harness contract: `{ outcome: 'allowed-once' | 'rejected' }` (extra
   * fields ignored).
   */
  async respond(rpcId: string, value: unknown): Promise<void> {
    const pending = this.pendingApprovals.get(rpcId)
    if (!pending) throw new Error(`Unknown ${ZCODE_CLI_ENGINE_ID} approval: ${rpcId}`)
    this.pendingApprovals.delete(rpcId)
    const allowed = extractAllowed(value)
    pending.resolve({ decision: allowed ? 'allow' : 'deny', reason: allowed ? 'Approved once' : 'Denied' })
    this.emitFrame({ kind: 'approval-resolved', approvalId: rpcId, outcome: allowed ? 'allowed-once' : 'rejected' })
  }

  async close(): Promise<void> {
    this.stopping = true
    for (const [rpcId, pending] of [...this.pendingApprovals]) {
      this.pendingApprovals.delete(rpcId)
      pending.resolve({ decision: 'deny', reason: 'ND is shutting down' })
    }
    const child = this.child
    this.wire?.close()
    this.wire = undefined
    this.child = undefined
    for (const session of this.sessions.values()) {
      if (!session.running) continue
      this.finishTurn(session)
      this.emitFrame({ kind: 'agent-error', sessionId: session.sessionId, message: 'ZCode engine stopped before the turn completed.' })
    }
    await killProcessTree(child)
    this.stopping = false
  }

  private async sendPrompt(session: ZcodeSession, content: string): Promise<void> {
    if (session.nativeSessionId === undefined) throw new Error('ZCode session is not attached')
    await this.requireWire().request('session/send', { sessionId: session.nativeSessionId, content })
  }

  /** Create the native session on the current child (or resume a persisted one). */
  private async attachNativeSession(session: ZcodeSession): Promise<void> {
    const wire = await this.ensureStarted()
    const workspacePath = session.cwd ?? process.cwd()
    const workspace = { workspacePath, workspaceKey: workspacePath }
    if (session.nativeSessionId !== undefined) {
      // The child restarted (generation mismatch): the persisted native
      // conversation is resumed by id so ND-side history stays the same chat.
      try {
        const snapshot = await wire.request('session/resume', {
          sessionId: session.nativeSessionId,
          workspace,
        })
        this.noteSnapshot(session, snapshot, { adoptTitle: true })
        await this.subscribeSession(session)
        session.childGeneration = this.generation
        return
      } catch (error: unknown) {
        if (!isSessionNotFound(error)) throw error
        // The native record is gone too; fall through to a fresh session.
        this.forgetNativeSession(session)
      }
    }
    const snapshot = await wire.request('session/create', {
      workspace,
      mode: RUN_MODE_ZCODE_MODE[session.mode],
    })
    this.noteSnapshot(session, snapshot, { adoptTitle: false })
    await this.subscribeSession(session)
    session.childGeneration = this.generation
  }

  /** Live `session/event` notifications only flow to subscribed sessions. */
  private async subscribeSession(session: ZcodeSession): Promise<void> {
    if (session.nativeSessionId === undefined) return
    await this.requireWire().request('session/subscribe', {
      sessionId: session.nativeSessionId,
      deliveryKind: 'desktop-continuous',
    }).catch((error: unknown) => {
      // A failed subscription would blind the chat; surface it loudly.
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`ZCode session subscription failed: ${message}`)
    })
  }

  /**
   * Track the native session id from a create/resume snapshot. A resumed
   * conversation's title is authoritative; a fresh create's default title
   * stays out of the way so ND can seed it from the first prompt.
   */
  private noteSnapshot(session: ZcodeSession, snapshot: unknown, options: { adoptTitle: boolean }): void {
    const record = isRecord(snapshot) ? snapshot : {}
    const nativeSession = isRecord(record.session) ? record.session : record
    const nativeSessionId = nativeSession.sessionId
    if (typeof nativeSessionId !== 'string' || !nativeSessionId) {
      throw new Error('ZCode session snapshot returned no session id')
    }
    if (session.nativeSessionId !== undefined && session.nativeSessionId !== nativeSessionId) {
      this.forgetNativeSession(session)
    }
    session.nativeSessionId = nativeSessionId
    this.sessionsByNative.set(nativeSessionId, session)
    if (options.adoptTitle && typeof nativeSession.title === 'string' && nativeSession.title.trim()) {
      session.title = nativeSession.title
      session.titleFromPrompt = false
    }
  }

  private forgetNativeSession(session: ZcodeSession): void {
    if (session.nativeSessionId !== undefined) this.sessionsByNative.delete(session.nativeSessionId)
    delete session.nativeSessionId
  }

  private async ensureStarted(): Promise<ZcodeAppServerWire> {
    if (this.wire && this.child) return this.wire
    if (this.startPromise) {
      await this.startPromise
      return this.wire as ZcodeAppServerWire
    }
    this.startPromise = this.start().finally(() => {
      this.startPromise = undefined
    })
    await this.startPromise
    return this.wire as ZcodeAppServerWire
  }

  private requireWire(): ZcodeAppServerWire {
    if (!this.wire) throw new Error('ZCode app-server is not running')
    return this.wire
  }

  private async start(): Promise<void> {
    this.generation += 1
    const bin = zcodeBinPath()
    if (!bin) throw new Error('The ZCode CLI is not installed. Install the ZCode desktop app or set ND_DSH_ZCODE_BINARY.')

    // The shipped entry is a CommonJS bundle, so it runs through the Electron
    // Node runtime exactly like the pinned Codex payload; any other entry
    // (developer overrides, .cmd shims) spawns through the shared CLI spawner.
    const bundled = bin.toLowerCase().endsWith('.js') || bin.toLowerCase().endsWith('.cjs')
    const argv = bundled ? [process.execPath, bin, 'app-server'] : [bin, 'app-server']
    const environment = engineEnvironment()
    if (bundled) environment.ELECTRON_RUN_AS_NODE = '1'

    const log = this.options.log ?? ((line: string) => console.warn(line))
    const spawnProcess = this.options.spawnProcess ?? spawn
    const child = spawnCliCommand(spawnProcess, argv[0] as string, argv.slice(1), {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: environment,
      // A process group lets POSIX teardown take the whole tree down; Windows
      // uses taskkill /T instead.
      detached: process.platform !== 'win32',
    })
    this.child = child
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => log(`[zcode app-server] ${chunk.trimEnd()}`))
    child.once('exit', (code, signal) => {
      const wasExpected = this.stopping || this.child !== child
      this.child = undefined
      this.wire?.close()
      this.wire = undefined
      if (wasExpected) return
      const message = `ZCode app-server exited (${signal ?? String(code ?? 'unknown')}).`
      for (const session of this.sessions.values()) {
        if (!session.running) continue
        session.turnSettled?.resolve({ status: 'failed', failureMessage: message })
        this.finishTurn(session)
      }
      for (const [rpcId, pending] of [...this.pendingApprovals]) {
        this.pendingApprovals.delete(rpcId)
        pending.resolve({ decision: 'deny', reason: 'ZCode app-server exited' })
      }
    })

    const wire = new ZcodeAppServerWire(child.stdout as NonNullable<typeof child.stdout>, child.stdin as NonNullable<typeof child.stdin>, {
      onNotification: (method, params) => this.handleNotification(method, params),
      onServerRequest: (method, params) => this.handleServerRequest(method, params),
      onProtocolError: (error) => this.handleProtocolError(error),
    })
    this.wire = wire
  }

  private handleNotification(method: string, params: ZcodeJsonObject): void {
    if (method === 'session/event') {
      this.handleSessionEvent(params)
      return
    }
    // Workspace-scope `state.updated` patches carry model-catalog updates and
    // projection noise; the `session/event` stream owns everything ND renders.
  }

  private handleSessionEvent(params: ZcodeJsonObject): void {
    const nativeSessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
    const session = nativeSessionId !== undefined ? this.sessionsByNative.get(nativeSessionId) : undefined
    if (!session) return
    const type = typeof params.type === 'string' ? params.type : ''
    const payload = isRecord(params.payload) ? params.payload : {}

    if (type === 'turn.started') {
      if (typeof params.turnId === 'string') session.activeTurnId = params.turnId
      return
    }

    if (type === 'part.started' || type === 'part.upserted') {
      const part = isRecord(payload.part) ? payload.part : undefined
      if (part) this.handlePart(session, part, type === 'part.upserted')
      return
    }

    if (type === 'part.delta') {
      const partId = typeof payload.partId === 'string' ? payload.partId : undefined
      const delta = typeof payload.delta === 'string' ? payload.delta : ''
      const field = payload.field
      if (!partId || !delta) return
      const state = session.parts.get(partId)
      if (!state) return
      state.text += delta
      if (field === 'text') {
        this.recordEnvelope(session, { type: 'assistant/chunk', data: { chunk: { content: [{ type: 'text', text: delta }] } } })
      }
      return
    }

    if (type === 'part.removed') {
      const partId = typeof payload.partId === 'string' ? payload.partId : undefined
      if (partId) session.parts.delete(partId)
      return
    }

    if (type === 'turn.completed') {
      this.finishAssistantText(session)
      const response = typeof payload.response === 'string' ? payload.response : ''
      if (response.trim() && !session.transcript.some((event) => event.type === 'assistant/message' && eventText(event) === response.trim())) {
        this.recordAssistantMessage(session, response)
      }
      session.turnSettled?.resolve({ status: 'completed' })
      return
    }

    if (type === 'turn.failed') {
      const error = isRecord(payload.error) ? payload.error : undefined
      const message = typeof error?.message === 'string' && error.message.trim() ? error.message : 'ZCode turn failed'
      this.finishAssistantText(session)
      session.turnSettled?.resolve({ status: 'failed', failureMessage: message })
      return
    }

    if (type === 'session.titleUpdated') {
      const title = typeof payload.title === 'string' ? payload.title.trim() : ''
      if (title) {
        session.title = title
        session.titleFromPrompt = false
      }
      return
    }

    if (type === 'session.closed') {
      if (session.turnSettled) {
        session.turnSettled.resolve({ status: 'failed', failureMessage: 'The ZCode session was closed mid-turn.' })
        this.finishTurn(session)
      }
      return
    }
  }

  private handlePart(session: ZcodeSession, part: ZcodeJsonObject, upserted: boolean): void {
    const partId = typeof part.partId === 'string' ? part.partId : undefined
    if (!partId) return
    const type = part.type

    if (type === 'text') {
      const text = typeof part.text === 'string' ? part.text : ''
      if (part.synthetic === true || part.ignored === true) return
      let state = session.parts.get(partId)
      if (!state || state.kind !== 'text') {
        state = { kind: 'text', text: '' }
        session.parts.set(partId, state)
      }
      // An upsert may carry the authoritative full text; keep the longest view.
      if (upserted && text.length > state.text.length) state.text = text
      if (upserted && state.text.trim()) {
        this.finishAssistantText(session)
      }
      return
    }

    if (type === 'reasoning') {
      const text = typeof part.text === 'string' ? part.text : ''
      let state = session.parts.get(partId)
      if (!state || state.kind !== 'reasoning') {
        state = { kind: 'reasoning', text: '' }
        session.parts.set(partId, state)
      }
      if (upserted) {
        if (text.length > state.text.length) state.text = text
        if (state.text.trim()) this.recordEnvelope(session, { type: 'agent/reasoning', data: { text: state.text } })
      }
      return
    }

    if (type === 'tool') {
      const toolName = typeof part.tool === 'string' && part.tool ? part.tool : 'tool'
      const callId = typeof part.callId === 'string' && part.callId ? part.callId : partId
      let state = session.parts.get(partId)
      if (!state || state.kind !== 'tool') {
        state = { kind: 'tool', text: '', toolName, callId }
        session.parts.set(partId, state)
      }
      const status = isRecord(part.state) && typeof part.state.status === 'string' ? part.state.status : 'running'
      if (!state.toolRecorded) {
        state.toolRecorded = true
        this.recordToolCall(session, callId, toolName, isRecord(part.state) ? part.state.input ?? null : null)
      }
      if (!upserted) return
      if (status === 'running' || status === 'pending') return
      if (state.toolSettled) return
      state.toolSettled = true
      if (status === 'completed') {
        const output = isRecord(part.state) && typeof part.state.output === 'string' ? part.state.output : ''
        this.recordToolResult(session, callId, summarize(output))
        return
      }
      const failure = isRecord(part.state) && isRecord(part.state.error) && typeof part.state.error.message === 'string'
        ? part.state.error.message
        : `tool ${status}`
      this.recordToolResult(session, callId, summarize(failure), failure)
      return
    }

    // file parts and any future kinds stay out of the surface for now.
  }

  /** Flush the live text part as one final assistant message. */
  private finishAssistantText(session: ZcodeSession): void {
    const open = [...session.parts.entries()].filter(([, state]) => state.kind === 'text' && state.text.trim())
    for (const [partId, state] of open) {
      this.recordAssistantMessage(session, state.text)
      session.parts.delete(partId)
    }
  }

  private handleServerRequest(method: string, params: ZcodeJsonObject): Promise<unknown> {
    switch (method) {
      case 'session/requestRuntimePreferences':
        // ND keeps ZCode defaults; nothing native-search or memory related is enabled.
        return Promise.resolve({ nativeSearchEnhancementsEnabled: false })
      case 'interaction/requestPermission':
        return this.requestHumanApproval(params)
      case 'interaction/requestUserInput':
        // Interactive question cards for ZCode are future work; answer empty.
        return Promise.resolve({ answers: {} })
      case 'interaction/requestProviderRuntimeHeaders': {
        // ND never injects provider credentials into ZCode; its own login stays
        // authoritative. However, x-opencode-session is a routing header (not a
        // credential) required by OpenCode managed-inference endpoints. ND
        // supplies the ND session id so requests within one conversation share a
        // stable routing identity.
        const nativeId = typeof params.sessionId === 'string' ? params.sessionId : ''
        const headerSession = this.sessionsByNative.get(nativeId)
        if (headerSession) {
          return Promise.resolve({
            ok: true,
            headers: { 'x-opencode-session': headerSession.sessionId },
          })
        }
        return Promise.resolve({ ok: false, reason: 'official_auth_unavailable' })
      }
      default:
        return Promise.reject(new Error(`Unsupported ZCode app-server request: ${method}`))
    }
  }

  private requestHumanApproval(params: ZcodeJsonObject): Promise<unknown> {
    const nativeSessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    const session = this.sessionsByNative.get(nativeSessionId)
    if (!session) return Promise.resolve({ decision: 'deny', reason: 'Unknown session' })
    if (session.mode === 'unattended') {
      // Unattended runs stay fail-closed: nobody is watching to approve.
      return Promise.resolve({ decision: 'deny', reason: 'Unattended runs cannot approve tool permissions.' })
    }

    const rpcId = `zcode:${randomUUID()}`
    const toolName = typeof params.toolName === 'string' && params.toolName ? params.toolName : 'Tool execution'
    const reason = typeof params.reason === 'string' && params.reason ? params.reason : `${toolName} needs permission`
    return new Promise<unknown>((resolve) => {
      this.pendingApprovals.set(rpcId, { resolve })
      this.emitFrame({
        kind: 'approval-requested',
        sessionId: session.sessionId,
        approvalId: rpcId,
        toolName,
        ...(reason ? { reason } : {}),
        rpcId,
      })
    })
  }

  private handleProtocolError(error: Error): void {
    this.options.log?.(`[zcode app-server] protocol error: ${error.message}`)
    for (const session of this.sessions.values()) {
      if (!session.running) continue
      session.turnSettled?.resolve({ status: 'failed', failureMessage: error.message })
      this.finishTurn(session)
    }
    this.child = undefined
    this.wire = undefined
  }

  private finishTurn(session: ZcodeSession): void {
    const wasActive = session.running || session.turnSettled !== undefined
    if (!wasActive) return
    this.finishAssistantText(session)
    session.running = false
    delete session.activeTurnId
    delete session.turnSettled
    session.updatedAt = Date.now()
    this.emitFrame({ kind: 'session-status', sessionId: session.sessionId, running: false })
  }

  private recordUserMessage(session: ZcodeSession, text: string): void {
    this.recordEnvelope(session, {
      type: 'user/message',
      data: { message: { role: 'user', content: [{ type: 'text', text }] } },
    })
  }

  private recordAssistantMessage(session: ZcodeSession, text: string): void {
    this.recordEnvelope(session, {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
    })
  }

  private recordToolCall(session: ZcodeSession, callId: string, name: string, args: unknown): void {
    this.recordEnvelope(session, { type: 'tool/call', data: { callId, name, arguments: args } })
  }

  private recordToolResult(session: ZcodeSession, callId: string, result: string, error?: string): void {
    this.recordEnvelope(session, {
      type: 'tool/result',
      data: { callId, message: { content: [{ type: 'text', text: result }] }, ...(error === undefined ? {} : { error }) },
    })
  }

  private recordEnvelope(session: ZcodeSession, partial: { type: string; data?: unknown }): void {
    session.sequence += 1
    const envelope: SessionEventEnvelope = {
      type: partial.type,
      seq: session.sequence,
      time: Date.now(),
      ...(partial.data === undefined ? {} : { data: partial.data }),
    }
    if (TRANSCRIPT_EVENT_TYPES.has(envelope.type)) {
      session.transcript.push(envelope)
      if (session.transcript.length > LOCAL_TRANSCRIPT_EVENTS) session.transcript.splice(0, session.transcript.length - LOCAL_TRANSCRIPT_EVENTS)
    }
    this.emitFrame({ kind: 'session-event', sessionId: session.sessionId, event: envelope })
  }

  private emitFrame(frame: DshEventFrame): void {
    this.onEvent?.(frame)
  }
}

function isRecord(value: unknown): value is ZcodeJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function eventText(event: SessionEventEnvelope): string {
  const data = isRecord(event.data) ? event.data : {}
  const message = isRecord(data.message) ? data.message : {}
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  const texts = message.content
    .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block as { text: string }).text)
  return texts.join('\n').trim()
}

function extractAllowed(value: unknown): boolean {
  if (isRecord(value)) {
    const outcome = value.outcome
    if (outcome === 'allowed-once' || outcome === 'allow' || outcome === true) return true
  }
  return false
}

function summarize(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)
  const cleaned = (text ?? '').trim()
  if (cleaned.length <= RESULT_SNIPPET_MAX_CHARS) return cleaned
  return `${cleaned.slice(0, RESULT_SNIPPET_MAX_CHARS - 1)}…`
}

/** Terminate the whole child tree; SIGTERM first, then hard teardown. */
async function killProcessTree(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { child.kill() } catch { /* Already gone. */ }
        resolve()
      }
      child.once('exit', finish)
      const timer = setTimeout(finish, 3_000)
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        killer.once('close', finish)
        killer.once('error', finish)
      } catch {
        // Already handled.
      }
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    })
    return
  }

  let groupSignalled = false
  try {
    process.kill(-pid, 'SIGTERM')
    groupSignalled = true
  } catch {
    try { child.kill('SIGTERM') } catch { return }
  }

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      try {
        if (groupSignalled) process.kill(-pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      finish()
    }, 3_000)
    child.once('exit', () => {
      if (!groupSignalled) {
        finish()
        return
      }
      try {
        process.kill(-pid, 0)
      } catch {
        finish()
      }
    })
  })
}


function normalizeWorkspaceRoot(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
