import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { PageGuardError } from '../src/main/browser/page-driver.js'
import { ChatGptWebEngine } from '../src/main/engines/chatgpt-web/chatgpt-web-engine.js'
import { discardWebImages } from '../src/main/engines/web-attachments.js'
import { WebTurnProgress } from '../src/main/engines/web-turn.js'
import {
  parseChatGptProjectInput,
  parseChatGptConversationUrl,
  matchProjectByNameOrPrefix,
} from '../src/main/engines/chatgpt-web/chatgpt-project-binding.js'

describe('ChatGPT Web engine', () => {
  it('captures declared assistant turns and shared completion without a nested author-role node', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-dom-'))
    const engine = new ChatGptWebEngine({ browser: {} as never, workspace: {} as never, storePath: join(directory, 'sessions.json') })
    class FakeElement {
      constructor(readonly role: string, readonly innerText: string) {}
      getAttribute(attribute: string) { return attribute === 'data-turn' ? this.role : null }
      querySelector(selector: string) { return selector === 'button[data-testid="copy-turn-action-button"], button[aria-label="Copy response"]' && this.role === 'assistant' ? {} : null }
    }
    let nodes = [new FakeElement('user', 'Translate Hello world'), new FakeElement('assistant', 'Hola mundo!')]
    const cdp = { evaluate: async (script: string) => runInNewContext(script, {
      location: new URL('https://chatgpt.com/c/test'), HTMLElement: FakeElement,
      document: { title: 'ChatGPT', querySelectorAll: () => nodes, querySelector: () => null },
    }) }
    const internals = engine as unknown as { captureSnapshot: (cdp: unknown) => Promise<{ complete: boolean; turns: Array<{ role: string; text: string }> }> }
    try {
      expect(await internals.captureSnapshot(cdp)).toMatchObject({ complete: true, turns: [
        { role: 'user', text: 'Translate Hello world' }, { role: 'assistant', text: 'Hola mundo!' },
      ] })
      nodes = []
      expect(await internals.captureSnapshot(cdp)).toMatchObject({ complete: false, turns: [] })
    } finally { await engine.close(); rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['opening', 'composer'])('stops before further side effects during %s', async (stage) => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-cancel-'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const reached = new Promise<void>((resolve) => { entered = resolve })
    const pause = async () => { entered(); await gate }
    const engine = new ChatGptWebEngine({ browser: { state: () => ({ url: 'about:blank' }) } as never,
      workspace: { state: () => ({ root: '/workspace' }) } as never,
      storePath: join(directory, 'sessions.json') })
    const cdp = { close: vi.fn(), evaluate: vi.fn(async () => { await pause(); return { ok: true } }) }
    const internals = engine as unknown as {
      openBoundConversation: () => Promise<typeof cdp>
      captureSnapshot: () => Promise<unknown>
    }
    internals.openBoundConversation = async () => { if (stage === 'opening') await pause(); return cdp }
    internals.captureSnapshot = async () => ({ url: 'https://chatgpt.com/', turns: [], busy: false })
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const run = engine.run('hello', { sessionId })
      const rejected = expect(run).rejects.toThrow('stopped')
      await reached
      await engine.stop(sessionId)
      release()
      await rejected
      expect(cdp.evaluate).toHaveBeenCalledTimes(stage === 'composer' ? 1 : 0)
      expect(cdp.close).toHaveBeenCalledOnce()
      expect(engine.listSessions()[0]?.running).toBe(false)
    } finally { release(); await engine.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('imports only the completed browser reply, once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-stream-'))
    const engine = new ChatGptWebEngine({ browser: {} as never, workspace: {} as never, storePath: join(directory, 'sessions.json') })
    const internals = engine as unknown as { sessions: Map<string, unknown>; importUnseenTurns: (session: unknown, snapshot: unknown) => void }
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const session = internals.sessions.get(sessionId)
      for (const [text, busy] of [['Hello', true], ['Hello world', true], ['Hello world!', false], ['Hello world!', false]] as const) {
        internals.importUnseenTurns(session, { url: 'https://chatgpt.com/c/test', busy, turns: [{ role: 'assistant', text }] })
      }
      const events = engine.transcript(sessionId).events
      expect(events).toHaveLength(1)
      expect(events[0]?.data).toEqual({ message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world!' }] } })
    } finally { await engine.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('normalizes tampered persisted conversation bindings before use', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-store-'))
    const storePath = join(directory, 'chatgpt-web-sessions.json')
    const sessionId = 'chatgpt-web-ABC-123_def'
    try {
      writeFileSync(storePath, JSON.stringify({
        version: 1,
        sessions: [{
          sessionId,
          conversationUrl: 'https://evil.example/c/not-chatgpt',
          cwd: '/workspace/demo',
          title: 'Tampered session',
          createdAt: 1,
          updatedAt: 2,
          running: true,
          sequence: 0,
          transcript: [],
          seenTurnKeys: [],
          sentPromptHashes: [],
        }],
      }), 'utf8')

      const engine = new ChatGptWebEngine({
        browser: {} as never,
        workspace: {} as never,
        storePath,
      })
      await engine.close()

      const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as {
        sessions: Array<{ conversationUrl?: string; running: boolean }>
      }
      expect(persisted.sessions[0]?.conversationUrl).toBeUndefined()
      expect(persisted.sessions[0]?.running).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('ChatGPT Web browser transports', () => {
  const storeFor = (directory: string): string => join(directory, 'chatgpt-web-sessions.json')

  it('manages browser mode settings and persists them across engine reloads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-mode-'))
    const storePath = storeFor(directory)
    try {
      const engine1 = new ChatGptWebEngine({ browser: {} as never, workspace: {} as never, storePath })
      expect(engine1.getModeSettings()).toEqual({ mode: 'auto', agentFallback: false, visualRecovery: true })
      expect(engine1.setModeSettings({ mode: 'browser-agent', visualRecovery: false })).toEqual({
        mode: 'browser-agent',
        agentFallback: false,
        visualRecovery: false,
      })
      await engine1.close()
      const engine2 = new ChatGptWebEngine({ browser: {} as never, workspace: {} as never, storePath })
      expect(engine2.getModeSettings()).toEqual({ mode: 'browser-agent', agentFallback: false, visualRecovery: false })
      await engine2.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('stops before composing when ChatGPT is already answering', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-busy-'))
    const engine = new ChatGptWebEngine({
      browser: { state: () => ({ url: 'https://chatgpt.com/' }), activeTabId: () => 'tab-1' } as never,
      workspace: { state: () => ({ root: '/workspace' }) } as never,
      storePath: storeFor(directory),
    })
    const driver = { evaluate: vi.fn(async () => true), setFilesOnInput: vi.fn(async () => true), close: vi.fn() }
    const internals = engine as unknown as {
      openBoundConversation: () => Promise<typeof driver>
      captureSnapshot: () => Promise<unknown>
      submitPrompt: ReturnType<typeof vi.fn>
    }
    internals.openBoundConversation = async () => driver
    internals.captureSnapshot = async () => ({
      url: 'https://chatgpt.com/',
      title: 'ChatGPT',
      composer: true,
      busy: true,
      complete: false,
      pendingSend: false,
      challenge: false,
      loginRequired: false,
      rateLimited: false,
      turns: [],
    })
    internals.submitPrompt = vi.fn()
    try {
      await expect(engine.run('hello')).rejects.toMatchObject({ code: 'page-busy', submission: 'none' })
      expect(internals.submitPrompt).not.toHaveBeenCalled()
      expect(driver.close).toHaveBeenCalledOnce()
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps a post-click confirmation timeout as uncertain instead of not submitted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-uncertain-'))
    const engine = new ChatGptWebEngine({ browser: {} as never, workspace: {} as never, storePath: storeFor(directory) })
    const prompt = 'Hello there'
    let now = 1_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const driver = {
      evaluate: vi.fn(async (script: string) => {
        if (script.includes('composerCleared')) {
          now += 10_000
          return { composerCleared: false, busy: false, sendVisible: true, sendDisabled: false }
        }
        if (script.includes('button.click()')) return true
        if (script.includes('return composer instanceof HTMLTextAreaElement')) return prompt
        if (script.includes('return { ok: true }')) return { ok: true }
        return undefined
      }),
      setFilesOnInput: vi.fn(async () => true),
      close: vi.fn(),
    }
    const internals = engine as unknown as {
      submitPrompt: (driver: unknown, prompt: string, signal: AbortSignal, progress: WebTurnProgress) => Promise<void>
    }
    const progress = new WebTurnProgress('extension')
    try {
      await expect(internals.submitPrompt(driver, prompt, new AbortController().signal, progress))
        .rejects.toMatchObject({ name: 'WebTurnError', code: 'submission-uncertain', phase: 'confirm', submission: 'uncertain' })
      expect(progress.submission).toBe('uncertain')
    } finally {
      nowSpy.mockRestore()
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('maps off-site guard failures to stop conditions without transport fallback', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-guard-'))
    const engine = new ChatGptWebEngine({
      browser: {
        state: () => ({ url: 'https://chatgpt.com/', cdpPort: 9222 }),
        activeTabId: () => 'tab-1',
      } as never,
      workspace: { state: () => ({ root: '/workspace' }) } as never,
      storePath: storeFor(directory),
    })
    const internals = engine as unknown as { openBoundConversation: () => Promise<never> }
    try {
      for (const [origin, code] of [
        ['https://auth.openai.com', 'login-required'],
        ['https://challenges.cloudflare.com', 'challenge'],
        ['https://example.com', 'wrong-page'],
      ] as const) {
        const openBoundConversation = vi.fn(async () => { throw new PageGuardError('wrong-page', origin, 'left the page') })
        internals.openBoundConversation = openBoundConversation
        const { sessionId } = await engine.createSession({ cwd: '/workspace' })
        await expect(engine.run('hello', { sessionId })).rejects.toMatchObject({ code, submission: 'none' })
        expect(openBoundConversation).toHaveBeenCalledTimes(1)
      }
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('clicks the page Stop control only after ND submitted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-stop-click-'))
    const evaluateInTab = vi.fn(async () => true)
    const browser = {
      state: () => ({ url: 'https://chatgpt.com/', cdpPort: 9222 }),
      activeTabId: () => 'tab-1',
      tabUrl: () => 'https://chatgpt.com/',
      evaluateInTab,
      ensureAgentReady: async () => {},
    }
    const engine = new ChatGptWebEngine({
      browser: browser as never,
      workspace: { state: () => ({ root: '/workspace' }) } as never,
      storePath: storeFor(directory),
    })
    engine.setModeSettings({ mode: 'extension' })
    const driver = { evaluate: vi.fn(async () => true), setFilesOnInput: vi.fn(async () => true), close: vi.fn() }
    const internals = engine as unknown as {
      openBoundConversation: () => Promise<typeof driver>
      activeTurns: Map<string, { progress?: { submission: string } }>
    }
    try {
      for (const submitted of [false, true]) {
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        let entered!: () => void
        const reached = new Promise<void>((resolve) => { entered = resolve })
        internals.openBoundConversation = async () => { entered(); await gate; return driver }
        const { sessionId } = await engine.createSession({ cwd: '/workspace' })
        const run = engine.run('hello', { sessionId })
        const rejected = expect(run).rejects.toThrow('stopped')
        await reached
        if (submitted) internals.activeTurns.get(sessionId)!.progress!.submission = 'confirmed'
        await engine.stop(sessionId)
        release()
        await rejected
        expect(evaluateInTab).toHaveBeenCalledTimes(submitted ? 1 : 0)
        evaluateInTab.mockClear()
      }
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not duplicate an image turn when ChatGPT echoes only the preview', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-echo-'))
    const engine = new ChatGptWebEngine({ browser: {} as never, workspace: {} as never, storePath: storeFor(directory) })
    const internals = engine as unknown as {
      sessions: Map<string, unknown>
      recordUserMessage: (session: unknown, text: string, images?: readonly { data: string; mediaType: string; name: string }[]) => void
      rememberSentPrompt: (session: unknown, prompt: string) => void
      importUnseenTurns: (session: unknown, snapshot: unknown) => void
    }
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const session = internals.sessions.get(sessionId)
      const prompt = 'What color is this image?'
      internals.recordUserMessage(session, prompt, [{ data: 'AAAA', mediaType: 'image/png', name: 'blue.png' }])
      internals.rememberSentPrompt(session, prompt)
      internals.importUnseenTurns(session, {
        url: 'https://chatgpt.com/c/conv',
        busy: false,
        turns: [
          { role: 'user', text: '![Uploaded image preview](https://chatgpt.com/preview)' },
          { role: 'assistant', text: 'Blue' },
        ],
      })
      const events = engine.transcript(sessionId).events
      expect(events.filter((event) => event.type === 'user/message')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'assistant/message')).toHaveLength(1)
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('ChatGPT Web project parsing and matching', () => {
  it('parses various project URL formats, paths, and raw IDs', () => {
    const fullUrl = 'https://chatgpt.com/g/g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-todo/project'
    expect(parseChatGptProjectInput(fullUrl)).toEqual({
      projectRef: 'g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-todo',
      projectId: 'g-p-6a9bf2a6a8c8191ba1ee77c51bc0967',
      slug: 'todo',
      projectUrl: fullUrl,
    })

    const chatUrl = 'https://chatgpt.com/g/g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-todo/c/6aaac7f2-1234'
    expect(parseChatGptProjectInput(chatUrl)).toEqual({
      projectRef: 'g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-todo',
      projectId: 'g-p-6a9bf2a6a8c8191ba1ee77c51bc0967',
      slug: 'todo',
      projectUrl: fullUrl,
    })

    const pathOnly = '/g/g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-todo/project'
    expect(parseChatGptProjectInput(pathOnly)).toEqual({
      projectRef: 'g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-todo',
      projectId: 'g-p-6a9bf2a6a8c8191ba1ee77c51bc0967',
      slug: 'todo',
      projectUrl: fullUrl,
    })

    const rawRef = 'g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-todo'
    expect(parseChatGptProjectInput(rawRef)).toEqual({
      projectRef: 'g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-todo',
      projectId: 'g-p-6a9bf2a6a8c8191ba1ee77c51bc0967',
      slug: 'todo',
      projectUrl: fullUrl,
    })

    const rawIdWithoutSlug = 'g-p-6a9bf2a6a8c8191ba1ee77c51bc0967'
    expect(parseChatGptProjectInput(rawIdWithoutSlug)).toEqual({
      projectRef: 'g-p-6a9bf2a6a8c8191ba1ee77c51bc0967',
      projectId: 'g-p-6a9bf2a6a8c8191ba1ee77c51bc0967',
      projectUrl: 'https://chatgpt.com/g/g-p-6a9bf2a6a8c8191ba1ee77c51bc0967/project',
    })

    expect(parseChatGptProjectInput('https://evil.com/g/g-p-123/project')).toBeNull()
    expect(parseChatGptProjectInput('not a project')).toBeNull()
    expect(parseChatGptProjectInput('')).toBeNull()
  })

  it('parses conversation URLs extracting projectRef and chatId', () => {
    const projectChat = 'https://chatgpt.com/g/g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-todo/c/6aaac7f2-abcd-ef01'
    expect(parseChatGptConversationUrl(projectChat)).toEqual({
      projectRef: 'g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-todo',
      chatId: '6aaac7f2-abcd-ef01',
    })

    const nonProjectChat = 'https://chatgpt.com/c/6aaac7f2-abcd-ef01'
    expect(parseChatGptConversationUrl(nonProjectChat)).toEqual({
      chatId: '6aaac7f2-abcd-ef01',
    })

    const guestChat = 'https://chatgpt.com/uc/6aaac7f2-abcd-ef01'
    expect(parseChatGptConversationUrl(guestChat)).toEqual({
      chatId: '6aaac7f2-abcd-ef01',
    })

    expect(parseChatGptConversationUrl('https://evil.com/c/123')).toBeNull()
    expect(parseChatGptConversationUrl('invalid')).toBeNull()
  })

  it('matches projects by name or prefix', () => {
    const items = [
      { name: 'Todo App', url: 'https://chatgpt.com/g/g-p-1-todo-app/project' },
      { name: 'Analytics Service', url: 'https://chatgpt.com/g/g-p-2-analytics-service/project' },
    ]

    // Exact match (case insensitive)
    expect(matchProjectByNameOrPrefix('todo app', items)?.name).toBe('Todo App')

    // Prefix match
    expect(matchProjectByNameOrPrefix('todo', items)?.name).toBe('Todo App')

    // Prefix matching the slug
    expect(matchProjectByNameOrPrefix('analytics', items)?.name).toBe('Analytics Service')

    // Unmatched
    expect(matchProjectByNameOrPrefix('billing', items)).toBeNull()
  })
})

describe('ChatGPT Web project binding management and persistence', () => {
  it('manages project bindings and persists them across engine reloads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-proj-'))
    const storePath = join(directory, 'chatgpt-web-sessions.json')

    try {
      const engine1 = new ChatGptWebEngine({
        browser: {} as never,
        workspace: { state: () => ({ root: '/workspace/app', projectName: 'app' }) } as never,
        storePath,
      })

      // Initially no binding
      expect(engine1.getProjectBinding('/workspace/app')).toBeNull()

      // Set binding with full URL
      const saved = await engine1.setProjectBinding('/workspace/app', 'https://chatgpt.com/g/g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-app/project')
      expect(saved).toMatchObject({
        workspaceRoot: '/workspace/app',
        chatGptProjectRef: 'g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-app',
        chatGptProjectId: 'g-p-6a9bf2a6a8c8191ba1ee77c51bc0967',
        chatGptProjectUrl: 'https://chatgpt.com/g/g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-app/project',
        source: 'manual',
      })

      await engine1.close()

      // Reload in a new engine instance
      const engine2 = new ChatGptWebEngine({
        browser: {} as never,
        workspace: { state: () => ({ root: '/workspace/app', projectName: 'app' }) } as never,
        storePath,
      })

      const reloaded = engine2.getProjectBinding('/workspace/app')
      expect(reloaded).toMatchObject({
        workspaceRoot: '/workspace/app',
        chatGptProjectRef: 'g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-app',
        source: 'manual',
      })

      // Clear binding
      await engine2.clearProjectBinding('/workspace/app')
      expect(engine2.getProjectBinding('/workspace/app')).toBeNull()

      await engine2.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('never requires a project and auto-binds one when the browser is already inside it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-resolve-'))
    const storePath = join(directory, 'chatgpt-web-sessions.json')

    try {
      const navigate = vi.fn(async () => {})
      const unbound = new ChatGptWebEngine({
        browser: { state: () => ({ url: 'https://chatgpt.com/' }), navigate } as never,
        workspace: { state: () => ({ root: '/workspace/unbound', projectName: 'unbound' }) } as never,
        storePath,
      })
      expect(await unbound.resolveProjectBinding('/workspace/unbound')).toBeNull()
      expect(navigate).not.toHaveBeenCalled()
      await unbound.close()

      const auto = new ChatGptWebEngine({
        browser: { state: () => ({ url: 'https://chatgpt.com/g/g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-app/project' }) } as never,
        workspace: { state: () => ({ root: '/workspace/unbound', projectName: 'unbound' }) } as never,
        storePath,
      })
      expect(await auto.resolveProjectBinding('/workspace/unbound')).toMatchObject({
        workspaceRoot: '/workspace/unbound',
        chatGptProjectRef: 'g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-app',
        source: 'auto',
      })
      await auto.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('opens the ChatGPT home page when unbound and the linked project when bound', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-direct-'))
    const storePath = join(directory, 'chatgpt-web-sessions.json')

    try {
      const navigate = vi.fn(async () => {})
      const createTab = vi.fn(async (url: string) => ({ id: 'tab-1', url }))
      const engine = new ChatGptWebEngine({
        browser: {
          state: () => ({ url: 'about:blank' }),
          navigate,
          createTab,
          activateTab: vi.fn(async () => ({})),
          tabUrl: () => undefined,
          ensureAgentReady: async () => {},
        } as never,
        workspace: { state: () => ({ root: '/workspace/direct', projectName: 'direct' }) } as never,
        storePath,
      })
      const internals = engine as unknown as {
        sessions: Map<string, unknown>
        openBoundConversation: (session: unknown, signal: AbortSignal) => Promise<unknown>
      }
      try {
        const { sessionId } = await engine.createSession({ cwd: '/workspace/direct' })
        const session = internals.sessions.get(sessionId)
        await expect(internals.openBoundConversation(session, new AbortController().signal)).rejects.toThrow('no CDP target id')
        expect(createTab).toHaveBeenLastCalledWith('https://chatgpt.com/', true)

        await engine.setProjectBinding('/workspace/direct', 'https://chatgpt.com/g/g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-app/project')
        await expect(internals.openBoundConversation(session, new AbortController().signal)).rejects.toThrow('no CDP target id')
        expect(createTab).toHaveBeenLastCalledWith('https://chatgpt.com/g/g-p-6a9bf2a6a8c8191ba1ee77c51bc0967-app/project', true)
      } finally {
        await engine.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('gives each chat one browser tab and reuses it on later turns', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-tabs-'))
    const storePath = join(directory, 'chatgpt-web-sessions.json')
    try {
      let open = false
      const createTab = vi.fn(async (url: string) => {
        open = true
        return { id: 'tab-1', url }
      })
      const activateTab = vi.fn(async () => ({}))
      const navigate = vi.fn(async () => {})
      const engine = new ChatGptWebEngine({
        browser: {
          state: () => ({ url: 'https://chatgpt.com/' }),
          createTab,
          activateTab,
          navigate,
          tabUrl: (tabId: string) => (open && tabId === 'tab-1' ? 'https://chatgpt.com/' : undefined),
          ensureAgentReady: async () => {},
        } as never,
        workspace: { state: () => ({ root: '/workspace/tabs' }) } as never,
        storePath,
      })
      const internals = engine as unknown as {
        sessions: Map<string, { browserTabId?: string }>
        ensureSessionTab: (session: unknown, url: string) => Promise<string>
      }
      try {
        const { sessionId } = await engine.createSession({ cwd: '/workspace/tabs' })
        const session = internals.sessions.get(sessionId)
        expect(await internals.ensureSessionTab(session, 'https://chatgpt.com/')).toBe('tab-1')
        expect(session?.browserTabId).toBe('tab-1')
        expect(await internals.ensureSessionTab(session, 'https://chatgpt.com/')).toBe('tab-1')
        expect(createTab).toHaveBeenCalledTimes(1)
        expect(activateTab).toHaveBeenCalledWith('tab-1')
        expect(navigate).not.toHaveBeenCalled()
        expect(engine.listSessions()[0]?.browserTabId).toBe('tab-1')
      } finally {
        await engine.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reopens a signed-out guest conversation URL instead of the home page', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-guest-'))
    const storePath = join(directory, 'chatgpt-web-sessions.json')

    try {
      const createTab = vi.fn(async (url: string) => ({ id: 'tab-1', url }))
      const engine = new ChatGptWebEngine({
        browser: {
          state: () => ({ url: 'about:blank' }),
          navigate: vi.fn(async () => {}),
          createTab,
          activateTab: vi.fn(async () => ({})),
          tabUrl: () => undefined,
          ensureAgentReady: async () => {},
        } as never,
        workspace: { state: () => ({ root: '/workspace/guest', projectName: 'guest' }) } as never,
        storePath,
      })
      const internals = engine as unknown as {
        sessions: Map<string, { conversationUrl?: string }>
        openBoundConversation: (session: unknown, signal: AbortSignal) => Promise<unknown>
      }
      try {
        const { sessionId } = await engine.createSession({ cwd: '/workspace/guest' })
        const session = internals.sessions.get(sessionId)
        if (!session) throw new Error('guest session missing')
        session.conversationUrl = 'https://chatgpt.com/uc/6aaac7f2-abcd-ef01'
        await expect(internals.openBoundConversation(session, new AbortController().signal)).rejects.toThrow('no CDP target id')
        expect(createTab).toHaveBeenLastCalledWith('https://chatgpt.com/uc/6aaac7f2-abcd-ef01', true)
      } finally {
        await engine.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('targets the visible project ProseMirror composer so the Send button appears and submits', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-project-send-'))
    const storePath = join(directory, 'chatgpt-web-sessions.json')
    try {
      const engine = new ChatGptWebEngine({
        browser: {} as never,
        workspace: { state: () => ({ root: '/workspace/habit', projectName: 'habit-tracker' }) } as never,
        storePath,
      })

      class FakeElement {
        nodeType = 1
        hidden = false
        innerText = ''
        parentElement: FakeElement | null = null
        constructor(
          readonly style: { display: string; visibility: string },
          readonly rect: { width: number; height: number },
        ) {}
        getAttribute() { return null }
        getBoundingClientRect() { return this.rect }
      }

      class FakeButton extends FakeElement {
        disabled = false
        clicked = false
        click() { this.clicked = true }
      }

      class FakeComposer extends FakeElement {
        classList = { contains: (cls: string) => cls === 'ProseMirror' }
        paragraphs: string[] = []
        form: { querySelectorAll: (sel: string) => FakeButton[]; querySelector: (sel: string) => FakeButton | null } | null = null
        focus() {}
        dispatchEvent() { return true }
        replaceChildren(...nodes: Array<{ textContent?: string }>) {
          this.paragraphs = nodes.map((n) => n.textContent ?? '')
          this.innerText = this.paragraphs.join('\n')
        }
        closest(sel: string) { return sel === 'form' ? this.form : null }
      }

      const hiddenContainer = new FakeElement({ display: 'none', visibility: 'visible' }, { width: 0, height: 0 })
      const hiddenComposer = new FakeComposer({ display: 'block', visibility: 'visible' }, { width: 0, height: 0 })
      hiddenComposer.parentElement = hiddenContainer
      hiddenComposer.form = { querySelectorAll: () => [], querySelector: () => null }

      const visibleComposer = new FakeComposer({ display: 'block', visibility: 'visible' }, { width: 340, height: 26 })
      const sendButton = new FakeButton({ display: 'flex', visibility: 'visible' }, { width: 32, height: 32 })
      visibleComposer.form = {
        // Send button only appears after text is inserted into the visible composer
        querySelectorAll: () => (visibleComposer.innerText.trim() ? [sendButton] : []),
        querySelector: () => (visibleComposer.innerText.trim() ? sendButton : null),
      }

      const cdp = {
        evaluate: async (script: string) => runInNewContext(script, {
          HTMLElement: FakeElement,
          HTMLButtonElement: FakeButton,
          HTMLTextAreaElement: class {},
          HTMLInputElement: class {},
          InputEvent: class {},
          Event: class {},
          window: {
            getComputedStyle: (el: FakeElement) => el.style ?? { display: 'block', visibility: 'visible' },
          },
          document: {
            querySelectorAll: (sel: string) => (sel.includes('ProseMirror') ? [hiddenComposer, visibleComposer] : []),
            querySelector: (sel: string) => (sel.includes('ProseMirror') ? hiddenComposer : null),
            createElement: (tag: string) => ({ tagName: tag.toUpperCase(), textContent: '', appendChild: () => {} }),
          },
        }),
      }

      const progress = new WebTurnProgress('cdp')
      const internals = engine as unknown as {
        submitPrompt: (driver: unknown, prompt: string, signal: AbortSignal, progress: WebTurnProgress) => Promise<void>
        confirmSubmission: (driver: unknown, prompt: string, signal: AbortSignal, progress: WebTurnProgress) => Promise<void>
      }
      internals.confirmSubmission = vi.fn(async (_driver, _prompt, _signal, turnProgress: WebTurnProgress) => {
        turnProgress.submission = 'confirmed'
      })
      await internals.submitPrompt(cdp, 'Track daily water intake', new AbortController().signal, progress)

      expect(hiddenComposer.innerText).toBe('')
      expect(visibleComposer.innerText).toBe('Track daily water intake')
      expect(sendButton.clicked).toBe(true)

      await engine.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('updates an existing assistant message in-place when an image finishes loading in a later snapshot', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-img-update-'))
    const storePath = join(directory, 'chatgpt-web-sessions.json')
    try {
      const engine = new ChatGptWebEngine({
        browser: {} as never,
        workspace: { state: () => ({ root: '/workspace' }) } as never,
        storePath,
      })
      const frames: unknown[] = []
      engine.setEmitter((frame) => frames.push(frame))
      const internals = engine as unknown as {
        sessions: Map<string, unknown>
        importUnseenTurns: (session: unknown, snapshot: unknown) => void
      }

      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const session = internals.sessions.get(sessionId)

      internals.importUnseenTurns(session, {
        url: 'https://chatgpt.com/c/test-img',
        busy: false,
        turns: [{ role: 'assistant', text: 'Here is your poster:' }],
      })
      internals.importUnseenTurns(session, {
        url: 'https://chatgpt.com/c/test-img',
        busy: false,
        turns: [{ role: 'assistant', text: '![Generated image 1](data:image/png;base64,abc)\n\nHere is your poster:' }],
      })

      const events = engine.transcript(sessionId).events
      expect(events).toHaveLength(1)
      expect(events[0]?.data).toEqual({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '![Generated image 1](data:image/png;base64,abc)\n\nHere is your poster:' }],
        },
      })

      await engine.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('records attached images on the user turn for thread previews', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-user-images-'))
    const engine = new ChatGptWebEngine({
      browser: {} as never,
      workspace: { state: () => ({ root: '/workspace' }) } as never,
      storePath: join(directory, 'chatgpt-web-sessions.json'),
    })
    const internals = engine as unknown as {
      sessions: Map<string, unknown>
      recordUserMessage: (session: unknown, text: string, images?: unknown[]) => void
    }
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      internals.recordUserMessage(internals.sessions.get(sessionId), 'describe these', [
        { data: 'QUJD', mediaType: 'image/png', name: 'blue.png' },
        { data: 'REVG', mediaType: 'image/jpeg', name: 'red.jpg' },
      ])
      expect(engine.transcript(sessionId).events.at(-1)?.data).toMatchObject({
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'describe these' },
            { type: 'image', mediaType: 'image/png', name: 'blue.png', data: 'QUJD' },
            { type: 'image', mediaType: 'image/jpeg', name: 'red.jpg', data: 'REVG' },
          ],
        },
      })
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('attaches pasted images through the ChatGPT uploader before sending', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-attach-'))
    const engine = new ChatGptWebEngine({
      browser: {} as never,
      workspace: { state: () => ({ root: '/workspace' }) } as never,
      storePath: join(directory, 'chatgpt-web-sessions.json'),
    })
    let uploaded = false
    let stagedFiles: string[] = []
    const cdp = {
      evaluate: vi.fn(async (script: string) => {
        if (script.includes('add files')) return true
        if (script.includes('!== null')) return true
        if (script.includes('Attached images')) return uploaded ? { count: 1, settled: true } : { count: 0, settled: true }
        return undefined
      }),
      setFilesOnInput: vi.fn(async (_expression: string, files: string[]) => {
        stagedFiles = files
        uploaded = true
        return true
      }),
    }
    const internals = engine as unknown as {
      attachImages: (connection: typeof cdp, images: unknown[], signal: AbortSignal) => Promise<{ directory: string; files: string[] } | undefined>
    }
    let staged: { directory: string; files: string[] } | undefined
    try {
      staged = await internals.attachImages(cdp, [{
        data: Buffer.from('chatgpt-image').toString('base64'),
        mediaType: 'image/jpeg',
        name: 'screen shot.jpg',
      }], new AbortController().signal)
      expect(staged?.files).toHaveLength(1)
      expect(stagedFiles).toEqual(staged?.files)
      expect(readFileSync(stagedFiles[0]!, 'utf8')).toBe('chatgpt-image')
      expect(stagedFiles[0]).toMatch(/screen-shot-1\.jpg$/)
      expect(cdp.setFilesOnInput).toHaveBeenCalledTimes(1)
    } finally {
      discardWebImages(staged)
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

