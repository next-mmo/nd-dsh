import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { DshEventFrame, EngineModelOption, EngineSessionSummary, EngineSessionTranscript, SessionEventEnvelope } from '../../../shared/contracts.js'
import { ND_NATIVE_ENGINE_ID } from '../../../shared/coding-engines.js'
import { ndAgentBinPath } from '../../app-paths.js'
import type { ProviderStore } from '../../providers.js'
import { noteModelUsage } from '../../metrics/task-metrics.js'
import { tokenSaverRuntime } from '../../token-saver/token-saver-runtime.js'

interface RpcPending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export interface NativeToolRequest {
  sessionId: string
  cwd: string
  name: string
  arguments: Record<string, unknown>
}

export interface NdNativeEngineOptions {
  providers: Pick<ProviderStore, 'nativeAgentRoute' | 'list'>
  dataDir: string
  tool(request: NativeToolRequest): Promise<unknown>
  spawnProcess?: typeof spawn
  binaryPath?: string
}

/** Supervised stdio client for the ND-owned Rust agent. All model secrets cross
 * this private pipe for one turn only; they never appear in argv or logs. */
export class NdNativeEngine {
  private child: ChildProcess | undefined
  private starting: Promise<void> | undefined
  private readonly pending = new Map<string, RpcPending>()
  private readonly approvals = new Set<string>()
  private readonly sessions = new Map<string, EngineSessionSummary>()
  private onEvent: ((frame: DshEventFrame) => void) | undefined

  constructor(private readonly options: NdNativeEngineOptions) {}

  setEmitter(emit: (frame: DshEventFrame) => void): void { this.onEvent = emit }

  ready(): boolean { return existsSync(this.options.binaryPath ?? ndAgentBinPath()) }

  hasPersistedSessions(): boolean {
    try {
      return readdirSync(this.options.dataDir, { withFileTypes: true }).some(
        (entry) => entry.isDirectory() && entry.name.startsWith('nd-native-'),
      )
    } catch {
      return false
    }
  }

  ownsSession(sessionId: string): boolean {
    return sessionId.startsWith('nd-native-') || this.sessions.has(sessionId)
  }

  handlesApproval(rpcId: string): boolean { return this.approvals.has(rpcId) }

  async respond(rpcId: string, value: unknown): Promise<void> {
    if (!this.approvals.has(rpcId)) throw new Error(`Unknown ND Agent approval: ${rpcId}`)
    const outcome = typeof value === 'object' && value !== null
      ? (value as { outcome?: unknown }).outcome : undefined
    await this.rpc('approval.respond', { approvalId: rpcId, outcome: typeof outcome === 'string' ? outcome : 'rejected' })
    this.approvals.delete(rpcId)
  }

  async listModels(): Promise<EngineModelOption[]> {
    return this.options.providers.list().filter((provider) => provider.enabled)
      .flatMap((provider) => provider.models.map((model) => ({ id: `${provider.id}/${model.id}`, name: `${provider.name} · ${model.id}` })))
  }

