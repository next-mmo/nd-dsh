import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DesignAgentTool } from './design-agent-tool.js'

const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * Loopback bridge used by the default ND Harness's design MCP server.
 *
 * The Harness runs as a separate process. It cannot call the in-process design
 * session, so this server exposes exactly one authenticated route. The token is
 * per app launch and lives only in the harness child environment; the renderer
 * never receives it.
 */
export class DesignAgentBridge {
  private server: Server | undefined
  private token = ''

  constructor(
    private readonly tool: DesignAgentTool,
    private readonly entryPath: string,
  ) {}

  async start(): Promise<void> {
    if (this.server) return
    this.token = randomUUID()
    const server = createServer((request, response) => {
      void this.handle(request, response)
    })
    this.server = server
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError)
        resolvePromise()
      })
    })
    const address = server.address() as AddressInfo | null
    if (!address?.port) {
      server.close()
      this.server = undefined
      throw new Error('ND Pencil design bridge did not bind a loopback port')
    }
    process.env.ND_DSH_DESIGN_MCP_URL = `http://127.0.0.1:${address.port}`
    process.env.ND_DSH_DESIGN_MCP_TOKEN = this.token
    process.env.ND_DSH_DESIGN_MCP_ENTRY = this.entryPath
  }

  async destroy(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.token = ''
    delete process.env.ND_DSH_DESIGN_MCP_URL
    delete process.env.ND_DSH_DESIGN_MCP_TOKEN
    delete process.env.ND_DSH_DESIGN_MCP_ENTRY
    if (!server) return
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('x-content-type-options', 'nosniff')
    if (request.method !== 'POST' || request.url !== '/nd-design') {
      send(response, 404, { ok: false, error: 'Not found' })
      return
    }
    if (!this.authorized(request)) {
      send(response, 401, { ok: false, error: 'Unauthorized' })
      return
    }
    try {
      const raw = await readBody(request)
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error('ND Pencil bridge body must be JSON')
      }
      if (!isRecord(parsed)) throw new Error('ND Pencil bridge body must be an object')
      const cwd = stringValue(parsed.cwd, 'cwd')
      const action = stringValue(parsed.action, 'action')
      const args = isRecord(parsed.args) ? parsed.args : {}
      const result = await this.tool.call({ sessionCwd: cwd, action, args })
      send(response, 200, { ok: true, result })
    } catch (cause) {
      send(response, 400, { ok: false, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const expected = `Bearer ${this.token}`
    const actual = request.headers.authorization ?? ''
    if (!this.token || actual.length !== expected.length) return false
    return timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('ND Pencil bridge request is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.end(JSON.stringify(body))
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) {
    throw new Error(`ND Pencil bridge ${label} must be a short non-empty string`)
  }
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
