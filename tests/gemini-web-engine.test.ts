import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { PageGuardError } from '../src/main/browser/page-driver.js'
import { GeminiWebEngine } from '../src/main/engines/gemini-web/gemini-web-engine.js'
import {
  GEMINI_MODE_FALLBACK,
  geminiModeSelectScript,
  readGeminiModeSwitchResult,
} from '../src/main/engines/gemini-web/gemini-web-models.js'
import { discardWebImages } from '../src/main/engines/web-attachments.js'
import { WebTurnProgress } from '../src/main/engines/web-turn.js'

function harnessSessionStore(directory: string): string {
  return join(directory, 'gemini-web-sessions.json')
}

describe('Gemini Web DOM turn capture', () => {
  it('captures user queries and completed assistant responses in DOM order', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-dom-'))
    const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath: harnessSessionStore(directory) })
    class FakeElement {
      constructor(readonly tagName: string, readonly innerText: string, readonly copyButton: boolean) {}
      getAttribute() { return null }
      querySelector(selector: string) {
        if (selector === '.markdown, [data-test-id="response-content"], .model-response-text') {
          return this instanceof FakeElement && this.tagName === 'MODEL-RESPONSE-CONTENT' ? this : null
        }
        if (selector.includes('Copy') || selector.includes('copy-response')) return this.copyButton ? {} : null
        return null
      }
    }
    let nodes = [
      new FakeElement('USER-QUERY-CONTENT', 'Summarize this repo', false),
      new FakeElement('MODEL-RESPONSE-CONTENT', 'This repo is an Electron app.', true),
    ]
    const cdp = { evaluate: async (script: string) => runInNewContext(script, {
      location: new URL('https://gemini.google.com/app/conv-id'),
      HTMLElement: FakeElement,
      document: { title: 'Gemini', querySelectorAll: () => (nodes as unknown[] as FakeElement[]), querySelector: () => null },
    }) }
    const internals = engine as unknown as { captureSnapshot: (cdp: unknown) => Promise<{ complete: boolean; turns: Array<{ role: string; text: string }> }> }
    try {
      expect(await internals.captureSnapshot(cdp)).toMatchObject({ complete: true, turns: [
        { role: 'user', text: 'Summarize this repo' }, { role: 'assistant', text: 'This repo is an Electron app.' },
      ] })
      nodes = []
      expect(await internals.captureSnapshot(cdp)).toMatchObject({ complete: false, turns: [] })
    } finally { await engine.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('serializes image cards and links from rich DOM nodes into Markdown', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-rich-dom-'))
    const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath: harnessSessionStore(directory) })

    class DomNode {
      constructor(
        readonly nodeType: number,
        readonly tagName: string = '',
        readonly nodeValue: string = '',
        readonly attributes: Record<string, string> = {},
        readonly childNodes: DomNode[] = [],
      ) {}

      getAttribute(name: string) { return this.attributes[name] ?? null }
      querySelector(selector: string): DomNode | null {
        if (selector === '.markdown, [data-test-id="response-content"], .model-response-text') return this
        if (selector.includes('Copy')) return new DomNode(1, 'BUTTON', '', { 'aria-label': 'Copy' })
        return null
      }
      get href() { return this.attributes['href'] ?? '' }
      get src() { return this.attributes['src'] ?? '' }
      get alt() { return this.attributes['alt'] ?? '' }
      get innerText() { return '' }
      get textContent() { return this.nodeValue }
    }

    const img = new DomNode(1, 'IMG', '', { src: 'https://images.com/phone.jpg', alt: 'Xiaomi Redmi Note 9' })
    const link = new DomNode(1, 'A', '', { href: 'https://zdnet.com/phone' }, [img])
    const sourceLink = new DomNode(1, 'A', '', { href: 'https://xiaomi.com' }, [new DomNode(3, '', 'Xiaomi')])
    const sourceText = new DomNode(1, 'DIV', '', {}, [new DomNode(3, '', 'Source: '), sourceLink])
    const p = new DomNode(1, 'P', '', {}, [new DomNode(3, '', 'Here are pictures:')])
    const card = new DomNode(1, 'DIV', '', {}, [link, sourceText])
    const modelResponse = new DomNode(1, 'MODEL-RESPONSE-CONTENT', '', {}, [p, card])

    const cdp = { evaluate: async (script: string) => runInNewContext(script, {
      location: new URL('https://gemini.google.com/app/conv-id'),
      HTMLElement: DomNode,
      document: {
        title: 'Gemini',
        querySelectorAll: () => [modelResponse],
        querySelector: () => null,
      },
    }) }

    const internals = engine as unknown as { captureSnapshot: (cdp: unknown) => Promise<{ complete: boolean; turns: Array<{ role: string; text: string }> }> }
    try {
      const snapshot = await internals.captureSnapshot(cdp)
      expect(snapshot.complete).toBe(true)
      expect(snapshot.turns).toHaveLength(1)
      const assistantTurn = snapshot.turns[0]
      expect(assistantTurn?.role).toBe('assistant')
      expect(assistantTurn?.text).toContain('[![Xiaomi Redmi Note 9](https://images.com/phone.jpg)](https://zdnet.com/phone)')
      expect(assistantTurn?.text).toContain('[Xiaomi](https://xiaomi.com)')
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('extracts Gemini single-image button cards with full-size URI and aria-hidden captions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-single-image-'))
    const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath: harnessSessionStore(directory) })

    class DomNode {
      parent: DomNode | null = null
      constructor(
        readonly nodeType: number,
        readonly tagName: string = '',
        readonly nodeValue: string = '',
        readonly attributes: Record<string, string> = {},
        readonly childNodes: DomNode[] = [],
      ) {
        for (const child of childNodes) child.parent = this
      }

      get className() { return this.attributes['class'] ?? '' }
      getAttribute(name: string) { return this.attributes[name] ?? null }
      closest(selector: string): DomNode | null {
        let cur: DomNode | null = this
        while (cur) {
          if (selector === '[data-full-size-image-uri]' && cur.attributes['data-full-size-image-uri']) return cur
          if (selector === 'a[href]' && cur.tagName === 'A' && cur.attributes['href']) return cur
          cur = cur.parent
        }
        return null
      }
      querySelector(selector: string): DomNode | null {
        if (selector === '.markdown, [data-test-id="response-content"], .model-response-text') return this
        if (selector.includes('Copy')) return new DomNode(1, 'BUTTON', '', { 'aria-label': 'Copy' })
        if (selector === 'img') {
          if (this.tagName === 'IMG') return this
          for (const child of this.childNodes) {
            const found = child.querySelector('img')
            if (found) return found
          }
        }
        return null
      }
      get src() { return this.attributes['src'] ?? '' }
      get alt() { return this.attributes['alt'] ?? '' }
      get innerText() { return '' }
      get textContent() { return this.nodeValue }
    }

    const img = new DomNode(1, 'IMG', '', {
      class: 'hero-image spark-licensed-portrait loaded',
      alt: 'Apple iPhone 8, AI generated',
      src: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:iphone8&s=10',
    })
    const imgButton = new DomNode(1, 'BUTTON', '', { class: 'image-button ng-star-inserted' }, [img])
    const captionSpan = new DomNode(1, 'SPAN', '', {}, [new DomNode(3, '', 'Source: Ubuy Cambodia')])
    const captionDiv = new DomNode(1, 'DIV', '', {
      'aria-hidden': 'true',
      class: 'caption gds-extended-caption hero-caption ng-star-inserted',
    }, [new DomNode(3, '', ' Apple iPhone 8. '), captionSpan])
    const captionRow = new DomNode(1, 'DIV', '', { class: 'hero-caption-row ng-star-inserted' }, [captionDiv])
    const overlay = new DomNode(1, 'DIV', '', { class: 'overlay-container hero-overlay-container' }, [imgButton, captionRow])
    const imageContainer = new DomNode(1, 'DIV', '', {
      class: 'image-container spark-licensed-center',
      'data-full-size-image-uri': 'https://i5.walmartimages.com/seo/Apple-iPhone-8.jpeg',
    }, [overlay])
    const singleImage = new DomNode(1, 'SINGLE-IMAGE', '', { class: 'spark-licensed-center-host' }, [imageContainer])
    const intro = new DomNode(1, 'P', '', {}, [new DomNode(3, '', 'Here is what the iPhone 8 series looks like:')])
    const modelResponse = new DomNode(1, 'MODEL-RESPONSE-CONTENT', '', {}, [intro, singleImage])

    const cdp = { evaluate: async (script: string) => runInNewContext(script, {
      location: new URL('https://gemini.google.com/app/conv-id'),
      HTMLElement: DomNode,
      document: {
        title: 'Gemini',
        querySelectorAll: () => [modelResponse],
        querySelector: () => null,
      },
    }) }

    const internals = engine as unknown as { captureSnapshot: (cdp: unknown) => Promise<{ complete: boolean; turns: Array<{ role: string; text: string }> }> }
    try {
      const snapshot = await internals.captureSnapshot(cdp)
      expect(snapshot.complete).toBe(true)
      expect(snapshot.turns).toHaveLength(1)
      expect(snapshot.turns[0]?.text).toContain(
        '[![Apple iPhone 8](https://encrypted-tbn0.gstatic.com/images?q=tbn:iphone8&s=10)](https://i5.walmartimages.com/seo/Apple-iPhone-8.jpeg)',
      )
      expect(snapshot.turns[0]?.text).toContain('*Apple iPhone 8. Source: Ubuy Cambodia*')
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('Gemini Web session behavior', () => {
  it('imports only the completed browser reply, once, and upgrades in-place if images hydrate later', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-stream-'))
    const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath: harnessSessionStore(directory) })
    const internals = engine as unknown as { sessions: Map<string, unknown>; importUnseenTurns: (session: unknown, snapshot: unknown) => void }
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const session = internals.sessions.get(sessionId)
      for (const [text, busy] of [['Hello', true], ['Hello world', true], ['Hello world!', false], ['Hello world!', false]] as const) {
        internals.importUnseenTurns(session, { url: 'https://gemini.google.com/app/conv', busy, turns: [{ role: 'assistant', text }] })
      }
      expect(engine.transcript(sessionId).events).toHaveLength(1)
      expect(engine.transcript(sessionId).events[0]?.data).toEqual({
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world!' }] },
      })

      internals.importUnseenTurns(session, {
        url: 'https://gemini.google.com/app/conv',
        busy: false,
        turns: [{ role: 'assistant', text: 'Hello world!\n\n![Phone](https://encrypted-tbn0.gstatic.com/images?q=tbn:1)' }],
      })
      const events = engine.transcript(sessionId).events
      expect(events).toHaveLength(1)
      expect(events[0]?.data).toEqual({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello world!\n\n![Phone](https://encrypted-tbn0.gstatic.com/images?q=tbn:1)' }],
        },
      })
    } finally { await engine.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('does not duplicate an image turn when Gemini echoes only the uploaded preview', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-image-echo-'))
    const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath: harnessSessionStore(directory) })
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
        url: 'https://gemini.google.com/app/conv',
        busy: false,
        turns: [
          { role: 'user', text: '![Uploaded image preview](https://lh3.googleusercontent.com/preview)' },
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

  it('never requires a Gem and auto-binds a Gem when the browser is inside one', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-unbound-'))
    const storePath = harnessSessionStore(directory)
    try {
      const plain = new GeminiWebEngine({
        browser: { state: () => ({ url: 'https://gemini.google.com/app' }) } as never,
        workspace: { state: () => ({ root: '/workspace', projectName: 'demo' }) } as never,
        storePath,
      })
      expect(await plain.resolveGemBinding('/workspace')).toBeNull()

      const auto = new GeminiWebEngine({
        browser: { state: () => ({ url: 'https://gemini.google.com/app/fa5b05f3a25f7f76' }) } as never,
        workspace: { state: () => ({ root: '/workspace', projectName: 'demo' }) } as never,
        storePath,
      })
      expect(await auto.resolveGemBinding('/workspace')).toMatchObject({
        workspaceRoot: '/workspace',
        gemRef: 'fa5b05f3a25f7f76',
        gemUrl: 'https://gemini.google.com/app/fa5b05f3a25f7f76',
        source: 'auto',
      })
      await auto.close()
      await plain.close()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('stops before further side effects during opening or composer stages', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-cancel-'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const reached = new Promise<void>((resolve) => { entered = resolve })
    const pause = async () => { entered(); await gate }
    const engine = new GeminiWebEngine({ browser: { state: () => ({ url: 'about:blank' }) } as never,
      workspace: { state: () => ({ root: '/workspace' }) } as never,
      storePath: harnessSessionStore(directory) })
    const cdp = { close: vi.fn(), evaluate: vi.fn(async () => { await pause(); return { ok: true } }) }
    const internals = engine as unknown as {
      openBoundConversation: () => Promise<typeof cdp>
      captureSnapshot: () => Promise<unknown>
    }
    for (const stage of ['opening', 'composer'] as const) {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      let entered!: () => void
      const reached = new Promise<void>((resolve) => { entered = resolve })
      const pause = async () => { entered(); await gate }
      cdp.evaluate.mockImplementation(async () => { await pause(); return { ok: true } })
      internals.openBoundConversation = async () => { if (stage === 'opening') await pause(); return cdp }
      internals.captureSnapshot = async () => ({ url: 'https://gemini.google.com/app', turns: [], busy: false })
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const run = engine.run('hello', { sessionId })
      const rejected = expect(run).rejects.toThrow('stopped')
      await reached
      await engine.stop(sessionId)
      release()
      await rejected
      expect(cdp.evaluate).toHaveBeenCalledTimes(stage === 'composer' ? 1 : 0)
      expect(cdp.close).toHaveBeenCalledOnce()
      expect(engine.listSessions().find((session) => session.sessionId === sessionId)?.running).toBe(false)
      cdp.evaluate.mockClear()
      cdp.close.mockClear()
    }
    await engine.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('stops before composing when the page is already answering', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-busy-'))
    const engine = new GeminiWebEngine({
      browser: { state: () => ({ url: 'https://gemini.google.com/app' }), activeTabId: () => 'tab-1' } as never,
      workspace: { state: () => ({ root: '/workspace' }) } as never,
      storePath: harnessSessionStore(directory),
    })
    const driver = { evaluate: vi.fn(async () => true), setFilesOnInput: vi.fn(async () => true), close: vi.fn() }
    const internals = engine as unknown as {
      openBoundConversation: () => Promise<typeof driver>
      captureSnapshot: () => Promise<unknown>
      submitPrompt: ReturnType<typeof vi.fn>
    }
    internals.openBoundConversation = async () => driver
    internals.captureSnapshot = async () => ({
      url: 'https://gemini.google.com/app',
      title: 'Gemini',
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

  it('maps off-site guard failures to stop conditions without transport fallback', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-guard-'))
    const engine = new GeminiWebEngine({
      browser: {
        state: () => ({ url: 'https://gemini.google.com/app', cdpPort: 9222 }),
        activeTabId: () => 'tab-1',
      } as never,
      workspace: { state: () => ({ root: '/workspace' }) } as never,
      storePath: harnessSessionStore(directory),
    })
    const internals = engine as unknown as { openBoundConversation: () => Promise<never> }
    try {
      for (const [origin, code] of [
        ['https://accounts.google.com', 'login-required'],
        ['https://consent.google.com', 'challenge'],
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

  it('keeps a post-click confirmation timeout as uncertain instead of not submitted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-uncertain-'))
    const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath: harnessSessionStore(directory) })
    const prompt = 'Explain quicksort'
    let now = 1_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const driver = {
      evaluate: vi.fn(async (script: string) => {
        if (script.includes('composerCleared')) {
          now += 10_000
          return { composerCleared: false, busy: false, userTurns: 0 }
        }
        if (script.includes('button.click()')) return true
        if (script.includes('return composer instanceof HTMLTextAreaElement')) return prompt
        if (script.includes("execCommand('insertText'")) return { ok: true, text: prompt }
        return false
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

  it('confirms when Gemini echoes the user turn before the Stop control appears', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-echo-'))
    const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath: harnessSessionStore(directory) })
    const prompt = 'Explain quicksort'
    const driver = {
      evaluate: vi.fn(async (script: string) => {
        if (script.includes('composerCleared')) return { composerCleared: true, busy: false, userTurns: 1 }
        if (script.includes('user-query-content')) return 0
        if (script.includes('button.click()')) return true
        if (script.includes('return composer instanceof HTMLTextAreaElement')) return prompt
        if (script.includes("execCommand('insertText'")) return { ok: true, text: prompt }
        return false
      }),
      setFilesOnInput: vi.fn(async () => true),
      close: vi.fn(),
    }
    const internals = engine as unknown as {
      submitPrompt: (driver: unknown, prompt: string, signal: AbortSignal, progress: WebTurnProgress) => Promise<void>
    }
    const progress = new WebTurnProgress('extension')
    try {
      await internals.submitPrompt(driver, prompt, new AbortController().signal, progress)
      expect(progress.submission).toBe('confirmed')
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('clicks the page Stop control only after ND submitted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-stop-click-'))
    const evaluateInTab = vi.fn(async () => true)
    const browser = {
      state: () => ({ url: 'https://gemini.google.com/app', cdpPort: 9222 }),
      activeTabId: () => 'tab-1',
      tabUrl: () => 'https://gemini.google.com/app',
      evaluateInTab,
      ensureAgentReady: async () => {},
    }
    const engine = new GeminiWebEngine({
      browser: browser as never,
      workspace: { state: () => ({ root: '/workspace' }) } as never,
      storePath: harnessSessionStore(directory),
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
})

describe('Gemini Web Gem binding management and persistence', () => {
  it('manages Gem bindings and persists them across engine reloads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-proj-'))
    const storePath = harnessSessionStore(directory)

    try {
      const engine1 = new GeminiWebEngine({
        browser: {} as never,
        workspace: { state: () => ({ root: '/workspace/app', projectName: 'app' }) } as never,
        storePath,
      })

      expect(engine1.getGemBinding('/workspace/app')).toBeNull()

      const saved = await engine1.setGemBinding('/workspace/app', 'https://gemini.google.com/app/fa5b05f3a25f7f76')
      expect(saved).toMatchObject({
        workspaceRoot: '/workspace/app',
        gemRef: 'fa5b05f3a25f7f76',
        gemId: 'fa5b05f3a25f7f76',
        gemUrl: 'https://gemini.google.com/app/fa5b05f3a25f7f76',
        source: 'manual',
      })

      await engine1.close()

      const engine2 = new GeminiWebEngine({
        browser: {} as never,
        workspace: { state: () => ({ root: '/workspace/app', projectName: 'app' }) } as never,
        storePath,
      })

      const reloaded = engine2.getGemBinding('/workspace/app')
      expect(reloaded).toMatchObject({
        workspaceRoot: '/workspace/app',
        gemRef: 'fa5b05f3a25f7f76',
        source: 'manual',
      })

      await engine2.clearGemBinding('/workspace/app')
      expect(engine2.getGemBinding('/workspace/app')).toBeNull()

      await engine2.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects invalid inputs with clear instructions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-invalid-'))
    const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath: harnessSessionStore(directory) })
    try {
      expect(() => engine.setGemBinding('/workspace', 'not a gem')).toThrow(/Invalid Gemini chat link/)
    } finally { await engine.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('normalizes tampered persisted conversation bindings before use', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-store-'))
    const storePath = harnessSessionStore(directory)
    const sessionId = 'gemini-web-ABC-123_def'
    try {
      writeFileSync(storePath, JSON.stringify({
        version: 1,
        sessions: [{
          sessionId,
          conversationUrl: 'https://evil.example/app/not-gemini',
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

      const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath })
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

  it('attaches pasted images through the Gemini uploader before sending', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-attach-'))
    const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath: harnessSessionStore(directory) })
    let uploaded = false
    let stagedFiles: string[] = []
    const cdp = {
      evaluate: vi.fn(async (script: string) => {
        if (script.includes('(?:&|and)')) return true
        if (script.includes('!== null')) return true
        if (script.includes('close attachment')) return false
        if (script.includes('gem-attachment-tile')) {
          return uploaded ? { count: 1, errors: 0, uploading: false } : { count: 0, errors: 0, uploading: false }
        }
        return undefined
      }),
      setFilesOnInput: vi.fn(async (_expression: string, files: string[]) => {
        stagedFiles = files
        uploaded = true
        return true
      }),
      close: vi.fn(),
    }
    const internals = engine as unknown as {
      attachImages: (connection: typeof cdp, images: unknown[], signal: AbortSignal) => Promise<{ directory: string; files: string[] } | undefined>
    }
    let staged: { directory: string; files: string[] } | undefined
    try {
      staged = await internals.attachImages(cdp, [{
        data: Buffer.from('gemini-image').toString('base64'),
        mediaType: 'image/png',
        name: 'capture.png',
      }], new AbortController().signal)
      expect(staged?.files).toHaveLength(1)
      expect(stagedFiles).toEqual(staged?.files)
      expect(readFileSync(stagedFiles[0]!, 'utf8')).toBe('gemini-image')
      expect(cdp.setFilesOnInput).toHaveBeenCalledTimes(1)
      expect(cdp.setFilesOnInput.mock.calls[0]?.[0]).toContain('document.querySelector')
    } finally {
      discardWebImages(staged)
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('stops before sending when Gemini exposes no image upload control', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-attach-missing-'))
    const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath: harnessSessionStore(directory) })
    const cdp = {
      evaluate: vi.fn(async () => false),
      setFilesOnInput: vi.fn(async () => true),
      close: vi.fn(),
    }
    const internals = engine as unknown as {
      attachImages: (connection: typeof cdp, images: unknown[], signal: AbortSignal) => Promise<unknown>
    }
    try {
      await expect(internals.attachImages(cdp, [{
        data: Buffer.from('x').toString('base64'),
        mediaType: 'image/png',
        name: 'capture.png',
      }], new AbortController().signal)).rejects.toThrow(/no image upload control/)
      expect(cdp.setFilesOnInput).not.toHaveBeenCalled()
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reports a stalled image upload as a sign-in requirement', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-attach-stall-'))
    const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath: harnessSessionStore(directory) })
    const cdp = {
      evaluate: vi.fn(async (script: string) => {
        if (script.includes('(?:&|and)')) return true
        if (script.includes('!== null')) return true
        if (script.includes('gem-attachment-tile')) {
          return { count: 0, errors: 0, uploading: true }
        }
        return undefined
      }),
      setFilesOnInput: vi.fn(async () => true),
      close: vi.fn(),
    }
    const internals = engine as unknown as {
      attachImages: (connection: typeof cdp, images: unknown[], signal: AbortSignal) => Promise<unknown>
    }
    const originalNow = Date.now
    let virtualTime = originalNow()
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      const current = virtualTime
      virtualTime += 15_000
      return current
    })
    try {
      await expect(internals.attachImages(cdp, [{
        data: Buffer.from('x').toString('base64'),
        mediaType: 'image/png',
        name: 'capture.png',
      }], new AbortController().signal)).rejects.toThrow(/still uploading the attached image/)
    } finally {
      nowSpy.mockRestore()
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails fast when an attached image stays in Gemini\'s pending-send state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-attach-pend-'))
    const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath: harnessSessionStore(directory) })
    const internals = engine as unknown as {
      waitForAssistant: (connection: unknown, session: unknown, count: number, signal: AbortSignal, pendingAttachment?: boolean) => Promise<unknown>
      captureSnapshot: () => Promise<unknown>
      captureConversationUrl: (session: unknown, url: string) => void
    }
    internals.captureSnapshot = async () => ({
      url: 'https://gemini.google.com/app/c1',
      title: 'Gemini',
      composer: true,
      busy: false,
      complete: false,
      pendingSend: true,
      challenge: false,
      loginRequired: false,
      rateLimited: false,
      turns: [],
    })
    internals.captureConversationUrl = () => {}
    const startedAt = 1_000_000
    const now = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(startedAt)
      .mockReturnValueOnce(startedAt)
      .mockReturnValue(startedAt + 61_000)
    try {
      await expect(internals.waitForAssistant({} as never, {} as never, 0, new AbortController().signal, true))
        .rejects.toThrow(/still uploading the attached image/)
    } finally {
      now.mockRestore()
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('records attached images on the user turn for thread previews', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-user-images-'))
    const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath: harnessSessionStore(directory) })
    const internals = engine as unknown as {
      sessions: Map<string, unknown>
      recordUserMessage: (session: unknown, text: string, images?: unknown[]) => void
    }
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      internals.recordUserMessage(internals.sessions.get(sessionId), 'describe these', [
        { data: 'QUJD', mediaType: 'image/png', name: 'blue.png' },
      ])
      expect(engine.transcript(sessionId).events.at(-1)?.data).toMatchObject({
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'describe these' },
            { type: 'image', mediaType: 'image/png', name: 'blue.png', data: 'QUJD' },
          ],
        },
      })
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('manages browser mode settings and persists them across engine reloads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-mode-'))
    const storePath = harnessSessionStore(directory)
    try {
      const engine1 = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath })
      expect(engine1.getModeSettings()).toEqual({ mode: 'auto', agentFallback: false, visualRecovery: true })

      const updated = engine1.setModeSettings({ mode: 'browser-agent', visualRecovery: false })
      expect(updated).toEqual({ mode: 'browser-agent', agentFallback: false, visualRecovery: false })
      await engine1.close()

      const engine2 = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath })
      expect(engine2.getModeSettings()).toEqual({ mode: 'browser-agent', agentFallback: false, visualRecovery: false })
      await engine2.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('adopts previously submitted prompt when uncertain retry already appears in DOM', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-adopt-'))
    const engine = new GeminiWebEngine({
      browser: {
        state: () => ({ url: 'https://gemini.google.com/app', cdpPort: 9222 }),
        activeTabId: () => 'tab-1',
        ensureAgentReady: async () => {},
      } as never,
      workspace: { state: () => ({ root: '/workspace' }) } as never,
      storePath: harnessSessionStore(directory),
    })

    const { sessionId } = await engine.createSession({ cwd: '/workspace' })
    const prompt = 'Tell me a joke'

    const driver = {
      evaluate: vi.fn(async (script: string) => {
        if (script.includes('readGeminiDomTurns')) {
          return {
            url: 'https://gemini.google.com/app/c1',
            title: 'Gemini',
            composer: true,
            busy: false,
            complete: true,
            pendingSend: false,
            challenge: false,
            loginRequired: false,
            rateLimited: false,
            turns: [
              { role: 'user', text: prompt },
              { role: 'assistant', text: 'Why did the chicken cross the road?' },
            ],
          }
        }
        return true
      }),
      setFilesOnInput: vi.fn(async () => true),
      close: vi.fn(),
    }

    const internals = engine as unknown as {
      openBoundConversation: () => Promise<typeof driver>
      submitPrompt: () => Promise<void>
      sessions: Map<string, { uncertainPromptHashes?: string[] }>
    }

    internals.openBoundConversation = async () => driver
    internals.submitPrompt = vi.fn(async () => {})

    const sessionObj = internals.sessions.get(sessionId)!
    sessionObj.uncertainPromptHashes = [
      (await import('node:crypto')).createHash('sha256').update(prompt.trim()).digest('hex'),
    ]

    await engine.run(prompt, { sessionId })

    expect(internals.submitPrompt).not.toHaveBeenCalled()
    expect(engine.transcript(sessionId).events.filter((e) => e.type === 'assistant/message')).toHaveLength(1)

    await engine.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('stops and does not fallback when encountering login-required or challenge', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-stop-condition-'))
    const engine = new GeminiWebEngine({
      browser: {
        state: () => ({ url: 'https://gemini.google.com/app', cdpPort: 9222 }),
        activeTabId: () => 'tab-1',
        ensureAgentReady: async () => {},
      } as never,
      workspace: { state: () => ({ root: '/workspace' }) } as never,
      storePath: harnessSessionStore(directory),
    })

    const driver = {
      evaluate: vi.fn(async (script: string) => {
        if (script.includes('readGeminiDomTurns')) {
          return {
            url: 'https://accounts.google.com/auth',
            title: 'Sign in - Google Accounts',
            composer: false,
            busy: false,
            complete: false,
            pendingSend: false,
            challenge: false,
            loginRequired: true,
            rateLimited: false,
            turns: [],
          }
        }
        return false
      }),
      setFilesOnInput: vi.fn(async () => true),
      close: vi.fn(),
    }

    const internals = engine as unknown as {
      openBoundConversation: () => Promise<typeof driver>
    }
    internals.openBoundConversation = async () => driver

    await expect(engine.run('hello')).rejects.toThrow(/needs you signed in to gemini\.google\.com/)

    await engine.close()
    rmSync(directory, { recursive: true, force: true })
  })
})

