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
import { DEEPSEEK_WEB_ENGINE_ID } from '../../../shared/coding-engines.js'
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

const DEEPSEEK_HOME_URL = 'https://chat.deepseek.com/'
const DEEPSEEK_ORIGINS = ['https://chat.deepseek.com'] as const
// Observed on chat.deepseek.com: the composer is a textarea inside the
// ds-textarea wrapper, the send/stop control is the last circular ds-button in
// that wrapper, answers render as .ds-markdown, and user turns use .fbb737a4.
const DEEPSEEK_COMPOSER_SELECTOR = 'textarea.ds-textarea__textarea, textarea[placeholder*="DeepSeek" i], textarea'
const DEEPSEEK_USER_TURN_SELECTOR = '.fbb737a4'
const DEEPSEEK_ASSISTANT_TURN_SELECTOR = '.ds-markdown'
const DEEPSEEK_CIRCLE_BUTTON_SELECTOR = '[role="button"].ds-button--circle, button.ds-button--circle'
const DEEPSEEK_MODELS: EngineModelOption[] = [
  { id: 'default', name: 'Page default' },
  { id: 'deep-think', name: 'DeepThink' },
]
const TRANSCRIPT_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'agent/reasoning'])
const MAX_TRANSCRIPT_EVENTS = 500
const MAX_PROMPT_CHARS = 100_000
const DEEPSEEK_READY_TIMEOUT_MS = 20_000
const DEEPSEEK_TURN_TIMEOUT_MS = 10 * 60_000
const ATTACHMENT_TIMEOUT_MS = 60_000
const ATTACHMENT_POLL_MS = 300
const SUBMIT_CONFIRM_POLL_MS = 150
const SUBMIT_CONFIRM_TIMEOUT_MS = 12_000
const TURN_POLL_MS = 350
const TURN_STABLE_POLLS = 4
const BACKGROUND_WATCH_MS = 5_000
const IMAGE_ECHO_PATTERN = /^(?:\s*!\[[^\]]*\]\([^)]*\)\s*)+$/

interface StoredDeepSeekWebSession {
  sessionId: string
  conversationUrl?: string
  /** ND browser tab owned by this chat; recreated if the user closes it. */
  browserTabId?: string
  /** Chrome-style profile that owns this chat's browser tab and sign-in. */
  browserProfileId?: string
  cwd?: string
  title: string
  createdAt: number
  updatedAt: number
  running: boolean
  /** Router-owned turns stay out of the chat sidebar and restart persistence. */
  hidden?: boolean
  /** Skip project context for private router turns. */
  isolated?: boolean
  sequence: number
  transcript: SessionEventEnvelope[]
  seenTurnKeys: string[]
  sentPromptHashes: string[]
  uncertainPromptHashes?: string[]
}

interface PersistedDeepSeekWebStore {
  version: 1
  sessions: StoredDeepSeekWebSession[]
  modeSettings?: WebBrowserModeSettings
}

interface ActiveDeepSeekTurn {
  controller: AbortController
  progress?: WebTurnProgress | undefined
}

interface DeepSeekDomTurn {
  role: 'user' | 'assistant'
  text: string
}

interface DeepSeekDomSnapshot {
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
  turns: DeepSeekDomTurn[]
}

export interface DeepSeekWebEngineOptions {
  browser: BrowserController
  workspace: WorkspaceService
  storePath: string
  log?: (line: string) => void
}

/**
 * DeepSeek Web is a conversation transport over ND's already-visible browser
 * tab. It keeps conversation state on chat.deepseek.com and never assumes
 * filesystem, shell, Git, or project-scoped provider tools.
 */
export class DeepSeekWebEngine {
  private readonly sessions = new Map<string, StoredDeepSeekWebSession>()
  private readonly activeTurns = new Map<string, ActiveDeepSeekTurn>()
  private modeSettings: WebBrowserModeSettings = { ...DEFAULT_WEB_BROWSER_MODE_SETTINGS }
  private onEvent: ((frame: DshEventFrame) => void) | undefined
  private watcherBusy = false
  private readonly watchTimer: ReturnType<typeof setInterval>

  constructor(private readonly options: DeepSeekWebEngineOptions) {
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

  /** Open (or recreate) this chat's browser tab without running a turn. */
  async ensureBrowserTab(sessionId: string): Promise<string | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    const targetUrl = session.conversationUrl && isDeepSeekConversationUrl(session.conversationUrl)
      ? session.conversationUrl
      : DEEPSEEK_HOME_URL
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
    throw new Error(`Unknown ${DEEPSEEK_WEB_ENGINE_ID} approval: ${rpcId}`)
  }

