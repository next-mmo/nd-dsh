import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  PHONE_INPUT_MAX_TEXT_CHARS,
  PHONE_INPUT_TOKEN_TTL_MS,
  isPhoneInputKey,
  type PhoneInputClientInfo,
  type PhoneInputInterfaceInfo,
  type PhoneInputOptions,
  type PhoneInputSessionState,
  type PhoneInputSnapshot,
} from '../../shared/phone-input.js'
import type { CoreInput } from '../core/core-input.js'
import {
  classifyRemoteTransport,
  discoverPhoneAudioInterfaces,
  isAllowedLocalRemoteIp,
  normalizeRemoteIp,
} from './phone-audio-network.js'
import { renderPairingQrSvg } from './phone-audio-qr.js'
import { renderPhoneInputPageHtml } from './phone-input-page.js'

const FIREWALL_HINT =
  'If Android cannot open the URL over Wi-Fi, allow ND-DSH on Private networks in Windows Defender Firewall, or switch Android to USB tethering.'

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws: wss:",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

interface BoundHttpListener {
  address: string
  server: Server
}

interface PairAttemptRecord {
  failures: number
  lockedUntil: number
}

export interface PhoneInputServiceOptions {
  /** nd-core keyboard injection surface; injection fails closed without it. */
  inject?: CoreInput
  renderQrSvg?: (url: string) => Promise<string>
  discoverInterfaces?: (port: number, token: string) => Promise<PhoneInputInterfaceInfo[]>
  onSnapshot?: (snapshot: PhoneInputSnapshot) => void
  onLog?: (line: string) => void
  /** Skip nothing renderer-side (there is no capture); kept for test parity. */
  headless?: boolean
  tokenTtlMs?: number
  disableRefreshTimer?: boolean
}

export class PhoneInputService {
  private readonly injectFn: CoreInput | undefined
  private readonly renderQrSvgFn: (url: string) => Promise<string>
  private readonly discoverInterfacesFn: (port: number, token: string) => Promise<PhoneInputInterfaceInfo[]>
  private readonly onSnapshotCb: ((snapshot: PhoneInputSnapshot) => void) | undefined
  private readonly onLogFn: (line: string) => void
  private readonly tokenTtlMs: number
  private readonly disableRefreshTimer: boolean

  private sessionState: PhoneInputSessionState = 'stopped'
  private serverRunning = false
  private port: number | null = null
  private token: string | null = null
  private pairingCode: string | null = null
  private tokenExpiresAt: number | null = null
  private interfaces: PhoneInputInterfaceInfo[] = []
  private options: PhoneInputOptions = {}
  private client: PhoneInputClientInfo | null = null
  private injectedChars = 0
  private injectedKeys = 0
  private lastError: string | null = null

  private listeners: BoundHttpListener[] = []
  private wss: WebSocketServer | null = null
  private activeSocket: WebSocket | null = null
  private activeClientId: string | null = null
  private pairAttempts = new Map<string, PairAttemptRecord>()
  private refreshTimer: NodeJS.Timeout | null = null
  private injectQueue: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(opts: PhoneInputServiceOptions = {}) {
    this.injectFn = opts.inject
    this.renderQrSvgFn = opts.renderQrSvg ?? renderPairingQrSvg
    this.discoverInterfacesFn =
      opts.discoverInterfaces ??
      ((port, token) => discoverPhoneAudioInterfaces(port, token, this.renderQrSvgFn))
    this.onSnapshotCb = opts.onSnapshot
    this.onLogFn = opts.onLog ?? (() => undefined)
    this.tokenTtlMs = opts.tokenTtlMs ?? PHONE_INPUT_TOKEN_TTL_MS
    this.disableRefreshTimer = opts.disableRefreshTimer === true
  }

  async snapshot(): Promise<PhoneInputSnapshot> {
    await this.refreshInterfaces()
    return this.currentSnapshot()
  }

