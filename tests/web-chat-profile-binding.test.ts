import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CHATGPT_WEB_ENGINE_ID, GEMINI_WEB_ENGINE_ID } from '../src/shared/coding-engines.js'
import { EngineSessionRouter } from '../src/main/engines/engine-session-router.js'
import { ChatGptWebEngine } from '../src/main/engines/chatgpt-web/chatgpt-web-engine.js'
import { GeminiWebEngine } from '../src/main/engines/gemini-web/gemini-web-engine.js'

const workspaceState = { root: '/workspace', name: 'workspace', projectName: 'project' }

function profileBrowser(overrides: Record<string, unknown> = {}) {
  return {
    activeProfileId: vi.fn(() => 'work'),
    activeTabId: vi.fn(() => 'user-tab'),
    defaultProfileId: vi.fn(() => 'default'),
    profileExists: vi.fn((id: string) => id === 'work' || id === 'default'),
    createTab: vi.fn(async (url: string, _activate: boolean, profileId?: string) => ({ id: 'chat-tab', url, profileId })),
    activateTab: vi.fn(async () => ({})),
    switchProfile: vi.fn(async () => ({})),
    tabUrl: vi.fn(() => 'https://chatgpt.com/'),
    navigate: vi.fn(async () => ({})),
    state: () => ({ url: 'https://chatgpt.com/' }),
    ...overrides,
  }
}

function chatSessionStore(directory: string, sessions: unknown[]): string {
  const path = join(directory, 'chatgpt-web-sessions.json')
  writeFileSync(path, JSON.stringify({
    version: 1,
    sessions,
  }), 'utf8')
  return path
}

function legacySession(sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId,
    title: 'Legacy chat',
    createdAt: 1,
    updatedAt: 1,
    running: false,
    sequence: 0,
    transcript: [],
    seenTurnKeys: [],
    sentPromptHashes: [],
    ...extra,
  }
}

describe('web chat browser profile binding', () => {
  it('binds a new chat to the active profile and creates its tab there', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chat-profile-'))
    const browser = profileBrowser()
    const engine = new ChatGptWebEngine({
      browser: browser as never,
      workspace: { state: () => workspaceState } as never,
      storePath: join(directory, 'chatgpt-web-sessions.json'),
    })
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      expect(await engine.ensureBrowserTab(sessionId)).toBe('chat-tab')
      expect(browser.createTab).toHaveBeenCalledWith('https://chatgpt.com/', true, 'work')
      const persisted = JSON.parse(readFileSync(join(directory, 'chatgpt-web-sessions.json'), 'utf8'))
      expect(persisted.sessions[0].browserProfileId).toBe('work')
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('migrates a session saved before profiles to the default profile', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chat-profile-legacy-'))
    const storePath = chatSessionStore(directory, [legacySession('chatgpt-web-legacy')])
    const browser = profileBrowser()
    const engine = new ChatGptWebEngine({
      browser: browser as never,
      workspace: { state: () => workspaceState } as never,
      storePath,
    })
    try {
      expect(await engine.ensureBrowserTab('chatgpt-web-legacy')).toBe('chat-tab')
      expect(browser.createTab).toHaveBeenCalledWith('https://chatgpt.com/', true, 'default')
      const persisted = JSON.parse(readFileSync(storePath, 'utf8'))
      expect(persisted.sessions[0].browserProfileId).toBe('default')
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rebinds a chat whose profile was deleted instead of resurrecting it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chat-profile-gone-'))
    const storePath = chatSessionStore(directory, [legacySession('gemini-web-gone', { browserProfileId: 'deleted-profile' })])
    const browser = profileBrowser({ profileExists: vi.fn(() => false) })
    const engine = new GeminiWebEngine({
      browser: browser as never,
      workspace: { state: () => workspaceState } as never,
      storePath,
    })
    try {
      expect(await engine.ensureBrowserTab('gemini-web-gone')).toBe('chat-tab')
      expect(browser.createTab).toHaveBeenCalledWith('https://gemini.google.com/app', true, 'default')
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reuses the chat tab and switches back to the profile that owns it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-chat-profile-reuse-'))
    const storePath = chatSessionStore(directory, [legacySession('chatgpt-web-reuse', { browserProfileId: 'work', browserTabId: 'owned-tab' })])
    const tabUrl = vi.fn((tabId: string) => (tabId === 'owned-tab' ? 'https://chatgpt.com/' : undefined))
    const browser = profileBrowser({ tabUrl })
    const engine = new ChatGptWebEngine({
      browser: browser as never,
      workspace: { state: () => workspaceState } as never,
      storePath,
    })
    try {
      expect(await engine.ensureBrowserTab('chatgpt-web-reuse')).toBe('owned-tab')
      expect(browser.activateTab).toHaveBeenCalledWith('owned-tab')
      expect(browser.createTab).not.toHaveBeenCalled()
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('web turns restore the user tab and profile', () => {
  it.each([CHATGPT_WEB_ENGINE_ID, GEMINI_WEB_ENGINE_ID])('returns %s to the tab the user had', async (engineId) => {
    const sessionId = `${engineId}-focus`
    const run = vi.fn(async () => ({ sessionId }))
    const engine = {
      run,
      listSessions: () => [{
        sessionId,
        engineId,
        title: 'focus chat',
        cwd: workspaceState.root,
        createdAt: 1,
        updatedAt: 1,
        running: false,
      }],
      ownsSession: (id: string) => id === sessionId,
      stop: vi.fn(),
      createSession: vi.fn(async () => ({ sessionId })),
    }
    const browser = profileBrowser()
    const router = new EngineSessionRouter(
      { status: () => ({ state: 'ready' }), run: vi.fn(), gatewayRpc: vi.fn(), stop: vi.fn() } as never,
      { ownsSession: () => false } as never,
      { state: () => workspaceState, assertUsable: vi.fn() } as never,
      undefined,
      engineId === CHATGPT_WEB_ENGINE_ID ? { browser, storePath: 'unused', engine } as never : undefined,
      engineId === GEMINI_WEB_ENGINE_ID ? { browser, storePath: 'unused', engine } as never : undefined,
    )

    await router.run('hello', { sessionId })

    expect(browser.activateTab).toHaveBeenCalledWith('user-tab')
    expect(browser.switchProfile).not.toHaveBeenCalled()
  })

  it('falls back to the user profile when their tab was closed during the turn', async () => {
    const sessionId = `${CHATGPT_WEB_ENGINE_ID}-focus-gone`
    const engine = {
      run: vi.fn(async () => ({ sessionId })),
      listSessions: () => [{
        sessionId,
        engineId: CHATGPT_WEB_ENGINE_ID,
        title: 'focus chat',
        cwd: workspaceState.root,
        createdAt: 1,
        updatedAt: 1,
        running: false,
      }],
      ownsSession: (id: string) => id === sessionId,
      stop: vi.fn(),
      createSession: vi.fn(async () => ({ sessionId })),
    }
    const browser = profileBrowser({ tabUrl: vi.fn(() => undefined) })
    const router = new EngineSessionRouter(
      { status: () => ({ state: 'ready' }), run: vi.fn(), gatewayRpc: vi.fn(), stop: vi.fn() } as never,
      { ownsSession: () => false } as never,
      { state: () => workspaceState, assertUsable: vi.fn() } as never,
      undefined,
      { browser, storePath: 'unused', engine } as never,
      undefined,
    )

    await router.run('hello', { sessionId })

    expect(browser.switchProfile).toHaveBeenCalledWith('work')
  })
})
