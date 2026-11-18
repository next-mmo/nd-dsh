import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { isRouterTtsProviderKind, providerAuthMode, type RouterPlaygroundEvent, type RouterPlaygroundInput, type RouterState } from '../../../shared/router.js'
import type { WorkspaceRegistry } from '../../workspace/workspace-registry.js'
import type { ExtensionPackageStore } from '../package-store.js'
import { AssistantEngine, type RouterChatPort } from './assistant.js'
import { ActiveProjectStore } from './active-project.js'
import { SnapshotCache } from './cache.js'
import { OpenSpecCli } from './openspec-cli.js'
import { RootsStore } from './roots.js'
import { SAFE_ID } from './security.js'
import { TicketStore } from './tickets.js'
import { HttpError, type HubConfig, type ProjectConfig, type RouterChatMessage } from './types.js'
import { WriteService } from './writes.js'

export const OPENSPEC_HUB_ID = 'nd.openspec-hub'
const VENDORED_BIN = path.join('vendor', 'openspec', 'node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js')
const PLAYGROUND_TIMEOUT_MS = 300_000

/** Narrow port over RouterService; the playground lane needs no external key. */
export interface OpenSpecRouterPort {
  state(): Promise<RouterState>
  playgroundStart(input: RouterPlaygroundInput, onEvent: (event: RouterPlaygroundEvent) => void): void
  playgroundStop(requestId: string): void
}

export interface OpenSpecHubDeps {
  workspaces: Pick<WorkspaceRegistry, 'list'>
  packages: Pick<ExtensionPackageStore, 'record' | 'snapshotDir'>
  router?: OpenSpecRouterPort
  /** Hub-owned state (tickets, audit); never inside a watched repository. */
  dataDir: string
}

function canonicalRoot(root: string): string {
  const resolved = path.resolve(root)
  try {
    return existsSync(resolved) ? realpathSync(resolved) : resolved
  } catch {
    return resolved
  }
}

function pathKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function projectIdFor(root: string, taken: Set<string>): string {
  const base = path.basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  let id = SAFE_ID.test(base) ? base : `p-${base}`.slice(0, 64)
  if (!SAFE_ID.test(id)) id = 'project'
  let candidate = id
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${id.slice(0, 60)}-${n}`
  taken.add(candidate)
  return candidate
}

/** Pinned workspaces containing openspec/, explicit extraRoots, and user-registered roots; duplicates collapse by canonical path. */
export function buildHubConfig(
  workspaces: ReadonlyArray<{ root: string; name?: string }>,
  extraRoots: string,
  registered: ReadonlyArray<{ path: string; name?: string }> = [],
): HubConfig {
  const projects: ProjectConfig[] = []
  const seenPaths = new Set<string>()
  const takenIds = new Set<string>()
  const add = (root: string, name: string | undefined, requireOpenSpec: boolean): void => {
    const canonical = canonicalRoot(root)
    const key = pathKey(canonical)
    if (seenPaths.has(key)) return
    if (requireOpenSpec && !existsSync(path.join(canonical, 'openspec'))) return
    seenPaths.add(key)
    projects.push({
      id: projectIdFor(canonical, takenIds),
      name: name && name.trim() ? name.trim() : path.basename(canonical),
      path: canonical,
    })
  }
  for (const workspace of workspaces) add(workspace.root, workspace.name, true)
  for (const raw of extraRoots.split(';')) {
    const trimmed = raw.trim()
    if (trimmed) add(trimmed, undefined, false)
  }
  for (const root of registered) add(root.path, root.name, false)
  return { projects }
}

/** RouterChatPort over ND Router's internal playground lane (no external key). */
export class NdRouterChatPort implements RouterChatPort {
  constructor(private readonly router: OpenSpecRouterPort) {}

  async models(): Promise<string[]> {
    const state = await this.router.state()
    const combos = state.combos.map((combo) => combo.id)
    // Mirror the router's own auth semantics: free-API, CLI and web lanes carry
    // no ND-stored secret; only api-key lanes require one. TTS voices are not chat models.
    const models = state.providers
      .filter((provider) => provider.isActive && !isRouterTtsProviderKind(provider.kind))
      .filter((provider) => providerAuthMode(provider.kind) !== 'api-key' || provider.hasSecret)
      .flatMap((provider) => provider.models.map((model) => `${provider.id}/${model}`))
    return [...combos, ...models]
  }

  async chat(options: {
    messages: RouterChatMessage[]
    model: string
    signal?: AbortSignal
    onDelta?: (text: string) => void
  }): Promise<{ text: string }> {
    if (options.signal?.aborted) throw new HttpError(499, 'cancelled', 'request cancelled')
    const state = await this.router.state()
    const route = state.combos.some((combo) => combo.id === options.model)
      ? { kind: 'combo' as const, combo: options.model }
      : options.model.includes('/')
        ? { kind: 'model' as const, providerId: options.model.split('/')[0]!, model: options.model.slice(options.model.indexOf('/') + 1) }
        : { kind: 'combo' as const, combo: options.model }
    const requestId = randomUUID()
    return new Promise<{ text: string }>((resolve, reject) => {
      let text = ''
      let settled = false
      const timer = setTimeout(() => {
        this.router.playgroundStop(requestId)
        finish(() => reject(new HttpError(504, 'router-timeout', 'ND Router did not finish within 5 minutes')))
      }, PLAYGROUND_TIMEOUT_MS)
      const onAbort = (): void => {
        this.router.playgroundStop(requestId)
        finish(() => reject(new HttpError(499, 'cancelled', 'request cancelled')))
      }
      const finish = (settle: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        settle()
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      // The signal may have aborted while state() was still resolving.
      if (options.signal?.aborted) {
        onAbort()
        return
      }
      const input: RouterPlaygroundInput = { requestId, route, messages: options.messages, stream: true }
      this.router.playgroundStart(input, (event) => {
        if (event.requestId !== requestId) return
        if (event.type === 'delta' && event.delta) {
          text += event.delta
          options.onDelta?.(event.delta)
        } else if (event.type === 'done') {
          finish(() => resolve({ text: event.text ?? text }))
        } else if (event.type === 'error') {
          finish(() => reject(new HttpError(502, 'router-error', event.error ?? 'ND Router request failed')))
        }
      })
    })
  }
}

interface EngineBundle {
  signature: string
  config: HubConfig
  cache: SnapshotCache
  tickets: TicketStore
  engine: AssistantEngine
}

/**
 * Lazy engine owner for the openspec.* host handlers. The bundle is rebuilt
 * only when the project set, write toggle, or installed package version
 * changes; scans stay cached in between (the web view polls the portfolio).
 */
export class OpenSpecHubService {
  private bundle?: EngineBundle
  readonly roots: RootsStore
  readonly active: ActiveProjectStore

  constructor(private readonly deps: OpenSpecHubDeps) {
    this.roots = new RootsStore(deps.dataDir)
    this.active = new ActiveProjectStore(deps.dataDir)
  }

  async routerConfigured(): Promise<boolean> {
    if (!this.deps.router) return false
    try {
      return Boolean((await this.deps.router.state()).endpoint)
    } catch {
      return false
    }
  }

  async bundleFor(settings: Record<string, unknown>): Promise<EngineBundle> {
    const enableWrites = settings.enableWrites === true
    const extraRoots = typeof settings.extraRoots === 'string' ? settings.extraRoots : ''
    const record = await this.deps.packages.record(OPENSPEC_HUB_ID)
    if (!record) throw new HttpError(503, 'extension-not-installed', 'Install the OpenSpec Hub package from Discover first')
    const packageDir = this.deps.packages.snapshotDir(OPENSPEC_HUB_ID, record.manifest.version)
    const bin = path.join(packageDir, VENDORED_BIN)
    if (!existsSync(bin)) {
      throw new HttpError(503, 'cli-missing', 'The vendored OpenSpec CLI is missing from the installed package; reinstall OpenSpec Hub')
    }
    const view = await this.deps.workspaces.list()
    const config = buildHubConfig(view.items, extraRoots, this.roots.list())
    const signature = JSON.stringify([config.projects.map((p) => [p.id, p.name, p.path]), enableWrites, packageDir])
    if (this.bundle && this.bundle.signature === signature) return this.bundle
    const cache = new SnapshotCache(config, new OpenSpecCli(bin))
    const tickets = new TicketStore(this.deps.dataDir)
    const writes = enableWrites ? new WriteService({ config, cache, tickets, dataDir: this.deps.dataDir }) : undefined
    const engine = new AssistantEngine({
      config,
      cache,
      tickets,
      ...(writes ? { writes } : {}),
      writesEnabled: enableWrites,
      activeProject: this.active,
      ...(this.deps.router ? { router: new NdRouterChatPort(this.deps.router) } : {}),
    })
    this.bundle = { signature, config, cache, tickets, engine }
    return this.bundle
  }
}