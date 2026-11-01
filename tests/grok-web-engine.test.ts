import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { GrokWebEngine } from '../src/main/engines/grok-web/grok-web-engine.js'
import { GROK_WEB_ENGINE_ID } from '../src/shared/coding-engines.js'
import { PageGuardError } from '../src/main/browser/page-driver.js'
import { WebTurnProgress } from '../src/main/engines/web-turn.js'

describe('GrokWebEngine', () => {
  it('creates and lists sessions with profile and persistence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-grok-test-'))
    const storePath = join(directory, 'grok-sessions.json')
    const browser = {
      activeProfileId: () => 'default-profile',
      tabUrl: () => undefined,
      state: () => ({ visible: true, cdpPort: 9222 }),
    }
    const workspace = { state: () => ({ root: '/workspace/test' }) }
    const engine = new GrokWebEngine({ browser: browser as never, workspace: workspace as never, storePath })

    try {
      const created = await engine.createSession({ cwd: '/workspace/test', title: 'Test Grok Chat' })
      expect(created.sessionId).toMatch(/^grok-web-/)

      const sessions = engine.listSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({
        sessionId: created.sessionId,
        engineId: GROK_WEB_ENGINE_ID,
        title: 'Test Grok Chat',
        cwd: '/workspace/test',
        running: false,
      })

      const models = await engine.listModels()
      expect(models.map((m) => m.id)).toEqual(['default', 'grok-3', 'grok-2', 'deepsearch', 'think'])

      expect(engine.ownsSession(created.sessionId)).toBe(true)
      expect(engine.ownsSession('unknown-session')).toBe(false)
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('captures DOM turns from grok.com snapshot', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-grok-dom-'))
    const engine = new GrokWebEngine({
      browser: {} as never,
      workspace: { state: () => ({ root: '/workspace' }) } as never,
      storePath: join(directory, 'sessions.json'),
    })

    class FakeElement {
      hidden = false
      parentElement: FakeElement | null = null
      nodeType = 1
      isContentEditable = false
      value = ''
      constructor(readonly role: string, readonly innerText: string, readonly order = 0) {}
      getAttribute(attribute: string) {
        if (attribute === 'data-message-author-role') return this.role
        return null
      }
      getBoundingClientRect() { return { width: 100, height: 40 } }
      compareDocumentPosition(other: FakeElement) { return other.order > this.order ? 4 : 2 }
      closest() { return null }
    }

    const userNode = new FakeElement('user', 'What is the speed of light?', 1)
    const assistantNode = new FakeElement('assistant', 'The speed of light in vacuum is approximately 299,792,458 m/s.', 2)
    const fakeComposer = new FakeElement('composer', '', 3)

    const cdp = {
      evaluate: async (script: string) => runInNewContext(script, {
        location: new URL('https://grok.com/chat/12345'),
        HTMLElement: FakeElement,
        Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
        document: {
          title: 'Grok',
          querySelectorAll: (selector: string) => {
            if (selector.includes('data-message-author-role="user"')) return [userNode]
            if (selector.includes('data-message-author-role="assistant"')) return [assistantNode]
            if (selector.includes('textarea') || selector.includes('contenteditable')) return [fakeComposer]
            if (selector.includes('button')) return []
            return []
          },
          querySelector: (selector: string) => {
            if (selector.includes('textarea') || selector.includes('contenteditable')) return fakeComposer
            return null
          },
          body: { innerText: 'Grok chat' },
        },
      }),
    }

    const internals = engine as unknown as {
      captureSnapshot: (cdp: unknown) => Promise<{
        url: string
        composer: boolean
        busy: boolean
        complete: boolean
        turns: Array<{ role: string; text: string }>
      }>
    }

    try {
      const snapshot = await internals.captureSnapshot(cdp)
      expect(snapshot.composer).toBe(true)
      expect(snapshot.busy).toBe(false)
      expect(snapshot.turns).toHaveLength(2)
      expect(snapshot.turns[0]).toEqual({ role: 'user', text: 'What is the speed of light?' })
      expect(snapshot.turns[1]).toEqual({ role: 'assistant', text: 'The speed of light in vacuum is approximately 299,792,458 m/s.' })
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('classifies login-required and verification errors accurately', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-grok-err-'))
    const engine = new GrokWebEngine({
      browser: {} as never,
      workspace: { state: () => ({ root: '/workspace' }) } as never,
      storePath: join(directory, 'sessions.json'),
    })

    const internals = engine as unknown as {
      classifyTurnError: (progress: WebTurnProgress, error: unknown) => { code: string; message: string }
    }

    try {
      const progress = new WebTurnProgress('cdp')
      const loginGuard = new PageGuardError('wrong-page', 'https://grok.com/login', 'Page left allowed origin')
      const loginClassified = internals.classifyTurnError(progress, loginGuard)
      expect(loginClassified.code).toBe('login-required')
      expect(loginClassified.message).toContain('signed in to grok.com')

      const challengeGuard = new PageGuardError('wrong-page', 'https://challenges.cloudflare.com/turnstile', 'Page left allowed origin')
      const challengeClassified = internals.classifyTurnError(progress, challengeGuard)
      expect(challengeClassified.code).toBe('challenge')
      expect(challengeClassified.message).toContain('verification challenge')
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
