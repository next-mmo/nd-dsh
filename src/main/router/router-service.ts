import type { ModelProvider } from '../../shared/contracts.js'
import {
  MANAGED_ROUTER_PROVIDER_ID,
  type RouterAccountInput,
  type RouterComboInput,
  type RouterProviderInput,
  type RouterState,
  type RouterTestResult,
  type RouterUsageSummary,
} from '../../shared/router.js'
import type { CoreClient } from '../core/core-client.js'
import type { ProviderStore } from '../providers.js'

interface InitializeResult {
  endpoint: string
  key: string
  port: number
  state: RouterState
}

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

  constructor(
    private readonly core: CoreClient,
    private readonly providers: ProviderStore,
    private readonly dataDir: string,
    private readonly log: (message: string) => void = (message) => console.warn(message),
  ) {}

  async initialize(): Promise<void> {
    try {
      const result = await this.core.request<InitializeResult>('router.initialize', { dataDir: this.dataDir })
      this.endpoint = result.endpoint
      this.key = result.key
      this.syncManagedProvider(result.state)
    } catch (error) {
      this.log(`ND Router is unavailable: ${message(error)}`)
    }
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
    return this.core.request<RouterTestResult>('router.testProvider', { providerId }, 150_000)
  }

  usage(): Promise<RouterUsageSummary> {
    return this.core.request<RouterUsageSummary>('router.usage', {})
  }

  async resetUsage(): Promise<RouterUsageSummary> {
    await this.core.request('router.resetUsage', {})
    return this.usage()
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
    const desiredModels = state.combos.map((combo) => ({ id: combo.name, context: '' }))
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
  return error instanceof Error ? error.message : String(error)
}