  listSessions(): EngineSessionSummary[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => ({
        sessionId: session.sessionId,
        engineId: DEEPSEEK_WEB_ENGINE_ID,
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
    return { sessionId, engineId: DEEPSEEK_WEB_ENGINE_ID, events: [...session.transcript] }
  }

  async listModels(): Promise<EngineModelOption[]> {
    return DEEPSEEK_MODELS.map((model) => ({ ...model }))
  }

  async createSession(input: { cwd?: string; hidden?: boolean; isolated?: boolean; title?: string; profileId?: string } = {}): Promise<{ sessionId: string }> {
    const sessionId = `deepseek-web-${randomUUID()}`
    const now = Date.now()
    const profileId = createdProfileId(this.options.browser, input.profileId)
    const session: StoredDeepSeekWebSession = {
      sessionId,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      title: input.title?.trim() || 'New DeepSeek Web chat',
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
    if (!session.hidden) this.emitFrame({ kind: 'session-added', sessionId, meta: { engineId: DEEPSEEK_WEB_ENGINE_ID } })
    return { sessionId }
  }

  async run(prompt: string, input: { sessionId?: string; cwd?: string; images?: HarnessRunImage[]; model?: string; isolated?: boolean; transports?: WebBrowserTransport[] } = {}): Promise<{ sessionId: string }> {
    const cleaned = stripWorkspaceContext(prompt).trim()
    if (!cleaned) throw new Error('Prompt cannot be empty')
    if (cleaned.length > MAX_PROMPT_CHARS) throw new Error(`Prompt exceeds the ${MAX_PROMPT_CHARS.toLocaleString()} character limit`)

    let session = input.sessionId === undefined ? undefined : this.sessions.get(input.sessionId)
    if (input.sessionId !== undefined && !session) throw new Error(`Unknown ${DEEPSEEK_WEB_ENGINE_ID} session: ${input.sessionId}`)
    if (!session) {
      const created = await this.createSession({
        cwd: input.cwd ?? this.options.workspace.state().root,
        ...(input.isolated ? { isolated: true } : {}),
      })
      session = this.sessions.get(created.sessionId)
    }
    if (!session) throw new Error(`${DEEPSEEK_WEB_ENGINE_ID} session could not be created`)
    if (input.isolated) session.isolated = true
    if (session.running) throw new Error('This DeepSeek Web chat already has an active turn')
    if ([...this.sessions.values()].some((candidate) => candidate.running && candidate.sessionId !== session.sessionId)) {
      throw new Error('DeepSeek Web uses ND\'s single visible browser pane. Finish the active DeepSeek Web turn before starting another one.')
    }

    const hasImages = (input.images?.length ?? 0) > 0
    const availability: WebTransportAvailability = {
      extension: true,
      cdp: Boolean(this.options.browser.state().cdpPort),
      // DeepSeek's custom controls expose no stable semantic labels, so the
      // observe/act Browser Agent is not a viable fallback yet.
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
    const activeTurn: ActiveDeepSeekTurn = { controller: abort }
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
            this.options.log?.(`[deepseek-web] ${transport} failed (${turnError.message}); falling back to ${transports[index + 1]}`)
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
      : [this.sessions.get(sessionId)].filter((session): session is StoredDeepSeekWebSession => session?.running === true)
    for (const session of targets) {
      const activeTurn = this.activeTurns.get(session.sessionId)
      activeTurn?.controller.abort()
      if (!activeTurn?.progress || activeTurn.progress.submission === 'none') continue
      if (!this.browserMayHostSession(session)) continue
      try {
        const tabId = session.browserTabId && typeof this.options.browser.tabUrl === 'function'
          ? session.browserTabId
          : this.options.browser.activeTabId()
        const driver = new ElectronPageDriver(this.options.browser, tabId, DEEPSEEK_ORIGINS)
        try {
          await driver.evaluate<boolean>(`(() => {
            const composer = document.querySelector(${JSON.stringify(DEEPSEEK_COMPOSER_SELECTOR)});
            let scope = composer;
            for (let depth = 0; depth < 9 && scope; depth += 1) {
              const circles = Array.from(scope.querySelectorAll(${JSON.stringify(DEEPSEEK_CIRCLE_BUTTON_SELECTOR)}))
                .filter((el) => el.getBoundingClientRect().width > 0);
              if (circles.length > 0) {
                const button = circles.at(-1);
                const disabled = button instanceof HTMLButtonElement
                  ? button.disabled
                  : button?.getAttribute('aria-disabled') === 'true' || /(?:^|\\s)\\S*disabled\\S*(?:\\s|$)/i.test(String(button?.className || ''));
                // Generating swaps the same circle to an enabled Stop control.
                // A pending prompt still in the composer must never be sent by
                // a cancellation click.
                const isStop = Boolean(button) && !disabled && !(composer instanceof HTMLTextAreaElement ? composer.value : '').trim();
                if (isStop && button instanceof HTMLElement) { button.click(); return true; }
                break;
              }
              scope = scope.parentElement;
            }
            const stop = Array.from(document.querySelectorAll('button, [role="button"]'))
              .find((el) => /stop|停止/i.test(el.getAttribute('aria-label') || '') || /stop|停止/i.test(el.innerText || ''));
            if (stop instanceof HTMLElement) { stop.click(); return true; }
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

  /** Remove a router-owned session; keep its tab when the user must sign in. */
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

  /** Each chat owns its browser tab so switching chats switches conversations. */
  private async ensureSessionTab(session: StoredDeepSeekWebSession, targetUrl: string): Promise<string> {
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
      if (!sameDeepSeekUrl(currentUrl, targetUrl)) await browser.navigate(targetUrl, existing)
      return existing
    }
    const tab = await browser.createTab(targetUrl, !session.hidden, desiredProfile)
    session.browserTabId = tab.id
    this.persistStore()
    return tab.id
  }

  private conversationTarget(session: StoredDeepSeekWebSession): string {
    return session.conversationUrl && isDeepSeekConversationUrl(session.conversationUrl)
      ? session.conversationUrl
      : DEEPSEEK_HOME_URL
  }

  private async openBoundConversation(
    session: StoredDeepSeekWebSession,
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
      ? new ElectronPageDriver(this.options.browser, tabId, DEEPSEEK_ORIGINS)
      : await VisibleCdpConnection.connect(this.options.browser, { targetId, allowedOrigins: DEEPSEEK_ORIGINS })

    try {
      const deadline = Date.now() + DEEPSEEK_READY_TIMEOUT_MS
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
        message: "DeepSeek Web is open in ND's visible Browser pane, but its composer is unavailable. Sign in to chat.deepseek.com (or finish any verification challenge), then resend this message.",
        phase: 'open',
      })
    } catch (error) {
      driver.close()
      throw error
    }
  }

  private async runWithPageDriver(
    transport: WebBrowserTransport,
    session: StoredDeepSeekWebSession,
    cleanedPrompt: string,
    images: readonly HarnessRunImage[] | undefined,
    model: string | undefined,
    signal: AbortSignal,
    progress: WebTurnProgress,
  ): Promise<{ sessionId: string }> {
    progress.enter('open')
    // An interactive chat can be started while the ND Browser pane is closed.
    // DeepSeek only hydrates and streams its conversation while the tab's view
    // is visible, so keep the lane's own tab rendered in the 1px off-screen
    // viewport (the same contract router lanes use) without raising the window.
    const tabId = await this.ensureSessionTab(session, this.conversationTarget(session))
    let detachHeadless: (() => void) | undefined
    if (!session.hidden && !this.options.browser.state().visible) {
      if (!this.options.browser.windowIsOnScreen()) {
        throw new WebTurnError({
          code: 'page-busy',
          message: "DeepSeek Web needs ND's window on screen to render its reply. Restore the ND window, then resend this message.",
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

      if (session.title === 'New DeepSeek Web chat') session.title = cleanedPrompt.slice(0, 80)
      progress.enter('wait')
      const completed = await this.waitForAssistant(driver, session, baselineAssistantCount, signal)
      this.captureConversationUrl(session, completed.url)
      const assistant = [...completed.turns].reverse().find((turn) => turn.role === 'assistant')
      if (!assistant?.text.trim()) throw new Error('DeepSeek Web completed without a readable assistant message')
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

  /**
   * Send/stop share one circular control, so icon state is the only busy
   * signal. Any off-site redirect is treated as the user's own auth step.
   */
  private classifyTurnError(progress: WebTurnProgress, error: unknown): WebTurnError {
    const classified = progress.classify(error)
    if (!(error instanceof PageGuardError)) return classified
    const host = (() => { try { return new URL(error.origin).hostname } catch { return '' } })()
    if (host.endsWith('deepseek.com')) {
      return new WebTurnError({
        code: 'login-required',
        message: "DeepSeek Web needs you signed in to chat.deepseek.com in ND's visible Browser pane. Sign in there, then resend this message.",
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
      message: "DeepSeek is still answering or uploading in ND's Browser pane. Let it finish (or stop it), then resend this message.",
      phase: 'observe',
    })
  }

  private throwStopConditions(snapshot: DeepSeekDomSnapshot): void {
    if (snapshot.challenge) {
      throw new WebTurnError({
        code: 'challenge',
        message: "Cloudflare or DeepSeek is showing a verification challenge in ND's Browser pane. Complete the challenge and resend this message.",
        phase: 'observe',
      })
    }
    if (snapshot.loginRequired) {
      throw new WebTurnError({
        code: 'login-required',
        message: "DeepSeek Web needs you signed in to chat.deepseek.com in ND's visible Browser pane. Sign in there, then resend this message.",
        phase: 'observe',
      })
    }
    if (snapshot.rateLimited) {
      throw new WebTurnError({
        code: 'rate-limited',
        message: 'DeepSeek has rate limited requests. Wait a few moments, then try again.',
        phase: 'observe',
      })
    }
  }

  /**
   * DeepThink is the only pre-compose mode DeepSeek exposes. `default` keeps
   * whatever the signed-in page already selected; `deep-think` explicitly
   * presses the toggle and waits for aria-pressed to confirm it.
   */
  private async applyModel(driver: PageDriver, requested: string | undefined, signal: AbortSignal): Promise<void> {
    const model = requested?.trim().toLowerCase()
    if (!model || model === 'default') return
    if (model !== 'deep-think' && model !== 'deepthink' && model !== 'deepseek-reasoner' && model !== 'r1') {
      throw new Error(`DeepSeek Web does not offer the "${requested}" model. Pick Page default or DeepThink.`)
    }
    assertTurnActive(signal)
    const state = await driver.evaluate<{ found: boolean; pressed: boolean | null }>(`(() => {
      const composer = document.querySelector(${JSON.stringify(DEEPSEEK_COMPOSER_SELECTOR)});
      let scope = composer;
      for (let depth = 0; depth < 9 && scope; depth += 1) {
        const toggle = Array.from(scope.querySelectorAll('[aria-pressed]'))
          .find((el) => /deepthink|深度思考/i.test((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')));
        if (toggle) {
          const pressed = toggle.getAttribute('aria-pressed');
          return { found: true, pressed: pressed === null ? null : pressed === 'true' };
        }
        scope = scope.parentElement;
      }
      return { found: false, pressed: null };
    })()`)
    if (!state.found) throw new Error('DeepSeek Web did not expose its DeepThink toggle. Reload DeepSeek and retry with Page default.')
    if (state.pressed === true) return
    await driver.evaluate<boolean>(`(() => {
      const composer = document.querySelector(${JSON.stringify(DEEPSEEK_COMPOSER_SELECTOR)});
      let scope = composer;
      for (let depth = 0; depth < 9 && scope; depth += 1) {
        const toggle = Array.from(scope.querySelectorAll('[aria-pressed]'))
          .find((el) => /deepthink|深度思考/i.test((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')));
        if (toggle instanceof HTMLElement) { toggle.click(); return true; }
        scope = scope.parentElement;
      }
      return false;
    })()`)
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      assertTurnActive(signal)
      const pressed = await driver.evaluate<boolean | null>(`(() => {
        const toggle = Array.from(document.querySelectorAll('[aria-pressed]'))
          .find((el) => /deepthink|深度思考/i.test((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')));
        if (!toggle) return null;
        const value = toggle.getAttribute('aria-pressed');
        return value === null ? null : value === 'true';
      })()`)
      if (pressed === true) return
      await sleep(100)
    }
    throw new Error('DeepSeek Web did not apply DeepThink. Reload DeepSeek and retry.')
  }

  private async clearStaleAttachments(driver: PageDriver): Promise<void> {
    await driver.evaluate<boolean>(`(() => {
      const composer = document.querySelector(${JSON.stringify(DEEPSEEK_COMPOSER_SELECTOR)});
      let scope = composer;
      for (let depth = 0; depth < 9 && scope; depth += 1) {
        const removers = Array.from(scope.querySelectorAll('button, [role="button"]'))
          .filter((el) => /^(remove|delete|移除|删除)\\b/i.test((el.getAttribute('aria-label') || '').trim()));
        if (removers.length > 0) {
          removers.forEach((el) => { if (el instanceof HTMLElement) el.click(); });
          return true;
        }
        scope = scope.parentElement;
      }
      return false;
    })()`).catch(() => false)
  }

  /**
   * DeepSeek accepts images through its own uploader. The hidden file input is
   * mounted with the composer; each upload is settled when the preview count
   * grows and the composer stops reporting an upload.
   */
  private async attachImages(driver: PageDriver, images: readonly HarnessRunImage[], signal: AbortSignal): Promise<StagedWebImages | undefined> {
    if (images.length === 0) return undefined
    assertTurnActive(signal)
    let staged: StagedWebImages | undefined
    try {
      staged = stageWebImages(images)
      const hasInput = await driver.evaluate<boolean>(`${DEEPSEEK_FILE_INPUT_EXPRESSION} !== null`)
      if (!hasInput) throw new Error('DeepSeek Web has no file input in ND\'s Browser pane. Sign in to chat.deepseek.com, then resend this message.')
      await this.clearStaleAttachments(driver)
      await sleep(200)
      const baseline = await driver.evaluate<{ count: number; uploading: boolean }>(DEEPSEEK_ATTACHMENT_STATE_SCRIPT)
      assertTurnActive(signal)
      if (!await driver.setFilesOnInput(DEEPSEEK_FILE_INPUT_EXPRESSION, staged.files)) {
        throw new Error('DeepSeek Web did not expose its file input. Reload DeepSeek and resend this message.')
      }
      const deadline = Date.now() + ATTACHMENT_TIMEOUT_MS
      while (Date.now() < deadline) {
        assertTurnActive(signal)
        const state = await driver.evaluate<{ count: number; uploading: boolean }>(DEEPSEEK_ATTACHMENT_STATE_SCRIPT)
        if (state.count >= baseline.count + images.length && !state.uploading) return staged
        await sleep(ATTACHMENT_POLL_MS)
      }
      throw new Error('DeepSeek Web did not finish attaching the image in time. Try a smaller PNG, JPEG, WebP, or GIF and resend.')
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
        const composers = Array.from(document.querySelectorAll(${JSON.stringify(DEEPSEEK_COMPOSER_SELECTOR)}));
        const composer = composers.at(-1);
        if (!(composer instanceof HTMLTextAreaElement)) return false;
        composer.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(composer, ${JSON.stringify(prompt)});
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`)
      if (!typed) throw new Error('DeepSeek Web composer is unavailable.')
      await sleep(250)
      if (composerKey(await this.readComposerText(driver)) === expected) {
        await sleep(250)
        accepted = composerKey(await this.readComposerText(driver)) === expected
      }
      if (!accepted) await sleep(200)
    }
    if (!accepted) throw new Error('DeepSeek Web composer did not keep the full message. Reload DeepSeek and retry.')

    progress.enter('submit')
    const baselineUserTurns = await this.readUserTurnCount(driver)
    let attempted = false
    let sent = false
    for (let index = 0; index < 100 && !sent; index += 1) {
      assertTurnActive(signal)
      const clicked = await driver.evaluate<boolean>(`(() => {
        const composer = Array.from(document.querySelectorAll(${JSON.stringify(DEEPSEEK_COMPOSER_SELECTOR)})).at(-1);
        if (!composer) return false;
        let scope = composer;
        for (let depth = 0; depth < 9 && scope; depth += 1) {
          const circles = Array.from(scope.querySelectorAll(${JSON.stringify(DEEPSEEK_CIRCLE_BUTTON_SELECTOR)}))
            .filter((el) => {
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
          if (circles.length > 0) {
            const button = circles.at(-1);
            if (!(button instanceof HTMLElement)) return false;
            const disabled = button instanceof HTMLButtonElement
              ? button.disabled
              : button.getAttribute('aria-disabled') === 'true' || /(?:^|\\s)\\S*disabled\\S*(?:\\s|$)/i.test(String(button.className || ''));
            if (disabled) return false;
            button.click();
            return true;
          }
          scope = scope.parentElement;
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
      // React listens to the textarea's keydown; Enter is the page's own send
      // gesture when the circular control cannot be identified.
      await driver.evaluate<boolean>(`(() => {
        const composer = Array.from(document.querySelectorAll(${JSON.stringify(DEEPSEEK_COMPOSER_SELECTOR)})).at(-1);
        if (!(composer instanceof HTMLTextAreaElement)) return false;
        composer.focus();
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        return true;
      })()`)
      attempted = true
      progress.submission = 'uncertain'
    }
    await this.confirmSubmission(driver, prompt, signal, progress, baselineUserTurns)
  }

  /**
   * A new user turn is the strongest acceptance proof; a cleared composer plus
   * an active reply is the fallback while the message renders. Never assert
   * `confirmed` without one of them.
   */
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
        const composer = Array.from(document.querySelectorAll(${JSON.stringify(DEEPSEEK_COMPOSER_SELECTOR)})).at(-1);
        const text = composer instanceof HTMLTextAreaElement ? composer.value : '';
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const users = Array.from(document.querySelectorAll(${JSON.stringify(DEEPSEEK_USER_TURN_SELECTOR)})).filter(visible).length;
        const assistants = Array.from(document.querySelectorAll(${JSON.stringify(DEEPSEEK_ASSISTANT_TURN_SELECTOR)}))
          .filter((el) => visible(el) && !el.closest('.ds-think-content')).length;
        let scope = composer;
        let send = null;
        for (let depth = 0; depth < 9 && scope; depth += 1) {
          const circles = Array.from(scope.querySelectorAll(${JSON.stringify(DEEPSEEK_CIRCLE_BUTTON_SELECTOR)})).filter(visible);
          if (circles.length > 0) { send = circles.at(-1); break; }
          scope = scope.parentElement;
        }
        const sendDisabled = send
          ? (send instanceof HTMLButtonElement
            ? send.disabled
            : send.getAttribute('aria-disabled') === 'true' || /(?:^|\\s)\\S*disabled\\S*(?:\\s|$)/i.test(String(send.className || '')))
          : true;
        const composerCleared = text.replace(/\\s+/g, '') !== ${JSON.stringify(expected)};
        return {
          composerCleared,
          busy: Boolean(send) && !sendDisabled && !text.trim(),
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
      message: "DeepSeek Web did not confirm that it accepted the message. The message may already have been sent — check ND's Browser pane before resending; ND will not resend it automatically.",
      phase: 'confirm',
      submission: 'uncertain',
      transport: progress.transport,
    })
  }

  private async readComposerText(driver: PageDriver): Promise<string> {
    return await driver.evaluate<string>(`(() => {
      const composer = Array.from(document.querySelectorAll(${JSON.stringify(DEEPSEEK_COMPOSER_SELECTOR)})).at(-1);
      return composer instanceof HTMLTextAreaElement ? composer.value : '';
    })()`)
  }

  private async readUserTurnCount(driver: PageDriver): Promise<number> {
    return await driver.evaluate<number>(`(() => {
      return Array.from(document.querySelectorAll(${JSON.stringify(DEEPSEEK_USER_TURN_SELECTOR)}))
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length;
    })()`)
  }

  private async waitForAssistant(
    driver: PageDriver,
    session: StoredDeepSeekWebSession,
    baselineAssistantCount: number,
    signal: AbortSignal,
  ): Promise<DeepSeekDomSnapshot> {
    const deadline = Date.now() + DEEPSEEK_TURN_TIMEOUT_MS
    const startedAt = Date.now()
    let stableText = ''
    let stableCount = 0
    let polls = 0
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('DeepSeek Web turn was stopped.')
      const snapshot = await this.captureSnapshot(driver)
      this.throwStopConditions(snapshot)
      this.captureConversationUrl(session, snapshot.url)
      const assistants = snapshot.turns.filter((turn) => turn.role === 'assistant')
      const latest = assistants.at(-1)?.text.trim() ?? ''
      if (session.isolated && polls % 10 === 0) {
        this.options.log?.(
          `[deepseek-web] isolated wait polls=${polls} complete=${snapshot.complete} busy=${snapshot.busy} assistants=${assistants.length}/${baselineAssistantCount} stable=${stableCount} latest=${latest.length}`,
        )
      }
      polls += 1
      if (assistants.length > baselineAssistantCount && latest) {
        if (latest === stableText) stableCount += 1
        else {
          stableText = latest
          stableCount = 0
        }
        // DeepSeek's stop control stays enabled through reasoning pauses, so
        // the disabled Send state is the completion proof; stable text remains
        // a fallback if a future layout stops exposing that disabled state.
        if (!snapshot.busy && (snapshot.complete || stableCount >= TURN_STABLE_POLLS + 8)) return snapshot
      } else if (assistants.length <= baselineAssistantCount && snapshot.complete && !snapshot.busy
        && Date.now() - startedAt > 45_000) {
        // A hidden or stalled renderer reports a finished composer without ever
        // mounting the answer. Fail with guidance instead of waiting ten minutes.
        throw new WebTurnError({
          code: 'empty-reply',
          message: "DeepSeek finished without rendering a reply. Keep ND's window on screen and the Browser pane available, then resend this message.",
          phase: 'wait',
        })
      }
      await sleep(TURN_POLL_MS)
    }
    throw new Error('DeepSeek Web turn exceeded the 10 minute completion deadline.')
  }

  private async captureSnapshot(driver: PageDriver): Promise<DeepSeekDomSnapshot> {
    return driver.evaluate<DeepSeekDomSnapshot>(`(() => {
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
      const composers = Array.from(document.querySelectorAll(${JSON.stringify(DEEPSEEK_COMPOSER_SELECTOR)})).filter(isVisible);
      const composer = composers.at(-1) ?? null;
      const turns = [];
      const nodes = [];
      for (const el of Array.from(document.querySelectorAll(${JSON.stringify(DEEPSEEK_USER_TURN_SELECTOR)}))) {
        if (isVisible(el)) nodes.push({ el, role: 'user', text: (el.innerText || '').trim() });
      }
      for (const el of Array.from(document.querySelectorAll(${JSON.stringify(DEEPSEEK_ASSISTANT_TURN_SELECTOR)}))) {
        // DeepThink renders its reasoning into the same markdown class inside
        // .ds-think-content; only the final answer is a chat turn.
        if (!isVisible(el) || el.closest(${JSON.stringify(DEEPSEEK_USER_TURN_SELECTOR)}) || el.closest('.ds-think-content')) continue;
        nodes.push({ el, role: 'assistant', text: (el.innerText || '').trim() });
      }
      nodes.sort((a, b) => {
        if (a.el === b.el) return 0;
        return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
      for (const node of nodes) {
        if (node.text) turns.push({ role: node.role, text: node.text });
      }
      let sendControl = null;
      let scope = composer;
      for (let depth = 0; depth < 9 && scope; depth += 1) {
        const circles = Array.from(scope.querySelectorAll(${JSON.stringify(DEEPSEEK_CIRCLE_BUTTON_SELECTOR)})).filter(isVisible);
        if (circles.length > 0) { sendControl = circles.at(-1); break; }
        scope = scope.parentElement;
      }
      const composerText = composer instanceof HTMLTextAreaElement ? composer.value : (composer?.innerText || '');
      const sendDisabled = sendControl
        ? (sendControl instanceof HTMLButtonElement
          ? sendControl.disabled
          : sendControl.getAttribute('aria-disabled') === 'true' || /(?:^|\\s)\\S*disabled\\S*(?:\\s|$)/i.test(String(sendControl.className || '')))
        : true;
      // While a turn runs, DeepSeek swaps Send for an enabled Stop circle and
      // empties the composer. When the turn ends that same circle returns to
      // disabled Send. This survives DeepThink reasoning pauses.
      const sendIconStop = Boolean(sendControl) && !sendDisabled && !composerText.trim();
      const host = location.hostname;
      const body = document.body?.innerText || '';
      const signInPath = /\\/sign_?in|\\/login/i.test(location.pathname);
      const hasPasswordField = document.querySelector('input[type="password"]') !== null;
      return {
        url: location.href,
        title: document.title,
        composer: Boolean(composer),
        composerText,
        busy: sendIconStop,
        complete: Boolean(sendControl) && sendDisabled,
        pendingSend: false,
        challenge: host === 'challenges.cloudflare.com' || /just a moment|checking your browser|verify you are human|unusual traffic/i.test(document.title + ' ' + body),
        loginRequired: signInPath || (host === 'chat.deepseek.com' && !composer && hasPasswordField)
          || (host === 'chat.deepseek.com' && !composer && /log in|sign in|登录/i.test(body)),
        rateLimited: /rate limit|too many requests|server busy|temporarily unavailable|连续访问|服务器繁忙/i.test(body),
        sendEnabled: Boolean(sendControl) && !sendDisabled && !sendIconStop,
        userTurns: nodes.filter((node) => node.role === 'user').length,
        turns,
      };
    })()`)
  }

  private importUnseenTurns(session: StoredDeepSeekWebSession, snapshot: DeepSeekDomSnapshot): void {
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

  private markAllTurnsSeen(session: StoredDeepSeekWebSession, snapshot: DeepSeekDomSnapshot): void {
    session.seenTurnKeys = trimArray(snapshot.turns.map((turn, index) => domTurnKey(turn, index)), 500)
    this.persistStore()
  }

  private rememberSentPrompt(session: StoredDeepSeekWebSession, prompt: string): void {
    session.sentPromptHashes = trimArray([...session.sentPromptHashes, hashText(prompt)], 100)
    this.persistStore()
  }

  private captureConversationUrl(session: StoredDeepSeekWebSession, url: string): void {
    if (!isDeepSeekConversationUrl(url)) return
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
        (session) => !session.running && session.conversationUrl !== undefined && sameDeepSeekUrl(currentUrl, session.conversationUrl),
      )
      if (visibleSessions.length > 0) {
        try {
          const driver = new ElectronPageDriver(this.options.browser, this.options.browser.activeTabId(), DEEPSEEK_ORIGINS)
          try {
            const snapshot = await this.captureSnapshot(driver)
            for (const visibleSession of visibleSessions) this.importUnseenTurns(visibleSession, snapshot)
          } finally {
            driver.close()
          }
        } catch (error) {
          this.options.log?.(`[deepseek-web] visible conversation sync skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } finally {
      this.watcherBusy = false
    }
  }

  private recordUserMessage(session: StoredDeepSeekWebSession, text: string, images?: readonly HarnessRunImage[]): void {
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

  private recordAssistantMessage(session: StoredDeepSeekWebSession, text: string): void {
    this.recordEnvelope(session, {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
    })
  }

  private updateAssistantMessageFromEnd(session: StoredDeepSeekWebSession, text: string, offsetFromEnd: number): void {
    let seenFromEnd = 0
    for (let index = session.transcript.length - 1; index >= 0; index -= 1) {
      const entry = session.transcript[index]
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

  private recordEnvelope(session: StoredDeepSeekWebSession, partial: { type: string; data?: unknown }): void {
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

  private requireSession(sessionId: string): StoredDeepSeekWebSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown ${DEEPSEEK_WEB_ENGINE_ID} session: ${sessionId}`)
    return session
  }

  private browserMayHostSession(session: StoredDeepSeekWebSession): boolean {
    const currentUrl = session.browserTabId && typeof this.options.browser.tabUrl === 'function'
      ? this.options.browser.tabUrl(session.browserTabId) ?? ''
      : this.options.browser.state().url
    if (!isDeepSeekPageUrl(currentUrl)) return false
    return session.conversationUrl === undefined || sameDeepSeekUrl(currentUrl, session.conversationUrl)
  }

  private emitFrame(frame: DshEventFrame): void {
    if (frame.sessionId && this.sessions.get(frame.sessionId)?.hidden) return
    this.onEvent?.(frame)
  }

  private loadStore(): void {
    if (!existsSync(this.options.storePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.options.storePath, 'utf8')) as Partial<PersistedDeepSeekWebStore>
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return
      for (const candidate of parsed.sessions) {
        if (!candidate || typeof candidate !== 'object') continue
        const session = candidate as StoredDeepSeekWebSession
        if (typeof session.sessionId !== 'string' || !session.sessionId.startsWith('deepseek-web-')) continue
        if (session.hidden === true) continue
        if (typeof session.conversationUrl !== 'string' || !isDeepSeekConversationUrl(session.conversationUrl)) delete session.conversationUrl
        if (typeof session.browserTabId !== 'string' || session.browserTabId === '') delete session.browserTabId
        if (typeof session.browserProfileId !== 'string' || session.browserProfileId === '') delete session.browserProfileId
        session.running = false
        session.transcript = Array.isArray(session.transcript) ? session.transcript.slice(-MAX_TRANSCRIPT_EVENTS) : []
        session.seenTurnKeys = Array.isArray(session.seenTurnKeys) ? session.seenTurnKeys.slice(-500) : []
        session.sentPromptHashes = Array.isArray(session.sentPromptHashes) ? session.sentPromptHashes.slice(-100) : []
        session.uncertainPromptHashes = Array.isArray(session.uncertainPromptHashes) ? session.uncertainPromptHashes.slice(-50) : []
        session.sequence = Number.isSafeInteger(session.sequence) ? session.sequence : session.transcript.at(-1)?.seq ?? 0
        this.sessions.set(session.sessionId, session)
      }
      if (parsed.modeSettings && typeof parsed.modeSettings === 'object') {
        this.modeSettings = normalizeWebBrowserModeSettings(parsed.modeSettings)
      }
    } catch (error) {
      this.options.log?.(`[deepseek-web] ignoring unreadable session store: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private persistStore(): void {
    const directory = dirname(this.options.storePath)
    mkdirSync(directory, { recursive: true })
    const tmp = `${this.options.storePath}.${process.pid}.${randomUUID()}.tmp`
    const payload: PersistedDeepSeekWebStore = {
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

// Resolve the composer's own hidden uploader; a page-level input can belong to
// the avatar/profile menu and must never receive chat attachments.
const DEEPSEEK_FILE_INPUT_EXPRESSION = `(() => {
  const composer = Array.from(document.querySelectorAll(${JSON.stringify(DEEPSEEK_COMPOSER_SELECTOR)})).at(-1);
  let scope = composer;
  for (let depth = 0; depth < 9 && scope; depth += 1) {
    const input = scope.querySelector('input[type="file"]');
    if (input instanceof HTMLInputElement) return input;
    scope = scope.parentElement;
  }
  return null;
})()`

const DEEPSEEK_ATTACHMENT_STATE_SCRIPT = `(() => {
  const composer = Array.from(document.querySelectorAll(${JSON.stringify(DEEPSEEK_COMPOSER_SELECTOR)})).at(-1);
  let scope = composer;
  for (let depth = 0; depth < 9 && scope; depth += 1) {
    const fileUi = scope.querySelectorAll('[class*="file"], [class*="attachment"], [class*="upload"]');
    const images = scope.querySelectorAll('img[src^="blob:"], img[src^="data:"]');
    if (fileUi.length + images.length > 0 || depth >= 3) {
      return {
        count: Math.max(fileUi.length, images.length),
        uploading: /uploading|upload failed|上传中|解析中|解析失败/i.test(scope.innerText || ''),
      };
    }
    scope = scope.parentElement;
  }
  return { count: 0, uploading: false };
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

function domTurnKey(turn: DeepSeekDomTurn, index: number): string {
  return `${index}:${turn.role}:${hashText(turn.text)}`
}

function trimArray<T>(values: T[], limit: number): T[] {
  return values.length <= limit ? values : values.slice(values.length - limit)
}

function isDeepSeekPageUrl(value: string): boolean {
  try {
    return new URL(value).origin === DEEPSEEK_ORIGINS[0]
  } catch {
    return false
  }
}

function isDeepSeekConversationUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.origin === DEEPSEEK_ORIGINS[0] && /^\/(?:a\/)?chat\/s\/[^/?#]+/.test(url.pathname)
  } catch {
    return false
  }
}

function sameDeepSeekUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left)
    const b = new URL(right)
    return a.origin === b.origin && a.pathname === b.pathname
  } catch {
    return left === right
  }
}

function assertTurnActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('DeepSeek Web turn was stopped.')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
