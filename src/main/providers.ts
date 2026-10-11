import { randomUUID } from 'node:crypto'
import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ModelProvider, ProviderModel, ProviderPingResult } from '../shared/contracts.js'
import { buildProviderRuntime, DIRECT_DEEPSEEK_ROUTE, isDynamicSessionHeader, isOpenCodeEndpoint, protocolFromApiFormat, type ProviderRuntimeConfig } from './provider-runtime.js'
import { pingProvider, probeProviderCompletion } from './provider-ping.js'
import { sanitizeProviderModel } from '../shared/provider-models.js'

const PROVIDERS_FILE = 'providers.json'
const PROVIDER_SECRETS_FILE = 'provider-secrets.json'
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_API_FORMAT = 'Chat completions (/chat/completions)'
const DEFAULT_MODEL = 'deepseek-v4-flash'
const DEFAULT_CONTEXT = '1M'
const PING_CACHE_TTL_MS = 30_000

interface ProviderSecretsFile {
  version: 1
  keys: Record<string, string>
}

interface ProviderReadResult {
  providers: ModelProvider[]
  hadPlaintextSecrets: boolean
}

/** Credential-bearing turn configuration; pass only over the supervised agent pipe. */
export interface NativeAgentModelRoute {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  format: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'deepseek'
  headers: Record<string, string>
}

function defaultProvider(): ModelProvider {
  const model = process.env.ND_DSH_MODEL?.trim() || DEFAULT_MODEL
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    enabled: false,
    baseUrl: process.env.ND_DSH_BASE_URL?.trim() || DEFAULT_BASE_URL,
    apiFormat: DEFAULT_API_FORMAT,
    apiKey: process.env.DEEPSEEK_API_KEY?.trim() ?? '',
    models: [
      { id: model, context: DEFAULT_CONTEXT },
      ...(model !== 'deepseek-v4-pro' ? [{ id: 'deepseek-v4-pro', context: DEFAULT_CONTEXT }] : []),
    ],
  }
}

function sanitizeHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const trimmedKey = key.trim()
    if (trimmedKey && typeof val === 'string') {
      result[trimmedKey] = val.trim()
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function sanitizeProvider(value: unknown, includeLegacySecret = false): ModelProvider | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!id || !name) return undefined
  const models = Array.isArray(record.models)
    ? record.models
        .map((model) => sanitizeProviderModel(model, DEFAULT_CONTEXT))
        .filter((model): model is ProviderModel => model !== undefined)
    : []
  const headers = sanitizeHeaders(record.headers)
  const maxRetries = typeof record.maxRetries === 'number' && Number.isFinite(record.maxRetries)
    ? Math.max(0, Math.min(Math.round(record.maxRetries), 5))
    : undefined
  const enabled = typeof record.enabled === 'boolean'
    ? record.enabled
    : id === 'deepseek' ? false : record.enabled !== false
  return {
    id,
    name,
    enabled,
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : '',
    apiFormat: typeof record.apiFormat === 'string' ? record.apiFormat : DEFAULT_API_FORMAT,
    apiKey: includeLegacySecret && typeof record.apiKey === 'string' ? record.apiKey : '',
    models,
    ...(headers ? { headers } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  }
}

export function resolveProbeHeaders(headers: Record<string, string> | undefined, baseUrl: string | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (headers) {
    for (const [key, val] of Object.entries(headers)) {
      if (isDynamicSessionHeader(val)) {
        result[key] = randomUUID()
      } else if (val.trim()) {
        result[key] = val.trim()
      }
    }
  }
  if (isOpenCodeEndpoint(baseUrl) && !result['x-opencode-session']) {
    result['x-opencode-session'] = randomUUID()
  }
  return result
}

function cloneProviders(providers: ModelProvider[]): ModelProvider[] {
  return structuredClone(providers)
}

