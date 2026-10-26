import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { NdGatewayAppId, NdGatewayConnectInput, NdGatewayMode, NdGatewayState } from '../../shared/gateway.js'
import type { ProviderStore } from '../providers.js'
import { promptShieldRuntime } from '../prompt-shield/prompt-shield-runtime.js'
import type { TokenSaverService } from '../token-saver/token-saver-service.js'
import type { CodexGatewayConfigManager } from './codex-config-manager.js'

const MAX_BODY_BYTES = 8 * 1024 * 1024
const CODEX_NATIVE_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const ND_CODEX_MODEL_PREFIX = 'nd/'

interface GatewayBinding {
  appId: NdGatewayAppId
  mode: NdGatewayMode
  providerId: string
  token: string
}

export class NdGatewayService {
  private server: Server | undefined
  private port: number | undefined
  private binding: GatewayBinding | undefined
  /**
   * Codex keeps its normal ChatGPT authorization when openai_base_url is set.
   * We learn it only after a successful native catalog request, retain it only
   * in memory, and require the same authorization before routing an ND model.
   */
  private codexNativeAuthorization: string | undefined
  private onChanged: ((state: NdGatewayState) => void) | undefined

  constructor(
    private readonly providers: () => ProviderStore,
    private readonly tokenSaver: TokenSaverService,
    private readonly fetchUpstream: typeof fetch = fetch,
    private readonly codexConfig?: CodexGatewayConfigManager,
  ) {}

  setOnChanged(listener: ((state: NdGatewayState) => void) | undefined): void {
    this.onChanged = listener
  }

  state(): NdGatewayState {
    const chatgptDetected = detectChatGptDesktop()
    const codexDetected = detectCodexDesktop()
    const binding = this.binding
    return {
      enabled: Boolean(binding),
      running: Boolean(this.server?.listening),
      ...(this.port ? { port: this.port, endpoint: `http://127.0.0.1:${this.port}/v1` } : {}),
      apps: [
        {
          id: 'chatgpt',
          name: 'ChatGPT Desktop',
          detected: chatgptDetected,
          supported: false,
          connected: false,
          mode: 'nd-enhanced',
          detail: chatgptDetected
            ? 'Detected. ChatGPT does not currently expose a safe custom model endpoint, so ND will not intercept its private traffic.'
            : 'Not detected. ND will only connect ChatGPT through a supported app integration; no terminal or OS proxy setup is used.',
        },
        {
          id: 'codex',
          name: 'Codex',
          detected: codexDetected,
          supported: true,
          connected: binding?.appId === 'codex',
          mode: binding?.appId === 'codex' ? binding.mode : 'nd-enhanced',
          ...(binding?.appId === 'codex' ? { providerId: binding.providerId } : {}),
          detail: codexDetected
            ? 'Detected. Codex can use ND Gateway through its supported custom Responses API provider configuration.'
            : 'Codex can use ND Gateway through a custom Responses API provider configuration.',
        },
      ],
    }
  }

  async connect(input: NdGatewayConnectInput): Promise<NdGatewayState> {
    const providerId = input.providerId.trim()
    if (!providerId) throw new Error('Choose a model provider first')
    const provider = this.providers().list().find((item) => item.id === providerId)
    if (!provider) throw new Error('Selected model provider was not found')
    if (!provider.hasApiKey) throw new Error(`Add the ${provider.name} API key in ND before connecting an external app`)
    if (input.appId === 'chatgpt') {
      throw new Error('ChatGPT Desktop does not currently support a custom LLM base URL. ND will not weaken your machine security to force the connection.')
    }
    if (input.appId !== 'codex') throw new Error('Unsupported external app')
    if (!supportsResponsesApi(provider.apiFormat)) {
      throw new Error(`${provider.name} must use the Responses (/responses) API format before Codex can connect through ND Gateway`)
    }
    const binding = await this.prepareLocalBinding(input.appId, input.mode, providerId)
    try {
      await this.codexConfig?.install(binding.endpoint)
    } catch (error) {
      this.binding = undefined
      this.codexNativeAuthorization = undefined
      await this.stop()
      throw error
    }
    return this.state()
  }

  async disconnect(_appId: NdGatewayAppId): Promise<NdGatewayState> {
    if (this.binding?.appId === 'codex') await this.codexConfig?.uninstall()
    this.binding = undefined
    this.codexNativeAuthorization = undefined
    await this.stop()
    return this.emit()
  }

