import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  DshEventFrame,
  EngineSessionSummary,
  EngineSessionTranscript,
  GeminiGemBinding,
  SessionEventEnvelope,
} from '../../../shared/contracts.js'
import { GEMINI_WEB_ENGINE_ID } from '../../../shared/coding-engines.js'
import type { BrowserController } from '../../browser/browser-controller.js'
import { GEMINI_DOM_TURNS_SCRIPT } from '../../browser/gemini-dom-turns.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import {
  isGeminiConversationUrl,
  isGeminiPageUrl,
  parseGeminiConversationUrl,
  parseGeminiGemInput,
  sameGeminiUrl,
} from './gemini-project-binding.js'

const GEMINI_HOME_URL = 'https://gemini.google.com/app'
const GEMINI_GEMS_URL = 'https://gemini.google.com/gems'
// Gemini's composer is a contenteditable editor inside <rich-textarea>/main.
const GEMINI_COMPOSER_SELECTOR = 'main rich-textarea [contenteditable="true"], main [contenteditable="true"], main textarea, main [role="textbox"]'
const TRANSCRIPT_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'agent/reasoning'])
const MAX_TRANSCRIPT_EVENTS = 500
const MAX_PROMPT_CHARS = 100_000
const GEMINI_READY_TIMEOUT_MS = 15_000
const GEMINI_TURN_TIMEOUT_MS = 10 * 60_000
const CDP_CONNECT_TIMEOUT_MS = 5_000
const CDP_CALL_TIMEOUT_MS = 15_000
const TURN_POLL_MS = 350
const BACKGROUND_WATCH_MS = 5_000

interface StoredGeminiWebSession {
  sessionId: string
  conversationUrl?: string
  cwd?: string
  title: string
  createdAt: number
  updatedAt: number
  running: boolean
  sequence: number
  transcript: SessionEventEnvelope[]
  seenTurnKeys: string[]
  sentPromptHashes: string[]
  gemRef?: string
}

interface PersistedGeminiWebStore {
  version: 1
  sessions: StoredGeminiWebSession[]
  gemBindings?: Record<string, GeminiGemBinding>
}

interface GeminiDomTurn {
  role: 'user' | 'assistant'
  text: string
}

interface GeminiDomSnapshot {
  url: string
  title: string
  composer: boolean
  busy: boolean
  complete: boolean
  challenge: boolean
  loginRequired: boolean
  turns: GeminiDomTurn[]
}

interface CdpTarget {
  id?: string
  webSocketDebuggerUrl?: string
}

interface CdpResponse {
  id?: number
  result?: {
    result?: { value?: unknown }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }
  error?: { message?: string }
}

interface PendingCdpCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface GeminiWebEngineOptions {
  browser: BrowserController
  workspace: WorkspaceService
  storePath: string
  log?: (line: string) => void
}

/**
 * Gemini Web is a conversation transport, not a second local harness, and it
 * carries no Git contract: chats stay on gemini.google.com in ND's already
 * visible browser pane over the loopback CDP endpoint. An optional per-project
 * Gem binding keeps the chat scoped to the Gem's instructions without requiring
 * any local repo setup.
 */
export class GeminiWebEngine {
  private readonly sessions = new Map<string, StoredGeminiWebSession>()
  private readonly gemBindings = new Map<string, GeminiGemBinding>()
  private readonly activeTurns = new Map<string, AbortController>()
  private onEvent: ((frame: DshEventFrame) => void) | undefined
  private watcherBusy = false
  private readonly watchTimer: ReturnType<typeof setInterval>

  constructor(private readonly options: GeminiWebEngineOptions) {
    this.loadStore()
    this.watchTimer = setInterval(() => { void this.watchTick() }, BACKGROUND_WATCH_MS)
    this.watchTimer.unref?.()
  }

  getGemBinding(workspaceRoot: string): GeminiGemBinding | null {
    const direct = this.gemBindings.get(workspaceRoot)
    if (direct) return direct
    const wsState = this.options.workspace.state()
    const name = wsState.projectName || wsState.name
    if (name && this.gemBindings.has(name)) return this.gemBindings.get(name) ?? null
    return null
  }

