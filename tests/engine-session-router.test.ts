import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EngineSessionRouter } from '../src/main/engines/engine-session-router.js'
import type { WorkspaceState } from '../src/shared/contracts.js'
import { ND_WORKSPACE_CONTEXT_MARKER } from '../src/shared/workspace-context.js'
import { CHATGPT_WEB_ENGINE_ID, CLAUDE_CODE_CLI_ENGINE_ID, CODEX_CLI_ENGINE_ID, GEMINI_WEB_ENGINE_ID, ND_NATIVE_ENGINE_ID } from '../src/shared/coding-engines.js'
import { ND_NATIVE_PRIVATE_SELECTION_ENV } from '../src/main/engines/nd-native/native-selection-gate.js'

const workspaceState: WorkspaceState = {
  root: 'C:/projects/parent/examples',
  name: 'examples',
  binding: 'project',
  projectId: 'blog-news',
  projectName: 'Blog News',
  projectObjective: 'Publish local news and community stories.',
}

function fixture() {
  const run = vi.fn(async (_prompt: string, options?: { sessionId?: string }) => ({ sessionId: options?.sessionId ?? 'session-1' }))
  const sessions = new Map<string, { sessionId: string; engineId: string; cwd?: string; title: string; createdAt: number; updatedAt: number; running: boolean }>()
  let counter = 0
  const direct = {
    run,
    stop: vi.fn(),
    listModels: async () => [{ id: 'native-model' }],
    ownsSession: (id: string) => id === 'session-1' || sessions.has(id),
    createSession: vi.fn(async (input: { cwd?: string } = {}) => {
      counter += 1
      const sessionId = `direct-${counter}`
      sessions.set(sessionId, { sessionId, engineId: 'direct', ...(input.cwd ? { cwd: input.cwd } : {}), title: sessionId, createdAt: Date.now(), updatedAt: Date.now(), running: false })
      return { sessionId }
    }),
    listSessions: () => [...sessions.values()],
    transcript: (sessionId: string) => ({ sessionId, engineId: 'direct', events: [] }),
    handlesApproval: () => false,
    respond: vi.fn(),
  }
  let harnessCounter = 0
  const harness = {
    run: vi.fn(),
    stop: vi.fn(),
    createSession: vi.fn(async () => {
      harnessCounter += 1
      return `harness-${harnessCounter}`
    }),
    renameSession: vi.fn(async () => {}),
    gatewayRpc: vi.fn(async (method: string) => {
      if (method === 'session.create') {
        harnessCounter += 1
        return { ok: true, value: { sessionId: `harness-${harnessCounter}` } }
      }
      return { ok: true }
    }),
    status: () => ({}),
  }
  const workspace = { state: () => workspaceState, assertUsable: vi.fn() }
  const router = new EngineSessionRouter(harness as never, direct as never, workspace as never, direct as never, undefined, undefined, direct as never, direct as never, direct as never, direct as never)
  return { router, run, workspace, harness, direct, sessions }
}

describe('session-scoped cancellation', () => {
  it('cancels only the requested harness session', async () => {
    const { router, harness, direct } = fixture()
    await router.stopSession('harness-session')
    expect(harness.gatewayRpc).toHaveBeenCalledWith('session.cancel', { sessionId: 'harness-session' })
    expect(harness.stop).not.toHaveBeenCalled()
    expect(direct.stop).not.toHaveBeenCalled()
  })

  it('passes the session id to its owning direct adapter', async () => {
    const { router, harness, direct } = fixture()
    await router.stopSession('session-1')
    expect(direct.stop).toHaveBeenCalledExactlyOnceWith('session-1')
    expect(harness.gatewayRpc).not.toHaveBeenCalled()
    expect(harness.stop).not.toHaveBeenCalled()
  })
})