  listSessions(): EngineSessionSummary[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async transcript(sessionId: string): Promise<EngineSessionTranscript> {
    const value = await this.rpc('session.history', { sessionId }) as { events?: SessionEventEnvelope[] }
    return { sessionId, engineId: ND_NATIVE_ENGINE_ID, events: value.events ?? [] }
  }

  async createSession(input: { cwd?: string; model?: string } = {}): Promise<{ sessionId: string }> {
    if (!input.cwd) throw new Error('ND Agent requires a workspace')
    const result = await this.rpc('session.create', { cwd: input.cwd }) as EngineSessionSummary
    this.sessions.set(result.sessionId, result)
    return { sessionId: result.sessionId }
  }

  async run(prompt: string, options: { sessionId?: string; cwd?: string; provider?: string; model?: string; permissionMode?: string } = {}): Promise<{ sessionId: string }> {
    const sessionId = options.sessionId ?? (await this.createSession(options.cwd ? { cwd: options.cwd } : {})).sessionId
    const slash = options.model?.indexOf('/') ?? -1
    const selectedProvider = slash > 0 && !options.provider ? options.model!.slice(0, slash) : options.provider
    const selectedModel = slash > 0 && !options.provider ? options.model!.slice(slash + 1) : options.model
    const route = this.options.providers.nativeAgentRoute(selectedProvider, selectedModel)
    const tokenSaver = tokenSaverRuntime()?.settings()
    const compactContext = tokenSaver ? tokenSaver.ndEnabled && tokenSaver.mode !== 'off' : true
    await this.rpc('turn.start', { sessionId, prompt, cwd: options.cwd, route, compactContext, permissionMode: options.permissionMode ?? 'workspace-write' })
    return { sessionId }
  }

  async stop(sessionId?: string): Promise<void> {
    if (!this.child) return
    const targets = sessionId ? [sessionId] : this.listSessions().filter((item) => item.running).map((item) => item.sessionId)
    await Promise.all(targets.map((id) => this.rpc('turn.cancel', { sessionId: id }).then(() => undefined)))
  }

  async close(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (!child) return
    child.kill()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('ND Agent closed'))
    }
    this.pending.clear()
    this.approvals.clear()
  }

  async start(): Promise<void> {
    if (this.child && !this.child.killed) return
    if (this.starting) return this.starting
    this.starting = this.spawnAndInitialize().finally(() => { this.starting = undefined })
    return this.starting
  }

  private async spawnAndInitialize(): Promise<void> {
    const binary = this.options.binaryPath ?? ndAgentBinPath()
    if (!existsSync(binary)) throw new Error('ND Agent binary is unavailable')
    const child = (this.options.spawnProcess ?? spawn)(binary, ['serve', '--stdio', '--data-dir', this.options.dataDir], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    this.child = child
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', (line) => { void this.onLine(line) })
    child.stderr?.on('data', () => { /* Never forward model/provider data to application logs. */ })
    child.once('error', (error) => this.onExit(error.message))
    child.once('exit', () => this.onExit('ND Agent process exited'))
    try {
      const models = this.options.providers.list().filter((provider) => provider.enabled)
        .flatMap((provider) => provider.models.map((model) => ({ id: `${provider.id}/${model.id}`, name: `${provider.name} · ${model.id}` })))
      await this.rawRpc('initialize', { protocolVersion: 1, models })
      const result = await this.rawRpc('session.list', {}) as { items?: EngineSessionSummary[] }
      for (const item of result.items ?? []) this.sessions.set(item.sessionId, item)
    } catch (error) {
      child.kill()
      if (this.child === child) this.child = undefined
      throw error
    }
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    await this.start()
    return this.rawRpc(method, params)
  }

  private rawRpc(method: string, params: unknown): Promise<unknown> {
    const child = this.child
    if (!child?.stdin?.writable) return Promise.reject(new Error('ND Agent pipe is unavailable'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ND Agent ${method} timed out`))
      }, method === 'initialize' ? 10_000 : 30_000)
      this.pending.set(id, { resolve, reject, timer })
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
      child.stdin!.write(line, (error) => {
        if (error) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }

  private async onLine(line: string): Promise<void> {
    if (line.length > 8 * 1024 * 1024) return
    let message: Record<string, unknown>
    try { message = JSON.parse(line) as Record<string, unknown> } catch { return }
    const id = typeof message.id === 'string' ? message.id : undefined
    if (id && message.method === 'host.tool') {
      try {
        const result = await this.options.tool(message.params as NativeToolRequest)
        this.send({ jsonrpc: '2.0', id, result })
      } catch (error) {
        this.send({ jsonrpc: '2.0', id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })
      }
      return
    }
    if (id) {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      const error = message.error as { message?: string } | undefined
      if (error) pending.reject(new Error(error.message ?? 'ND Agent request failed'))
      else pending.resolve(message.result)
      return
    }
    if (message.method === 'event' && message.params && typeof message.params === 'object') {
      const frame = message.params as DshEventFrame
      if (frame.kind === 'session-event' && frame.sessionId && frame.event?.type === 'model/usage') {
        noteModelUsage(frame.sessionId, 'cli-steps', frame.event.data)
      }
      if (frame.kind === 'approval-requested' && frame.rpcId) this.approvals.add(frame.rpcId)
      if (frame.kind === 'approval-resolved' && frame.approvalId) this.approvals.delete(frame.approvalId)
      if (frame.sessionId && frame.kind === 'session-status') {
        const session = this.sessions.get(frame.sessionId)
        if (session) this.sessions.set(frame.sessionId, { ...session, running: frame.running === true, updatedAt: Date.now() })
      }
      if (frame.sessionId && frame.kind === 'session-added') {
        void this.rawRpc('session.resume', { sessionId: frame.sessionId })
          .then((value) => this.sessions.set(frame.sessionId!, value as EngineSessionSummary)).catch(() => undefined)
      }
      this.onEvent?.(frame)
    }
  }

  private send(value: unknown): void {
    this.child?.stdin?.write(JSON.stringify(value) + '\n')
  }

  private onExit(reason: string): void {
    this.child = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
    this.approvals.clear()
    for (const [sessionId, session] of this.sessions) {
      if (!session.running) continue
      this.sessions.set(sessionId, { ...session, running: false })
      this.onEvent?.({ kind: 'agent-error', sessionId, message: reason })
      this.onEvent?.({ kind: 'session-status', sessionId, running: false })
    }
  }
}
