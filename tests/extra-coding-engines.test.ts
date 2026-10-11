import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { EngineSessionRouter } from '../src/main/engines/engine-session-router.js'
import { createExtraCliEngines, gooseAdapter, hermesAdapter, jcodeAdapter, opencodeAdapter } from '../src/main/engines/agent-cli/extra-cli-engines.js'
import { StructuredCliEngine, type StructuredCliAdapter } from '../src/main/engines/agent-cli/structured-cli-engine.js'
import {
  buildExtraCodingEngineCatalog,
  GOOSE_CLI_ENGINE_ID,
  HERMES_CLI_ENGINE_ID,
  JCODE_CLI_ENGINE_ID,
  MINIMAX_CLI_ENGINE_ID,
  OPENCODE_CLI_ENGINE_ID,
} from '../src/shared/extra-coding-engines.js'

class FakeStructuredCli {
  readonly child: ChildProcess
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()

  constructor() {
    const base = new EventEmitter() as unknown as Record<string, unknown>
    base.stdin = this.stdin
    base.stdout = this.stdout
    base.stderr = this.stderr
    base.pid = 43_243
    base.exitCode = null
    base.signalCode = null
    base.kill = () => true
    this.child = base as unknown as ChildProcess
  }

  spawn(): (file: string, args: string[], options: { windowsHide?: boolean }) => ChildProcess {
    return (_file, _args, options) => {
      expect(options.windowsHide).toBe(true)
      return this.child
    }
  }

  raw(value: string): void {
    this.stdout.write(value)
  }

