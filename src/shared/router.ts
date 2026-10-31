import type { NineRouterDesktopApi } from './nine-router.js'

export type RouterProviderKind =
  | 'openai-compatible'
  | 'antigravity'
  | 'gemini-cli'
  | 'qoder'
  | 'chatgpt-web'
  | 'gemini-web'
  | 'deepseek-web'
export type RouterWebProviderKind = 'chatgpt-web' | 'gemini-web' | 'deepseek-web'
export type RouterComboStrategy = 'priority' | 'round-robin'

/** Seed models for web lanes; Gemini's live picker can replace these later. */
export const ROUTER_WEB_LANE_MODELS: Record<RouterWebProviderKind, string[]> = {
  'chatgpt-web': ['default'],
  'gemini-web': ['3.5 Flash-Lite', '3.8 Flash', '3.1 Pro', '4 Argon'],
  'deepseek-web': ['default', 'deep-think'],
}

export function isRouterWebProviderKind(kind: string): kind is RouterWebProviderKind {
  return kind === 'chatgpt-web' || kind === 'gemini-web' || kind === 'deepseek-web'
}

export const ROUTER_HEADERS = {
  combo: 'x-nd-route-combo',
  requestId: 'x-nd-request-id',
  resolvedCombo: 'x-nd-router-combo',
  resolvedProvider: 'x-nd-router-provider',
  resolvedModel: 'x-nd-router-model',
  latencyMs: 'x-nd-router-latency-ms',
} as const

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
  /** Web-lane combos default to private: they stay callable but leave the personal picker. */
  hiddenFromChat: boolean
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
  /** Experimental network lockdown; absent only from older sidecar builds. */
  safeMode?: boolean
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
  hiddenFromChat?: boolean
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

export interface RouterGoogleConnectResult {
  state: RouterState
  email: string
  accountId: string
}

export interface RouterGoogleExistingAccount {
  /** Email of the Antigravity account ND already signed in through Token Saver. */
  email?: string
}

export interface RouterExternalApiState {
  endpoint?: string
  hasKey: boolean
  /** False when OS-backed secure storage is unavailable and the key is per-launch. */
  persisted: boolean
  /** True while Safe Mode rejects this credential for external apps. */
  safeMode: boolean
}

export interface RouterExternalKey extends RouterExternalApiState {
  endpoint: string
  key: string
}

export type RouterPlaygroundRoute =
  | { kind: 'combo'; combo: string }
  | { kind: 'model'; providerId: string; model: string }

export interface RouterPlaygroundMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface RouterPlaygroundInput {
  requestId: string
  route: RouterPlaygroundRoute
  messages: RouterPlaygroundMessage[]
  stream?: boolean
}

export interface RouterPlaygroundEvent {
  requestId: string
  type: 'phase' | 'delta' | 'done' | 'error'
  phase?: 'connecting' | 'waiting' | 'streaming'
  delta?: string
  text?: string
  status?: number
  combo?: string
  provider?: string
  model?: string
  latencyMs?: number
  error?: string
  code?: string
}

export const ROUTER_IPC = {
  state: 'router:state',
  saveProvider: 'router:save-provider',
  deleteProvider: 'router:delete-provider',
  saveAccount: 'router:save-account',
  deleteAccount: 'router:delete-account',
  googleConnect: 'router:google-connect',
  googleExisting: 'router:google-existing',
  saveCombo: 'router:save-combo',
  deleteCombo: 'router:delete-combo',
  testProvider: 'router:test-provider',
  usage: 'router:usage',
  resetUsage: 'router:reset-usage',
  externalKeyState: 'router:external-key-state',
  revealExternalKey: 'router:reveal-external-key',
  rotateExternalKey: 'router:rotate-external-key',
  setSafeMode: 'router:set-safe-mode',
  playgroundStart: 'router:playground-start',
  playgroundStop: 'router:playground-stop',
  playgroundEvent: 'router:playground-event',
} as const

export interface RouterDesktopApi extends NineRouterDesktopApi {
  state(): Promise<RouterState>
  saveProvider(input: RouterProviderInput): Promise<RouterState>
  deleteProvider(providerId: string): Promise<RouterState>
  saveAccount(input: RouterAccountInput): Promise<RouterState>
  deleteAccount(providerId: string, accountId: string): Promise<RouterState>
  googleConnect(providerId: string, mode?: 'browser' | 'existing'): Promise<RouterGoogleConnectResult>
  googleExistingAccount(): Promise<RouterGoogleExistingAccount>
  saveCombo(input: RouterComboInput): Promise<RouterState>
  deleteCombo(comboId: string): Promise<RouterState>
  testProvider(providerId: string): Promise<RouterTestResult>
  usage(): Promise<RouterUsageSummary>
  resetUsage(): Promise<RouterUsageSummary>
  externalKeyState(): Promise<RouterExternalApiState>
  revealExternalKey(): Promise<RouterExternalKey>
  rotateExternalKey(): Promise<RouterExternalKey>
  setSafeMode(enabled: boolean): Promise<RouterState>
  playgroundStart(input: RouterPlaygroundInput): Promise<void>
  playgroundStop(requestId: string): Promise<void>
  onPlaygroundEvent(listener: (event: RouterPlaygroundEvent) => void): () => void
}

export const MANAGED_ROUTER_PROVIDER_ID = 'nd-router'
