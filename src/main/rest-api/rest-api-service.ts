import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { promises as fsPromises, existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { CHATGPT_WEB_ENGINE_ID, GEMINI_WEB_ENGINE_ID } from '../../shared/coding-engines.js'
import { parsePromptShieldBlockedError } from '../../shared/prompt-shield.js'
import type {
  RestApiRunRequest,
  RestApiRunResponse,
  RestApiStatusResponse,
  SrtTranslateRequest,
  SrtTranslateResponse,
} from '../../shared/rest-api.js'
import type { EngineSessionRouter } from '../engines/engine-session-router.js'
import { extractLatestAssistantText } from '../engines/web-turn-result.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import {
  buildDubbingPrompt,
  chunkSrtBlocks,
  formatSrt,
  mergeTranslatedChunk,
  parseSrt,
} from './srt-parser.js'

const DEFAULT_PORT = 3118
const MAX_BODY_BYTES = 16 * 1024 * 1024 // 16MB
const BIND_HOST = '127.0.0.1'

export interface NdRestApiServiceOptions {
  engineRouter: EngineSessionRouter
  workspace: WorkspaceService
  userDataPath: string
  preferredPort?: number | undefined
  log?: ((line: string) => void) | undefined
}

export class NdRestApiService {
  private server: Server | undefined
  private activePort: number | undefined
  private readonly infoFilePath: string

  private readonly options: NdRestApiServiceOptions

  constructor(options: NdRestApiServiceOptions) {
    this.options = options
    this.infoFilePath = join(options.userDataPath, 'nd-rest-api.json')
  }

  port(): number | undefined {
    return this.activePort
  }

  endpoint(): string | undefined {
    return this.activePort ? `http://${BIND_HOST}:${this.activePort}` : undefined
  }

  status(): RestApiStatusResponse {
    return {
      ok: true,
      status: this.server?.listening ? 'ready' : 'stopped',
      port: this.activePort ?? 0,
      endpoint: this.endpoint() ?? '',
      defaultEngine: CHATGPT_WEB_ENGINE_ID,
      availableEngines: [CHATGPT_WEB_ENGINE_ID, GEMINI_WEB_ENGINE_ID],
      workspace: this.options.workspace.state().root,
    }
  }

