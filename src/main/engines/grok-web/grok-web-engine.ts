import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  DshEventFrame,
  EngineModelOption,
  EngineSessionSummary,
  EngineSessionTranscript,
  HarnessRunImage,
  SessionEventEnvelope,
} from '../../../shared/contracts.js'
import { GROK_WEB_ENGINE_ID } from '../../../shared/coding-engines.js'
import {
  DEFAULT_WEB_BROWSER_MODE_SETTINGS,
  normalizeWebBrowserModeSettings,
  type WebBrowserModeSettings,
  type WebBrowserTransport,
} from '../../../shared/browser-modes.js'
import { stripWorkspaceContext } from '../../../shared/workspace-context.js'
import type { BrowserController } from '../../browser/browser-controller.js'
import { ElectronPageDriver, PageGuardError, type PageDriver } from '../../browser/page-driver.js'
import { VisibleCdpConnection } from '../../browser/visible-cdp-connection.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import { discardWebImages, stageWebImages, type StagedWebImages } from '../web-attachments.js'
import { createdProfileId, sessionProfileId } from '../web-engine-profile.js'
import {
  canSwitchTransport,
  planWebTransports,
  WebTurnError,
  WebTurnProgress,
  type WebTransportAvailability,
} from '../web-turn.js'

const GROK_HOME_URL = 'https://grok.com/'
const GROK_ORIGINS = ['https://grok.com', 'https://x.ai'] as const

const GROK_COMPOSER_SELECTOR = [
  'textarea.ring-0',
  'textarea[placeholder*="Grok" i]',
  'textarea[placeholder*="Ask" i]',
  'textarea[placeholder*="message" i]',
  'textarea[placeholder*="Anything" i]',
  'div[contenteditable="true"]',
  '[role="textbox"]',
  'textarea',
].join(', ')

const GROK_USER_TURN_SELECTOR = [
  '[data-message-author-role="user"]',
  '[data-testid*="user-message"]',
  'div[class*="user-message"]',
  'div[class*="userMessage"]',
  '.items-end .message-bubble',
  'div.items-end .whitespace-pre-wrap',
  'div[class*="userTurn"]',
].join(', ')

const GROK_ASSISTANT_TURN_SELECTOR = [
  '[data-message-author-role="assistant"]',
  '[data-testid*="assistant-message"]',
  '.prose',
  '.markdown',
  'div[class*="response-content"]',
  'div[class*="grok-response"]',
  'div[class*="assistantTurn"]',
].join(', ')

const GROK_BUTTON_SELECTOR = [
  'button[type="submit"]',
  'button[aria-label*="Send" i]',
  'button[aria-label*="Submit" i]',
  'button[aria-label*="Grok" i]',
  'button.rounded-full',
].join(', ')

const GROK_STOP_BUTTON_SELECTOR = [
  'button[aria-label*="Stop" i]',
  'button[aria-label*="Cancel" i]',
  'button[aria-label*="Pause" i]',
].join(', ')

const GROK_MODELS: EngineModelOption[] = [
  { id: 'default', name: 'Page default' },
  { id: 'grok-3', name: 'Grok 3' },
  { id: 'grok-2', name: 'Grok 2' },
  { id: 'deepsearch', name: 'DeepSearch' },
  { id: 'think', name: 'Think' },
]

const TRANSCRIPT_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'agent/reasoning'])
const MAX_TRANSCRIPT_EVENTS = 500
const MAX_PROMPT_CHARS = 100_000
const GROK_READY_TIMEOUT_MS = 20_000
const GROK_TURN_TIMEOUT_MS = 10 * 60_000
const ATTACHMENT_TIMEOUT_MS = 60_000
const ATTACHMENT_POLL_MS = 300
const SUBMIT_CONFIRM_POLL_MS = 150
const SUBMIT_CONFIRM_TIMEOUT_MS = 12_000
const TURN_POLL_MS = 350
const TURN_STABLE_POLLS = 4
const BACKGROUND_WATCH_MS = 5_000
const IMAGE_ECHO_PATTERN = /^(?:\s*!\[[^\]]*\]\([^)]*\)\s*)+$/

interface StoredGrokWebSession {
  sessionId: string
  conversationUrl?: string
  browserTabId?: string
  browserProfileId?: string
  cwd?: string
  title: string
  createdAt: number
  updatedAt: number
  running: boolean
  hidden?: boolean
  isolated?: boolean
  sequence: number
  transcript: SessionEventEnvelope[]
  seenTurnKeys: string[]
  sentPromptHashes: string[]
  uncertainPromptHashes?: string[]
}

interface PersistedGrokWebStore {
  version: 1
  sessions: StoredGrokWebSession[]
  modeSettings?: WebBrowserModeSettings
}

interface ActiveGrokTurn {
  controller: AbortController
  progress?: WebTurnProgress | undefined
}

interface GrokDomTurn {
  role: 'user' | 'assistant'
  text: string
}

interface GrokDomSnapshot {
  url: string
  title: string
  composer: boolean
  composerText: string
  busy: boolean
  complete: boolean
  pendingSend: boolean
  challenge: boolean
  loginRequired: boolean
  rateLimited: boolean
  sendEnabled: boolean
  userTurns: number
  turns: GrokDomTurn[]
}

export interface GrokWebEngineOptions {
  browser: BrowserController
  workspace: WorkspaceService
  storePath: string
  log?: (line: string) => void
}

/**
 * Grok Web is a conversation transport over ND's visible browser tab.
 * It drives grok.com and never assumes filesystem, shell, Git, or project-scoped provider tools.
 */
