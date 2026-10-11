import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  DshEventFrame,
  EngineSessionSummary,
  EngineSessionTranscript,
  SessionEventEnvelope,
} from '../../../shared/contracts.js'
import { CLAUDE_CODE_CLI_ENGINE_ID } from '../../../shared/coding-engines.js'
import { stripWorkspaceContext } from '../../../shared/workspace-context.js'
import { claudeBinPath } from '../../app-paths.js'
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
 * ND-owned direct Claude Code engine. Each ND session hosts one long-lived
 * `claude` CLI child driven over the documented headless stream-json wires:
 * `--input-format stream-json` user messages in, NDJSON
 * system/assistant/user/result events back on stdout. Native Claude
 * authentication, model, and settings stay authoritative; headless permission
 * prompts are denied by the CLI itself, so file edits flow through ND's
 * `acceptEdits` posture and anything riskier stays fail-closed. A child death
 * is healed on the next run by resuming the persisted conversation by its
 * native session id.
 */

const RESULT_MAX_CHARS = 4_000
const LOCAL_TRANSCRIPT_EVENTS = 32

interface TurnOutcome {
  status: string
  failureMessage?: string
}

interface ClaudeSession {
  sessionId: string
  /** Native Claude conversation id, learned from the `system/init` event. */
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
  /** Assistant/tool usage this turn, for the empty-turn sanity check. */
  turnAssistantText: string
}

export interface ClaudeCodeCliEngineOptions {
  /** Diagnostic sink for CLI stderr and lifecycle warnings. */
  log?: (line: string) => void
  /** Test seam: process spawner (defaults to node:child_process.spawn). */
  spawnProcess?: typeof spawn
}

export class ClaudeCodeCliEngine {
  private readonly sessions = new Map<string, ClaudeSession>()
  private onEvent: ((frame: DshEventFrame) => void) | undefined
  private stopping = false

  constructor(private readonly options: ClaudeCodeCliEngineOptions = {}) {}

  /** Frames translated into the shared event vocabulary leave through here. */
  setEmitter(emit: (frame: DshEventFrame) => void): void {
    this.onEvent = emit
  }

  ready(): boolean {
    return claudeBinPath() !== undefined
  }

  /** Whether a session id belongs to this engine (run routing). */
  ownsSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** Headless `claude -p` has no programmatic approval surface. */
  handlesApproval(_rpcId: string): boolean {
    return false
  }

  /** No approval can ever pend here; answering one is a routing bug. */
  async respond(rpcId: string, _value: unknown): Promise<void> {
    throw new Error(`Unknown ${CLAUDE_CODE_CLI_ENGINE_ID} approval: ${rpcId}`)
  }

  /** Model configuration stays native to Claude Code; ND exposes no picker yet. */
  async listModels(): Promise<never[]> {
    return []
  }