/**
 * Provider metadata lives in userData/providers.json, but API keys do not.
 * Keys are encrypted with Electron safeStorage into provider-secrets.json.
 * On Linux we deliberately refuse safeStorage's `basic_text` fallback: when
 * no real desktop keyring is available the key stays memory-only rather than
 * being written with a known plaintext encryption password.
 *
 * Existing credentials are write-only from the renderer's perspective:
 * `list()` always returns `apiKey: ''` plus `hasApiKey`; replacement and clear
 * use dedicated IPC methods. Full secret values remain in this trusted main
 * process and in the ephemeral child-process environment used by the runtime.
 */
export class ProviderStore {
  private readonly filePath: string
  private readonly secretsPath: string
  private providers: ModelProvider[]
  /**
   * Ciphertext that exists on disk but could not be decrypted in this session
   * (for example after an OS keyring reset or a profile move). It is carried
   * back into the next secrets write so a failed decrypt can never erase a
   * stored credential; only an explicit replace or clear drops it.
   */
  private readonly preservedSecrets: Record<string, string> = {}
  private revisionValue = 0
  private readonly pingCache = new Map<string, { at: number; result: ProviderPingResult }>()

  constructor() {
    if (!app.isReady()) throw new Error('ProviderStore must be created after the Electron app is ready')
    this.filePath = join(app.getPath('userData'), PROVIDERS_FILE)
    this.secretsPath = join(app.getPath('userData'), PROVIDER_SECRETS_FILE)
    const loaded = this.readProviders()
    this.providers = this.hydrateSecrets(loaded.providers)

    if (loaded.hadPlaintextSecrets) this.persist()
  }

  /** Renderer-safe metadata: never returns an existing credential value. */
  list(): ModelProvider[] {
    return this.providers.map(({ apiKey, hasApiKey: _ignored, ...provider }) => ({
      ...structuredClone(provider),
      apiKey: '',
      hasApiKey: Boolean(apiKey.trim()),
    }))
  }

  /** Save metadata/model routes while preserving credentials by provider id. */
  save(value: unknown): ModelProvider[] {
    const sanitized = Array.isArray(value)
      ? value.map((item) => sanitizeProvider(item)).filter((provider): provider is ModelProvider => provider !== undefined)
      : []
    const previousKeys = new Map(this.providers.map((provider) => [provider.id, provider.apiKey]))
    const next = sanitized.length > 0 ? sanitized : [defaultProvider()]
    this.providers = next.map((provider) => ({
      ...provider,
      apiKey: previousKeys.get(provider.id) ?? provider.apiKey,
    }))
    this.revisionValue += 1
    this.persist()
    return this.list()
  }

  setApiKey(providerId: string, value: string): ModelProvider[] {
    const id = providerId.trim()
    const apiKey = value.trim()
    if (!id) throw new Error('Provider id is required')
    if (!apiKey) throw new Error('API key cannot be empty; use clear credential instead')
    if (apiKey.length > 32_768) throw new Error('API key exceeds the supported length')
    const provider = this.providers.find((item) => item.id === id)
    if (!provider) throw new Error('Provider not found')
    provider.apiKey = apiKey
    delete this.preservedSecrets[id]
    this.revisionValue += 1
    this.persist()
    return this.list()
  }

  clearApiKey(providerId: string): ModelProvider[] {
    const id = providerId.trim()
    if (!id) throw new Error('Provider id is required')
    const provider = this.providers.find((item) => item.id === id)
    if (!provider) throw new Error('Provider not found')
    provider.apiKey = ''
    delete this.preservedSecrets[id]
    this.revisionValue += 1
    this.persist()
    return this.list()
  }

  revision(): number {
    return this.revisionValue
  }

