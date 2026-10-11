import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stripWorkspaceContext } from '../../../shared/workspace-context.js'
import type {
  DshEventFrame,
  EngineModelOption,
  EngineSessionSummary,
  EngineSessionTranscript,
  SessionEventEnvelope,
} from '../../../shared/contracts.js'
import { CODEX_CLI_ENGINE_ID } from '../../../shared/coding-engines.js'
import { codexBinPath } from '../../app-paths.js'
import { asText, CodexAppServerWire, isObject, pickDecision, type JsonObject } from './codex-wire.js'

/**
 * ND-owned direct Codex engine. One long-lived official `codex app-server`
 * child hosts one thread per ND session; wire activity is translated into the
 * shared `DshEventFrame` vocabulary so the organization orchestrator and the
 * renderer consume it exactly like primary-runtime events. Native Codex
 * authentication, `CODEX_HOME`, and model configuration stay authoritative.
 */

export type CodexRunMode = 'interactive' | 'unattended'

/** Thread policies per run mode. Unattended runs stay fail-closed (`never`). */
const THREAD_POLICY: Record<CodexRunMode, { approvalPolicy: string; sandbox?: string }> = {
  interactive: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  unattended: { approvalPolicy: 'never' },
}

const TRANSCRIPT_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'agent/reasoning', 'tool/call', 'tool/result'])
const LOCAL_TRANSCRIPT_EVENTS = 32
const RESULT_SNIPPET_MAX_CHARS = 4_000

interface PendingApproval {
  resolve: (result: JsonObject) => void
  availableDecisions: unknown
}

interface TurnOutcome {
  status: string
  failureMessage?: string
}

interface CodexSession {
  sessionId: string
  threadId: string
  /** Which app-server child owns this thread; stale ids are recreated lazily. */
  threadGeneration: number
  cwd?: string
  mode: CodexRunMode
  title: string
  createdAt: number
  updatedAt: number
  running: boolean
  turnId?: string
  sequence: number
  transcript: SessionEventEnvelope[]
  turnSettled?: Deferred<TurnOutcome>
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

export interface CodexCliEngineOptions {
  /** Diagnostic sink for app-server stderr and lifecycle warnings. */
  log?: (line: string) => void
  /** Test seam: process spawner (defaults to node:child_process.spawn). */
  spawnProcess?: typeof spawn
}

export class CodexCliEngine {
  private child: ChildProcess | undefined
  private wire: CodexAppServerWire | undefined
  private startPromise: Promise<void> | undefined
  private stopping = false
  /** Bumped every time a fresh app-server child is spawned; threads from an older generation no longer exist. */
  private generation = 0
  private readonly sessions = new Map<string, CodexSession>()
  private readonly sessionsByThread = new Map<string, CodexSession>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private onEvent: ((frame: DshEventFrame) => void) | undefined

  constructor(private readonly options: CodexCliEngineOptions = {}) {}

  /** Frames translated into the shared event vocabulary leave through here. */
  setEmitter(emit: (frame: DshEventFrame) => void): void {
    this.onEvent = emit
  }