describe('engine route admission', () => {
  it('fails closed instead of silently routing an unknown engine through Harness', async () => {
    const { router, harness } = fixture()

    await expect(router.run('hello', { engineId: 'missing-engine' })).rejects.toThrow(/Unknown coding engine/)
    await expect(router.createSession('missing-engine')).rejects.toThrow(/Unknown coding engine/)
    expect(harness.run).not.toHaveBeenCalled()
    expect(harness.gatewayRpc).not.toHaveBeenCalled()
  })
})

describe('ND Agent session ownership', () => {
  it('requires both the private flag and a ready native runtime for new sessions', async () => {
    const previous = process.env[ND_NATIVE_PRIVATE_SELECTION_ENV]
    const { harness, workspace, direct } = fixture()
    let ready = false
    const native = {
      ...direct,
      ready: () => ready,
      start: vi.fn(async () => {}),
      ownsSession: () => false,
      listSessions: () => [],
    }
    const router = new EngineSessionRouter(harness as never, direct as never, workspace as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, native as never)
    try {
      delete process.env[ND_NATIVE_PRIVATE_SELECTION_ENV]
      await expect(router.createSession(ND_NATIVE_ENGINE_ID)).rejects.toThrow(/private/i)

      process.env[ND_NATIVE_PRIVATE_SELECTION_ENV] = '1'
      await expect(router.createSession(ND_NATIVE_ENGINE_ID)).rejects.toThrow(/runtime is unavailable/i)

      ready = true
      await expect(router.createSession(ND_NATIVE_ENGINE_ID)).resolves.toMatchObject({ engineId: ND_NATIVE_ENGINE_ID })
    } finally {
      if (previous === undefined) delete process.env[ND_NATIVE_PRIVATE_SELECTION_ENV]
      else process.env[ND_NATIVE_PRIVATE_SELECTION_ENV] = previous
    }
  })

  it('resumes an existing native session with its original engine despite a different requested engine', async () => {
    const { harness, workspace, direct } = fixture()
    const native = {
      ...direct,
      start: vi.fn(async () => {}),
      run: vi.fn(async () => ({ sessionId: 'nd-native-legacy' })),
      ownsSession: (id: string) => id === 'nd-native-legacy',
      listSessions: () => [{ sessionId: 'nd-native-legacy', engineId: 'nd-native', cwd: workspaceState.root, title: 'Old native chat', createdAt: 1, updatedAt: 2, running: false }],
      transcript: async (sessionId: string) => ({ sessionId, engineId: 'nd-native', events: [] }),
    }
    const router = new EngineSessionRouter(harness as never, direct as never, workspace as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, native as never)
    await router.run('continue', { sessionId: 'nd-native-legacy', engineId: 'nd-harness' })
    expect(native.run).toHaveBeenCalledWith(expect.stringContaining('continue'), { sessionId: 'nd-native-legacy', cwd: workspaceState.root })
    expect(harness.run).not.toHaveBeenCalled()
    await expect(router.transcript('nd-native-legacy')).resolves.toMatchObject({ engineId: 'nd-native' })
  })
})

