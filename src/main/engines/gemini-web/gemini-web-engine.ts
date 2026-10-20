import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  DshEventFrame,
  EngineSessionSummary,
  EngineSessionTranscript,
  GeminiGemBinding,
  HarnessRunImage,
  SessionEventEnvelope,
} from '../../../shared/contracts.js'
import { GEMINI_WEB_ENGINE_ID } from '../../../shared/coding-engines.js'
import {
  DEFAULT_WEB_BROWSER_MODE_SETTINGS,
  normalizeWebBrowserModeSettings,
  type WebBrowserModeSettings,
  type WebBrowserTransport,
} from '../../../shared/browser-modes.js'
import { stripWorkspaceContext } from '../../../shared/workspace-context.js'
import type { BrowserController } from '../../browser/browser-controller.js'
import { GEMINI_DOM_TURNS_SCRIPT } from '../../browser/gemini-dom-turns.js'
import {
  BrowserAgentRunner,
  findCloseAttachmentElements,
  findComposerElement,
  findNewChatElement,
  findSendButtonElement,
} from '../../browser/browser-agent.js'
import { ElectronPageDriver, PageGuardError, type PageDriver } from '../../browser/page-driver.js'
import { VisibleCdpConnection } from '../../browser/visible-cdp-connection.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import { discardWebImages, stageWebImages, type StagedWebImages } from '../web-attachments.js'
import {
  canSwitchTransport,
  planWebTransports,
  WebTurnError,
  WebTurnProgress,
  type WebTransportAvailability,
} from '../web-turn.js'
import {
  isGeminiConversationUrl,
  isGeminiPageUrl,
  parseGeminiConversationUrl,
  parseGeminiSkillLinkInput,
  sameGeminiUrl,
} from './gemini-project-binding.js'

const GEMINI_HOME_URL = 'https://gemini.google.com/app'
const GEMINI_ORIGIN = 'https://gemini.google.com'
const GEMINI_ORIGINS = [GEMINI_ORIGIN] as const

// Gemini's composer is a contenteditable editor inside <rich-textarea>/main.
const GEMINI_COMPOSER_SELECTOR = 'main rich-textarea [contenteditable="true"], main [contenteditable="true"], main textarea, main [role="textbox"]'
// The uploader mounts its hidden inputs when the tools menu is first opened.
const GEMINI_IMAGE_INPUT_SELECTOR = 'input[type="file"][accept*="image"]'
const TRANSCRIPT_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'agent/reasoning'])
const MAX_TRANSCRIPT_EVENTS = 500
const MAX_PROMPT_CHARS = 100_000
const GEMINI_READY_TIMEOUT_MS = 15_000
const GEMINI_TURN_TIMEOUT_MS = 10 * 60_000
const ATTACHMENT_TIMEOUT_MS = 30_000
const ATTACHMENT_POLL_MS = 250
const ATTACHMENT_SEND_GRACE_MS = 60_000
const SUBMIT_CONFIRM_POLL_MS = 150
const SUBMIT_CONFIRM_TIMEOUT_MS = 6_000
const GEMINI_ATTACHMENT_STATE_SCRIPT = `(() => {
  const tiles = Array.from(document.querySelectorAll('.gem-attachment-tile'));
  const settled = tiles.filter((el) => el.querySelector('img')
    && !el.querySelector('.gem-attachment-loading-container, .gem-attachment-content.loading, mat-spinner, [role="progressbar"]'));
  const errors = document.querySelectorAll('uploader-file-preview-container.has-error, .gem-attachment-loading-error').length;
  return { count: settled.length, errors, uploading: tiles.length > settled.length || /uploading image/i.test(document.body.innerText) };
})()`
const TURN_POLL_MS = 350
const BACKGROUND_WATCH_MS = 5_000
// Gemini's DOM echo of an image-only user turn is just the uploaded preview;
// it no longer contains the prompt text, so a text-hash match cannot see it.
const IMAGE_ECHO_PATTERN = /^(?:\s*!\[[^\]]*\]\([^)]*\)\s*)+$/

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
  uncertainPromptHashes?: string[]
  gemRef?: string
}

interface PersistedGeminiWebStore {
  version: 1
  sessions: StoredGeminiWebSession[]
  gemBindings?: Record<string, GeminiGemBinding>
  modeSettings?: WebBrowserModeSettings
}

interface ActiveGeminiTurn {
  controller: AbortController
  progress?: WebTurnProgress | undefined
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
  pendingSend: boolean
  challenge: boolean
  loginRequired: boolean
  rateLimited: boolean
  turns: GeminiDomTurn[]
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
 * visible browser pane.
 *
 * Supports four interaction modes:
 * - auto (default): plans Extension -> CDP -> Browser Agent (opt-in), falling back only before submission.
 * - extension: content-script style isolated-world DOM integration inside ND's tab.
 * - cdp: loopback Chrome DevTools Protocol against the pinned tab.
 * - browser-agent: structured Observe -> Act -> Verify loop over semantic elements.
 */
export class GeminiWebEngine {
  private readonly sessions = new Map<string, StoredGeminiWebSession>()
  private readonly gemBindings = new Map<string, GeminiGemBinding>()
  private readonly activeTurns = new Map<string, ActiveGeminiTurn>()
  private modeSettings: WebBrowserModeSettings = { ...DEFAULT_WEB_BROWSER_MODE_SETTINGS }
  private onEvent: ((frame: DshEventFrame) => void) | undefined
  private watcherBusy = false
  private readonly watchTimer: ReturnType<typeof setInterval>

