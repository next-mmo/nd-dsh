import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelProvider } from '../../shared/contracts.js'
import {
  MANAGED_ROUTER_PROVIDER_ID,
  ROUTER_HEADERS,
  type RouterAccountInput,
  type RouterComboInput,
  type RouterExternalApiState,
  type RouterExternalKey,
  type RouterPlaygroundEvent,
  type RouterPlaygroundInput,
  type RouterProviderInput,
  type RouterState,
  type RouterTestResult,
  type RouterUsageSummary,
} from '../../shared/router.js'
import type { CoreClient } from '../core/core-client.js'
import type { ProviderStore } from '../providers.js'
import { RouterExternalKeyStore } from './external-key-store.js'
import type { WebLaneBridgeDescriptor } from './web-lane-bridge.js'

interface InitializeResult {
  endpoint: string
  key: string
  port: number
  state: RouterState
}

type WebLaneCanceller = { cancel(requestId: string): void }

const DEFAULT_PREFERRED_PORT = 3130

/**
 * Main-process client for the Rust ND Router.
 *
 * The router owns providers, accounts and combos in the sidecar. ND's own
 * model selection reaches it through one managed provider entry, so every
 * engine and ND Gateway inherit the same routes without duplicating routing
 * logic in Node.
 */
export class RouterService {
  private endpoint: string | undefined
  private key: string | undefined
  private appliedKey: string | undefined
  private readonly externalKeys: RouterExternalKeyStore
  private webLaneBridge: WebLaneCanceller | undefined
  private readonly playground = new Map<string, AbortController>()

  constructor(
    private readonly core: CoreClient,
    private readonly providers: ProviderStore,
    private readonly dataDir: string,
    private readonly log: (message: string) => void = (message) => console.warn(message),
  ) {
    this.externalKeys = new RouterExternalKeyStore(join(dataDir, 'external-key.json'), undefined, log)
  }

  async initialize(webLaneBridge?: WebLaneBridgeDescriptor): Promise<void> {
    this.webLaneBridge = undefined
    const external = this.externalKeys.loadOrCreate()
    try {
      const result = await this.core.request<InitializeResult>('router.initialize', {
        dataDir: this.dataDir,
        externalKey: external.key,
        preferredPort: preferredPort(),
        ...(webLaneBridge ? { webBridge: webLaneBridge } : {}),
      }, 30_000)
      this.endpoint = result.endpoint
      this.key = result.key
      this.persistServerInfo(result.port)
      this.syncManagedProvider(result.state)
    } catch (error) {
      // Web lanes are unavailable without the bridge, but API lanes still work.
      this.log(`ND Router is unavailable: ${message(error)}`)
    }
  }

  /** Playground/UI cancellation needs the same bridge that owns the browser turn. */
  setWebLaneBridge(bridge: WebLaneCanceller | undefined): void {
    this.webLaneBridge = bridge
  }

  async state(): Promise<RouterState> {
    const state = await this.core.request<RouterState>('router.state', {})
    return this.withEndpoint(state)
  }

  async saveProvider(input: RouterProviderInput): Promise<RouterState> {
    await this.core.request('router.saveProvider', input)
    return this.refreshedState()
  }

  async deleteProvider(providerId: string): Promise<RouterState> {
    await this.core.request('router.deleteProvider', { providerId })
    return this.refreshedState()
  }

  async saveAccount(input: RouterAccountInput): Promise<RouterState> {
    await this.core.request('router.saveAccount', input)
    return this.refreshedState()
  }

  async deleteAccount(providerId: string, accountId: string): Promise<RouterState> {
    await this.core.request('router.deleteAccount', { providerId, accountId })
    return this.refreshedState()
  }

  async saveCombo(input: RouterComboInput): Promise<RouterState> {
    await this.core.request('router.saveCombo', input)
    return this.refreshedState()
  }

  async deleteCombo(comboId: string): Promise<RouterState> {
    await this.core.request('router.deleteCombo', { comboId })
    return this.refreshedState()
  }

  testProvider(providerId: string): Promise<RouterTestResult> {
    // Web lanes can wait on a full browser turn; API lanes keep the short ping.
    return this.state()
      .then((state) => {
        const provider = state.providers.find((candidate) => candidate.id === providerId)
        const timeout = provider?.kind === 'chatgpt-web' || provider?.kind === 'gemini-web' ? 310_000 : 150_000
        return this.core.request<RouterTestResult>('router.testProvider', { providerId }, timeout)
      })
      .catch(() => this.core.request<RouterTestResult>('router.testProvider', { providerId }, 150_000))
  }

