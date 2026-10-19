import type { CoreClient } from './core-client.js'

export interface CoreApiHttpHeader {
  name: string
  value: string
}

export interface CoreApiHttpRequest {
  url: string
  method: string
  headers: CoreApiHttpHeader[]
  body?: string
  timeoutMs?: number
  maxResponseBytes?: number
}

export interface CoreApiHttpResponse {
  status: number
  statusText: string
  headers: CoreApiHttpHeader[]
  body: string
  bodyEncoding: 'utf8' | 'base64'
  bytes: number
  truncated: boolean
  durationMs: number
  finalUrl: string
}

/**
 * nd-core's outbound HTTP surface. The extension web view has no network, so
 * API Studio sends through the sidecar; scheme, header, redirect, size, and
 * timeout policy live in Rust and fail closed when the sidecar is absent.
 */
export interface CoreApiHttp {
  execute(request: CoreApiHttpRequest): Promise<CoreApiHttpResponse>
}

const DEFAULT_TIMEOUT_MS = 30_000
/** The client waits longer than the core so a deadline arrives as a typed error. */
const CLIENT_TIMEOUT_MARGIN_MS = 5_000

export function createCoreApiHttp(core: Pick<CoreClient, 'request'>): CoreApiHttp {
  return {
    async execute(request) {
      const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
      return await core.request<CoreApiHttpResponse>(
        'apiStudio.request',
        request,
        timeoutMs + CLIENT_TIMEOUT_MARGIN_MS,
      )
    },
  }
}