  async start(): Promise<{ port: number; endpoint: string }> {
    if (this.server?.listening && this.activePort) {
      return { port: this.activePort, endpoint: `http://${BIND_HOST}:${this.activePort}` }
    }

    const startPort = this.resolvePort()
    const server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((err) => {
        this.options.log?.(`[rest-api] Unhandled error: ${err instanceof Error ? err.message : String(err)}`)
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : 'Internal Server Error' })
        }
      })
    })

    const boundPort = await this.listenWithFallback(server, startPort)
    this.server = server
    this.activePort = boundPort

    const endpoint = `http://${BIND_HOST}:${boundPort}`
    this.persistInfo(boundPort, endpoint)
    this.options.log?.(`[rest-api] ND REST API listening on ${endpoint}`)

    return { port: boundPort, endpoint }
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve())
      })
      this.server = undefined
      this.activePort = undefined
    }
    this.clearInfo()
  }

  private resolvePort(): number {
    const envVal = process.env.ND_REST_API_PORT || process.env.ND_API_PORT
    if (envVal) {
      const parsed = parseInt(envVal, 10)
      if (Number.isInteger(parsed) && parsed >= 1024 && parsed < 65536) return parsed
    }
    return this.options.preferredPort || DEFAULT_PORT
  }

  private async listenWithFallback(server: Server, preferredPort: number): Promise<number> {
    for (let offset = 0; offset < 10; offset++) {
      const candidatePort = preferredPort + offset
      const bound = await new Promise<boolean>((resolve) => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            resolve(false)
          } else {
            resolve(false)
          }
        })
        server.listen(candidatePort, BIND_HOST, () => {
          resolve(true)
        })
      })
      if (bound) return candidatePort
    }

    // Ephemeral port fallback
    return new Promise<number>((resolve, reject) => {
      server.listen(0, BIND_HOST, () => {
        const address = server.address()
        if (address && typeof address === 'object') {
          resolve(address.port)
        } else {
          reject(new Error('Failed to resolve bound port'))
        }
      })
    })
  }

  private persistInfo(port: number, endpoint: string): void {
    try {
      const payload = {
        port,
        endpoint,
        pid: process.pid,
        startedAt: Date.now(),
      }
      writeFileSync(this.infoFilePath, JSON.stringify(payload, null, 2), 'utf-8')
    } catch (err) {
      this.options.log?.(`[rest-api] Failed to write ${this.infoFilePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private clearInfo(): void {
    try {
      if (existsSync(this.infoFilePath)) unlinkSync(this.infoFilePath)
    } catch {
      // best effort
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers for loopback clients
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const rawUrl = req.url || '/'
    const parsedUrl = new URL(rawUrl, `http://${BIND_HOST}`)
    const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/'

    // 1. Health / status routes
    if (req.method === 'GET' && (pathname === '/' || pathname === '/api/status' || pathname === '/api/health')) {
      sendJson(res, 200, this.status())
      return
    }

    // 2. Sessions list
    if (req.method === 'GET' && pathname === '/api/sessions') {
      const sessions = this.options.engineRouter.sessions()
      sendJson(res, 200, { ok: true, sessions })
      return
    }

    // 3. Transcript route: /api/sessions/:id/transcript
    const transcriptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/)
    if (req.method === 'GET' && transcriptMatch?.[1]) {
      const sessionId = decodeURIComponent(transcriptMatch[1])
      try {
        const transcript = await this.options.engineRouter.transcript(sessionId)
        sendJson(res, 200, { ok: true, transcript })
      } catch (err) {
        sendJson(res, 404, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    // 4. SRT Dubbing Translation: /gpt-web/translate-srt, /api/gpt-web/translate-srt, /api/translate-srt
    if (
      req.method === 'POST' &&
      (pathname === '/gpt-web/translate-srt' ||
        pathname === '/api/gpt-web/translate-srt' ||
        pathname === '/api/translate-srt')
    ) {
      await this.handleTranslateSrt(req, res, pathname, parsedUrl)
      return
    }

    // 5. Prompt Run: /gpt-web/run, /api/gpt-web/run, /api/run
    if (
      req.method === 'POST' &&
      (pathname === '/gpt-web/run' || pathname === '/api/gpt-web/run' || pathname === '/api/run')
    ) {
      await this.handleRunPrompt(req, res, pathname)
      return
    }

    sendJson(res, 404, { ok: false, error: `Route not found: ${req.method} ${pathname}` })
  }

  private async handleTranslateSrt(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    parsedUrl: URL,
  ): Promise<void> {
    const contentType = req.headers['content-type'] || ''
    const acceptHeader = req.headers['accept'] || ''
    const bodyBuffer = await readRequestBody(req)
    const rawBody = bodyBuffer.toString('utf-8').trim()

    let requestData: SrtTranslateRequest = {}
    const isJson = contentType.includes('application/json')

    if (isJson && rawBody) {
      try {
        requestData = JSON.parse(rawBody) as SrtTranslateRequest
      } catch {
        sendJson(res, 400, { ok: false, error: 'Malformed JSON payload in request body' })
        return
      }
    } else if (rawBody) {
      // Body is raw SRT
      const parsedBatchParam = parsedUrl.searchParams.get('batchSize')
      const parsedBatch = parsedBatchParam ? parseInt(parsedBatchParam, 10) : undefined
      requestData = {
        srt: rawBody,
        targetLanguage: parsedUrl.searchParams.get('targetLanguage') || 'Khmer',
        engine: parsedUrl.searchParams.get('engine') || undefined,
        batchSize: Number.isInteger(parsedBatch) ? parsedBatch : undefined,
      }
    }

    // Check if filePath is provided
    let srtContent = requestData.srt || ''
    if (!srtContent && requestData.filePath) {
      try {
        srtContent = await fsPromises.readFile(requestData.filePath, 'utf-8')
      } catch (err) {
        sendJson(res, 400, {
          ok: false,
          error: `Could not read SRT file from path: ${err instanceof Error ? err.message : String(err)}`,
        })
        return
      }
    }

    if (!srtContent.trim()) {
      sendJson(res, 400, {
        ok: false,
        error: 'Missing SRT content. Provide "srt", "filePath", or raw SRT text in the request body.',
      })
      return
    }

    const blocks = parseSrt(srtContent)
    if (blocks.length === 0) {
      sendJson(res, 400, { ok: false, error: 'No valid subtitle blocks found in the provided SRT content.' })
      return
    }

    const targetLanguage = requestData.targetLanguage?.trim() || 'Khmer'
    const batchSize = Math.max(1, requestData.batchSize || 25)
    const engineId = normalizeEngineId(
      requestData.engine || requestData.engineId || (pathname.includes('gpt-web') ? CHATGPT_WEB_ENGINE_ID : undefined),
    )

    const chunks = chunkSrtBlocks(blocks, batchSize)
    const translatedBlocks = []
    let activeSessionId = requestData.sessionId

    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        if (!chunk) continue
        const chunkSrt = formatSrt(chunk)
        const prompt = buildDubbingPrompt(chunkSrt, targetLanguage, requestData.instructions)

        const runResult = await this.options.engineRouter.run(prompt, {
          engineId,
          ...(activeSessionId ? { sessionId: activeSessionId } : {}),
          ...(requestData.cwd ? { workspaceCwd: requestData.cwd } : {}),
        })
        activeSessionId = runResult.sessionId

        const transcript = await this.options.engineRouter.transcript(activeSessionId)
        const assistantText = extractLatestAssistantText(transcript.events)
        if (!assistantText) {
          throw new Error(
            `Engine ${engineId} finished batch ${i + 1}/${chunks.length} without an assistant message`,
          )
        }

        const merged = mergeTranslatedChunk(chunk, assistantText)
        translatedBlocks.push(...merged)
      }

      const finalSrt = formatSrt(translatedBlocks)

      if (requestData.outputPath) {
        await fsPromises.writeFile(requestData.outputPath, finalSrt, 'utf-8')
      }

      const wantsText = !isJson && !acceptHeader.includes('application/json')
      if (wantsText) {
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': Buffer.byteLength(finalSrt),
        })
        res.end(finalSrt)
        return
      }

      const responsePayload: SrtTranslateResponse = {
        ok: true,
        targetLanguage,
        totalBlocks: blocks.length,
        batches: chunks.length,
        engineId,
        sessionId: activeSessionId || '',
        srt: finalSrt,
        ...(requestData.outputPath ? { outputPath: requestData.outputPath } : {}),
      }
      sendJson(res, 200, responsePayload)
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: `SRT translation failed: ${err instanceof Error ? err.message : String(err)}`,
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
      })
    }
  }

  private async handleRunPrompt(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const bodyBuffer = await readRequestBody(req)
    const rawBody = bodyBuffer.toString('utf-8').trim()
    let requestData: RestApiRunRequest = { prompt: '' }

    try {
      requestData = JSON.parse(rawBody) as RestApiRunRequest
    } catch {
      sendJson(res, 400, { ok: false, error: 'Malformed JSON payload in request body' })
      return
    }

    if (!requestData.prompt || !requestData.prompt.trim()) {
      sendJson(res, 400, { ok: false, error: 'Missing required "prompt" field in request body' })
      return
    }

    const engineId = normalizeEngineId(
      requestData.engine || requestData.engineId || (pathname.includes('gpt-web') ? CHATGPT_WEB_ENGINE_ID : undefined),
    )

    try {
      const runResult = await this.options.engineRouter.run(requestData.prompt, {
        engineId,
        ...(requestData.sessionId ? { sessionId: requestData.sessionId } : {}),
        ...(requestData.cwd ? { workspaceCwd: requestData.cwd } : {}),
        ...(requestData.permissionMode ? { permissionMode: requestData.permissionMode } : {}),
      })

      const transcript = await this.options.engineRouter.transcript(runResult.sessionId)
      const assistantText = extractLatestAssistantText(transcript.events) || ''

      const responsePayload: RestApiRunResponse = {
        ok: true,
        engineId,
        sessionId: runResult.sessionId,
        response: assistantText,
      }
      sendJson(res, 200, responsePayload)
    } catch (err) {
      const failure = err instanceof Error ? err.message : String(err)
      const blocked = parsePromptShieldBlockedError(failure)
      if (blocked) {
        sendJson(res, 422, {
          ok: false,
          error: 'ND Prompt Shield blocked this prompt',
          code: 'prompt_shield_blocked',
          findings: blocked.findings,
          engineId,
          sessionId: requestData.sessionId || '',
        })
        return
      }
      sendJson(res, 500, {
        ok: false,
        error: `Engine run failed: ${failure}`,
        engineId,
        sessionId: requestData.sessionId || '',
      })
    }
  }
}

function normalizeEngineId(engine?: string): string {
  if (!engine) return CHATGPT_WEB_ENGINE_ID
  const lower = engine.toLowerCase().trim()
  if (lower === 'gpt-web' || lower === 'chatgpt' || lower === 'chatgpt-web') return CHATGPT_WEB_ENGINE_ID
  if (lower === 'gemini-web' || lower === 'gemini') return GEMINI_WEB_ENGINE_ID
  return engine
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const json = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  })
  res.end(json)
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error(`Request body exceeded ${MAX_BODY_BYTES} byte limit`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', (err) => reject(err))
  })
}
