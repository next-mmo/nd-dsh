import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { parsePromptShieldBlockedError } from '../../shared/prompt-shield.js'
import type { EngineSessionRouter } from '../engines/engine-session-router.js'
import { WebTurnError } from '../engines/web-turn.js'

const BIND_HOST = '127.0.0.1'
const MAX_BODY_BYTES = 8 * 1024 * 1024
/** Below the engine's 10-minute turn limit so its own timeout wins. */
const TURN_DEADLINE_MS = 615_000
const MAX_PENDING_PER_ENGINE = 2
const MAX_PENDING_TOTAL = 4

export type WebLaneEngine = 'chatgpt-web' | 'gemini-web'

export interface WebLaneBridgeDescriptor {
  url: string
  token: string
}

export interface WebLaneBridgeResult {
  text: string
  engineId: string
  model: string
  latencyMs: number
}

export interface WebLaneBridgeDeps {
  engineRouter: Pick<EngineSessionRouter, 'runWebLane'>
  log?: (line: string) => void
}

interface WebLaneJob {
  requestId: string
  engine: WebLaneEngine
  model?: string
  prompt: string
  controller: AbortController
  promise: Promise<WebLaneBridgeResult>
  resolve: (value: WebLaneBridgeResult) => void
  reject: (error: unknown) => void
  settled: boolean
  timedOut: boolean
  timer?: NodeJS.Timeout
}

export class WebLaneCancelledError extends Error {
  constructor() {
    super('Web lane request was cancelled')
    this.name = 'WebLaneCancelledError'
  }
}

export class WebLaneTimeoutError extends Error {
  constructor() {
    super('Web lane turn exceeded its deadline')
    this.name = 'WebLaneTimeoutError'
  }
}

export class WebLaneQueueFullError extends Error {
  constructor() {
    super('The background browser already has the maximum number of queued web-lane turns')
    this.name = 'WebLaneQueueFullError'
  }
}

/**
 * Internal loopback bridge between the Rust router and Electron's web engines.
 *
 * Both web engines drive ND's single embedded browser, so jobs are serialized
 * globally. Every job creates its own hidden web session inside the engine
 * router; the bridge never touches browser or session state directly.
 */
export class WebLaneBridge {
  private server: Server | undefined
  private port: number | undefined
  private readonly token = `ndr_bridge_${randomBytes(24).toString('base64url')}`
  private readonly queue: WebLaneJob[] = []
  private active: WebLaneJob | undefined
  private closing = false

  constructor(private readonly deps: WebLaneBridgeDeps) {}

  descriptor(): WebLaneBridgeDescriptor | undefined {
    if (!this.port) return undefined
    return { url: `http://${BIND_HOST}:${this.port}`, token: this.token }
  }

