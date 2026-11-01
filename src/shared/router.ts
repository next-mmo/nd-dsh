import type { NineRouterDesktopApi } from './nine-router.js'

export type RouterProviderCategory = 'api' | 'cli' | 'web'
export type RouterAuthMode = 'none' | 'api-key' | 'cli' | 'browser'

export type RouterCliProviderKind =
  | 'antigravity'
  | 'gemini-cli'
  | 'qoder'
  | 'codex-cli'
  | 'claude-code-cli'
  | 'pi-coding'
  | 'zcode-cli'
  | 'cursor-cli'
  | 'opencode-cli'
  | 'goose-cli'
  | 'hermes-cli'
  | 'jcode-cli'
  | 'minimax-cli'

export type RouterProviderKind =
  | 'openai-compatible'
  | 'ai-studio'
  | 'pollinations'
  | 'ovh-kepler'
  | 'free-ai'
  | 'kilo-gateway'
  | RouterCliProviderKind
  | 'chatgpt-web'
  | 'gemini-web'
  | 'aistudio-web'
  | 'deepseek-web'
  | 'grok-web'
  | 'qwen-web'
  | 'zai-web'
  | 'mistral-web'
  | 'perplexity-web'
  | 'poe-web'
  | 'arena-web'
  | 'meta-web'
  | 'duck-web'

export type RouterWebProviderKind =
  | 'chatgpt-web'
  | 'gemini-web'
  | 'aistudio-web'
  | 'deepseek-web'
  | 'grok-web'
  | 'qwen-web'
  | 'zai-web'
  | 'mistral-web'
  | 'perplexity-web'
  | 'poe-web'
  | 'arena-web'
  | 'meta-web'
  | 'duck-web'

export type RouterComboStrategy = 'priority' | 'round-robin'

/** Seed models for web lanes; Gemini's live picker can replace these later. */
export const ROUTER_WEB_LANE_MODELS: Record<RouterWebProviderKind, string[]> = {
  'chatgpt-web': ['default'],
  'gemini-web': ['3.5 Flash-Lite', '3.8 Flash', '3.1 Pro', '4 Argon'],
  'aistudio-web': ['default', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  'deepseek-web': ['default', 'deep-think'],
  'grok-web': ['default', 'grok-3', 'grok-2', 'deepsearch', 'think'],
  'qwen-web': ['default', 'qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-coder'],
  'zai-web': ['default', 'glm-4-plus', 'glm-4-air', 'glm-4-flash'],
  'mistral-web': ['default', 'mistral-large', 'mistral-small', 'codestral'],
  'perplexity-web': ['default', 'sonar', 'sonar-pro', 'sonar-reasoning'],
  'poe-web': ['default', 'assistant', 'web-search'],
  'arena-web': ['default', 'battle', 'side-by-side', 'direct-chat'],
  'meta-web': ['default', 'llama-3.3', 'imagine'],
  'duck-web': ['default', 'gpt-4o-mini', 'claude-3-haiku', 'llama-3.3-70b'],
}

export function isRouterWebProviderKind(kind: string): kind is RouterWebProviderKind {
  return (
    kind === 'chatgpt-web' ||
    kind === 'gemini-web' ||
    kind === 'aistudio-web' ||
    kind === 'deepseek-web' ||
    kind === 'grok-web' ||
    kind === 'qwen-web' ||
    kind === 'zai-web' ||
    kind === 'mistral-web' ||
    kind === 'perplexity-web' ||
    kind === 'poe-web' ||
    kind === 'arena-web' ||
    kind === 'meta-web' ||
    kind === 'duck-web'
  )
}

export const ROUTER_CLI_LANE_MODELS: Record<RouterCliProviderKind, string[]> = {
  'codex-cli': ['default', 'o3-mini', 'o1', 'gpt-4.5'],
  'claude-code-cli': ['default', 'claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-5-haiku'],
  'pi-coding': ['default'],
  'zcode-cli': ['default', 'deepseek-r1', 'deepseek-v3', 'qwen-2.5-coder'],
  'cursor-cli': ['default', 'claude-3-7-sonnet', 'claude-3-5-sonnet', 'gpt-4o'],
  'opencode-cli': ['default', 'deepseek/deepseek-chat', 'anthropic/claude-3-7-sonnet'],
  'goose-cli': ['default'],
  'hermes-cli': ['default'],
  'jcode-cli': ['default'],
  'minimax-cli': ['default', 'MiniMax-Text-01'],
  antigravity: ['default', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  qoder: ['default', 'qoder-1', 'deepseek-r1'],
  'gemini-cli': ['default', 'gemini-2.5-flash', 'gemini-2.5-pro'],
}

export function isRouterCliProviderKind(kind: string): kind is RouterCliProviderKind {
  return (
    kind === 'antigravity' ||
    kind === 'gemini-cli' ||
    kind === 'qoder' ||
    kind === 'codex-cli' ||
    kind === 'claude-code-cli' ||
    kind === 'pi-coding' ||
    kind === 'zcode-cli' ||
    kind === 'cursor-cli' ||
    kind === 'opencode-cli' ||
    kind === 'goose-cli' ||
    kind === 'hermes-cli' ||
    kind === 'jcode-cli' ||
    kind === 'minimax-cli'
  )
}

export const ROUTER_FREE_API_MODELS: Record<string, string[]> = {
  pollinations: ['openai-fast'],
  'ovh-kepler': [
    'gpt-oss-120b',
    'Qwen3.6-27B',
    'Qwen2.5-VL-72B-Instruct',
    'Mistral-Small-3.2-24B-Instruct-2506',
    'Meta-Llama-3_3-70B-Instruct',
  ],
  'free-ai': ['qwen3-coder', 'qwen25-vl', 'deepseek-r1-7b', 'deepseek-r1', 'mistral'],
  'kilo-gateway': [
    'openrouter/free',
    'cohere/north-mini-code:free',
    'kilo-auto/small',
    'nvidia/nemotron-3.5-lightning:free',
  ],
}

export const ROUTER_FREE_API_BASE_URLS: Record<string, string> = {
  pollinations: 'https://text.pollinations.ai/v1',
  'ovh-kepler': 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
  'free-ai': 'https://api.free.ai/v1',
  'kilo-gateway': 'https://api.kilo.ai/api/gateway/v1',
}

export const ROUTER_AI_STUDIO_MODELS: string[] = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-pro',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
]

export const ROUTER_AI_STUDIO_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/'

export function isRouterFreeApiKind(kind: string): boolean {
  return kind === 'pollinations' || kind === 'ovh-kepler' || kind === 'free-ai' || kind === 'kilo-gateway'
}

export function providerCategory(kind: string): RouterProviderCategory {
  if (isRouterWebProviderKind(kind)) return 'web'
  if (isRouterCliProviderKind(kind)) return 'cli'
  return 'api'
}

export function providerAuthMode(kind: string): RouterAuthMode {
  if (isRouterFreeApiKind(kind)) return 'none'
  if (isRouterWebProviderKind(kind)) return 'browser'
  if (isRouterCliProviderKind(kind)) return 'cli'
  return 'api-key'
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
  testCandidate: 'router:test-candidate',
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
  testCandidate(input: RouterProviderInput): Promise<RouterTestResult>
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