  setGemBinding(workspaceRoot: string, input: string): GeminiGemBinding {
    const parsed = parseGeminiGemInput(input)
    if (!parsed) {
      throw new Error('Invalid Gemini Gem link. Please provide a link like https://gemini.google.com/gem/... (or a /gems/view/... or /gems/connect/... URL).')
    }
    const wsState = this.options.workspace.state()
    const projectName = wsState.projectName || wsState.name || 'project'
    const binding: GeminiGemBinding = {
      workspaceRoot,
      ...(wsState.projectId ? { projectId: wsState.projectId } : {}),
      projectName,
      gemRef: parsed.gemRef,
      gemId: parsed.gemId,
      gemUrl: parsed.gemUrl,
      source: 'manual',
      updatedAt: Date.now(),
    }
    this.gemBindings.set(workspaceRoot, binding)
    if (projectName) this.gemBindings.set(projectName, binding)
    this.persistStore()
    return binding
  }

  clearGemBinding(workspaceRoot: string): void {
    this.gemBindings.delete(workspaceRoot)
    const wsState = this.options.workspace.state()
    const name = wsState.projectName || wsState.name
    if (name) this.gemBindings.delete(name)
    this.persistStore()
  }

  /**
   * Gems are optional: an unbound chat simply runs as the user's default
   * Gemini conversation. When the visible browser is already inside a Gem page,
   * auto-bind it so the project keeps the scoped context across sessions.
   */
  async resolveGemBinding(workspaceRoot: string, _signal?: AbortSignal): Promise<GeminiGemBinding | null> {
    const existing = this.getGemBinding(workspaceRoot)
    if (existing) return existing

    const currentUrl = this.options.browser.state().url
    const currentGem = parseGeminiGemInput(currentUrl)
    if (currentGem) {
      const wsState = this.options.workspace.state()
      const projectName = wsState.projectName || wsState.name || 'project'
      const binding: GeminiGemBinding = {
        workspaceRoot,
        ...(wsState.projectId ? { projectId: wsState.projectId } : {}),
        projectName,
        gemRef: currentGem.gemRef,
        gemId: currentGem.gemId,
        gemUrl: currentGem.gemUrl,
        source: 'auto',
        updatedAt: Date.now(),
      }
      this.gemBindings.set(workspaceRoot, binding)
      this.gemBindings.set(projectName, binding)
      this.persistStore()
      return binding
    }
    return null
  }

  setEmitter(emit: (frame: DshEventFrame) => void): void {
    this.onEvent = emit
  }

  ownsSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  handlesApproval(_rpcId: string): boolean {
    return false
  }

  async respond(rpcId: string, _value: unknown): Promise<void> {
    throw new Error(`Unknown ${GEMINI_WEB_ENGINE_ID} approval: ${rpcId}`)
  }