  async start(): Promise<WebLaneBridgeDescriptor> {
    if (this.server?.listening && this.port) {
      return { url: `http://${BIND_HOST}:${this.port}`, token: this.token }
    }
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        this.deps.log?.(`[router-web-bridge] ${error instanceof Error ? error.message : String(error)}`)
        if (!response.headersSent && !response.writableEnded) sendJson(response, 500, { ok: false, error: 'Internal web bridge error', code: 'bridge_error' })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, BIND_HOST, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('ND Router web bridge could not allocate a loopback port')
    }
    this.server = server
    this.port = address.port
    this.closing = false
    this.deps.log?.(`[router-web-bridge] listening on http://${BIND_HOST}:${this.port}`)
    return { url: `http://${BIND_HOST}:${this.port}`, token: this.token }
  }

  async stop(): Promise<void> {
    this.closing = true
    for (const job of [...this.queue]) this.rejectJob(job, new WebLaneCancelledError())
    this.queue.length = 0
    if (this.active) this.cancel(this.active.requestId)
    const server = this.server
    this.server = undefined
    this.port = undefined
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    }
  }

  /** Cancel one queued or active turn; safe to call more than once. */
  cancel(requestId: string): void {
    const queuedIndex = this.queue.findIndex((job) => job.requestId === requestId)
    if (queuedIndex >= 0) {
      const [job] = this.queue.splice(queuedIndex, 1)
      if (job) this.rejectJob(job, new WebLaneCancelledError())
      return
    }
    if (this.active?.requestId === requestId) {
      const job = this.active
      job.controller.abort()
      this.rejectJob(job, new WebLaneCancelledError())
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/health') {
      if (!authorized(request, this.token)) return sendJson(response, 401, { ok: false, error: 'Invalid bridge credential', code: 'unauthorized' })
      return sendJson(response, 200, { ok: true, engine: 'nd-router-web-bridge' })
    }
    if (request.method !== 'POST' || request.url !== '/v1/web/chat') {
      return sendJson(response, 404, { ok: false, error: 'Unsupported web bridge endpoint', code: 'not_found' })
    }
    if (!authorized(request, this.token)) {
      return sendJson(response, 401, { ok: false, error: 'Invalid bridge credential', code: 'unauthorized' })
    }

    let job: WebLaneJob
    try {
      const body = await readJsonBody(request)
      job = this.createJob(body)
    } catch (error) {
      const mapped = mapError(error)
      return sendJson(response, mapped.status, mapped.body)
    }

    response.on('close', () => {
      if (!response.writableEnded) this.cancel(job.requestId)
    })

    try {
      const result = await job.promise
      if (!response.writableEnded && !response.destroyed) {
        sendJson(response, 200, { ok: true, ...result })
      }
    } catch (error) {
      if (response.writableEnded || response.destroyed) return
      const mapped = mapError(error)
      sendJson(response, mapped.status, mapped.body)
    }
  }

  private createJob(body: unknown): WebLaneJob {
    if (!body || typeof body !== 'object') throw new BadBridgeRequest('Request body must be a JSON object')
    const record = body as Record<string, unknown>
    const engine = record.engine === 'gemini-web' ? 'gemini-web' : record.engine === 'chatgpt-web' ? 'chatgpt-web' : undefined
    if (!engine) throw new BadBridgeRequest('engine must be chatgpt-web or gemini-web')
    const prompt = typeof record.prompt === 'string' ? record.prompt : ''
    if (!prompt.trim()) throw new BadBridgeRequest('prompt is required')
    if (prompt.length > 100_000) throw new BadBridgeRequest('prompt exceeds the 100,000 character limit')
    const requestId = typeof record.requestId === 'string' && record.requestId.trim()
      ? record.requestId.trim().slice(0, 128)
      : `web-${randomBytes(12).toString('hex')}`
    const model = typeof record.model === 'string' && record.model.trim() ? record.model.trim().slice(0, 200) : undefined

    if (this.closing) throw new WebLaneQueueFullError()
    if (this.queue.length >= MAX_PENDING_TOTAL || this.queue.filter((job) => job.engine === engine).length >= MAX_PENDING_PER_ENGINE) {
      throw new WebLaneQueueFullError()
    }

    let resolve!: (value: WebLaneBridgeResult) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<WebLaneBridgeResult>((res, rej) => {
      resolve = res
      reject = rej
    })
    const job: WebLaneJob = {
      requestId,
      engine,
      ...(model ? { model } : {}),
      prompt,
      controller: new AbortController(),
      promise,
      resolve,
      reject,
      settled: false,
      timedOut: false,
    }
    this.queue.push(job)
    this.drain()
    return job
  }

  private drain(): void {
    if (this.active || this.closing) return
    const job = this.queue.shift()
    if (!job) return
    if (job.settled) {
      this.drain()
      return
    }
    this.active = job
    this.deps.log?.(`[router-web-bridge] ${job.engine} ${job.requestId} started`)
    job.timer = setTimeout(() => {
      job.timedOut = true
      job.controller.abort()
      this.rejectJob(job, new WebLaneTimeoutError())
    }, TURN_DEADLINE_MS)
    const startedAt = Date.now()
    void this.deps.engineRouter.runWebLane({
      engineId: job.engine,
      prompt: job.prompt,
      ...(job.model ? { model: job.model } : {}),
      signal: job.controller.signal,
    }).then((result) => {
      this.deps.log?.(`[router-web-bridge] ${job.engine} ${job.requestId} finished in ${Date.now() - startedAt}ms (${result.text.length} chars)`)
      if (!job.settled) {
        job.settled = true
        job.resolve(result)
      }
    }).catch((error) => {
      this.deps.log?.(`[router-web-bridge] ${job.engine} ${job.requestId} failed in ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}`)
      this.rejectJob(job, job.timedOut ? new WebLaneTimeoutError() : error)
    }).finally(() => {
      if (job.timer) clearTimeout(job.timer)
      if (this.active === job) this.active = undefined
      this.drain()
    })
  }

  private rejectJob(job: WebLaneJob, error: unknown): void {
    if (job.settled) return
    job.settled = true
    if (job.timer) clearTimeout(job.timer)
    job.reject(error)
  }
}

