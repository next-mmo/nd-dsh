import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  ChatGptProjectBinding,
  DshEventFrame,
  EngineSessionSummary,
  EngineSessionTranscript,
  SessionEventEnvelope,
} from '../../../shared/contracts.js'
import { CHATGPT_WEB_ENGINE_ID } from '../../../shared/coding-engines.js'
import { stripWorkspaceContext } from '../../../shared/workspace-context.js'
import type { BrowserController } from '../../browser/browser-controller.js'
import { CHATGPT_DOM_TURNS_SCRIPT } from '../../browser/chatgpt-dom-turns.js'
import type { GitService } from '../../git/git-service.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import {
  type DiscoveredProjectItem,
  matchProjectByNameOrPrefix,
  parseChatGptConversationUrl,
  parseChatGptProjectInput,
} from './chatgpt-project-binding.js'

const CHATGPT_HOME_URL = 'https://chatgpt.com/'
// Signed-in project pages use ProseMirror without the old prompt ID or Lexical
// attribute; signed-out guest chats use the mobile composer textarea instead.
const CHATGPT_COMPOSER_SELECTOR = '[data-testid="prompt-textarea"], #prompt-textarea, #mobile-composer-prompt, [contenteditable="true"][data-lexical-editor="true"], form .ProseMirror[contenteditable="true"], form .ProseMirror[contenteditable="plaintext-only"]'
const TRANSCRIPT_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'agent/reasoning'])
const MAX_TRANSCRIPT_EVENTS = 500
const MAX_PROMPT_CHARS = 100_000
const CHATGPT_READY_TIMEOUT_MS = 15_000
const CHATGPT_TURN_TIMEOUT_MS = 10 * 60_000
const CDP_CONNECT_TIMEOUT_MS = 5_000
const CDP_CALL_TIMEOUT_MS = 15_000
const TURN_POLL_MS = 350
const REMOTE_POLL_MS = 2_000
const BACKGROUND_WATCH_MS = 5_000
const BACKGROUND_REMOTE_POLL_MS = 10_000

interface StoredChatGptWebSession {
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
  branch: string
  remote?: string
  lastRemoteSha?: string
  gitMode?: 'none' | 'sync'
  chatGptProjectRef?: string
  chatGptChatId?: string
}

interface PersistedChatGptWebStore {
  version: 1
  sessions: StoredChatGptWebSession[]
  projectBindings?: Record<string, ChatGptProjectBinding>
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
  turns: ChatGptDomTurn[]
}

