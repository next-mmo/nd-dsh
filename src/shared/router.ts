import type { NineRouterDesktopApi } from './nine-router.js'

export type RouterProviderKind = 'openai-compatible' | 'antigravity' | 'gemini-cli' | 'qoder'
export type RouterComboStrategy = 'priority' | 'round-robin'

export interface RouterAccountView {
  id: string
  label: string
  kind: 'api-key' | 'cli'
  isActive: boolean
  priority: number
  hasSecret: boolean
  /** CLI lane account name inside the external CLI (agy `AGY_ACCOUNT`). */
  selector?: string
  /** CLI lane config directory (qoder `QODER_CONFIG_DIR`). */
  envDir?: string
  cooldownUntilMs?: number
  lastStatus?: string
}

export interface RouterProviderView {
  id: string
  kind: RouterProviderKind
  name: string
  baseUrl: string
  models: string[]
  isActive: boolean
  priority: number
  hasSecret: boolean
  accounts: RouterAccountView[]
}

export interface RouterComboEntry {
  providerId: string
  model: string
  weight?: number
  accountId?: string
}

export interface RouterComboView {
  id: string
  name: string
  strategy: RouterComboStrategy
  models: RouterComboEntry[]
}

export interface RouterCounters {
  requests: number
  ok: number
  failed: number
  lastError?: string | null
}

export interface RouterState {
  /** Loopback endpoint of the Rust router; internal to ND. */
  endpoint?: string
  providers: RouterProviderView[]
  combos: RouterComboView[]
  counters: RouterCounters
}

export interface RouterUsageSummary {
  requests: number
  ok: number
  failed: number
  avgLatencyMs: number
  byProvider: Record<string, number>
  session: RouterCounters
}

export interface RouterProviderInput {
  id?: string
  kind?: RouterProviderKind
  name?: string
  baseUrl?: string
  models?: string[]
  isActive?: boolean
  priority?: number
  apiKey?: string
  clearSecret?: boolean
}

export interface RouterAccountInput {
  providerId: string
  id?: string
  label: string
  kind?: 'api-key' | 'cli'
  apiKey?: string
  envDir?: string
  selector?: string
  isActive?: boolean
  priority?: number
  clearSecret?: boolean
}

export interface RouterComboInput {
  id?: string
  name: string
  strategy?: RouterComboStrategy
  models: RouterComboEntry[]
}

export interface RouterTestResult {
  id: string
  ok: boolean
  statusCode: number
  latencyMs: number
  model: string
  error?: string | null
  preview?: string
}

export const ROUTER_IPC = {
  state: 'router:state',
  saveProvider: 'router:save-provider',
  deleteProvider: 'router:delete-provider',
  saveAccount: 'router:save-account',
  deleteAccount: 'router:delete-account',
  saveCombo: 'router:save-combo',
  deleteCombo: 'router:delete-combo',
  testProvider: 'router:test-provider',
  usage: 'router:usage',
  resetUsage: 'router:reset-usage',
} as const

export interface RouterDesktopApi extends NineRouterDesktopApi {
  state(): Promise<RouterState>
  saveProvider(input: RouterProviderInput): Promise<RouterState>
  deleteProvider(providerId: string): Promise<RouterState>
  saveAccount(input: RouterAccountInput): Promise<RouterState>
  deleteAccount(providerId: string, accountId: string): Promise<RouterState>
  saveCombo(input: RouterComboInput): Promise<RouterState>
  deleteCombo(comboId: string): Promise<RouterState>
  testProvider(providerId: string): Promise<RouterTestResult>
  usage(): Promise<RouterUsageSummary>
  resetUsage(): Promise<RouterUsageSummary>
}

export const MANAGED_ROUTER_PROVIDER_ID = 'nd-router'
