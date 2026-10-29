import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  ChatGptProjectBinding,
  DshEventFrame,
  EngineSessionSummary,
  EngineSessionTranscript,
  HarnessRunImage,
  SessionEventEnvelope,
} from '../../../shared/contracts.js'
import { CHATGPT_WEB_ENGINE_ID } from '../../../shared/coding-engines.js'
import {
  DEFAULT_WEB_BROWSER_MODE_SETTINGS,
  normalizeWebBrowserModeSettings,
  type WebBrowserModeSettings,
  type WebBrowserTransport,
} from '../../../shared/browser-modes.js'
import { stripWorkspaceContext } from '../../../shared/workspace-context.js'
import type { BrowserController } from '../../browser/browser-controller.js'
import {
  BrowserAgentRunner,
  findCloseAttachmentElements,
  findComposerElement,
  findNewChatElement,
  findSendButtonElement,
} from '../../browser/browser-agent.js'
import { CHATGPT_DOM_TURNS_SCRIPT } from '../../browser/chatgpt-dom-turns.js'
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
import {
  type DiscoveredProjectItem,
  matchProjectByNameOrPrefix,
  parseChatGptConversationUrl,
  parseChatGptProjectInput,
} from './chatgpt-project-binding.js'

const CHATGPT_HOME_URL = 'https://chatgpt.com/'
const CHATGPT_ORIGINS = ['https://chatgpt.com'] as const
// Signed-in project pages use ProseMirror without the old prompt ID or Lexical
// attribute; signed-out guest chats use the mobile composer textarea instead.
const CHATGPT_COMPOSER_SELECTOR = '[data-testid="prompt-textarea"], #prompt-textarea, #mobile-composer-prompt, [contenteditable="true"][data-lexical-editor="true"], form .ProseMirror[contenteditable="true"], form .ProseMirror[contenteditable="plaintext-only"]'
// Camera/photo-capture inputs cannot be driven by CDP file assignment.
const CHATGPT_IMAGE_INPUT_EXPRESSION = `(() => {
  const imageInputs = Array.from(document.querySelectorAll('input[type="file"]')).filter((el) => el instanceof HTMLInputElement
    && !el.disabled
    && !el.hasAttribute('capture')
    && (el.accept || '').toLowerCase().includes('image/'));
  return imageInputs.at(-1) ?? null;
})()`
const CHATGPT_ATTACHMENT_STATE_SCRIPT = `(() => {
  const scope = document.querySelector('form') || document;
  const isRemover = (label) => /^Remove (?:file:|image:)/i.test(label) || /^Remove .+\\.[a-z0-9]{1,8}$/i.test(label);
  const removers = Array.from(scope.querySelectorAll('button[aria-label]'))
    .map((el) => el.getAttribute('aria-label') || '')
    .filter(isRemover)
    .map((label) => label.replace(/^Remove\\s+/i, '').trim());
  const images = scope.querySelectorAll('[aria-label="Attached images"] img');
  const chips = Array.from(scope.querySelectorAll('[role="button"][aria-label]')).filter((el) => {
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    return ['.png', '.jpg', '.jpeg', '.gif', '.webp'].some((extension) => label.endsWith(extension));
  });
  // The composer enables Send while an image still uploads: the tile shows a
  // spinner and a blob: preview until the upload finishes and the preview
  // switches to the uploaded data URL.
  const uploading = chips.some((chip) => {
    const image = chip.querySelector('img');
    const spinner = chip.querySelector('[role="progressbar"], progress, .animate-spin');
    return Boolean(spinner) || !image || !image.complete || image.naturalWidth === 0 || String(image.src || '').startsWith('blob:');
  });
  return { count: Math.max(new Set(removers).size, images.length), settled: !uploading };
})()`
const TRANSCRIPT_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'agent/reasoning'])
const MAX_TRANSCRIPT_EVENTS = 500
const MAX_PROMPT_CHARS = 100_000
const CHATGPT_READY_TIMEOUT_MS = 15_000
const CHATGPT_TURN_TIMEOUT_MS = 10 * 60_000
const ATTACHMENT_TIMEOUT_MS = 30_000
const ATTACHMENT_POLL_MS = 250
const SUBMIT_CONFIRM_POLL_MS = 150
const SUBMIT_CONFIRM_TIMEOUT_MS = 10_000
const TURN_POLL_MS = 350
// Gemini-style DOM echo of an image-only turn: the preview no longer carries
// the prompt text, so a text-hash match alone would import it twice.
const IMAGE_ECHO_PATTERN = /^(?:\s*!\[[^\]]*\]\([^)]*\)\s*)+$/
const BACKGROUND_WATCH_MS = 5_000

interface StoredChatGptWebSession {
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
  /** Skip ChatGPT Project auto-binding for private router turns. */
  isolated?: boolean
  sequence: number
  transcript: SessionEventEnvelope[]
  seenTurnKeys: string[]
  sentPromptHashes: string[]
  uncertainPromptHashes?: string[]
  chatGptProjectRef?: string
  chatGptChatId?: string
}

interface PersistedChatGptWebStore {
  version: 1
  sessions: StoredChatGptWebSession[]
  projectBindings?: Record<string, ChatGptProjectBinding>
  modeSettings?: WebBrowserModeSettings
}

interface ActiveChatGptTurn {
  controller: AbortController
  progress?: WebTurnProgress | undefined
}

interface ChatGptDomTurn {
  role: 'user' | 'assistant'
  text: string
}

interface ChatGptDomSnapshot {
  url: string
  title: string
  composer: boolean
  busy: boolean
  complete: boolean
  pendingSend: boolean
  challenge: boolean
  loginRequired: boolean
  rateLimited: boolean
  turns: ChatGptDomTurn[]
}

export interface ChatGptWebEngineOptions {
  browser: BrowserController
  workspace: WorkspaceService
  storePath: string
  log?: (line: string) => void
}

/**
 * ChatGPT Web is a conversation transport, not a second local harness. It
 * drives ND's already-visible browser target through the shared Extension /
 * CDP / Browser Agent transports.
 */
export class ChatGptWebEngine {
  private readonly sessions = new Map<string, StoredChatGptWebSession>()
  private readonly projectBindings = new Map<string, ChatGptProjectBinding>()
  private readonly activeTurns = new Map<string, ActiveChatGptTurn>()
  private modeSettings: WebBrowserModeSettings = { ...DEFAULT_WEB_BROWSER_MODE_SETTINGS }
  private onEvent: ((frame: DshEventFrame) => void) | undefined
  private watcherBusy = false
  private readonly watchTimer: ReturnType<typeof setInterval>

