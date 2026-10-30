import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type {
  DshEventFrame,
  EngineModelOption,
  EngineSessionSummary,
  EngineSessionTranscript,
  SessionEventEnvelope,
  HarnessRunFile,
  HarnessRunImage,
  HarnessRunOptions,
  HarnessRunResult,
  HarnessStatus,
} from '../../shared/contracts.js'
import {
  ANTIGRAVITY_ENGINE_ID,
  CHATGPT_WEB_ENGINE_ID,
  CLAUDE_CODE_CLI_ENGINE_ID,
  CODEX_ENGINE_ID,
  CODEX_CLI_ENGINE_ID,
  CURSOR_CLI_ENGINE_ID,
  GEMINI_WEB_ENGINE_ID,
  ND_HARNESS_ENGINE_ID,
  ND_NATIVE_ENGINE_ID,
  PI_CODING_ENGINE_ID,
  ZCODE_CLI_ENGINE_ID,
} from '../../shared/coding-engines.js'
import {
  GOOSE_CLI_ENGINE_ID,
  HERMES_CLI_ENGINE_ID,
  JCODE_CLI_ENGINE_ID,
  MINIMAX_CLI_ENGINE_ID,
  OPENCODE_CLI_ENGINE_ID,
} from '../../shared/extra-coding-engines.js'
import type { BrowserController } from '../browser/browser-controller.js'
import { appendWorkspaceContext, stripWorkspaceContext } from '../../shared/workspace-context.js'
import type { ExtensionRouter } from '../extensions/extension-router.js'
import type { HarnessService } from '../harness/harness-service.js'
import type { SessionJournalStore } from '../harness/session-journal-store.js'
import { taskMetricsRecorder } from '../metrics/task-metrics.js'
import { tokenSaverRuntime } from '../token-saver/token-saver-runtime.js'
import { promptShieldRuntime } from '../prompt-shield/prompt-shield-runtime.js'
import { promptShieldBlockedError } from '../prompt-shield/prompt-shield-service.js'
import { sessionInWorkspace } from '../workspace/path-utils.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import type { ClaudeCodeCliEngine } from './claude/claude-code-cli-engine.js'
import type { AntigravityEngine } from './antigravity/antigravity-engine.js'
import type { CursorCliEngine } from './cursor/cursor-cli-engine.js'
import { ChatGptWebEngine } from './chatgpt-web/chatgpt-web-engine.js'
import { GeminiWebEngine } from './gemini-web/gemini-web-engine.js'
import type { CodexCliEngine } from './codex/codex-cli-engine.js'
import { createExtraCliEngines } from './agent-cli/extra-cli-engines.js'
import { TRANSCRIPT_EVENT_TYPES } from './agent-cli/agent-cli-support.js'
import type { PiCodingEngine } from './pi/pi-coding-engine.js'
import type { ZcodeCliEngine } from './zcode/zcode-cli-engine.js'
import type { NdNativeEngine } from './nd-native/nd-native-engine.js'
import { nativePrivateSelectionEnabled } from './nd-native/native-selection-gate.js'
import { inlineTextAttachments, stageAttachments } from './attachment-delivery.js'
import { WebTurnError } from './web-turn.js'
import { extractLatestAssistantText } from './web-turn-result.js'

/** Direct engines that accept native base64 image blocks (Claude stream-json). */
const BASE64_IMAGE_DIRECT_ENGINES = new Set([CLAUDE_CODE_CLI_ENGINE_ID])
/** Direct engines that accept native local-image paths (Codex app-server). */
const LOCAL_IMAGE_DIRECT_ENGINES = new Set([CODEX_CLI_ENGINE_ID])

const STRUCTURED_TRANSCRIPT_ENGINE_IDS = new Set([
  OPENCODE_CLI_ENGINE_ID,
  GOOSE_CLI_ENGINE_ID,
  JCODE_CLI_ENGINE_ID,
  HERMES_CLI_ENGINE_ID,
])

export interface ChatGptWebRuntime {
  browser: BrowserController
  storePath?: string
  log?: (line: string) => void
  engine?: ChatGptWebEngine
}

export interface GeminiWebRuntime {
  browser: BrowserController
  storePath?: string
  log?: (line: string) => void
  engine?: GeminiWebEngine
}

/**
 * The shared surface of every workspace-capable direct engine. The router
 * dispatches to these by catalog id; organization workflow and renderer code
 * never branch on engine ids.
 */
export interface DirectWorkspaceEngine {
  run(prompt: string, options?: { sessionId?: string; cwd?: string; provider?: string; model?: string; permissionMode?: string; images?: HarnessRunImage[]; imagePaths?: string[] }): Promise<{ sessionId: string }>
  createSession(input?: { cwd?: string; model?: string }): Promise<{ sessionId: string }>
  stop(sessionId?: string): Promise<void>
  listSessions(): EngineSessionSummary[]
  transcript(sessionId: string): EngineSessionTranscript | Promise<EngineSessionTranscript>
  ownsSession(sessionId: string): boolean
  handlesApproval(rpcId: string): boolean
  respond(rpcId: string, value: unknown): Promise<void>
  listModels(): Promise<EngineModelOption[]>
  setEmitter?(emit: (frame: DshEventFrame) => void): void
  close?(): Promise<void>
}

/**
 * The single dispatch point between renderer-facing run/respond/stop calls and
 * the engine that owns the target session. Routing is derived from explicit run
 * options or from which engine registered the session id.
 */
export class EngineSessionRouter {
  private messageStore: import('../sessions/session-archive-store.js').SessionArchiveStore | undefined

  setMessageStore(store: import('../sessions/session-archive-store.js').SessionArchiveStore): void { this.messageStore = store }

