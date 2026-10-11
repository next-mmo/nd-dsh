import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  DshEventFrame,
  EngineModelOption,
  EngineSessionSummary,
  EngineSessionTranscript,
  SessionEventEnvelope,
} from '../../../shared/contracts.js'
import { PI_CODING_ENGINE_ID } from '../../../shared/coding-engines.js'
import { stripWorkspaceContext } from '../../../shared/workspace-context.js'
import { managedPiAgentDir, piBinPath } from '../../app-paths.js'
import { appBrowserConfigPath, DEFAULT_AGENT_BROWSER_SESSION } from '../../browser/agent-browser-client.js'
import { parseContextWindow, protocolFromApiFormat, resolveRuntimeHeaders } from '../../provider-runtime.js'
import type { ProviderStore } from '../../providers.js'
import {
  deferred,
  engineEnvironment,
  killProcessTree,
  spawnCliCommand,
  summarize,
  TRANSCRIPT_EVENT_TYPES,
  type Deferred,
} from '../agent-cli/agent-cli-support.js'

/**
 * ND-owned direct Pi engine. Each ND session hosts one long-lived `pi --mode
 * rpc` child driven over the documented JSONL RPC wires: `prompt` commands
 * in, agent events back on stdout, with `agent_settled` closing each turn.
 * Native Pi authentication and model configuration stay authoritative; ND
 * fail-closes extension dialogs because there is no human to answer them. A
 * child death is healed on the next run by reloading the persisted session
 * file via `switch_session`.
 */

const LOCAL_TRANSCRIPT_EVENTS = 32
const MODELS_CACHE_TTL_MS = 5 * 60_000
const COMMAND_TIMEOUT_MS = 30_000

const PROVIDER_ENV_MAP: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  kimi: 'KIMI_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  xai: 'XAI_API_KEY',
  'azure-openai': 'AZURE_OPENAI_API_KEY',
}

interface TurnOutcome {
  status: string
  failureMessage?: string
}

interface CommandWaiter {
  resolve: (data: Record<string, unknown> | undefined) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  label: string
}

interface PiSession {
  sessionId: string
  /** Persisted pi session file, learned from `get_state`; reloads after a respawn. */
  nativeSessionFile?: string
  cwd?: string
  model?: string
  title: string
  createdAt: number
  updatedAt: number
  running: boolean
  sequence: number
  transcript: SessionEventEnvelope[]
  turnSettled?: Deferred<TurnOutcome>
  child?: ChildProcess
  /** In-flight attach work for the active child; awaited before any command. */
  attachPromise?: Promise<void>
  /** Partial stdout line of the active child. */
  buffer: string
  cmdSeq: number
  commandWaiters: Map<string, CommandWaiter>
  turnAssistantText: string
  /** Text streamed for the open assistant message; `message_end` finalizes it. */
  streamingText?: string
}

export interface PiCodingEngineOptions {
  /** Diagnostic sink for CLI stderr and lifecycle warnings. */
  log?: (line: string) => void
  /** Test seam: process spawner (defaults to node:child_process.spawn). */
  spawnProcess?: typeof spawn
  /** Provider store to inject active model credentials and routes into Pi turns. */
  providers?: () => ProviderStore | undefined
  /** Base skills directory to forward to Pi CLI via --skill. */
  skillsDir?: () => string | undefined
}

export class PiCodingEngine {
  private readonly sessions = new Map<string, PiSession>()
  private modelsCache: { at: number; models: EngineModelOption[] } | undefined
  private onEvent: ((frame: DshEventFrame) => void) | undefined
  private stopping = false

  constructor(private readonly options: PiCodingEngineOptions = {}) {}

  /** Frames translated into the shared event vocabulary leave through here. */
  setEmitter(emit: (frame: DshEventFrame) => void): void {
    this.onEvent = emit
  }

  ready(): boolean {
    return piBinPath() !== undefined
  }

  /** Whether a session id belongs to this engine (run routing). */
  ownsSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** ND fail-closes Pi extension dialogs; no approval gate pends here. */
  handlesApproval(_rpcId: string): boolean {
    return false
  }