  constructor(private readonly options: ChatGptWebEngineOptions) {
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

  getProjectBinding(workspaceRoot: string): ChatGptProjectBinding | null {
    const direct = this.projectBindings.get(workspaceRoot)
    if (direct) return direct
    // Never resolve a requested root against the currently open project's name.
    const wsState = this.options.workspace.state()
    if (wsState.root !== workspaceRoot) return null
    const name = wsState.projectName || wsState.name
    if (name && this.projectBindings.has(name)) return this.projectBindings.get(name) ?? null
    return null
  }

  setProjectBinding(workspaceRoot: string, input: string): ChatGptProjectBinding {
    const parsed = parseChatGptProjectInput(input)
    if (!parsed) {
      throw new Error('Invalid ChatGPT Project link or ID. Please provide a link like https://chatgpt.com/g/g-p-.../project or an ID like g-p-...')
    }
    const wsState = this.options.workspace.state()
    const projectName = wsState.projectName || wsState.name || 'project'
    const binding: ChatGptProjectBinding = {
      workspaceRoot,
      ...(wsState.projectId ? { projectId: wsState.projectId } : {}),
      projectName,
      chatGptProjectRef: parsed.projectRef,
      chatGptProjectId: parsed.projectId,
      chatGptProjectUrl: parsed.projectUrl,
      source: 'manual',
      updatedAt: Date.now(),
    }
    this.projectBindings.set(workspaceRoot, binding)
    if (projectName) this.projectBindings.set(projectName, binding)
    this.persistStore()
    return binding
  }

  clearProjectBinding(workspaceRoot: string): void {
    this.projectBindings.delete(workspaceRoot)
    const wsState = this.options.workspace.state()
    const name = wsState.projectName || wsState.name
    if (name) this.projectBindings.delete(name)
    this.persistStore()
  }

  /**
   * Projects are optional: an unbound chat simply starts on the ChatGPT home
   * page. When the visible browser is already inside a project, auto-bind it so
   * the ND project keeps the scoped context across sessions.
   */
  async resolveProjectBinding(workspaceRoot: string, signal?: AbortSignal): Promise<ChatGptProjectBinding | null> {
    const existing = this.getProjectBinding(workspaceRoot)
    if (existing) return existing

    const wsState = this.options.workspace.state()
    const projectName = wsState.projectName || wsState.name || 'project'

    // 1. Check if the visible browser is currently viewing a project URL
    const currentUrl = this.options.browser.state().url
    const currentParsed = parseChatGptProjectInput(currentUrl)
    if (currentParsed) {
      const binding: ChatGptProjectBinding = {
        workspaceRoot,
        ...(wsState.projectId ? { projectId: wsState.projectId } : {}),
        projectName,
        chatGptProjectRef: currentParsed.projectRef,
        chatGptProjectId: currentParsed.projectId,
        chatGptProjectUrl: currentParsed.projectUrl,
        source: 'auto',
        updatedAt: Date.now(),
      }
      this.projectBindings.set(workspaceRoot, binding)
      this.projectBindings.set(projectName, binding)
      this.persistStore()
      return binding
    }

    // 2. Try auto-discovery via CDP on https://chatgpt.com/projects
    try {
      if (signal) assertTurnActive(signal)
      if (isChatGptPageUrl(currentUrl)) {
        const driver = new ElectronPageDriver(this.options.browser, this.options.browser.activeTabId(), CHATGPT_ORIGINS)
        try {
          const items = await driver.evaluate<DiscoveredProjectItem[]>(`(() => {
            const anchors = Array.from(document.querySelectorAll('a[href*="/g/g-p-"], [role="button"][href*="/g/g-p-"]'));
            return anchors.map(a => ({
              name: a.innerText?.trim() || a.getAttribute('aria-label') || '',
              href: a.getAttribute('href') || '',
            })).filter(i => i.href);
          })()`)
          const matched = matchProjectByNameOrPrefix(projectName, items)
          if (matched) {
            const binding: ChatGptProjectBinding = {
              workspaceRoot,
              ...(wsState.projectId ? { projectId: wsState.projectId } : {}),
              projectName,
              chatGptProjectRef: matched.projectRef,
              chatGptProjectId: matched.projectId,
              chatGptProjectUrl: matched.projectUrl,
              source: 'auto',
              updatedAt: Date.now(),
            }
            this.projectBindings.set(workspaceRoot, binding)
            this.projectBindings.set(projectName, binding)
            this.persistStore()
            return binding
          }
        } finally {
          driver.close()
        }
      }
    } catch {
      // Auto-discovery is best effort; unbound chats use the ChatGPT home page.
    }

    return null
  }

  /** Open (or recreate) this chat's browser tab without running a turn. */
  async ensureBrowserTab(sessionId: string): Promise<string | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    const binding = session.isolated ? null : this.getProjectBinding(session.cwd ?? this.options.workspace.state().root)
    const targetUrl = session.conversationUrl && isChatGptConversationUrl(session.conversationUrl)
      ? session.conversationUrl
      : binding?.chatGptProjectUrl ?? CHATGPT_HOME_URL
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
    throw new Error(`Unknown ${CHATGPT_WEB_ENGINE_ID} approval: ${rpcId}`)
  }