  usage(): Promise<RouterUsageSummary> {
    return this.core.request<RouterUsageSummary>('router.usage', {})
  }

  async resetUsage(): Promise<RouterUsageSummary> {
    await this.core.request('router.resetUsage', {})
    return this.usage()
  }

  externalKeyState(): RouterExternalApiState {
    const value = this.externalKeys.loadOrCreate()
    return {
      ...(this.endpoint ? { endpoint: this.endpoint } : {}),
      hasKey: true,
      persisted: value.persisted,
    }
  }

  revealExternalKey(): RouterExternalKey {
    const value = this.externalKeys.loadOrCreate()
    return {
      endpoint: this.endpoint ?? '',
      key: value.key,
      hasKey: true,
      persisted: value.persisted,
    }
  }

  async rotateExternalKey(): Promise<RouterExternalKey> {
    if (!this.endpoint) throw new Error('ND Router is not initialized')
    const next = this.externalKeys.rotate()
    await this.core.request('router.setExternalKey', { externalKey: next.key }, 10_000)
    return { endpoint: this.endpoint, key: next.key, hasKey: true, persisted: next.persisted }
  }

  /** Kick off one playground turn; progress arrives through the event callback. */
  playgroundStart(input: RouterPlaygroundInput, onEvent: (event: RouterPlaygroundEvent) => void): void {
    void this.runPlayground(input, onEvent)
  }

  playgroundStop(requestId: string): void {
    this.webLaneBridge?.cancel(requestId)
    this.playground.get(requestId)?.abort()
    this.playground.delete(requestId)
  }

