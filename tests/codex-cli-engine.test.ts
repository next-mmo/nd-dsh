import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { CodexCliEngine } from '../src/main/engines/codex/codex-cli-engine.js'
import type { DshEventFrame } from '../src/shared/contracts.js'

/**
 * Scripted stand-in for the official `codex app-server --stdio` child: answers
 * the fixed handshake/account/thread/turn requests and lets each test drive
 * notifications, approvals, and crashes over the same stdio wires.
 */
class FakeAppServer {
  readonly child: ChildProcess
  readonly stdin: PassThrough
  readonly stdout: PassThrough
  requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  responses: Array<{ id: number; result?: unknown; error?: unknown }> = []
  threadCounter = 0
  turnCounter = 0
  killCalls = 0
  lastThreadId?: string
  lastTurnId?: string
  private buffer = ''

  constructor(private readonly accountResult: Record<string, unknown> = {
    account: { type: 'chatgpt', email: 'test@example.com', planType: 'plus' },
    requiresOpenaiAuth: true,
  }) {
    this.stdin = new PassThrough()
    this.stdout = new PassThrough()
    const stderr = new PassThrough()
    const base = new EventEmitter() as unknown as Record<string, unknown>
    base.stdout = this.stdout
    base.stdin = this.stdin
    base.stderr = stderr
    base.pid = 42_424
    base.exitCode = null
    base.signalCode = null
    base.kill = () => {
      this.killCalls += 1
      queueMicrotask(() => this.child.emit('exit', null, 'SIGTERM'))
      return true
    }
    this.child = base as unknown as ChildProcess
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      this.buffer += chunk
      let newline = this.buffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line) this.handle(JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown })
        newline = this.buffer.indexOf('\n')
      }
    })
  }

  private handle(message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }): void {
    if (message.id === undefined) return
    if (message.method === undefined) {
      // A response from ND to a server-initiated request.
      this.responses.push({ id: message.id, ...(message.result !== undefined ? { result: message.result } : {}) })
      return
    }
    this.requests.push({ id: message.id, method: message.method, params: message.params ?? {} })
    switch (message.method) {
      case 'initialize':
        this.respond(message.id, {})
        break
      case 'account/read':
        this.respond(message.id, this.accountResult)
        break
      case 'model/list':
        this.respond(message.id, { data: [{ id: 'catalog-id', model: 'codex-test-model', displayName: 'Codex Test Model' }], nextCursor: null })
        break
      case 'thread/start': {
        this.threadCounter += 1
        this.lastThreadId = `thr-${this.threadCounter}`
        this.respond(message.id, { thread: { id: this.lastThreadId } })
        break
      }
      case 'turn/start': {
        this.turnCounter += 1
        this.lastTurnId = `turn-${this.turnCounter}`
        this.lastThreadId = String(message.params?.threadId ?? this.lastThreadId)
        this.respond(message.id, { turn: { id: this.lastTurnId } })
        break
      }
      case 'turn/interrupt':
        this.respond(message.id, {})
        break
      default:
        break
    }
  }

  respond(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`)
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`)
  }

  /** Emit a server-initiated request (e.g. an approval elicitation). */
  serverRequest(id: number, method: string, params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ id, method, params })}\n`)
  }

  itemStarted(item: Record<string, unknown>): void {
    this.notify('item/started', { threadId: this.lastThreadId, turnId: this.lastTurnId, item })
  }

  itemCompleted(item: Record<string, unknown>): void {
    this.notify('item/completed', { threadId: this.lastThreadId, turnId: this.lastTurnId, item })
  }

  completeTurn(status: string, failure?: Record<string, unknown>): void {
    this.notify('turn/completed', {
      threadId: this.lastThreadId,
      turn: { id: this.lastTurnId, status, ...(failure ? { error: failure } : {}) },
    })
  }

  crash(code: number | null, signal: string | null): void {
    this.child.emit('exit', code, signal)
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))
const flush = async (): Promise<void> => { await tick(); await tick() }

// The engine refuses to start without a resolvable binary; point the dev
// override at any existing file since the fake child never executes it.
const originalOverride = process.env.ND_DSH_CODEX_BINARY
afterAll(() => {
  if (originalOverride === undefined) delete process.env.ND_DSH_CODEX_BINARY
  else process.env.ND_DSH_CODEX_BINARY = originalOverride
})

async function makeEngine(accountResult?: Record<string, unknown>) {
  process.env.ND_DSH_CODEX_BINARY = process.execPath
  const server = new FakeAppServer(accountResult)
  const engine = new CodexCliEngine({
    log: () => {},
    spawnProcess: ((_file: string, _args: string[], options: { windowsHide?: boolean }) => {
      expect(options.windowsHide).toBe(true)
      return server.child
    }) as never,
  })
  const frames: DshEventFrame[] = []
  engine.setEmitter((frame) => frames.push(frame))
  return { engine, server, frames }
}

describe('CodexCliEngine', () => {
  it('lists native models and applies a selected model to a turn', async () => {
    const { engine, server } = await makeEngine()
    try {
      await expect(engine.listModels()).resolves.toEqual([{ id: 'codex-test-model', name: 'Codex Test Model' }])
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const run = engine.run('hello', { sessionId, model: 'codex-test-model' })
      await flush()
      expect(server.requests.find((request) => request.method === 'turn/start')?.params.model).toBe('codex-test-model')
      server.completeTurn('completed')
      await run
    } finally {
      await engine.close()
    }
  })

  it('cleans up the spawned app-server when the account startup handshake fails', async () => {
    const { engine, server } = await makeEngine({ account: null, requiresOpenaiAuth: 'invalid' })
    try {
      await expect(engine.listModels()).rejects.toThrow(/invalid account\/read response/i)
      await flush()
      expect(server.killCalls).toBeGreaterThan(0)
    } finally {
      await engine.close()
    }
  })

  it('creates a session, streams a turn into shared frames, and settles cleanly', async () => {
    const { engine, server, frames } = await makeEngine()
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      expect(sessionId).toMatch(/^codex-/)
      await flush()

      const accountRead = server.requests.find((request) => request.method === 'account/read')
      expect(accountRead?.params).toEqual({})
      const threadStart = server.requests.find((request) => request.method === 'thread/start')
      expect(threadStart?.params.cwd).toBe('/workspace')
      expect(threadStart?.params.approvalPolicy).toBe('on-request')
      expect(frames.some((frame) => frame.kind === 'session-added' && frame.sessionId === sessionId)).toBe(true)

      const runPromise = engine.run('fix the bug', { sessionId })
      await flush()
      server.itemStarted({ type: 'commandExecution', id: 'c1', command: 'pnpm test', status: 'pending' })
      server.itemCompleted({ type: 'commandExecution', id: 'c1', command: 'pnpm test', status: 'completed', exitCode: 0 })
      server.itemCompleted({ type: 'agentMessage', phase: 'commentary', text: 'looking around' })
      server.itemCompleted({ type: 'agentMessage', phase: 'final_answer', text: 'all green' })
      server.completeTurn('completed')
      await expect(runPromise).resolves.toEqual({ sessionId })

      const types = frames.filter((frame) => frame.sessionId === sessionId).map((frame) => frame.kind === 'session-event' ? frame.event?.type : frame.kind)
      expect(types).toContain('user/message')
      expect(types).toContain('assistant/message')
      expect(types).toContain('tool/call')
      expect(types).toContain('tool/result')

      // Transcript restore matches what streamed; commentary stays out.
      const transcript = engine.transcript(sessionId)
      expect(transcript.events.map((event) => event.type)).toEqual(['user/message', 'tool/call', 'tool/result', 'assistant/message'])
      const summaries = engine.listSessions()
      expect(summaries[0]?.running).toBe(false)
      expect(summaries[0]?.title).toBe('fix the bug')
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('surfaces interactive approvals and forwards the human decision back to Codex', async () => {
    const { engine, server, frames } = await makeEngine()
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      await flush()
      const runPromise = engine.run('deploy carefully', { sessionId })
      await flush()

      server.serverRequest(9001, 'item/commandExecution/requestApproval', {
        threadId: server.lastThreadId,
        turnId: server.lastTurnId,
        command: 'git push --force',
        availableDecisions: ['accepted', 'declined'],
      })
      await flush()

      const approval = frames.find((frame) => frame.kind === 'approval-requested')
      expect(approval?.rpcId).toBeDefined()
      expect(approval?.sessionId).toBe(sessionId)
      expect(approval?.toolName).toBe('Command execution')
      expect(approval?.reason).toContain('git push --force')
      expect(engine.handlesApproval(approval!.rpcId!)).toBe(true)
      // The turn stays blocked until the human answers.
      expect(server.responses.find((response) => response.id === 9001)).toBeUndefined()

      await engine.respond(approval!.rpcId!, { outcome: 'allowed-once' })
      await flush()
      expect(server.responses.find((response) => response.id === 9001)?.result).toEqual({ decision: 'accepted' })
      expect(frames.some((frame) => frame.kind === 'approval-resolved')).toBe(true)
      expect(engine.handlesApproval(approval!.rpcId!)).toBe(false)

      server.completeTurn('completed')
      await expect(runPromise).resolves.toEqual({ sessionId })
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('reports an unexpected app-server crash as an agent-error and rejects the run', async () => {
    const { engine, server, frames } = await makeEngine()
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      await flush()
      const runPromise = engine.run('keep going', { sessionId })
      await flush()
      server.crash(1, null)
      await expect(runPromise).rejects.toThrow(/exited/i)
      expect(frames.some((frame) => frame.kind === 'agent-error' && frame.sessionId === sessionId)).toBe(true)
      expect(engine.listSessions()[0]?.running).toBe(false)
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('recreates a lost thread transparently after the app-server restarts', async () => {
    const { engine, server } = await makeEngine()
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      await flush()
      const firstRun = engine.run('first task', { sessionId })
      await flush()
      server.completeTurn('completed')
      await firstRun
      const threadsBeforeRestart = server.requests.filter((request) => request.method === 'thread/start').length

      // The app-server child dies; ND keeps the session record.
      server.crash(1, null)
      await flush()

      const secondRun = engine.run('second task', { sessionId })
      await flush()
      // A fresh thread/start must have been issued for the new child generation.
      const threadsAfterRestart = server.requests.filter((request) => request.method === 'thread/start').length
      expect(threadsAfterRestart).toBeGreaterThan(threadsBeforeRestart)
      server.itemCompleted({ type: 'agentMessage', phase: 'final_answer', text: 'recovered' })
      server.completeTurn('completed')
      await expect(secondRun).resolves.toEqual({ sessionId })

      const turnStarts = server.requests.filter((request) => request.method === 'turn/start')
      expect(turnStarts.at(-1)?.params.threadId).toBe(server.lastThreadId)
      // The transcript survives across the restart within ND.
      expect(engine.transcript(sessionId).events.some((event) => event.type === 'user/message' && JSON.stringify(event.data).includes('second task'))).toBe(true)
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('fails a turn whose terminal status is failed and reports the failure message', async () => {
    const { engine, server, frames } = await makeEngine()
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      await flush()
      const runPromise = engine.run('attempt the impossible', { sessionId })
      await flush()
      server.completeTurn('failed', { message: 'unauthorized' })
      await expect(runPromise).rejects.toThrow(/unauthorized/)
      expect(frames.some((frame) => frame.kind === 'agent-error')).toBe(true)
    } finally {
      await engine.close()
    }
  }, 15_000)
})