  currentSnapshot(): PhoneInputSnapshot {
    const selected = this.resolveSelectedInterface()
    return {
      sessionState: this.sessionState,
      serverRunning: this.serverRunning,
      port: this.port,
      pairingCode: this.pairingCode,
      tokenExpiresAt: this.tokenExpiresAt,
      selectedInterfaceId: selected?.id ?? null,
      selectedUrl: selected?.url ?? null,
      interfaces: this.interfaces,
      options: { ...this.options },
      client: this.client ? { ...this.client } : null,
      injectedChars: this.injectedChars,
      injectedKeys: this.injectedKeys,
      lastError: this.lastError,
      firewallHint: FIREWALL_HINT,
    }
  }

  async start(partialOptions?: Partial<PhoneInputOptions>): Promise<PhoneInputSnapshot> {
    if (this.disposed) throw new Error('Phone Keyboard service is disposed')
    if (partialOptions) this.applyOptions(partialOptions)

    if (this.serverRunning) {
      await this.refreshInterfaces()
      return this.currentSnapshot()
    }

    this.lastError = null
    this.sessionState = 'starting'
    this.issueFreshCredentials()
    this.emitSnapshot()

    try {
      await this.startNetworkServer()
      await this.refreshInterfaces()
      this.sessionState = 'waiting'
      if (!this.disableRefreshTimer) {
        this.refreshTimer = setInterval(() => { void this.tickRefresh() }, 4_000)
        this.refreshTimer.unref?.()
      }
      this.emitSnapshot()
      return this.currentSnapshot()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      await this.stopInternal(msg, true)
      throw error
    }
  }

  async stop(reason?: string): Promise<PhoneInputSnapshot> {
    await this.stopInternal(reason, false)
    return this.currentSnapshot()
  }

  async disconnectClient(): Promise<PhoneInputSnapshot> {
    if (this.activeSocket) {
      this.sendWs(this.activeSocket, { type: 'server-stop', reason: 'Disconnected by desktop.' })
      try {
        this.activeSocket.close(4003, 'Disconnected by desktop')
      } catch {
        // Ignore close errors.
      }
      this.activeSocket = null
    }
    this.activeClientId = null
    this.client = null
    if (this.serverRunning) this.sessionState = 'waiting'
    this.emitSnapshot()
    return this.currentSnapshot()
  }

  async rotateToken(): Promise<PhoneInputSnapshot> {
    if (!this.serverRunning) return this.currentSnapshot()
    await this.disconnectClient()
    this.issueFreshCredentials()
    await this.refreshInterfaces()
    this.emitSnapshot()
    return this.currentSnapshot()
  }

  async setOptions(partial: Partial<PhoneInputOptions>): Promise<PhoneInputSnapshot> {
    this.applyOptions(partial)
    await this.refreshInterfaces()
    this.emitSnapshot()
    return this.currentSnapshot()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stopInternal(undefined, false)
  }

  private applyOptions(partial: Partial<PhoneInputOptions>): void {
    if (typeof partial.preferredInterfaceId === 'string') {
      const cleaned = partial.preferredInterfaceId.trim()
      if (cleaned) this.options.preferredInterfaceId = cleaned
      else delete this.options.preferredInterfaceId
    }
  }

  private issueFreshCredentials(): void {
    this.token = randomBytes(16).toString('hex')
    this.pairingCode = String(randomInt(100_000, 1_000_000))
    this.tokenExpiresAt = Date.now() + this.tokenTtlMs
    this.pairAttempts.clear()
  }

