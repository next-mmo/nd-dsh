import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  DshEventFrame,
  EngineSessionSummary,
  EngineSessionTranscript,
  SessionEventEnvelope,
} from '../../../shared/contracts.js'
import { stripWorkspaceContext } from '../../../shared/workspace-context.js'
import { noteModelUsage } from '../../metrics/task-metrics.js'
import {
  deferred,
  engineEnvironment,
  killProcessTree,
  spawnCliCommand,
  summarize,
  type Deferred,
} from './agent-cli-support.js'

const LOCAL_TRANSCRIPT_EVENTS = 32

export type StructuredCliEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'text-replace'; text: string }
  /**
   * One model call completed inside the CLI's own agent loop. ND cannot see a
   * CLI's model calls directly, so an engine whose wire exposes step
   * boundaries reports them here; that is what makes a turn's model round
   * trips countable instead of collapsing to "one turn".
   */
  | { kind: 'step'; usage?: { inputTokens?: number; outputTokens?: number } }
  | { kind: 'tool-start'; callId?: string; name: string; input?: unknown }
  | { kind: 'tool-result'; callId?: string; name?: string; output: unknown; isError?: boolean }
  | { kind: 'done'; text?: string; failed?: boolean; message?: string }
  | { kind: 'error'; message: string }

export interface StructuredCliAdapter {
  id: string
  label: string
  sessionPrefix: string
  binary(): string | undefined
  unavailableMessage: string
  buildArgs(input: { prompt: string; cwd: string; sessionId: string; isContinuation: boolean; model?: string; nativeSessionId?: string }): string[]
  parse(value: Record<string, unknown>): StructuredCliEvent[]
}

interface TurnOutcome {
  status: 'success' | 'failed'
  failureMessage?: string
}

interface StructuredCliSession {
  sessionId: string
  nativeSessionId?: string
  cwd?: string
  model?: string
  title: string
  createdAt: number
  updatedAt: number
  running: boolean
  sequence: number
  transcript: SessionEventEnvelope[]
  child?: ChildProcess
  buffer: string
  doneSeen: boolean
  turnAssistantText: string
  turnToolCalls: Set<string>
  pendingToolCalls: Array<{ callId: string; name: string }>
  continuationReady: boolean
  turnSettled?: Deferred<TurnOutcome>
  terminalOutcome?: TurnOutcome
}

export interface StructuredCliEngineOptions {
  log?: (line: string) => void
  spawnProcess?: typeof spawn
}

/**
 * Generic ND adapter for coding CLIs that expose one JSON object per stdout
 * line. Vendor-specific code is deliberately limited to argv construction and
 * event translation; session ownership, cancellation and transcript behavior
 * stay identical across engines.
 */
export class StructuredCliEngine {
  private readonly sessions = new Map<string, StructuredCliSession>()
  private onEvent: ((frame: DshEventFrame) => void) | undefined
  private stopping = false

  constructor(
    private readonly adapter: StructuredCliAdapter,
    private readonly options: StructuredCliEngineOptions = {},
  ) {}

  setEmitter(emit: (frame: DshEventFrame) => void): void {
    this.onEvent = emit
  }

  ready(): boolean {
    return this.adapter.binary() !== undefined
  }

  ownsSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  handlesApproval(_rpcId: string): boolean {
    return false
  }

  async respond(rpcId: string, _value: unknown): Promise<void> {
    throw new Error(`Unknown ${this.adapter.id} approval: ${rpcId}`)
  }

  async listModels(): Promise<never[]> {
    return []
  }