  constructor(private readonly options: GeminiWebEngineOptions) {
    this.loadStore()
    this.watchTimer = setInterval(() => { void this.watchTick() }, BACKGROUND_WATCH_MS)
    this.watchTimer.unref?.()
  }

  getModeSettings(): WebBrowserModeSettings {
    return { ...this.modeSettings }
  }

  setModeSettings(settings: Partial<WebBrowserModeSettings>): WebBrowserModeSettings {
    this.modeSettings = normalizeWebBrowserModeSettings({ ...this.modeSettings, ...settings })
    this.persistStore()
    return { ...this.modeSettings }
  }

  getGemBinding(workspaceRoot: string): GeminiGemBinding | null {
    const direct = this.gemBindings.get(workspaceRoot)
    if (direct) return direct
    return null
  }

  setGemBinding(workspaceRoot: string, input: string): GeminiGemBinding {
    const parsed = parseGeminiSkillLinkInput(input)
    if (!parsed) {
      throw new Error('Invalid Gemini chat link. Use a link like https://gemini.google.com/app/fa5b05f3a25f7f76.')
    }
    const wsState = this.options.workspace.state()
    const projectName = (wsState.root === workspaceRoot ? (wsState.projectName || wsState.name) : undefined) || 'project'
    const binding: GeminiGemBinding = {
      workspaceRoot,
      ...(wsState.root === workspaceRoot && wsState.projectId ? { projectId: wsState.projectId } : {}),
      projectName,
      gemRef: parsed.gemRef,
      gemId: parsed.gemId,
      gemUrl: parsed.gemUrl,
      source: 'manual',
      updatedAt: Date.now(),
    }
    this.gemBindings.set(workspaceRoot, binding)
    this.persistStore()
    return binding
  }

  clearGemBinding(workspaceRoot: string): void {
    this.gemBindings.delete(workspaceRoot)
    for (const [key, b] of this.gemBindings.entries()) {
      if (b.workspaceRoot === workspaceRoot) this.gemBindings.delete(key)
    }
    this.persistStore()
  }