  async restoreMessages<T>(sessionId: string, value: T): Promise<T> {
    return this.messageStore ? this.messageStore.restoreSkillMessages(sessionId, value) : value
  }

  private extensions: ExtensionRouter | undefined
  private skills: import('../skills/nd-skill-service.js').NdSkillService | undefined
  private browserAccess: { issueSessionAccess(sessionId: string): string; revokeSessionAccess(sessionId: string): void } | undefined
  private vaultAccess: { hint(): Promise<string | undefined> } | undefined
  private worktreeGuard: ((cwd: string) => boolean) | undefined

  setSkillService(service: import('../skills/nd-skill-service.js').NdSkillService): void {
    this.skills = service
  }

  setBrowserAccessProvider(provider: { issueSessionAccess(sessionId: string): string; revokeSessionAccess(sessionId: string): void } | undefined): void {
    this.browserAccess = provider
  }

  setVaultAccessProvider(provider: { hint(): Promise<string | undefined> } | undefined): void {
    this.vaultAccess = provider
  }
  /** Logical engine ids for harness-backed sessions such as delegated Codex. */
  private readonly logicalEngineBySession = new Map<string, string>()
  /** ND-owned immutable workspace binding for routed task/interactive sessions. */
  private readonly workspaceRootBySession = new Map<string, string>()
  private readonly chatGptWeb: ChatGptWebEngine | undefined
  private readonly chatGptWebBrowser: BrowserController | undefined
  private readonly chatGptWebLog: ((line: string) => void) | undefined
  private readonly geminiWeb: GeminiWebEngine | undefined
  private readonly geminiWebBrowser: BrowserController | undefined
  private readonly geminiWebLog: ((line: string) => void) | undefined
  /** Workspace-capable direct engines by catalog id, in catalog order. */
  private readonly directEngines = new Map<string, DirectWorkspaceEngine>()
  /** Direct engines constructed by the router rather than Electron bootstrap. */
  private readonly routerOwnedDirectEngines = new Set<DirectWorkspaceEngine>()

  constructor(
    private readonly harness: HarnessService,
    codex: CodexCliEngine,
    private readonly workspace: WorkspaceService,
    antigravity?: AntigravityEngine,
    chatGptWebRuntime?: ChatGptWebRuntime,
    geminiWebRuntime?: GeminiWebRuntime,
    zcode?: ZcodeCliEngine,
    pi?: PiCodingEngine,
    cursor?: CursorCliEngine,
    claude?: ClaudeCodeCliEngine,
    directSpawnProcess: typeof spawn = spawn,
    private readonly sessionJournal?: SessionJournalStore,
    nativeAgent?: NdNativeEngine,
  ) {
    this.directEngines.set(CODEX_CLI_ENGINE_ID, codex)
    if (antigravity) this.directEngines.set(ANTIGRAVITY_ENGINE_ID, antigravity)
    if (zcode) this.directEngines.set(ZCODE_CLI_ENGINE_ID, zcode)
    if (pi) this.directEngines.set(PI_CODING_ENGINE_ID, pi)
    if (cursor) this.directEngines.set(CURSOR_CLI_ENGINE_ID, cursor)
    if (claude) this.directEngines.set(CLAUDE_CODE_CLI_ENGINE_ID, claude)
    if (nativeAgent) {
      this.directEngines.set(ND_NATIVE_ENGINE_ID, nativeAgent)
      this.routerOwnedDirectEngines.add(nativeAgent)
    }
    for (const [engineId, engine] of createExtraCliEngines((line) => console.warn(line), directSpawnProcess)) {
      this.directEngines.set(engineId, engine)
      this.routerOwnedDirectEngines.add(engine)
    }
    if (chatGptWebRuntime) {
      this.chatGptWebBrowser = chatGptWebRuntime.browser
      this.chatGptWebLog = chatGptWebRuntime.log
      this.chatGptWeb = chatGptWebRuntime.engine ?? new ChatGptWebEngine({
        browser: chatGptWebRuntime.browser,
        workspace,
        storePath: chatGptWebRuntime.storePath!,
        ...(chatGptWebRuntime.log ? { log: chatGptWebRuntime.log } : {}),
      })
    }
    if (geminiWebRuntime) {
      this.geminiWebBrowser = geminiWebRuntime.browser
      this.geminiWebLog = geminiWebRuntime.log
      this.geminiWeb = geminiWebRuntime.engine ?? new GeminiWebEngine({
        browser: geminiWebRuntime.browser,
        workspace,
        storePath: geminiWebRuntime.storePath!,
        ...(geminiWebRuntime.log ? { log: geminiWebRuntime.log } : {}),
      })
    }
  }

  setExtensionRouter(router: ExtensionRouter): void {
    this.extensions = router
  }

  /**
   * ND's isolated task worktrees live beside the project repository by design,
   * so a session rooted in one is still this project's session even though it
   * is not a descendant of the workspace root. The organization layer supplies
   * the exact roots it created; nothing else widens the workspace boundary.
   */
  setWorktreeGuard(guard: ((cwd: string) => boolean) | undefined): void {
    this.worktreeGuard = guard
  }

  /** Every direct engine emits through the same ND organization/renderer fan-out. */
  setEmitter(emit: (frame: DshEventFrame) => void): void {
    const routed = (frame: DshEventFrame): void => {
      this.captureDirectTranscript(frame)
      emit(frame)
    }
    this.chatGptWeb?.setEmitter(routed)
    this.geminiWeb?.setEmitter(routed)
    for (const direct of this.directEngines.values()) direct.setEmitter?.(routed)
  }

  private get zcode(): ZcodeCliEngine | undefined {
    return this.directEngines.get(ZCODE_CLI_ENGINE_ID) as ZcodeCliEngine | undefined
  }

