import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { GeminiWebEngine } from '../src/main/engines/gemini-web/gemini-web-engine.js'

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
})