import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { DshEventFrame, EngineSessionSummary, EngineSessionTranscript, SessionEventEnvelope } from '../../../shared/contracts.js'
import { MINIMAX_CLI_ENGINE_ID } from '../../../shared/extra-coding-engines.js'
import { stripWorkspaceContext } from '../../../shared/workspace-context.js'
import { deferred, engineEnvironment, killProcessTree, spawnCliCommand, type Deferred } from './agent-cli-support.js'
import { minimaxBinPath } from './extra-cli-paths.js'

const LOCAL_TRANSCRIPT_EVENTS = 32

interface MiniMaxSession {
  sessionId: string
  model?: string
  title: string
  createdAt: number
  updatedAt: number
  running: boolean
  sequence: number
  transcript: SessionEventEnvelope[]
  child?: ChildProcess
  stdout: string
  turnSettled?: Deferred<{ ok: boolean; message?: string }>
}

export class MiniMaxCliEngine {
  private readonly sessions = new Map<string, MiniMaxSession>()
  private onEvent: ((frame: DshEventFrame) => void) | undefined

  constructor(
    private readonly log: (line: string) => void = (line) => console.warn(line),
    private readonly spawnProcess: typeof spawn = spawn,
  ) {}

  setEmitter(emit: (frame: DshEventFrame) => void): void { this.onEvent = emit }
  ready(): boolean { return minimaxBinPath() !== undefined }
  ownsSession(sessionId: string): boolean { return this.sessions.has(sessionId) }
  handlesApproval(_rpcId: string): boolean { return false }
  async respond(rpcId: string, _value: unknown): Promise<void> { throw new Error(`Unknown ${MINIMAX_CLI_ENGINE_ID} approval: ${rpcId}`) }
  async listModels(): Promise<never[]> { return [] }

  listSessions(): EngineSessionSummary[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((session) => ({
      sessionId: session.sessionId,
      engineId: MINIMAX_CLI_ENGINE_ID,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      running: session.running,
    }))
  }

  transcript(sessionId: string): EngineSessionTranscript {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown ${MINIMAX_CLI_ENGINE_ID} session: ${sessionId}`)
    return { sessionId, engineId: MINIMAX_CLI_ENGINE_ID, events: [...session.transcript] }
  }

  async createSession(input: { cwd?: string; model?: string } = {}): Promise<{ sessionId: string }> {
    const sessionId = `minimax-${randomUUID()}`
    const now = Date.now()
    this.sessions.set(sessionId, {
      sessionId,
      ...(input.model === undefined ? {} : { model: input.model }),
      title: 'New MiniMax chat',
      createdAt: now,
      updatedAt: now,
      running: false,
      sequence: 0,
      transcript: [],
      stdout: '',
    })
    this.onEvent?.({ kind: 'session-added', sessionId, meta: { engineId: MINIMAX_CLI_ENGINE_ID } })
    return { sessionId }
  }

  async run(prompt: string, options: { sessionId?: string; cwd?: string; model?: string } = {}): Promise<{ sessionId: string }> {
    const cleaned = prompt.trim()
    if (!cleaned) throw new Error('Prompt cannot be empty')
    let session = options.sessionId === undefined ? undefined : this.sessions.get(options.sessionId)
    if (options.sessionId !== undefined && !session) throw new Error(`Unknown ${MINIMAX_CLI_ENGINE_ID} session: ${options.sessionId}`)
    if (!session) {
      const created = await this.createSession({
        ...(options.model === undefined ? {} : { model: options.model }),
      })
      session = this.sessions.get(created.sessionId)
    }
    if (!session) throw new Error('MiniMax session could not be created')
    if (session.running) throw new Error('This MiniMax chat already has an active turn')
    if (options.model !== undefined) session.model = options.model

    const userText = stripWorkspaceContext(cleaned)
    this.record(session, 'user/message', { message: { role: 'user', content: [{ type: 'text', text: userText }] } })
    if (session.title === 'New MiniMax chat') session.title = userText.slice(0, 80)
    const settled = deferred<{ ok: boolean; message?: string }>()
    session.turnSettled = settled
    session.stdout = ''
    try {
      this.spawnTurn(session, userText)
      session.running = true
      session.updatedAt = Date.now()
      this.onEvent?.({ kind: 'session-status', sessionId: session.sessionId, running: true })
      const result = await settled.promise
      this.finish(session)
      if (!result.ok) {
        const message = result.message ?? 'MiniMax CLI turn failed'
        this.onEvent?.({ kind: 'agent-error', sessionId: session.sessionId, message })
        throw new Error(message)
      }
      return { sessionId: session.sessionId }
    } catch (error: unknown) {
      if (session.turnSettled === settled) {
        this.finish(session)
        const message = error instanceof Error ? error.message : String(error)
        this.onEvent?.({ kind: 'agent-error', sessionId: session.sessionId, message })
      }
      throw error
    }
  }

  async stop(sessionId?: string): Promise<void> {
    const targets = sessionId === undefined ? [...this.sessions.values()].filter((item) => item.running) : [this.sessions.get(sessionId)]
    for (const session of targets) {
      if (!session?.child) continue
      const child = session.child
      delete session.child
      session.turnSettled?.resolve({ ok: false, message: 'MiniMax CLI turn was stopped.' })
      this.finish(session)
      await killProcessTree(child)
    }
  }

  async close(): Promise<void> { await this.stop() }

  private spawnTurn(session: MiniMaxSession, prompt: string): void {
    const bin = minimaxBinPath()
    if (!bin) throw new Error('The MiniMax CLI (mmx) is not installed. Install mmx-cli or set ND_DSH_MINIMAX_BINARY.')
    const args = ['text', 'chat', '--non-interactive', '--quiet']
    if (session.model) args.push('--model', session.model)
    args.push('--message', `user:${prompt}`)
    const child = spawnCliCommand(this.spawnProcess, bin, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: engineEnvironment(),
      cwd: process.cwd(),
      detached: process.platform !== 'win32',
    })
    session.child = child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { session.stdout += chunk })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => this.log(`[minimax-cli] ${chunk.trimEnd()}`))
    child.once('error', (error) => {
      if (session.child !== child) return
      delete session.child
      session.turnSettled?.resolve({ ok: false, message: error.message })
    })
    child.once('close', (code, signal) => {
      if (session.child !== child) return
      delete session.child
      const text = session.stdout.trim()
      if (code === 0 && text) {
        this.record(session, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } })
        session.turnSettled?.resolve({ ok: true })
        return
      }
      session.turnSettled?.resolve({ ok: false, message: `MiniMax CLI exited (${signal ?? String(code ?? 'unknown')})${text ? `: ${text.slice(0, 500)}` : ''}` })
    })
  }

  private finish(session: MiniMaxSession): void {
    if (!session.running && session.turnSettled === undefined) return
    session.running = false
    delete session.turnSettled
    session.updatedAt = Date.now()
    this.onEvent?.({ kind: 'session-status', sessionId: session.sessionId, running: false })
  }

  private record(session: MiniMaxSession, type: string, data: unknown): void {
    const event: SessionEventEnvelope = { type, seq: ++session.sequence, time: Date.now(), data }
    session.transcript.push(event)
    if (session.transcript.length > LOCAL_TRANSCRIPT_EVENTS) session.transcript.splice(0, session.transcript.length - LOCAL_TRANSCRIPT_EVENTS)
    this.onEvent?.({ kind: 'session-event', sessionId: session.sessionId, event })
  }
}