  async run(prompt: string, options?: HarnessRunOptions): Promise<HarnessRunResult> {
    const requested = options?.sessionId
      ? this.engineForSession(options.sessionId)
      : options?.engineId ?? ND_HARNESS_ENGINE_ID
    if (!options?.sessionId) this.assertKnownEngine(requested)
    if (requested === ND_NATIVE_ENGINE_ID) {
      await (this.directEngines.get(requested) as NdNativeEngine | undefined)?.start()
    }
    const providerId = requested === ND_HARNESS_ENGINE_ID || requested === ND_NATIVE_ENGINE_ID
      ? options?.provider ?? this.harness.status().provider
      : undefined
    const directTarget = this.directEngines.get(requested)
    const requestedSessionId = options?.sessionId
    const workspaceDirect = Boolean(directTarget) && this.isWorkspaceDirectEngine(requested)
    const engineSessionCwd = workspaceDirect && requestedSessionId
      ? directTarget?.listSessions().find((item) => item.sessionId === requestedSessionId)?.cwd
      : undefined
    const boundSessionCwd = requestedSessionId ? this.workspaceRootBySession.get(requestedSessionId) : undefined
    const requestedRunCwd = options?.workspaceCwd?.trim()
    if (boundSessionCwd && requestedRunCwd && !sameWorkspaceRoot(boundSessionCwd, requestedRunCwd)) {
      throw new Error('Run requested a different workspace than the ND-bound session; create a new session instead of re-rooting this one')
    }
    if (boundSessionCwd && engineSessionCwd && !sameWorkspaceRoot(boundSessionCwd, engineSessionCwd)) {
      throw new Error('Direct engine changed the ND-bound task workspace; create a new session instead of re-rooting this one')
    }
    const sessionCwd = boundSessionCwd ?? engineSessionCwd
    if (workspaceDirect && requestedSessionId) {
      if (!sessionCwd || !this.sessionRootAllowed(sessionCwd)) throw new Error('Session belongs to a different project workspace')
    }
    if (!options?.sessionId && this.browserAccess) {
      const defaultCwd = workspaceDirect ? this.workspace.state().root : undefined
      const created = await this.createSession(requested, defaultCwd)
      options = { ...options, sessionId: created.sessionId }
    }
    const webChatSkill = requested === CHATGPT_WEB_ENGINE_ID || requested === GEMINI_WEB_ENGINE_ID
    const skill = await this.skills?.prepare(prompt, options?.skillScope, options?.skillSelectionId, webChatSkill ? 'chat' : 'agent')
    const targetSessionId = options?.sessionId
    if (skill && targetSessionId && !directTarget && requested !== CHATGPT_WEB_ENGINE_ID && requested !== GEMINI_WEB_ENGINE_ID) {
      const result = await this.harness.gatewayRpc('session.list')
      const items = (result.value as { items?: Array<{ sessionId?: string; cwd?: string }> } | undefined)?.items
      const session = items?.find((item) => item.sessionId === targetSessionId)
      if (!result.ok || !session?.cwd || !this.sessionRootAllowed(session.cwd)) throw new Error('Skill session does not belong to the active workspace')
    }
    if (skill && targetSessionId && requested === CHATGPT_WEB_ENGINE_ID) {
      const session = this.chatGptWeb?.listSessions().find((candidate) => candidate.sessionId === targetSessionId)
      if (session?.cwd && !this.sessionRootAllowed(session.cwd)) throw new Error('Skill session does not belong to the active workspace')
    }
    if (skill && targetSessionId && requested === GEMINI_WEB_ENGINE_ID) {
      const session = this.geminiWeb?.listSessions().find((candidate) => candidate.sessionId === targetSessionId)
      if (session?.cwd && !this.sessionRootAllowed(session.cwd)) throw new Error('Skill session does not belong to the active workspace')
    }
    let routedPrompt = this.extensions
      ? await this.extensions.decoratePrompt(skill?.prompt ?? prompt, requested, providerId)
      : skill?.prompt ?? prompt
    // Prompt Shield runs on the user/skill/extension text before ND appends its
    // own scoped tokens, which must reach the engine untouched.
    routedPrompt = this.shieldPrompt(routedPrompt, options?.promptShieldOverride)
    if (options?.sessionId && this.browserAccess && requested !== ND_NATIVE_ENGINE_ID && requested !== CHATGPT_WEB_ENGINE_ID && requested !== GEMINI_WEB_ENGINE_ID) {
      const token = this.browserAccess.issueSessionAccess(options.sessionId)
      routedPrompt += `\n\n<nd-browser-access>\nOpaque browser access token for this ND session: ${token}\nPass it unchanged as accessToken on every nd_browser_call. Do not expose it in user-facing output.\n</nd-browser-access>`
    }
    // The vault hint is only useful to engines that can run a command. Web
    // engines and the Rust agent have no shell, so they never see it.
    if (this.vaultAccess
      && requested !== ND_NATIVE_ENGINE_ID
      && requested !== CHATGPT_WEB_ENGINE_ID
      && requested !== GEMINI_WEB_ENGINE_ID) {
      const hint = await this.vaultAccess.hint().catch(() => undefined)
      if (hint) routedPrompt += `\n\n${hint}`
    }
    // Built-in Token Saver is deliberately applied at the common engine
    // boundary, after ND has added trusted extension context and before either
    // the Harness or direct engines receive the turn.
    const optimizedPrompt = skill ? routedPrompt : tokenSaverRuntime()?.optimize(routedPrompt, { kind: 'prompt' }).text ?? routedPrompt
    if (skill) {
      await this.skills!.assertScope(skill.scope)
      if (skill.mention.selectionId) await this.skills!.detail(skill.mention.selectionId)
    }
    if (skill && this.messageStore) {
      const sessionId = options?.sessionId ?? (await this.createSession(requested)).sessionId
      options = { ...options, sessionId }
      await this.skills!.assertScope(skill.scope)
      await this.messageStore.rememberSkillMessage(sessionId, optimizedPrompt, prompt, skill.mention)
      await this.messageStore.rememberSkillMessage(sessionId, stripWorkspaceContext(optimizedPrompt).trim(), prompt, skill.mention)
      await this.messageStore.rememberSkillMessage(sessionId, appendWorkspaceContext(optimizedPrompt, this.workspace.state()), prompt, skill.mention)
    }
    const direct = this.directEngines.get(requested)
    // Cost measurement sits at the shared engine boundary: the route the turn
    // will use and the bytes ND actually hands to an engine are known here for
    // every engine, before any vendor protocol is involved.
    if (options?.sessionId) {
      const metrics = taskMetricsRecorder()
      metrics?.noteRoute(options.sessionId, {
        engineId: requested,
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {}),
      })
      metrics?.notePrompt(options.sessionId, optimizedPrompt)
    }
    if (direct) {
      const files = options?.files ?? []
      const images = options?.images ?? []
      const base64Images = BASE64_IMAGE_DIRECT_ENGINES.has(requested) ? images : []
      const localImageEngine = LOCAL_IMAGE_DIRECT_ENGINES.has(requested)
      const stagedImages = base64Images.length === images.length ? [] : images
      if (!this.isWorkspaceDirectEngine(requested)) {
        const staged = await stageAttachments(files, stagedImages, undefined, { manifestImages: !localImageEngine })
        const promptWithAttachments = staged.suffix ? `${optimizedPrompt}\n\n${staged.suffix}` : optimizedPrompt
        try {
          return await direct.run(promptWithAttachments, {
            ...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
            ...(options?.model !== undefined ? { model: options.model } : {}),
            ...(base64Images.length > 0 ? { images: base64Images } : {}),
            ...(localImageEngine && staged.imagePaths.length > 0 ? { imagePaths: staged.imagePaths } : {}),
          })
        } finally {
          await staged.cleanup()
        }
      }
      this.workspace.assertUsable()
      const workspace = this.workspace.state()
      const cwd = sessionCwd ?? workspace.root
      const staged = await stageAttachments(files, stagedImages, cwd, { manifestImages: !localImageEngine })
      const promptWithAttachments = staged.suffix ? `${optimizedPrompt}\n\n${staged.suffix}` : optimizedPrompt
      try {
        return await direct.run(appendWorkspaceContext(promptWithAttachments, workspace, cwd), {
          ...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
          ...(options?.model !== undefined ? { model: options.model } : {}),
          ...(options?.provider !== undefined ? { provider: options.provider } : {}),
          ...(options?.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
          ...(base64Images.length > 0 ? { images: base64Images } : {}),
          ...(localImageEngine && staged.imagePaths.length > 0 ? { imagePaths: staged.imagePaths } : {}),
          // A session keeps the root it was created with. Re-rooting every turn
          // at the active workspace would run an isolated task worktree's worker
          // against the base checkout, which is exactly what per-task isolation
          // exists to prevent; the workspace root is only the default for a
          // session that has no root of its own.
          cwd,
        })
      } finally {
        await staged.cleanup()
      }
    }
    if (requested === CHATGPT_WEB_ENGINE_ID) {
      const harnessState = this.harness.status().state
      if (harnessState === 'running' || harnessState === 'starting') {
        throw new Error('ChatGPT Web and ND Harness share the visible browser. Finish the active ND Harness turn before starting ChatGPT Web.')
      }
      if (this.geminiWeb?.listSessions().some((session) => session.running)) {
        throw new Error('ChatGPT Web and Gemini Web share the visible browser. Finish the active Gemini Web turn before starting ChatGPT Web.')
      }
      const engine = this.requireChatGptWeb()
      const workspaceRoot = this.workspace.state().root
      if (options?.sessionId) {
        const session = engine.listSessions().find((candidate) => candidate.sessionId === options.sessionId)
        if (session?.cwd && session.cwd !== workspaceRoot) {
          throw new Error('This ChatGPT Web chat belongs to a different project workspace. Reopen that project before continuing the chat.')
        }
      }
      const browser = this.chatGptWebBrowser
      const focus = this.browserFocus(browser)
      const result = await engine.run(this.shieldPrompt(appendWebTextFiles(optimizedPrompt, options?.files ?? [], 'ChatGPT Web'), options?.promptShieldOverride), {
        ...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        cwd: workspaceRoot,
        ...(options?.images?.length ? { images: options.images } : {}),
      })
      // ChatGPT temporarily owns the canonical visible browser while the turn
      // is active. After a successful turn, hand the pane back to the tab and
      // profile the user had, so any Git fast-forward becomes visible again
      // and a chat bound to another profile does not leave that identity
      // selected. On auth/setup errors leave ChatGPT visible so the user can
      // fix the page and retry.
      await this.restoreBrowserFocus(browser, focus)
      return result
    }
    if (requested === GEMINI_WEB_ENGINE_ID) {
      const harnessState = this.harness.status().state
      if (harnessState === 'running' || harnessState === 'starting') {
        throw new Error('Gemini Web and ND Harness share the visible browser. Finish the active ND Harness turn before starting Gemini Web.')
      }
      if (this.chatGptWeb?.listSessions().some((session) => session.running)) {
        throw new Error('Gemini Web and ChatGPT Web share the visible browser. Finish the active ChatGPT Web turn before starting Gemini Web.')
      }
      const engine = this.requireGeminiWeb()
      const workspaceRoot = this.workspace.state().root
      if (options?.sessionId) {
        const session = engine.listSessions().find((candidate) => candidate.sessionId === options.sessionId)
        if (session?.cwd && session.cwd !== workspaceRoot) {
          throw new Error('This Gemini Web chat belongs to a different project workspace. Reopen that project before continuing the chat.')
        }
      }
      const browser = this.geminiWebBrowser
      const focus = this.browserFocus(browser)
      const result = await engine.run(this.shieldPrompt(appendWebTextFiles(optimizedPrompt, options?.files ?? [], 'Gemini Web'), options?.promptShieldOverride), {
        ...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options?.model !== undefined ? { model: options.model } : {}),
        cwd: workspaceRoot,
        ...(options?.images?.length ? { images: options.images } : {}),
      })
      // Like ChatGPT Web, Gemini owns the canonical visible browser while the
      // turn is active; the pane returns to the user's own tab and profile
      // afterwards. On auth/setup errors leave Gemini visible so the user can
      // fix the page.
      await this.restoreBrowserFocus(browser, focus)
      return result
    }
    if (this.chatGptWeb?.listSessions().some((session) => session.running) || this.geminiWeb?.listSessions().some((session) => session.running)) {
      throw new Error('ND Harness and its Web chats share the visible browser. Finish the active web chat turn before starting ND Harness.')
    }
    const harnessCwd = sessionCwd ?? requestedRunCwd
    const staged = await stageAttachments(options?.files ?? [], [], harnessCwd)
    const harnessPrompt = staged.suffix ? `${optimizedPrompt}\n\n${staged.suffix}` : optimizedPrompt
    try {
      return await this.harness.run(harnessPrompt, harnessCwd ? { ...options, workspaceCwd: harnessCwd } : options)
    } finally {
      await staged.cleanup()
    }
  }

  /**
   * Run one private router turn on a web engine. The session is hidden from
   * chat lists and persistence, starts a fresh conversation, and is deleted
   * after the reply so external API calls never inherit prior context.
   */
  async runWebLane(input: {
    engineId: string
    prompt: string
    model?: string
    signal?: AbortSignal
  }): Promise<{ text: string; engineId: string; model: string; latencyMs: number }> {
    const engineId = input.engineId === CHATGPT_WEB_ENGINE_ID
      ? CHATGPT_WEB_ENGINE_ID
      : input.engineId === GEMINI_WEB_ENGINE_ID
        ? GEMINI_WEB_ENGINE_ID
        : undefined
    if (!engineId) throw new Error(`Router web lane is not supported: ${input.engineId}`)
    if (input.signal?.aborted) throw new WebTurnError({ code: 'cancelled', message: 'Web lane request was cancelled', phase: 'open' })

    const harnessState = this.harness.status().state
    // A Harness that is only starting does not own the browser yet; blocking on
    // it strands private lanes behind a runtime that may never become ready.
    if (harnessState === 'running') {
      throw new WebTurnError({
        code: 'page-busy',
        message: 'ND Harness is using the visible browser. Wait for its turn to finish, then retry.',
        phase: 'open',
      })
    }
    const otherEngine = engineId === CHATGPT_WEB_ENGINE_ID ? this.geminiWeb : this.chatGptWeb
    if (otherEngine?.listSessions().some((session) => session.running)) {
      throw new WebTurnError({
        code: 'page-busy',
        message: 'The other web engine is using the visible browser. Wait for its turn to finish, then retry.',
        phase: 'open',
      })
    }
    const engine = engineId === CHATGPT_WEB_ENGINE_ID ? this.requireChatGptWeb() : this.requireGeminiWeb()
    if (engine.listSessions().some((session) => session.running)) {
      throw new WebTurnError({
        code: 'page-busy',
        message: 'This web engine already has an active turn. Wait for it to finish, then retry.',
        phase: 'open',
      })
    }

    // Prompt Shield gates the text before any browser session is opened.
    const prompt = this.shieldPrompt(input.prompt)
    const workspaceRoot = this.workspace.state().root
    const browser = engineId === CHATGPT_WEB_ENGINE_ID ? this.chatGptWebBrowser : this.geminiWebBrowser
    const started = Date.now()
    const created = await engine.createSession({
      cwd: workspaceRoot,
      hidden: true,
      isolated: true,
      // A private lane runs in the identity the user is browsing as, and the
      // session records it so a retry after a restart lands in the same jar.
      ...(browser ? { profileId: browser.activeProfileId() } : {}),
      title: engineId === CHATGPT_WEB_ENGINE_ID ? 'ND Router · ChatGPT Web' : 'ND Router · Gemini Web',
    })
    const sessionId = created.sessionId
    let keepTab = false
    let laneTabId: string | undefined
    let detachHeadless: (() => void) | undefined
    const stopOnAbort = (): void => {
      void engine.stop(sessionId).catch(() => undefined)
    }
    input.signal?.addEventListener('abort', stopOnAbort, { once: true })

    try {
      if (input.signal?.aborted) {
        throw new WebTurnError({ code: 'cancelled', message: 'Web lane request was cancelled', phase: 'open' })
      }
      // Router turns are headless: the lane tab is attached with a full page
      // viewport but only one pixel inside the window, so Chromium keeps the
      // page visible and streaming while the app UI stays in front. The window
      // is never raised or focused.
      if (browser) {
        const tabId = await engine.ensureBrowserTab(sessionId)
        laneTabId = tabId ?? undefined
        if (tabId) {
          if (engineId === GEMINI_WEB_ENGINE_ID && !browser.windowIsOnScreen()) {
            // Gemini stops streaming when Chromium hides its page, which is
            // what a minimized or hidden ND window produces.
            throw new WebTurnError({
              code: 'page-busy',
              message: "Gemini Web streams only while ND's window is on screen. Restore the ND window, then retry.",
              phase: 'open',
            })
          }
          detachHeadless = browser.attachTabForRouterTurn(tabId)
        }
      }
      if (engineId === GEMINI_WEB_ENGINE_ID) {
        await this.requireGeminiWeb().run(prompt, {
          sessionId,
          cwd: workspaceRoot,
          isolated: true,
          transports: ['cdp'],
          ...(input.model?.trim() ? { model: input.model.trim() } : {}),
        })
      } else {
        await this.requireChatGptWeb().run(prompt, {
          sessionId,
          cwd: workspaceRoot,
          isolated: true,
          transports: ['cdp'],
        })
      }
      const transcript = await engine.transcript(sessionId)
      const text = extractLatestAssistantText(transcript.events)
      if (!text) {
        throw new WebTurnError({
          code: 'empty-reply',
          message: `${engineId === CHATGPT_WEB_ENGINE_ID ? 'ChatGPT Web' : 'Gemini Web'} finished without an assistant reply`,
          phase: 'wait',
        })
      }
      return {
        text,
        engineId,
        model: input.model?.trim() || 'default',
        latencyMs: Date.now() - started,
      }
    } catch (error) {
      if (error instanceof WebTurnError && (error.code === 'login-required' || error.code === 'challenge')) {
        // Leave the page visible so the user can sign in or clear the challenge.
        keepTab = true
      }
      throw error
    } finally {
      input.signal?.removeEventListener('abort', stopOnAbort)
      detachHeadless?.()
      await engine.deleteSession(sessionId, { closeTab: !keepTab }).catch((error) => {
        this.chatGptWebLog?.(`[router web lane] could not clean up session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      })
      if (keepTab && browser && laneTabId && browser.tabUrl(laneTabId) !== undefined) {
        // A login or challenge page is only useful where the user can see it:
        // hand the lane's tab, and the profile that owns it, over visibly.
        await browser.activateTab(laneTabId).catch(() => undefined)
      }
    }
  }

  /** True while any ChatGPT Web or Gemini Web turn is in flight. */
  hasRunningWebTurn(): boolean {
    return Boolean(
      this.chatGptWeb?.listSessions().some((session) => session.running)
      || this.geminiWeb?.listSessions().some((session) => session.running),
    )
  }

  /** The tab and profile the user was looking at before a web turn took over. */
  private browserFocus(browser: BrowserController | undefined): { profileId: string; tabId: string } | undefined {
    if (!browser || typeof browser.activeProfileId !== 'function' || typeof browser.activeTabId !== 'function') {
      return undefined
    }
    return { profileId: browser.activeProfileId(), tabId: browser.activeTabId() }
  }

  /**
   * Return the visible browser to the tab and profile the user had before a
   * web turn. Activating the original tab also restores its profile identity;
   * when that tab is gone, the profile switch alone brings the user's tab set
   * back.
   */
  private async restoreBrowserFocus(
    browser: BrowserController | undefined,
    focus: { profileId: string; tabId: string } | undefined,
  ): Promise<void> {
    if (!browser || !focus) return
    if (typeof browser.tabUrl === 'function' && typeof browser.activateTab === 'function'
      && browser.tabUrl(focus.tabId) !== undefined) {
      await browser.activateTab(focus.tabId).catch(() => undefined)
      return
    }
    if (typeof browser.switchProfile === 'function') {
      await browser.switchProfile(focus.profileId).catch(() => undefined)
    }
  }

  /**
   * Create a session on the engine named by a catalog descriptor id. An
   * explicit cwd is the portable isolation seam used by organization task
   * worktrees; interactive chat keeps the active workspace default. A title
   * names the session after its real work on engines that keep durable
   * titles; engines that own their own thread labels ignore it.
   */
  async createSession(engineId: string, cwd?: string, title?: string): Promise<{ sessionId: string; engineId: string }> {
    this.assertKnownEngine(engineId)
    const direct = this.directEngines.get(engineId)
    if (direct) {
      const workspaceDirect = this.isWorkspaceDirectEngine(engineId)
      const targetCwd = workspaceDirect ? (cwd ?? this.workspace.state().root) : undefined
      const sessionId = (await direct.createSession(
        workspaceDirect && targetCwd ? { cwd: targetCwd } : {},
      )).sessionId
      this.logicalEngineBySession.set(sessionId, engineId)
      if (workspaceDirect && targetCwd) this.workspaceRootBySession.set(sessionId, targetCwd)
      return { engineId, sessionId }
    }
    const targetCwd = cwd ?? this.workspace.state().root
    if (engineId === CHATGPT_WEB_ENGINE_ID) {
      const sessionId = (await this.requireChatGptWeb().createSession({ cwd: targetCwd })).sessionId
      this.logicalEngineBySession.set(sessionId, engineId)
      return { engineId, sessionId }
    }
    if (engineId === GEMINI_WEB_ENGINE_ID) {
      const sessionId = (await this.requireGeminiWeb().createSession({ cwd: targetCwd })).sessionId
      this.logicalEngineBySession.set(sessionId, engineId)
      return { engineId, sessionId }
    }
    if (cwd === undefined) {
      const sessionId = await this.harness.createSession()
      this.logicalEngineBySession.set(sessionId, engineId)
      this.workspaceRootBySession.set(sessionId, targetCwd)
      await this.renameHarnessSession(sessionId, title)
      return { engineId, sessionId }
    }
    const result = await this.harness.gatewayRpc('session.create', { cwd: targetCwd })
    if (!result.ok) throw new Error(result.error?.message ?? 'Harness session.create failed')
    const sessionId = (result.value as { sessionId?: unknown } | undefined)?.sessionId
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Harness session.create returned no session id')
    this.logicalEngineBySession.set(sessionId, engineId)
    this.workspaceRootBySession.set(sessionId, targetCwd)
    await this.renameHarnessSession(sessionId, title)
    return { engineId, sessionId }
  }

  /**
   * Best-effort harness rename: the runtime's first-prompt fallback title
   * ("You are Builder acting as…") hides the session's real work from the
   * chat sidebar, so callers name org sessions directly. A failure must
   * never fail the session the title decorates.
   */
  private async renameHarnessSession(sessionId: string, title?: string): Promise<void> {
    const trimmed = title?.trim()
    if (!trimmed) return
    try {
      await this.harness.renameSession(sessionId, trimmed)
    } catch (cause) {
      console.warn(`engine router: session rename failed for ${sessionId}:`, cause instanceof Error ? cause.message : String(cause))
    }
  }

  /** Cancel exactly one engine session; unrelated organization workers continue. */
  async stopSession(sessionId: string): Promise<void> {
    this.browserAccess?.revokeSessionAccess(sessionId)
    const engine = this.engineForSession(sessionId)
    const direct = this.directEngines.get(engine)
    if (direct) {
      await direct.stop(sessionId)
      return
    }
    if (engine === CHATGPT_WEB_ENGINE_ID) {
      await this.requireChatGptWeb().stop(sessionId)
      return
    }
    if (engine === GEMINI_WEB_ENGINE_ID) {
      await this.requireGeminiWeb().stop(sessionId)
      return
    }
    const result = await this.harness.gatewayRpc('session.cancel', { sessionId })
    if (!result.ok) throw new Error(result.error?.message ?? 'Harness session.cancel failed')
  }

  /** Cancel pending turns on every engine; each keeps its runtime available. */
  async stop(): Promise<HarnessStatus> {
    await this.chatGptWeb?.stop()
    await this.geminiWeb?.stop()
    for (const direct of this.directEngines.values()) await direct.stop()
    return this.harness.stop()
  }

  /** Release router-owned resources without double-closing bootstrap-owned engines. */
  async close(): Promise<void> {
    await this.chatGptWeb?.close()
    await this.geminiWeb?.close()
    await Promise.all([...this.routerOwnedDirectEngines].map(async (direct) => { await direct.close?.() }))
  }

  /** Approval/question answers are routed by who issued the rpcId. */
  respond(rpcId: string, value: unknown): Promise<void> {
    for (const direct of this.directEngines.values()) {
      if (direct.handlesApproval(rpcId)) return direct.respond(rpcId, value)
    }
    if (this.chatGptWeb?.handlesApproval(rpcId)) return this.chatGptWeb.respond(rpcId, value)
    if (this.geminiWeb?.handlesApproval(rpcId)) return this.geminiWeb.respond(rpcId, value)
    return this.harness.respond(rpcId, value)
  }

  sessions(): EngineSessionSummary[] {
    const workspaceRoot = this.workspace.state().root
    const workspaceSessions = [
      ...this.chatGptWeb?.listSessions() ?? [],
      ...this.geminiWeb?.listSessions() ?? [],
      ...[...this.directEngines.entries()]
        .filter(([engineId]) => this.isWorkspaceDirectEngine(engineId))
        .flatMap(([, direct]) => direct.listSessions()),
    ].filter((session) => session.cwd === undefined || sessionInWorkspace(workspaceRoot, session.cwd) || this.worktreeGuard?.(session.cwd) === true)
    const interactiveSessions = [...this.directEngines.entries()]
      .filter(([engineId]) => !this.isWorkspaceDirectEngine(engineId))
      .flatMap(([, direct]) => direct.listSessions())
    return [...workspaceSessions, ...interactiveSessions].filter((session) => session.hidden !== true)
  }

  /** Activate the chat's owned browser tab, creating it after a restart. */
  async ensureEngineBrowserTab(sessionId: string): Promise<string | null> {
    if (this.chatGptWeb?.ownsSession(sessionId)) return await this.chatGptWeb.ensureBrowserTab(sessionId)
    if (this.geminiWeb?.ownsSession(sessionId)) return await this.geminiWeb.ensureBrowserTab(sessionId)
    return null
  }

  async transcript(sessionId: string): Promise<EngineSessionTranscript> {
    for (const direct of this.directEngines.values()) {
      if (!direct.ownsSession(sessionId)) continue
      const fallback = await direct.transcript(sessionId)
      const events = await this.nativeTranscript(sessionId, fallback.events)
      return { ...fallback, events }
    }
    if (this.chatGptWeb?.ownsSession(sessionId)) {
      // ChatGPT Web already owns durable restart persistence. Keep it out of
      // the volatile nd-core journal so this migration does not duplicate its
      // 500-event retained history or change browser-session recovery.
      return this.chatGptWeb.transcript(sessionId)
    }
    if (this.geminiWeb?.ownsSession(sessionId)) {
      // Gemini Web persists its own transcript, same as ChatGPT Web.
      return this.geminiWeb.transcript(sessionId)
    }
    throw new Error(`No engine owns session: ${sessionId}`)
  }

  private captureDirectTranscript(frame: DshEventFrame): void {
    if (!this.sessionJournal || frame.kind !== 'session-event' || !frame.sessionId || !frame.event) return
    const engineId = this.engineForSession(frame.sessionId)
    if (engineId === CHATGPT_WEB_ENGINE_ID || engineId === GEMINI_WEB_ENGINE_ID) return
    const structuredChunk = STRUCTURED_TRANSCRIPT_ENGINE_IDS.has(engineId) && frame.event.type === 'assistant/chunk'
    if (!TRANSCRIPT_EVENT_TYPES.has(frame.event.type) && !structuredChunk) return
    void this.sessionJournal.append(frame.sessionId, [{
      type: frame.event.type,
      seq: frame.event.seq,
      time: frame.event.time,
      ...(frame.event.data === undefined ? {} : { data: frame.event.data }),
      ...(frame.event.surfaceOp === undefined ? {} : { surfaceOp: frame.event.surfaceOp }),
    }]).catch(() => undefined)
  }

  private async nativeTranscript(sessionId: string, fallback: SessionEventEnvelope[]): Promise<SessionEventEnvelope[]> {
    if (!this.sessionJournal) return fallback
    const native = await this.sessionJournal.tail(sessionId, 500).catch(() => [])
    if (native.length === 0) return fallback

    // nd-core journals are intentionally volatile. After a sidecar restart the
    // first new native event must not hide the adapter's local safety tail from
    // just before the restart. Merge by the session sequence; in the normal
    // case the fallback is simply a 32-event subset of native history.
    const bySeq = new Map<number, SessionEventEnvelope>()
    for (const event of fallback) bySeq.set(event.seq, event)
    for (const event of native) {
      bySeq.set(event.seq, {
        type: event.type,
        seq: event.seq,
        time: event.time ?? Date.now(),
        ...(event.data === undefined ? {} : { data: event.data }),
        ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
      })
    }
    return [...bySeq.values()].sort((left, right) => left.seq - right.seq).slice(-500)
  }

  /**
   * Native model catalog for engines that expose one; engines whose model
   * configuration has no ND-visible picker return an empty list.
   */
  async models(engineId: string): Promise<EngineModelOption[]> {
    if (engineId === GEMINI_WEB_ENGINE_ID) return await this.geminiWeb?.listModels() ?? []
    const direct = this.directEngines.get(engineId)
    if (direct) return direct.listModels()
    return []
  }

  /**
   * Restart the ZCode app-server child so the next turn picks up freshly
   * written CLI config (model provider). Native sessions are durable and
   * resume by id, but a turn in flight is never interrupted: when any ZCode
   * session is running the restart is deferred to the next write or app
   * launch, which is fine because the config only gates session creation.
   */
  async restartZcodeRuntime(): Promise<void> {
    const zcode = this.zcode
    if (!zcode || zcode.listSessions().some((session) => session.running)) return
    await zcode.close()
  }

  private assertKnownEngine(engineId: string): void {
    if (engineId === ND_NATIVE_ENGINE_ID) {
      if (!nativePrivateSelectionEnabled()) {
        throw new Error('ND Agent is private; set ND_DSH_NATIVE_PRIVATE_SELECTION=1 only after running the milestone validation gate')
      }
      const native = this.directEngines.get(engineId) as NdNativeEngine | undefined
      if (!native?.ready()) throw new Error('ND Agent runtime is unavailable')
      return
    }
    if (
      engineId === ND_HARNESS_ENGINE_ID
      || engineId === CODEX_ENGINE_ID
      || engineId === CHATGPT_WEB_ENGINE_ID
      || engineId === GEMINI_WEB_ENGINE_ID
      || this.directEngines.has(engineId)
    ) return
    throw new Error(`Unknown coding engine: ${engineId}`)
  }

  private isWorkspaceDirectEngine(engineId: string): boolean {
    return engineId !== MINIMAX_CLI_ENGINE_ID
  }

  /** The active workspace, or a task worktree ND isolate-created for it. */
  private sessionRootAllowed(cwd: string): boolean {
    if (sessionInWorkspace(this.workspace.state().root, cwd)) return true
    return this.worktreeGuard?.(cwd) === true
  }

  private engineForSession(sessionId: string): string {
    const logical = this.logicalEngineBySession.get(sessionId)
    if (logical) return logical
    for (const [engineId, direct] of this.directEngines) {
      if (direct.ownsSession(sessionId)) return engineId
    }
    if (this.chatGptWeb?.ownsSession(sessionId)) return CHATGPT_WEB_ENGINE_ID
    if (this.geminiWeb?.ownsSession(sessionId)) return GEMINI_WEB_ENGINE_ID
    return ND_HARNESS_ENGINE_ID
  }

  getChatGptWeb(): ChatGptWebEngine | undefined {
    return this.chatGptWeb
  }

  private requireChatGptWeb(): ChatGptWebEngine {
    if (!this.chatGptWeb) {
      throw new Error('ChatGPT Web is unavailable because ND did not initialize its visible-browser Git-sync runtime.')
    }
    return this.chatGptWeb
  }

  getGeminiWeb(): GeminiWebEngine | undefined {
    return this.geminiWeb
  }

  private requireGeminiWeb(): GeminiWebEngine {
    if (!this.geminiWeb) {
      throw new Error('Gemini Web is unavailable because ND did not initialize its visible-browser runtime.')
    }
    return this.geminiWeb
  }

  private shieldPrompt(text: string, override?: 'mask' | 'allow'): string {
    const shield = promptShieldRuntime()
    if (!shield) return text
    const result = shield.apply(text, override)
    if (result.blocked) throw promptShieldBlockedError(shield.blockedPayload(result))
    return result.text
  }
}

function appendWebTextFiles(prompt: string, files: readonly HarnessRunFile[], engineName: string): string {
  if (files.length === 0) return prompt
  const inline = inlineTextAttachments(files)
  if (inline.unsupported.length > 0) {
    const names = inline.unsupported.slice(0, 6).map((file) => file.relativePath ?? file.name).join(', ')
    const more = inline.unsupported.length > 6 ? ` and ${inline.unsupported.length - 6} more` : ''
    throw new Error(`${engineName} can attach images and text/code files only. Use a CLI engine for binary files or folders: ${names}${more}`)
  }
  return inline.suffix ? `${prompt}\n\n${inline.suffix}` : prompt
}

function sameWorkspaceRoot(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const root = resolve(value)
    return process.platform === 'win32' ? root.toLowerCase() : root
  }
  return normalize(left) === normalize(right)
}