export interface ChatGptGitContext {
  remote: string
  remoteUrl: string
  branch: string
  head: string
  dirty: boolean
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

export interface ChatGptWebEngineOptions {
  browser: BrowserController
  git: GitService
  workspace: WorkspaceService
  storePath: string
  log?: (line: string) => void
}

/** Stable, Git-safe branch name derived from one ND engine session. */
export function chatGptSyncBranchName(sessionId: string): string {
  const suffix = sessionId.replace(/^chatgpt-web-/, '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)
    || createHash('sha256').update(sessionId).digest('hex').slice(0, 10)
  return `nd/chat-${suffix.toLowerCase()}`
}

/** Never leak credentials or credential-like URL metadata into a web prompt. */
export function sanitizeRemoteForPrompt(remoteUrl: string): string {
  const trimmed = remoteUrl.trim()
  try {
    const parsed = new URL(trimmed)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    // SCP-style SSH remotes such as git@github.com:owner/repo.git are not URLs.
    return trimmed
  }
}

export function compileChatGptGitPrompt(prompt: string, context: ChatGptGitContext): string {
  return [
    '<nd-git-sync>',
    `Remote: ${sanitizeRemoteForPrompt(context.remoteUrl)}`,
    `Remote name: ${context.remote}`,
    `Branch: ${context.branch}`,
    `Expected local HEAD: ${context.head}`,
    `Local working tree: ${context.dirty ? 'dirty (uncommitted local changes are NOT on the remote)' : 'clean'}`,
    '',
    'Use this Git branch as the shared code transport for this ND chat.',
    `Before editing, read/pull the latest ${context.remote}/${context.branch}.`,
    `If your connected ChatGPT coding/Git tools allow writes, commit and push completed code changes to ${context.remote}/${context.branch}.`,
    'Never push this task directly to main or master.',
    'If you do not have a writable Git/coding tool in ChatGPT, say that clearly and do not claim code was pushed.',
    '</nd-git-sync>',
    '',
    prompt,
  ].join('\n')
}

/**
 * ChatGPT Web is a conversation transport, not a second local harness. It
 * drives ND's already-visible browser target over the loopback CDP endpoint;
 * code moves through the user's Git remote and GitService remains the only
 * local mutation authority.
 */
export class ChatGptWebEngine {
  private readonly sessions = new Map<string, StoredChatGptWebSession>()
  private readonly projectBindings = new Map<string, ChatGptProjectBinding>()
  private readonly activeTurns = new Map<string, AbortController>()
  private readonly remoteCheckedAt = new Map<string, number>()
  private onEvent: ((frame: DshEventFrame) => void) | undefined
  private watcherBusy = false
  private readonly watchTimer: ReturnType<typeof setInterval>

  constructor(private readonly options: ChatGptWebEngineOptions) {
    this.loadStore()
    this.watchTimer = setInterval(() => { void this.watchTick() }, BACKGROUND_WATCH_MS)
    this.watchTimer.unref?.()
  }

  getProjectBinding(workspaceRoot: string): ChatGptProjectBinding | null {
    const direct = this.projectBindings.get(workspaceRoot)
    if (direct) return direct
    const wsState = this.options.workspace.state()
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
        const cdp = await VisibleCdpConnection.connect(this.options.browser)
        try {
          const items = await cdp.evaluate<DiscoveredProjectItem[]>(`(() => {
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
          cdp.close()
        }
      }
    } catch {
      // Auto-discovery is best effort; unbound chats use the ChatGPT home page.
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
      }))
  }

  transcript(sessionId: string): EngineSessionTranscript {
    const session = this.requireSession(sessionId)
    return { sessionId, engineId: CHATGPT_WEB_ENGINE_ID, events: [...session.transcript] }
  }

  async createSession(input: { cwd?: string } = {}): Promise<{ sessionId: string }> {
    const sessionId = `chatgpt-web-${randomUUID()}`
    const now = Date.now()
    const session: StoredChatGptWebSession = {
      sessionId,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      title: 'New ChatGPT Web chat',
      createdAt: now,
      updatedAt: now,
      running: false,
      sequence: 0,
      transcript: [],
      seenTurnKeys: [],
      sentPromptHashes: [],
      branch: chatGptSyncBranchName(sessionId),
    }
    this.sessions.set(sessionId, session)
    this.persistStore()
    this.emitFrame({ kind: 'session-added', sessionId, meta: { engineId: CHATGPT_WEB_ENGINE_ID } })
    return { sessionId }
  }

  async run(prompt: string, input: { sessionId?: string; cwd?: string } = {}): Promise<{ sessionId: string }> {
    const cleaned = stripWorkspaceContext(prompt).trim()
    if (!cleaned) throw new Error('Prompt cannot be empty')
    if (cleaned.length > MAX_PROMPT_CHARS) throw new Error(`Prompt exceeds the ${MAX_PROMPT_CHARS.toLocaleString()} character limit`)

    let session = input.sessionId === undefined ? undefined : this.sessions.get(input.sessionId)
    if (input.sessionId !== undefined && !session) throw new Error(`Unknown ${CHATGPT_WEB_ENGINE_ID} session: ${input.sessionId}`)
    if (!session) {
      const created = await this.createSession({ cwd: input.cwd ?? this.options.workspace.state().root })
      session = this.sessions.get(created.sessionId)
    }
    if (!session) throw new Error(`${CHATGPT_WEB_ENGINE_ID} session could not be created`)
    if (session.running) throw new Error('This ChatGPT Web chat already has an active turn')
    if ([...this.sessions.values()].some((candidate) => candidate.running && candidate.sessionId !== session.sessionId)) {
      throw new Error('ChatGPT Web uses ND\'s single visible browser pane. Finish the active ChatGPT Web turn before starting another one.')
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
        const gitContext = await this.prepareGit(session, abort.signal)
        const compiledPrompt = gitContext ? compileChatGptGitPrompt(cleaned, gitContext) : cleaned
        const baselineAssistantCount = before.turns.filter((turn) => turn.role === 'assistant').length
        assertTurnActive(abort.signal)
        await this.submitPrompt(cdp, compiledPrompt, abort.signal)
        this.recordUserMessage(session, cleaned)
        this.rememberSentPrompt(session, compiledPrompt)
        if (compiledPrompt !== cleaned) this.rememberSentPrompt(session, cleaned)
        if (session.title === 'New ChatGPT Web chat') session.title = cleaned.slice(0, 80)
        const completed = await this.waitForAssistant(cdp, session, baselineAssistantCount, abort.signal)
        this.captureConversationUrl(session, completed.url)
        const assistant = [...completed.turns].reverse().find((turn) => turn.role === 'assistant')
        if (!assistant?.text.trim()) throw new Error('ChatGPT Web completed without a readable assistant message')
        this.recordAssistantMessage(session, assistant.text.trim())
        this.markAllTurnsSeen(session, completed)
        await this.syncRemoteIfChanged(session, true)
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
      : [this.sessions.get(sessionId)].filter((session): session is StoredChatGptWebSession => session?.running === true)
    for (const session of targets) {
      this.activeTurns.get(session.sessionId)?.abort()
      if (!this.browserMayHostSession(session)) continue
      try {
        const cdp = await VisibleCdpConnection.connect(this.options.browser)
        try {
          await cdp.evaluate<boolean>(`(() => { const button = document.querySelector('button[data-testid="stop-button"]'); if (!(button instanceof HTMLElement)) return false; button.click(); return true })()`)
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

  private async openBoundConversation(session: StoredChatGptWebSession, signal: AbortSignal): Promise<VisibleCdpConnection> {
    assertTurnActive(signal)
    const binding = await this.resolveProjectBinding(session.cwd ?? this.options.workspace.state().root, signal)
    if (binding) session.chatGptProjectRef = binding.chatGptProjectRef
    else delete session.chatGptProjectRef

    const targetUrl = session.conversationUrl && isChatGptConversationUrl(session.conversationUrl)
      ? session.conversationUrl
      : binding?.chatGptProjectUrl || CHATGPT_HOME_URL
    const currentUrl = this.options.browser.state().url
    if (!sameConversationUrl(currentUrl, targetUrl)) await this.options.browser.navigate(targetUrl)
    assertTurnActive(signal)
    await this.options.browser.ensureAgentReady()
    assertTurnActive(signal)
    const cdp = await VisibleCdpConnection.connect(this.options.browser)
    try {
      const deadline = Date.now() + CHATGPT_READY_TIMEOUT_MS
      while (Date.now() < deadline) {
        assertTurnActive(signal)
        const snapshot = await this.captureSnapshot(cdp)
        assertTurnActive(signal)
        if (snapshot.composer) return cdp
        await cdp.evaluate<boolean>(`(() => {
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
          const btn = Array.from(document.querySelectorAll('button, a')).filter(isVisible).find(el => {
            const text = el.innerText?.trim() || '';
            return text.includes('New chat in') || text.includes('New chat');
          });
          if (btn instanceof HTMLElement) { btn.click(); return true; }
          return false;
        })()`).catch(() => false)
        await sleep(250)
      }
      const projectScope = binding?.chatGptProjectRef ? ` for project "${binding.projectName}"` : ''
      throw new Error(`ChatGPT Web is open in ND's visible Browser pane, but the composer${projectScope} is unavailable. Sign in to chatgpt.com and ensure the chat composer is accessible, then resend this message.`)
    } catch (error) {
      cdp.close()
      throw error
    }
  }

  private async prepareGit(session: StoredChatGptWebSession, signal: AbortSignal): Promise<ChatGptGitContext | null> {
    assertTurnActive(signal)
    const workspaceRoot = this.options.workspace.state().root
    if (session.cwd !== workspaceRoot) {
      throw new Error('This ChatGPT Web chat belongs to a different workspace. Reopen the chat from its original project before syncing Git.')
    }

    // Validate the shared remote and committed HEAD before changing branches.
    // A project that is not ready for Git sync must fail without mutating its checkout.
    const initialState = await this.options.git.refresh()
    assertTurnActive(signal)
    const started = session.transcript.some((event) => event.type === 'user/message')
    // Git is optional for every project. This also repairs sessions created
    // before project Git became root-scoped: a nested project must not inherit
    // its parent's remote and then fail during Web sync.
    if (initialState.remotes.length === 0) {
      session.gitMode = 'none'
      delete session.remote
      delete session.lastRemoteSha
      return null
    }
    if (started && session.gitMode === 'none') return null
    if (!started && initialState.branch) session.branch = initialState.branch
    session.gitMode = 'sync'
    const remote = session.remote && initialState.remotes.includes(session.remote)
      ? session.remote
      : initialState.remotes.includes('origin') ? 'origin' : initialState.remotes[0]
    if (!remote) throw new Error('ChatGPT Web Git sync requires a configured Git remote for this workspace.')
    const remoteUrl = await this.options.git.remoteUrl(remote)
    assertTurnActive(signal)
    if (!remoteUrl) throw new Error(`Git remote ${remote} has no fetch/push URL.`)
    if (!await this.options.git.head()) {
      throw new Error('ChatGPT Web Git sync requires at least one local commit before the first turn.')
    }

    try {
      assertTurnActive(signal)
      await this.options.git.ensureBranch(session.branch)
      assertTurnActive(signal)
      await this.options.git.pushBranch(remote, session.branch)
      assertTurnActive(signal)
      const head = await this.options.git.head()
      if (!head) throw new Error('ChatGPT Web Git sync requires a committed Git HEAD before the first turn.')
      const remoteSha = await this.options.git.remoteBranchHead(remote, session.branch)
      if (!remoteSha) throw new Error(`Git remote ${remote}/${session.branch} did not expose the pushed branch.`)
      session.remote = remote
      session.lastRemoteSha = remoteSha
      this.persistStore()
      return {
        remote,
        remoteUrl,
        branch: session.branch,
        head,
        dirty: await this.options.git.hasUncommittedChanges(),
      }
    } catch (error) {
      session.gitMode = 'none'
      delete session.remote
      delete session.lastRemoteSha
      this.persistStore()
      const message = error instanceof Error ? error.message : String(error)
      this.recordReasoning(session, `Git sync to ${remote}/${session.branch} was skipped (${message}). Continuing in non-git conversation mode.`)
      return null
    }
  }

  private async submitPrompt(cdp: VisibleCdpConnection, prompt: string, signal: AbortSignal): Promise<void> {
    assertTurnActive(signal)
    const source = JSON.stringify(prompt)
    const result = await cdp.evaluate<{ ok: boolean; reason?: string }>(`(async () => {
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
    for (let index = 0; index < 50; index += 1) {
      assertTurnActive(signal)
      const sent = await cdp.evaluate<boolean>(`(() => {
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
          button.click();
          return true;
        }
        return false;
      })()`)
      if (sent) return
      await sleep(100)
    }
    assertTurnActive(signal)
    throw new Error('ChatGPT Web could not send the message (send-button-unavailable). Reload ChatGPT and retry.')
  }

  private async waitForAssistant(
    cdp: VisibleCdpConnection,
    session: StoredChatGptWebSession,
    baselineAssistantCount: number,
    signal: AbortSignal,
  ): Promise<ChatGptDomSnapshot> {
    const deadline = Date.now() + CHATGPT_TURN_TIMEOUT_MS
    let stableText = ''
    let stableCount = 0
    let lastRemotePoll = 0
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('ChatGPT Web turn was stopped.')
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
      if (Date.now() - lastRemotePoll >= REMOTE_POLL_MS) {
        lastRemotePoll = Date.now()
        await this.syncRemoteIfChanged(session, false).catch((error) => {
          this.options.log?.(`[chatgpt-web] remote sync deferred: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      await sleep(TURN_POLL_MS)
    }
    throw new Error('ChatGPT Web turn exceeded the 10 minute completion deadline.')
  }

  private async captureSnapshot(cdp: VisibleCdpConnection): Promise<ChatGptDomSnapshot> {
    return cdp.evaluate<ChatGptDomSnapshot>(`(() => {
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
      return {
        url: location.href,
        title: document.title,
        composer: hasComposer,
        busy: hasStop || lastAssistant?.imagesPending === true,
        complete: lastAssistant?.complete === true,
        turns,
      };
    })()`)
  }

  private async syncRemoteIfChanged(session: StoredChatGptWebSession, announce: boolean): Promise<void> {
    if (!session.remote || !session.lastRemoteSha) return
    if (session.cwd !== this.options.workspace.state().root) return
    const state = this.options.git.current
    if (state.branch !== session.branch) return
    const remoteSha = await this.options.git.remoteBranchHead(session.remote, session.branch)
    if (!remoteSha || remoteSha === session.lastRemoteSha) return
    await this.options.git.fastForwardBranch(session.remote, session.branch)
    session.lastRemoteSha = remoteSha
    session.updatedAt = Date.now()
    this.persistStore()
    if (announce) this.recordReasoning(session, `Git sync fast-forwarded ${session.remote}/${session.branch} to ${remoteSha.slice(0, 8)}. Local preview files are up to date.`)
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
        changed = true
        return
      }
      const strippedUserText = turn.role === 'user' ? (stripWorkspaceContext(turn.text).trim() || turn.text) : turn.text
      if (turn.role === 'user' && (sent.has(hashText(turn.text)) || sent.has(hashText(strippedUserText)))) {
        seen.add(key)
        changed = true
        return
      }
      if (turn.role === 'user') this.recordUserMessage(session, strippedUserText)
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
    this.watcherBusy = true
    try {
      const currentUrl = this.options.browser.state().url
      const visibleSessions = [...this.sessions.values()].filter(
        (session) => !session.running && session.conversationUrl !== undefined && sameConversationUrl(currentUrl, session.conversationUrl),
      )
      if (visibleSessions.length > 0) {
        try {
          const cdp = await VisibleCdpConnection.connect(this.options.browser)
          try {
            const snapshot = await this.captureSnapshot(cdp)
            for (const visibleSession of visibleSessions) {
              this.importUnseenTurns(visibleSession, snapshot)
            }
          } finally {
            cdp.close()
          }
        } catch (error) {
          this.options.log?.(`[chatgpt-web] visible conversation sync skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      const now = Date.now()
      for (const session of this.sessions.values()) {
        if (session.running || !session.remote || !session.lastRemoteSha) continue
        if (session.cwd !== this.options.workspace.state().root) continue
        if (this.options.git.current.branch !== session.branch) continue
        if (now - (this.remoteCheckedAt.get(session.sessionId) ?? 0) < BACKGROUND_REMOTE_POLL_MS) continue
        this.remoteCheckedAt.set(session.sessionId, now)
        await this.syncRemoteIfChanged(session, true).catch((error) => {
          this.options.log?.(`[chatgpt-web] background remote sync skipped: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    } finally {
      this.watcherBusy = false
    }
  }

  private recordUserMessage(session: StoredChatGptWebSession, text: string): void {
    this.recordEnvelope(session, {
      type: 'user/message',
      data: { message: { role: 'user', content: [{ type: 'text', text }] } },
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
        if (typeof session.branch !== 'string' || !/^[\w][\w.\-/]{0,255}$/.test(session.branch) || session.branch.includes('..') || session.branch.endsWith('.lock')) session.branch = chatGptSyncBranchName(session.sessionId)
        if (typeof session.conversationUrl !== 'string' || !isChatGptConversationUrl(session.conversationUrl)) delete session.conversationUrl
        session.running = false
        session.transcript = Array.isArray(session.transcript) ? session.transcript.slice(-MAX_TRANSCRIPT_EVENTS) : []
        session.seenTurnKeys = Array.isArray(session.seenTurnKeys) ? session.seenTurnKeys.slice(-500) : []
        session.sentPromptHashes = Array.isArray(session.sentPromptHashes) ? session.sentPromptHashes.slice(-100) : []
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
      sessions: [...this.sessions.values()],
      projectBindings: bindingsObj,
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