  private async runPlayground(input: RouterPlaygroundInput, onEvent: (event: RouterPlaygroundEvent) => void): Promise<void> {
    const requestId = input.requestId
    const fail = (error: string, code: string): void => {
      onEvent({ requestId, type: 'error', error, code })
    }
    if (!this.endpoint || !this.key) {
      fail('ND Router is not initialized', 'router_unavailable')
      return
    }
    if (typeof requestId !== 'string' || !requestId.trim()) {
      fail('Playground request id is missing', 'invalid_request')
      return
    }
    if (!Array.isArray(input.messages) || input.messages.length === 0) {
      fail('Add a message before sending', 'invalid_request')
      return
    }
    const combo = input.route.kind === 'combo' ? input.route.combo.trim() : undefined
    const model = input.route.kind === 'combo'
      ? input.route.combo.trim()
      : `${input.route.providerId}/${input.route.model}`
    if (!model) {
      fail('Choose a route before sending', 'invalid_request')
      return
    }

    const controller = new AbortController()
    this.playground.set(requestId, controller)
    const started = Date.now()
    const stream = input.stream !== false
    onEvent({ requestId, type: 'phase', phase: 'connecting' })
    try {
      const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.key}`,
          [ROUTER_HEADERS.requestId]: requestId,
          ...(combo ? { [ROUTER_HEADERS.combo]: combo } : {}),
        },
        body: JSON.stringify({ model, messages: input.messages, stream }),
        signal: controller.signal,
      })
      const resolved = this.resolvedRoute(response)
      if (!response.ok) {
        const raw = await response.text().catch(() => '')
        fail(routerErrorText(raw) ?? `Router returned HTTP ${response.status}`, 'router_error')
        return
      }
      onEvent({ requestId, type: 'phase', phase: 'waiting' })
      const contentType = response.headers.get('content-type') ?? ''
      if (stream && contentType.includes('text/event-stream') && response.body) {
        onEvent({ requestId, type: 'phase', phase: 'streaming' })
        let text = ''
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const event = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            for (const line of event.split('\n')) {
              if (!line.startsWith('data:')) continue
              const data = line.slice(5).trim()
              if (!data || data === '[DONE]') continue
              const delta = sseDelta(data)
              if (delta) {
                text += delta
                onEvent({ requestId, type: 'delta', delta })
              }
            }
            boundary = buffer.indexOf('\n\n')
          }
        }
        onEvent({ requestId, type: 'done', text, status: response.status, ...resolved, latencyMs: resolved.latencyMs ?? Date.now() - started })
        return
      }
      const payload = await response.json().catch(() => undefined) as {
        choices?: Array<{ message?: { content?: unknown } }>
      } | undefined
      const content = payload?.choices?.[0]?.message?.content
      const text = typeof content === 'string' ? content : ''
      if (text) onEvent({ requestId, type: 'delta', delta: text })
      onEvent({ requestId, type: 'done', text, status: response.status, ...resolved, latencyMs: resolved.latencyMs ?? Date.now() - started })
    } catch (error) {
      if (controller.signal.aborted) return
      fail(message(error), 'playground_failed')
    } finally {
      this.playground.delete(requestId)
    }
  }

  private resolvedRoute(response: Response): Pick<RouterPlaygroundEvent, 'combo' | 'provider' | 'model' | 'latencyMs'> {
    const combo = response.headers.get(ROUTER_HEADERS.resolvedCombo)
    const provider = response.headers.get(ROUTER_HEADERS.resolvedProvider)
    const model = response.headers.get(ROUTER_HEADERS.resolvedModel)
    const latency = Number.parseInt(response.headers.get(ROUTER_HEADERS.latencyMs) ?? '', 10)
    return {
      ...(combo ? { combo } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(Number.isFinite(latency) ? { latencyMs: latency } : {}),
    }
  }

  private persistServerInfo(port: number): void {
    try {
      writeFileSync(
        join(this.dataDir, 'server.json'),
        `${JSON.stringify({ version: 1, endpoint: this.endpoint, port, pid: process.pid, startedAt: Date.now() }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
    } catch (error) {
      this.log(`ND Router could not write its discovery file: ${message(error)}`)
    }
  }

  private async refreshedState(): Promise<RouterState> {
    const state = await this.state()
    this.syncManagedProvider(state)
    return state
  }

  private withEndpoint(state: RouterState): RouterState {
    return this.endpoint ? { ...state, endpoint: this.endpoint } : state
  }

  /**
   * Publish the router as one managed provider. Each combo becomes a model id,
   * so the picker (and ND Gateway) select routes without knowing the panel.
   * Saves only when the shape actually changed: every save bumps the provider
   * revision, which restarts the Harness before the next turn.
   */
  private syncManagedProvider(state: RouterState): void {
    if (!this.endpoint || !this.key) return
    // Private web-lane combos stay resolvable through /v1 but never reach the
    // personal-chat picker.
    const visibleCombos = state.combos.filter((combo) => combo.hiddenFromChat !== true)
    const desiredModels = visibleCombos.map((combo) => ({ id: combo.name, context: '' }))
    const managed: ModelProvider = {
      id: MANAGED_ROUTER_PROVIDER_ID,
      name: 'ND Router',
      enabled: desiredModels.length > 0,
      baseUrl: `${this.endpoint}/v1`,
      apiFormat: 'openai-completions',
      apiKey: '',
      models: desiredModels,
      maxRetries: 1,
    }
    const existing = this.providers.list()
    const current = existing.find((provider) => provider.id === MANAGED_ROUTER_PROVIDER_ID)
    const shapeChanged = !current
      || current.name !== managed.name
      || current.enabled !== managed.enabled
      || current.baseUrl !== managed.baseUrl
      || current.apiFormat !== managed.apiFormat
      || current.models.map((model) => model.id).join('\n') !== desiredModels.map((model) => model.id).join('\n')
    if (shapeChanged) {
      this.providers.save([...existing.filter((provider) => provider.id !== MANAGED_ROUTER_PROVIDER_ID), managed])
    }
    if (this.appliedKey !== this.key || !this.providers.list().find((provider) => provider.id === MANAGED_ROUTER_PROVIDER_ID)?.hasApiKey) {
      this.providers.setApiKey(MANAGED_ROUTER_PROVIDER_ID, this.key)
      this.appliedKey = this.key
    }
  }
}

function message(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message && cause.message !== error.message) {
      return `${error.message}: ${cause.message}`
    }
    return error.message
  }
  return String(error)
}

function preferredPort(): number {
  const parsed = Number.parseInt(process.env.ND_ROUTER_PORT ?? '', 10)
  if (Number.isInteger(parsed) && parsed >= 1024 && parsed < 65_536) return parsed
  return DEFAULT_PREFERRED_PORT
}

function sseDelta(data: string): string | undefined {
  try {
    const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> }
    const content = parsed.choices?.[0]?.delta?.content
    return typeof content === 'string' && content ? content : undefined
  } catch {
    return undefined
  }
}

function routerErrorText(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } | string }
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error
    const text = parsed.error && typeof parsed.error === 'object' ? parsed.error.message : undefined
    if (typeof text === 'string' && text.trim()) return text
  } catch {
    // Plain-text upstream errors are returned as-is.
  }
  return raw.trim() || undefined
}
