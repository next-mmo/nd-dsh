import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  ChatGptWebEngine,
  chatGptSyncBranchName,
  compileChatGptGitPrompt,
  sanitizeRemoteForPrompt,
} from '../src/main/engines/chatgpt-web/chatgpt-web-engine.js'
import {
  parseChatGptProjectInput,
  parseChatGptConversationUrl,
  matchProjectByNameOrPrefix,
} from '../src/main/engines/chatgpt-web/chatgpt-project-binding.js'

describe('ChatGPT Web Git sync helpers', () => {
  it('captures declared assistant turns and shared completion without a nested author-role node', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-dom-'))
    const engine = new ChatGptWebEngine({ browser: {} as never, git: {} as never, workspace: {} as never, storePath: join(directory, 'sessions.json') })
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
  it('keeps chats without a remote independent of Git and preserves the selected branch for Git chats', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-optional-'))
    let remotes: string[] = []
    const git = { refresh: async () => ({ remotes, branch: 'feature/readable' }), remoteUrl: async () => 'https://example.com/repo.git', head: async () => 'abc', ensureBranch: vi.fn(async () => {}), pushBranch: vi.fn(async () => {}), remoteBranchHead: async () => 'abc', hasUncommittedChanges: async () => false }
    const engine = new ChatGptWebEngine({ browser: {} as never, workspace: { state: () => ({ root: '/workspace' }) } as never, git: git as never, storePath: join(directory, 'sessions.json') })
    const internals = engine as unknown as { sessions: Map<string, { transcript: Array<{ type: string }> }>; prepareGit: (session: unknown, signal: AbortSignal) => Promise<{ branch: string } | null> }
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const session = internals.sessions.get(sessionId)!
      expect(await internals.prepareGit(session, new AbortController().signal)).toBeNull()
      expect(git.pushBranch).not.toHaveBeenCalled()
      session.transcript.push({ type: 'user/message' })
      remotes = ['origin']
      expect(await internals.prepareGit(session, new AbortController().signal)).toBeNull()
      const next = await engine.createSession({ cwd: '/workspace' })
      expect(await internals.prepareGit(internals.sessions.get(next.sessionId), new AbortController().signal)).toMatchObject({ branch: 'feature/readable' })
      expect(git.ensureBranch).toHaveBeenCalledWith('feature/readable')
    } finally { await engine.close(); rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['opening', 'branch', 'composer'])('stops before further side effects during %s', async (stage) => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-cancel-'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const reached = new Promise<void>((resolve) => { entered = resolve })
    const pause = async () => { entered(); await gate }
    const git = {
      refresh: async () => ({ remotes: ['origin'] }),
      remoteUrl: async () => 'https://example.com/repo.git', head: async () => 'abc',
      ensureBranch: vi.fn(async () => { if (stage === 'branch') await pause() }),
      pushBranch: vi.fn(async () => {}), remoteBranchHead: async () => 'abc',
      hasUncommittedChanges: async () => false,
    }
    const engine = new ChatGptWebEngine({ browser: { state: () => ({ url: 'about:blank' }) } as never,
      workspace: { state: () => ({ root: '/workspace' }) } as never, git: git as never,
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
      if (stage !== 'composer') expect(git.pushBranch).not.toHaveBeenCalled()
      expect(cdp.evaluate).toHaveBeenCalledTimes(stage === 'composer' ? 1 : 0)
      expect(cdp.close).toHaveBeenCalledOnce()
      expect(engine.listSessions()[0]?.running).toBe(false)
    } finally { release(); await engine.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('imports only the completed browser reply, once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-stream-'))
    const engine = new ChatGptWebEngine({ browser: {} as never, git: {} as never, workspace: {} as never, storePath: join(directory, 'sessions.json') })
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

  it('derives a stable safe branch from the ND chat id', () => {
    const branch = chatGptSyncBranchName('chatgpt-web-ABC-123_def')
    expect(branch).toBe('nd/chat-abc123def')
    expect(branch).toBe(chatGptSyncBranchName('chatgpt-web-ABC-123_def'))
    expect(branch).not.toBe('main')
    expect(branch).not.toBe('master')
  })

  it('removes URL credentials and metadata before repository data enters a web prompt', () => {
    expect(sanitizeRemoteForPrompt('https://user:secret@github.com/acme/demo.git')).toBe('https://github.com/acme/demo.git')
    expect(sanitizeRemoteForPrompt('https://user:secret@github.com/acme/demo.git?token=oops#private')).toBe('https://github.com/acme/demo.git')
    expect(sanitizeRemoteForPrompt('ssh://user:secret@github.com/acme/demo.git?token=oops#private')).toBe('ssh://github.com/acme/demo.git')
    expect(sanitizeRemoteForPrompt('git@github.com:acme/demo.git')).toBe('git@github.com:acme/demo.git')
  })

  it('tells ChatGPT the exact safe branch and refuses to imply unavailable writes', () => {
    const prompt = compileChatGptGitPrompt('Make the header smaller.', {
      remote: 'origin',
      remoteUrl: 'https://github.com/acme/demo.git',
      branch: 'nd/chat-a1b2c3',
      head: '1234567890abcdef',
      dirty: false,
    })

    expect(prompt).toContain('Branch: nd/chat-a1b2c3')
    expect(prompt).toContain('Expected local HEAD: 1234567890abcdef')
    expect(prompt).toContain('Never push this task directly to main or master.')
    expect(prompt).toContain('do not claim code was pushed')
    expect(prompt).toContain('Make the header smaller.')
  })

  it('normalizes tampered persisted branch and conversation bindings before use', async () => {
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
          branch: '--invalid',
        }],
      }), 'utf8')

      const engine = new ChatGptWebEngine({
        browser: {} as never,
        git: {} as never,
        workspace: {} as never,
        storePath,
      })
      await engine.close()

      const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as {
        sessions: Array<{ branch: string; conversationUrl?: string; running: boolean }>
      }
      expect(persisted.sessions[0]?.branch).toBe(chatGptSyncBranchName(sessionId))
      expect(persisted.sessions[0]?.branch).not.toBe('main')
      expect(persisted.sessions[0]?.conversationUrl).toBeUndefined()
      expect(persisted.sessions[0]?.running).toBe(false)
    } finally {
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
        git: {} as never,
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
        git: {} as never,
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

  it('degrades gracefully to non-git mode if git push fails in prepareGit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-push-fail-'))
    const storePath = join(directory, 'chatgpt-web-sessions.json')

    try {
      const git = {
        refresh: async () => ({ remotes: ['origin'], branch: 'feature/test' }),
        remoteUrl: async () => 'https://example.com/repo.git',
        head: async () => 'abc',
        ensureBranch: vi.fn(async () => {}),
        pushBranch: vi.fn(async () => {
          throw new Error('Connection refused to remote git server')
        }),
        remoteBranchHead: async () => 'abc',
        hasUncommittedChanges: async () => false,
      }

      const engine = new ChatGptWebEngine({
        browser: {} as never,
        workspace: { state: () => ({ root: '/workspace' }) } as never,
        git: git as never,
        storePath,
      })

      const internals = engine as unknown as {
        sessions: Map<string, { transcript: Array<{ type: string; message?: { content?: Array<{ type: string; text?: string }> } }> }>
        prepareGit: (session: unknown, signal: AbortSignal) => Promise<{ branch: string } | null>
      }

      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const session = internals.sessions.get(sessionId)!

      // prepareGit should catch push failure, record a reasoning note, and return null instead of throwing
      const gitInfo = await internals.prepareGit(session, new AbortController().signal)
      expect(gitInfo).toBeNull()

      // Verify reasoning entry was recorded
      expect(session.transcript.some((entry) =>
        entry.type === 'agent/reasoning' &&
        (entry as { data?: { text?: string } }).data?.text?.includes('Connection refused to remote git server'),
      )).toBe(true)

      await engine.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails with clear instructions if no project is bound and auto-match fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chatgpt-resolve-'))
    const storePath = join(directory, 'chatgpt-web-sessions.json')

    try {
      const engine = new ChatGptWebEngine({
        browser: { state: () => ({ url: 'https://chatgpt.com/' }) } as never,
        git: {} as never,
        workspace: { state: () => ({ root: '/workspace/unbound', projectName: 'unbound' }) } as never,
        storePath,
      })

      await expect(engine.resolveProjectBinding('/workspace/unbound')).rejects.toThrow(
        'ChatGPT Web requires a project for "unbound"',
      )

      await engine.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