  /**
   * Real reachability probe with the provider's stored credential. Accepts
   * either the ND provider id or the runtime route id it compiles to (the
   * `deepseek` provider routes as `deepseek-official` in sessions). Results
   * are cached briefly so opening the model picker does not spam provider
   * servers; `force` re-probes immediately (settings "Test connection").
   */
  async ping(providerId: string, force = false): Promise<ProviderPingResult> {
    const requested = providerId.trim()
    const id = requested === DIRECT_DEEPSEEK_ROUTE ? 'deepseek' : requested
    const provider = this.providers.find((item) => item.id === id)
    if (!provider) throw new Error('Provider not found')
    const cached = this.pingCache.get(id)
    if (!force && cached && Date.now() - cached.at < PING_CACHE_TTL_MS) return cached.result
    const pingHeaders = resolveProbeHeaders(provider.headers, provider.baseUrl)
    const outcome = await pingProvider({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      ...(Object.keys(pingHeaders).length > 0 ? { headers: pingHeaders } : {}),
    })
    const result: ProviderPingResult = {
      providerId: id,
      state: outcome.state,
      ...(outcome.latencyMs !== undefined ? { latencyMs: outcome.latencyMs } : {}),
      ...(outcome.status !== undefined ? { status: outcome.status } : {}),
      hasApiKey: Boolean(provider.apiKey.trim()),
      at: Date.now(),
    }
    this.pingCache.set(id, { at: result.at, result })
    return result
  }

  runtimeConfig(): ProviderRuntimeConfig {
    return buildProviderRuntime(this.providers)
  }

  /**
   * Real generation probe against the provider's first configured model. The
   * /models ping cannot see the completion path, so this is the honest
   * "will sessions work" check. Never cached: every press is a fresh probe.
   */
  async testCompletion(providerId: string): Promise<ProviderPingResult> {
    const requested = providerId.trim()
    const id = requested === DIRECT_DEEPSEEK_ROUTE ? 'deepseek' : requested
    const provider = this.providers.find((item) => item.id === id)
    if (!provider) throw new Error('Provider not found')
    const model = provider.models.find((item) => item.id.trim())?.id.trim()
    if (!model) throw new Error(`Provider ${provider.name || id} has no configured model to test`)
    const probeHeaders = resolveProbeHeaders(provider.headers, provider.baseUrl)
    const outcome = await probeProviderCompletion({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model,
      ...(Object.keys(probeHeaders).length > 0 ? { headers: probeHeaders } : {}),
    })
    return {
      providerId: id,
      state: outcome.state,
      ...(outcome.latencyMs !== undefined ? { latencyMs: outcome.latencyMs } : {}),
      ...(outcome.status !== undefined ? { status: outcome.status } : {}),
      hasApiKey: Boolean(provider.apiKey.trim()),
      at: Date.now(),
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    }
  }

  /** Trusted main-process summary used by runtime status computation. */
  enabled(): ModelProvider | undefined {
    return cloneProviders(this.providers).find((provider) => provider.enabled)
  }

  /** Trusted main-process list of all enabled providers with decrypted credentials. */
  allEnabled(): ModelProvider[] {
    return cloneProviders(this.providers).filter((provider) => provider.enabled)
  }