  listSessions(): EngineSessionSummary[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => ({
        sessionId: session.sessionId,
        engineId: GEMINI_WEB_ENGINE_ID,
        title: session.title,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        running: session.running,
      }))
  }

  transcript(sessionId: string): EngineSessionTranscript {
    const session = this.requireSession(sessionId)
    return { sessionId, engineId: GEMINI_WEB_ENGINE_ID, events: [...session.transcript] }
  }

  async createSession(input: { cwd?: string } = {}): Promise<{ sessionId: string }> {
    const sessionId = `gemini-web-${randomUUID()}`
    const now = Date.now()
    const session: StoredGeminiWebSession = {
      sessionId,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      title: 'New Gemini Web chat',
      createdAt: now,
      updatedAt: now,
      running: false,
      sequence: 0,
      transcript: [],
      seenTurnKeys: [],
      sentPromptHashes: [],
    }
    this.sessions.set(sessionId, session)
    this.persistStore()
    this.emitFrame({ kind: 'session-added', sessionId, meta: { engineId: GEMINI_WEB_ENGINE_ID } })
    return { sessionId }
  }

  async run(prompt: string, input: { sessionId?: string; cwd?: string } = {}): Promise<{ sessionId: string }> {
    const cleaned = prompt.trim()
    if (!cleaned) throw new Error('Prompt cannot be empty')
    if (cleaned.length > MAX_PROMPT_CHARS) throw new Error(`Prompt exceeds the ${MAX_PROMPT_CHARS.toLocaleString()} character limit`)

    let session = input.sessionId === undefined ? undefined : this.sessions.get(input.sessionId)
    if (input.sessionId !== undefined && !session) throw new Error(`Unknown ${GEMINI_WEB_ENGINE_ID} session: ${input.sessionId}`)
    if (!session) {
      const created = await this.createSession({ cwd: input.cwd ?? this.options.workspace.state().root })
      session = this.sessions.get(created.sessionId)
    }
    if (!session) throw new Error(`${GEMINI_WEB_ENGINE_ID} session could not be created`)
    if (session.running) throw new Error('This Gemini Web chat already has an active turn')
    if ([...this.sessions.values()].some((candidate) => candidate.running && candidate.sessionId !== session.sessionId)) {
      throw new Error('Gemini Web uses ND\'s single visible browser pane. Finish the active Gemini Web turn before starting another one.')
    }

    session.cwd = input.cwd ?? session.cwd ?? this.options.workspace.state().root
    const abort = new AbortController()
    this.activeTurns.set(session.sessionId, abort)
    session.running = true
    session.updatedAt = Date.now()
    this.persistStore()
    this.emitFrame({ kind: 'session-status', sessionId: session.sessionId, running: true })

    try {
      const cdp = await this.openBoundConversation(session, abort.signal)
      try {
        assertTurnActive(abort.signal)
        const before = await this.captureSnapshot(cdp)
        assertTurnActive(abort.signal)
        this.importUnseenTurns(session, before)
        const baselineAssistantCount = before.turns.filter((turn) => turn.role === 'assistant').length
        assertTurnActive(abort.signal)
        await this.submitPrompt(cdp, cleaned, abort.signal)
        this.recordUserMessage(session, cleaned)
        this.rememberSentPrompt(session, cleaned)
        if (session.title === 'New Gemini Web chat') session.title = cleaned.slice(0, 80)
        const completed = await this.waitForAssistant(cdp, session, baselineAssistantCount, abort.signal)
        this.captureConversationUrl(session, completed.url)
        const assistant = [...completed.turns].reverse().find((turn) => turn.role === 'assistant')
        if (!assistant?.text.trim()) throw new Error('Gemini Web completed without a readable assistant message')
        this.recordAssistantMessage(session, assistant.text.trim())
        this.markAllTurnsSeen(session, completed)
        return { sessionId: session.sessionId }
      } finally {
        cdp.close()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emitFrame({ kind: 'agent-error', sessionId: session.sessionId, message })
      throw error
    } finally {
      this.activeTurns.delete(session.sessionId)
      session.running = false
      session.updatedAt = Date.now()
      this.persistStore()
      this.emitFrame({ kind: 'session-status', sessionId: session.sessionId, running: false })
    }
  }

  async stop(sessionId?: string): Promise<void> {
    const targets = sessionId === undefined
      ? [...this.sessions.values()].filter((session) => session.running)
      : [this.sessions.get(sessionId)].filter((session): session is StoredGeminiWebSession => session?.running === true)
    for (const session of targets) {
      this.activeTurns.get(session.sessionId)?.abort()
      if (!this.browserMayHostSession(session)) continue
      try {
        const cdp = await VisibleCdpConnection.connect(this.options.browser)
        try {
          await cdp.evaluate<boolean>(`(() => { const button = Array.from(document.querySelectorAll('button')).find(el => /^stop(?:\\b|$)/i.test(el.getAttribute('aria-label') || '') || el.getAttribute('data-test-id') === 'stop-button'); if (!(button instanceof HTMLElement)) return false; button.click(); return true })()`)
        } finally {
          cdp.close()
        }
      } catch {
        // Local cancellation remains authoritative even when the page changed.
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.watchTimer)
    for (const controller of this.activeTurns.values()) controller.abort()
    this.activeTurns.clear()
    for (const session of this.sessions.values()) session.running = false
    this.persistStore()
  }

  private async openBoundConversation(session: StoredGeminiWebSession, signal: AbortSignal): Promise<VisibleCdpConnection> {
    assertTurnActive(signal)
    const binding = await this.resolveGemBinding(session.cwd ?? this.options.workspace.state().root, signal)
    if (binding) session.gemRef = binding.gemRef

    const targetUrl = binding?.gemUrl
      ?? (session.conversationUrl && isGeminiConversationUrl(session.conversationUrl) ? session.conversationUrl : GEMINI_HOME_URL)
    const currentUrl = this.options.browser.state().url
    if (!sameGeminiUrl(currentUrl, targetUrl)) await this.options.browser.navigate(targetUrl)
    assertTurnActive(signal)
    await this.options.browser.ensureAgentReady()
    assertTurnActive(signal)
    const cdp = await VisibleCdpConnection.connect(this.options.browser)
    try {
      const deadline = Date.now() + GEMINI_READY_TIMEOUT_MS
      while (Date.now() < deadline) {
        assertTurnActive(signal)
        const snapshot = await this.captureSnapshot(cdp)
        assertTurnActive(signal)
        if (snapshot.challenge) throw new Error('Google is showing a verification challenge in ND\'s Browser pane. Complete the challenge (or sign in to gemini.google.com) and resend this message.')
        if (snapshot.loginRequired) throw new Error('Gemini Web needs you signed in to gemini.google.com in ND\'s visible Browser pane. Sign in there, then resend this message.')
        if (snapshot.composer) return cdp
        await cdp.evaluate<boolean>(`(() => {
          const btn = Array.from(document.querySelectorAll('button, a')).find(el => {
            const text = el.innerText?.trim() || '';
            return text.includes('New chat') || text.includes('Start a new chat') || text.includes('New conversation');
          });
          if (btn instanceof HTMLElement) { btn.click(); return true; }
          return false;
        })()`).catch(() => false)
        await sleep(250)
      }
      throw new Error('Gemini Web is open in ND\'s visible Browser pane, but the composer is unavailable. Sign in to gemini.google.com and confirm the page is interactive, then resend this message.')
    } catch (error) {
      cdp.close()
      throw error
    }
  }

  private async submitPrompt(cdp: VisibleCdpConnection, prompt: string, signal: AbortSignal): Promise<void> {
    assertTurnActive(signal)
    const source = JSON.stringify(prompt)
    const result = await cdp.evaluate<{ ok: boolean; reason?: string }>(`(async () => {
      const composerSelector = ${JSON.stringify(GEMINI_COMPOSER_SELECTOR)};
      const composer = document.querySelector(composerSelector);
      if (!(composer instanceof HTMLElement)) return { ok: false, reason: 'composer-missing' };
      const text = ${source};
      composer.focus();
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter?.call(composer, text);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.execCommand('delete');
        if (!document.execCommand('insertText', false, text)) composer.textContent = text;
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
      return { ok: true };
    })()`)
    if (!result?.ok) throw new Error('Gemini Web composer is unavailable.')
    for (let index = 0; index < 50; index += 1) {
      assertTurnActive(signal)
      const sent = await cdp.evaluate<boolean>(`(() => {
        const composer = document.querySelector(${JSON.stringify(GEMINI_COMPOSER_SELECTOR)});
        const form = composer?.closest('form');
        const button = form?.querySelector('button[aria-label*="Send" i], button[type="submit"]')
          ?? document.querySelector('button[aria-label*="Send message" i], button[aria-label*="Send" i]');
        if (button instanceof HTMLButtonElement && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
          button.click();
          return true;
        }
        return false;
      })()`)
      if (sent) return
      await sleep(100)
    }
    assertTurnActive(signal)
    throw new Error('Gemini Web could not send the message (send-button-unavailable). Reload Gemini and retry.')
  }

  private async waitForAssistant(
    cdp: VisibleCdpConnection,
    session: StoredGeminiWebSession,
    baselineAssistantCount: number,
    signal: AbortSignal,
  ): Promise<GeminiDomSnapshot> {
    const deadline = Date.now() + GEMINI_TURN_TIMEOUT_MS
    let stableText = ''
    let stableCount = 0
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('Gemini Web turn was stopped.')
      const snapshot = await this.captureSnapshot(cdp)
      this.captureConversationUrl(session, snapshot.url)
      const assistants = snapshot.turns.filter((turn) => turn.role === 'assistant')
      const latest = assistants.at(-1)?.text.trim() ?? ''
      if (assistants.length > baselineAssistantCount && latest) {
        if (latest === stableText) stableCount += 1
        else {
          stableText = latest
          stableCount = 0
        }
        if ((snapshot.complete || (!snapshot.busy && stableCount >= 2)) && !snapshot.busy) return snapshot
      }
      await sleep(TURN_POLL_MS)
    }
    throw new Error('Gemini Web turn exceeded the 10 minute completion deadline.')
  }

  private async captureSnapshot(cdp: VisibleCdpConnection): Promise<GeminiDomSnapshot> {
    return cdp.evaluate<GeminiDomSnapshot>(`(() => {
      ${GEMINI_DOM_TURNS_SCRIPT}
      const composerSelector = ${JSON.stringify(GEMINI_COMPOSER_SELECTOR)};
      const domTurns = readGeminiDomTurns();
      const turns = [];
      for (const { root, role } of domTurns) {
        const text = root instanceof HTMLElement ? root.innerText.trim() : '';
        if (text) turns.push({ role, text });
      }
      const lastAssistant = domTurns.filter(turn => turn.role === 'assistant').at(-1);
      const stopButton = Array.from(document.querySelectorAll('button')).find(el => /^stop(?:\\b|$)/i.test(el.getAttribute('aria-label') || '') || el.getAttribute('data-test-id') === 'stop-button');
      return {
        url: location.href,
        title: document.title,
        composer: document.querySelector(composerSelector) !== null,
        busy: stopButton !== undefined || document.querySelector('[data-is-streaming="true"], [data-is-generating="true"]') !== null,
        complete: lastAssistant?.complete === true,
        challenge: location.hostname === 'consent.google.com' || location.pathname.includes('/sorry/') || /verify you are human|checking your browser|just a moment/i.test(document.title),
        loginRequired: location.hostname === 'accounts.google.com' || location.pathname.includes('/auth/'),
        turns,
      };
    })()`)
  }

  private importUnseenTurns(session: StoredGeminiWebSession, snapshot: GeminiDomSnapshot): void {
    // Browser-originated turns may still be streaming even when ND has no
    // active turn. Import only settled snapshots, never partial reply text.
    if (snapshot.busy) return
    const seen = new Set(session.seenTurnKeys)
    const sent = new Set(session.sentPromptHashes)
    let changed = false
    snapshot.turns.forEach((turn, index) => {
      const key = domTurnKey(turn, index)
      if (seen.has(key)) return
      if (turn.role === 'user' && sent.has(hashText(turn.text))) {
        seen.add(key)
        changed = true
        return
      }
      if (turn.role === 'user') this.recordUserMessage(session, turn.text)
      else this.recordAssistantMessage(session, turn.text)
      seen.add(key)
      changed = true
    })
    if (changed) {
      session.seenTurnKeys = trimArray([...seen], 500)
      this.captureConversationUrl(session, snapshot.url)
      this.persistStore()
    }
  }

  private markAllTurnsSeen(session: StoredGeminiWebSession, snapshot: GeminiDomSnapshot): void {
    session.seenTurnKeys = trimArray(snapshot.turns.map((turn, index) => domTurnKey(turn, index)), 500)
    this.persistStore()
  }

  private rememberSentPrompt(session: StoredGeminiWebSession, prompt: string): void {
    session.sentPromptHashes = trimArray([...session.sentPromptHashes, hashText(prompt)], 100)
    this.persistStore()
  }

  private captureConversationUrl(session: StoredGeminiWebSession, url: string): void {
    if (!isGeminiConversationUrl(url)) return
    const parsed = parseGeminiConversationUrl(url)
    if (parsed?.gemId) session.gemRef = parsed.gemId
    if (session.conversationUrl === url) return
    session.conversationUrl = url
    this.persistStore()
  }

  private async watchTick(): Promise<void> {
    if (this.watcherBusy) return
    this.watcherBusy = true
    try {
      const currentUrl = this.options.browser.state().url
      const visibleSession = [...this.sessions.values()].find((session) => session.conversationUrl !== undefined && sameGeminiUrl(currentUrl, session.conversationUrl))
      if (visibleSession && !visibleSession.running) {
        try {
          const cdp = await VisibleCdpConnection.connect(this.options.browser)
          try {
            this.importUnseenTurns(visibleSession, await this.captureSnapshot(cdp))
          } finally {
            cdp.close()
          }
        } catch (error) {
          this.options.log?.(`[gemini-web] visible conversation sync skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } finally {
      this.watcherBusy = false
    }
  }

  private recordUserMessage(session: StoredGeminiWebSession, text: string): void {
    this.recordEnvelope(session, {
      type: 'user/message',
      data: { message: { role: 'user', content: [{ type: 'text', text }] } },
    })
  }

  private recordAssistantMessage(session: StoredGeminiWebSession, text: string): void {
    this.recordEnvelope(session, {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
    })
  }

  private recordEnvelope(session: StoredGeminiWebSession, partial: { type: string; data?: unknown }): void {
    session.sequence += 1
    session.updatedAt = Date.now()
    const envelope: SessionEventEnvelope = {
      type: partial.type,
      seq: session.sequence,
      time: session.updatedAt,
      ...(partial.data === undefined ? {} : { data: partial.data }),
    }
    if (TRANSCRIPT_EVENT_TYPES.has(envelope.type)) {
      session.transcript.push(envelope)
      if (session.transcript.length > MAX_TRANSCRIPT_EVENTS) session.transcript.splice(0, session.transcript.length - MAX_TRANSCRIPT_EVENTS)
    }
    this.persistStore()
    this.emitFrame({ kind: 'session-event', sessionId: session.sessionId, event: envelope })
  }

  private requireSession(sessionId: string): StoredGeminiWebSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown ${GEMINI_WEB_ENGINE_ID} session: ${sessionId}`)
    return session
  }

  private browserMayHostSession(session: StoredGeminiWebSession): boolean {
    const currentUrl = this.options.browser.state().url
    if (!isGeminiPageUrl(currentUrl)) return false
    return session.conversationUrl === undefined || sameGeminiUrl(currentUrl, session.conversationUrl)
  }

  private emitFrame(frame: DshEventFrame): void {
    this.onEvent?.(frame)
  }

  private loadStore(): void {
    if (!existsSync(this.options.storePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.options.storePath, 'utf8')) as Partial<PersistedGeminiWebStore>
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return
      for (const candidate of parsed.sessions) {
        if (!candidate || typeof candidate !== 'object') continue
        const session = candidate as StoredGeminiWebSession
        if (typeof session.sessionId !== 'string' || !session.sessionId.startsWith('gemini-web-')) continue
        if (typeof session.conversationUrl !== 'string' || !isGeminiConversationUrl(session.conversationUrl)) delete session.conversationUrl
        session.running = false
        session.transcript = Array.isArray(session.transcript) ? session.transcript.slice(-MAX_TRANSCRIPT_EVENTS) : []
        session.seenTurnKeys = Array.isArray(session.seenTurnKeys) ? session.seenTurnKeys.slice(-500) : []
        session.sentPromptHashes = Array.isArray(session.sentPromptHashes) ? session.sentPromptHashes.slice(-100) : []
        session.sequence = Number.isSafeInteger(session.sequence) ? session.sequence : session.transcript.at(-1)?.seq ?? 0
        if (typeof session.gemRef !== 'string') delete session.gemRef
        this.sessions.set(session.sessionId, session)
      }
      if (parsed.gemBindings && typeof parsed.gemBindings === 'object') {
        for (const [key, binding] of Object.entries(parsed.gemBindings)) {
          if (binding && typeof binding === 'object' && typeof binding.gemRef === 'string') {
            this.gemBindings.set(key, binding)
          }
        }
      }
    } catch (error) {
      this.options.log?.(`[gemini-web] ignoring unreadable session store: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private persistStore(): void {
    const directory = dirname(this.options.storePath)
    mkdirSync(directory, { recursive: true })
    const tmp = `${this.options.storePath}.${process.pid}.${randomUUID()}.tmp`
    const bindingsObj: Record<string, GeminiGemBinding> = {}
    for (const [key, val] of this.gemBindings.entries()) {
      bindingsObj[key] = val
    }
    const payload: PersistedGeminiWebStore = {
      version: 1,
      sessions: [...this.sessions.values()],
      gemBindings: bindingsObj,
    }
    try {
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.options.storePath)
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
    }
  }
}

class VisibleCdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, PendingCdpCall>()

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event) => {
      let parsed: CdpResponse
      try { parsed = JSON.parse(String(event.data)) as CdpResponse } catch { return }
      if (parsed.id === undefined) return
      const pending = this.pending.get(parsed.id)
      if (!pending) return
      this.pending.delete(parsed.id)
      clearTimeout(pending.timer)
      if (parsed.error?.message) {
        pending.reject(new Error(parsed.error.message))
        return
      }
      const exception = parsed.result?.exceptionDetails
      if (exception) {
        pending.reject(new Error(exception.exception?.description ?? exception.text ?? 'CDP Runtime.evaluate failed'))
        return
      }
      pending.resolve(parsed.result?.result?.value)
    }
    socket.onclose = () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('Visible browser CDP connection closed'))
      }
      this.pending.clear()
    }
  }

  static async connect(browser: BrowserController): Promise<VisibleCdpConnection> {
    await browser.ensureAgentReady()
    const state = browser.state()
    if (!state.targetId) throw new Error('ND visible browser has no CDP target id')
    const response = await fetch(`http://127.0.0.1:${state.cdpPort}/json/list`, { signal: AbortSignal.timeout(CDP_CONNECT_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`ND visible browser CDP target list failed (${response.status})`)
    const targets = await response.json() as CdpTarget[]
    const target = targets.find((candidate) => candidate.id === state.targetId)
    if (!target?.webSocketDebuggerUrl) throw new Error('ND visible browser target is not available through loopback CDP')
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { socket.close() } catch { /* not open yet */ }
        reject(new Error('Timed out connecting to ND visible browser CDP'))
      }, CDP_CONNECT_TIMEOUT_MS)
      socket.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error('Could not connect to ND visible browser CDP'))
      }
    })
    return new VisibleCdpConnection(socket)
  }

  async evaluate<T>(expression: string): Promise<T> {
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Visible browser CDP call timed out after ${CDP_CALL_TIMEOUT_MS}ms`))
      }, CDP_CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
    })
    try {
      this.socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        },
      }))
    } catch (error) {
      const pending = this.pending.get(id)
      if (pending) clearTimeout(pending.timer)
      this.pending.delete(id)
      throw error
    }
    return await promise as T
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Visible browser CDP connection closed'))
    }
    this.pending.clear()
    try { this.socket.close() } catch { /* already closed */ }
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value.trim()).digest('hex')
}

function domTurnKey(turn: GeminiDomTurn, index: number): string {
  return `${index}:${turn.role}:${hashText(turn.text)}`
}

function trimArray<T>(values: T[], limit: number): T[] {
  return values.length <= limit ? values : values.slice(values.length - limit)
}

function assertTurnActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Gemini Web turn was stopped.')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