class BadBridgeRequest extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadBridgeRequest'
  }
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  return constantTimeEqual(token, expected)
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  if (leftBytes.length !== rightBytes.length) return false
  return timingSafeEqual(leftBytes, rightBytes)
}

function mapError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof BadBridgeRequest) {
    return { status: 400, body: { ok: false, error: error.message, code: 'invalid_request' } }
  }
  if (error instanceof WebLaneQueueFullError) {
    return { status: 429, body: { ok: false, error: error.message, code: 'queue_full' } }
  }
  if (error instanceof WebLaneCancelledError) {
    return { status: 499, body: { ok: false, error: error.message, code: 'turn_cancelled' } }
  }
  if (error instanceof WebLaneTimeoutError) {
    return { status: 504, body: { ok: false, error: error.message, code: 'turn_timeout' } }
  }
  if (error instanceof WebTurnError) {
    switch (error.code) {
      case 'cancelled':
        return { status: 499, body: { ok: false, error: error.message, code: 'turn_cancelled' } }
      case 'login-required':
        return { status: 503, body: { ok: false, error: error.message, code: 'web_signed_out' } }
      case 'challenge':
        return { status: 503, body: { ok: false, error: error.message, code: 'web_challenge' } }
      case 'rate-limited':
        return { status: 429, body: { ok: false, error: error.message, code: 'web_rate_limited' } }
      case 'page-busy':
        return { status: 429, body: { ok: false, error: error.message, code: 'browser_busy' } }
      case 'timeout':
        return { status: 504, body: { ok: false, error: error.message, code: 'turn_timeout' } }
      default:
        return { status: 502, body: { ok: false, error: error.message, code: `web_${error.code.replace(/-/g, '_')}` } }
    }
  }
  const failure = error instanceof Error ? error.message : String(error)
  const blocked = parsePromptShieldBlockedError(failure)
  if (blocked) {
    return {
      status: 422,
      body: { ok: false, error: 'ND Prompt Shield blocked this prompt', code: 'prompt_shield_blocked', findings: blocked.findings },
    }
  }
  return { status: 502, body: { ok: false, error: failure || 'Web lane failed', code: 'turn_failed' } }
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        request.destroy()
        reject(new BadBridgeRequest(`Request body exceeded ${MAX_BODY_BYTES} bytes`))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return reject(new BadBridgeRequest('Request body is empty'))
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new BadBridgeRequest('Malformed JSON payload'))
      }
    })
    request.on('error', (error) => reject(error))
    request.on('aborted', () => reject(new WebLaneCancelledError()))
  })
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  if (response.writableEnded || response.destroyed) return
  const json = JSON.stringify(payload)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  })
  response.end(json)
}