  /**
   * Internal seam for a supported zero-click app connector. The connector gets
   * only an ND-local credential; real provider credentials stay in trusted main.
   */
  async prepareLocalBinding(appId: NdGatewayAppId, mode: NdGatewayMode, providerId: string): Promise<{ endpoint: string; token: string }> {
    if (mode === 'full-nd') {
      throw new Error('Full ND mode requires a supported ND app connector and cannot be exposed as a raw LLM proxy')
    }
    const provider = this.providers().list().find((item) => item.id === providerId)
    if (!provider?.hasApiKey) throw new Error('A provider API key is required before starting ND Gateway')
    this.binding = { appId, mode, providerId, token: `nd_local_${randomBytes(32).toString('base64url')}` }
    await this.start()
    this.emit()
    return { endpoint: `http://127.0.0.1:${this.port}/v1`, token: this.binding.token }
  }

  async close(): Promise<void> {
    try {
      if (this.binding?.appId === 'codex') await this.codexConfig?.uninstall()
    } finally {
      this.binding = undefined
      this.codexNativeAuthorization = undefined
      await this.stop()
    }
  }

  private async start(): Promise<void> {
    if (this.server?.listening) return
    this.server = createServer((request, response) => { void this.handle(request, response) })
    await new Promise<void>((resolve, reject) => {
      const server = this.server!
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        const address = server.address()
        if (!address || typeof address === 'string') return reject(new Error('ND Gateway could not allocate a loopback port'))
        this.port = address.port
        resolve()
      })
    })
  }

  private async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.port = undefined
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const binding = this.binding
      if (!binding) return json(response, 503, { error: { message: 'ND Gateway is not configured' } })
      if (binding.appId === 'codex') return this.handleCodex(request, response, binding)
      if (!authorized(request, binding.token)) return json(response, 401, { error: { message: 'Invalid ND Gateway credential' } })
      if (request.method === 'GET' && request.url === '/health') return json(response, 200, { ok: true })
      if (request.method !== 'POST' || (request.url !== '/v1/chat/completions' && request.url !== '/v1/responses')) {
        return json(response, 404, { error: { message: 'Unsupported ND Gateway endpoint' } })
      }

      const raw = await readBody(request)
      const body = JSON.parse(raw) as unknown
      const shielded = promptShieldRuntime()?.applyToPayload(body)
      if (shielded?.blocked) {
        return json(response, 422, promptShieldRejection(shielded.findings))
      }
      const shieldedBody = shielded?.payload ?? body
      const optimized = binding.mode === 'llm-only' ? shieldedBody : optimizePayload(shieldedBody, this.tokenSaver)
      const upstream = resolveUpstream(this.providers(), binding.providerId, request.url)
      const result = await this.fetchUpstream(upstream.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${upstream.apiKey}`,
        },
        body: JSON.stringify(optimized),
        signal: AbortSignal.timeout(120_000),
      })
      response.statusCode = result.status
      response.setHeader('content-type', result.headers.get('content-type') ?? 'application/json')
      if (!result.body) {
        response.end()
        return
      }
      for await (const chunk of result.body) response.write(Buffer.from(chunk))
      response.end()
    } catch (error) {
      if (!response.headersSent) json(response, 502, { error: { message: error instanceof Error ? error.message : String(error) } })
      else response.end()
    }
  }

  private async handleCodex(request: IncomingMessage, response: ServerResponse, binding: GatewayBinding): Promise<void> {
    if (request.method === 'GET' && request.url === '/v1/models') {
      const native = await this.forwardNativeCodex(request, 'models')
      if (!native.ok) return pipe(response, native)
      const catalog = await native.json() as unknown
      const augmented = augmentCodexModelCatalog(catalog, this.providers(), binding.providerId)
      this.codexNativeAuthorization = request.headers.authorization
      return json(response, 200, augmented)
    }
    if (request.method !== 'POST' || (request.url !== '/v1/responses' && request.url !== '/v1/responses/compact')) {
      return json(response, 404, { error: { message: 'Unsupported ND Gateway endpoint' } })
    }

    const raw = await readBody(request)
    const body = JSON.parse(raw) as unknown
    const model = modelId(body)
    if (!model?.startsWith(ND_CODEX_MODEL_PREFIX)) {
      return pipe(response, await this.forwardNativeCodex(request, request.url === '/v1/responses' ? 'responses' : 'responses/compact', raw))
    }
    if (!matchesAuthorization(request.headers.authorization, this.codexNativeAuthorization)) {
      return json(response, 401, { error: { message: 'Refresh the Codex model list before selecting an ND model' } })
    }
    const upstreamModel = decodeNdCodexModel(model, binding.providerId)
    if (!upstreamModel) return json(response, 400, { error: { message: 'Selected ND model is not available for this connection' } })
    const selected = this.providers().list().find((item) => item.id === binding.providerId)
    if (!selected?.models.some((item) => item.id === upstreamModel)) {
      return json(response, 400, { error: { message: 'Selected ND model is no longer configured in ND' } })
    }
    const payload = replaceModel(body, upstreamModel)
    const shielded = promptShieldRuntime()?.applyToPayload(payload)
    if (shielded?.blocked) {
      return json(response, 422, promptShieldRejection(shielded.findings))
    }
    const shieldedPayload = shielded?.payload ?? payload
    const optimized = binding.mode === 'llm-only' ? shieldedPayload : optimizePayload(shieldedPayload, this.tokenSaver)
    const upstream = resolveUpstream(this.providers(), binding.providerId, request.url)
    const result = await this.fetchUpstream(upstream.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${upstream.apiKey}`,
        ...(upstream.headers ?? {}),
      },
      body: JSON.stringify(optimized),
      signal: AbortSignal.timeout(120_000),
    })
    return pipe(response, result)
  }

  private async forwardNativeCodex(request: IncomingMessage, endpoint: 'models' | 'responses' | 'responses/compact', body?: string): Promise<Response> {
    const authorization = request.headers.authorization
    if (!authorization?.startsWith('Bearer ') || authorization.length <= 'Bearer '.length) {
      throw new Error('Codex native authorization is required')
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || isHopByHopHeader(name) || name.toLowerCase() === 'content-length') continue
      headers.set(name, Array.isArray(value) ? value.join(', ') : value)
    }
    if (endpoint === 'models') headers.delete('if-none-match')
    const result = await this.fetchUpstream(`${CODEX_NATIVE_BASE_URL}/${endpoint}`, {
      method: endpoint === 'models' ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(120_000),
    })
    return result
  }

  private emit(): NdGatewayState {
    const state = this.state()
    this.onChanged?.(state)
    return state
  }
}