  ready(): boolean {
    return codexBinPath() !== undefined
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
        engineId: CODEX_CLI_ENGINE_ID,
        title: session.title,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        running: session.running,
      }))
  }

  transcript(sessionId: string): EngineSessionTranscript {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown ${CODEX_CLI_ENGINE_ID} session: ${sessionId}`)
    return { sessionId, engineId: CODEX_CLI_ENGINE_ID, events: [...session.transcript] }
  }

  async listModels(): Promise<EngineModelOption[]> {
    return (await this.ensureStarted()).listModels()
  }

  async createSession(input: { cwd?: string; mode?: CodexRunMode } = {}): Promise<{ sessionId: string }> {
    const wire = await this.ensureStarted()
    const sessionId = `codex-${randomUUID()}`
    const threadId = await wire.startThread(this.threadStartParams(input.mode ?? 'interactive', input.cwd))
    const now = Date.now()
    const session: CodexSession = {
      sessionId,
      threadId,
      threadGeneration: this.generation,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      mode: input.mode ?? 'interactive',
      title: 'New Codex chat',
      createdAt: now,
      updatedAt: now,
      running: false,
      sequence: 0,
      transcript: [],
    }
    this.sessions.set(sessionId, session)
    this.sessionsByThread.set(threadId, session)
    this.emitFrame({ kind: 'session-added', sessionId, meta: { engineId: CODEX_CLI_ENGINE_ID } })
    return { sessionId }
  }

  /**
   * Submit one prompt to a codex-backed session (created lazily when no id is
   * given). Progress streams out as frames; the promise settles with the turn.
   */
  async run(prompt: string, options: { sessionId?: string; cwd?: string; model?: string } = {}): Promise<{ sessionId: string }> {
    const cleaned = prompt.trim()
    if (!cleaned) throw new Error('Prompt cannot be empty')
    if (cleaned.length > 100_000) throw new Error('Prompt exceeds the 100,000 character limit')

    let session = options.sessionId !== undefined ? this.sessions.get(options.sessionId) : undefined
    if (options.sessionId !== undefined && !session) throw new Error(`Unknown ${CODEX_CLI_ENGINE_ID} session: ${options.sessionId}`)
    if (!session) {
      const created = await this.createSession(options.cwd === undefined ? {} : { cwd: options.cwd })
      session = this.sessions.get(created.sessionId)
    }
    if (!session) throw new Error(`${CODEX_CLI_ENGINE_ID} session could not be created`)
    const activeSession = session
    if (activeSession.running) throw new Error('This Codex chat already has an active turn')

    const settled = deferred<TurnOutcome>()
    activeSession.turnSettled = settled
    try {
      let wire = await this.ensureStarted()
      const userPrompt = stripWorkspaceContext(cleaned)
      this.recordUserMessage(activeSession, userPrompt)
      if (activeSession.title === 'New Codex chat') activeSession.title = userPrompt.slice(0, 80)
      // Threads die with their app-server child. If the child restarted since
      // this session's thread was created (or the server lost the thread),
      // recreate it transparently instead of failing the run.
      if (activeSession.threadGeneration !== this.generation) {
        await this.recreateThread(activeSession)
        wire = await this.ensureStarted()
      }
      let turnId: string
      try {
        turnId = await wire.startTurn(activeSession.threadId, [cleaned], options.model)
      } catch (error: unknown) {
        if (!isThreadNotFound(error)) throw error
        await this.recreateThread(activeSession)
        wire = await this.ensureStarted()
        turnId = await wire.startTurn(activeSession.threadId, [cleaned], options.model)
      }
      activeSession.turnId = turnId
      activeSession.running = true
      activeSession.updatedAt = Date.now()
      this.emitFrame({ kind: 'session-status', sessionId: activeSession.sessionId, running: true })
      const terminal = await settled.promise
      this.finishTurn(activeSession)
      if (terminal.status === 'failed') {
        const message = terminal.failureMessage ?? 'Codex turn failed'
        this.emitFrame({ kind: 'agent-error', sessionId: activeSession.sessionId, message })
        throw new Error(message)
      }
      return { sessionId: activeSession.sessionId }
    } catch (error: unknown) {
      // The turn never published (startup/startup-turn failure): clean up here.
      if (activeSession.turnSettled === settled) {
        this.finishTurn(activeSession)
        const message = error instanceof Error ? error.message : String(error)
        this.emitFrame({ kind: 'agent-error', sessionId: activeSession.sessionId, message })
      }
      throw error
    }
  }

  /** Interrupt the active turn of one codex-backed session (or every session). */
  async stop(sessionId?: string): Promise<void> {
    const targets = sessionId !== undefined
      ? [this.sessions.get(sessionId)]
      : [...this.sessions.values()].filter((item) => item.running)
    for (const session of targets) {
      if (!session?.running || session.turnId === undefined) continue
      this.wire?.interrupt(session.threadId, session.turnId)
    }
  }

  /**
   * Answer a pending interactive approval. The value mirrors the harness
   * contract: `{ outcome: 'allowed-once' | 'rejected' }` (extra fields ignored).
   */
  async respond(rpcId: string, value: unknown): Promise<void> {
    const pending = this.pendingApprovals.get(rpcId)
    if (!pending) throw new Error(`Unknown ${CODEX_CLI_ENGINE_ID} approval: ${rpcId}`)
    this.pendingApprovals.delete(rpcId)
    const outcome = extractOutcome(value)
    pending.resolve({
      decision: pickDecision(pending.availableDecisions, outcome === 'allowed-once'),
    })
    this.emitFrame({ kind: 'approval-resolved', approvalId: rpcId, outcome })
  }

  async close(): Promise<void> {
    this.stopping = true
    for (const [rpcId, pending] of [...this.pendingApprovals]) {
      this.pendingApprovals.delete(rpcId)
      pending.resolve({ decision: 'decline' })
    }
    const child = this.child
    this.wire?.close()
    this.wire = undefined
    this.child = undefined
    for (const session of this.sessions.values()) {
      if (!session.running) continue
      this.finishTurn(session)
      this.emitFrame({ kind: 'agent-error', sessionId: session.sessionId, message: 'Codex engine stopped before the turn completed.' })
    }
    await killProcessTree(child)
    this.stopping = false
  }

  private async ensureStarted(): Promise<CodexAppServerWire> {
    if (this.wire && this.child) return this.wire
    if (this.startPromise) {
      await this.startPromise
      return this.wire as CodexAppServerWire
    }
    this.startPromise = this.start().finally(() => {
      this.startPromise = undefined
    })
    await this.startPromise
    return this.wire as CodexAppServerWire
  }

  /** Wire parameters for one native thread under this run mode. */
  private threadStartParams(mode: CodexRunMode, cwd?: string): { cwd: string; approvalPolicy: string; sandbox?: string } {
    const policy = THREAD_POLICY[mode]
    return {
      cwd: cwd ?? process.cwd(),
      approvalPolicy: asText(policy.approvalPolicy, 'approval policy'),
      ...(policy.sandbox === undefined ? {} : { sandbox: policy.sandbox }),
    }
  }

  /**
   * Recreate a session's native thread on the current app-server child. Used
   * when the child restarted (generation mismatch) or the server lost the
   * thread; conversation history already rendered stays intact in ND.
   */
  private async recreateThread(session: CodexSession): Promise<void> {
    if (session.turnId !== undefined) throw new Error('Cannot recreate a thread while a turn is active')
    this.sessionsByThread.delete(session.threadId)
    const wire = await this.ensureStarted()
    session.threadId = await wire.startThread(this.threadStartParams(session.mode, session.cwd))
    session.threadGeneration = this.generation
    this.sessionsByThread.set(session.threadId, session)
    session.updatedAt = Date.now()
    // Visible in diagnostics; the chat itself continues in the fresh thread.
    this.emitFrame({
      kind: 'stream-error',
      sessionId: session.sessionId,
      message: 'Codex runtime restarted; continuing this chat in a fresh Codex thread.',
    })
  }

  private async start(): Promise<void> {
    this.generation += 1
    const bin = codexBinPath()
    if (!bin) throw new Error('The bundled Codex CLI payload is missing from this install. Set the runtime up in Settings → Capabilities, or reinstall ND.')

    const argv = bin.toLowerCase().endsWith('.js') ? [process.execPath, bin, 'app-server', '--stdio'] : [bin, 'app-server', '--stdio']
    const environment: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('ND_DSH_') || key.startsWith('DSH_')) continue
      environment[key] = value
    }
    if (argv[0] === process.execPath && bin.toLowerCase().endsWith('.js')) environment.ELECTRON_RUN_AS_NODE = '1'

    const log = this.options.log ?? ((line: string) => console.warn(line))
    const spawnProcess = this.options.spawnProcess ?? spawn
    const child = spawnProcess(argv[0] as string, argv.slice(1), {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: environment,
      // A process group lets POSIX teardown take the whole tree down; Windows
      // uses taskkill /T instead.
      detached: process.platform !== 'win32',
    })
    this.child = child
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => log(`[codex app-server] ${chunk.trimEnd()}`))
    child.once('exit', (code, signal) => {
      const wasExpected = this.stopping || this.child !== child
      this.child = undefined
      this.wire?.close()
      this.wire = undefined
      if (wasExpected) return
      const message = `Codex app-server exited (${signal ?? String(code ?? 'unknown')}).`
      for (const session of this.sessions.values()) {
        if (!session.running) continue
        session.turnSettled?.resolve({ status: 'failed', failureMessage: message })
        this.finishTurn(session)
      }
      for (const [rpcId, pending] of [...this.pendingApprovals]) {
        this.pendingApprovals.delete(rpcId)
        pending.resolve({ decision: 'decline' })
      }
    })

    const wire = new CodexAppServerWire(child.stdout as NonNullable<typeof child.stdout>, child.stdin as NonNullable<typeof child.stdin>, {
      onNotification: (method, params) => this.handleNotification(method, params),
      onServerRequest: (method, params) => this.handleServerRequest(method, params),
      onProtocolError: (error) => this.handleProtocolError(error),
    })
    try {
      await wire.start()
      this.wire = wire
    } catch (error: unknown) {
      wire.close()
      if (this.child === child) this.child = undefined
      await killProcessTree(child)
      throw error
    }
  }

  private handleNotification(method: string, params: JsonObject): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
    const session = threadId !== undefined ? this.sessionsByThread.get(threadId) : undefined
    if (!session) return

    if (method === 'turn/started') return

    if (method === 'item/started' || method === 'item/completed') {
      const item = isObject(params.item) ? params.item : undefined
      if (item) this.handleItem(session, method === 'item/started', item)
      return
    }

    if (method === 'turn/completed') {
      const turn = isObject(params.turn) ? params.turn : undefined
      const status = typeof turn?.status === 'string' ? turn.status : 'failed'
      const failure = isObject(turn?.error) ? turn.error : isObject(params.error) ? params.error : undefined
      const failureMessage = failure && typeof failure.message === 'string' ? failure.message : undefined
      const matchesActiveTurn = session.turnId === undefined || turn?.id === undefined || turn.id === session.turnId
      if (session.turnSettled && matchesActiveTurn) {
        session.turnSettled.resolve(failureMessage === undefined ? { status } : { status, failureMessage })
      }
    }
  }

  private handleItem(session: CodexSession, started: boolean, item: JsonObject): void {
    const type = item.type
    if (type === 'agentMessage') {
      if (started || item.phase === 'commentary') return
      const text = typeof item.text === 'string' ? item.text : ''
      if (!text.trim()) return
      this.recordAssistantMessage(session, text)
      return
    }
    if (type === 'reasoning') {
      // Surface model reasoning as a collapsible chat card; skip empty deltas.
      const text = typeof item.text === 'string' ? item.text : ''
      if (text.trim() && !started) {
        this.recordEnvelope(session, { type: 'agent/reasoning', data: { text } })
      }
      return
    }
    if (type === 'todoList') return

    const callId = typeof item.id === 'string' ? item.id : `${session.sequence + 1}`
    if (type === 'commandExecution') {
      if (started) {
        const command = typeof item.command === 'string' ? item.command : 'command'
        this.recordToolCall(session, callId, 'command execution', { command, ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}) })
        return
      }
      this.recordToolResult(session, callId, describeCommandResult(item))
      return
    }
    if (type === 'fileChange') {
      if (started) {
        this.recordToolCall(session, callId, 'file change', { files: item.files ?? item.changes ?? {} })
        return
      }
      this.recordToolResult(session, callId, describeFileChangeResult(item))
      return
    }
    if (type === 'mcpToolCall' || type === 'webSearch' || type === 'tool') {
      const name = typeof item.tool === 'string' ? item.tool : type
      if (started) {
        this.recordToolCall(session, callId, name, { arguments: item.arguments ?? item.input ?? null })
        return
      }
      this.recordToolResult(session, callId, summarize(item.result ?? item.output))
      return
    }
    if (type === 'error' && !started) {
      const message = typeof item.message === 'string' ? item.message : 'Codex reported an execution error.'
      this.emitFrame({ kind: 'stream-error', sessionId: session.sessionId, message })
    }
  }

  private handleServerRequest(method: string, params: JsonObject): Promise<JsonObject> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return this.requestHumanApproval(method, params)
      case 'item/permissions/requestApproval':
        // ND never grants arbitrary turn permissions; fail closed like unattended runs.
        this.options.log?.('[codex app-server] permission grant denied by ND policy')
        return Promise.resolve({ permissions: {}, scope: 'turn' })
      case 'item/tool/requestUserInput':
        // Interactive question cards for Codex are future work; answer empty.
        return Promise.resolve({ answers: {} })
      case 'mcpServer/elicitation/request':
        return Promise.resolve({ action: 'decline', content: null, _meta: null })
      default:
        return Promise.reject(new Error(`Unsupported Codex app-server request: ${method}`))
    }
  }

  private requestHumanApproval(method: string, params: JsonObject): Promise<JsonObject> {
    const threadId = typeof params.threadId === 'string' ? params.threadId : ''
    const session = this.sessionsByThread.get(threadId)
    if (!session) return Promise.resolve({ decision: 'decline' })

    const rpcId = `codex:${randomUUID()}`
    const toolName = method === 'item/commandExecution/requestApproval' ? 'Command execution' : 'File change'
    const reason = typeof params.reason === 'string'
      ? params.reason
      : method === 'item/commandExecution/requestApproval'
        ? firstLine(typeof params.command === 'string' ? params.command : '')
        : 'Codex wants to modify files in the workspace'
    return new Promise<JsonObject>((resolve) => {
      this.pendingApprovals.set(rpcId, { resolve, availableDecisions: params.availableDecisions })
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
    this.options.log?.(`[codex app-server] protocol error: ${error.message}`)
    for (const session of this.sessions.values()) {
      if (!session.running) continue
      session.turnSettled?.resolve({ status: 'failed', failureMessage: error.message })
      this.finishTurn(session)
    }
    this.child = undefined
    this.wire = undefined
  }

  private finishTurn(session: CodexSession): void {
    const wasActive = session.running || session.turnSettled !== undefined
    if (!wasActive) return
    session.running = false
    delete session.turnId
    delete session.turnSettled
    session.updatedAt = Date.now()
    this.emitFrame({ kind: 'session-status', sessionId: session.sessionId, running: false })
  }

  private recordUserMessage(session: CodexSession, text: string): void {
    this.recordEnvelope(session, {
      type: 'user/message',
      data: { message: { role: 'user', content: [{ type: 'text', text }] } },
    })
  }

  private recordAssistantMessage(session: CodexSession, text: string): void {
    this.recordEnvelope(session, {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
    })
  }

  private recordToolCall(session: CodexSession, callId: string, name: string, args: unknown): void {
    this.recordEnvelope(session, { type: 'tool/call', data: { callId, name, arguments: args } })
  }

  private recordToolResult(session: CodexSession, callId: string, result: string): void {
    this.recordEnvelope(session, { type: 'tool/result', data: { callId, message: { content: [{ type: 'text', text: result }] } } })
  }

  private recordEnvelope(session: CodexSession, partial: { type: string; data?: unknown }): void {
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

/** Server-side "thread not found" means the child no longer knows the thread. */
function isThreadNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /thread/i.test(message) && /not\s*found/i.test(message)
}

function extractOutcome(value: unknown): 'allowed-once' | 'rejected' {  if (isObject(value)) {
    const outcome = value.outcome
    if (outcome === 'allowed-once' || outcome === 'allow' || outcome === true) return 'allowed-once'
  }
  return 'rejected'
}

function describeCommandResult(item: JsonObject): string {
  const status = typeof item.status === 'string' ? item.status : 'completed'
  const exitCode = typeof item.exitCode === 'number' ? ` (exit code ${item.exitCode})` : ''
  const output = isObject(item.aggregatedOutput) && typeof item.aggregatedOutput.text === 'string'
    ? item.aggregatedOutput.text
    : typeof item.aggregatedOutput === 'string'
      ? item.aggregatedOutput
      : ''
  const snippet = output.trim() ? `\n${summarize(output)}` : ''
  return `${status}${exitCode}${snippet}`
}

function describeFileChangeResult(item: JsonObject): string {
  const status = typeof item.status === 'string' ? item.status : 'completed'
  return `file change ${status}`
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? ''
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
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
