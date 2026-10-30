import { createHash } from 'node:crypto'
import type { RouterService } from './router-service.js'
import {
  NINE_ROUTER_EXTERNAL_PROVIDER_ID,
  type NineRouterConnectInput,
  type NineRouterModel,
} from '../../shared/nine-router.js'

/** Gateway URLs are user-specified, but never an arbitrary http private-network request. */
export function parseNineRouterBaseUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('Invalid 9Router URL')
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw new Error('9Router URL must be absolute') }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  // External hosts require explicit remote-gateway policy and DNS/IP egress
  // controls. Do not allow an arbitrary renderer string to make main-process
  // HTTPS requests to private networks, metadata endpoints, or rebinding hosts.
  if (!loopback) throw new Error('9Router currently supports loopback gateways only')
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Unsupported gateway URL scheme')
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '') !== '/v1') {
    throw new Error('9Router URL must end with /v1 and have no credentials, query or fragment')
  }
  if (!url.port && loopback) throw new Error('Specify the local 9Router port')
  return url
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const size = Number(response.headers.get('content-length') ?? 0)
  if (size > maxBytes) throw new Error('9Router response too large')
  if (!response.body) throw new Error('9Router returned no model catalog')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let count = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      count += value.byteLength
      if (count > maxBytes) throw new Error('9Router model catalog exceeded size limit')
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks.map(v => Buffer.from(v))).toString('utf8')) as unknown
}

export async function discoverNineRouterModels(input: NineRouterConnectInput, fetcher: typeof fetch = fetch): Promise<NineRouterModel[]> {
  const url = parseNineRouterBaseUrl(input.baseUrl)
  if (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 32768) {
    throw new Error('A 9Router gateway API key is required')
  }
  const target = new URL(url.toString())
  target.pathname = '/v1/models'
  const response = await fetcher(target, {
    method: 'GET',
    redirect: 'error',
    headers: { authorization: 'Bearer ' + input.apiKey.trim(), accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error('9Router model discovery failed: HTTP ' + response.status)
  const data = await boundedJson(response, 2 * 1024 * 1024)
  if (!data || typeof data !== 'object' || !('data' in data) || !Array.isArray(data.data)) {
    throw new Error('9Router did not return an OpenAI-compatible /models catalog')
  }
  const unique = new Set<string>()
  for (const item of data.data) {
    if (!item || typeof item !== 'object') continue
    const id = (item as {id?:unknown}).id
    if (typeof id === 'string' && id.trim() && id.length <= 200) unique.add(id.trim())
  }
  const models = [...unique].slice(0, 60).map(id => ({ id }))
  if (!models.length) throw new Error('No models are configured in 9Router. Add an account using its dashboard.')
  return models
}

/** Connects the existing ND Router. No model gateway API keys persist in React. */
export async function connectNineRouter(
  router: RouterService,
  input: NineRouterConnectInput,
  fetcher: typeof fetch = fetch,
): Promise<{ connected: number; endpoint: string }> {
  const baseUrl = parseNineRouterBaseUrl(input.baseUrl).toString().replace(/\/$/, '')
  const models = await discoverNineRouterModels(input, fetcher)
  const providerId = NINE_ROUTER_EXTERNAL_PROVIDER_ID
  await router.saveProvider({
    id: providerId,
    kind: 'openai-compatible',
    name: '9Router',
    baseUrl,
    models: models.map(m => m.id),
    isActive: true,
    apiKey: input.apiKey,
  })
  const state = await router.state()
  const available = new Set(models.map(m => m.id))
  // Only touch our own one-lane generated combos. Never change user combos.
  for (const combo of state.combos) {
    if (!combo.name.startsWith('9R: ')) continue
    if (combo.models.length !== 1 || combo.models[0]?.providerId !== providerId) continue
    if (!available.has(combo.models[0].model)) await router.deleteCombo(combo.id)
  }
  for (const model of models) {
    const prefix = '9R: '
    const name = (prefix + model.id).length <= 64
      ? prefix + model.id
      : prefix + model.id.slice(0, 43) + '-' + createHash('sha256').update(model.id).digest('hex').slice(0, 12)
    const latest = await router.state()
    if (latest.combos.some(c => c.name === name)) continue
    await router.saveCombo({ name, strategy: 'priority', models: [{ providerId, model: model.id }] })
  }
  return { connected: models.length, endpoint: baseUrl }
}