function resolveUpstream(providers: ProviderStore, providerId: string, path: string): { url: string; apiKey: string; headers?: Record<string, string> | undefined } {
  const metadata = providers.list().find((item) => item.id === providerId)
  if (!metadata) throw new Error('Selected provider no longer exists')
  const runtime = providers.runtimeConfig()
  let baseUrl = metadata.baseUrl.trim().replace(/\/$/, '')
  let apiKey = ''
  if (providerId === 'deepseek') {
    baseUrl = (runtime.environment.DEEPSEEK_BASE_URL || baseUrl).replace(/\/$/, '')
    apiKey = runtime.environment.DEEPSEEK_API_KEY ?? ''
  } else {
    const profile = runtime.profiles[providerId]
    if (profile?.baseURL) baseUrl = profile.baseURL.replace(/\/$/, '')
    if (profile?.apiKeyEnv) apiKey = runtime.environment[profile.apiKeyEnv] ?? ''
  }
  if (!apiKey) throw new Error(`${metadata.name} API key is required`)
  if (!baseUrl) throw new Error(`${metadata.name} base URL is not configured`)
  return { url: joinBasePath(baseUrl, path), apiKey, ...(metadata.headers ? { headers: metadata.headers } : {}) }
}

function joinBasePath(baseUrl: string, path: string): string {
  if (baseUrl.endsWith('/v1') && path.startsWith('/v1/')) return `${baseUrl}${path.slice(3)}`
  return `${baseUrl}${path}`
}

function supportsResponsesApi(apiFormat: string): boolean {
  return apiFormat.trim().toLowerCase().includes('responses')
}

function augmentCodexModelCatalog(value: unknown, providers: ProviderStore, providerId: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const catalog = structuredClone(value) as Record<string, unknown>
  if (!Array.isArray(catalog.models)) return catalog
  const nativeModels = catalog.models.filter((model) => model && typeof model === 'object' && !Array.isArray(model)) as Record<string, unknown>[]
  const template = nativeModels.find((model) => model.visibility === 'list') ?? nativeModels[0]
  const provider = providers.list().find((item) => item.id === providerId)
  if (!template || !provider) return catalog
  const proxyModels = provider.models
    .filter((model) => model.id.trim())
    .map((model) => ({
      ...structuredClone(template),
      slug: ndCodexModelId(provider.id, model.id),
      display_name: `ND \u2014 ${provider.name} \u2014 ${model.id}`,
      description: `Route this model through ND Gateway. Native Codex models remain direct.`,
      visibility: 'list',
      supported_in_api: true,
      tool_mode: null,
    }))
  catalog.models = [...nativeModels.filter((model) => !String(model.slug ?? '').startsWith(ND_CODEX_MODEL_PREFIX)), ...proxyModels]
  return catalog
}