  private isTokenValid(candidate: string | null | undefined): boolean {
    if (!candidate || !this.token || !this.tokenExpiresAt) return false
    if (Date.now() > this.tokenExpiresAt) return false
    const a = Buffer.from(candidate, 'utf8')
    const b = Buffer.from(this.token, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private isCodeValid(candidate: string): boolean {
    if (!this.pairingCode || !this.tokenExpiresAt) return false
    if (Date.now() > this.tokenExpiresAt) return false
    const a = Buffer.from(candidate.trim(), 'utf8')
    const b = Buffer.from(this.pairingCode, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private resolveSelectedInterface(): PhoneInputInterfaceInfo | undefined {
    if (this.interfaces.length === 0) return undefined
    if (this.options.preferredInterfaceId) {
      const match = this.interfaces.find((item) => item.id === this.options.preferredInterfaceId)
      if (match) return match
    }
    return this.interfaces[0]
  }

  private async refreshInterfaces(): Promise<void> {
    const activePort = this.port ?? 0
    const activeToken = this.token ?? ''
    if (this.serverRunning && activePort > 0 && activeToken) {
      this.interfaces = await this.discoverInterfacesFn(activePort, activeToken)
      await this.reconcileInterfaceListeners()
    } else {
      this.interfaces = await this.discoverInterfacesFn(0, 'preview')
    }
  }

  private async tickRefresh(): Promise<void> {
    if (!this.serverRunning || this.disposed) return
    if (this.tokenExpiresAt && Date.now() > this.tokenExpiresAt) {
      await this.stopInternal(`Pairing session expired after ${Math.round(this.tokenTtlMs / 60_000)} minutes. Start Phone Keyboard again for a new code.`, true)
      return
    }
    await this.refreshInterfaces()
    this.emitSnapshot()
  }

  private async startNetworkServer(): Promise<void> {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
    this.wss = wss
    wss.on('connection', (socket, req) => this.handleWsConnection(socket, req))

    const primary = await this.listenOnAddress('127.0.0.1', 0)
    this.listeners.push(primary)
    const addr = primary.server.address() as AddressInfo | null
    if (!addr || typeof addr.port !== 'number') {
      throw new Error('Could not bind local keyboard port')
    }
    this.port = addr.port
    this.serverRunning = true

    const initialIfaces = await this.discoverInterfacesFn(this.port, this.token ?? '')
    this.interfaces = initialIfaces
    for (const iface of initialIfaces) {
      if (iface.address === '127.0.0.1') continue
      try {
        const bound = await this.listenOnAddress(iface.address, this.port)
        this.listeners.push(bound)
      } catch (err) {
        this.onLogFn(`[phone-input] Could not bind ${iface.address}:${this.port}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private async reconcileInterfaceListeners(): Promise<void> {
    if (!this.serverRunning || !this.port) return
    const desired = new Set(['127.0.0.1', ...this.interfaces.map((item) => item.address)])
    const existing = new Set(this.listeners.map((item) => item.address))

    for (const address of desired) {
      if (existing.has(address)) continue
      try {
        const bound = await this.listenOnAddress(address, this.port)
        this.listeners.push(bound)
      } catch (err) {
        this.onLogFn(`[phone-input] Could not bind new interface ${address}:${this.port}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const keep: BoundHttpListener[] = []
    for (const item of this.listeners) {
      if (desired.has(item.address)) {
        keep.push(item)
      } else {
        await this.closeHttpServer(item.server)
      }
    }
    this.listeners = keep
  }

  private listenOnAddress(address: string, port: number): Promise<BoundHttpListener> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => { void this.handleHttpRequest(req, res) })
      server.on('upgrade', (req, socket, head) => { this.handleHttpUpgrade(req, socket, head) })
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve({ address, server })
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, address)
    })
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remoteIp = normalizeRemoteIp(req.socket.remoteAddress)
    if (!isAllowedLocalRemoteIp(remoteIp)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Forbidden: local network only')
      return
    }

    const securityHeaders: Record<string, string> = {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': PAGE_CSP,
    }

    let url: URL
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    } catch {
      res.writeHead(400, securityHeaders)
      res.end('Bad request')
      return
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, state: this.sessionState }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/pair') {
      await this.handlePairRequest(req, res, remoteIp, securityHeaders)
      return
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const providedToken = url.searchParams.get('token')
      if (providedToken) {
        if (!this.isTokenValid(providedToken)) {
          res.writeHead(401, { ...securityHeaders, 'content-type': 'text/html; charset=utf-8' })
          res.end(renderPhoneInputPageHtml({ error: 'This QR link expired or is invalid. Enter the current 6-digit pairing code or rescan QR.' }))
          return
        }
        res.writeHead(200, { ...securityHeaders, 'content-type': 'text/html; charset=utf-8' })
        res.end(renderPhoneInputPageHtml({ initialToken: providedToken }))
        return
      }
      res.writeHead(200, { ...securityHeaders, 'content-type': 'text/html; charset=utf-8' })
      res.end(renderPhoneInputPageHtml({}))
      return
    }

    res.writeHead(404, { ...securityHeaders, 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not found')
  }

  private async handlePairRequest(
    req: IncomingMessage,
    res: ServerResponse,
    remoteIp: string,
    securityHeaders: Record<string, string>,
  ): Promise<void> {
    const attempt = this.pairAttempts.get(remoteIp) ?? { failures: 0, lockedUntil: 0 }
    if (attempt.lockedUntil > Date.now()) {
      res.writeHead(429, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Too many invalid attempts. Wait 30 seconds and try again.' }))
      return
    }

    const body = await readBoundedBody(req, 1024)
    if (body === null) {
      res.writeHead(413, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Request too large' }))
      return
    }

    let code = ''
    try {
      const parsed = JSON.parse(body) as { code?: unknown }
      if (typeof parsed.code === 'string') code = parsed.code.trim()
    } catch {
      res.writeHead(400, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Invalid JSON payload' }))
      return
    }

    if (!this.isCodeValid(code)) {
      attempt.failures += 1
      if (attempt.failures >= 8) {
        attempt.lockedUntil = Date.now() + 30_000
        attempt.failures = 0
      }
      this.pairAttempts.set(remoteIp, attempt)
      res.writeHead(401, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Invalid or expired pairing code.' }))
      return
    }

    this.pairAttempts.delete(remoteIp)
    res.writeHead(200, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ token: this.token, expiresAt: this.tokenExpiresAt }))
  }

  private handleHttpUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const remoteIp = normalizeRemoteIp(req.socket.remoteAddress)
    if (!this.wss || !this.serverRunning || !isAllowedLocalRemoteIp(remoteIp)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    let url: URL
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    if (url.pathname !== '/ws' || !this.isTokenValid(url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss?.emit('connection', ws, req)
    })
  }

  private handleWsConnection(socket: WebSocket, req: IncomingMessage): void {
    if (!this.serverRunning) {
      socket.close(4001, 'Server stopped')
      return
    }

    if (this.activeSocket && this.activeSocket.readyState <= 1) {
      socket.close(4008, 'Another phone keyboard is already connected')
      return
    }

    const remoteAddress = normalizeRemoteIp(req.socket.remoteAddress)
    const clientId = randomBytes(8).toString('hex')
    const transport = classifyRemoteTransport(remoteAddress, this.interfaces)
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 180) : 'Android Browser'

    this.activeSocket = socket
    this.activeClientId = clientId
    this.client = {
      id: clientId,
      remoteAddress,
      transport,
      userAgent,
      connectedAt: Date.now(),
      charsSent: 0,
      keysSent: 0,
    }
    this.sessionState = 'connected'
    this.emitSnapshot()

    socket.on('message', (raw) => {
      if (this.activeSocket !== socket) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>
      } catch {
        return
      }
      const type = msg.type
      if (type === 'client-hello') {
        if (typeof msg.userAgent === 'string' && this.client) {
          this.client.userAgent = msg.userAgent.slice(0, 180)
        }
        this.emitSnapshot()
        return
      }
      if (type === 'ping' && typeof msg.t === 'number') {
        this.sendWs(socket, { type: 'pong', t: msg.t })
        return
      }
      if (type === 'text') {
        void this.handleText(socket, msg)
        return
      }
      if (type === 'key') {
        void this.handleKey(socket, msg)
        return
      }
      if (type === 'client-disconnect') {
        socket.close(1000, 'Client disconnected')
      }
    })

    socket.on('close', () => {
      if (this.activeSocket !== socket) return
      this.activeSocket = null
      this.activeClientId = null
      this.client = null
      if (this.serverRunning) this.sessionState = 'waiting'
      this.emitSnapshot()
    })
  }

  private async handleText(socket: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const id = typeof msg.id === 'number' ? msg.id : 0
    const text = typeof msg.text === 'string' ? msg.text : ''
    if (!text || text.length > PHONE_INPUT_MAX_TEXT_CHARS) {
      this.sendWs(socket, { type: 'ack', id, ok: false, error: `Text must be 1–${PHONE_INPUT_MAX_TEXT_CHARS} characters.` })
      return
    }
    await this.enqueueInjection(socket, id, async () => {
      if (!this.injectFn) throw new Error('Keyboard injection unavailable: the nd-core sidecar is not running.')
      await this.injectFn.typeText(text)
      this.injectedChars += text.length
      if (this.client) this.client.charsSent += text.length
      this.sendWs(socket, { type: 'ack', id, ok: true, chars: text.length })
      this.emitSnapshot()
    })
  }

  private async handleKey(socket: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const id = typeof msg.id === 'number' ? msg.id : 0
    const key = msg.key
    if (!isPhoneInputKey(key)) {
      this.sendWs(socket, { type: 'ack', id, ok: false, error: 'Unknown key.' })
      return
    }
    await this.enqueueInjection(socket, id, async () => {
      if (!this.injectFn) throw new Error('Keyboard injection unavailable: the nd-core sidecar is not running.')
      await this.injectFn.sendKey(key)
      this.injectedKeys += 1
      if (this.client) this.client.keysSent += 1
      this.sendWs(socket, { type: 'ack', id, ok: true })
      this.emitSnapshot()
    })
  }

  /** One injection at a time: overlapping SendInput batches would interleave keys. */
  private enqueueInjection(socket: WebSocket, id: number, job: () => Promise<void>): Promise<void> {
    const run = this.injectQueue.then(job, job)
    this.injectQueue = run.then(
      () => undefined,
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.lastError = message
        this.sendWs(socket, { type: 'ack', id, ok: false, error: message })
        this.emitSnapshot()
      },
    )
    return this.injectQueue
  }

  private sendWs(socket: WebSocket, payload: Record<string, unknown>): void {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(payload))
    }
  }

  private async stopInternal(reason: string | undefined, isError: boolean): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }

    if (this.activeSocket) {
      this.sendWs(this.activeSocket, { type: 'server-stop', reason: reason || 'Phone Keyboard stopped by desktop.' })
      try {
        this.activeSocket.close(1000, 'Server stopped')
      } catch {
        // Ignore close errors.
      }
      this.activeSocket = null
    }
    this.activeClientId = null
    this.client = null

    if (this.wss) {
      try {
        this.wss.close()
      } catch {
        // Ignore close errors.
      }
      this.wss = null
    }

    const toClose = [...this.listeners]
    this.listeners = []
    await Promise.all(toClose.map((item) => this.closeHttpServer(item.server)))

    this.serverRunning = false
    this.port = null
    this.token = null
    this.pairingCode = null
    this.tokenExpiresAt = null
    this.lastError = isError && reason ? reason : null
    this.sessionState = isError ? 'error' : 'stopped'
    this.emitSnapshot()
  }

  private closeHttpServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
      try {
        server.closeAllConnections?.()
        server.close(() => resolve())
      } catch {
        resolve()
      }
    })
  }

  private emitSnapshot(): void {
    this.onSnapshotCb?.(this.currentSnapshot())
  }
}

function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      total += chunk.length
      if (total > maxBytes) {
        done = true
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!done) {
        done = true
        resolve(Buffer.concat(chunks).toString('utf8'))
      }
    })
    req.on('error', () => {
      if (!done) {
        done = true
        resolve(null)
      }
    })
  })
}