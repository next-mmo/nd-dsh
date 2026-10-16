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
})

describe('Gemini Web session behavior', () => {
  it('imports only the completed browser reply, once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-stream-'))
    const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath: harnessSessionStore(directory) })
    const internals = engine as unknown as { sessions: Map<string, unknown>; importUnseenTurns: (session: unknown, snapshot: unknown) => void }
    try {
      const { sessionId } = await engine.createSession({ cwd: '/workspace' })
      const session = internals.sessions.get(sessionId)
      for (const [text, busy] of [['Hello', true], ['Hello world', true], ['Hello world!', false], ['Hello world!', false]] as const) {
        internals.importUnseenTurns(session, { url: 'https://gemini.google.com/app/conv', busy, turns: [{ role: 'assistant', text }] })
      }
      const events = engine.transcript(sessionId).events
      expect(events).toHaveLength(1)
      expect(events[0]?.data).toEqual({ message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world!' }] } })
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
        browser: { state: () => ({ url: 'https://gemini.google.com/gem/1e5f6a7b8c9d' }) } as never,
        workspace: { state: () => ({ root: '/workspace', projectName: 'demo' }) } as never,
        storePath,
      })
      expect(await auto.resolveGemBinding('/workspace')).toMatchObject({
        workspaceRoot: '/workspace',
        gemRef: '1e5f6a7b8c9d',
        gemUrl: 'https://gemini.google.com/gem/1e5f6a7b8c9d',
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

      const saved = await engine1.setGemBinding('/workspace/app', 'https://gemini.google.com/gems/view/1e5f6a7b8c9d')
      expect(saved).toMatchObject({
        workspaceRoot: '/workspace/app',
        gemRef: '1e5f6a7b8c9d',
        gemId: '1e5f6a7b8c9d',
        gemUrl: 'https://gemini.google.com/gem/1e5f6a7b8c9d',
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
        gemRef: '1e5f6a7b8c9d',
        source: 'manual',
      })

      await engine2.clearGemBinding('/workspace/app')
      expect(engine2.getGemBinding('/workspace/app')).toBeNull()

      await engine2.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects non-Gem inputs with clear instructions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nd-gemini-invalid-'))
    const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath: harnessSessionStore(directory) })
    try {
      expect(() => engine.setGemBinding('/workspace', 'not a gem')).toThrow(/Invalid Gemini Gem link/)
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