  listSessions(): EngineSessionSummary[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => ({
        sessionId: session.sessionId,
        engineId: CHATGPT_WEB_ENGINE_ID,
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
    return { sessionId, engineId: CHATGPT_WEB_ENGINE_ID, events: [...session.transcript] }
  }

  async createSession(input: { cwd?: string; hidden?: boolean; isolated?: boolean; title?: string; profileId?: string } = {}): Promise<{ sessionId: string }> {
    const sessionId = `chatgpt-web-${randomUUID()}`
    const now = Date.now()
    const profileId = createdProfileId(this.options.browser, input.profileId)
    const session: StoredChatGptWebSession = {
      sessionId,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      title: input.title?.trim() || 'New ChatGPT Web chat',
      createdAt: now,
      updatedAt: now,
      running: false,
      // A chat keeps the identity it was started with: its cookies and sign-in
      // live in that profile's partition, so reopening it after a restart or a
      // profile switch must return to the same one.
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
    if (!session.hidden) this.emitFrame({ kind: 'session-added', sessionId, meta: { engineId: CHATGPT_WEB_ENGINE_ID } })
    return { sessionId }
  }

  async run(prompt: string, input: { sessionId?: string; cwd?: string; images?: HarnessRunImage[]; isolated?: boolean; transports?: WebBrowserTransport[] } = {}): Promise<{ sessionId: string }> {
    const cleaned = stripWorkspaceContext(prompt).trim()
    if (!cleaned) throw new Error('Prompt cannot be empty')
    if (cleaned.length > MAX_PROMPT_CHARS) throw new Error(`Prompt exceeds the ${MAX_PROMPT_CHARS.toLocaleString()} character limit`)

    let session = input.sessionId === undefined ? undefined : this.sessions.get(input.sessionId)
    if (input.sessionId !== undefined && !session) throw new Error(`Unknown ${CHATGPT_WEB_ENGINE_ID} session: ${input.sessionId}`)
    if (!session) {
      const created = await this.createSession({
        cwd: input.cwd ?? this.options.workspace.state().root,
        ...(input.isolated ? { isolated: true } : {}),
      })
      session = this.sessions.get(created.sessionId)
    }
    if (!session) throw new Error(`${CHATGPT_WEB_ENGINE_ID} session could not be created`)
    if (input.isolated) session.isolated = true
    if (session.running) throw new Error('This ChatGPT Web chat already has an active turn')
    if ([...this.sessions.values()].some((candidate) => candidate.running && candidate.sessionId !== session.sessionId)) {
      throw new Error('ChatGPT Web uses ND\'s single visible browser pane. Finish the active ChatGPT Web turn before starting another one.')
    }

    const hasImages = (input.images?.length ?? 0) > 0
    const availability: WebTransportAvailability = {
      extension: true,
      cdp: Boolean(this.options.browser.state().cdpPort),
      browserAgent: true,
    }
    const plan = planWebTransports({ settings: this.modeSettings, hasImages, available: availability })
    // Router lanes pin deterministic background-capable transports instead of
    // inheriting an interactive Browser Agent preference from the chat pane.
    const transports = input.transports?.length
      ? input.transports.filter((transport) => transport === 'extension' || (transport === 'cdp' && availability.cdp))
      : plan.transports
    if (transports.length === 0) {
      const reason = plan.skipped.map((skipped) => `${skipped.transport}: ${skipped.reason}`).join(', ')
      throw new Error(`No browser transport available for mode "${this.modeSettings.mode}" (${reason || 'unavailable'})`)
    }

    session.cwd = input.cwd ?? session.cwd ?? this.options.workspace.state().root
    const abort = new AbortController()
    const activeTurn: ActiveChatGptTurn = { controller: abort }
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
          if (index < transports.length - 1 && canSwitchTransport(turnError)) {
            this.options.log?.(`[chatgpt-web] ${transport} failed (${turnError.message}); falling back to ${transports[index + 1]}`)
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

  private async runWithPageDriver(
    transport: WebBrowserTransport,
    session: StoredChatGptWebSession,
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
          session.uncertainPromptHashes = session.uncertainPromptHashes.filter((hash) => hash !== hashText(cleanedPrompt))
        }
      }

      if (session.title === 'New ChatGPT Web chat') session.title = cleanedPrompt.slice(0, 80)
      progress.enter('wait')
      const completed = await this.waitForAssistant(driver, session, baselineAssistantCount, signal)
      this.captureConversationUrl(session, completed.url)
      const assistant = [...completed.turns].reverse().find((turn) => turn.role === 'assistant')
      if (!assistant?.text.trim()) throw new Error('ChatGPT Web completed without a readable assistant message')
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
    session: StoredChatGptWebSession,
    cleanedPrompt: string,
    images: readonly HarnessRunImage[] | undefined,
    signal: AbortSignal,
    progress: WebTurnProgress,
  ): Promise<{ sessionId: string }> {
    progress.enter('open')
    const driver = await this.openBoundConversation(session, signal, 'extension')
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
        await this.clearStaleAttachments(driver)
        if ((images?.length ?? 0) > 0) {
          progress.enter('attach')
          assertTurnActive(signal)
          stagedImages = await this.attachImages(driver, images ?? [], signal)
        }
        const tabId = this.options.browser.activeTabId()
        const agent = new BrowserAgentRunner({
          port: this.options.browser,
          tabId,
          allowedOrigins: CHATGPT_ORIGINS,
          signal,
          visualRecovery: this.modeSettings.visualRecovery,
          log: this.options.log,
        })
        progress.enter('compose')
        await agent.runStep({
          name: 'fill-composer',
          maxAttempts: 5,
          plan: (observation) => {
            const composer = findComposerElement(observation.snapshot)
            if (!composer) {
              const newChat = findNewChatElement(observation.snapshot)
              if (newChat) return { kind: 'click', ref: newChat.ref, reason: 'open new chat for composer' }
              return null
            }
            return { kind: 'fill', ref: composer.ref, text: cleanedPrompt }
          },
          verify: (after) => Boolean(findComposerElement(after)),
        })

        progress.enter('submit')
        let sendAttempted = false
        let sendFailure: unknown
        try {
          await agent.runStep({
            name: 'send-prompt',
            maxAttempts: 1,
            plan: (observation) => {
              const sendButton = findSendButtonElement(observation.snapshot)
              if (!sendButton) return null
              sendAttempted = true
              progress.submission = 'uncertain'
              return { kind: 'click', ref: sendButton.ref }
            },
          })
        } catch (error) {
          sendFailure = error
        }
        if (!sendAttempted) {
          throw progress.fail('layout-changed', 'ChatGPT Web did not expose an enabled Send control. Reload ChatGPT and retry.', sendFailure)
        }
        if (sendFailure) {
          this.options.log?.(`[chatgpt-web] browser-agent send step could not verify itself (${sendFailure instanceof Error ? sendFailure.message : String(sendFailure)}); confirming against the page`)
        }
        await this.confirmSubmission(driver, cleanedPrompt, signal, progress)
        this.recordUserMessage(session, cleanedPrompt, images)
        this.rememberSentPrompt(session, cleanedPrompt)
        if (session.uncertainPromptHashes?.length) {
          session.uncertainPromptHashes = session.uncertainPromptHashes.filter((hash) => hash !== hashText(cleanedPrompt))
        }
      }

      if (session.title === 'New ChatGPT Web chat') session.title = cleanedPrompt.slice(0, 80)
      progress.enter('wait')
      const completed = await this.waitForAssistant(driver, session, baselineAssistantCount, signal)
      this.captureConversationUrl(session, completed.url)
      const assistant = [...completed.turns].reverse().find((turn) => turn.role === 'assistant')
      if (!assistant?.text.trim()) throw new Error('ChatGPT Web completed without a readable assistant message')
      progress.enter('read')
      this.recordAssistantMessage(session, assistant.text.trim())
      this.markAllTurnsSeen(session, completed)
      return { sessionId: session.sessionId }
    } finally {
      discardWebImages(stagedImages)
      driver.close()
    }
  }

  async stop(sessionId?: string): Promise<void> {
    const targets = sessionId === undefined
      ? [...this.sessions.values()].filter((session) => session.running)
      : [this.sessions.get(sessionId)].filter((session): session is StoredChatGptWebSession => session?.running === true)
    for (const session of targets) {
      const activeTurn = this.activeTurns.get(session.sessionId)
      activeTurn?.controller.abort()
      // Only stop the page after ND submitted; otherwise the user's own
      // in-pane reply could be cancelled.
      if (!activeTurn?.progress || activeTurn.progress.submission === 'none') continue
      if (!this.browserMayHostSession(session)) continue
      try {
        const driver = new ElectronPageDriver(this.options.browser, this.options.browser.activeTabId(), CHATGPT_ORIGINS)
        try {
          await driver.evaluate<boolean>(`(() => {
            const button = document.querySelector('button[data-testid="stop-button"], main form button[aria-label="Stop generating"], main form button[aria-label="Stop streaming"], main form button[aria-label="Stop"]');
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

  private async openBoundConversation(session: StoredChatGptWebSession, signal: AbortSignal, transport: WebBrowserTransport = 'cdp'): Promise<PageDriver> {
    assertTurnActive(signal)
    const binding = session.isolated
      ? null
      : await this.resolveProjectBinding(session.cwd ?? this.options.workspace.state().root, signal)
    if (binding) session.chatGptProjectRef = binding.chatGptProjectRef
    else delete session.chatGptProjectRef

    const targetUrl = session.conversationUrl && isChatGptConversationUrl(session.conversationUrl)
      ? session.conversationUrl
      : binding?.chatGptProjectUrl || CHATGPT_HOME_URL
    const tabId = await this.ensureSessionTab(session, targetUrl)
    assertTurnActive(signal)
    await this.options.browser.ensureAgentReady()
    assertTurnActive(signal)
    const driver: PageDriver = transport === 'extension'
      ? new ElectronPageDriver(this.options.browser, tabId, CHATGPT_ORIGINS)
      : await VisibleCdpConnection.connect(this.options.browser, {
        targetId: this.options.browser.state()?.targetId,
        allowedOrigins: CHATGPT_ORIGINS,
      })
    try {
      const deadline = Date.now() + CHATGPT_READY_TIMEOUT_MS
      while (Date.now() < deadline) {
        assertTurnActive(signal)
        const snapshot = await this.captureSnapshot(driver)
        assertTurnActive(signal)
        this.throwStopConditions(snapshot)
        if (snapshot.composer) return driver
        await driver.evaluate<boolean>(`(() => {
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
            const r = el.getBoundingClientRect?.();
            return !r || (r.width > 0 && r.height > 0);
          };
          const candidates = Array.from(document.querySelectorAll('button, a')).filter(isVisible);
          const label = (el) => \`\${el.innerText?.trim() || ''} \${el.getAttribute?.('aria-label') || ''}\`;
          // Project pages expose an icon-only "New chat in <project>" button
          // whose accessible name is the only text, and the scoped button must
          // win over the global sidebar "New chat".
          const btn = candidates.find(el => label(el).includes('New chat in'))
            || candidates.find(el => label(el).includes('New chat') || label(el).includes('New conversation'));
          if (btn instanceof HTMLElement) { btn.click(); return true; }
          return false;
        })()`).catch(() => false)
        await sleep(250)
      }
      const projectScope = binding?.chatGptProjectRef ? ` for project "${binding.projectName}"` : ''
      throw new Error(`ChatGPT Web is open in ND's visible Browser pane, but the composer${projectScope} is unavailable. Sign in to chatgpt.com and ensure the chat composer is accessible, then resend this message.`)
    } catch (error) {
      driver.close()
      throw error
    }
  }

  /** Each chat owns its browser tab so switching chats switches conversations. */
  private async ensureSessionTab(session: StoredChatGptWebSession, targetUrl: string): Promise<string> {
    const browser = this.options.browser
    // Sessions from before browser profiles existed were signed in through the
    // historical partition, which the default profile still owns.
    const desiredProfile = sessionProfileId(browser, session.browserProfileId)
    if (session.browserProfileId !== desiredProfile) {
      session.browserProfileId = desiredProfile
      this.persistStore()
    }
    const existing = session.browserTabId
    if (existing && browser.tabUrl(existing) !== undefined) {
      await browser.activateTab(existing)
      const currentUrl = browser.tabUrl(existing) ?? ''
      if (!sameConversationUrl(currentUrl, targetUrl)) await browser.navigate(targetUrl, existing)
      return existing
    }
    const tab = await browser.createTab(targetUrl, true, desiredProfile)
    session.browserTabId = tab.id
    this.persistStore()
    return tab.id
  }

  /**
   * Pasted images ride ChatGPT's own uploader so the model receives a real
   * attachment. The turn only starts after the preview tiles appear.
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
        if (${CHATGPT_IMAGE_INPUT_EXPRESSION}) return true;
        const button = Array.from(document.querySelectorAll('button')).find((el) => /add files|add photos|attach|upload/i.test(el.getAttribute('aria-label') || ''));
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()`)
      if (!mounted) {
        throw new Error('ChatGPT Web has no file attachment control in ND\'s Browser pane. Open chatgpt.com and sign in, then resend this message.')
      }
      let inputReady = false
      for (let attempt = 0; attempt < 20 && !inputReady; attempt += 1) {
        assertTurnActive(signal)
        inputReady = await driver.evaluate<boolean>(`${CHATGPT_IMAGE_INPUT_EXPRESSION} !== null`)
        if (!inputReady) await sleep(100)
      }
      if (!inputReady) {
        throw new Error('ChatGPT Web did not expose an image input. Reload ChatGPT and resend this message.')
      }
      // ND owns this turn: drop chips left by an earlier browser draft so the
      // message never carries a stale image alongside the new ones.
      await this.clearStaleAttachments(driver)
      await sleep(200)
      const baseline = await driver.evaluate<{ count: number }>(CHATGPT_ATTACHMENT_STATE_SCRIPT)
      assertTurnActive(signal)
      if (!await driver.setFilesOnInput(CHATGPT_IMAGE_INPUT_EXPRESSION, staged.files)) {
        throw new Error('ChatGPT Web did not expose an image input. Reload ChatGPT and resend this message.')
      }
      const deadline = Date.now() + ATTACHMENT_TIMEOUT_MS
      while (Date.now() < deadline) {
        assertTurnActive(signal)
        const state = await driver.evaluate<{ count: number; settled: boolean }>(CHATGPT_ATTACHMENT_STATE_SCRIPT)
        if (state.count >= baseline.count + images.length && state.settled) return staged
        await sleep(ATTACHMENT_POLL_MS)
      }
      throw new Error('ChatGPT Web did not finish attaching the image in time. Make sure chatgpt.com accepts uploads in ND\'s Browser pane, then resend this message.')
    } catch (error) {
      discardWebImages(staged)
      throw error
    }
  }

  private async clearStaleAttachments(driver: PageDriver): Promise<void> {
    await driver.evaluate<boolean>(`(() => {
      const isRemover = (label) => /^Remove (?:file:|image:)/i.test(label) || /^Remove .+\\.[a-z0-9]{1,8}$/i.test(label);
      const stale = Array.from(document.querySelectorAll('button[aria-label]')).filter((el) => isRemover(el.getAttribute('aria-label') || ''));
      stale.forEach((el) => el.click());
      return stale.length > 0;
    })()`).catch(() => false)
  }

  private throwStopConditions(snapshot: ChatGptDomSnapshot): void {
    if (snapshot.challenge) {
      throw new WebTurnError({
        code: 'challenge',
        message: "Cloudflare or ChatGPT is showing a verification challenge in ND's Browser pane. Complete the challenge and resend this message.",
        phase: 'observe',
      })
    }
    if (snapshot.loginRequired) {
      throw new WebTurnError({
        code: 'login-required',
        message: "ChatGPT Web needs you signed in to chatgpt.com in ND's visible Browser pane (or a working guest chat). Sign in there, then resend this message.",
        phase: 'observe',
      })
    }
    if (snapshot.rateLimited) {
      throw new WebTurnError({
        code: 'rate-limited',
        message: 'ChatGPT has rate limited requests. Please wait a few moments and try again.',
        phase: 'observe',
      })
    }
  }

  private pageBusyError(): WebTurnError {
    return new WebTurnError({
      code: 'page-busy',
      message: "ChatGPT is still answering or uploading in ND's Browser pane. Let it finish (or stop it), then resend this message.",
      phase: 'observe',
    })
  }

  private classifyTurnError(progress: WebTurnProgress, error: unknown): WebTurnError {
    const classified = progress.classify(error)
    if (!(error instanceof PageGuardError)) return classified
    const host = (() => { try { return new URL(error.origin).hostname } catch { return '' } })()
    if (host === 'auth.openai.com' || host === 'auth0.openai.com' || host === 'login.openai.com') {
      return new WebTurnError({
        code: 'login-required',
        message: "ChatGPT Web needs you signed in to chatgpt.com in ND's visible Browser pane. Sign in there, then resend this message.",
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

  private async submitPrompt(driver: PageDriver, prompt: string, signal: AbortSignal, progress: WebTurnProgress): Promise<void> {
    assertTurnActive(signal)
    const source = JSON.stringify(prompt)
    const expected = composerKey(prompt)
    let accepted = false
    for (let attempt = 0; attempt < 3 && !accepted; attempt += 1) {
      assertTurnActive(signal)
      const result = await driver.evaluate<{ ok: boolean; reason?: string }>(`(async () => {
        const composerSelector = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)};
        const isVisible = (el) => {
          if (!el) return false;
          if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return true;
          let cur = el;
          while (cur && cur.nodeType === 1) {
            if (cur.hidden || cur.getAttribute?.('aria-hidden') === 'true') return false;
            const style = window.getComputedStyle(cur);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            cur = cur.parentElement;
          }
          if (typeof el.getBoundingClientRect === 'function') {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }
          return true;
        };
        const allComposers = typeof document.querySelectorAll === 'function'
          ? Array.from(document.querySelectorAll(composerSelector)).filter(isVisible)
          : [];
        const composer = allComposers.at(-1) ?? (() => {
          const single = document.querySelector?.(composerSelector) ?? null;
          return isVisible(single) ? single : null;
        })();
        if (!(composer instanceof HTMLElement)) return { ok: false, reason: 'composer-missing' };
        const text = ${source};
        composer.focus?.();
        if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
          const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          setter?.call(composer, text);
          composer.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (composer.classList?.contains('ProseMirror') && typeof document.createElement === 'function' && typeof composer.replaceChildren === 'function') {
          const paragraphs = text.split('\\n').map((line) => {
            const p = document.createElement('p');
            if (line) p.textContent = line;
            else p.appendChild(document.createElement('br'));
            return p;
          });
          composer.replaceChildren(...paragraphs);
          composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        } else {
          const selection = window.getSelection?.();
          const range = document.createRange?.();
          if (selection && range) {
            range.selectNodeContents(composer);
            selection.removeAllRanges();
            selection.addRange(range);
          }
          document.execCommand?.('delete');
          if (!document.execCommand?.('insertText', false, text)) composer.textContent = text;
          composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        }
        return { ok: true };
      })()`)
      if (!result?.ok) throw new Error('ChatGPT Web composer is unavailable.')
      await sleep(250)
      accepted = composerKey(await this.readComposerText(driver)) === expected
      if (!accepted) await sleep(200)
    }
    if (!accepted) throw new Error('ChatGPT Web composer did not keep the full message. Reload ChatGPT and retry.')

    progress.enter('submit')
    let attempted = false
    let attempts = 0
    let sent = false
    for (let index = 0; index < 100 && !sent; index += 1) {
      assertTurnActive(signal)
      // The click may register even if its result never reaches ND, so the
      // submission stays uncertain until confirmation.
      progress.submission = attempted ? 'uncertain' : 'none'
      const clicked = await driver.evaluate<boolean>(`(() => {
        const composerSelector = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)};
        const isVisible = (el) => {
          if (!el) return false;
          if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return true;
          let cur = el;
          while (cur && cur.nodeType === 1) {
            if (cur.hidden || cur.getAttribute?.('aria-hidden') === 'true') return false;
            const style = window.getComputedStyle(cur);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            cur = cur.parentElement;
          }
          if (typeof el.getBoundingClientRect === 'function') {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }
          return true;
        };
        const allComposers = typeof document.querySelectorAll === 'function'
          ? Array.from(document.querySelectorAll(composerSelector)).filter(isVisible)
          : [];
        const composer = allComposers.at(-1) ?? (() => {
          const single = document.querySelector?.(composerSelector) ?? null;
          return isVisible(single) ? single : null;
        })();
        if (${index > 0 && index % 5 === 0} && composer instanceof HTMLElement && composer.classList?.contains('ProseMirror') && !(composer.innerText || '').trim()) {
          const text = ${source};
          const paragraphs = text.split('\\n').map((line) => {
            const p = document.createElement('p');
            if (line) p.textContent = line;
            else p.appendChild(document.createElement('br'));
            return p;
          });
          composer.replaceChildren(...paragraphs);
          composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        }
        const form = composer?.closest?.('form');
        const sendSelector = 'button[data-testid="send-button"], button[data-testid="fruitjuice-send-button"], button[aria-label*="Send" i], button[type="submit"]';
        const formButtons = typeof form?.querySelectorAll === 'function'
          ? Array.from(form.querySelectorAll(sendSelector)).filter(isVisible)
          : [];
        const docButtons = typeof document.querySelectorAll === 'function'
          ? Array.from(document.querySelectorAll('button[data-testid="send-button"], button[data-testid="fruitjuice-send-button"], button[aria-label*="Send" i]')).filter(isVisible)
          : [];
        const button = formButtons.at(-1)
          ?? form?.querySelector?.('button[data-testid="send-button"], button[aria-label*="Send"], button[type="submit"]')
          ?? docButtons.at(-1)
          ?? document.querySelector?.('button[data-testid="send-button"], button[aria-label*="Send"]');
        if (button instanceof HTMLButtonElement && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
          // ChatGPT ignores scripted button clicks, but its form submit handler
          // is the same path a real Send press runs.
          const form = button.form ?? (typeof button.closest === 'function' ? button.closest('form') : null);
          if (form && typeof form.requestSubmit === 'function') {
            form.requestSubmit();
            return true;
          }
          button.click();
          return true;
        }
        return false;
      })()`)
      if (clicked) {
        attempted = true
        attempts += 1
        progress.submission = 'uncertain'
        // A submit issued while the composer is still settling (for example
        // while an image uploads) can be ignored. Retrying is safe only while
        // the composer still holds the full prompt; a real submit clears it.
        await sleep(400)
        sent = composerKey(await this.readComposerText(driver)) !== expected
        if (!sent && attempts >= 3) break
        continue
      }
      await sleep(100)
    }
    if (!sent && !attempted) {
      throw progress.fail('not-submitted', 'ChatGPT Web could not find an enabled Send control. Reload ChatGPT and retry.')
    }
    await this.confirmSubmission(driver, prompt, signal, progress)
  }

  private async readComposerText(driver: PageDriver): Promise<string> {
    return await driver.evaluate<string>(`(() => {
      const composerSelector = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)};
      const isVisible = (el) => {
        if (!el) return false;
        if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return true;
        let cur = el;
        while (cur && cur.nodeType === 1) {
          if (cur.hidden || cur.getAttribute?.('aria-hidden') === 'true') return false;
          const style = window.getComputedStyle(cur);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          cur = cur.parentElement;
        }
        if (typeof el.getBoundingClientRect === 'function') {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }
        return true;
      };
      const allComposers = typeof document.querySelectorAll === 'function'
        ? Array.from(document.querySelectorAll(composerSelector)).filter(isVisible)
        : [];
      const composer = allComposers.at(-1) ?? (() => {
        const single = document.querySelector?.(composerSelector) ?? null;
        return isVisible(single) ? single : null;
      })();
      if (!(composer instanceof HTMLElement)) return '';
      return composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? composer.value : composer.innerText;
    })()`)
  }

  /**
   * Confirmation is the only proof ChatGPT accepted the prompt. A timeout or
   * cancellation after the click stays `uncertain` so a retry cannot duplicate.
   */
  private async confirmSubmission(driver: PageDriver, prompt: string, signal: AbortSignal, progress: WebTurnProgress): Promise<void> {
    progress.enter('confirm')
    if (progress.submission === 'none') progress.submission = 'uncertain'
    const expected = JSON.stringify(composerKey(prompt))
    const confirmDeadline = Date.now() + SUBMIT_CONFIRM_TIMEOUT_MS
    let confirmed = false
    while (Date.now() < confirmDeadline) {
      if (signal.aborted) break
      const state = await driver.evaluate<{ composerCleared: boolean; busy: boolean; sendVisible: boolean; sendDisabled: boolean }>(`(() => {
        const composerSelector = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)};
        const isVisible = (el) => {
          if (!el) return false;
          if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return true;
          let cur = el;
          while (cur && cur.nodeType === 1) {
            if (cur.hidden || cur.getAttribute?.('aria-hidden') === 'true') return false;
            const style = window.getComputedStyle(cur);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            cur = cur.parentElement;
          }
          if (typeof el.getBoundingClientRect === 'function') {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }
          return true;
        };
        const composers = Array.from(document.querySelectorAll(composerSelector)).filter(isVisible);
        const composer = composers.at(-1) ?? document.querySelector(composerSelector);
        const text = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? composer.value : (composer?.innerText || '');
        const stop = document.querySelector('button[data-testid="stop-button"], main form button[aria-label*="Stop" i]');
        const send = document.querySelector('button[data-testid="send-button"], button[data-testid="fruitjuice-send-button"], button[aria-label*="Send" i]');
        return {
          composerCleared: text.replace(/\\s+/g, '') !== ${expected},
          busy: isVisible(stop),
          sendVisible: isVisible(send),
          sendDisabled: send instanceof HTMLButtonElement ? Boolean(send.disabled || send.getAttribute('aria-disabled') === 'true') : true,
        };
      })()`).catch(() => undefined)
      if (state && state.composerCleared && (state.busy || !state.sendVisible || state.sendDisabled)) {
        confirmed = true
        break
      }
      await sleep(SUBMIT_CONFIRM_POLL_MS)
    }
    if (!confirmed) {
      throw new WebTurnError({
        code: 'submission-uncertain',
        message: "ChatGPT Web did not confirm that it accepted the message. The message may already have been sent — check ND's Browser pane before resending; ND will not resend it automatically.",
        phase: 'confirm',
        submission: 'uncertain',
        transport: progress.transport,
      })
    }
    progress.submission = 'confirmed'
  }

  private async waitForAssistant(
    driver: PageDriver,
    session: StoredChatGptWebSession,
    baselineAssistantCount: number,
    signal: AbortSignal,
  ): Promise<ChatGptDomSnapshot> {
    const deadline = Date.now() + CHATGPT_TURN_TIMEOUT_MS
    let stableText = ''
    let stableCount = 0
    let polls = 0
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('ChatGPT Web turn was stopped.')
      const snapshot = await this.captureSnapshot(driver)
      this.throwStopConditions(snapshot)
      this.captureConversationUrl(session, snapshot.url)
      const assistants = snapshot.turns.filter((turn) => turn.role === 'assistant')
      const latest = assistants.at(-1)?.text.trim() ?? ''
      if (session.isolated && polls % 10 === 0) {
        this.options.log?.(
          `[chatgpt-web] isolated wait polls=${polls} roles=${snapshot.turns.map((turn) => turn.role).join(',') || 'none'} complete=${snapshot.complete} busy=${snapshot.busy} assistants=${assistants.length}/${baselineAssistantCount} stable=${stableCount} latest=${latest.length}`,
        )
      }
      polls += 1
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
    throw new Error('ChatGPT Web turn exceeded the 10 minute completion deadline.')
  }

  private async captureSnapshot(driver: PageDriver): Promise<ChatGptDomSnapshot> {
    return driver.evaluate<ChatGptDomSnapshot>(`(() => {
      ${CHATGPT_DOM_TURNS_SCRIPT}
      const composerSelector = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)};
      const isVisible = (el) => {
        if (!el || isHiddenChatGptNode(el)) return false;
        if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function' && typeof el.getBoundingClientRect === 'function') {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }
        return true;
      };
      const domTurns = readChatGptDomTurns({ legacyFallback: true });
      const turns = [];
      for (const { root, role, text: turnText } of domTurns) {
        const text = turnText || (root instanceof HTMLElement ? root.innerText.trim() : '');
        if (text) turns.push({ role, text });
      }
      const assistants = domTurns.filter(turn => turn.role === 'assistant');
      const lastAssistant = assistants.at(-1);
      const visibleComposers = typeof document.querySelectorAll === 'function'
        ? Array.from(document.querySelectorAll(composerSelector)).filter(isVisible)
        : [];
      const hasComposer = visibleComposers.length > 0 || isVisible(document.querySelector?.(composerSelector));
      const stopSelector = 'button[data-testid="stop-button"], main form button[aria-label="Stop generating"], main form button[aria-label="Stop streaming"], main form button[aria-label="Stop"]';
      const visibleStops = typeof document.querySelectorAll === 'function'
        ? Array.from(document.querySelectorAll(stopSelector)).filter(isVisible)
        : [];
      const hasStop = visibleStops.length > 0 || isVisible(document.querySelector?.(stopSelector));
      const host = location.hostname;
      const bodyText = document.body?.innerText || '';
      const titleAndBody = String(document.title || '') + ' ' + bodyText;
      return {
        url: location.href,
        title: document.title,
        composer: hasComposer,
        busy: hasStop || lastAssistant?.imagesPending === true,
        complete: lastAssistant?.complete === true,
        pendingSend: false,
        challenge: host === 'challenges.cloudflare.com' || /just a moment|checking your browser|verify you are human|unusual traffic/i.test(titleAndBody),
        loginRequired: host === 'auth.openai.com' || host === 'auth0.openai.com' || host === 'login.openai.com' || location.pathname.includes('/auth/'),
        rateLimited: /rate limit|too many requests|usage limit|you(?:'|’)ve reached|try again later/i.test(bodyText),
        turns,
      };
    })()`)
  }

  private importUnseenTurns(session: StoredChatGptWebSession, snapshot: ChatGptDomSnapshot): void {
    // Browser-originated turns may still be streaming even when ND has no
    // active turn. Import only settled snapshots, never partial reply text.
    if (snapshot.busy) return
    const seen = new Set(session.seenTurnKeys)
    const sent = new Set(session.sentPromptHashes)
    const assistantIndices = snapshot.turns
      .map((turn, idx) => (turn.role === 'assistant' ? idx : -1))
      .filter((idx) => idx >= 0)
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
          const pos = assistantIndices.indexOf(index)
          const offsetFromEnd = pos >= 0 ? assistantIndices.length - 1 - pos : 0
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

  private markAllTurnsSeen(session: StoredChatGptWebSession, snapshot: ChatGptDomSnapshot): void {
    session.seenTurnKeys = trimArray(snapshot.turns.map((turn, index) => domTurnKey(turn, index)), 500)
    this.persistStore()
  }

  private rememberSentPrompt(session: StoredChatGptWebSession, prompt: string): void {
    session.sentPromptHashes = trimArray([...session.sentPromptHashes, hashText(prompt)], 100)
    this.persistStore()
  }

  private captureConversationUrl(session: StoredChatGptWebSession, url: string): void {
    if (!isChatGptConversationUrl(url)) return
    const parsed = parseChatGptConversationUrl(url)
    if (parsed?.projectRef) session.chatGptProjectRef = parsed.projectRef
    if (parsed?.chatId) session.chatGptChatId = parsed.chatId
    if (session.conversationUrl === url) return
    session.conversationUrl = url
    this.persistStore()
  }

  private async watchTick(): Promise<void> {
    if (this.watcherBusy) return
    if (typeof this.options.browser?.state !== 'function' || typeof this.options.browser?.activeTabId !== 'function') return
    this.watcherBusy = true
    try {
      const currentUrl = this.options.browser.state().url
      const visibleSessions = [...this.sessions.values()].filter(
        (session) => !session.running && session.conversationUrl !== undefined && sameConversationUrl(currentUrl, session.conversationUrl),
      )
      if (visibleSessions.length > 0) {
        try {
          const driver = new ElectronPageDriver(this.options.browser, this.options.browser.activeTabId(), CHATGPT_ORIGINS)
          try {
            const snapshot = await this.captureSnapshot(driver)
            for (const visibleSession of visibleSessions) {
              this.importUnseenTurns(visibleSession, snapshot)
            }
          } finally {
            driver.close()
          }
        } catch (error) {
          this.options.log?.(`[chatgpt-web] visible conversation sync skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } finally {
      this.watcherBusy = false
    }
  }

  private recordUserMessage(session: StoredChatGptWebSession, text: string, images?: readonly HarnessRunImage[]): void {
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

  private recordAssistantMessage(session: StoredChatGptWebSession, text: string): void {
    this.recordEnvelope(session, {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
    })
  }

  private updateAssistantMessageFromEnd(session: StoredChatGptWebSession, text: string, offsetFromEnd: number): void {
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

  private recordReasoning(session: StoredChatGptWebSession, text: string): void {
    this.recordEnvelope(session, { type: 'agent/reasoning', data: { text } })
  }

  private recordEnvelope(session: StoredChatGptWebSession, partial: { type: string; data?: unknown }): void {
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

  private requireSession(sessionId: string): StoredChatGptWebSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown ${CHATGPT_WEB_ENGINE_ID} session: ${sessionId}`)
    return session
  }

  private browserMayHostSession(session: StoredChatGptWebSession): boolean {
    const currentUrl = this.options.browser.state().url
    if (!isChatGptPageUrl(currentUrl)) return false
    return session.conversationUrl === undefined || sameConversationUrl(currentUrl, session.conversationUrl)
  }

  private emitFrame(frame: DshEventFrame): void {
    if (frame.sessionId && this.sessions.get(frame.sessionId)?.hidden) return
    this.onEvent?.(frame)
  }

  private loadStore(): void {
    if (!existsSync(this.options.storePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.options.storePath, 'utf8')) as Partial<PersistedChatGptWebStore>
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return
      for (const candidate of parsed.sessions) {
        if (!candidate || typeof candidate !== 'object') continue
        const session = candidate as StoredChatGptWebSession
        if (typeof session.sessionId !== 'string' || !session.sessionId.startsWith('chatgpt-web-')) continue
        if (session.hidden === true) continue
        if (typeof session.conversationUrl !== 'string' || !isChatGptConversationUrl(session.conversationUrl)) delete session.conversationUrl
        if (typeof session.browserTabId !== 'string' || session.browserTabId === '') delete session.browserTabId
        if (typeof session.browserProfileId !== 'string' || session.browserProfileId === '') delete session.browserProfileId
        session.running = false
        session.transcript = Array.isArray(session.transcript) ? session.transcript.slice(-MAX_TRANSCRIPT_EVENTS) : []
        session.seenTurnKeys = Array.isArray(session.seenTurnKeys) ? session.seenTurnKeys.slice(-500) : []
        session.sentPromptHashes = Array.isArray(session.sentPromptHashes) ? session.sentPromptHashes.slice(-100) : []
        session.uncertainPromptHashes = Array.isArray(session.uncertainPromptHashes) ? session.uncertainPromptHashes.slice(-50) : []
        session.sequence = Number.isSafeInteger(session.sequence) ? session.sequence : session.transcript.at(-1)?.seq ?? 0
        if (typeof session.chatGptProjectRef !== 'string') delete session.chatGptProjectRef
        if (typeof session.chatGptChatId !== 'string') delete session.chatGptChatId
        this.sessions.set(session.sessionId, session)
      }
      if (parsed.projectBindings && typeof parsed.projectBindings === 'object') {
        for (const [key, binding] of Object.entries(parsed.projectBindings)) {
          if (binding && typeof binding === 'object' && typeof binding.chatGptProjectRef === 'string' && binding.chatGptProjectRef) {
            this.projectBindings.set(key, binding)
          }
        }
      }
      if (parsed.modeSettings && typeof parsed.modeSettings === 'object') {
        this.modeSettings = normalizeWebBrowserModeSettings(parsed.modeSettings)
      }
    } catch (error) {
      this.options.log?.(`[chatgpt-web] ignoring unreadable session store: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private persistStore(): void {
    const directory = dirname(this.options.storePath)
    mkdirSync(directory, { recursive: true })
    const tmp = `${this.options.storePath}.${process.pid}.${randomUUID()}.tmp`
    const bindingsObj: Record<string, ChatGptProjectBinding> = {}
    for (const [key, val] of this.projectBindings.entries()) {
      bindingsObj[key] = val
    }
    const payload: PersistedChatGptWebStore = {
      version: 1,
      sessions: [...this.sessions.values()].filter((session) => session.hidden !== true),
      projectBindings: bindingsObj,
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

function promptMatchesDom(domText: string, prompt: string): boolean {
  const text = domText.trim()
  return text === prompt.trim() || text.includes(prompt.trim())
}

function userMessageText(event: SessionEventEnvelope): string | undefined {
  const message = (event.data as { message?: { content?: Array<{ type?: string; text?: string }> } } | undefined)?.message
  return message?.content?.find((content) => content.type === 'text')?.text
}

function domTurnKey(turn: ChatGptDomTurn, index: number): string {
  return `${index}:${turn.role}:${hashText(turn.text)}`
}

function trimArray<T>(values: T[], limit: number): T[] {
  return values.length <= limit ? values : values.slice(values.length - limit)
}

function isChatGptPageUrl(value: string): boolean {
  try {
    return new URL(value).origin === 'https://chatgpt.com'
  } catch {
    return false
  }
}

function isChatGptConversationUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.origin === 'https://chatgpt.com' && /(^|\/)(?:c|uc)\//.test(url.pathname)
  } catch {
    return false
  }
}

function sameConversationUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left)
    const b = new URL(right)
    return a.origin === b.origin && a.pathname === b.pathname
  } catch {
    return left === right
  }
}

function assertTurnActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('ChatGPT Web turn was stopped.')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
