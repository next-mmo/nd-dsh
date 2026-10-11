import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  DshEventFrame,
  EngineSessionSummary,
  EngineSessionTranscript,
  SessionEventEnvelope,
} from '../../../shared/contracts.js'
import { CURSOR_CLI_ENGINE_ID } from '../../../shared/coding-engines.js'
import { stripWorkspaceContext } from '../../../shared/workspace-context.js'
import { cursorBinPath } from '../../app-paths.js'
import {
  deferred,
  engineEnvironment,
  killProcessTree,
  spawnCliCommand,
  summarize,
  TRANSCRIPT_EVENT_TYPES,
  type Deferred,
} from '../agent-cli/agent-cli-support.js'

/**
 * ND-owned direct Cursor engine. Each turn spawns the documented headless
 * `cursor-agent -p` child with `--output-format stream-json` and translates
 * its NDJSON events into the shared `DshEventFrame` vocabulary. Follow-up
 * prompts resume the native conversation by session id. Native Cursor
 * authentication and model configuration stay authoritative; `--force` is
 * required for the agent to actually apply file changes headlessly, and
 * without it Cursor only proposes diffs.
 */

/** Windows CreateProcess command lines cap out far below ND's prompt limit. */
const CURSOR_PROMPT_MAX_CHARS = 30_000

const LOCAL_TRANSCRIPT_EVENTS = 32

interface TurnOutcome {
  status: string
  failureMessage?: string
}

interface CursorSession {
  sessionId: string
  /** Native Cursor conversation id, learned from the event stream. */
  nativeSessionId?: string
  cwd?: string
  model?: string
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
  /** The `result` event settles the turn; process exit is the fallback. */
  resultSeen: boolean
  turnAssistantText: string
}

export interface CursorCliEngineOptions {
  /** Diagnostic sink for CLI stderr and lifecycle warnings. */
  log?: (line: string) => void
  /** Test seam: process spawner (defaults to node:child_process.spawn). */
  spawnProcess?: typeof spawn
}

export class CursorCliEngine {
  private readonly sessions = new Map<string, CursorSession>()
  private onEvent: ((frame: DshEventFrame) => void) | undefined
  private stopping = false

  constructor(private readonly options: CursorCliEngineOptions = {}) {}

  /** Frames translated into the shared event vocabulary leave through here. */
  setEmitter(emit: (frame: DshEventFrame) => void): void {
    this.onEvent = emit
  }

  ready(): boolean {
    return cursorBinPath() !== undefined
  }

  /** Whether a session id belongs to this engine (run routing). */
  ownsSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** Headless `cursor-agent -p` has no programmatic approval surface. */
  handlesApproval(_rpcId: string): boolean {
    return false
  }

  /** No approval can ever pend here; answering one is a routing bug. */
  async respond(rpcId: string, _value: unknown): Promise<void> {
    throw new Error(`Unknown ${CURSOR_CLI_ENGINE_ID} approval: ${rpcId}`)
  }

  /** Model configuration stays native to Cursor; ND exposes no picker yet. */
  async listModels(): Promise<never[]> {
    return []
  }