describe('Gemini Web model selection', () => {
  function geminiModeDom(currentLabel: string, labels: readonly string[]) {
    let menuOpen = false
    const isCurrent = (label: string): boolean =>
      label === currentLabel || label.endsWith(` ${currentLabel}`) || currentLabel.endsWith(` ${label}`)
    const button = {
      label: currentLabel,
      expanded: false,
      clicks: 0,
      querySelector(selector: string) {
        return selector === '.picker-primary-text' ? { textContent: button.label } : null
      },
      getAttribute(name: string) {
        if (name === 'aria-expanded') return button.expanded ? 'true' : 'false'
        if (name === 'aria-label') return `Open mode picker, currently ${button.label}`
        return null
      },
      click() {
        button.clicks += 1
        button.expanded = !button.expanded
        menuOpen = button.expanded
      },
    }
    const items = labels.map((label) => ({
      label,
      className: isCurrent(label) ? 'ng-star-inserted selected' : 'ng-star-inserted',
      querySelector(selector: string) {
        return selector === '.label' ? { textContent: label } : null
      },
      getAttribute() { return null },
      click() {
        button.label = label
        button.expanded = false
        menuOpen = false
        for (const item of items) {
          item.className = item.label === label ? 'ng-star-inserted selected' : 'ng-star-inserted'
        }
      },
    }))
    const document = {
      querySelector(selector: string) {
        return selector.includes('bard-mode-menu-button') ? button : null
      },
      querySelectorAll(selector: string) {
        return selector.includes('gem-menu-item') && menuOpen ? items : []
      },
      dispatchEvent() {
        menuOpen = false
        button.expanded = false
        return true
      },
      body: {
        click() {
          menuOpen = false
          button.expanded = false
        },
      },
    }
    return { document, button, items }
  }

  async function runSelectScript(currentLabel: string, labels: readonly string[], desired: string) {
    const dom = geminiModeDom(currentLabel, labels)
    const value = await runInNewContext(geminiModeSelectScript(desired), {
      document: dom.document,
      KeyboardEvent: class {},
      setTimeout,
    })
    return { ...dom, result: readGeminiModeSwitchResult(value) }
  }

  const labels = ['3.5 Flash-Lite', '3.8 Flash', '3.1 Pro', '4 Argon']

  it('accepts the composer pill short name as already selected without opening the menu', async () => {
    const { result, button } = await runSelectScript('Flash-Lite', labels, '3.5 Flash-Lite')
    expect(result).toMatchObject({ ok: true, changed: false, current: 'Flash-Lite' })
    expect(button.clicks).toBe(0)
  })

  it('opens the real menu and switches to the requested model', async () => {
    const { result, button } = await runSelectScript('Argon', labels, '3.5 Flash-Lite')
    expect(result).toMatchObject({ ok: true, changed: true, current: '3.5 Flash-Lite' })
    expect(result?.ok && result.options).toEqual(labels)
    expect(button.label).toBe('3.5 Flash-Lite')
    expect(button.expanded).toBe(false)
  })

  it('reports the available models instead of silently keeping the old one', async () => {
    const { result, button } = await runSelectScript('Argon', labels, '9 Nova')
    expect(result).toMatchObject({ ok: false, reason: 'unknown-model', options: labels })
    expect(button.label).toBe('Argon')
    expect(button.expanded).toBe(false)
  })

  it('reports a missing picker as its own failure', async () => {
    const value = await runInNewContext(geminiModeSelectScript('3.8 Flash'), {
      document: { querySelector: () => null },
      KeyboardEvent: class {},
      setTimeout,
    })
    expect(readGeminiModeSwitchResult(value)).toEqual({ ok: false, reason: 'picker-missing' })
  })

  it('caches the live menu across engine reloads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-model-store-'))
    const storePath = harnessSessionStore(directory)
    const engine = new GeminiWebEngine({ browser: {} as never, workspace: { state: () => ({ root: '/workspace' }) } as never, storePath })
    const driver = {
      evaluate: vi.fn(async () => ({ ok: true, changed: true, current: 'Flash-Lite', options: labels })),
      setFilesOnInput: vi.fn(async () => true),
      close: vi.fn(),
    }
    const internals = engine as unknown as {
      applyModel: (driver: unknown, model: string | undefined, signal: AbortSignal) => Promise<void>
    }
    try {
      expect(await engine.listModels()).toEqual(GEMINI_MODE_FALLBACK)
      await internals.applyModel(driver, '3.5 Flash-Lite', new AbortController().signal)
      expect(await engine.listModels()).toEqual(labels.map((label) => ({ id: label, name: label })))
      await engine.close()

      const reloaded = new GeminiWebEngine({ browser: {} as never, workspace: { state: () => ({ root: '/workspace' }) } as never, storePath })
      expect(await reloaded.listModels()).toEqual(labels.map((label) => ({ id: label, name: label })))
      await reloaded.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails with the account-specific model list when the requested model is gone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-model-gone-'))
    const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath: harnessSessionStore(directory) })
    const driver = {
      evaluate: vi.fn(async () => ({ ok: false, reason: 'unknown-model', options: ['3.8 Flash'] })),
      setFilesOnInput: vi.fn(async () => true),
      close: vi.fn(),
    }
    const internals = engine as unknown as {
      applyModel: (driver: unknown, model: string | undefined, signal: AbortSignal) => Promise<void>
    }
    try {
      await expect(internals.applyModel(driver, '4 Argon', new AbortController().signal))
        .rejects.toThrow(/does not offer the "4 Argon" model.*available: 3\.8 Flash/)
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('forwards the selected model into the page before composing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-model-run-'))
    const engine = new GeminiWebEngine({
      browser: { state: () => ({ url: 'https://gemini.google.com/app', cdpPort: 0 }), activeTabId: () => 'tab-1' } as never,
      workspace: { state: () => ({ root: '/workspace' }) } as never,
      storePath: harnessSessionStore(directory),
    })
    const driver = { evaluate: vi.fn(async () => true), setFilesOnInput: vi.fn(async () => true), close: vi.fn() }
    const snapshot = {
      url: 'https://gemini.google.com/app',
      title: 'Gemini',
      composer: true,
      busy: false,
      complete: false,
      pendingSend: false,
      challenge: false,
      loginRequired: false,
      rateLimited: false,
      turns: [],
    }
    const completed = { ...snapshot, complete: true, turns: [{ role: 'assistant', text: 'ok' }] }
    const internals = engine as unknown as {
      openBoundConversation: () => Promise<typeof driver>
      captureSnapshot: () => Promise<typeof snapshot>
      waitForAssistant: () => Promise<typeof completed>
      captureConversationUrl: () => void
      applyModel: ReturnType<typeof vi.fn>
      submitPrompt: ReturnType<typeof vi.fn>
    }
    internals.openBoundConversation = async () => driver
    internals.captureSnapshot = async () => snapshot
    internals.waitForAssistant = async () => completed
    internals.captureConversationUrl = () => {}
    internals.applyModel = vi.fn(async () => {})
    internals.submitPrompt = vi.fn(async () => {})
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      await engine.run('hello', { sessionId, model: '3.5 Flash-Lite' })
      expect(internals.applyModel).toHaveBeenCalledWith(driver, '3.5 Flash-Lite', expect.any(AbortSignal))
      expect(internals.submitPrompt).toHaveBeenCalledOnce()
    } finally {
      await engine.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})