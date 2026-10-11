import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  DshEventFrame,
  EngineModelOption,
  EngineSessionSummary,
  EngineSessionTranscript,
  SessionEventEnvelope,
} from '../../../shared/contracts.js'
import { ANTIGRAVITY_ENGINE_ID } from '../../../shared/coding-engines.js'
import { stripWorkspaceContext } from '../../../shared/workspace-context.js'
import { antigravityBinPath } from '../../app-paths.js'

/**
 * ND-owned direct Google Antigravity engine. Each ND session hosts one
 * long-lived `agy` CLI child driven over the documented stream-json wires:
 * one NDJSON user event per turn on stdin, `init`/`step_update`/`result`
 * NDJSON events back on stdout. Native Antigravity authentication, model
 * configuration, and headless permission policy stay authoritative; a child
 * death is healed on the next run by resuming the conversation by id.
 */

const TRANSCRIPT_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'agent/reasoning', 'tool/call', 'tool/result'])
const LOCAL_TRANSCRIPT_EVENTS = 32
const RESULT_SNIPPET_MAX_CHARS = 4_000

interface TurnOutcome {
  status: string
  failureMessage?: string
}

interface AntigravityToolInfo {
  name?: unknown
  parameters?: unknown
  error?: { type?: unknown; message?: unknown }
}

interface AntigravityStepUpdate {
  step_index?: unknown
  state?: unknown
  step_type?: unknown
  text_delta?: unknown
  tool_name?: unknown
  tool_info?: AntigravityToolInfo
}

interface AntigravityResult {
  conversation_id?: unknown
  status?: unknown
  response?: unknown
  error?: unknown
}

interface AntigravityWireEvent {
  event?: unknown
  conversation_id?: unknown
  step_update?: AntigravityStepUpdate
  result?: AntigravityResult
}

interface AntigravitySession {
  sessionId: string
  conversationId?: string
  cwd?: string
  model?: string
  permissionMode?: string
  title: string
  createdAt: number
  updatedAt: number
  running: boolean
  sequence: number
  transcript: SessionEventEnvelope[]
  turnSettled?: Deferred<TurnOutcome>
  child?: ChildProcess
  /** Partial stdout line of the active child. */
  buffer: string
  /** Final response text is re-emitted by `result`; skip the duplicate. */
  lastAssistantText?: string
  /** Response step identity, so ACTIVE/DONE replays do not add bubbles. */
  lastAssistantStepIndex?: number
  assistantResponse?: { stepIndex: number | undefined; text: string; lastDelta: string }
  turnAssistantText: string
  lastToolError?: string
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** `agy models` prints `slug<TAB>Label` rows; anything else is status output. */
function parseAgyModels(output: string): EngineModelOption[] {
  const models: EngineModelOption[] = []
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.includes('\t')) continue
    const [id, name] = trimmed.split('\t', 2)
    if (!id || models.some((model) => model.id === id)) continue
    models.push({ id, name: name?.trim() || id })
  }
  return models
}

export interface AntigravityEngineOptions {
  /** Diagnostic sink for CLI stderr and lifecycle warnings. */
  log?: (line: string) => void
  /** Test seam: process spawner (defaults to node:child_process.spawn). */
  spawnProcess?: typeof spawn
  /** Execution mode for agy (defaults to accept-edits). */
  mode?: string
  /** Auto-approve headless tool calls without prompting (defaults to true in headless stream-json). */
  skipPermissions?: boolean
}

export class AntigravityEngine {
  private readonly sessions = new Map<string, AntigravitySession>()
  private modelsCache: { at: number; models: EngineModelOption[] } | undefined
  private onEvent: ((frame: DshEventFrame) => void) | undefined
  private stopping = false

  constructor(private readonly options: AntigravityEngineOptions = {}) {}

  /** Frames translated into the shared event vocabulary leave through here. */
  setEmitter(emit: (frame: DshEventFrame) => void): void {
    this.onEvent = emit
  }

  ready(): boolean {
    return antigravityBinPath() !== undefined
  }

  /** Whether a session id belongs to this engine (run routing). */
  ownsSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** Headless `agy` cannot prompt for permissions, so no approvals pend here. */
  handlesApproval(_rpcId: string): boolean {
    return false
  }