  nativeAgentRoute(providerId?: string, modelId?: string): NativeAgentModelRoute {
    const selected = providerId?.trim()
    const provider = this.providers.find((item) => item.enabled && (item.id === selected || (selected === DIRECT_DEEPSEEK_ROUTE && item.id === 'deepseek')))
      ?? (!selected ? this.providers.find((item) => item.enabled) : undefined)
    if (!provider) throw new Error(selected ? `ND provider ${selected} is not enabled` : 'Enable a model provider in ND Settings before running ND Agent')
    const model = modelId?.trim() || provider.models.find((item) => item.id.trim())?.id.trim()
    if (!model) throw new Error(`ND provider ${provider.name} has no model configured`)
    if (!provider.models.some((item) => item.id === model)) throw new Error(`Model ${model} is not configured for ND provider ${provider.name}`)
    const format = provider.id === 'deepseek' ? 'deepseek' : protocolFromApiFormat(provider.apiFormat)
    if (!format) throw new Error(`ND provider ${provider.name} needs an explicit API format for the native agent`)
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(provider.headers ?? {})) {
      if (isDynamicSessionHeader(value)) continue
      headers[key] = value
    }
    return {
      provider: provider.id,
      model,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      format,
      headers,
    }
  }

  private readProviders(): ProviderReadResult {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      const hadPlaintextSecrets = Array.isArray(parsed) && parsed.some((value) => {
        if (!value || typeof value !== 'object') return false
        const apiKey = (value as Record<string, unknown>).apiKey
        return typeof apiKey === 'string' && apiKey.trim().length > 0
      })
      const sanitized = Array.isArray(parsed)
        ? parsed.map((item) => sanitizeProvider(item, true)).filter((provider): provider is ModelProvider => provider !== undefined)
        : []
      if (sanitized.length > 0) return { providers: sanitized, hadPlaintextSecrets }
    } catch {
      // Missing or unreadable metadata falls back to the compatibility route.
    }
    return { providers: [defaultProvider()], hadPlaintextSecrets: false }
  }

  private hydrateSecrets(providers: ModelProvider[]): ModelProvider[] {
    const secrets = this.readSecureSecrets()
    const environmentKey = process.env.DEEPSEEK_API_KEY?.trim() ?? ''
    return providers.map((provider) => ({
      ...provider,
      apiKey: secrets[provider.id]
        ?? provider.apiKey
        ?? (provider.id === 'deepseek' ? environmentKey : ''),
    })).map((provider) => ({
      ...provider,
      apiKey: provider.apiKey || (provider.id === 'deepseek' ? environmentKey : ''),
    }))
  }

  private readSecureSecrets(): Record<string, string> {
    if (!this.canPersistSecrets()) return {}
    try {
      const parsed = JSON.parse(readFileSync(this.secretsPath, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object') return {}
      const record = parsed as Record<string, unknown>
      if (record.version !== 1 || !record.keys || typeof record.keys !== 'object') return {}
      const decrypted: Record<string, string> = {}
      for (const [providerId, encoded] of Object.entries(record.keys as Record<string, unknown>)) {
        if (typeof encoded !== 'string' || !encoded) continue
        try {
          decrypted[providerId] = safeStorage.decryptString(Buffer.from(encoded, 'base64'))
        } catch (error) {
          // The key may become readable again later (keyring unlocked, profile
          // restored), so the ciphertext is preserved for the next write
          // instead of being silently dropped.
          this.preservedSecrets[providerId] = encoded
          console.warn(`Could not decrypt API key for provider ${providerId}; the stored credential is preserved:`, error)
        }
      }
      return decrypted
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Failed to read encrypted provider secrets:', error)
      return {}
    }
  }

  private persist(): void {
    try {
      const metadata = this.providers.map(({ apiKey: _apiKey, hasApiKey: _hasApiKey, ...provider }) => provider)
      writeJsonAtomic(this.filePath, metadata)
    } catch (error) {
      console.warn('Failed to persist model providers:', error)
      return
    }

    if (!this.canPersistSecrets()) {
      if (this.providers.some((provider) => provider.apiKey.trim())) {
        console.warn('OS-backed secure storage is unavailable; provider API keys will remain memory-only for this app session.')
      }
      return
    }

    try {
      const keys: Record<string, string> = { ...this.preservedSecrets }
      for (const provider of this.providers) {
        const apiKey = provider.apiKey.trim()
        if (!apiKey) continue
        keys[provider.id] = safeStorage.encryptString(apiKey).toString('base64')
      }
      const payload: ProviderSecretsFile = { version: 1, keys }
      writeJsonAtomic(this.secretsPath, payload)
    } catch (error) {
      console.warn('Failed to persist encrypted provider secrets:', error)
    }
  }

  private canPersistSecrets(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (process.platform !== 'linux') return true
    const backend = safeStorage.getSelectedStorageBackend()
    return backend !== 'basic_text' && backend !== 'unknown'
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temp, path)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* best effort */ }
    throw error
  }
}