  close(code = 0, signal: string | null = null): void {
    this.child.emit('close', code, signal)
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

const originalMiniMaxOverride = process.env.ND_DSH_MINIMAX_BINARY
afterAll(() => {
  if (originalMiniMaxOverride === undefined) delete process.env.ND_DSH_MINIMAX_BINARY
  else process.env.ND_DSH_MINIMAX_BINARY = originalMiniMaxOverride
})

describe('extra coding engines', () => {
  it('keeps coding harnesses workspace-capable while MiniMax stays chat-only', () => {
    const catalog = buildExtraCodingEngineCatalog({
      opencodeCliReady: true,
      gooseCliReady: true,
      jcodeCliReady: true,
      hermesCliReady: true,
      minimaxCliReady: true,
    })
    const byId = new Map(catalog.map((engine) => [engine.id, engine]))

    for (const id of [OPENCODE_CLI_ENGINE_ID, GOOSE_CLI_ENGINE_ID, JCODE_CLI_ENGINE_ID, HERMES_CLI_ENGINE_ID]) {
      expect(byId.get(id)?.available).toBe(true)
      expect(byId.get(id)?.capabilities.workspace).toBe(true)
      expect(byId.get(id)?.capabilities.filesystem).toBe(true)
      expect(byId.get(id)?.capabilities.shell).toBe(true)
      expect(byId.get(id)?.capabilities.browser).toBe(false)
      expect(byId.get(id)?.capabilities.humanApprovals).toBe(false)
    }

    expect(byId.get(MINIMAX_CLI_ENGINE_ID)?.available).toBe(true)
    expect(byId.get(MINIMAX_CLI_ENGINE_ID)?.capabilities.workspace).toBe(false)
    expect(byId.get(MINIMAX_CLI_ENGINE_ID)?.capabilities.filesystem).toBe(false)
    expect(byId.get(MINIMAX_CLI_ENGINE_ID)?.capabilities.shell).toBe(false)
  })

  it('registers a runtime adapter for every requested CLI id', () => {
    const engines = new Map(createExtraCliEngines())
    expect([...engines.keys()]).toEqual([
      OPENCODE_CLI_ENGINE_ID,
      GOOSE_CLI_ENGINE_ID,
      JCODE_CLI_ENGINE_ID,
      HERMES_CLI_ENGINE_ID,
      MINIMAX_CLI_ENGINE_ID,
    ])
    for (const engine of engines.values()) {
      expect(typeof engine.run).toBe('function')
      expect(typeof engine.createSession).toBe('function')
      expect(typeof engine.stop).toBe('function')
    }
  })

  it('parses the current OpenCode tool_use and nested error wire formats', () => {
    expect(opencodeAdapter.parse({
      type: 'tool_use',
      sessionID: 'native-open-1',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'call-1',
        state: { status: 'completed', input: { command: 'pnpm test' }, output: 'green' },
      },
    })).toEqual([
      { kind: 'session', sessionId: 'native-open-1' },
      { kind: 'tool-result', callId: 'call-1', name: 'bash', output: 'green' },
    ])

    expect(opencodeAdapter.parse({
      type: 'error',
      error: { name: 'ProviderError', data: { message: 'authentication failed' } },
    })).toEqual([{ kind: 'error', message: 'authentication failed' }])
  })

  it('matches current Goose nested tool payloads and stable named-session resume', () => {
    const firstArgs = gooseAdapter.buildArgs({
      prompt: 'first',
      cwd: process.cwd(),
      sessionId: 'goose-nd-session',
      isContinuation: false,
    })
    expect(firstArgs).toEqual(expect.arrayContaining(['--name', 'goose-nd-session']))
    expect(firstArgs).not.toContain('--resume')

    const resumedArgs = gooseAdapter.buildArgs({
      prompt: 'second',
      cwd: process.cwd(),
      sessionId: 'goose-nd-session',
      isContinuation: true,
    })
    expect(resumedArgs).toEqual(expect.arrayContaining(['--name', 'goose-nd-session', '--resume']))

    expect(gooseAdapter.parse({
      type: 'message',
      message: {
        content: [
          {
            type: 'toolRequest',
            id: 'goose-call-1',
            toolCall: {
              status: 'success',
              value: { name: 'developer__shell', arguments: { command: 'pnpm test' } },
            },
          },
          {
            type: 'toolResponse',
            id: 'goose-call-1',
            toolResult: {
              status: 'success',
              value: { content: [{ type: 'text', text: 'passed' }] },
            },
          },
        ],
      },
    })).toEqual([
      { kind: 'tool-start', callId: 'goose-call-1', name: 'developer__shell', input: { command: 'pnpm test' } },
      { kind: 'tool-result', callId: 'goose-call-1', output: { content: [{ type: 'text', text: 'passed' }] } },
    ])
  })

  it('handles JCode replacement text and tool errors from the current NDJSON protocol', () => {
    expect(jcodeAdapter.parse({ type: 'text_replace', text: 'clean prefix' }))
      .toEqual([{ kind: 'text-replace', text: 'clean prefix' }])
    expect(jcodeAdapter.parse({ type: 'tool_done', id: 'j1', name: 'shell', error: 'command failed' }))
      .toEqual([{ kind: 'tool-result', callId: 'j1', name: 'shell', output: 'command failed', isError: true }])
  })

  it('keeps Hermes no-id tool use/result events correlated by tool name', () => {
    expect(hermesAdapter.parse({ type: 'tool_use', name: 'terminal', input: { command: 'pwd' } }))
      .toEqual([{ kind: 'tool-start', name: 'terminal', input: { command: 'pwd' } }])
    expect(hermesAdapter.parse({ type: 'tool_result', name: 'terminal', output: 'ok' }))
      .toEqual([{ kind: 'tool-result', name: 'terminal', output: 'ok' }])
  })

  it('waits for process close, flushes trailing JSON, and pairs terminal-only tool results', async () => {
    const cli = new FakeStructuredCli()
    const adapter: StructuredCliAdapter = {
      id: 'test-cli',
      label: 'Test',
      sessionPrefix: 'test',
      binary: () => process.execPath,
      unavailableMessage: 'missing',
      buildArgs: () => [],
      parse: (wire) => {
        if (wire.type === 'text' && typeof wire.text === 'string') return [{ kind: 'text', text: wire.text }]
        if (wire.type === 'tool_result') return [{ kind: 'tool-result', callId: 'call-1', name: 'bash', output: wire.output }]
        if (wire.type === 'done') return [{ kind: 'done' }]
        return []
      },
    }
    const engine = new StructuredCliEngine(adapter, { spawnProcess: cli.spawn() as never })
    try {
      const run = engine.run('do the work', { cwd: process.cwd() })
      await tick()
      const sessionId = engine.listSessions()[0]?.sessionId
      expect(sessionId).toBeTruthy()

      cli.raw(JSON.stringify({ type: 'text', text: 'finished' }) + '\n')
      cli.raw(JSON.stringify({ type: 'tool_result', output: 'ok' }) + '\n')
      cli.raw(JSON.stringify({ type: 'done' }))
      await tick()

      expect(engine.listSessions()[0]?.running).toBe(true)
      cli.close(0, null)
      await expect(run).resolves.toEqual({ sessionId })

      const eventTypes = engine.transcript(sessionId!).events.map((event) => event.type)
      expect(eventTypes).toEqual(['user/message', 'assistant/chunk', 'tool/call', 'tool/result', 'assistant/message'])
      expect(engine.listSessions()[0]?.running).toBe(false)
    } finally {
      await engine.close()
    }
  })

  it('pairs no-id tool results with their pending tool call and emits ND-compatible result data', async () => {
    const cli = new FakeStructuredCli()
    const adapter: StructuredCliAdapter = {
      id: 'no-id-cli',
      label: 'No ID',
      sessionPrefix: 'no-id',
      binary: () => process.execPath,
      unavailableMessage: 'missing',
      buildArgs: () => [],
      parse: (wire) => {
        if (wire.type === 'tool_start') return [{ kind: 'tool-start', name: 'terminal', input: { command: 'pwd' } }]
        if (wire.type === 'tool_result') return [{ kind: 'tool-result', name: 'terminal', output: 'ok' }]
        if (wire.type === 'done') return [{ kind: 'done', text: 'complete' }]
        return []
      },
    }
    const engine = new StructuredCliEngine(adapter, { spawnProcess: cli.spawn() as never })
    try {
      const run = engine.run('do it', { cwd: process.cwd() })
      await tick()
      const sessionId = engine.listSessions()[0]!.sessionId
      cli.raw(JSON.stringify({ type: 'tool_start' }) + '\n')
      cli.raw(JSON.stringify({ type: 'tool_result' }) + '\n')
      cli.raw(JSON.stringify({ type: 'done' }) + '\n')
      cli.close(0, null)
      await run

      const transcript = engine.transcript(sessionId).events
      const call = transcript.find((event) => event.type === 'tool/call')
      const result = transcript.find((event) => event.type === 'tool/result')
      expect(call?.data).toMatchObject({ name: 'terminal', arguments: { command: 'pwd' } })
      expect(result?.data).toMatchObject({
        callId: (call?.data as Record<string, unknown>)?.callId,
        message: { content: [{ type: 'text', text: 'ok' }] },
      })
    } finally {
      await engine.close()
    }
  })

  it('keeps MiniMax routing independent of workspace execution', async () => {
    process.env.ND_DSH_MINIMAX_BINARY = '/definitely/not/a/minimax-binary'
    const codex = {
      run: async () => ({ sessionId: 'codex' }),
      createSession: async () => ({ sessionId: 'codex' }),
      stop: async () => {},
      listSessions: () => [],
      transcript: () => ({ sessionId: 'codex', engineId: 'codex-cli', events: [] }),
      ownsSession: () => false,
      handlesApproval: () => false,
      respond: async () => {},
      listModels: async () => [],
    }
    const workspace = {
      state: () => { throw new Error('workspace should not be touched') },
      assertUsable: () => { throw new Error('workspace should not be touched') },
    }
    const router = new EngineSessionRouter({} as never, codex as never, workspace as never)
    try {
      const created = await router.createSession(MINIMAX_CLI_ENGINE_ID)
      expect(created.engineId).toBe(MINIMAX_CLI_ENGINE_ID)
      await expect(router.run('hello', { engineId: MINIMAX_CLI_ENGINE_ID })).rejects.toThrow(/MiniMax CLI.*not installed/)
    } finally {
      await router.close()
    }
  })
})