  /** No approval can ever pend here; answering one is a routing bug. */
  async respond(rpcId: string, _value: unknown): Promise<void> {
    throw new Error(`Unknown ${ANTIGRAVITY_ENGINE_ID} approval: ${rpcId}`)
  }

  listSessions(): EngineSessionSummary[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => ({
        sessionId: session.sessionId,
        engineId: ANTIGRAVITY_ENGINE_ID,
        title: session.title,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        running: session.running,
      }))
  }

  transcript(sessionId: string): EngineSessionTranscript {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown ${ANTIGRAVITY_ENGINE_ID} session: ${sessionId}`)
    return { sessionId, engineId: ANTIGRAVITY_ENGINE_ID, events: [...session.transcript] }
  }

  /**
   * The `agy models` catalog (one `slug<TAB>Label` row per line), cached
   * briefly so opening the picker never re-spawns the CLI. Selection stays
   * native to Antigravity: an unset model means "whatever the CLI is
   * configured with".
   */
  async listModels(): Promise<EngineModelOption[]> {
    const cached = this.modelsCache
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.models
    const bin = antigravityBinPath()
    if (!bin) throw new Error('The Antigravity CLI (agy) is not installed. Install it from https://antigravity.google or set ND_DSH_ANTIGRAVITY_BINARY.')
    const models = await new Promise<EngineModelOption[]>((resolve, reject) => {
      const spawnProcess = this.options.spawnProcess ?? spawn
      const child = spawnProcess(bin, ['models'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('Timed out listing Antigravity models.'))
      }, 15_000)
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => { out += chunk })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => { err += chunk })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          reject(new Error(`agy models failed (${String(code ?? 'unknown')}). ${err.trim().slice(0, 200)}`.trim()))
          return
        }
        resolve(parseAgyModels(out))
      })
    })
    this.modelsCache = { at: Date.now(), models }
    return models
  }

  async createSession(input: { cwd?: string; model?: string } = {}): Promise<{ sessionId: string }> {
    const sessionId = `antigravity-${randomUUID()}`
    const now = Date.now()
    const session: AntigravitySession = {
      sessionId,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.model === undefined ? {} : { model: input.model }),
      title: 'New Antigravity chat',
      createdAt: now,
      updatedAt: now,
      running: false,
      sequence: 0,
      transcript: [],
      buffer: '',
      turnAssistantText: '',
    }
    this.sessions.set(sessionId, session)
    this.emitFrame({ kind: 'session-added', sessionId, meta: { engineId: ANTIGRAVITY_ENGINE_ID } })
    return { sessionId }
  }

  /**
   * Submit one prompt to an Antigravity-backed session (created lazily when no
   * id is given). Progress streams out as frames; the promise settles with the
   * turn, which is exactly one `result` event on the child's stdout.
   */
  async run(prompt: string, options: { sessionId?: string; cwd?: string; model?: string; permissionMode?: string } = {}): Promise<{ sessionId: string }> {
    const cleaned = prompt.trim()
    if (!cleaned) throw new Error('Prompt cannot be empty')
    if (cleaned.length > 100_000) throw new Error('Prompt exceeds the 100,000 character limit')

    let session = options.sessionId !== undefined ? this.sessions.get(options.sessionId) : undefined
    if (options.sessionId !== undefined && !session) throw new Error(`Unknown ${ANTIGRAVITY_ENGINE_ID} session: ${options.sessionId}`)
    if (!session) {
      const created = await this.createSession({
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.model === undefined ? {} : { model: options.model }),
      })
      session = this.sessions.get(created.sessionId)
    }
    if (!session) throw new Error(`${ANTIGRAVITY_ENGINE_ID} session could not be created`)
    const activeSession = session
    if (activeSession.running) throw new Error('This Antigravity chat already has an active turn')
    if (options.cwd !== undefined) activeSession.cwd = options.cwd
    if (options.permissionMode !== undefined && options.permissionMode !== activeSession.permissionMode) {
      activeSession.permissionMode = options.permissionMode
      const staleChild = activeSession.child
      if (staleChild && staleChild.exitCode === null && staleChild.signalCode === null) {
        delete activeSession.child
        await killProcessTree(staleChild)
      }
    }
    if (options.model !== undefined && options.model !== activeSession.model) {
      activeSession.model = options.model
      // Model selection is a per-process CLI flag: tear the current child down
      // so the next spawn resumes the conversation under the new model.
      const staleChild = activeSession.child
      if (staleChild && staleChild.exitCode === null && staleChild.signalCode === null) {
        delete activeSession.child
        await killProcessTree(staleChild)
      }
    }

    const settled = deferred<TurnOutcome>()
    activeSession.turnSettled = settled
    delete activeSession.lastAssistantText
    delete activeSession.lastAssistantStepIndex
    delete activeSession.assistantResponse
    delete activeSession.lastToolError
    activeSession.turnAssistantText = ''
    try {
      const child = this.ensureChild(activeSession)
      const userPrompt = stripWorkspaceContext(cleaned)
      this.recordUserMessage(activeSession, userPrompt)
      if (activeSession.title === 'New Antigravity chat') activeSession.title = userPrompt.slice(0, 80)
      child.stdin?.write(`${JSON.stringify({ event: 'user', message: { content: cleaned } })}\n`)
      activeSession.running = true
      activeSession.updatedAt = Date.now()
      this.emitFrame({ kind: 'session-status', sessionId: activeSession.sessionId, running: true })
      const terminal = await settled.promise
      this.finishTurn(activeSession)
      if (terminal.status === 'failed') {
        const message = terminal.failureMessage ?? 'Antigravity turn failed'
        this.emitFrame({ kind: 'agent-error', sessionId: activeSession.sessionId, message })
        throw new Error(message)
      }
      return { sessionId: activeSession.sessionId }
    } catch (error: unknown) {
      // The turn never published (spawn/startup failure): clean up here.
      if (activeSession.turnSettled === settled) {
        this.finishTurn(activeSession)
        const message = error instanceof Error ? error.message : String(error)
        this.emitFrame({ kind: 'agent-error', sessionId: activeSession.sessionId, message })
      }
      throw error
    }
  }

  /**
   * Stop one Antigravity-backed session (or every running one) by tearing down
   * its child. The conversation itself survives: the next run resumes it by id.
   */
  async stop(sessionId?: string): Promise<void> {
    const targets = sessionId !== undefined
      ? [this.sessions.get(sessionId)]
      : [...this.sessions.values()].filter((item) => item.running)
    for (const session of targets) {
      if (!session) continue
      const child = session.child
      if (!child) continue
      delete session.child
      if (session.turnSettled) {
        session.turnSettled.resolve({ status: 'failed', failureMessage: 'Antigravity turn was stopped.' })
        this.finishTurn(session)
      }
      await killProcessTree(child)
    }
  }

  async close(): Promise<void> {
    this.stopping = true
    const children: ChildProcess[] = []
    for (const session of this.sessions.values()) {
      if (session.child) {
        children.push(session.child)
        delete session.child
      }
      if (!session.running) continue
      session.turnSettled?.resolve({ status: 'failed', failureMessage: 'Antigravity engine stopped before the turn completed.' })
      this.finishTurn(session)
      this.emitFrame({ kind: 'agent-error', sessionId: session.sessionId, message: 'Antigravity engine stopped before the turn completed.' })
    }
    await Promise.all(children.map((child) => killProcessTree(child)))
    this.stopping = false
  }

  /**
   * Reuse the session's live child or spawn a fresh `agy` process for it. A
   * respawn resumes the recorded conversation by id so ND-side history and
   * Antigravity-side context stay the same conversation.
   */
  private ensureChild(session: AntigravitySession): ChildProcess {
    const existing = session.child
    if (existing && existing.exitCode === null && existing.signalCode === null) return existing

    const bin = antigravityBinPath()
    if (!bin) throw new Error('The Antigravity CLI (agy) is not installed. Install it from https://antigravity.google or set ND_DSH_ANTIGRAVITY_BINARY.')
    const argv = [bin, '--output-format', 'stream-json', '--input-format', 'stream-json', '--disable-slash-commands']
    const resolvedPermissionMode = session.permissionMode
      ?? (process.env.ND_DSH_PERMISSION_MODE?.trim() || 'workspace-write')
    const defaultMode = resolvedPermissionMode === 'read-only' ? 'plan' : 'accept-edits'
    const mode = process.env.ND_DSH_ANTIGRAVITY_MODE ?? this.options.mode ?? defaultMode
    if (mode) argv.push('--mode', mode)
    const defaultSkipPermissions = resolvedPermissionMode !== 'read-only'
    const skipPermissions = process.env.ND_DSH_ANTIGRAVITY_SKIP_PERMISSIONS !== '0'
      && process.env.ND_DSH_ANTIGRAVITY_SKIP_PERMISSIONS !== 'false'
      && (this.options.skipPermissions ?? defaultSkipPermissions)
    if (skipPermissions) argv.push('--dangerously-skip-permissions')
    if (session.conversationId !== undefined) argv.push('--conversation', session.conversationId)
    if (session.model !== undefined) argv.push('--model', session.model)
    // `agy` sandboxes its file tools to its own brain workspace; without this
    // mount the agent sees an empty scratch dir instead of the ND workspace.
    if (session.cwd !== undefined) argv.push('--add-dir', session.cwd)

    // Engines must never see ND's control-plane configuration.
    const environment: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('ND_DSH_') || key.startsWith('DSH_')) continue
      environment[key] = value
    }

    const log = this.options.log ?? ((line: string) => console.warn(line))
    const spawnProcess = this.options.spawnProcess ?? spawn
    const child = spawnProcess(argv[0] as string, argv.slice(1), {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: environment,
      cwd: session.cwd ?? process.cwd(),
      // A process group lets POSIX teardown take the whole tree down; Windows
      // uses taskkill /T instead.
      detached: process.platform !== 'win32',
    })
    session.child = child
    session.buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.consumeStdout(session, chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => log(`[antigravity] ${chunk.trimEnd()}`))
    child.stdin?.on('error', (error) => log(`[antigravity] stdin write failed: ${error.message}`))
    child.once('exit', (code, signal) => {
      if (session.child !== child) return // intentional teardown already handled it
      delete session.child
      if (this.stopping) return
      const message = `Antigravity CLI exited (${signal ?? String(code ?? 'unknown')}).`
      if (session.turnSettled) {
        session.turnSettled.resolve({ status: 'failed', failureMessage: message })
        this.finishTurn(session)
      }
    })
    child.once('error', (error) => {
      if (session.child !== child) return
      delete session.child
      if (this.stopping) return
      if (session.turnSettled) {
        session.turnSettled.resolve({ status: 'failed', failureMessage: error.message })
        this.finishTurn(session)
      }
    })
    return child
  }

  private consumeStdout(session: AntigravitySession, chunk: string): void {
    session.buffer += chunk
    let newline = session.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = session.buffer.slice(0, newline).trim()
      session.buffer = session.buffer.slice(newline + 1)
      if (line) this.handleWireLine(session, line)
      newline = session.buffer.indexOf('\n')
    }
  }

  private handleWireLine(session: AntigravitySession, line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.options.log?.(`[antigravity] dropping unparseable stdout line: ${line.slice(0, 200)}`)
      return
    }
    if (!isObject(parsed)) return
    const wire = parsed as AntigravityWireEvent
    if (typeof wire.conversation_id === 'string' && wire.conversation_id) session.conversationId = wire.conversation_id
    if (wire.event === 'step_update' && isObject(wire.step_update)) {
      this.handleStep(session, wire.step_update)
      return
    }
    if (wire.event === 'result' && isObject(wire.result)) {
      this.handleResult(session, wire.result)
      return
    }
  }

  private handleStep(session: AntigravitySession, step: AntigravityStepUpdate): void {
    if (step.step_type === 'agent_response') {
      const text = typeof step.text_delta === 'string' ? step.text_delta : ''
      const stepIndex = typeof step.step_index === 'number' ? step.step_index : undefined
      if (!session.assistantResponse && stepIndex !== undefined
        && stepIndex === session.lastAssistantStepIndex && step.state === 'DONE'
        && (!text || text.trim() === session.lastAssistantText?.trim())) return
      if (session.assistantResponse && session.assistantResponse.stepIndex !== stepIndex) {
        this.finishAssistantResponse(session)
      }
      const response = session.assistantResponse ?? { stepIndex, text: '', lastDelta: '' }
      session.assistantResponse = response
      // DONE can replay the text already delivered by the active update.
      if (text && !(step.state === 'DONE' && text === response.lastDelta)) {
        response.text += text
        response.lastDelta = text
        this.recordEnvelope(session, {
          type: 'assistant/chunk',
          data: { chunk: { content: [{ type: 'text', text }] } },
        })
      }
      // Keep the step open until the next step/result: text_delta updates are
      // fragments, and the terminal result owns the complete response.
      return
    }
    if (step.step_type !== 'tool') return
    this.finishAssistantResponse(session)
    const callId = typeof step.step_index === 'number' ? `step-${step.step_index}` : `step-${session.sequence + 1}`
    const name = typeof step.tool_name === 'string' && step.tool_name
      ? step.tool_name
      : typeof step.tool_info?.name === 'string' ? step.tool_info.name : 'tool'
    if (step.state === 'ACTIVE') {
      this.recordToolCall(session, callId, name, step.tool_info?.parameters ?? null)
      return
    }
    if (step.state !== 'DONE' && step.state !== 'ERROR') return
    const failed = step.state === 'ERROR'
    const failure = isObject(step.tool_info?.error) ? step.tool_info.error : undefined
    const error = failed
      ? typeof failure?.message === 'string' ? summarize(failure.message) : `${name} failed`
      : undefined
    if (error) session.lastToolError = error
    this.recordToolResult(session, callId, error ?? 'completed', error)
  }

  private handleResult(session: AntigravitySession, result: AntigravityResult): void {
    this.finishAssistantResponse(session)
    const response = typeof result.response === 'string' ? result.response : ''
    if (response.trim() && response.trim() !== session.lastAssistantText?.trim()
      && response.trim() !== session.turnAssistantText.trim()) {
      this.recordAssistantMessage(session, response)
    }
    if (!session.turnSettled) return
    if (result.status === 'SUCCESS') {
      if (session.lastToolError || !session.turnAssistantText.trim()) {
        const permissionHint = session.lastToolError && /permission check failed|denied permission/i.test(session.lastToolError)
          ? `\n\nThe CLI cannot request permission in chat. Check that the selected project folder contains the file you want it to read.${session.cwd ? ` Current workspace: ${session.cwd}` : ''}`
          : ''
        session.turnSettled.resolve({
          status: 'failed',
          failureMessage: session.lastToolError
            ? `Antigravity ended without a reply after a tool failed: ${session.lastToolError}${permissionHint}`
            : 'Antigravity ended this turn without a reply. Please retry.',
        })
        return
      }
      session.turnSettled.resolve({ status: 'success' })
      return
    }
    const failure = typeof result.error === 'string'
      ? result.error
      : isObject(result.error) && typeof result.error.message === 'string' ? result.error.message : undefined
    session.turnSettled.resolve({
      status: 'failed',
      ...(failure === undefined ? {} : { failureMessage: failure }),
    })
  }

  private finishTurn(session: AntigravitySession): void {
    const wasActive = session.running || session.turnSettled !== undefined
    if (!wasActive) return
    this.finishAssistantResponse(session)
    session.running = false
    delete session.turnSettled
    session.updatedAt = Date.now()
    this.emitFrame({ kind: 'session-status', sessionId: session.sessionId, running: false })
  }

  private recordUserMessage(session: AntigravitySession, text: string): void {
    this.recordEnvelope(session, {
      type: 'user/message',
      data: { message: { role: 'user', content: [{ type: 'text', text }] } },
    })
  }

  private recordAssistantMessage(session: AntigravitySession, text: string): void {
    delete session.lastToolError
    session.lastAssistantText = text
    session.turnAssistantText += text
    this.recordEnvelope(session, {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
    })
  }

  private finishAssistantResponse(session: AntigravitySession): void {
    const response = session.assistantResponse
    if (!response) return
    delete session.assistantResponse
    if (response.stepIndex !== undefined) session.lastAssistantStepIndex = response.stepIndex
    else delete session.lastAssistantStepIndex
    if (response.text) this.recordAssistantMessage(session, response.text)
  }

  private recordToolCall(session: AntigravitySession, callId: string, name: string, args: unknown): void {
    this.recordEnvelope(session, { type: 'tool/call', data: { callId, name, arguments: args } })
  }

  private recordToolResult(session: AntigravitySession, callId: string, result: string, error?: string): void {
    this.recordEnvelope(session, {
      type: 'tool/result',
      data: { callId, message: { content: [{ type: 'text', text: result }] }, ...(error === undefined ? {} : { error }) },
    })
  }

  private recordEnvelope(session: AntigravitySession, partial: { type: string; data?: unknown }): void {
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