  listSessions(): EngineSessionSummary[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => ({
        sessionId: session.sessionId,
        engineId: CURSOR_CLI_ENGINE_ID,
        title: session.title,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        running: session.running,
      }))
  }

  transcript(sessionId: string): EngineSessionTranscript {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown ${CURSOR_CLI_ENGINE_ID} session: ${sessionId}`)
    return { sessionId, engineId: CURSOR_CLI_ENGINE_ID, events: [...session.transcript] }
  }

  async createSession(input: { cwd?: string; model?: string } = {}): Promise<{ sessionId: string }> {
    const sessionId = `cursor-${randomUUID()}`
    const now = Date.now()
    const session: CursorSession = {
      sessionId,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.model === undefined ? {} : { model: input.model }),
      title: 'New Cursor chat',
      createdAt: now,
      updatedAt: now,
      running: false,
      sequence: 0,
      transcript: [],
      buffer: '',
      resultSeen: false,
      turnAssistantText: '',
    }
    this.sessions.set(sessionId, session)
    this.emitFrame({ kind: 'session-added', sessionId, meta: { engineId: CURSOR_CLI_ENGINE_ID } })
    return { sessionId }
  }

  /**
   * Submit one prompt to a Cursor-backed session (created lazily when no id
   * is given). Each turn is one headless child; follow-ups resume the native
   * conversation by session id. The promise settles with the `result` event.
   */
  async run(prompt: string, options: { sessionId?: string; cwd?: string; model?: string } = {}): Promise<{ sessionId: string }> {
    const cleaned = prompt.trim()
    if (!cleaned) throw new Error('Prompt cannot be empty')
    if (cleaned.length > CURSOR_PROMPT_MAX_CHARS) throw new Error(`Prompt exceeds the ${CURSOR_PROMPT_MAX_CHARS.toLocaleString()} character limit of the Cursor CLI headless mode`)

    let session = options.sessionId !== undefined ? this.sessions.get(options.sessionId) : undefined
    if (options.sessionId !== undefined && !session) throw new Error(`Unknown ${CURSOR_CLI_ENGINE_ID} session: ${options.sessionId}`)
    if (!session) {
      const created = await this.createSession({
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.model === undefined ? {} : { model: options.model }),
      })
      session = this.sessions.get(created.sessionId)
    }
    if (!session) throw new Error(`${CURSOR_CLI_ENGINE_ID} session could not be created`)
    const activeSession = session
    if (activeSession.running) throw new Error('This Cursor chat already has an active turn')
    if (options.cwd !== undefined) activeSession.cwd = options.cwd
    if (options.model !== undefined) activeSession.model = options.model

    const settled = deferred<TurnOutcome>()
    activeSession.turnSettled = settled
    activeSession.resultSeen = false
    activeSession.turnAssistantText = ''
    try {
      const userPrompt = stripWorkspaceContext(cleaned)
      this.recordUserMessage(activeSession, userPrompt)
      if (activeSession.title === 'New Cursor chat') activeSession.title = userPrompt.slice(0, 80)
      this.spawnTurn(activeSession, cleaned)
      activeSession.running = true
      activeSession.updatedAt = Date.now()
      this.emitFrame({ kind: 'session-status', sessionId: activeSession.sessionId, running: true })
      const terminal = await settled.promise
      this.finishTurn(activeSession)
      if (terminal.status === 'failed') {
        const message = terminal.failureMessage ?? 'Cursor turn failed'
        this.emitFrame({ kind: 'agent-error', sessionId: activeSession.sessionId, message })
        throw new Error(message)
      }
      return { sessionId: activeSession.sessionId }
    } catch (error: unknown) {
      // The turn never published (spawn failure): clean up here.
      if (activeSession.turnSettled === settled) {
        this.finishTurn(activeSession)
        const message = error instanceof Error ? error.message : String(error)
        this.emitFrame({ kind: 'agent-error', sessionId: activeSession.sessionId, message })
      }
      throw error
    }
  }

  /** Stop one Cursor-backed session (or every running one) by killing its turn child. */
  async stop(sessionId?: string): Promise<void> {
    const targets = sessionId !== undefined
      ? [this.sessions.get(sessionId)]
      : [...this.sessions.values()].filter((item) => item.running)
    for (const session of targets) {
      if (!session) continue
      const child = session.child
      if (!child) continue
      delete session.child
      if (session.turnSettled && !session.resultSeen) {
        session.turnSettled.resolve({ status: 'failed', failureMessage: 'Cursor turn was stopped.' })
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
      session.turnSettled?.resolve({ status: 'failed', failureMessage: 'Cursor engine stopped before the turn completed.' })
      this.finishTurn(session)
      this.emitFrame({ kind: 'agent-error', sessionId: session.sessionId, message: 'Cursor engine stopped before the turn completed.' })
    }
    await Promise.all(children.map((child) => killProcessTree(child)))
    this.stopping = false
  }

  /**
   * Spawn one headless `cursor-agent -p` child for this turn. `--force` lets
   * the agent apply its file changes; without it Cursor only proposes diffs
   * and no coding work would reach the workspace.
   */
  private spawnTurn(session: CursorSession, prompt: string): void {
    const bin = cursorBinPath()
    if (!bin) throw new Error('The Cursor CLI is not installed. Install it from https://cursor.com/docs/cli/installation or set ND_DSH_CURSOR_BINARY.')
    const argv = ['-p', '--output-format', 'stream-json', '--force']
    if (session.nativeSessionId !== undefined) argv.push(`--resume=${session.nativeSessionId}`)
    if (session.model !== undefined) argv.push('--model', session.model)
    argv.push(prompt)

    const log = this.options.log ?? ((line: string) => console.warn(line))
    const spawnProcess = this.options.spawnProcess ?? spawn
    const child = spawnCliCommand(spawnProcess, bin, argv, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: engineEnvironment(),
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
    child.stderr?.on('data', (chunk: string) => log(`[cursor] ${chunk.trimEnd()}`))
    child.stdin?.end()
    child.once('exit', (code, signal) => {
      if (session.child !== child) return // stop() already handled the teardown
      delete session.child
      if (this.stopping) return
      if (session.resultSeen) return // the turn already settled on its result event
      const message = `Cursor CLI exited (${signal ?? String(code ?? 'unknown')}).`
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
  }

  private consumeStdout(session: CursorSession, chunk: string): void {
    session.buffer += chunk
    let newline = session.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = session.buffer.slice(0, newline).trim()
      session.buffer = session.buffer.slice(newline + 1)
      if (line) this.handleWireLine(session, line)
      newline = session.buffer.indexOf('\n')
    }
  }

  private handleWireLine(session: CursorSession, line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.options.log?.(`[cursor] dropping unparseable stdout line: ${line.slice(0, 200)}`)
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const wire = parsed as Record<string, unknown>
    if (typeof wire.session_id === 'string' && wire.session_id) session.nativeSessionId = wire.session_id

    if (wire.type === 'assistant' && typeof wire.message === 'object' && wire.message !== null) {
      this.handleAssistantMessage(session, wire.message as Record<string, unknown>)
      return
    }
    if (wire.type === 'tool_call') {
      this.handleToolCallEvent(session, wire)
      return
    }
    if (wire.type === 'result') {
      session.resultSeen = true
      if (session.turnSettled) {
        if (session.turnAssistantText.trim()) {
          session.turnSettled.resolve({ status: 'success' })
        } else {
          session.turnSettled.resolve({
            status: 'failed',
            failureMessage: 'Cursor ended this turn without a reply. Please retry.',
          })
        }
      }
      return
    }
    // `system`/init carries the model; anything else stays out of the surface.
  }

  private handleAssistantMessage(session: CursorSession, message: Record<string, unknown>): void {
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const record = block as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string' && record.text.trim()) {
        this.recordAssistantMessage(session, record.text)
      }
    }
  }

  private handleToolCallEvent(session: CursorSession, wire: Record<string, unknown>): void {
    const subtype = typeof wire.subtype === 'string' ? wire.subtype : ''
    const toolCall = typeof wire.tool_call === 'object' && wire.tool_call !== null
      ? wire.tool_call as Record<string, unknown>
      : undefined
    if (!toolCall) return
    const name = typeof toolCall.type === 'string' && toolCall.type ? toolCall.type : 'tool'
    const callId = typeof toolCall.tool_call_id === 'string' && toolCall.tool_call_id
      ? toolCall.tool_call_id
      : `tool-${session.sequence + 1}`
    if (subtype === 'started') {
      this.recordToolCall(session, callId, name, toolCall.args ?? toolCall.input ?? null)
      return
    }
    if (subtype === 'completed') {
      const result = typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result ?? null)
      this.recordToolResult(session, callId, summarize(result))
    }
  }

  private finishTurn(session: CursorSession): void {
    const wasActive = session.running || session.turnSettled !== undefined
    if (!wasActive) return
    session.running = false
    delete session.turnSettled
    session.updatedAt = Date.now()
    this.emitFrame({ kind: 'session-status', sessionId: session.sessionId, running: false })
  }

  private recordUserMessage(session: CursorSession, text: string): void {
    this.recordEnvelope(session, {
      type: 'user/message',
      data: { message: { role: 'user', content: [{ type: 'text', text }] } },
    })
  }

  private recordAssistantMessage(session: CursorSession, text: string): void {
    session.turnAssistantText += text
    this.recordEnvelope(session, {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
    })
  }

  private recordToolCall(session: CursorSession, callId: string, name: string, args: unknown): void {
    this.recordEnvelope(session, { type: 'tool/call', data: { callId, name, arguments: args } })
  }

  private recordToolResult(session: CursorSession, callId: string, result: string): void {
    this.recordEnvelope(session, {
      type: 'tool/result',
      data: { callId, message: { content: [{ type: 'text', text: result }] } },
    })
  }

  private recordEnvelope(session: CursorSession, partial: { type: string; data?: unknown }): void {
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