describe('direct engine workspace context', () => {
  it.each(['antigravity', 'codex-cli', 'zcode-cli', 'pi-coding', 'cursor-cli', 'claude-code-cli'])('routes the catalog and selected model for %s', async (engineId) => {
    const { router, run } = fixture()
    await expect(router.models(engineId)).resolves.toEqual([{ id: 'native-model' }])
    await router.run('hello', { engineId, model: 'native-model' })
    expect(run).toHaveBeenCalledWith(expect.any(String), { cwd: workspaceState.root, model: 'native-model' })
  })

  it.each(['antigravity', 'codex-cli', 'zcode-cli', 'pi-coding', 'cursor-cli', 'claude-code-cli'])('sends the selected project and exact folder to %s', async (engineId) => {
    const { router, run, workspace } = fixture()
    await router.run('project about?', { engineId })
    expect(workspace.assertUsable).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith(expect.stringContaining('project about?'), { cwd: workspaceState.root })
    const prompt = (run.mock.calls[0] as unknown as [string])[0]
    expect(prompt.split(ND_WORKSPACE_CONTEXT_MARKER)).toHaveLength(2)
    expect(prompt).toContain('"projectName": "Blog News"')
    expect(prompt).toContain('"projectObjective": "Publish local news and community stories."')
    expect(prompt).toContain('"workingDirectory": "C:/projects/parent/examples"')
  })

  it('keeps mixed direct-engine task sessions on their ND-bound worktree roots', async () => {
    const { router, run } = fixture()
    const codexRoot = 'C:/projects/parent/.nd-dsh-worktrees/repo/task-codex'
    const zcodeRoot = 'C:/projects/parent/.nd-dsh-worktrees/repo/task-zcode'
    router.setWorktreeGuard((cwd) => cwd === codexRoot || cwd === zcodeRoot)

    const codex = await router.createSession('codex-cli', codexRoot)
    const zcode = await router.createSession('zcode-cli', zcodeRoot)

    await router.run('codex task', { sessionId: codex.sessionId })
    await router.run('zcode task', { sessionId: zcode.sessionId })

    expect(run).toHaveBeenNthCalledWith(1, expect.any(String), { sessionId: codex.sessionId, cwd: codexRoot })
    expect(run).toHaveBeenNthCalledWith(2, expect.any(String), { sessionId: zcode.sessionId, cwd: zcodeRoot })
    const codexPrompt = (run.mock.calls[0] as unknown as [string])[0]
    const zcodePrompt = (run.mock.calls[1] as unknown as [string])[0]
    expect(codexPrompt).toContain(`"workingDirectory": "${codexRoot}"`)
    expect(zcodePrompt).toContain(`"workingDirectory": "${zcodeRoot}"`)
    expect(codexPrompt).not.toContain(`"workingDirectory": "${workspaceState.root}"`)
    expect(zcodePrompt).not.toContain(`"workingDirectory": "${workspaceState.root}"`)
  })

  it('carries an isolated Harness task root through to the Harness turn', async () => {
    const { router, harness } = fixture()
    const taskRoot = 'C:/projects/parent/.nd-dsh-worktrees/repo/task-harness'
    const created = await router.createSession('nd-harness', taskRoot)

    expect(harness.gatewayRpc).toHaveBeenCalledWith('session.create', { cwd: taskRoot })
    await router.run('harness task', { sessionId: created.sessionId })

    expect(harness.run).toHaveBeenCalledWith('harness task', {
      sessionId: created.sessionId,
      workspaceCwd: taskRoot,
    })
  })

  it('names harness-created sessions after their real work without touching direct engines', async () => {
    const { router, harness } = fixture()
    const taskRoot = 'C:/projects/parent/.nd-dsh-worktrees/repo/task-named'
    const named = await router.createSession('nd-harness', taskRoot, 'Implement the login flow')
    expect(harness.renameSession).toHaveBeenCalledWith(named.sessionId, 'Implement the login flow')

    harness.renameSession.mockClear()
    const workspaceless = await router.createSession('nd-harness', undefined, 'Implement the login flow')
    expect(harness.renameSession).toHaveBeenCalledWith(workspaceless.sessionId, 'Implement the login flow')

    // Direct engines keep their own thread labels; the title is harness-only today.
    harness.renameSession.mockClear()
    await router.createSession('zcode-cli', taskRoot, 'Implement the login flow')
    expect(harness.renameSession).not.toHaveBeenCalled()
  })

  it('treats a failed session rename as cosmetic and still returns the session', async () => {
    const { router, harness } = fixture()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    harness.renameSession.mockRejectedValue(new Error('rename unavailable'))
    try {
      const created = await router.createSession('nd-harness', 'C:/work', 'Implement the login flow')
      expect(created.sessionId).toBe('harness-1')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('session rename failed'), 'rename unavailable')
    } finally {
      warn.mockRestore()
    }
  })

  it('rejects a caller that tries to re-root an existing Harness session', async () => {
    const { router, harness } = fixture()
    const taskRoot = 'C:/projects/parent/.nd-dsh-worktrees/repo/task-bound'
    const created = await router.createSession('nd-harness', taskRoot)
    harness.run.mockClear()

    await expect(router.run('wrong root', {
      sessionId: created.sessionId,
      workspaceCwd: 'C:/projects/parent/other-root',
    })).rejects.toThrow(/different workspace than the ND-bound session/i)

    expect(harness.run).not.toHaveBeenCalled()
  })

  it('fails closed if a direct adapter reports a different cwd than the ND session binding', async () => {
    const { router, sessions } = fixture()
    const root = 'C:/projects/parent/.nd-dsh-worktrees/repo/task-a'
    router.setWorktreeGuard((cwd) => cwd === root)
    const session = await router.createSession('zcode-cli', root)
    const row = sessions.get(session.sessionId)
    if (!row) throw new Error('missing fake direct session')
    row.cwd = 'C:/projects/other'

    await expect(router.run('should fail', { sessionId: session.sessionId })).rejects.toThrow(/changed the ND-bound task workspace/i)
  })

  it('does not start a direct engine for an unavailable project workspace', async () => {
    const { router, run, workspace } = fixture()
    workspace.assertUsable.mockImplementation(() => { throw new Error('Project workspace is unavailable') })
    await expect(router.run('project about?', { engineId: 'antigravity' })).rejects.toThrow('workspace is unavailable')
    expect(run).not.toHaveBeenCalled()
  })

  it('leaves Harness context attachment to the Harness service', async () => {
    const { router, run, harness } = fixture()
    await router.run('project about?')
    expect(harness.run).toHaveBeenCalledWith('project about?', undefined)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('native direct transcript retention', () => {
  it('merges the local safety tail with post-restart native events', async () => {
    const journal = {
      async append() {},
      async tail() {
        return [
          { type: 'assistant/message', seq: 101, time: 101, data: { text: 'after restart' } },
          { type: 'assistant/message', seq: 102, time: 102, data: { text: 'after restart 2' } },
        ]
      },
      async clear() {},
    }
    const fallbackEvents = Array.from({ length: 32 }, (_, index) => ({
      type: 'assistant/message',
      seq: 69 + index,
      time: 69 + index,
      data: { text: 'fallback-' + (69 + index) },
    }))
    const direct = {
      run: async () => ({ sessionId: 'session-native' }),
      stop: async () => {},
      listModels: async () => [],
      ownsSession: (id: string) => id === 'session-native',
      createSession: async () => ({ sessionId: 'session-native' }),
      listSessions: () => [],
      transcript: () => ({ sessionId: 'session-native', engineId: 'codex-cli', events: fallbackEvents }),
      handlesApproval: () => false,
      respond: async () => {},
      setEmitter: () => {},
    }
    const harness = { run: vi.fn(), stop: vi.fn(), gatewayRpc: vi.fn(async () => ({ ok: true })), status: () => ({}) }
    const workspace = { state: () => workspaceState, assertUsable: vi.fn() }
    const router = new EngineSessionRouter(
      harness as never,
      direct as never,
      workspace as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      journal,
    )

    const transcript = await router.transcript('session-native')
    expect(transcript.events[0]?.seq).toBe(69)
    expect(transcript.events.at(-1)?.seq).toBe(102)
    expect(transcript.events).toHaveLength(34)
  })

  it('replays more history than the engine-local safety tail', async () => {
    const retained = new Map<string, Array<{ type: string; seq: number; time?: number; data?: unknown }>>()
    const journal = {
      async append(sessionId: string, events: Array<{ type: string; seq: number; time?: number; data?: unknown }>) {
        retained.set(sessionId, [...(retained.get(sessionId) ?? []), ...events])
      },
      async tail(sessionId: string, maxMessages: number) {
        return (retained.get(sessionId) ?? []).slice(-maxMessages)
      },
      async clear() { retained.clear() },
    }
    let engineEmit: ((frame: import('../src/shared/contracts.js').DshEventFrame) => void) | undefined
    const direct = {
      run: async () => ({ sessionId: 'session-native' }),
      stop: async () => {},
      listModels: async () => [],
      ownsSession: (id: string) => id === 'session-native',
      createSession: async () => ({ sessionId: 'session-native' }),
      listSessions: () => [],
      transcript: () => ({
        sessionId: 'session-native',
        engineId: 'codex-cli',
        events: [{ type: 'assistant/message', seq: 40, time: 40, data: { text: 'local tail' } }],
      }),
      handlesApproval: () => false,
      respond: async () => {},
      setEmitter: (emit: (frame: import('../src/shared/contracts.js').DshEventFrame) => void) => { engineEmit = emit },
    }
    const harness = { run: vi.fn(), stop: vi.fn(), gatewayRpc: vi.fn(async () => ({ ok: true })), status: () => ({}) }
    const workspace = { state: () => workspaceState, assertUsable: vi.fn() }
    const router = new EngineSessionRouter(
      harness as never,
      direct as never,
      workspace as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      journal,
    )
    router.setEmitter(() => {})

    for (let seq = 1; seq <= 40; seq += 1) {
      engineEmit?.({
        kind: 'session-event',
        sessionId: 'session-native',
        event: { type: 'assistant/message', seq, time: seq, data: { text: 'event-' + seq } },
      })
    }

    const transcript = await router.transcript('session-native')
    expect(transcript.events).toHaveLength(40)
    expect(transcript.events[0]?.seq).toBe(1)
    expect(transcript.events.at(-1)?.seq).toBe(40)
  })
})


async function withTempWorkspace(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'nd-router-workspace-'))
  const previous = workspaceState.root
  workspaceState.root = root
  try {
    await fn(root)
  } finally {
    workspaceState.root = previous
    await rm(root, { recursive: true, force: true })
  }
}

describe('Direct engine attachments', () => {
  it('stages files into the session workspace and references them in the prompt', async () => {
    await withTempWorkspace(async (root) => {
      const { router, run } = fixture()
      const files = [{ data: Buffer.from('hello').toString('base64'), mediaType: 'text/plain', name: 'notes.txt' }]
      await router.run('review these notes', { engineId: CODEX_CLI_ENGINE_ID, files })
      const call = run.mock.calls[0] as unknown as [string, { cwd?: string; images?: unknown }] | undefined
      expect(call?.[0]).toContain('<nd-attachments>')
      expect(call?.[0]).toContain('notes.txt')
      expect(call?.[0]).toContain('.nd-dsh/attachments/')
      expect(call?.[1]).toMatchObject({ cwd: root })
      expect(call?.[1]?.images).toBeUndefined()
    })
  })

  it('passes images natively to Claude instead of staging them', async () => {
    await withTempWorkspace(async () => {
      const { router, run } = fixture()
      const images = [{ data: Buffer.from('image').toString('base64'), mediaType: 'image/png', name: 'shot.png' }]
      await router.run('describe this', { engineId: CLAUDE_CODE_CLI_ENGINE_ID, images })
      const call = run.mock.calls[0] as unknown as [string, { images?: unknown }] | undefined
      expect(call?.[0]).not.toContain('- image:')
      expect(call?.[1]?.images).toEqual(images)
    })
  })

  it('passes native local-image paths to Codex', async () => {
    await withTempWorkspace(async () => {
      const { router, run } = fixture()
      const images = [{ data: Buffer.from('image').toString('base64'), mediaType: 'image/png', name: 'shot.png' }]
      await router.run('describe this', { engineId: CODEX_CLI_ENGINE_ID, images })
      const call = run.mock.calls[0] as unknown as [string, { imagePaths?: string[] }] | undefined
      expect(call?.[0]).not.toContain('- image:')
      expect(call?.[1]?.imagePaths).toHaveLength(1)
      expect(call?.[1]?.imagePaths?.[0]).toMatch(/shot\.png$/)
    })
  })
})

describe('Web chat image attachments', () => {
  it.each([CHATGPT_WEB_ENGINE_ID, GEMINI_WEB_ENGINE_ID])('forwards pasted images to %s', async (engineId) => {
    const sessionId = `${engineId}-session-1`
    const images = [{ data: Buffer.from('image').toString('base64'), mediaType: 'image/png', name: 'shot.png' }]
    const run = vi.fn(async () => ({ sessionId }))
    const engine = {
      run,
      listSessions: () => [{ sessionId, engineId, title: 'image chat', cwd: workspaceState.root, createdAt: 1, updatedAt: 1, running: false }],
      ownsSession: (id: string) => id === sessionId,
      stop: vi.fn(),
      createSession: vi.fn(async () => ({ sessionId })),
    }
    const browser = {
      state: () => ({ url: 'https://example.com/preview' }),
      navigate: vi.fn(async () => {}),
      activeProfileId: () => 'default',
      activeTabId: () => 'tab-1',
      tabUrl: () => undefined,
      activateTab: vi.fn(async () => ({})),
      switchProfile: vi.fn(async () => ({})),
    }
    const harness = { status: () => ({ state: 'ready' }), run: vi.fn(), gatewayRpc: vi.fn(), stop: vi.fn() }
    const workspace = { state: () => workspaceState, assertUsable: vi.fn() }
    const runtime = { browser, git: {} as never, storePath: 'unused', engine }
    const router = new EngineSessionRouter(
      harness as never,
      { ownsSession: () => false } as never,
      workspace as never,
      undefined,
      engineId === CHATGPT_WEB_ENGINE_ID ? runtime as never : undefined,
      engineId === GEMINI_WEB_ENGINE_ID ? runtime as never : undefined,
    )

    await router.run('describe this image', { sessionId, images })

    expect(run).toHaveBeenCalledWith('describe this image', expect.objectContaining({
      sessionId,
      cwd: workspaceState.root,
      images,
    }))
  })

  it.each([CHATGPT_WEB_ENGINE_ID, GEMINI_WEB_ENGINE_ID])('inlines text files for %s and rejects binary files', async (engineId) => {
    const sessionId = `${engineId}-session-files`
    const run = vi.fn(async () => ({ sessionId }))
    const engine = {
      run,
      listSessions: () => [{ sessionId, engineId, title: 'file chat', cwd: workspaceState.root, createdAt: 1, updatedAt: 1, running: false }],
      ownsSession: (id: string) => id === sessionId,
      stop: vi.fn(),
      createSession: vi.fn(async () => ({ sessionId })),
    }
    const browser = {
      state: () => ({ url: 'https://example.com/preview' }),
      navigate: vi.fn(async () => {}),
      activeProfileId: () => 'default',
      activeTabId: () => 'tab-1',
      tabUrl: () => undefined,
      activateTab: vi.fn(async () => ({})),
      switchProfile: vi.fn(async () => ({})),
    }
    const harness = { status: () => ({ state: 'ready' }), run: vi.fn(), gatewayRpc: vi.fn(), stop: vi.fn() }
    const workspace = { state: () => workspaceState, assertUsable: vi.fn() }
    const runtime = { browser, git: {} as never, storePath: 'unused', engine }
    const router = new EngineSessionRouter(
      harness as never,
      { ownsSession: () => false } as never,
      workspace as never,
      undefined,
      engineId === CHATGPT_WEB_ENGINE_ID ? runtime as never : undefined,
      engineId === GEMINI_WEB_ENGINE_ID ? runtime as never : undefined,
    )

    await router.run('summarize', {
      sessionId,
      files: [{ data: Buffer.from('const value = 1').toString('base64'), mediaType: 'text/typescript', name: 'a.ts' }],
    })
    const prompts = run.mock.calls as unknown as Array<[string]>
    expect(prompts[0]?.[0]).toContain('const value = 1')
    expect(prompts[0]?.[0]).toContain('<attached-files>')

    await expect(router.run('open this', {
      sessionId,
      files: [{ data: Buffer.from('%PDF').toString('base64'), mediaType: 'application/pdf', name: 'brief.pdf' }],
    })).rejects.toThrow(/text\/code files only/)
  })
})