export class GrokWebEngine {
  private readonly sessions = new Map<string, StoredGrokWebSession>()
  private readonly activeTurns = new Map<string, ActiveGrokTurn>()
  private modeSettings: WebBrowserModeSettings = { ...DEFAULT_WEB_BROWSER_MODE_SETTINGS }
  private onEvent: ((frame: DshEventFrame) => void) | undefined
  private watcherBusy = false
  private readonly watchTimer: ReturnType<typeof setInterval>

  constructor(private readonly options: GrokWebEngineOptions) {
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

  async ensureBrowserTab(sessionId: string): Promise<string | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    const targetUrl = session.conversationUrl && isGrokConversationUrl(session.conversationUrl)
      ? session.conversationUrl
      : GROK_HOME_URL
    return await this.ensureSessionTab(session, targetUrl)
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
    throw new Error(`Unknown ${GROK_WEB_ENGINE_ID} approval: ${rpcId}`)
  }

  listSessions(): EngineSessionSummary[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => ({
        sessionId: session.sessionId,
        engineId: GROK_WEB_ENGINE_ID,
        title: session.title,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        running: session.running,
        ...(session.hidden ? { hidden: true } : {}),
        ...(session.browserTabId ? { browserTabId: session.browserTabId } : {}),
      }))
  }

  transcript(sessionId: string): EngineSessionTranscript {
    const session = this.requireSession(sessionId)
    return { sessionId, engineId: GROK_WEB_ENGINE_ID, events: [...session.transcript] }
  }

  async listModels(): Promise<EngineModelOption[]> {
    return GROK_MODELS.map((model) => ({ ...model }))
  }

  async createSession(input: { cwd?: string; hidden?: boolean; isolated?: boolean; title?: string; profileId?: string } = {}): Promise<{ sessionId: string }> {
    const sessionId = `grok-web-${randomUUID()}`
    const now = Date.now()
    const profileId = createdProfileId(this.options.browser, input.profileId)
    const session: StoredGrokWebSession = {
      sessionId,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      title: input.title?.trim() || 'New Grok Web chat',
      createdAt: now,
      updatedAt: now,
      running: false,
      ...(profileId ? { browserProfileId: profileId } : {}),
      ...(input.hidden ? { hidden: true } : {}),
      ...(input.isolated ? { isolated: true } : {}),
      sequence: 0,
      transcript: [],
      seenTurnKeys: [],
      sentPromptHashes: [],
    }
    this.sessions.set(sessionId, session)
    this.persistStore()
    if (!session.hidden) this.emitFrame({ kind: 'session-added', sessionId, meta: { engineId: GROK_WEB_ENGINE_ID } })
    return { sessionId }
  }

  async run(prompt: string, input: { sessionId?: string; cwd?: string; images?: HarnessRunImage[]; model?: string; isolated?: boolean; transports?: WebBrowserTransport[] } = {}): Promise<{ sessionId: string }> {
    const cleaned = stripWorkspaceContext(prompt).trim()
    if (!cleaned) throw new Error('Prompt cannot be empty')
    if (cleaned.length > MAX_PROMPT_CHARS) throw new Error(`Prompt exceeds the ${MAX_PROMPT_CHARS.toLocaleString()} character limit`)

    let session = input.sessionId === undefined ? undefined : this.sessions.get(input.sessionId)
    if (input.sessionId !== undefined && !session) throw new Error(`Unknown ${GROK_WEB_ENGINE_ID} session: ${input.sessionId}`)
    if (!session) {
      const created = await this.createSession({
        cwd: input.cwd ?? this.options.workspace.state().root,
        ...(input.isolated ? { isolated: true } : {}),
      })
      session = this.sessions.get(created.sessionId)
    }
    if (!session) throw new Error(`${GROK_WEB_ENGINE_ID} session could not be created`)
    if (input.isolated) session.isolated = true
    if (session.running) throw new Error('This Grok Web chat already has an active turn')
    if ([...this.sessions.values()].some((candidate) => candidate.running && candidate.sessionId !== session.sessionId)) {
      throw new Error('Grok Web uses ND\'s single visible browser pane. Finish the active Grok Web turn before starting another one.')
    }

    const hasImages = (input.images?.length ?? 0) > 0
    const availability: WebTransportAvailability = {
      extension: true,
      cdp: Boolean(this.options.browser.state().cdpPort),
      browserAgent: false,
    }
    const plan = planWebTransports({ settings: this.modeSettings, hasImages, available: availability })
    const transports = input.transports?.length
      ? input.transports.filter((transport) => transport === 'extension' || (transport === 'cdp' && availability.cdp))
      : plan.transports
    if (transports.length === 0) {
      const reason = plan.skipped.map((skipped) => `${skipped.transport}: ${skipped.reason}`).join(', ')
      throw new Error(`No browser transport available for mode "${this.modeSettings.mode}" (${reason || 'unavailable'})`)
    }

    session.cwd = input.cwd ?? session.cwd ?? this.options.workspace.state().root
    const abort = new AbortController()
    const activeTurn: ActiveGrokTurn = { controller: abort }
    this.activeTurns.set(session.sessionId, activeTurn)
    session.running = true
    session.updatedAt = Date.now()
    this.persistStore()
    this.emitFrame({ kind: 'session-status', sessionId: session.sessionId, running: true })

    try {
      let lastError: unknown
      for (let index = 0; index < transports.length; index += 1) {
        const transport = transports[index]!
        const progress = new WebTurnProgress(transport)
        activeTurn.progress = progress
        try {
          return await this.runWithPageDriver(transport, session, cleaned, input.images, input.model, abort.signal, progress)
        } catch (error) {
          lastError = error
          const turnError = this.classifyTurnError(progress, error)
          if (turnError.submission === 'uncertain') {
            session.uncertainPromptHashes = trimArray([...(session.uncertainPromptHashes ?? []), hashText(cleaned)], 50)
            this.persistStore()
          }
          if (index < transports.length - 1 && canSwitchTransport(turnError)) {
            this.options.log?.(`[grok-web] ${transport} failed (${turnError.message}); falling back to ${transports[index + 1]}`)
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
      : [this.sessions.get(sessionId)].filter((session): session is StoredGrokWebSession => session?.running === true)
    for (const session of targets) {
      const activeTurn = this.activeTurns.get(session.sessionId)
      activeTurn?.controller.abort()
      if (!activeTurn?.progress || activeTurn.progress.submission === 'none') continue
      if (!this.browserMayHostSession(session)) continue
      try {
        const tabId = session.browserTabId && typeof this.options.browser.tabUrl === 'function'
          ? session.browserTabId
          : this.options.browser.activeTabId()
        const driver = new ElectronPageDriver(this.options.browser, tabId, GROK_ORIGINS)
        try {
          await driver.evaluate<boolean>(`(() => {
            const stops = Array.from(document.querySelectorAll(${JSON.stringify(GROK_STOP_BUTTON_SELECTOR)}))
              .filter((el) => el instanceof HTMLElement && el.getBoundingClientRect().width > 0);
            if (stops.length > 0 && stops[0] instanceof HTMLElement) {
              stops[0].click();
              return true;
            }
            return false;
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

  async deleteSession(sessionId: string, options: { closeTab?: boolean } = {}): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.running) await this.stop(sessionId)
    this.activeTurns.delete(sessionId)
    const tabId = session.browserTabId
    this.sessions.delete(sessionId)
    this.persistStore()
    if ((options.closeTab ?? true) && tabId) {
      await this.options.browser.closeTab(tabId).catch(() => false)
    }
  }

  private async ensureSessionTab(session: StoredGrokWebSession, targetUrl: string): Promise<string> {
    const browser = this.options.browser
    const desiredProfile = sessionProfileId(browser, session.browserProfileId)
    if (session.browserProfileId !== desiredProfile) {
      session.browserProfileId = desiredProfile
      this.persistStore()
    }
    const existing = session.browserTabId
    if (existing && browser.tabUrl(existing) !== undefined) {
      if (!session.hidden) await browser.activateTab(existing)
      const currentUrl = browser.tabUrl(existing) ?? ''
      if (!sameGrokUrl(currentUrl, targetUrl)) await browser.navigate(targetUrl, existing)
      return existing
    }
    const tab = await browser.createTab(targetUrl, !session.hidden, desiredProfile)
    session.browserTabId = tab.id
    this.persistStore()
    return tab.id
  }

  private conversationTarget(session: StoredGrokWebSession): string {
    return session.conversationUrl && isGrokConversationUrl(session.conversationUrl)
      ? session.conversationUrl
      : GROK_HOME_URL
  }

  private async openBoundConversation(
    session: StoredGrokWebSession,
    signal: AbortSignal,
    transport: WebBrowserTransport = 'cdp',
  ): Promise<PageDriver> {
    assertTurnActive(signal)
    const targetUrl = this.conversationTarget(session)
    const tabId = await this.ensureSessionTab(session, targetUrl)
    assertTurnActive(signal)
    await this.options.browser.ensureAgentReady()
    assertTurnActive(signal)
    const targetId = session.hidden === true
      ? await this.options.browser.targetIdForTab(tabId)
      : typeof this.options.browser?.state === 'function' ? this.options.browser.state()?.targetId : undefined
    const driver: PageDriver = transport === 'extension'
      ? new ElectronPageDriver(this.options.browser, tabId, GROK_ORIGINS)
      : await VisibleCdpConnection.connect(this.options.browser, { targetId, allowedOrigins: GROK_ORIGINS })

    try {
      const deadline = Date.now() + GROK_READY_TIMEOUT_MS
      while (Date.now() < deadline) {
        assertTurnActive(signal)
        const snapshot = await this.captureSnapshot(driver)
        assertTurnActive(signal)
        this.throwStopConditions(snapshot)
        if (snapshot.composer) return driver
        await sleep(250)
      }
      throw new WebTurnError({
        code: 'login-required',
        message: "Grok Web is open in ND's visible Browser pane, but its composer is unavailable. Sign in to grok.com (or complete any verification challenge), then resend this message.",
        phase: 'open',
      })
    } catch (error) {
      driver.close()
      throw error
    }
  }

  private async runWithPageDriver(
    transport: WebBrowserTransport,
    session: StoredGrokWebSession,
    cleanedPrompt: string,
    images: readonly HarnessRunImage[] | undefined,
    model: string | undefined,
    signal: AbortSignal,
    progress: WebTurnProgress,
  ): Promise<{ sessionId: string }> {
    progress.enter('open')
    const tabId = await this.ensureSessionTab(session, this.conversationTarget(session))
    let detachHeadless: (() => void) | undefined
    if (!session.hidden && !this.options.browser.state().visible) {
      if (!this.options.browser.windowIsOnScreen()) {
        throw new WebTurnError({
          code: 'page-busy',
          message: "Grok Web needs ND's window on screen to render its reply. Restore the ND window, then resend this message.",
          phase: 'open',
        })
      }
      detachHeadless = this.options.browser.attachTabForRouterTurn(tabId)
    }
    const driver = await this.openBoundConversation(session, signal, transport)
    let stagedImages: StagedWebImages | undefined
    try {
      assertTurnActive(signal)
      progress.enter('observe')
      const before = await this.captureSnapshot(driver)
      assertTurnActive(signal)
      this.throwStopConditions(before)

      const lastUserIndex = before.turns.map((turn) => turn.role).lastIndexOf('user')
      const lastUserTurn = lastUserIndex >= 0 ? before.turns[lastUserIndex] : undefined
      const isUncertain = session.uncertainPromptHashes?.includes(hashText(cleanedPrompt))
      const alreadyInDom = Boolean(lastUserTurn && promptMatchesDom(lastUserTurn.text, cleanedPrompt))
      let baselineAssistantCount = before.turns.filter((turn) => turn.role === 'assistant').length

      if (alreadyInDom && isUncertain) {
        progress.submission = 'confirmed'
        session.uncertainPromptHashes = (session.uncertainPromptHashes ?? []).filter((hash) => hash !== hashText(cleanedPrompt))
        this.rememberSentPrompt(session, cleanedPrompt)
        baselineAssistantCount = before.turns.slice(0, lastUserIndex).filter((turn) => turn.role === 'assistant').length
        this.importUnseenTurns(session, { ...before, turns: before.turns.slice(0, lastUserIndex) })
        const hasUserTurn = [...session.transcript].reverse().some((event) =>
          event.type === 'user/message' && userMessageText(event)?.trim() === cleanedPrompt,
        )
        if (!hasUserTurn) this.recordUserMessage(session, cleanedPrompt, images)
      } else {
        if (before.busy || before.pendingSend) throw this.pageBusyError()
        this.importUnseenTurns(session, before)
        assertTurnActive(signal)
        await this.applyModel(driver, model, signal)
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
          session.uncertainPromptHashes = session.uncertainPromptHashes.filter((hash) => hash !== hashText(cleanedPrompt))
        }
      }

      if (session.title === 'New Grok Web chat') session.title = cleanedPrompt.slice(0, 80)
      progress.enter('wait')
      const completed = await this.waitForAssistant(driver, session, baselineAssistantCount, signal)
      this.captureConversationUrl(session, completed.url)
      const assistant = [...completed.turns].reverse().find((turn) => turn.role === 'assistant')
      if (!assistant?.text.trim()) throw new Error('Grok Web completed without a readable assistant message')
      progress.enter('read')
      this.recordAssistantMessage(session, assistant.text.trim())
      this.markAllTurnsSeen(session, completed)
      return { sessionId: session.sessionId }
    } finally {
      discardWebImages(stagedImages)
      driver.close()
      detachHeadless?.()
    }
  }

  private classifyTurnError(progress: WebTurnProgress, error: unknown): WebTurnError {
    const classified = progress.classify(error)
    if (!(error instanceof PageGuardError)) return classified
    const host = (() => { try { return new URL(error.origin).hostname } catch { return '' } })()
    if (host.endsWith('grok.com') || host.endsWith('x.ai')) {
      return new WebTurnError({
        code: 'login-required',
        message: "Grok Web needs you signed in to grok.com in ND's visible Browser pane. Sign in there, then resend this message.",
        phase: classified.phase,
        submission: classified.submission,
        ...(classified.transport ? { transport: classified.transport } : {}),
        cause: error,
      })
    }
    if (host === 'challenges.cloudflare.com') {
      return new WebTurnError({
        code: 'challenge',
        message: "Cloudflare is showing a verification challenge in ND's Browser pane. Complete the challenge and resend this message.",
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
      message: "Grok is still answering or uploading in ND's Browser pane. Let it finish (or stop it), then resend this message.",
      phase: 'observe',
    })
  }

  private throwStopConditions(snapshot: GrokDomSnapshot): void {
    if (snapshot.challenge) {
      throw new WebTurnError({
        code: 'challenge',
        message: "Cloudflare or Grok is showing a verification challenge in ND's Browser pane. Complete the challenge and resend this message.",
        phase: 'observe',
      })
    }
    if (snapshot.loginRequired) {
      throw new WebTurnError({
        code: 'login-required',
        message: "Grok Web needs you signed in to grok.com in ND's visible Browser pane. Sign in there, then resend this message.",
        phase: 'observe',
      })
    }
    if (snapshot.rateLimited) {
      throw new WebTurnError({
        code: 'rate-limited',
        message: 'Grok has rate limited requests. Wait a few moments, then try again.',
        phase: 'observe',
      })
    }
  }

  private async applyModel(driver: PageDriver, requested: string | undefined, signal: AbortSignal): Promise<void> {
    const model = requested?.trim().toLowerCase()
    if (!model || model === 'default') return
    assertTurnActive(signal)

    const labelPattern = model === 'think' || model === 'reasoning'
      ? 'think'
      : model === 'deepsearch' || model === 'deep-search'
        ? 'deepsearch|deep search'
        : model === 'grok-3' || model === 'grok3'
          ? 'grok 3|grok-3'
          : model === 'grok-2' || model === 'grok2'
            ? 'grok 2|grok-2'
            : model

    await driver.evaluate<boolean>(`(() => {
      const pattern = new RegExp(${JSON.stringify(labelPattern)}, 'i');
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="radio"], [role="switch"], [role="tab"]'))
        .filter((el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      for (const el of candidates) {
        const text = (el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '');
        if (pattern.test(text)) {
          const pressed = el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true';
          if (!pressed) {
            el.click();
            return true;
          }
          return false;
        }
      }
      return false;
    })()`).catch(() => false)
  }

  private async attachImages(driver: PageDriver, images: readonly HarnessRunImage[], signal: AbortSignal): Promise<StagedWebImages | undefined> {
    if (images.length === 0) return undefined
    assertTurnActive(signal)
    let staged: StagedWebImages | undefined
    try {
      staged = stageWebImages(images)
      const hasInput = await driver.evaluate<boolean>(`${GROK_FILE_INPUT_EXPRESSION} !== null`)
      if (!hasInput) throw new Error("Grok Web has no file input in ND's Browser pane. Sign in to grok.com, then resend this message.")
      await sleep(200)
      const baseline = await driver.evaluate<{ count: number; uploading: boolean }>(GROK_ATTACHMENT_STATE_SCRIPT)
      assertTurnActive(signal)
      if (!await driver.setFilesOnInput(GROK_FILE_INPUT_EXPRESSION, staged.files)) {
        throw new Error('Grok Web did not expose its file input. Reload Grok and resend this message.')
      }
      const deadline = Date.now() + ATTACHMENT_TIMEOUT_MS
      while (Date.now() < deadline) {
        assertTurnActive(signal)
        const state = await driver.evaluate<{ count: number; uploading: boolean }>(GROK_ATTACHMENT_STATE_SCRIPT)
        if (state.count >= baseline.count + images.length && !state.uploading) return staged
        await sleep(ATTACHMENT_POLL_MS)
      }
      throw new Error('Grok Web did not finish attaching the image in time. Try a smaller PNG, JPEG, WebP, or GIF and resend.')
    } catch (error) {
      discardWebImages(staged)
      throw error
    }
  }

  private async submitPrompt(driver: PageDriver, prompt: string, signal: AbortSignal, progress: WebTurnProgress): Promise<void> {
    assertTurnActive(signal)
    const expected = composerKey(prompt)
    let accepted = false
    for (let attempt = 0; attempt < 3 && !accepted; attempt += 1) {
      assertTurnActive(signal)
      const typed = await driver.evaluate<boolean>(`(() => {
        const composer = document.querySelector(${JSON.stringify(GROK_COMPOSER_SELECTOR)});
        if (!composer) return false;
        composer.focus();
        if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
            || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(composer, ${JSON.stringify(prompt)});
          composer.dispatchEvent(new Event('input', { bubbles: true }));
          composer.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        if (composer instanceof HTMLElement && composer.isContentEditable) {
          composer.innerText = ${JSON.stringify(prompt)};
          composer.dispatchEvent(new InputEvent('input', { bubbles: true }));
          return true;
        }
        return false;
      })()`)
      if (!typed) throw new Error('Grok Web composer is unavailable.')
      await sleep(250)
      if (composerKey(await this.readComposerText(driver)) === expected) {
        await sleep(250)
        accepted = composerKey(await this.readComposerText(driver)) === expected
      }
      if (!accepted) await sleep(200)
    }
    if (!accepted) throw new Error('Grok Web composer did not keep the full message. Reload Grok and retry.')

    progress.enter('submit')
    const baselineUserTurns = await this.readUserTurnCount(driver)
    let attempted = false

    for (let index = 0; index < 50 && !attempted; index += 1) {
      assertTurnActive(signal)
      const clicked = await driver.evaluate<boolean>(`(() => {
        const buttons = Array.from(document.querySelectorAll(${JSON.stringify(GROK_BUTTON_SELECTOR)}))
          .filter((el) => {
            if (!(el instanceof HTMLElement)) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
        for (const button of buttons) {
          if (button instanceof HTMLElement) {
            const disabled = button instanceof HTMLButtonElement ? button.disabled : button.getAttribute('aria-disabled') === 'true';
            if (!disabled) {
              button.click();
              return true;
            }
          }
        }
        return false;
      })()`)
      if (clicked) {
        attempted = true
        progress.submission = 'uncertain'
        break
      }
      await sleep(100)
    }

    if (!attempted) {
      await driver.evaluate<boolean>(`(() => {
        const composer = document.querySelector(${JSON.stringify(GROK_COMPOSER_SELECTOR)});
        if (!composer) return false;
        composer.focus();
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        return true;
      })()`)
      attempted = true
      progress.submission = 'uncertain'
    }

    await this.confirmSubmission(driver, prompt, signal, progress, baselineUserTurns)
  }

  private async confirmSubmission(
    driver: PageDriver,
    prompt: string,
    signal: AbortSignal,
    progress: WebTurnProgress,
    baselineUserTurns: number,
  ): Promise<void> {
    progress.enter('confirm')
    if (progress.submission === 'none') progress.submission = 'uncertain'
    const deadline = Date.now() + SUBMIT_CONFIRM_TIMEOUT_MS
    const expected = composerKey(prompt)
    while (Date.now() < deadline) {
      if (signal.aborted) break
      const state = await driver.evaluate<{ composerCleared: boolean; busy: boolean; userTurns: number; assistants: number }>(`(() => {
        const composer = document.querySelector(${JSON.stringify(GROK_COMPOSER_SELECTOR)});
        const text = composer instanceof HTMLTextAreaElement ? composer.value : (composer?.innerText || '');
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const users = Array.from(document.querySelectorAll(${JSON.stringify(GROK_USER_TURN_SELECTOR)})).filter(visible).length;
        const assistants = Array.from(document.querySelectorAll(${JSON.stringify(GROK_ASSISTANT_TURN_SELECTOR)})).filter(visible).length;
        const stops = Array.from(document.querySelectorAll(${JSON.stringify(GROK_STOP_BUTTON_SELECTOR)})).filter(visible);
        const composerCleared = text.replace(/\\s+/g, '') !== ${JSON.stringify(expected)};
        return {
          composerCleared,
          busy: stops.length > 0,
          userTurns: users,
          assistants,
        };
      })()`).catch(() => undefined)
      if (state && (state.userTurns > baselineUserTurns || (state.composerCleared && (state.busy || state.assistants > 0)))) {
        progress.submission = 'confirmed'
        return
      }
      await sleep(SUBMIT_CONFIRM_POLL_MS)
    }
    throw new WebTurnError({
      code: 'submission-uncertain',
      message: "Grok Web did not confirm that it accepted the message. The message may already have been sent — check ND's Browser pane before resending; ND will not resend it automatically.",
      phase: 'confirm',
      submission: 'uncertain',
      transport: progress.transport,
    })
  }

  private async readComposerText(driver: PageDriver): Promise<string> {
    return await driver.evaluate<string>(`(() => {
      const composer = document.querySelector(${JSON.stringify(GROK_COMPOSER_SELECTOR)});
      return composer instanceof HTMLTextAreaElement ? composer.value : (composer?.innerText || '');
    })()`)
  }

  private async readUserTurnCount(driver: PageDriver): Promise<number> {
    return await driver.evaluate<number>(`(() => {
      return Array.from(document.querySelectorAll(${JSON.stringify(GROK_USER_TURN_SELECTOR)}))
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length;
    })()`)
  }

  private async waitForAssistant(
    driver: PageDriver,
    session: StoredGrokWebSession,
    baselineAssistantCount: number,
    signal: AbortSignal,
  ): Promise<GrokDomSnapshot> {
    const deadline = Date.now() + GROK_TURN_TIMEOUT_MS
    const startedAt = Date.now()
    let stableText = ''
    let stableCount = 0
    let polls = 0
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('Grok Web turn was stopped.')
      const snapshot = await this.captureSnapshot(driver)
      this.throwStopConditions(snapshot)
      this.captureConversationUrl(session, snapshot.url)
      const assistants = snapshot.turns.filter((turn) => turn.role === 'assistant')
      const latest = assistants.at(-1)?.text.trim() ?? ''
      if (session.isolated && polls % 10 === 0) {
        this.options.log?.(
          `[grok-web] isolated wait polls=${polls} complete=${snapshot.complete} busy=${snapshot.busy} assistants=${assistants.length}/${baselineAssistantCount} stable=${stableCount} latest=${latest.length}`,
        )
      }
      polls += 1
      if (assistants.length > baselineAssistantCount && latest) {
        if (latest === stableText) stableCount += 1
        else {
          stableText = latest
          stableCount = 0
        }
        if (!snapshot.busy && (snapshot.complete || stableCount >= TURN_STABLE_POLLS + 8)) return snapshot
      } else if (assistants.length <= baselineAssistantCount && snapshot.complete && !snapshot.busy
        && Date.now() - startedAt > 45_000) {
        throw new WebTurnError({
          code: 'empty-reply',
          message: "Grok finished without rendering a reply. Keep ND's window on screen and the Browser pane available, then resend this message.",
          phase: 'wait',
        })
      }
      await sleep(TURN_POLL_MS)
    }
    throw new Error('Grok Web turn exceeded the 10 minute completion deadline.')
  }

  private async captureSnapshot(driver: PageDriver): Promise<GrokDomSnapshot> {
    return driver.evaluate<GrokDomSnapshot>(`(() => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return true;
        let cur = el;
        while (cur && cur.nodeType === 1) {
          if (cur.hidden || cur.getAttribute?.('aria-hidden') === 'true') return false;
          const style = window.getComputedStyle(cur);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          cur = cur.parentElement;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const composers = Array.from(document.querySelectorAll(${JSON.stringify(GROK_COMPOSER_SELECTOR)})).filter(isVisible);
      const composer = composers.at(-1) ?? null;

      const turns = [];
      const nodes = [];

      for (const el of Array.from(document.querySelectorAll(${JSON.stringify(GROK_USER_TURN_SELECTOR)}))) {
        if (isVisible(el)) nodes.push({ el, role: 'user', text: (el.innerText || '').trim() });
      }

      for (const el of Array.from(document.querySelectorAll(${JSON.stringify(GROK_ASSISTANT_TURN_SELECTOR)}))) {
        if (!isVisible(el) || el.closest(${JSON.stringify(GROK_USER_TURN_SELECTOR)})) continue;
        nodes.push({ el, role: 'assistant', text: (el.innerText || '').trim() });
      }

      nodes.sort((a, b) => {
        if (a.el === b.el) return 0;
        return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });

      for (const node of nodes) {
        if (node.text) turns.push({ role: node.role, text: node.text });
      }

      const stops = Array.from(document.querySelectorAll(${JSON.stringify(GROK_STOP_BUTTON_SELECTOR)})).filter(isVisible);
      const buttons = Array.from(document.querySelectorAll(${JSON.stringify(GROK_BUTTON_SELECTOR)})).filter(isVisible);
      const sendButton = buttons.at(-1) ?? null;
      const isTextArea = typeof HTMLTextAreaElement !== 'undefined'
        ? composer instanceof HTMLTextAreaElement
        : composer && 'value' in composer;
      const composerText = isTextArea ? (composer.value || '') : (composer?.innerText || '');
      const sendDisabled = sendButton
        ? ((typeof HTMLButtonElement !== 'undefined' && sendButton instanceof HTMLButtonElement)
          ? sendButton.disabled
          : sendButton.getAttribute('aria-disabled') === 'true' || /(?:^|\\s)\\S*disabled\\S*(?:\\s|$)/i.test(String(sendButton.className || '')))
        : true;

      const isBusy = stops.length > 0;
      const host = location.hostname;
      const body = document.body?.innerText || '';
      const signInPath = /\\/sign_?in|\\/login|\\/auth/i.test(location.pathname);
      const hasPasswordField = document.querySelector('input[type="password"]') !== null;

      return {
        url: location.href,
        title: document.title,
        composer: Boolean(composer),
        composerText,
        busy: isBusy,
        complete: !isBusy && (Boolean(sendButton) || turns.length > 0),
        pendingSend: false,
        challenge: host === 'challenges.cloudflare.com' || /just a moment|checking your browser|verify you are human|unusual traffic/i.test(document.title + ' ' + body),
        loginRequired: signInPath || ((host.endsWith('grok.com') || host.endsWith('x.ai')) && !composer && hasPasswordField)
          || ((host.endsWith('grok.com') || host.endsWith('x.ai')) && !composer && /log in|sign in/i.test(body)),
        rateLimited: /rate limit|too many requests|server busy|temporarily unavailable/i.test(body),
        sendEnabled: Boolean(sendButton) && !sendDisabled && !isBusy,
        userTurns: nodes.filter((node) => node.role === 'user').length,
        turns,
      };
    })()`)
  }

  private importUnseenTurns(session: StoredGrokWebSession, snapshot: GrokDomSnapshot): void {
    if (snapshot.busy) return
    const seen = new Set(session.seenTurnKeys)
    const sent = new Set(session.sentPromptHashes)
    const assistantIndices = snapshot.turns
      .map((turn, index) => (turn.role === 'assistant' ? index : -1))
      .filter((index) => index >= 0)
    let changed = false
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
          const position = assistantIndices.indexOf(index)
          const offsetFromEnd = position >= 0 ? assistantIndices.length - 1 - position : 0
          this.updateAssistantMessageFromEnd(session, turn.text, offsetFromEnd)
        }
        awaitingEcho = false
        changed = true
        return
      }
      const strippedUserText = turn.role === 'user' ? (stripWorkspaceContext(turn.text).trim() || turn.text) : turn.text
      if (turn.role === 'user' && (sent.has(hashText(turn.text)) || sent.has(hashText(strippedUserText)) || (awaitingEcho && IMAGE_ECHO_PATTERN.test(turn.text)))) {
        seen.add(key)
        awaitingEcho = false
        changed = true
        return
      }
      if (turn.role === 'user') this.recordUserMessage(session, strippedUserText)
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

  private markAllTurnsSeen(session: StoredGrokWebSession, snapshot: GrokDomSnapshot): void {
    session.seenTurnKeys = trimArray(snapshot.turns.map((turn, index) => domTurnKey(turn, index)), 500)
    this.persistStore()
  }

  private rememberSentPrompt(session: StoredGrokWebSession, prompt: string): void {
    session.sentPromptHashes = trimArray([...session.sentPromptHashes, hashText(prompt)], 100)
    this.persistStore()
  }

  private captureConversationUrl(session: StoredGrokWebSession, url: string): void {
    if (!isGrokConversationUrl(url)) return
    if (session.conversationUrl === url) return
    session.conversationUrl = url
    session.updatedAt = Date.now()
    this.persistStore()
  }

  private recordUserMessage(session: StoredGrokWebSession, text: string, images?: readonly HarnessRunImage[]): void {
    session.sequence += 1
    const event: SessionEventEnvelope = {
      type: 'user/message',
      seq: session.sequence,
      time: Date.now(),
      data: {
        message: {
          role: 'user',
          content: [
            { type: 'text', text },
            ...(images?.map((img) => ({ type: 'image', mediaType: img.mediaType, data: img.data })) ?? []),
          ],
        },
      },
    }
    session.transcript.push(event)
    session.updatedAt = Date.now()
    this.persistStore()
    if (!session.hidden) this.emitFrame({ kind: 'session-event', sessionId: session.sessionId, event })
  }

  private recordAssistantMessage(session: StoredGrokWebSession, text: string): void {
    session.sequence += 1
    const event: SessionEventEnvelope = {
      type: 'assistant/message',
      seq: session.sequence,
      time: Date.now(),
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text }],
        },
      },
    }
    session.transcript.push(event)
    session.updatedAt = Date.now()
    this.persistStore()
    if (!session.hidden) this.emitFrame({ kind: 'session-event', sessionId: session.sessionId, event })
  }

  private updateAssistantMessageFromEnd(session: StoredGrokWebSession, text: string, offsetFromEnd: number): void {
    const assistants = session.transcript
      .map((event, index) => (event.type === 'assistant/message' ? index : -1))
      .filter((index) => index >= 0)
    const targetIndex = assistants[assistants.length - 1 - offsetFromEnd]
    if (targetIndex === undefined) return
    const target = session.transcript[targetIndex]
    if (!target) return
    const message = (target.data as { message?: { content?: Array<{ type?: string; text?: string }> } } | undefined)?.message
    if (!message || !Array.isArray(message.content)) return
    const item = message.content.find((entry) => entry?.type === 'text')
    if (item && item.text !== text) {
      item.text = text
      target.time = Date.now()
      session.updatedAt = Date.now()
      this.persistStore()
      if (!session.hidden) this.emitFrame({ kind: 'session-event', sessionId: session.sessionId, event: target })
    }
  }

  private browserMayHostSession(session: StoredGrokWebSession): boolean {
    if (!session.browserTabId) return false
    const url = this.options.browser.tabUrl(session.browserTabId)
    return Boolean(url && isGrokPageUrl(url))
  }

  private async watchTick(): Promise<void> {
    if (this.watcherBusy) return
    this.watcherBusy = true
    try {
      for (const session of this.sessions.values()) {
        if (session.hidden || session.running || !this.browserMayHostSession(session)) continue
        try {
          const tabId = session.browserTabId!
          const driver = new ElectronPageDriver(this.options.browser, tabId, GROK_ORIGINS)
          try {
            const snapshot = await this.captureSnapshot(driver)
            this.importUnseenTurns(session, snapshot)
          } finally {
            driver.close()
          }
        } catch {
          // background sync skipped on error
        }
      }
    } finally {
      this.watcherBusy = false
    }
  }

  private emitFrame(frame: DshEventFrame): void {
    try {
      this.onEvent?.(frame)
    } catch {
      // emitter failed
    }
  }

  private requireSession(sessionId: string): StoredGrokWebSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown ${GROK_WEB_ENGINE_ID} session: ${sessionId}`)
    return session
  }

  private loadStore(): void {
    if (!existsSync(this.options.storePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.options.storePath, 'utf8')) as PersistedGrokWebStore
      if (parsed.version === 1 && Array.isArray(parsed.sessions)) {
        for (const session of parsed.sessions) {
          if (typeof session.sessionId !== 'string' || !session.sessionId.startsWith('grok-web-')) continue
          this.sessions.set(session.sessionId, {
            ...session,
            running: false,
            transcript: Array.isArray(session.transcript)
              ? session.transcript.filter((ev) => ev && TRANSCRIPT_EVENT_TYPES.has(ev.type)).slice(-MAX_TRANSCRIPT_EVENTS)
              : [],
            seenTurnKeys: Array.isArray(session.seenTurnKeys) ? session.seenTurnKeys.slice(-500) : [],
            sentPromptHashes: Array.isArray(session.sentPromptHashes) ? session.sentPromptHashes.slice(-100) : [],
          })
        }
        if (parsed.modeSettings) {
          this.modeSettings = normalizeWebBrowserModeSettings(parsed.modeSettings)
        }
      }
    } catch (error) {
      this.options.log?.(`[grok-web] ignoring unreadable session store: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private persistStore(): void {
    const directory = dirname(this.options.storePath)
    mkdirSync(directory, { recursive: true })
    const tmp = `${this.options.storePath}.${process.pid}.${randomUUID()}.tmp`
    const payload: PersistedGrokWebStore = {
      version: 1,
      sessions: [...this.sessions.values()].filter((session) => session.hidden !== true),
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

const GROK_FILE_INPUT_EXPRESSION = `(() => {
  const composer = document.querySelector(${JSON.stringify(GROK_COMPOSER_SELECTOR)});
  let scope = composer;
  for (let depth = 0; depth < 9 && scope; depth += 1) {
    const input = scope.querySelector('input[type="file"]');
    if (input instanceof HTMLInputElement) return input;
    scope = scope.parentElement;
  }
  const anyInput = document.querySelector('input[type="file"]');
  if (anyInput instanceof HTMLInputElement) return anyInput;
  return null;
})()`

const GROK_ATTACHMENT_STATE_SCRIPT = `(() => {
  const fileUi = document.querySelectorAll('[class*="file"], [class*="attachment"], [class*="upload"], img[src^="blob:"], img[src^="data:"]');
  return {
    count: fileUi.length,
    uploading: /uploading|upload failed/i.test(document.body?.innerText || ''),
  };
})()`

function hashText(value: string): string {
  return createHash('sha256').update(value.trim()).digest('hex')
}

function composerKey(text: string): string {
  return text.replace(/\s+/g, '')
}

function promptMatchesDom(domText: string, prompt: string): boolean {
  const text = domText.trim()
  return text === prompt.trim() || text.includes(prompt.trim())
}

function userMessageText(event: SessionEventEnvelope): string | undefined {
  const message = (event.data as { message?: { content?: Array<{ type?: string; text?: string }> } } | undefined)?.message
  return message?.content?.find((content) => content.type === 'text')?.text
}

function domTurnKey(turn: GrokDomTurn, index: number): string {
  return `${index}:${turn.role}:${hashText(turn.text)}`
}

function trimArray<T>(values: T[], limit: number): T[] {
  return values.length <= limit ? values : values.slice(values.length - limit)
}

function isGrokPageUrl(value: string): boolean {
  try {
    const origin = new URL(value).origin
    return origin === GROK_ORIGINS[0] || origin === GROK_ORIGINS[1]
  } catch {
    return false
  }
}

function isGrokConversationUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.origin === GROK_ORIGINS[0] || url.origin === GROK_ORIGINS[1]) && (/^\/(?:chat|c)\/[^/?#]+/.test(url.pathname) || url.searchParams.has('chat'))
  } catch {
    return false
  }
}

function sameGrokUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left)
    const b = new URL(right)
    return a.origin === b.origin && a.pathname === b.pathname
  } catch {
    return left === right
  }
}

function assertTurnActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Grok Web turn was stopped.')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