  /**
   * Gems are optional: an unbound chat simply runs as the user's default
   * Gemini conversation. When the visible browser is already inside a Gem page,
   * auto-bind it so the project keeps the scoped context across sessions.
   * Never auto-bind if the current URL is already owned by an existing chat session.
   */
  async resolveGemBinding(workspaceRoot: string, _signal?: AbortSignal): Promise<GeminiGemBinding | null> {
    const existing = this.getGemBinding(workspaceRoot)
    if (existing) return existing

    const currentUrl = this.options.browser.state().url
    const currentChat = parseGeminiSkillLinkInput(currentUrl)
    const isSessionUrl = [...this.sessions.values()].some((s) => s.conversationUrl && sameGeminiUrl(currentUrl, s.conversationUrl))
    if (currentChat && !isSessionUrl) {
      const wsState = this.options.workspace.state()
      const projectName = (wsState.root === workspaceRoot ? (wsState.projectName || wsState.name) : undefined) || 'project'
      const binding: GeminiGemBinding = {
        workspaceRoot,
        ...(wsState.root === workspaceRoot && wsState.projectId ? { projectId: wsState.projectId } : {}),
        projectName,
        gemRef: currentChat.gemRef,
        gemId: currentChat.gemId,
        gemUrl: currentChat.gemUrl,
        source: 'auto',
        updatedAt: Date.now(),
      }
      this.gemBindings.set(workspaceRoot, binding)
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

  async run(prompt: string, input: { sessionId?: string; cwd?: string; images?: HarnessRunImage[] } = {}): Promise<{ sessionId: string }> {
    const cleaned = stripWorkspaceContext(prompt).trim()
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

    const hasImages = (input.images?.length ?? 0) > 0
    const availableTransports: WebTransportAvailability = {
      extension: true,
      cdp: Boolean(this.options.browser.state().cdpPort),
      browserAgent: true,
    }
    const plan = planWebTransports({
      settings: this.modeSettings,
      hasImages,
      available: availableTransports,
    })
    if (plan.transports.length === 0) {
      const reason = plan.skipped.map((s) => `${s.transport}: ${s.reason}`).join(', ')
      throw new Error(`No browser transport available for mode "${this.modeSettings.mode}" (${reason || 'unavailable'})`)
    }

    session.cwd = input.cwd ?? session.cwd ?? this.options.workspace.state().root
    const abort = new AbortController()
    const activeTurn: ActiveGeminiTurn = { controller: abort }
    this.activeTurns.set(session.sessionId, activeTurn)
    session.running = true
    session.updatedAt = Date.now()
    this.persistStore()
    this.emitFrame({ kind: 'session-status', sessionId: session.sessionId, running: true })

    try {
      let lastError: unknown
      for (let i = 0; i < plan.transports.length; i += 1) {
        const transport = plan.transports[i]!
        const progress = new WebTurnProgress(transport)
        activeTurn.progress = progress
        try {
          if (transport === 'browser-agent') {
            return await this.runWithBrowserAgent(session, cleaned, input.images, abort.signal, progress)
          }
          return await this.runWithPageDriver(transport, session, cleaned, input.images, abort.signal, progress)
        } catch (error) {
          lastError = error
          const turnError = this.classifyTurnError(progress, error)
          if (turnError.submission === 'uncertain') {
            session.uncertainPromptHashes = trimArray([...(session.uncertainPromptHashes ?? []), hashText(cleaned)], 50)
            this.persistStore()
          }
          if (i < plan.transports.length - 1 && canSwitchTransport(turnError)) {
            this.options.log?.(`[gemini-web] ${transport} failed (${turnError.message}); falling back to ${plan.transports[i + 1]}`)
            continue
          }
          throw turnError
        }
      }
      throw lastError ?? new Error('No browser transport succeeded')
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
      const activeTurn = this.activeTurns.get(session.sessionId)
      activeTurn?.controller.abort()
      // Clicking the page's Stop before ND submitted anything could cancel an
      // unrelated reply the user started in the pane themselves.
      if (!activeTurn?.progress || activeTurn.progress.submission === 'none') continue
      if (!this.browserMayHostSession(session)) continue
      try {
        const tabId = this.options.browser.activeTabId()
        const driver = new ElectronPageDriver(this.options.browser, tabId, GEMINI_ORIGINS)
        try {
          await driver.evaluate<boolean>(`(() => {
            const button = Array.from(document.querySelectorAll('button')).find(el => /^stop(?:\\b|$)/i.test(el.getAttribute('aria-label') || '') || el.getAttribute('data-test-id') === 'stop-button');
            if (!(button instanceof HTMLElement)) return false;
            button.click();
            return true;
          })()`)
        } finally {
          driver.close()
        }
      } catch {
        // Local cancellation remains authoritative even when the page changed.
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.watchTimer)
    for (const activeTurn of this.activeTurns.values()) activeTurn.controller.abort()
    this.activeTurns.clear()
    for (const session of this.sessions.values()) session.running = false
    this.persistStore()
  }

  private async openBoundConversation(
    session: StoredGeminiWebSession,
    signal: AbortSignal,
    transport: WebBrowserTransport = 'cdp',
  ): Promise<PageDriver> {
    assertTurnActive(signal)
    const binding = await this.resolveGemBinding(session.cwd ?? this.options.workspace.state().root, signal)
    if (binding) session.gemRef = binding.gemRef

    const targetUrl = (session.conversationUrl && isGeminiConversationUrl(session.conversationUrl))
      ? session.conversationUrl
      : (binding?.gemUrl ?? GEMINI_HOME_URL)

    const currentUrl = typeof this.options.browser?.state === 'function' ? this.options.browser.state()?.url ?? '' : ''
    if (!sameGeminiUrl(currentUrl, targetUrl)) await this.options.browser.navigate(targetUrl)
    assertTurnActive(signal)
    await this.options.browser.ensureAgentReady()
    assertTurnActive(signal)

    const tabId = typeof this.options.browser?.activeTabId === 'function' ? this.options.browser.activeTabId() : 'active'
    const targetId = typeof this.options.browser?.state === 'function' ? this.options.browser.state()?.targetId : undefined
    const driver: PageDriver = transport === 'extension'
      ? new ElectronPageDriver(this.options.browser, tabId, GEMINI_ORIGINS)
      : await VisibleCdpConnection.connect(this.options.browser, { targetId, allowedOrigins: GEMINI_ORIGINS })

    try {
      const deadline = Date.now() + GEMINI_READY_TIMEOUT_MS
      while (Date.now() < deadline) {
        assertTurnActive(signal)
        const snapshot = await this.captureSnapshot(driver)
        assertTurnActive(signal)
        if (snapshot.challenge) throw new WebTurnError({ code: 'challenge', message: "Google is showing a verification challenge in ND's Browser pane. Complete the challenge (or sign in to gemini.google.com) and resend this message.", phase: 'open' })
        if (snapshot.loginRequired) throw new WebTurnError({ code: 'login-required', message: "Gemini Web needs you signed in to gemini.google.com in ND's visible Browser pane. Sign in there, then resend this message.", phase: 'open' })
        if (snapshot.rateLimited) throw new WebTurnError({ code: 'rate-limited', message: 'Gemini has rate limited requests. Please wait a few moments and try again.', phase: 'open' })
        if (snapshot.composer) return driver
        await driver.evaluate<boolean>(`(() => {
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
      driver.close()
      throw error
    }
  }

  private async runWithPageDriver(
    transport: WebBrowserTransport,
    session: StoredGeminiWebSession,
    cleanedPrompt: string,
    images: readonly HarnessRunImage[] | undefined,
    signal: AbortSignal,
    progress: WebTurnProgress,
  ): Promise<{ sessionId: string }> {
    progress.enter('open')
    const driver = await this.openBoundConversation(session, signal, transport)
    let stagedImages: StagedWebImages | undefined
    try {
      assertTurnActive(signal)
      progress.enter('observe')
      const before = await this.captureSnapshot(driver)
      assertTurnActive(signal)
      if (before.loginRequired) {
        throw new WebTurnError({
          code: 'login-required',
          message: "Gemini Web needs you signed in to gemini.google.com in ND's visible Browser pane. Sign in there, then resend this message.",
          phase: 'observe',
        })
      }
      if (before.challenge) {
        throw new WebTurnError({
          code: 'challenge',
          message: "Google is showing a verification challenge in ND's Browser pane. Complete the challenge (or sign in to gemini.google.com) and resend this message.",
          phase: 'observe',
        })
      }
      if (before.rateLimited) {
        throw new WebTurnError({
          code: 'rate-limited',
          message: 'Gemini has rate limited requests. Please wait a few moments and try again.',
          phase: 'observe',
        })
      }
      // Duplicate prevention: if this exact prompt was already submitted in the page
      // (e.g. from an uncertain retry), adopt it instead of typing and submitting again!
      const lastUserIndex = before.turns.map((t) => t.role).lastIndexOf('user')
      const lastUserTurn = lastUserIndex >= 0 ? before.turns[lastUserIndex] : undefined
      const alreadyInDom = lastUserTurn && lastUserTurn.text.trim() === cleanedPrompt
      const isUncertain = session.uncertainPromptHashes?.includes(hashText(cleanedPrompt))

      let baselineAssistantCount = before.turns.filter((turn) => turn.role === 'assistant').length

      if (alreadyInDom && isUncertain) {
        progress.submission = 'confirmed'
        session.uncertainPromptHashes = (session.uncertainPromptHashes ?? []).filter((h) => h !== hashText(cleanedPrompt))
        this.rememberSentPrompt(session, cleanedPrompt)
        baselineAssistantCount = before.turns.slice(0, lastUserIndex).filter((turn) => turn.role === 'assistant').length

        // Only import background turns that occurred BEFORE the adopted prompt
        const priorSnapshot: GeminiDomSnapshot = {
          ...before,
          turns: before.turns.slice(0, lastUserIndex),
        }
        this.importUnseenTurns(session, priorSnapshot)

        const hasUserTurnInTranscript = [...session.transcript].reverse().some(
          (e) => e.type === 'user/message' && (e.data as { message?: { content?: Array<{ text?: string }> } })?.message?.content?.[0]?.text?.trim() === cleanedPrompt,
        )
        if (!hasUserTurnInTranscript) {
          this.recordUserMessage(session, cleanedPrompt, images)
        }
      } else {
        if (before.busy || before.pendingSend) throw this.pageBusyError()
        this.importUnseenTurns(session, before)
        assertTurnActive(signal)
        await this.clearStaleAttachments(driver)

        if ((images?.length ?? 0) > 0) {
          progress.enter('attach')
          assertTurnActive(signal)
          stagedImages = await this.attachImages(driver, images ?? [], signal)
        }

        assertTurnActive(signal)
        progress.enter('compose')
        await this.submitPrompt(driver, cleanedPrompt, signal, progress)
        this.recordUserMessage(session, cleanedPrompt, images)
        this.rememberSentPrompt(session, cleanedPrompt)
        if (session.uncertainPromptHashes?.length) {
          session.uncertainPromptHashes = session.uncertainPromptHashes.filter((h) => h !== hashText(cleanedPrompt))
        }
      }

      if (session.title === 'New Gemini Web chat') session.title = cleanedPrompt.slice(0, 80)
      progress.enter('wait')
      const completed = await this.waitForAssistant(driver, session, baselineAssistantCount, signal, (images?.length ?? 0) > 0)
      this.captureConversationUrl(session, completed.url)
      const assistant = [...completed.turns].reverse().find((turn) => turn.role === 'assistant')
      if (!assistant?.text.trim()) throw new Error('Gemini Web completed without a readable assistant message')
      progress.enter('read')
      this.recordAssistantMessage(session, assistant.text.trim())
      this.markAllTurnsSeen(session, completed)
      return { sessionId: session.sessionId }
    } finally {
      discardWebImages(stagedImages)
      driver.close()
    }
  }

  private async runWithBrowserAgent(
    session: StoredGeminiWebSession,
    cleanedPrompt: string,
    images: readonly HarnessRunImage[] | undefined,
    signal: AbortSignal,
    progress: WebTurnProgress,
  ): Promise<{ sessionId: string }> {
    progress.enter('open')
    // Browser Agent uses PageDriver for initial navigation, attachment handling, and snapshot waiting.
    const driver = await this.openBoundConversation(session, signal, 'extension')
    let stagedImages: StagedWebImages | undefined
    try {
      assertTurnActive(signal)
      progress.enter('observe')
      const before = await this.captureSnapshot(driver)
      assertTurnActive(signal)
      if (before.loginRequired) {
        throw new WebTurnError({
          code: 'login-required',
          message: "Gemini Web needs you signed in to gemini.google.com in ND's visible Browser pane. Sign in there, then resend this message.",
          phase: 'observe',
        })
      }
      if (before.challenge) {
        throw new WebTurnError({
          code: 'challenge',
          message: "Google is showing a verification challenge in ND's Browser pane. Complete the challenge (or sign in to gemini.google.com) and resend this message.",
          phase: 'observe',
        })
      }
      if (before.rateLimited) {
        throw new WebTurnError({
          code: 'rate-limited',
          message: 'Gemini has rate limited requests. Please wait a few moments and try again.',
          phase: 'observe',
        })
      }
      const lastUserIndex = before.turns.map((t) => t.role).lastIndexOf('user')
      const lastUserTurn = lastUserIndex >= 0 ? before.turns[lastUserIndex] : undefined
      const alreadyInDom = lastUserTurn && lastUserTurn.text.trim() === cleanedPrompt
      const isUncertain = session.uncertainPromptHashes?.includes(hashText(cleanedPrompt))

      let baselineAssistantCount = before.turns.filter((turn) => turn.role === 'assistant').length

      if (alreadyInDom && isUncertain) {
        progress.submission = 'confirmed'
        session.uncertainPromptHashes = (session.uncertainPromptHashes ?? []).filter((h) => h !== hashText(cleanedPrompt))
        this.rememberSentPrompt(session, cleanedPrompt)
        baselineAssistantCount = before.turns.slice(0, lastUserIndex).filter((turn) => turn.role === 'assistant').length

        // Only import background turns that occurred BEFORE the adopted prompt
        const priorSnapshot: GeminiDomSnapshot = {
          ...before,
          turns: before.turns.slice(0, lastUserIndex),
        }
        this.importUnseenTurns(session, priorSnapshot)

        const hasUserTurnInTranscript = [...session.transcript].reverse().some(
          (e) => e.type === 'user/message' && (e.data as { message?: { content?: Array<{ text?: string }> } })?.message?.content?.[0]?.text?.trim() === cleanedPrompt,
        )
        if (!hasUserTurnInTranscript) {
          this.recordUserMessage(session, cleanedPrompt, images)
        }
      } else {
        if (before.busy || before.pendingSend) throw this.pageBusyError()
        this.importUnseenTurns(session, before)
        const tabId = this.options.browser.activeTabId()
        const agent = new BrowserAgentRunner({
          port: this.options.browser,
          tabId,
          allowedOrigins: GEMINI_ORIGINS,
          signal,
          visualRecovery: this.modeSettings.visualRecovery,
          log: this.options.log,
        })

        // Step 1: Observe & clear stale attachment chips if any exist
        await agent.runStep({
          name: 'clear-stale-chips',
          maxAttempts: 2,
          plan: (obs) => {
            const stale = findCloseAttachmentElements(obs.snapshot)[0]
            if (!stale) return null
            return { kind: 'click', ref: stale.ref }
          },
          verify: () => true,
        }).catch(() => undefined)

        // Step 2: Attach images if provided (reusing driver upload)
        if ((images?.length ?? 0) > 0) {
          progress.enter('attach')
          assertTurnActive(signal)
          stagedImages = await this.attachImages(driver, images ?? [], signal)
        }

        // Step 3: Observe -> Act -> Verify Composer Fill
        progress.enter('compose')
        assertTurnActive(signal)
        await agent.runStep({
          name: 'fill-composer',
          maxAttempts: 5,
          plan: (obs) => {
            const composer = findComposerElement(obs.snapshot)
            if (!composer) {
              const newChat = findNewChatElement(obs.snapshot)
              if (newChat) return { kind: 'click', ref: newChat.ref, reason: 'open new chat for composer' }
              return null
            }
            return { kind: 'fill', ref: composer.ref, text: cleanedPrompt }
          },
          verify: (after) => {
            const composer = findComposerElement(after)
            return Boolean(composer)
          },
        })

        // Step 4: click Send once through the semantic driver, then confirm it
        // against the page. Retrying a semantic step that clicks Send could
        // submit the same prompt twice.
        progress.enter('submit')
        assertTurnActive(signal)
        let sendAttempted = false
        let sendFailure: unknown
        try {
          await agent.runStep({
            name: 'send-prompt',
            maxAttempts: 1,
            plan: (obs) => {
              const sendBtn = findSendButtonElement(obs.snapshot)
              if (!sendBtn) return null
              sendAttempted = true
              progress.submission = 'uncertain'
              return { kind: 'click', ref: sendBtn.ref }
            },
          })
        } catch (error) {
          sendFailure = error
        }
        if (!sendAttempted) {
          throw progress.fail('layout-changed', 'Gemini Web did not expose an enabled Send control. Reload Gemini and retry.', sendFailure)
        }
        if (sendFailure) {
          this.options.log?.(`[gemini-web] browser-agent send step could not verify itself (${sendFailure instanceof Error ? sendFailure.message : String(sendFailure)}); confirming against the page`)
        }
        await this.confirmSubmission(driver, cleanedPrompt, signal, progress)

        this.recordUserMessage(session, cleanedPrompt, images)
        this.rememberSentPrompt(session, cleanedPrompt)
        if (session.uncertainPromptHashes?.length) {
          session.uncertainPromptHashes = session.uncertainPromptHashes.filter((h) => h !== hashText(cleanedPrompt))
        }
      }

      if (session.title === 'New Gemini Web chat') session.title = cleanedPrompt.slice(0, 80)
      progress.enter('wait')
      const completed = await this.waitForAssistant(driver, session, baselineAssistantCount, signal, (images?.length ?? 0) > 0)
      this.captureConversationUrl(session, completed.url)
      const assistant = [...completed.turns].reverse().find((turn) => turn.role === 'assistant')
      if (!assistant?.text.trim()) throw new Error('Gemini Web completed without a readable assistant message')
      progress.enter('read')
      this.recordAssistantMessage(session, assistant.text.trim())
      this.markAllTurnsSeen(session, completed)
      return { sessionId: session.sessionId }
    } finally {
      discardWebImages(stagedImages)
      driver.close()
    }
  }

  /**
   * The in-page origin guard fires before the snapshot script can report that
   * Google redirected to sign-in or a challenge. Map those edges back to the
   * provider condition, and treat any other off-site navigation as the user's
   * own action so no transport tries to reclaim the pane.
   */
  private classifyTurnError(progress: WebTurnProgress, error: unknown): WebTurnError {
    const classified = progress.classify(error)
    if (!(error instanceof PageGuardError)) return classified
    const host = (() => { try { return new URL(error.origin).hostname } catch { return '' } })()
    if (host === 'accounts.google.com') {
      return new WebTurnError({
        code: 'login-required',
        message: "Gemini Web needs you signed in to gemini.google.com in ND's visible Browser pane. Sign in there, then resend this message.",
        phase: classified.phase,
        submission: classified.submission,
        ...(classified.transport ? { transport: classified.transport } : {}),
        cause: error,
      })
    }
    if (host === 'consent.google.com') {
      return new WebTurnError({
        code: 'challenge',
        message: "Google is showing a verification challenge in ND's Browser pane. Complete the challenge (or sign in to gemini.google.com) and resend this message.",
        phase: classified.phase,
        submission: classified.submission,
        ...(classified.transport ? { transport: classified.transport } : {}),
        cause: error,
      })
    }
    return new WebTurnError({
      code: 'wrong-page',
      message: classified.message,
      phase: classified.phase,
      submission: classified.submission,
      ...(classified.transport ? { transport: classified.transport } : {}),
      cause: error,
    })
  }

  private pageBusyError(): WebTurnError {
    return new WebTurnError({
      code: 'page-busy',
      message: "Gemini is still answering or uploading in ND's Browser pane. Let it finish (or stop it), then resend this message.",
      phase: 'observe',
    })
  }

  private async clearStaleAttachments(driver: PageDriver): Promise<void> {
    await driver.evaluate<boolean>(`(() => {
      const stale = Array.from(document.querySelectorAll('button')).filter((el) => {
        const label = (el.getAttribute('aria-label') || '').trim();
        return /^(close|remove)\\s+attachment$/i.test(label);
      });
      stale.forEach((el) => el.click());
      return stale.length > 0;
    })()`).catch(() => false)
  }

  /**
   * Pasted images ride Gemini's own uploader so the model receives a real
   * attachment. The turn only starts after the previews finish loading.
   */
  private async attachImages(
    driver: PageDriver,
    images: readonly HarnessRunImage[],
    signal: AbortSignal,
  ): Promise<StagedWebImages | undefined> {
    if (images.length === 0) return undefined
    assertTurnActive(signal)
    let staged: StagedWebImages | undefined
    try {
      staged = stageWebImages(images)
      const mounted = await driver.evaluate<boolean>(`(() => {
        if (document.querySelector(${JSON.stringify(GEMINI_IMAGE_INPUT_SELECTOR)})) return true;
        // Signed-out Gemini labels this "Upload & tools"; signed-in Gemini
        // uses "Upload and tools".
        const button = Array.from(document.querySelectorAll('button')).find((el) => /upload\\s*(?:&|and)\\s*tools/i.test((el.getAttribute('aria-label') || '').trim()));
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()`)
      if (!mounted) {
        throw new Error('Gemini Web has no image upload control in ND\'s Browser pane. Open gemini.google.com and sign in, then resend this message.')
      }
      const inputExpression = `document.querySelector(${JSON.stringify(GEMINI_IMAGE_INPUT_SELECTOR)})`
      let inputReady = false
      for (let attempt = 0; attempt < 20 && !inputReady; attempt += 1) {
        assertTurnActive(signal)
        inputReady = await driver.evaluate<boolean>(`${inputExpression} !== null`)
        if (!inputReady) await sleep(100)
      }
      if (!inputReady) {
        throw new Error('Gemini Web did not expose an image input. Reload Gemini and resend this message.')
      }
      await this.clearStaleAttachments(driver)
      await sleep(200)
      const baseline = await driver.evaluate<{ count: number; errors: number; uploading: boolean }>(GEMINI_ATTACHMENT_STATE_SCRIPT)
      assertTurnActive(signal)
      if (!await driver.setFilesOnInput(inputExpression, staged.files)) {
        throw new Error('Gemini Web did not expose an image input. Reload Gemini and resend this message.')
      }
      const deadline = Date.now() + ATTACHMENT_TIMEOUT_MS
      let state = baseline
      while (Date.now() < deadline) {
        assertTurnActive(signal)
        state = await driver.evaluate<{ count: number; errors: number; uploading: boolean }>(GEMINI_ATTACHMENT_STATE_SCRIPT)
        if (state.errors > baseline.errors) {
          throw new Error('Gemini Web rejected the attached image. Sign in to gemini.google.com or try a different PNG, JPEG, WebP, or GIF, then resend.')
        }
        if (state.count >= baseline.count + images.length) return staged
        await sleep(ATTACHMENT_POLL_MS)
      }
      throw state.uploading
        ? new Error('Gemini Web is still uploading the attached image. Sign in to gemini.google.com — image turns can require an account — then resend this message.')
        : new Error('Gemini Web did not finish attaching the image in time. Reload Gemini and resend this message.')
    } catch (error) {
      discardWebImages(staged)
      throw error
    }
  }

  private async submitPrompt(driver: PageDriver, prompt: string, signal: AbortSignal, progress: WebTurnProgress): Promise<void> {
    assertTurnActive(signal)
    const source = JSON.stringify(prompt)
    const expected = composerKey(prompt)
    let accepted = false
    for (let attempt = 0; attempt < 3 && !accepted; attempt += 1) {
      assertTurnActive(signal)
      const result = await driver.evaluate<{ ok: boolean; reason?: string; text?: string }>(`(async () => {
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
        return { ok: true, text: composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? composer.value : composer.innerText };
      })()`)
      if (!result?.ok) throw new Error('Gemini Web composer is unavailable.')
      if (composerKey(result.text ?? '') !== expected) {
        await sleep(400)
        continue
      }
      await sleep(250)
      const settled = await this.readComposerText(driver)
      if (composerKey(settled) !== expected) {
        await sleep(200)
        continue
      }
      await sleep(250)
      accepted = composerKey(await this.readComposerText(driver)) === expected
    }
    if (!accepted) {
      throw new Error('Gemini Web composer did not keep the full message. Reload Gemini and retry.')
    }

    progress.enter('submit')
    let sent = false
    for (let index = 0; index < 50; index += 1) {
      assertTurnActive(signal)
      // The click can take effect even when its result never reaches ND (socket
      // close, timeout), so every attempted click starts as an uncertain submission.
      progress.submission = 'uncertain'
      const clicked = await driver.evaluate<boolean>(`(() => {
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
      if (clicked) {
        sent = true
        break
      }
      progress.submission = 'none'
      await sleep(100)
    }
    if (!sent) {
      throw progress.fail('not-submitted', 'Gemini Web could not find an enabled Send control. Reload Gemini and retry.')
    }
    await this.confirmSubmission(driver, prompt, signal, progress)
  }

  /**
   * Confirmation is the only proof the provider accepted the prompt. A timeout
   * or cancellation after the Send click stays `uncertain`: resending from that
   * state can duplicate the turn.
   */
  private async confirmSubmission(driver: PageDriver, prompt: string, signal: AbortSignal, progress: WebTurnProgress): Promise<void> {
    progress.enter('confirm')
    if (progress.submission === 'none') progress.submission = 'uncertain'
    const confirmDeadline = Date.now() + SUBMIT_CONFIRM_TIMEOUT_MS
    let confirmed = false
    while (Date.now() < confirmDeadline) {
      if (signal.aborted) break
      const state = await driver.evaluate<{ composerCleared: boolean; busy: boolean; lastUserTurn?: string }>(`(() => {
        const composer = document.querySelector(${JSON.stringify(GEMINI_COMPOSER_SELECTOR)});
        const composerText = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? composer.value : (composer?.innerText || '');
        const buttons = Array.from(document.querySelectorAll('button'));
        const stopButton = buttons.find(el => /^stop(?:\\b|$)/i.test(el.getAttribute('aria-label') || '') || el.getAttribute('data-test-id') === 'stop-button');
        const pendingSend = buttons.some(el => (el.getAttribute('aria-label') || '') === 'Cancel send');
        const userTurns = Array.from(document.querySelectorAll('user-query-content, [data-test-id="user-query"]'));
        const lastUser = userTurns.at(-1)?.innerText?.trim();
        return {
          composerCleared: composerText.trim() === '' || composerText.trim() !== ${JSON.stringify(prompt)}.trim(),
          busy: stopButton !== undefined || pendingSend || document.querySelector('[data-is-streaming="true"], [data-is-generating="true"]') !== null,
          lastUserTurn: lastUser,
        };
      })()`).catch(() => undefined)

      if (state && (state.lastUserTurn === prompt || (state.composerCleared && state.busy))) {
        confirmed = true
        break
      }
      await sleep(SUBMIT_CONFIRM_POLL_MS)
    }

    if (!confirmed) {
      throw new WebTurnError({
        code: 'submission-uncertain',
        message: "Gemini Web did not confirm that it accepted the message. The message may already have been sent — check ND's Browser pane before resending; ND will not resend it automatically.",
        phase: 'confirm',
        submission: 'uncertain',
        transport: progress.transport,
      })
    }
    progress.submission = 'confirmed'
  }

  private async readComposerText(driver: PageDriver): Promise<string> {
    return await driver.evaluate<string>(`(() => {
      const composer = document.querySelector(${JSON.stringify(GEMINI_COMPOSER_SELECTOR)});
      if (!(composer instanceof HTMLElement)) return '';
      return composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? composer.value : composer.innerText;
    })()`)
  }

  private async waitForAssistant(
    driver: PageDriver,
    session: StoredGeminiWebSession,
    baselineAssistantCount: number,
    signal: AbortSignal,
    pendingAttachment = false,
  ): Promise<GeminiDomSnapshot> {
    const startedAt = Date.now()
    const deadline = startedAt + GEMINI_TURN_TIMEOUT_MS
    let stableText = ''
    let stableCount = 0
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('Gemini Web turn was stopped.')
      const snapshot = await this.captureSnapshot(driver)
      if (snapshot.challenge) throw new WebTurnError({ code: 'challenge', message: "Google is showing a verification challenge in ND's Browser pane. Complete the challenge (or sign in to gemini.google.com) and resend this message.", phase: 'wait' })
      if (snapshot.loginRequired) throw new WebTurnError({ code: 'login-required', message: "Gemini Web needs you signed in to gemini.google.com in ND's visible Browser pane. Sign in there, then resend this message.", phase: 'wait' })
      if (snapshot.rateLimited) throw new WebTurnError({ code: 'rate-limited', message: 'Gemini has rate limited requests. Please wait a few moments and try again.', phase: 'wait' })
      this.captureConversationUrl(session, snapshot.url)
      const assistants = snapshot.turns.filter((turn) => turn.role === 'assistant')
      if (pendingAttachment && snapshot.pendingSend && assistants.length <= baselineAssistantCount && Date.now() - startedAt >= ATTACHMENT_SEND_GRACE_MS) {
        throw new Error('Gemini Web is still uploading the attached image and no reply started. Sign in to gemini.google.com — image turns can require an account — then resend this message.')
      }
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

  private async captureSnapshot(driver: PageDriver): Promise<GeminiDomSnapshot> {
    return driver.evaluate<GeminiDomSnapshot>(`(() => {
      ${GEMINI_DOM_TURNS_SCRIPT}
      const composerSelector = ${JSON.stringify(GEMINI_COMPOSER_SELECTOR)};
      const domTurns = readGeminiDomTurns();
      const turns = [];
      for (const { root, role, text: turnText } of domTurns) {
        const text = turnText || (root instanceof HTMLElement ? root.innerText.trim() : '');
        if (text) turns.push({ role, text });
      }
      const lastAssistant = domTurns.filter(turn => turn.role === 'assistant').at(-1);
      const buttons = Array.from(document.querySelectorAll('button'));
      const stopButton = buttons.find(el => /^stop(?:\\b|$)/i.test(el.getAttribute('aria-label') || '') || el.getAttribute('data-test-id') === 'stop-button');
      const pendingSend = buttons.some(el => (el.getAttribute('aria-label') || '') === 'Cancel send');
      return {
        url: location.href,
        title: document.title,
        composer: document.querySelector(composerSelector) !== null,
        busy: stopButton !== undefined
          || document.querySelector('[data-is-streaming="true"], [data-is-generating="true"], .markdown[aria-busy="true"]') !== null
          || lastAssistant?.imagesPending === true,
        complete: lastAssistant?.complete === true,
        pendingSend,
        challenge: location.hostname === 'consent.google.com' || location.pathname.includes('/sorry/') || /verify you are human|checking your browser|just a moment/i.test(document.title),
        loginRequired: location.hostname === 'accounts.google.com' || location.pathname.includes('/auth/'),
        rateLimited: /rate limit|too many requests|quota exceeded|try again in a few moments|temporarily unavailable/i.test(document.body?.innerText || ''),
        turns,
      };
    })()`)
  }

  private importUnseenTurns(session: StoredGeminiWebSession, snapshot: GeminiDomSnapshot): void {
    if (snapshot.busy) return
    const seen = new Set(session.seenTurnKeys)
    const sent = new Set(session.sentPromptHashes)
    const assistantIndices = snapshot.turns
      .map((turn, idx) => (turn.role === 'assistant' ? idx : -1))
      .filter((idx) => idx >= 0)
    let changed = false
    // The engine optimistically recorded the user prompt before Gemini's DOM
    // echoed it. Reconcile that echo instead of importing it a second time.
    let awaitingEcho = session.transcript.at(-1)?.type === 'user/message'
    snapshot.turns.forEach((turn, index) => {
      const key = domTurnKey(turn, index)
      if (seen.has(key)) return
      const indexRolePrefix = `${index}:${turn.role}:`
      const existingAtIndex = [...seen].find((candidate) => candidate.startsWith(indexRolePrefix))
      if (existingAtIndex) {
        seen.delete(existingAtIndex)
        seen.add(key)
        if (turn.role === 'assistant') {
          const pos = assistantIndices.indexOf(index)
          const offsetFromEnd = pos >= 0 ? assistantIndices.length - 1 - pos : 0
          this.updateAssistantMessageFromEnd(session, turn.text, offsetFromEnd)
        }
        awaitingEcho = false
        changed = true
        return
      }
      if (turn.role === 'user' && (sent.has(hashText(turn.text)) || (awaitingEcho && IMAGE_ECHO_PATTERN.test(turn.text)))) {
        seen.add(key)
        awaitingEcho = false
        changed = true
        return
      }
      if (turn.role === 'user') this.recordUserMessage(session, turn.text)
      else this.recordAssistantMessage(session, turn.text)
      awaitingEcho = false
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
    if (parsed?.chatId) session.gemRef = parsed.chatId
    if (session.conversationUrl === url) return
    session.conversationUrl = url
    this.persistStore()
  }

  private async watchTick(): Promise<void> {
    if (this.watcherBusy) return
    this.watcherBusy = true
    try {
      if (typeof this.options.browser?.state !== 'function' || typeof this.options.browser?.activeTabId !== 'function') return
      const currentUrl = this.options.browser.state()?.url ?? ''
      const visibleSessions = [...this.sessions.values()].filter(
        (session) => !session.running && session.conversationUrl !== undefined && sameGeminiUrl(currentUrl, session.conversationUrl),
      )
      if (visibleSessions.length > 0) {
        try {
          const tabId = this.options.browser.activeTabId()
          const driver = new ElectronPageDriver(this.options.browser, tabId, GEMINI_ORIGINS)
          try {
            const snapshot = await this.captureSnapshot(driver)
            for (const visibleSession of visibleSessions) {
              this.importUnseenTurns(visibleSession, snapshot)
            }
          } finally {
            driver.close()
          }
        } catch (error) {
          this.options.log?.(`[gemini-web] visible conversation sync skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } finally {
      this.watcherBusy = false
    }
  }

  private recordUserMessage(session: StoredGeminiWebSession, text: string, images?: readonly HarnessRunImage[]): void {
    this.recordEnvelope(session, {
      type: 'user/message',
      data: {
        message: {
          role: 'user',
          content: [
            { type: 'text', text },
            ...(images ?? []).map((image, index) => ({
              type: 'image',
              mediaType: image.mediaType,
              name: image.name || `attached-${index + 1}`,
              data: image.data,
            })),
          ],
        },
      },
    })
  }

  private recordAssistantMessage(session: StoredGeminiWebSession, text: string): void {
    this.recordEnvelope(session, {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
    })
  }

  private updateAssistantMessageFromEnd(session: StoredGeminiWebSession, text: string, offsetFromEnd: number): void {
    let seenFromEnd = 0
    for (let i = session.transcript.length - 1; i >= 0; i--) {
      const entry = session.transcript[i]
      if (entry?.type === 'assistant/message') {
        if (seenFromEnd === offsetFromEnd) {
          session.updatedAt = Date.now()
          entry.time = session.updatedAt
          entry.data = { message: { role: 'assistant', content: [{ type: 'text', text }] } }
          this.emitFrame({
            kind: 'session-event',
            sessionId: session.sessionId,
            event: {
              ...entry,
              data: {
                message: { role: 'assistant', content: [{ type: 'text', text }] },
                replaceFromEndAssistantOffset: offsetFromEnd,
              },
            },
          })
          return
        }
        seenFromEnd += 1
      }
    }
    this.recordAssistantMessage(session, text)
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
        session.uncertainPromptHashes = Array.isArray(session.uncertainPromptHashes) ? session.uncertainPromptHashes.slice(-50) : []
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
      if (parsed.modeSettings && typeof parsed.modeSettings === 'object') {
        this.modeSettings = normalizeWebBrowserModeSettings(parsed.modeSettings)
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
      modeSettings: this.modeSettings,
    }
    try {
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.options.storePath)
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
    }
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value.trim()).digest('hex')
}

function composerKey(text: string): string {
  return text.replace(/\s+/g, '')
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
