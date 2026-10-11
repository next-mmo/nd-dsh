import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { ClaudeCodeCliEngine } from '../src/main/engines/claude/claude-code-cli-engine.js'
import { CursorCliEngine } from '../src/main/engines/cursor/cursor-cli-engine.js'
import { PiCodingEngine } from '../src/main/engines/pi/pi-coding-engine.js'
import type { DshEventFrame } from '../src/shared/contracts.js'

/**
 * Scripted stand-in for the headless CLI children (Claude Code stream-json,
 * Cursor stream-json, Pi RPC): records spawned argv, lets each test drive
 * stdout events, and fails runs on child exit like the real CLIs do.
 */
class FakeCli {
  readonly child: ChildProcess
  readonly stdin: PassThrough
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  readonly writes: string[] = []
  argv: string[] = []
  exited = false
  private buffer = ''

  constructor() {
    this.stdin = new PassThrough()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => this.writes.push(chunk))
    const base = new EventEmitter() as unknown as Record<string, unknown>
    base.stdout = this.stdout
    base.stdin = this.stdin
    base.stderr = this.stderr
    base.pid = 43_242
    base.exitCode = null
    base.signalCode = null
    base.kill = () => {
      // A kill always terminates, even after an earlier direct exit().
      queueMicrotask(() => this.child.emit('exit', null, 'SIGTERM'))
      return true
    }
    this.child = base as unknown as ChildProcess
  }

  /** Capture the argv of the next spawn and hand back this fake child. */
  spawn(): (file: string, args: string[], options: { windowsHide?: boolean }) => ChildProcess {
    return (file: string, args: string[], options: { windowsHide?: boolean }) => {
      expect(options.windowsHide).toBe(true)
      this.argv = [file, ...args]
      return this.child
    }
  }

  /** Write one NDJSON event to the child's stdout. */
  line(payload: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`)
  }

  /** Feed raw (possibly non-JSON) stdout bytes. */
  raw(chunk: string): void {
    this.stdout.write(chunk)
  }

  exit(code: number | null, signal: string | null): void {
    if (this.exited) return
    this.exited = true
    this.child.emit('exit', code, signal)
  }

  /** JSONL commands written to the child's stdin (Pi RPC mode). */
  commands(): Array<Record<string, unknown>> {
    const commands: Array<Record<string, unknown>> = []
    for (const write of this.writes) {
      for (const line of write.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          commands.push(JSON.parse(trimmed) as Record<string, unknown>)
        } catch {
          // Non-JSON stdin writes are not commands.
        }
      }
    }
    return commands
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))
const flush = async (): Promise<void> => { await tick(); await tick() }

const overrides = [
  'ND_DSH_CLAUDE_BINARY',
  'ND_DSH_CURSOR_BINARY',
  'ND_DSH_PI_BINARY',
] as const
const originalOverrides: Record<string, string | undefined> = {}
for (const key of overrides) originalOverrides[key] = process.env[key]
afterAll(() => {
  for (const key of overrides) {
    if (originalOverrides[key] === undefined) delete process.env[key]
    else process.env[key] = originalOverrides[key]
  }
})

function collect(engine: { setEmitter: (emit: (frame: DshEventFrame) => void) => void }): DshEventFrame[] {
  const frames: DshEventFrame[] = []
  engine.setEmitter((frame) => frames.push(frame))
  return frames
}

const frameTypes = (frames: DshEventFrame[], sessionId: string): Array<string | undefined> =>
  frames
    .filter((frame) => frame.sessionId === sessionId)
    .map((frame) => frame.kind === 'session-event' ? frame.event?.type : frame.kind)

describe('ClaudeCodeCliEngine', () => {
  it('spawns the headless stream-json surface and streams a turn into shared frames', async () => {
    process.env.ND_DSH_CLAUDE_BINARY = process.execPath
    const cli = new FakeCli()
    const engine = new ClaudeCodeCliEngine({ log: () => {}, spawnProcess: cli.spawn() as never })
    const frames = collect(engine)
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      expect(sessionId).toMatch(/^claude-/)
      const run = engine.run('fix the bug', { sessionId })
      await flush()

      expect(cli.argv.slice(1)).toContain('-p')
      expect(cli.argv).toContain('--input-format')
      expect(cli.argv).toContain('stream-json')
      expect(cli.argv).toContain('--output-format')
      expect(cli.argv).toContain('--permission-mode')
      expect(cli.argv).toContain('acceptEdits')
      expect(frameTypes(frames, sessionId)).toContain('user/message')

      cli.line({ type: 'system', subtype: 'init', session_id: 'native-1', model: 'claude-test' })
      cli.line({
        type: 'assistant',
        session_id: 'native-1',
        message: { role: 'assistant', content: [
          { type: 'thinking', thinking: 'looking around' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test' } },
          { type: 'text', text: 'all green' },
        ] },
      })
      cli.line({
        type: 'user',
        session_id: 'native-1',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '3 passed' }] }] },
      })
      cli.line({ type: 'result', subtype: 'success', session_id: 'native-1', result: 'all green' })
      await expect(run).resolves.toEqual({ sessionId })

      const types = frameTypes(frames, sessionId)
      expect(types).toContain('agent/reasoning')
      expect(types).toContain('tool/call')
      expect(types).toContain('tool/result')
      expect(types).toContain('assistant/message')
      // The native session id is learned from the event stream for resume.
      expect(engine.listSessions()[0]?.running).toBe(false)
      expect(engine.listSessions()[0]?.title).toBe('fix the bug')
      const transcript = engine.transcript(sessionId)
      expect(transcript.events.map((event) => event.type)).toEqual(['user/message', 'agent/reasoning', 'tool/call', 'assistant/message', 'tool/result'])
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('resumes the native conversation on a respawned child', async () => {
    process.env.ND_DSH_CLAUDE_BINARY = process.execPath
    const cli = new FakeCli()
    const engine = new ClaudeCodeCliEngine({ log: () => {}, spawnProcess: cli.spawn() as never })
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const firstRun = engine.run('first task', { sessionId })
      await flush()
      cli.line({ type: 'system', subtype: 'init', session_id: 'native-1' })
      cli.line({ type: 'assistant', session_id: 'native-1', message: { role: 'assistant', content: [{ type: 'text', text: 'first done' }] } })
      cli.line({ type: 'result', subtype: 'success', session_id: 'native-1', result: 'first done' })
      await firstRun

      cli.exit(0, null)
      await flush()

      const secondRun = engine.run('second task', { sessionId })
      await flush()
      expect(cli.argv).toContain('--resume')
      expect(cli.argv[cli.argv.indexOf('--resume') + 1]).toBe('native-1')
      cli.line({ type: 'assistant', session_id: 'native-1', message: { role: 'assistant', content: [{ type: 'text', text: 'done again' }] } })
      cli.line({ type: 'result', subtype: 'success', session_id: 'native-1', result: 'done again' })
      await expect(secondRun).resolves.toEqual({ sessionId })
      expect(engine.transcript(sessionId).events.some((event) => event.type === 'user/message' && JSON.stringify(event.data).includes('second task'))).toBe(true)
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('fails the turn when the result event reports an error', async () => {
    process.env.ND_DSH_CLAUDE_BINARY = process.execPath
    const cli = new FakeCli()
    const engine = new ClaudeCodeCliEngine({ log: () => {}, spawnProcess: cli.spawn() as never })
    const frames = collect(engine)
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const run = engine.run('attempt the impossible', { sessionId })
      await flush()
      cli.line({ type: 'result', subtype: 'error_during_execution', session_id: 'native-1', is_error: true, result: 'credit balance too low' })
      await expect(run).rejects.toThrow(/credit balance too low/)
      expect(frames.some((frame) => frame.kind === 'agent-error' && frame.sessionId === sessionId)).toBe(true)
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('fails the turn when the CLI reports an auth failure as a success result', async () => {
    // Claude Code emits subtype "success" with is_error for auth failures;
    // the reply text is the CLI's error message, not a model reply.
    process.env.ND_DSH_CLAUDE_BINARY = process.execPath
    const cli = new FakeCli()
    const engine = new ClaudeCodeCliEngine({ log: () => {}, spawnProcess: cli.spawn() as never })
    const frames = collect(engine)
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const run = engine.run('reply anyway', { sessionId })
      await flush()
      cli.line({ type: 'assistant', session_id: 'native-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401' }] } })
      cli.line({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, session_id: 'native-1', result: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.' })
      await expect(run).rejects.toThrow(/OAuth access token has been revoked/)
      expect(frames.some((frame) => frame.kind === 'agent-error' && frame.sessionId === sessionId)).toBe(true)
      expect(engine.listSessions()[0]?.running).toBe(false)
    } finally {
      await engine.close()
    }
  }, 15_000)
})

describe('CursorCliEngine', () => {
  it('spawns one headless turn with --force and streams the shared vocabulary', async () => {
    process.env.ND_DSH_CURSOR_BINARY = process.execPath
    const cli = new FakeCli()
    const engine = new CursorCliEngine({ log: () => {}, spawnProcess: cli.spawn() as never })
    const frames = collect(engine)
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      expect(sessionId).toMatch(/^cursor-/)
      const run = engine.run('write the feature', { sessionId })
      await flush()

      expect(cli.argv).toContain('-p')
      expect(cli.argv).toContain('--output-format')
      expect(cli.argv).toContain('stream-json')
      expect(cli.argv).toContain('--force')
      expect(cli.argv.at(-1)).toContain('write the feature')
      expect(frameTypes(frames, sessionId)).toContain('user/message')

      cli.line({ type: 'system', subtype: 'init', session_id: 'cursor-native-1', model: 'composer' })
      cli.line({
        type: 'assistant',
        session_id: 'cursor-native-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'writing it now' }] },
      })
      cli.line({
        type: 'tool_call',
        subtype: 'started',
        session_id: 'cursor-native-1',
        tool_call: { tool_call_id: 'tc1', type: 'writeToolCall', args: { path: 'src/a.ts' } },
      })
      cli.line({
        type: 'tool_call',
        subtype: 'completed',
        session_id: 'cursor-native-1',
        tool_call: { tool_call_id: 'tc1', type: 'writeToolCall', result: { success: { linesCreated: 12 } } },
      })
      cli.line({ type: 'result', subtype: 'success', session_id: 'cursor-native-1', duration_ms: 4211 })
      await expect(run).resolves.toEqual({ sessionId })

      const types = frameTypes(frames, sessionId)
      expect(types).toEqual(expect.arrayContaining(['user/message', 'assistant/message', 'tool/call', 'tool/result']))
      expect(engine.transcript(sessionId).events.map((event) => event.type)).toEqual(['user/message', 'assistant/message', 'tool/call', 'tool/result'])
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('passes --resume=<native id> on follow-up turns and fails on child exit', async () => {
    process.env.ND_DSH_CURSOR_BINARY = process.execPath
    const cli = new FakeCli()
    const engine = new CursorCliEngine({ log: () => {}, spawnProcess: cli.spawn() as never })
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const firstRun = engine.run('first', { sessionId })
      await flush()
      cli.line({ type: 'assistant', session_id: 'cursor-native-1', message: { role: 'assistant', content: [{ type: 'text', text: 'first done' }] } })
      cli.line({ type: 'result', subtype: 'success', session_id: 'cursor-native-1' })
      await firstRun

      const secondRun = engine.run('second', { sessionId })
      await flush()
      expect(cli.argv.some((arg) => arg === '--resume=cursor-native-1')).toBe(true)

      cli.exit(1, null)
      await expect(secondRun).rejects.toThrow(/exited/i)
    } finally {
      await engine.close()
    }
  }, 15_000)
})

describe('PiCodingEngine', () => {
  it('drives the RPC wires: get_state, prompt, streamed text, tools, and agent_settled', async () => {
    process.env.ND_DSH_PI_BINARY = process.execPath
    const cli = new FakeCli()
    const engine = new PiCodingEngine({ log: () => {}, spawnProcess: cli.spawn() as never })
    const frames = collect(engine)
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      expect(sessionId).toMatch(/^pi-/)
      const run = engine.run('list the modules', { sessionId })
      await flush()

      // Attach happens before the prompt: get_state first, prompt only after
      // its response lands.
      expect(cli.commands().map((command) => command.type)).toEqual(['get_state'])
      const getStateCommand = cli.commands().find((command) => command.type === 'get_state')
      cli.line({ type: 'response', command: 'get_state', success: true, id: getStateCommand?.id, data: { sessionFile: '/sessions/s1.jsonl', sessionId: 's1' } })
      await flush()

      const commands = cli.commands()
      expect(commands.map((command) => command.type)).toEqual(['get_state', 'prompt'])
      expect(commands[1]?.message).toContain('list the modules')
      expect(frameTypes(frames, sessionId)).toContain('user/message')

      const promptId = commands[1]?.id
      cli.line({ type: 'response', command: 'prompt', success: true, id: promptId })
      await flush()

      cli.line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello ' } })
      cli.line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'world' } })
      cli.line({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: { command: 'ls' },
      })
      cli.line({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'src\n' }] },
        isError: false,
      })
      cli.line({
        type: 'message_end',
        message: { role: 'assistant', content: [
          { type: 'thinking', thinking: 'reading the tree' },
          { type: 'text', text: 'Hello world' },
        ] },
      })
      cli.line({ type: 'agent_settled' })
      await expect(run).resolves.toEqual({ sessionId })

      const types = frameTypes(frames, sessionId)
      expect(types).toContain('assistant/chunk')
      expect(types).toContain('tool/call')
      expect(types).toContain('tool/result')
      expect(types).toContain('agent/reasoning')
      // The streamed text is finalized once, not duplicated by message_end.
      expect(types.filter((type) => type === 'assistant/message')).toHaveLength(1)
      expect(engine.listSessions()[0]?.title).toBe('list the modules')
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('reloads the persisted session file on a fresh child and cancels extension dialogs', async () => {
    process.env.ND_DSH_PI_BINARY = process.execPath
    const cli = new FakeCli()
    const engine = new PiCodingEngine({ log: () => {}, spawnProcess: cli.spawn() as never })
    const frames = collect(engine)
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const firstRun = engine.run('first', { sessionId })
      await flush()
      const getStateCommand = cli.commands().find((command) => command.type === 'get_state')
      cli.line({ type: 'response', command: 'get_state', success: true, id: getStateCommand?.id, data: { sessionFile: '/sessions/s1.jsonl' } })
      await flush()
      const firstCommands = cli.commands()
      const firstPrompt = firstCommands.find((command) => command.type === 'prompt')
      cli.line({ type: 'response', command: 'prompt', success: true, id: firstPrompt?.id })
      cli.line({ type: 'agent_settled' })
      await firstRun

      // The first child dies; the next run must switch back into s1.jsonl
      // before any prompt is written.
      cli.exit(1, null)
      await flush()
      const secondRun = engine.run('second', { sessionId })
      await flush()
      expect(cli.commands().filter((command) => command.type !== 'get_state').map((command) => command.type)).toEqual(['prompt', 'switch_session'])
      const switchCommand = cli.commands().find((command) => command.type === 'switch_session')
      expect(switchCommand?.sessionPath).toBe('/sessions/s1.jsonl')
      cli.line({ type: 'response', command: 'switch_session', success: true, id: switchCommand?.id })
      await flush()

      const secondPrompt = cli.commands().filter((command) => command.type === 'prompt').at(-1)
      expect(secondPrompt?.message).toContain('second')
      cli.line({ type: 'response', command: 'prompt', success: true, id: secondPrompt?.id })
      await flush()

      // A pending extension dialog is answered fail-closed.
      cli.line({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Allow dangerous command?' })
      await flush()
      const responses = cli.commands().filter((command) => command.type === 'extension_ui_response')
      expect(responses.at(-1)).toMatchObject({ id: 'ui-1', cancelled: true })

      cli.line({ type: 'agent_settled' })
      await expect(secondRun).resolves.toEqual({ sessionId })
      expect(engine.transcript(sessionId).events.some((event) => event.type === 'user/message' && JSON.stringify(event.data).includes('second'))).toBe(true)
      expect(frames.some((frame) => frame.kind === 'session-event')).toBe(true)
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('lists the native model catalog as provider-qualified options', async () => {
    process.env.ND_DSH_PI_BINARY = process.execPath
    const cli = new FakeCli()
    const engine = new PiCodingEngine({ log: () => {}, spawnProcess: cli.spawn() as never })
    try {
      const modelsPromise = engine.listModels()
      await flush()
      cli.line({
        type: 'response',
        command: 'get_available_models',
        success: true,
        id: 'nd-models',
        data: { models: [
          { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic' },
          { id: 'gpt-5', name: 'GPT-5', provider: 'openai' },
        ] },
      })
      await expect(modelsPromise).resolves.toEqual([
        { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
        { id: 'openai/gpt-5', name: 'GPT-5' },
      ])
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('injects ND provider credentials and browser session into child process environment', async () => {
    process.env.ND_DSH_PI_BINARY = process.execPath
    const cli = new FakeCli()
    let capturedEnv: NodeJS.ProcessEnv | undefined
    const spawnProcess = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv; windowsHide?: boolean }) => {
      capturedEnv = options.env
      return cli.spawn()(file, args, options)
    }
    const mockProviders = {
      allEnabled: () => [
        { id: 'deepseek', name: 'DeepSeek', enabled: true, apiKey: 'sk-test-deepseek', baseUrl: 'https://api.deepseek.com', models: [{ id: 'deepseek-chat', context: '1M' }] },
        { id: 'openai', name: 'OpenAI', enabled: true, apiKey: 'sk-test-openai', baseUrl: 'https://custom.openai.endpoint/v1', models: [{ id: 'gpt-4o', context: '128k' }] },
      ],
      enabled: () => ({ id: 'deepseek', name: 'DeepSeek', enabled: true, apiKey: 'sk-test-deepseek', baseUrl: 'https://api.deepseek.com', models: [{ id: 'deepseek-chat', context: '1M' }] }),
    }
    const engine = new PiCodingEngine({
      log: () => {},
      spawnProcess: spawnProcess as never,
      providers: () => mockProviders as never,
    })
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const run = engine.run('test env injection', { sessionId })
      await flush()
      expect(capturedEnv).toBeDefined()
      expect(capturedEnv?.DEEPSEEK_API_KEY).toBe('sk-test-deepseek')
      expect(capturedEnv?.OPENAI_API_KEY).toBe('sk-test-openai')
      expect(capturedEnv?.OPENAI_BASE_URL).toBe('https://custom.openai.endpoint/v1')
      expect(capturedEnv?.ND_DSH_AGENT_BROWSER_SESSION).toBeDefined()

      const getStateCommand = cli.commands().find((command) => command.type === 'get_state')
      cli.line({ type: 'response', command: 'get_state', success: true, id: getStateCommand?.id, data: { sessionFile: '/sessions/s1.jsonl', sessionId: 's1' } })
      await flush()

      const setModelCommand = cli.commands().find((command) => command.type === 'set_model')
      expect(setModelCommand).toMatchObject({ provider: 'deepseek', modelId: 'deepseek-chat' })
      cli.line({ type: 'response', command: 'set_model', success: true, id: setModelCommand?.id })
      await flush()

      const promptCommand = cli.commands().find((command) => command.type === 'prompt')
      cli.line({ type: 'response', command: 'prompt', success: true, id: promptCommand?.id })
      cli.line({ type: 'agent_settled' })
      await run
    } finally {
      await engine.close()
    }
  }, 15_000)

  it('synchronizes custom OpenAI-compatible providers into models.json and auth.json for Pi', async () => {
    process.env.ND_DSH_PI_BINARY = process.execPath
    const cli = new FakeCli()
    let capturedEnv: NodeJS.ProcessEnv | undefined
    const spawnProcess = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv; windowsHide?: boolean }) => {
      capturedEnv = options.env
      return cli.spawn()(file, args, options)
    }
    const customProviders = {
      allEnabled: () => [
        {
          id: 'custom-26c67720',
          name: 'remote',
          enabled: true,
          apiKey: 'sk-remote-test-key',
          baseUrl: 'https://opencode.ai/zen/go/v1',
          apiFormat: 'OpenAI compatible (/v1/chat/completions)',
          models: [{ id: 'mimo-v2.6-flash', context: '1M' }],
        },
      ],
      enabled: () => ({
        id: 'custom-26c67720',
        name: 'remote',
        enabled: true,
        apiKey: 'sk-remote-test-key',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        apiFormat: 'OpenAI compatible (/v1/chat/completions)',
        models: [{ id: 'mimo-v2.6-flash', context: '1M' }],
      }),
    }
    const engine = new PiCodingEngine({
      log: () => {},
      spawnProcess: spawnProcess as never,
      providers: () => customProviders as never,
    })
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const run = engine.run('test custom provider', { sessionId })
      await flush()
      expect(capturedEnv?.PI_CODING_AGENT_DIR).toBeDefined()
      const piDir = capturedEnv!.PI_CODING_AGENT_DIR!
      const modelsJson = JSON.parse(readFileSync(join(piDir, 'models.json'), 'utf8'))
      expect(modelsJson.providers['custom-26c67720']).toBeDefined()
      expect(modelsJson.providers['custom-26c67720'].baseUrl).toBe('https://opencode.ai/zen/go/v1')
      expect(modelsJson.providers['custom-26c67720'].models[0].id).toBe('mimo-v2.6-flash')

      const authJson = JSON.parse(readFileSync(join(piDir, 'auth.json'), 'utf8'))
      expect(authJson['custom-26c67720']).toMatchObject({ type: 'api_key', key: 'sk-remote-test-key' })

      const getStateCommand = cli.commands().find((command) => command.type === 'get_state')
      cli.line({ type: 'response', command: 'get_state', success: true, id: getStateCommand?.id, data: { sessionFile: '/sessions/s2.jsonl', sessionId: 's2' } })
      await flush()

      const setModelCommand = cli.commands().find((command) => command.type === 'set_model')
      expect(setModelCommand).toMatchObject({ provider: 'custom-26c67720', modelId: 'mimo-v2.6-flash' })
      cli.line({ type: 'response', command: 'set_model', success: true, id: setModelCommand?.id })
      await flush()

      const promptCommand = cli.commands().find((command) => command.type === 'prompt')
      cli.line({ type: 'response', command: 'prompt', success: true, id: promptCommand?.id })
      cli.line({ type: 'agent_settled' })
      await run
    } finally {
      await engine.close()
    }
  }, 15_000)
})

