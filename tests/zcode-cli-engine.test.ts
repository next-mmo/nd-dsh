import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { ZcodeCliEngine } from '../src/main/engines/zcode/zcode-cli-engine.js'
import type { DshEventFrame } from '../src/shared/contracts.js'

/**
 * Scripted stand-in for the `zcode app-server` child: answers the fixed
 * session/create, subscribe, send, stop, and resume requests and lets each
 * test drive server-initiated requests and session/event notifications over
 * the same stdio wires.
 */
class FakeZcodeServer {
  readonly child: ChildProcess
  readonly stdin: PassThrough
  readonly stdout: PassThrough
  requests: Array<{ id: string | number; method: string; params: Record<string, unknown> }> = []
  responses: Array<{ id: string | number; result?: unknown }> = []
  nativeCounter = 0
  lastNativeId?: string
  readonly nativeIds = new Set<string>()
  private buffer = ''

  constructor() {
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
        if (line) this.handle(JSON.parse(line) as { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown })
        newline = this.buffer.indexOf('\n')
      }
    })
  }

  private handle(message: { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown }): void {
    if (message.id === undefined) return
    if (message.method === undefined) {
      this.responses.push({ id: message.id, ...(message.result !== undefined ? { result: message.result } : {}) })
      return
    }
    this.requests.push({ id: message.id, method: message.method, params: message.params ?? {} })
    switch (message.method) {
      case 'session/create': {
        this.nativeCounter += 1
        this.lastNativeId = `sess_native_${this.nativeCounter}`
        this.nativeIds.add(this.lastNativeId)
        this.respond(message.id, { session: { sessionId: this.lastNativeId, title: 'New ZCode chat' } })
        break
      }
      case 'session/resume': {
        if (typeof message.params?.sessionId === 'string' && this.nativeIds.has(message.params.sessionId)) {
          this.lastNativeId = message.params.sessionId
          this.respond(message.id, { session: { sessionId: message.params.sessionId, title: 'Resumed chat' } })
        } else {
          this.respondError(message.id, { code: -32000, message: 'proto.sessionNotFound', data: { code: 'proto.sessionNotFound' } })
        }
        break
      }
      case 'session/subscribe':
      case 'session/send':
      case 'session/stop':
        this.respond(message.id, {})
        break
      default:
        break
    }
  }

  respond(id: string | number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`)
  }

  respondError(id: string | number, error: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, error })}\n`)
  }

  /** Server-initiated request (preferences, permissions, user input). */
  serverRequest(id: string | number, method: string, params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ id, method, params })}\n`)
  }

  /** Session-event notification; ND routes it by the envelope sessionId. */
  event(nativeSessionId: string | undefined, type: string, payload: Record<string, unknown> = {}, turnId?: string): void {
    this.stdout.write(`${JSON.stringify({
      method: 'session/event',
      params: { eventId: `evt-${Math.random()}`, sessionId: nativeSessionId, ...(turnId === undefined ? {} : { turnId }), seq: 1, timestamp: Date.now(), type, payload },
    })}\n`)
  }

  crash(code: number | null, signal: string | null): void {
    this.child.emit('exit', code, signal)
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))
const flush = async (): Promise<void> => { await tick(); await tick() }

const originalOverride = process.env.ND_DSH_ZCODE_BINARY
afterAll(() => {
  if (originalOverride === undefined) delete process.env.ND_DSH_ZCODE_BINARY
  else process.env.ND_DSH_ZCODE_BINARY = originalOverride
})

async function makeEngine() {
  process.env.ND_DSH_ZCODE_BINARY = process.execPath
  const server = new FakeZcodeServer()
  const spawnProcess = vi.fn((_file: string, _args: string[], options: { windowsHide?: boolean }) => {
    expect(options.windowsHide).toBe(true)
    return server.child
  })
  const engine = new ZcodeCliEngine({
    log: () => {},
    spawnProcess: spawnProcess as never,
  })
  const frames: DshEventFrame[] = []
  engine.setEmitter((frame) => frames.push(frame))
  return { engine, server, frames, spawnProcess }
}

const frameTypes = (frames: DshEventFrame[], sessionId: string): Array<string | undefined> =>
  frames
    .filter((frame) => frame.sessionId === sessionId)
    .map((frame) => frame.kind === 'session-event' ? frame.event?.type : frame.kind)

describe('ZcodeCliEngine', () => {
  it('creates a native session, streams a turn into shared frames, and settles cleanly', async () => {
    const { engine, server, frames } = await makeEngine()
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      expect(sessionId).toMatch(/^zcode-/)
      const run = engine.run('fix the bug', { sessionId })
      await flush()

      const create = server.requests.find((request) => request.method === 'session/create')
      expect(create?.params.workspace).toEqual({ workspacePath: '/workspace', workspaceKey: '/workspace' })
      expect(create?.params.mode).toBe('build')
      expect(server.requests.some((request) => request.method === 'session/subscribe')).toBe(true)
      expect(frames.some((frame) => frame.kind === 'session-added' && frame.sessionId === sessionId)).toBe(true)
      expect(frameTypes(frames, sessionId)).toContain('user/message')

      const send = server.requests.find((request) => request.method === 'session/send')
      expect(send?.params.sessionId).toBe(server.lastNativeId)
      expect(send?.params.content).toContain('fix the bug')

      const nativeId = server.lastNativeId
      server.event(nativeId, 'turn.started', { turnNumber: 1 }, 'turn-1')
      server.event(nativeId, 'part.started', { part: { type: 'tool', partId: 'p1', callId: 'c1', tool: 'bash', state: { status: 'running', input: { command: 'pnpm test' } } } }, 'turn-1')
      server.event(nativeId, 'part.upserted', { part: { type: 'tool', partId: 'p1', callId: 'c1', tool: 'bash', state: { status: 'completed', output: '3 passed', input: { command: 'pnpm test' } } } }, 'turn-1')
      server.event(nativeId, 'part.started', { part: { type: 'text', partId: 'p2', text: '' } }, 'turn-1')
      server.event(nativeId, 'part.delta', { partId: 'p2', field: 'text', delta: 'all ' }, 'turn-1')
      server.event(nativeId, 'part.delta', { partId: 'p2', field: 'text', delta: 'green' }, 'turn-1')
      server.event(nativeId, 'part.upserted', { part: { type: 'text', partId: 'p2', text: 'all green' } }, 'turn-1')
      server.event(nativeId, 'turn.completed', { response: 'all green', tokenCount: 10, toolCallCount: 1, duration: 100 }, 'turn-1')
      await expect(run).resolves.toEqual({ sessionId })

      const types = frameTypes(frames, sessionId)
      expect(types).toContain('tool/call')
      expect(types).toContain('tool/result')
      expect(types).toContain('assistant/chunk')
      expect(types).toContain('assistant/message')
      // The streamed text finalizes exactly once even though turn.completed
      // repeats the response.
      expect(types.filter((type) => type === 'assistant/message')).toHaveLength(1)
      expect(engine.listSessions()[0]?.running).toBe(false)
      expect(engine.listSessions()[0]?.title).toBe('fix the bug')
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('keeps each ZCode session immutably bound to the workspace it was created for', async () => {
    const { engine } = await makeEngine()
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace/task-a' })
      await expect(engine.run('do not move me', { sessionId, cwd: '/workspace/task-b' })).rejects.toThrow(/workspace is immutable/i)
      expect(engine.listSessions().find((item) => item.sessionId === sessionId)?.cwd).toBe('/workspace/task-a')
    } finally {
      await engine.close()
    }
  })

  it('runs two task sessions in distinct workspaces through one ZCode app-server child', async () => {
    const { engine, server, spawnProcess } = await makeEngine()
    try {
      const first = await engine.createSession({ cwd: '/workspace/task-a' })
      const second = await engine.createSession({ cwd: '/workspace/task-b' })
      const firstRun = engine.run('task a', { sessionId: first.sessionId })
      await flush()
      const secondRun = engine.run('task b', { sessionId: second.sessionId })
      await flush()

      const creates = server.requests.filter((request) => request.method === 'session/create')
      expect(spawnProcess).toHaveBeenCalledTimes(1)
      expect(creates).toHaveLength(2)
      expect(creates[0]?.params.workspace).toEqual({ workspacePath: '/workspace/task-a', workspaceKey: '/workspace/task-a' })
      expect(creates[1]?.params.workspace).toEqual({ workspacePath: '/workspace/task-b', workspaceKey: '/workspace/task-b' })

      server.event('sess_native_1', 'turn.completed', { response: 'task a done' })
      server.event('sess_native_2', 'turn.completed', { response: 'task b done' })
      await expect(Promise.all([firstRun, secondRun])).resolves.toEqual([
        { sessionId: first.sessionId },
        { sessionId: second.sessionId },
      ])
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('surfaces interactive approvals and forwards the human decision back to ZCode', async () => {
    const { engine, server, frames } = await makeEngine()
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const run = engine.run('deploy carefully', { sessionId })
      await flush()

      server.serverRequest('server-1', 'interaction/requestPermission', {
        requestId: 'perm-1',
        sessionId: server.lastNativeId,
        toolName: 'Bash',
        reason: 'git push --force',
        riskLevel: 'high',
        input: { command: 'git push --force' },
      })
      await flush()

      const approval = frames.find((frame) => frame.kind === 'approval-requested')
      expect(approval?.rpcId).toBeDefined()
      expect(approval?.sessionId).toBe(sessionId)
      expect(approval?.toolName).toBe('Bash')
      expect(approval?.reason).toContain('git push --force')
      expect(engine.handlesApproval(approval!.rpcId!)).toBe(true)
      expect(server.responses.find((response) => response.id === 'server-1')).toBeUndefined()

      await engine.respond(approval!.rpcId!, { outcome: 'allowed-once' })
      await flush()
      expect(server.responses.find((response) => response.id === 'server-1')?.result).toMatchObject({ decision: 'allow' })
      expect(frames.some((frame) => frame.kind === 'approval-resolved')).toBe(true)
      expect(engine.handlesApproval(approval!.rpcId!)).toBe(false)

      server.event(server.lastNativeId, 'turn.completed', { response: 'done' })
      await expect(run).resolves.toEqual({ sessionId })
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('auto-denies permission requests in unattended sessions', async () => {
    const { engine, server } = await makeEngine()
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace', mode: 'unattended' })
      const run = engine.run('do it alone', { sessionId })
      await flush()
      server.serverRequest('server-1', 'interaction/requestPermission', {
        requestId: 'perm-1',
        sessionId: server.lastNativeId,
        toolName: 'Bash',
        reason: 'run tests',
      })
      await flush()
      expect(server.responses.find((response) => response.id === 'server-1')?.result).toMatchObject({ decision: 'deny' })
      server.event(server.lastNativeId, 'turn.completed', { response: 'denied the risky path, continuing' })
      await expect(run).resolves.toEqual({ sessionId })
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('answers runtime preferences and fails closed on unknown server requests', async () => {
    const { engine, server } = await makeEngine()
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      // The app-server child is started lazily by the first turn.
      const run = engine.run('wake up', { sessionId })
      await flush()
      server.serverRequest('server-1', 'session/requestRuntimePreferences', { sessionId: server.lastNativeId, scope: 'runtime-materialization' })
      await flush()
      expect(server.responses.find((response) => response.id === 'server-1')?.result).toEqual({ nativeSearchEnhancementsEnabled: false })

      server.serverRequest('server-2', 'totally/unknownRequest', {})
      await flush()
      expect(server.responses.find((response) => response.id === 'server-2')?.result).toBeUndefined()

      server.event(server.lastNativeId, 'turn.completed', { response: 'awake' })
      await expect(run).resolves.toEqual({ sessionId })
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('reports an unexpected app-server crash as an agent-error and rejects the run', async () => {
    const { engine, server, frames } = await makeEngine()
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const run = engine.run('keep going', { sessionId })
      await flush()
      server.crash(1, null)
      await expect(run).rejects.toThrow(/exited/i)
      expect(frames.some((frame) => frame.kind === 'agent-error' && frame.sessionId === sessionId)).toBe(true)
      expect(engine.listSessions()[0]?.running).toBe(false)
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('resumes the persisted native session after the app-server restarts', async () => {
    const { engine, server } = await makeEngine()
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const firstRun = engine.run('first task', { sessionId })
      await flush()
      server.event(server.lastNativeId, 'turn.completed', { response: 'first done' })
      await firstRun
      const createsBefore = server.requests.filter((request) => request.method === 'session/create').length

      server.crash(1, null)
      await flush()

      const secondRun = engine.run('second task', { sessionId })
      await flush()
      // The new child must receive session/resume, not a fresh session/create.
      const createsAfter = server.requests.filter((request) => request.method === 'session/create').length
      expect(createsAfter).toBe(createsBefore)
      const resume = server.requests.filter((request) => request.method === 'session/resume').at(-1)
      expect(resume?.params.sessionId).toBe('sess_native_1')
      expect(resume?.params.workspace).toEqual({ workspacePath: '/workspace', workspaceKey: '/workspace' })
      const sends = server.requests.filter((request) => request.method === 'session/send')
      expect(sends.at(-1)?.params.sessionId).toBe('sess_native_1')
      expect(sends.at(-1)?.params.content).toContain('second task')
      server.event(server.lastNativeId, 'turn.completed', { response: 'second done' })
      await expect(secondRun).resolves.toEqual({ sessionId })
      expect(engine.transcript(sessionId).events.some((event) => event.type === 'user/message' && JSON.stringify(event.data).includes('second task'))).toBe(true)
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('fails a turn whose terminal event is failed and reports the failure message', async () => {
    const { engine, server, frames } = await makeEngine()
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const run = engine.run('attempt the impossible', { sessionId })
      await flush()
      server.event(server.lastNativeId, 'turn.failed', { error: { type: 'provider', message: 'unauthorized' }, turnPhase: 'model' })
      await expect(run).rejects.toThrow(/unauthorized/)
      expect(frames.some((frame) => frame.kind === 'agent-error')).toBe(true)
    } finally {
      await engine.close()
    }
  }, 15_000)
})