  /** No approval can ever pend here; answering one is a routing bug. */
  async respond(rpcId: string, _value: unknown): Promise<void> {
    throw new Error(`Unknown ${PI_CODING_ENGINE_ID} approval: ${rpcId}`)
  }

  listSessions(): EngineSessionSummary[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => ({
        sessionId: session.sessionId,
        engineId: PI_CODING_ENGINE_ID,
        title: session.title,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        running: session.running,
      }))
  }

  transcript(sessionId: string): EngineSessionTranscript {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown ${PI_CODING_ENGINE_ID} session: ${sessionId}`)
    return { sessionId, engineId: PI_CODING_ENGINE_ID, events: [...session.transcript] }
  }

  /**
   * The `get_available_models` catalog from a short-lived RPC child, cached
   * briefly so opening the picker never re-spawns the CLI. Selection stays
   * native to Pi: an unset model means "whatever the CLI is configured with".
   */
  async listModels(): Promise<EngineModelOption[]> {
    const store = this.options.providers?.()
    if (store) {
      try {
        const enabled = store.allEnabled?.() ?? (store.enabled() ? [store.enabled()!] : [])
        if (enabled.length > 0) {
          const models: EngineModelOption[] = []
          for (const provider of enabled) {
            for (const model of provider.models) {
              const qualifiedId = `${provider.id}/${model.id}`
              if (!models.some((item) => item.id === qualifiedId)) {
                models.push({ id: qualifiedId, name: `${provider.name} · ${model.id}` })
              }
            }
          }
          return models
        }
      } catch {
        // Fallback gracefully to probed models below
      }
    }

    const cached = this.modelsCache
    if (cached && Date.now() - cached.at < MODELS_CACHE_TTL_MS) return cached.models
    let models: EngineModelOption[] = []
    try {
      models = await this.probeModels()
    } catch {
      // If Pi's probe fails or Pi has no models configured yet
    }
    this.modelsCache = { at: Date.now(), models }
    return models
  }

  private async probeModels(): Promise<EngineModelOption[]> {
    const bin = piBinPath()
    if (!bin) {
      throw new Error('The Pi coding agent CLI is not installed. Install it with `npm install -g @mariozechner/pi-coding-agent` or set ND_DSH_PI_BINARY.')
    }
    const spawnProcess = this.options.spawnProcess ?? spawn
    return new Promise<EngineModelOption[]>((resolve, reject) => {
      const child = spawnCliCommand(spawnProcess, bin, ['--mode', 'rpc'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.buildEnvironment(),
      })
      let out = ''
      let err = ''
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
        void killProcessTree(child)
      }
      const timer = setTimeout(() => finish(() => reject(new Error('Timed out listing Pi models.'))), 20_000)
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => { out += chunk })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => { err += chunk })
      child.once('error', (error) => finish(() => reject(error)))
      child.once('exit', (code) => finish(() => reject(new Error(`pi models probe failed (${String(code ?? 'unknown')}). ${err.trim().slice(0, 200)}`.trim()))))
      child.stdin?.write(`${JSON.stringify({ id: 'nd-models', type: 'get_available_models' })}\n`)
      const consume = () => {
        let newline = out.indexOf('\n')
        while (newline >= 0) {
          const line = out.slice(0, newline).trim()
          out = out.slice(newline + 1)
          newline = out.indexOf('\n')
          if (!line) continue
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            continue
          }
          if (typeof parsed !== 'object' || parsed === null) continue
          const record = parsed as Record<string, unknown>
          if (record.type !== 'response' || record.id !== 'nd-models') continue
          if (record.success !== true) {
            finish(() => reject(new Error(typeof record.error === 'string' ? record.error : 'Pi model probe failed')))
            return
          }
          const data = typeof record.data === 'object' && record.data !== null ? record.data as Record<string, unknown> : {}
          const models: EngineModelOption[] = []
          for (const model of Array.isArray(data.models) ? data.models : []) {
            if (typeof model !== 'object' || model === null) continue
            const entry = model as Record<string, unknown>
            const provider = typeof entry.provider === 'string' ? entry.provider : ''
            const id = typeof entry.id === 'string' ? entry.id : ''
            if (!id || models.some((existing) => existing.id === `${provider}/${id}`)) continue
            const name = typeof entry.name === 'string' && entry.name ? entry.name : id
            models.push({ id: `${provider}/${id}`, name })
          }
          finish(() => resolve(models))
          return
        }
      }
      child.stdout?.on('data', consume)
    })
  }

  async createSession(input: { cwd?: string; model?: string } = {}): Promise<{ sessionId: string }> {
    const sessionId = `pi-${randomUUID()}`
    const now = Date.now()
    const session: PiSession = {
      sessionId,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.model === undefined ? {} : { model: input.model }),
      title: 'New Pi chat',
      createdAt: now,
      updatedAt: now,
      running: false,
      sequence: 0,
      transcript: [],
      buffer: '',
      cmdSeq: 0,
      commandWaiters: new Map(),
      turnAssistantText: '',
    }
    this.sessions.set(sessionId, session)
    this.emitFrame({ kind: 'session-added', sessionId, meta: { engineId: PI_CODING_ENGINE_ID } })
    return { sessionId }
  }

  /**
   * Submit one prompt to a Pi-backed session (created lazily when no id is
   * given). Progress streams out as frames; the promise settles when the
   * agent reports `agent_settled`.
   */
  async run(prompt: string, options: { sessionId?: string; cwd?: string; model?: string } = {}): Promise<{ sessionId: string }> {
    const cleaned = prompt.trim()
    if (!cleaned) throw new Error('Prompt cannot be empty')
    if (cleaned.length > 100_000) throw new Error('Prompt exceeds the 100,000 character limit')

    let session = options.sessionId !== undefined ? this.sessions.get(options.sessionId) : undefined
    if (options.sessionId !== undefined && !session) throw new Error(`Unknown ${PI_CODING_ENGINE_ID} session: ${options.sessionId}`)
    if (!session) {
      const created = await this.createSession({
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.model === undefined ? {} : { model: options.model }),
      })
      session = this.sessions.get(created.sessionId)
    }
    if (!session) throw new Error(`${PI_CODING_ENGINE_ID} session could not be created`)
    const activeSession = session
    if (activeSession.running) throw new Error('This Pi chat already has an active turn')
    if (options.cwd !== undefined) activeSession.cwd = options.cwd
    if (options.model !== undefined) activeSession.model = options.model
    if (activeSession.model === undefined) {
      const store = this.options.providers?.()
      const enabled = store?.enabled?.()
      if (enabled?.id && enabled.models[0]?.id) {
        activeSession.model = `${enabled.id}/${enabled.models[0].id}`
      }
    }

    const settled = deferred<TurnOutcome>()
    activeSession.turnSettled = settled
    activeSession.turnAssistantText = ''
    try {
      const userPrompt = stripWorkspaceContext(cleaned)
      this.recordUserMessage(activeSession, userPrompt)
      if (activeSession.title === 'New Pi chat') activeSession.title = userPrompt.slice(0, 80)
      const child = this.ensureChild(activeSession)
      await activeSession.attachPromise
      await this.applyModel(activeSession)
      activeSession.running = true
      activeSession.updatedAt = Date.now()
      this.emitFrame({ kind: 'session-status', sessionId: activeSession.sessionId, running: true })
      await this.command(activeSession, { type: 'prompt', message: cleaned })
      const terminal = await settled.promise
      this.finishTurn(activeSession)
      if (terminal.status === 'failed') {
        const message = terminal.failureMessage ?? 'Pi turn failed'
        this.emitFrame({ kind: 'agent-error', sessionId: activeSession.sessionId, message })
        throw new Error(message)
      }
      return { sessionId: activeSession.sessionId }
    } catch (error: unknown) {
      // The turn never published (spawn/startup failure): clean up here.
      if (activeSession.turnSettled === settled) {
        this.finishTurn(activeSession)
        const message = error instanceof Error ? error.message : String(error)
        this.emitFrame({ kind: 'agent-error', sessionId: activeSession.sessionId, message })
      }
      throw error
    }
  }

  /**
   * Stop one Pi-backed session (or every running one) with the `abort`
   * command. The conversation survives: the next run reloads it by session
   * file if the child had to be restarted.
   */
  async stop(sessionId?: string): Promise<void> {
    const targets = sessionId !== undefined
      ? [this.sessions.get(sessionId)]
      : [...this.sessions.values()].filter((item) => item.running)
    for (const session of targets) {
      if (!session) continue
      const child = session.child
      if (!child || child.exitCode !== null || child.signalCode !== null) continue
      child.stdin?.write(`${JSON.stringify({ type: 'abort' })}\n`)
    }
  }

  async close(): Promise<void> {
    this.stopping = true
    const children: ChildProcess[] = []
    for (const session of this.sessions.values()) {
      for (const [, waiter] of session.commandWaiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('Pi engine is shutting down.'))
      }
      session.commandWaiters.clear()
      if (session.child) {
        children.push(session.child)
        delete session.child
      }
      if (!session.running) continue
      session.turnSettled?.resolve({ status: 'failed', failureMessage: 'Pi engine stopped before the turn completed.' })
      this.finishTurn(session)
      this.emitFrame({ kind: 'agent-error', sessionId: session.sessionId, message: 'Pi engine stopped before the turn completed.' })
    }
    await Promise.all(children.map((child) => killProcessTree(child)))
    this.stopping = false
  }

  private resolveSkills(cwd?: string): string[] {
    const skills: string[] = []
    if (cwd) {
      const workspaceSkills = join(cwd, '.agents', 'skills')
      if (existsSync(workspaceSkills)) {
        skills.push(workspaceSkills)
      }
    }
    const presetDir = this.options.skillsDir?.()
    if (presetDir && existsSync(presetDir)) {
      skills.push(presetDir)
    }
    return skills
  }

  private resolveExtensions(cwd?: string): string[] {
    const extensions: string[] = []
    const seen = new Set<string>()

    const addFilesFrom = (dir: string) => {
      if (!existsSync(dir)) return
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.ts') || entry.name.endsWith('.mjs'))) {
            const full = join(dir, entry.name)
            if (!seen.has(full)) {
              seen.add(full)
              extensions.push(full)
            }
          }
        }
      } catch {
        // Directory read error
      }
    }

    if (cwd) {
      addFilesFrom(join(cwd, '.pi', 'extensions'))
    }

    const userHome = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
    addFilesFrom(join(userHome, '.pi', 'agent', 'extensions'))

    return extensions
  }

  /**
   * Synchronize ND model providers and secrets into Pi's config directory (~/.pi/agent or managed directory).
   * Generates models.json and auth.json so custom OpenAI-compatible endpoints,
   * local models, and decrypted credentials work natively in Pi without manual /login.
   */
  private syncAgentConfig(): string {
    const dir = managedPiAgentDir()
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // Ignore directory create errors
    }

    // Preserve any existing auth / models from ~/.pi/agent if available
    const userHome = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
    const userPiAgentDir = join(userHome, '.pi', 'agent')
    let baseAuth: Record<string, unknown> = {}
    let baseModels: { providers?: Record<string, unknown> } = { providers: {} }

    try {
      const userAuthPath = join(userPiAgentDir, 'auth.json')
      if (existsSync(userAuthPath)) {
        baseAuth = JSON.parse(readFileSync(userAuthPath, 'utf8')) as Record<string, unknown>
      }
    } catch {
      // Ignore read errors
    }

    try {
      const userModelsPath = join(userPiAgentDir, 'models.json')
      if (existsSync(userModelsPath)) {
        baseModels = JSON.parse(readFileSync(userModelsPath, 'utf8')) as { providers?: Record<string, unknown> }
      }
    } catch {
      // Ignore read errors
    }

    const authConfig: Record<string, unknown> = { ...baseAuth }
    const providersConfig: Record<string, unknown> = { ...(baseModels.providers ?? {}) }

    const store = this.options.providers?.()
    if (store) {
      try {
        const enabled = store.allEnabled?.() ?? (store.enabled() ? [store.enabled()!] : [])
        for (const provider of enabled) {
          const key = provider.apiKey?.trim()
          if (key) {
            authConfig[provider.id] = { type: 'api_key', key }
            authConfig[provider.id.toLowerCase()] = { type: 'api_key', key }
          }

          let apiProtocol: string = 'openai-completions'
          try {
            apiProtocol = protocolFromApiFormat(provider.apiFormat) ?? 'openai-completions'
          } catch {
            if (provider.id.toLowerCase().includes('anthropic')) apiProtocol = 'anthropic-messages'
            else if (provider.id.toLowerCase().includes('google') || provider.id.toLowerCase().includes('gemini')) apiProtocol = 'google-generative-ai'
          }

          const resolvedHeaders = resolveRuntimeHeaders(provider.headers, provider.baseUrl)
          const models = provider.models.map((m) => ({
            id: m.id,
            name: `${provider.name} · ${m.id}`,
            contextWindow: parseContextWindow(m.context) ?? 128_000,
            input: m.inputTypes?.includes('image') ? (['text', 'image'] as const) : (['text'] as const),
          }))

          providersConfig[provider.id] = {
            name: provider.name,
            ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
            api: apiProtocol,
            apiKey: key || 'placeholder',
            ...(resolvedHeaders && Object.keys(resolvedHeaders).length > 0 ? { headers: resolvedHeaders } : {}),
            models,
          }
        }
      } catch {
        // Fallback gracefully
      }
    }

    const targetDirs = [dir]
    if (userPiAgentDir && userPiAgentDir !== dir && existsSync(userPiAgentDir)) {
      targetDirs.push(userPiAgentDir)
    }

    for (const targetDir of targetDirs) {
      try {
        mkdirSync(targetDir, { recursive: true })
        writeFileSync(join(targetDir, 'models.json'), JSON.stringify({ providers: providersConfig }, null, 2), 'utf8')
        writeFileSync(join(targetDir, 'auth.json'), JSON.stringify(authConfig, null, 2), 'utf8')
      } catch {
        // Ignore write errors
      }
    }

    return dir
  }

  /**
   * Build the child process environment for Pi CLI.
   * Injects ND's embedded browser session, PI_CODING_AGENT_DIR pointing to the
   * synchronized models/credentials, and decrypted provider env vars so turns succeed.
   */
  private buildEnvironment(session?: PiSession): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = engineEnvironment()

    // 1. ND embedded browser session integration (canonical browser)
    try {
      env.ND_DSH_AGENT_BROWSER_CONFIG = appBrowserConfigPath()
      env.AGENT_BROWSER_CONFIG = env.ND_DSH_AGENT_BROWSER_CONFIG
    } catch {
      // Electron or app data path not ready yet in test harness
    }
    env.ND_DSH_AGENT_BROWSER_SESSION = session?.sessionId ?? DEFAULT_AGENT_BROWSER_SESSION
    env.AGENT_BROWSER_SESSION = env.ND_DSH_AGENT_BROWSER_SESSION

    // 2. Synchronize ND providers and credentials into Pi agent dir
    try {
      const agentDir = this.syncAgentConfig()
      env.PI_CODING_AGENT_DIR = agentDir
    } catch {
      // Fallback gracefully
    }

    // 3. ND provider secrets injection into environment
    const store = this.options.providers?.()
    if (store) {
      try {
        const enabled = store.allEnabled?.() ?? (store.enabled() ? [store.enabled()!] : [])
        for (const provider of enabled) {
          const key = provider.apiKey?.trim()
          if (!key) continue
          const envVar = PROVIDER_ENV_MAP[provider.id.toLowerCase()]
          if (envVar && !env[envVar]) {
            env[envVar] = key
          }
          if (provider.id.toLowerCase() === 'openai' && provider.baseUrl && provider.baseUrl !== 'https://api.openai.com/v1') {
            env.OPENAI_BASE_URL = provider.baseUrl
          }
        }
      } catch {
        // Fallback gracefully
      }
    }

    return env
  }

  /**
   * Reuse the session's live child or spawn a fresh `pi --mode rpc` process
   * for it. A respawn reloads the recorded session file so ND-side history
   * and Pi-side context stay the same conversation. The returned child must
   * not receive commands until the session's `attachPromise` settles.
   */
  private ensureChild(session: PiSession): ChildProcess {
    const existing = session.child
    if (existing && existing.exitCode === null && existing.signalCode === null) return existing

    const bin = piBinPath()
    if (!bin) throw new Error('The Pi coding agent CLI is not installed. Install it with `npm install -g @mariozechner/pi-coding-agent` or set ND_DSH_PI_BINARY.')

    const log = this.options.log ?? ((line: string) => console.warn(line))
    const spawnProcess = this.options.spawnProcess ?? spawn
    const args = ['--mode', 'rpc']
    for (const skillPath of this.resolveSkills(session.cwd)) {
      args.push('--skill', skillPath)
    }
    for (const extPath of this.resolveExtensions(session.cwd)) {
      args.push('--extension', extPath)
    }
    const child = spawnCliCommand(spawnProcess, bin, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.buildEnvironment(session),
      cwd: session.cwd ?? process.cwd(),
      // A process group lets POSIX teardown take the whole tree down; Windows
      // uses taskkill /T instead.
      detached: process.platform !== 'win32',
    })
    session.child = child
    session.buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.consumeStdout(session, chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => log(`[pi] ${chunk.trimEnd()}`))
    child.stdin?.on('error', (error) => log(`[pi] stdin write failed: ${error.message}`))
    child.once('exit', (code, signal) => {
      if (session.child !== child) return // intentional teardown already handled it
      delete session.child
      for (const [, waiter] of session.commandWaiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(`Pi CLI exited before ${waiter.label} completed (${signal ?? String(code ?? 'unknown')}).`))
      }
      session.commandWaiters.clear()
      if (this.stopping) return
      const message = `Pi CLI exited (${signal ?? String(code ?? 'unknown')}).`
      if (session.turnSettled) {
        session.turnSettled.resolve({ status: 'failed', failureMessage: message })
        this.finishTurn(session)
      }
    })
    child.once('error', (error) => {
      if (session.child !== child) return
      delete session.child
      if (this.stopping) return
      if (session.turnSettled) {
        session.turnSettled.resolve({ status: 'failed', failureMessage: error.message })
        this.finishTurn(session)
      }
    })

    // A fresh child either continues the recorded conversation or starts the
    // native session ND tracks from here on.
    session.attachPromise = this.attachChild(session, child).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Pi session attach failed: ${message}`)
    })
    return child
  }

  private async attachChild(session: PiSession, child: ChildProcess): Promise<void> {
    if (session.nativeSessionFile !== undefined) {
      const switched = await this.commandOn(child, session, { type: 'switch_session', sessionPath: session.nativeSessionFile })
      if (switched?.cancelled === true) throw new Error('Pi cancelled reloading the persisted session.')
      return
    }
    const state = await this.commandOn(child, session, { type: 'get_state' })
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : undefined
    if (sessionFile) session.nativeSessionFile = sessionFile
  }

  /** Apply ND's selected model to the child when it differs from the active one. */
  private async applyModel(session: PiSession): Promise<void> {
    if (session.model === undefined) return
    let provider = ''
    let modelId = ''
    const separator = session.model.indexOf('/')
    if (separator > 0) {
      provider = session.model.slice(0, separator)
      modelId = session.model.slice(separator + 1)
    } else {
      modelId = session.model
      const store = this.options.providers?.()
      const all = store?.allEnabled?.() ?? (store?.enabled?.() ? [store.enabled()!] : [])
      const matched = all.find((p) => p.models.some((m) => m.id === modelId))
      if (matched) {
        provider = matched.id
      }
    }
    if (provider && modelId) {
      // Model selection is best-effort: pi keeps its configured model.
      await this.command(session, { type: 'set_model', provider, modelId }).catch(() => {})
    }
  }

  /** Run one RPC command on the session's child and wait for its response. */
  private command(session: PiSession, command: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const child = session.child
    if (!child) return Promise.reject(new Error('Pi session is not running'))
    return this.commandOn(child, session, command)
  }

  private commandOn(child: ChildProcess, session: PiSession, command: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(new Error('Pi CLI is not running'))
    }
    session.cmdSeq += 1
    const id = `nd-cmd-${session.cmdSeq}`
    const label = typeof command.type === 'string' ? command.type : 'command'
    return new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const waiter: CommandWaiter = {
        label,
        resolve: (data) => {
          session.commandWaiters.delete(id)
          resolve(data)
        },
        reject: (error) => {
          session.commandWaiters.delete(id)
          reject(error)
        },
        timer: setTimeout(() => {
          session.commandWaiters.delete(id)
          reject(new Error(`Pi command timed out: ${label}`))
        }, COMMAND_TIMEOUT_MS),
      }
      session.commandWaiters.set(id, waiter)
      child.stdin?.write(`${JSON.stringify({ id, ...command })}\n`)
    })
  }

  private consumeStdout(session: PiSession, chunk: string): void {
    session.buffer += chunk
    let newline = session.buffer.indexOf('\n')
    while (newline >= 0) {
      // Pi RPC framing is LF-delimited only; never split on Unicode separators.
      const line = session.buffer.slice(0, newline).replace(/\r$/, '')
      session.buffer = session.buffer.slice(newline + 1)
      if (line.trim()) this.handleWireLine(session, line.trim())
      newline = session.buffer.indexOf('\n')
    }
  }

  private handleWireLine(session: PiSession, line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.options.log?.(`[pi] dropping unparseable stdout line: ${line.slice(0, 200)}`)
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const wire = parsed as Record<string, unknown>

    if (wire.type === 'response') {
      const waiter = typeof wire.id === 'string' ? session.commandWaiters.get(wire.id) : undefined
      if (!waiter) return
      if (wire.success === true) {
        waiter.resolve(typeof wire.data === 'object' && wire.data !== null ? wire.data as Record<string, unknown> : undefined)
      } else {
        waiter.reject(new Error(typeof wire.error === 'string' ? wire.error : `Pi command failed: ${waiter.label}`))
      }
      return
    }

    if (wire.type === 'extension_ui_request') {
      this.handleExtensionDialog(session, wire)
      return
    }

    if (wire.type === 'message_update' && typeof wire.assistantMessageEvent === 'object' && wire.assistantMessageEvent !== null) {
      this.handleStreamDelta(session, wire.assistantMessageEvent as Record<string, unknown>)
      return
    }

    if (wire.type === 'message_end' && typeof wire.message === 'object' && wire.message !== null) {
      this.handleMessageEnd(session, wire.message as Record<string, unknown>)
      return
    }

    if (wire.type === 'tool_execution_start') {
      const callId = typeof wire.toolCallId === 'string' ? wire.toolCallId : `tool-${session.sequence + 1}`
      const name = typeof wire.toolName === 'string' && wire.toolName ? wire.toolName : 'tool'
      this.recordToolCall(session, callId, name, wire.args ?? null)
      return
    }

    if (wire.type === 'tool_execution_end') {
      const callId = typeof wire.toolCallId === 'string' ? wire.toolCallId : `tool-${session.sequence + 1}`
      const result = typeof wire.result === 'object' && wire.result !== null ? wire.result : {}
      const text = contentText((result as Record<string, unknown>).content)
      const failed = wire.isError === true
      this.recordToolResult(session, callId, summarize(text), failed ? summarize(text) || 'tool failed' : undefined)
      return
    }

    if (wire.type === 'agent_settled') {
      session.turnSettled?.resolve({ status: 'success' })
      return
    }

    // agent_start/agent_end/turn_*/queue_update/compaction_*/auto_retry_*
    // stay out of the surface; the message and tool streams above cover it.
  }

  /** Streaming deltas: ND streams assistant text; reasoning is taken at message_end. */
  private handleStreamDelta(session: PiSession, event: Record<string, unknown>): void {
    const type = typeof event.type === 'string' ? event.type : ''
    if (type === 'text_delta' && typeof event.delta === 'string' && event.delta) {
      session.streamingText = (session.streamingText ?? '') + event.delta
      this.recordEnvelope(session, { type: 'assistant/chunk', data: { chunk: { content: [{ type: 'text', text: event.delta }] } } })
    }
    // toolcall_* events are covered by tool_execution_start/end.
  }

  /** `message_end` is authoritative: finalize the streamed text, add reasoning. */
  private handleMessageEnd(session: PiSession, message: Record<string, unknown>): void {
    if (message.role !== 'assistant') return
    const content = Array.isArray(message.content) ? message.content : []
    const finalText = content
      .filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null)
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n')
    if (finalText.trim() && finalText !== session.streamingText) {
      this.recordAssistantMessage(session, finalText)
    } else if (session.streamingText?.trim()) {
      // Close the streaming bubble with its own accumulated text.
      this.recordAssistantMessage(session, session.streamingText)
    }
    delete session.streamingText
    const thinking = content
      .filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null)
      .filter((block) => block.type === 'thinking' && typeof block.thinking === 'string')
      .map((block) => block.thinking as string)
      .join('\n')
    if (thinking.trim()) {
      this.recordEnvelope(session, { type: 'agent/reasoning', data: { text: thinking } })
    }
  }

  /**
   * Pi extension dialogs have no human behind ND's headless sessions, so
   * every dialog is cancelled (fail-closed). Fire-and-forget UI methods need
   * no response at all.
   */
  private handleExtensionDialog(session: PiSession, wire: Record<string, unknown>): void {
    const method = typeof wire.method === 'string' ? wire.method : ''
    const dialogMethods = new Set(['select', 'confirm', 'input', 'editor'])
    if (!dialogMethods.has(method)) return
    const id = typeof wire.id === 'string' ? wire.id : undefined
    if (!id) return
    const child = session.child
    child?.stdin?.write(`${JSON.stringify({ type: 'extension_ui_response', id, cancelled: true })}\n`)
    this.options.log?.(`[pi] cancelled extension dialog (${method}); no human is attached to this session.`)
  }

  private finishTurn(session: PiSession): void {
    const wasActive = session.running || session.turnSettled !== undefined
    if (!wasActive) return
    delete session.streamingText
    session.running = false
    delete session.turnSettled
    session.updatedAt = Date.now()
    this.emitFrame({ kind: 'session-status', sessionId: session.sessionId, running: false })
  }

  private recordUserMessage(session: PiSession, text: string): void {
    this.recordEnvelope(session, {
      type: 'user/message',
      data: { message: { role: 'user', content: [{ type: 'text', text }] } },
    })
  }

  private recordAssistantMessage(session: PiSession, text: string): void {
    session.turnAssistantText += text
    this.recordEnvelope(session, {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
    })
  }

  private recordToolCall(session: PiSession, callId: string, name: string, args: unknown): void {
    this.recordEnvelope(session, { type: 'tool/call', data: { callId, name, arguments: args } })
  }

  private recordToolResult(session: PiSession, callId: string, result: string, error?: string): void {
    this.recordEnvelope(session, {
      type: 'tool/result',
      data: { callId, message: { content: [{ type: 'text', text: result }] }, ...(error === undefined ? {} : { error }) },
    })
  }

  private recordEnvelope(session: PiSession, partial: { type: string; data?: unknown }): void {
    session.sequence += 1
    const envelope: SessionEventEnvelope = {
      type: partial.type,
      seq: session.sequence,
      time: Date.now(),
      ...(partial.data === undefined ? {} : { data: partial.data }),
    }
    if (TRANSCRIPT_EVENT_TYPES.has(envelope.type)) {
      session.transcript.push(envelope)
      if (session.transcript.length > LOCAL_TRANSCRIPT_EVENTS) session.transcript.splice(0, session.transcript.length - LOCAL_TRANSCRIPT_EVENTS)
    }
    this.emitFrame({ kind: 'session-event', sessionId: session.sessionId, event: envelope })
  }

  private emitFrame(frame: DshEventFrame): void {
    this.onEvent?.(frame)
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'text'
      && typeof (block as Record<string, unknown>).text === 'string') {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.join('\n')
}