  listSessions(): EngineSessionSummary[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => ({
        sessionId: session.sessionId,
        engineId: CLAUDE_CODE_CLI_ENGINE_ID,
        title: session.title,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        running: session.running,
      }))
  }

  transcript(sessionId: string): EngineSessionTranscript {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown ${CLAUDE_CODE_CLI_ENGINE_ID} session: ${sessionId}`)
    return { sessionId, engineId: CLAUDE_CODE_CLI_ENGINE_ID, events: [...session.transcript] }
  }

  async createSession(input: { cwd?: string; model?: string } = {}): Promise<{ sessionId: string }> {
    const sessionId = `claude-${randomUUID()}`
    const now = Date.now()
    const session: ClaudeSession = {
      sessionId,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.model === undefined ? {} : { model: input.model }),
      title: 'New Claude Code chat',
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
    this.emitFrame({ kind: 'session-added', sessionId, meta: { engineId: CLAUDE_CODE_CLI_ENGINE_ID } })
    return { sessionId }
  }

  /**
   * Submit one prompt to a Claude Code-backed session (created lazily when no
   * id is given). Progress streams out as frames; the promise settles with the
   * turn, which is exactly one `result` event on the child's stdout.
   */
  async run(prompt: string, options: { sessionId?: string; cwd?: string; model?: string } = {}): Promise<{ sessionId: string }> {
    const cleaned = prompt.trim()
    if (!cleaned) throw new Error('Prompt cannot be empty')
    if (cleaned.length > 100_000) throw new Error('Prompt exceeds the 100,000 character limit')

    let session = options.sessionId !== undefined ? this.sessions.get(options.sessionId) : undefined
    if (options.sessionId !== undefined && !session) throw new Error(`Unknown ${CLAUDE_CODE_CLI_ENGINE_ID} session: ${options.sessionId}`)
    if (!session) {
      const created = await this.createSession({
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.model === undefined ? {} : { model: options.model }),
      })
      session = this.sessions.get(created.sessionId)
    }
    if (!session) throw new Error(`${CLAUDE_CODE_CLI_ENGINE_ID} session could not be created`)
    const activeSession = session
    if (activeSession.running) throw new Error('This Claude Code chat already has an active turn')
    if (options.cwd !== undefined) activeSession.cwd = options.cwd
    if (options.model !== undefined) activeSession.model = options.model

    const settled = deferred<TurnOutcome>()
    activeSession.turnSettled = settled
    activeSession.resultSeen = false
    activeSession.turnAssistantText = ''
    try {
      const userPrompt = stripWorkspaceContext(cleaned)
      this.recordUserMessage(activeSession, userPrompt)
      if (activeSession.title === 'New Claude Code chat') activeSession.title = userPrompt.slice(0, 80)
      const child = this.ensureChild(activeSession)
      activeSession.running = true
      activeSession.updatedAt = Date.now()
      this.emitFrame({ kind: 'session-status', sessionId: activeSession.sessionId, running: true })
      child.stdin?.write(`${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: cleaned }] },
        parent_tool_use_id: null,
      })}\n`)
      const terminal = await settled.promise
      this.finishTurn(activeSession)
      if (terminal.status === 'failed') {
        const message = terminal.failureMessage ?? 'Claude Code turn failed'
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
   * Stop one Claude Code-backed session (or every running one) by tearing
   * down its child. The conversation itself survives: the next run resumes it
   * by its native session id.
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
      if (session.turnSettled && !session.resultSeen) {
        session.turnSettled.resolve({ status: 'failed', failureMessage: 'Claude Code turn was stopped.' })
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
      session.turnSettled?.resolve({ status: 'failed', failureMessage: 'Claude Code engine stopped before the turn completed.' })
      this.finishTurn(session)
      this.emitFrame({ kind: 'agent-error', sessionId: session.sessionId, message: 'Claude Code engine stopped before the turn completed.' })
    }
    await Promise.all(children.map((child) => killProcessTree(child)))
    this.stopping = false
  }

  /**
   * Reuse the session's live child or spawn a fresh `claude` process for it.
   * A respawn resumes the recorded native conversation so ND-side history and
   * Claude-side context stay the same conversation. Headless runs use
   * `acceptEdits`: file edits apply without prompting while riskier tools
   * stay denied by the CLI itself.
   */
  private ensureChild(session: ClaudeSession): ChildProcess {
    const existing = session.child
    if (existing && existing.exitCode === null && existing.signalCode === null) return existing

    const bin = claudeBinPath()
    if (!bin) throw new Error('The Claude Code CLI is not installed. Install it from https://claude.com/product/claude-code or set ND_DSH_CLAUDE_BINARY.')
    const argv = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'acceptEdits',
    ]
    if (session.nativeSessionId !== undefined) argv.push('--resume', session.nativeSessionId)
    if (session.model !== undefined) argv.push('--model', session.model)

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
    child.stderr?.on('data', (chunk: string) => log(`[claude] ${chunk.trimEnd()}`))
    child.stdin?.on('error', (error) => log(`[claude] stdin write failed: ${error.message}`))
    child.once('exit', (code, signal) => {
      if (session.child !== child) return // intentional teardown already handled it
      delete session.child
      if (this.stopping) return
      if (session.resultSeen) return // the turn already settled on its result event
      const message = `Claude Code CLI exited (${signal ?? String(code ?? 'unknown')}).`
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

  private consumeStdout(session: ClaudeSession, chunk: string): void {
    session.buffer += chunk
    let newline = session.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = session.buffer.slice(0, newline).trim()
      session.buffer = session.buffer.slice(newline + 1)
      if (line) this.handleWireLine(session, line)
      newline = session.buffer.indexOf('\n')
    }
  }

  private handleWireLine(session: ClaudeSession, line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.options.log?.(`[claude] dropping unparseable stdout line: ${line.slice(0, 200)}`)
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const wire = parsed as Record<string, unknown>
    if (typeof wire.session_id === 'string' && wire.session_id) session.nativeSessionId = wire.session_id

    if (wire.type === 'assistant' && typeof wire.message === 'object' && wire.message !== null) {
      this.handleAssistantMessage(session, wire.message as Record<string, unknown>)
      return
    }
    if (wire.type === 'user' && typeof wire.message === 'object' && wire.message !== null) {
      this.handleUserMessage(session, wire.message as Record<string, unknown>)
      return
    }
    if (wire.type === 'result') {
      this.handleResult(session, wire)
      return
    }
    // `system`/init (session id, model), `stream_event` partials (the
    // completed assistant messages above already carry the full text), and
    // control responses stay out of the surface.
  }

  private handleAssistantMessage(session: ClaudeSession, message: Record<string, unknown>): void {
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const record = block as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string' && record.text.trim()) {
        this.recordAssistantMessage(session, record.text)
        continue
      }
      if (record.type === 'thinking' && typeof record.thinking === 'string' && record.thinking.trim()) {
        this.recordEnvelope(session, { type: 'agent/reasoning', data: { text: record.thinking } })
        continue
      }
      if (record.type === 'tool_use') {
        const callId = typeof record.id === 'string' && record.id ? record.id : `tool-${session.sequence + 1}`
        const name = typeof record.name === 'string' && record.name ? record.name : 'tool'
        this.recordToolCall(session, callId, name, record.input ?? null)
      }
    }
  }

  private handleUserMessage(session: ClaudeSession, message: Record<string, unknown>): void {
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const record = block as Record<string, unknown>
      if (record.type !== 'tool_result') continue
      const callId = typeof record.tool_use_id === 'string' ? record.tool_use_id : `tool-${session.sequence + 1}`
      const failed = record.is_error === true
      const text = toolResultText(record.content)
      this.recordToolResult(session, callId, summarize(text), failed ? summarize(text) || 'tool failed' : undefined)
    }
  }

  private handleResult(session: ClaudeSession, wire: Record<string, unknown>): void {
    session.resultSeen = true
    if (!session.turnSettled) return
    const subtype = typeof wire.subtype === 'string' ? wire.subtype : 'success'
    const resultText = typeof wire.result === 'string' && wire.result.trim() ? wire.result : undefined
    // The CLI reports auth/API failures as subtype "success" with is_error
    // set; those must surface as failed turns, not as a model reply.
    if (subtype === 'success' && wire.is_error !== true) {
      if (!session.turnAssistantText.trim()) {
        session.turnSettled.resolve({
          status: 'failed',
          failureMessage: 'Claude Code ended this turn without a reply. Please retry.',
        })
        return
      }
      session.turnSettled.resolve({ status: 'success' })
      return
    }
    const failure = resultText ?? `Claude Code turn failed (${subtype})`
    session.turnSettled.resolve({ status: 'failed', failureMessage: failure })
  }

  private finishTurn(session: ClaudeSession): void {
    const wasActive = session.running || session.turnSettled !== undefined
    if (!wasActive) return
    session.running = false
    delete session.turnSettled
    session.updatedAt = Date.now()
    this.emitFrame({ kind: 'session-status', sessionId: session.sessionId, running: false })
  }

  private recordUserMessage(session: ClaudeSession, text: string): void {
    this.recordEnvelope(session, {
      type: 'user/message',
      data: { message: { role: 'user', content: [{ type: 'text', text }] } },
    })
  }

  private recordAssistantMessage(session: ClaudeSession, text: string): void {
    session.turnAssistantText += text
    this.recordEnvelope(session, {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
    })
  }

  private recordToolCall(session: ClaudeSession, callId: string, name: string, args: unknown): void {
    this.recordEnvelope(session, { type: 'tool/call', data: { callId, name, arguments: args } })
  }

  private recordToolResult(session: ClaudeSession, callId: string, result: string, error?: string): void {
    this.recordEnvelope(session, {
      type: 'tool/result',
      data: { callId, message: { content: [{ type: 'text', text: result }] }, ...(error === undefined ? {} : { error }) },
    })
  }

  private recordEnvelope(session: ClaudeSession, partial: { type: string; data?: unknown }): void {
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

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'text'
      && typeof (block as Record<string, unknown>).text === 'string') {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.join('\n')
}