  listSessions(): EngineSessionSummary[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => ({
        sessionId: session.sessionId,
        engineId: this.adapter.id,
        title: session.title,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        running: session.running,
      }))
  }

  transcript(sessionId: string): EngineSessionTranscript {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown ${this.adapter.id} session: ${sessionId}`)
    return { sessionId, engineId: this.adapter.id, events: [...session.transcript] }
  }

  async createSession(input: { cwd?: string; model?: string } = {}): Promise<{ sessionId: string }> {
    const sessionId = `${this.adapter.sessionPrefix}-${randomUUID()}`
    const now = Date.now()
    this.sessions.set(sessionId, {
      sessionId,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.model === undefined ? {} : { model: input.model }),
      title: `New ${this.adapter.label} chat`,
      createdAt: now,
      updatedAt: now,
      running: false,
      sequence: 0,
      transcript: [],
      buffer: '',
      doneSeen: false,
      turnAssistantText: '',
      turnToolCalls: new Set<string>(),
      pendingToolCalls: [],
      continuationReady: false,
    })
    this.emitFrame({ kind: 'session-added', sessionId, meta: { engineId: this.adapter.id } })
    return { sessionId }
  }

  async run(prompt: string, options: { sessionId?: string; cwd?: string; model?: string } = {}): Promise<{ sessionId: string }> {
    const cleaned = prompt.trim()
    if (!cleaned) throw new Error('Prompt cannot be empty')

    let session = options.sessionId === undefined ? undefined : this.sessions.get(options.sessionId)
    if (options.sessionId !== undefined && !session) throw new Error(`Unknown ${this.adapter.id} session: ${options.sessionId}`)
    if (!session) {
      const created = await this.createSession({
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.model === undefined ? {} : { model: options.model }),
      })
      session = this.sessions.get(created.sessionId)
    }
    if (!session) throw new Error(`${this.adapter.id} session could not be created`)
    if (session.running) throw new Error(`This ${this.adapter.label} chat already has an active turn`)
    if (options.cwd !== undefined) session.cwd = options.cwd
    if (options.model !== undefined) session.model = options.model
    const cwd = session.cwd ?? process.cwd()

    const settled = deferred<TurnOutcome>()
    session.turnSettled = settled
    session.doneSeen = false
    session.turnAssistantText = ''
    session.turnToolCalls.clear()
    session.pendingToolCalls = []
    delete session.terminalOutcome
    const userPrompt = stripWorkspaceContext(cleaned)
    this.recordUserMessage(session, userPrompt)
    if (session.title === `New ${this.adapter.label} chat`) session.title = userPrompt.slice(0, 80)

    try {
      this.spawnTurn(session, cleaned, cwd)
      session.running = true
      session.updatedAt = Date.now()
      this.emitFrame({ kind: 'session-status', sessionId: session.sessionId, running: true })
      const outcome = await settled.promise
      this.finishTurn(session)
      if (outcome.status === 'failed') {
        const message = outcome.failureMessage ?? `${this.adapter.label} turn failed`
        this.emitFrame({ kind: 'agent-error', sessionId: session.sessionId, message })
        throw new Error(message)
      }
      return { sessionId: session.sessionId }
    } catch (error: unknown) {
      if (session.turnSettled === settled) {
        this.finishTurn(session)
        const message = error instanceof Error ? error.message : String(error)
        this.emitFrame({ kind: 'agent-error', sessionId: session.sessionId, message })
      }
      throw error
    }
  }

  async stop(sessionId?: string): Promise<void> {
    const targets = sessionId === undefined
      ? [...this.sessions.values()].filter((item) => item.running)
      : [this.sessions.get(sessionId)]
    for (const session of targets) {
      if (!session?.child) continue
      const child = session.child
      delete session.child
      session.turnSettled?.resolve({ status: 'failed', failureMessage: `${this.adapter.label} turn was stopped.` })
      delete session.terminalOutcome
      this.finishTurn(session)
      await killProcessTree(child)
    }
  }

  async close(): Promise<void> {
    this.stopping = true
    await this.stop()
    this.stopping = false
  }

  private spawnTurn(session: StructuredCliSession, prompt: string, cwd: string): void {
    const bin = this.adapter.binary()
    if (!bin) throw new Error(this.adapter.unavailableMessage)
    const args = this.adapter.buildArgs({
      prompt,
      cwd,
      sessionId: session.sessionId,
      isContinuation: session.continuationReady,
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(session.nativeSessionId === undefined ? {} : { nativeSessionId: session.nativeSessionId }),
    })
    const spawnProcess = this.options.spawnProcess ?? spawn
    const child = spawnCliCommand(spawnProcess, bin, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: engineEnvironment(),
      cwd,
      detached: process.platform !== 'win32',
    })
    session.child = child
    session.buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.consumeStdout(session, chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => this.options.log?.(`[${this.adapter.id}] ${chunk.trimEnd()}`))
    child.stdin?.end()
    child.once('close', (code, signal) => {
      if (session.child !== child) return

      // ChildProcess "close" fires after stdio streams are closed, so it is
      // the safe point to flush a final JSON object that did not end in "\n".
      const trailing = session.buffer.trim()
      session.buffer = ''
      if (trailing) this.handleWireLine(session, trailing)

      delete session.child
      if (this.stopping) return

      const terminalOutcome = session.terminalOutcome
      if (code === 0 || terminalOutcome !== undefined) session.continuationReady = true
      this.finalizeAssistantMessage(session)
      delete session.terminalOutcome
      if (terminalOutcome) {
        session.turnSettled?.resolve(terminalOutcome)
        return
      }
      if (code === 0 && session.turnAssistantText.trim()) {
        session.turnSettled?.resolve({ status: 'success' })
      } else {
        const suffix = signal ?? String(code ?? 'unknown')
        session.turnSettled?.resolve({ status: 'failed', failureMessage: `${this.adapter.label} CLI exited (${suffix}).` })
      }
    })
    child.once('error', (error) => {
      if (session.child !== child) return
      delete session.child
      if (!this.stopping) session.turnSettled?.resolve({ status: 'failed', failureMessage: error.message })
    })
  }

  private consumeStdout(session: StructuredCliSession, chunk: string): void {
    session.buffer += chunk
    let newline = session.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = session.buffer.slice(0, newline).trim()
      session.buffer = session.buffer.slice(newline + 1)
      if (line) this.handleWireLine(session, line)
      newline = session.buffer.indexOf('\n')
    }
  }

  private handleWireLine(session: StructuredCliSession, line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.options.log?.(`[${this.adapter.id}] dropping non-JSON stdout line: ${line.slice(0, 200)}`)
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    for (const event of this.adapter.parse(parsed as Record<string, unknown>)) {
      if (event.kind === 'session') {
        if (event.sessionId) session.nativeSessionId = event.sessionId
        continue
      }
      if (event.kind === 'text') {
        if (event.text) this.recordAssistantChunk(session, event.text)
        continue
      }
      if (event.kind === 'text-replace') {
        session.turnAssistantText = event.text
        continue
      }
      if (event.kind === 'step') {
        noteModelUsage(session.sessionId, 'cli-steps', event.usage)
        continue
      }
      if (event.kind === 'tool-start') {
        const callId = event.callId ?? `tool-${session.sequence + 1}`
        if (!session.turnToolCalls.has(callId)) {
          session.turnToolCalls.add(callId)
          session.pendingToolCalls.push({ callId, name: event.name })
          this.recordToolCall(session, callId, event.name, event.input ?? null)
        }
        continue
      }
      if (event.kind === 'tool-result') {
        let callId = event.callId
        if (callId) {
          const pendingIndex = session.pendingToolCalls.findIndex((pending) => pending.callId === callId)
          if (pendingIndex >= 0) session.pendingToolCalls.splice(pendingIndex, 1)
        } else {
          const pendingIndex = event.name
            ? session.pendingToolCalls.findIndex((pending) => pending.name === event.name)
            : (session.pendingToolCalls.length ? 0 : -1)
          if (pendingIndex >= 0) callId = session.pendingToolCalls.splice(pendingIndex, 1)[0]?.callId
        }
        callId ??= `tool-${session.sequence + 1}`
        // Some machine-readable CLIs (notably current OpenCode) only emit a
        // terminal tool event. Preserve ND's call/result pairing even when the
        // upstream stream omits a separate "started" event.
        if (!session.turnToolCalls.has(callId)) {
          session.turnToolCalls.add(callId)
          this.recordToolCall(session, callId, event.name ?? 'tool', null)
        }
        this.recordToolResult(session, callId, summarize(event.output), event.isError === true)
        continue
      }
      if (event.kind === 'error') {
        session.doneSeen = true
        session.terminalOutcome = { status: 'failed', failureMessage: event.message }
        continue
      }
      session.doneSeen = true
      if (event.text?.trim()) session.turnAssistantText = event.text
      session.terminalOutcome = event.failed
        ? { status: 'failed', failureMessage: event.message ?? `${this.adapter.label} turn failed` }
        : { status: 'success' }
    }
  }

  private finishTurn(session: StructuredCliSession): void {
    const wasActive = session.running || session.turnSettled !== undefined
    if (!wasActive) return
    session.running = false
    delete session.turnSettled
    session.updatedAt = Date.now()
    this.emitFrame({ kind: 'session-status', sessionId: session.sessionId, running: false })
  }

  private recordUserMessage(session: StructuredCliSession, text: string): void {
    this.recordEnvelope(session, {
      type: 'user/message',
      data: { message: { role: 'user', content: [{ type: 'text', text }] } },
    })
  }

  private recordAssistantChunk(session: StructuredCliSession, text: string): void {
    session.turnAssistantText += text
    this.recordEnvelope(session, {
      type: 'assistant/chunk',
      data: { chunk: { content: [{ type: 'text', text }] } },
    })
  }

  private finalizeAssistantMessage(session: StructuredCliSession): void {
    const text = session.turnAssistantText
    if (!text.trim()) return
    this.recordEnvelope(session, {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
    })
  }

  private recordToolCall(session: StructuredCliSession, callId: string, name: string, input: unknown): void {
    this.recordEnvelope(session, { type: 'tool/call', data: { callId, name, arguments: input } })
  }

  private recordToolResult(session: StructuredCliSession, callId: string, output: string, isError: boolean): void {
    this.recordEnvelope(session, {
      type: 'tool/result',
      data: {
        callId,
        message: { content: [{ type: 'text', text: output }] },
        ...(isError ? { error: output || 'Tool failed' } : {}),
      },
    })
  }

  private recordEnvelope(session: StructuredCliSession, event: Omit<SessionEventEnvelope, 'seq' | 'time'>): void {
    const envelope: SessionEventEnvelope = {
      ...event,
      seq: ++session.sequence,
      time: Date.now(),
    }
    session.transcript.push(envelope)
    if (session.transcript.length > LOCAL_TRANSCRIPT_EVENTS) session.transcript.splice(0, session.transcript.length - LOCAL_TRANSCRIPT_EVENTS)
    this.emitFrame({ kind: 'session-event', sessionId: session.sessionId, event: envelope })
  }

  private emitFrame(frame: DshEventFrame): void {
    this.onEvent?.(frame)
  }
}