function ndCodexModelId(providerId: string, modelId: string): string {
  return `${ND_CODEX_MODEL_PREFIX}${encodeURIComponent(providerId)}/${encodeURIComponent(modelId)}`
}

function decodeNdCodexModel(value: string, providerId: string): string | undefined {
  const prefix = `${ND_CODEX_MODEL_PREFIX}${encodeURIComponent(providerId)}/`
  if (!value.startsWith(prefix)) return undefined
  try {
    const decoded = decodeURIComponent(value.slice(prefix.length))
    return decoded && !decoded.includes('\u0000') ? decoded : undefined
  } catch {
    return undefined
  }
}

function modelId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const model = (value as Record<string, unknown>).model
  return typeof model === 'string' && model ? model : undefined
}

function replaceModel(value: unknown, model: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Codex request body must be an object')
  return { ...(value as Record<string, unknown>), model }
}

function matchesAuthorization(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function isHopByHopHeader(name: string): boolean {
  return ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'].includes(name.toLowerCase())
}

function optimizePayload(value: unknown, tokenSaver: TokenSaverService): unknown {
  if (!value || typeof value !== 'object') return value
  const clone = structuredClone(value) as Record<string, unknown>
  if (typeof clone.instructions === 'string') clone.instructions = optimizeText(clone.instructions, tokenSaver)
  if (Array.isArray(clone.messages)) {
    clone.messages = clone.messages.map((entry) => optimizeMessage(entry, tokenSaver))
  }
  if (typeof clone.input === 'string') clone.input = optimizeText(clone.input, tokenSaver)
  else if (Array.isArray(clone.input)) clone.input = clone.input.map((entry) => optimizeMessage(entry, tokenSaver))
  return clone
}

function optimizeMessage(value: unknown, tokenSaver: TokenSaverService): unknown {
  if (!value || typeof value !== 'object') return value
  const message = { ...(value as Record<string, unknown>) }
  if (message.type && message.type !== 'message') return message
  if (typeof message.content === 'string') message.content = optimizeText(message.content, tokenSaver)
  else if (Array.isArray(message.content)) {
    message.content = message.content.map((value) => {
      if (!value || typeof value !== 'object') return value
      const block = { ...(value as Record<string, unknown>) }
      if ((block.type === 'input_text' || block.type === 'text') && typeof block.text === 'string') {
        block.text = optimizeText(block.text, tokenSaver)
      }
      return block
    })
  }
  return message
}

function optimizeText(text: string, tokenSaver: TokenSaverService): string {
  return tokenSaver.optimize(text, { kind: 'prompt' }).text
}

function promptShieldRejection(findings: unknown): Record<string, unknown> {
  return {
    error: {
      message: 'ND Prompt Shield blocked this request. Adjust the category action in ND Settings → Privacy or send a masked prompt.',
      code: 'prompt_shield_blocked',
      findings,
    },
  }
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const value = request.headers.authorization
  if (!value?.startsWith('Bearer ')) return false
  const actual = Buffer.from(value.slice(7))
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('Gateway request is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(value))
}

async function pipe(response: ServerResponse, upstream: Response): Promise<void> {
  response.statusCode = upstream.status
  response.statusMessage = upstream.statusText
  for (const [name, value] of upstream.headers) {
    if (!isHopByHopHeader(name) && name.toLowerCase() !== 'content-length') response.setHeader(name, value)
  }
  if (!upstream.body) {
    response.end()
    return
  }
  for await (const chunk of upstream.body) response.write(Buffer.from(chunk))
  response.end()
}

function detectChatGptDesktop(): boolean {
  const home = homedir()
  const candidates = process.platform === 'darwin'
    ? ['/Applications/ChatGPT.app', join(home, 'Applications/ChatGPT.app')]
    : process.platform === 'win32'
      ? [join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ChatGPT'), join(process.env.LOCALAPPDATA ?? '', 'Packages', 'OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0')]
      : [join(home, '.local', 'share', 'applications', 'chatgpt.desktop')]
  return candidates.some((path) => path && existsSync(path))
}

function detectCodexDesktop(): boolean {
  const home = homedir()
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Codex.app', join(home, 'Applications/Codex.app')]
    : process.platform === 'win32'
      ? [join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Codex'), join(process.env.LOCALAPPDATA ?? '', 'Codex')]
      : [join(home, '.local', 'share', 'applications', 'codex.desktop')]
  return candidates.some((path) => path && existsSync(path))
}
