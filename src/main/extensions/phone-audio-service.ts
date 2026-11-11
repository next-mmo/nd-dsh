import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  PHONE_AUDIO_TOKEN_TTL_MS,
  type PhoneAudioCaptureInfo,
  type PhoneAudioCaptureMode,
  type PhoneAudioClientInfo,
  type PhoneAudioCommand,
  type PhoneAudioInputDevice,
  type PhoneAudioInterfaceInfo,
  type PhoneAudioOptions,
  type PhoneAudioOutputDevice,
  type PhoneAudioRendererReport,
  type PhoneAudioSignalFromRenderer,
  type PhoneAudioSignalToRenderer,
  type PhoneAudioSnapshot,
  type PhoneAudioStats,
  type PhoneAudioStreamState,
  type PhoneAudioSystemVolume,
} from '../../shared/phone-audio.js'
import {
  classifyRemoteTransport,
  discoverPhoneAudioInterfaces,
  isAllowedLocalRemoteIp,
  normalizeRemoteIp,
} from './phone-audio-network.js'
import { renderPairingQrSvg } from './phone-audio-qr.js'
import { renderPhoneAudioReceiverHtml } from './phone-audio-receiver.js'
import { readWindowsOutputEndpoints } from './phone-audio-devices.js'

const FIREWALL_HINT =
  'If Android cannot open the URL over Wi-Fi, allow ND-DSH on Private networks in Windows Defender Firewall, or switch Android to USB tethering.'

const RECEIVER_CSP = [
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

export interface PhoneAudioServiceOptions {
  readSystemVolume?: () => Promise<PhoneAudioSystemVolume>
  readOutputDevices?: () => Promise<PhoneAudioOutputDevice[]>
  renderQrSvg?: (url: string) => Promise<string>
  discoverInterfaces?: (port: number, token: string) => Promise<PhoneAudioInterfaceInfo[]>
  onSnapshot?: (snapshot: PhoneAudioSnapshot) => void
  onCommand?: (command: PhoneAudioCommand) => void
  onSignalToRenderer?: (signal: PhoneAudioSignalToRenderer) => void
  onLog?: (line: string) => void
  /** Skip renderer handshake in headless HTTP/WS integration tests. */
  headless?: boolean
  /** Override token TTL for tests. */
  tokenTtlMs?: number
  /** Disable periodic refresh timer for deterministic tests. */
  disableRefreshTimer?: boolean
}

export class PhoneAudioService {
  private readonly readSystemVolumeFn: () => Promise<PhoneAudioSystemVolume>
  private readonly readOutputDevicesFn: () => Promise<PhoneAudioOutputDevice[]>
  private readonly renderQrSvgFn: (url: string) => Promise<string>
  private readonly discoverInterfacesFn: (port: number, token: string) => Promise<PhoneAudioInterfaceInfo[]>
  private readonly onSnapshotCb: ((snapshot: PhoneAudioSnapshot) => void) | undefined
  private readonly onCommandCb: ((command: PhoneAudioCommand) => void) | undefined
  private readonly onSignalToRendererCb: ((signal: PhoneAudioSignalToRenderer) => void) | undefined
  private readonly onLogFn: (line: string) => void
  private readonly headless: boolean
  private readonly tokenTtlMs: number
  private readonly disableRefreshTimer: boolean

  private streamState: PhoneAudioStreamState = 'stopped'
  private serverRunning = false
  private port: number | null = null
  private sessionId: string | null = null
  private token: string | null = null
  private pairingCode: string | null = null
  private tokenExpiresAt: number | null = null
  private interfaces: PhoneAudioInterfaceInfo[] = []
  private options: PhoneAudioOptions = {
    captureMode: 'loopback',
    muteLocalPlayback: false,
  }
  private capture: PhoneAudioCaptureInfo = {
    active: false,
    mode: 'loopback',
    loopbackSupported: process.platform === 'win32',
    muteLocalPlayback: false,
  }
  private audioLevel = 0
  private rendererOutputDevices: PhoneAudioOutputDevice[] = []
  private systemOutputDevices: PhoneAudioOutputDevice[] = []
  private inputDevices: PhoneAudioInputDevice[] = []
  private systemVolume: PhoneAudioSystemVolume = { available: false, reason: 'Not checked yet' }
  private client: PhoneAudioClientInfo | null = null
  private stats: PhoneAudioStats = {}
  private lastError: string | null = null

  private listeners: BoundHttpListener[] = []
  private wss: WebSocketServer | null = null
  private activeSocket: WebSocket | null = null
  private activeClientId: string | null = null
  private pairAttempts = new Map<string, PairAttemptRecord>()
  private refreshTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(opts: PhoneAudioServiceOptions = {}) {
    this.readSystemVolumeFn = opts.readSystemVolume ?? (async () => ({ available: false, reason: 'Unavailable' }))
    this.readOutputDevicesFn = opts.readOutputDevices ?? (opts.headless ? async () => [] : readWindowsOutputEndpoints)
    this.renderQrSvgFn = opts.renderQrSvg ?? renderPairingQrSvg
    this.discoverInterfacesFn =
      opts.discoverInterfaces ??
      ((port, token) => discoverPhoneAudioInterfaces(port, token, this.renderQrSvgFn))
    this.onSnapshotCb = opts.onSnapshot
    this.onCommandCb = opts.onCommand
    this.onSignalToRendererCb = opts.onSignalToRenderer
    this.onLogFn = opts.onLog ?? (() => undefined)
    this.headless = opts.headless === true
    this.tokenTtlMs = opts.tokenTtlMs ?? PHONE_AUDIO_TOKEN_TTL_MS
    this.disableRefreshTimer = opts.disableRefreshTimer === true
  }

  isCaptureArmed(): boolean {
    return !this.disposed && this.serverRunning && this.sessionId !== null
  }

  requestedLoopbackAudioMode(): 'loopback' | 'loopbackWithMute' {
    return this.options.muteLocalPlayback ? 'loopbackWithMute' : 'loopback'
  }

  async snapshot(): Promise<PhoneAudioSnapshot> {
    await this.refreshSystemAndInterfaces()
    return this.currentSnapshot()
  }

  currentSnapshot(): PhoneAudioSnapshot {
    const selected = this.resolveSelectedInterface()
    return {
      streamState: this.streamState,
      serverRunning: this.serverRunning,
      port: this.port,
      pairingCode: this.pairingCode,
      tokenExpiresAt: this.tokenExpiresAt,
      selectedInterfaceId: selected?.id ?? null,
      selectedUrl: selected?.url ?? null,
      interfaces: this.interfaces,
      options: { ...this.options },
      capture: { ...this.capture },
      audioLevel: this.audioLevel,
      outputDevices: this.mergedOutputDevices(),
      inputDevices: [...this.inputDevices],
      systemVolume: { ...this.systemVolume },
      client: this.client ? { ...this.client } : null,
      stats: { ...this.stats },
      lastError: this.lastError,
      firewallHint: FIREWALL_HINT,
    }
  }

  async start(partialOptions?: Partial<PhoneAudioOptions>): Promise<PhoneAudioSnapshot> {
    if (this.disposed) throw new Error('Phone Audio service is disposed')
    if (partialOptions) this.applyOptions(partialOptions)

    if (this.serverRunning) {
      await this.refreshSystemAndInterfaces()
      return this.currentSnapshot()
    }

    this.lastError = null
    this.streamState = 'starting'
    this.sessionId = randomBytes(12).toString('hex')
    this.issueFreshCredentials()
    this.emitSnapshot()

    try {
      await this.startNetworkServer()
      await this.refreshSystemAndInterfaces()
      if (!this.headless) {
        this.onCommandCb?.({
          kind: 'start',
          sessionId: this.sessionId,
          captureMode: this.options.captureMode,
          muteLocalPlayback: this.options.muteLocalPlayback,
          ...(this.options.inputDeviceId ? { inputDeviceId: this.options.inputDeviceId } : {}),
        })
      } else {
        this.capture = {
          ...this.capture,
          active: true,
          mode: this.options.captureMode,
          muteLocalPlayback: this.options.muteLocalPlayback,
        }
        this.streamState = 'waiting'
      }
      if (!this.disableRefreshTimer) {
        this.refreshTimer = setInterval(() => {
          void this.tickRefresh()
        }, 4_000)
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

  async stop(reason?: string): Promise<PhoneAudioSnapshot> {
    await this.stopInternal(reason, false)
    return this.currentSnapshot()
  }

  async disconnectClient(): Promise<PhoneAudioSnapshot> {
    if (this.activeSocket) {
      this.sendWs(this.activeSocket, { type: 'server-stop', reason: 'Disconnected by desktop.' })
      try {
        this.activeSocket.close(4003, 'Disconnected by desktop')
      } catch {
        // Ignore close errors.
      }
      this.activeSocket = null
    }
    if (this.activeClientId) {
      const id = this.activeClientId
      this.activeClientId = null
      this.onCommandCb?.({ kind: 'client-disconnected', clientId: id })
    }
    this.client = null
    this.stats = {}
    if (this.serverRunning) {
      this.streamState = this.capture.active ? 'waiting' : 'starting'
    }
    this.emitSnapshot()
    return this.currentSnapshot()
  }

  async rotateToken(): Promise<PhoneAudioSnapshot> {
    if (!this.serverRunning) {
      return this.currentSnapshot()
    }
    await this.disconnectClient()
    this.issueFreshCredentials()
    await this.refreshSystemAndInterfaces()
    this.emitSnapshot()
    return this.currentSnapshot()
  }

  async setOptions(partial: Partial<PhoneAudioOptions>): Promise<PhoneAudioSnapshot> {
    const captureRelevantChanged =
      (partial.captureMode !== undefined && partial.captureMode !== this.options.captureMode) ||
      (partial.muteLocalPlayback !== undefined && partial.muteLocalPlayback !== this.options.muteLocalPlayback) ||
      (partial.inputDeviceId !== undefined && partial.inputDeviceId !== this.options.inputDeviceId)

    this.applyOptions(partial)
    if (this.serverRunning && captureRelevantChanged && !this.headless && this.sessionId) {
      this.onCommandCb?.({ kind: 'stop', reason: 'Capture settings updated' })
      this.sessionId = randomBytes(12).toString('hex')
      this.onCommandCb?.({
        kind: 'start',
        sessionId: this.sessionId,
        captureMode: this.options.captureMode,
        muteLocalPlayback: this.options.muteLocalPlayback,
        ...(this.options.inputDeviceId ? { inputDeviceId: this.options.inputDeviceId } : {}),
      })
    }
    await this.refreshSystemAndInterfaces()
    this.emitSnapshot()
    return this.currentSnapshot()
  }

  handleRendererSignal(signal: PhoneAudioSignalFromRenderer): void {
    if (!this.serverRunning) return
    if (signal.kind === 'peer-state') {
      if (this.activeClientId && signal.clientId !== this.activeClientId) return
      if (signal.state === 'error') {
        this.lastError = signal.error ?? 'WebRTC connection failed'
        this.streamState = 'error'
      } else {
        this.streamState = signal.state
      }
      this.emitSnapshot()
      return
    }
    if (!this.activeSocket || this.activeSocket.readyState !== 1) return
    if (this.activeClientId && signal.clientId !== this.activeClientId) return

    if (signal.kind === 'sdp-offer') {
      this.sendWs(this.activeSocket, { type: 'sdp-offer', sdp: signal.sdp })
      return
    }
    if (signal.kind === 'ice-candidate') {
      this.sendWs(this.activeSocket, { type: 'ice-candidate', candidate: signal.candidate })
    }
  }

  handleRendererReport(report: PhoneAudioRendererReport): void {
    if (report.outputDevices) {
      this.rendererOutputDevices = report.outputDevices
    }
    if (report.inputDevices) {
      this.inputDevices = report.inputDevices
    }
    if (report.sessionId && this.sessionId && report.sessionId !== this.sessionId) {
      return
    }
    if (report.captureError) {
      this.capture = {
        ...this.capture,
        active: false,
        error: report.captureError,
      }
      this.lastError = report.captureError
      this.streamState = 'error'
      this.emitSnapshot()
      return
    }
    if (report.captureActive !== undefined) {
      this.capture = {
        ...this.capture,
        active: report.captureActive,
        mode: this.options.captureMode,
        muteLocalPlayback: this.options.muteLocalPlayback,
        ...(report.sampleRate !== undefined ? { sampleRate: report.sampleRate } : {}),
        ...(report.channelCount !== undefined ? { channelCount: report.channelCount } : {}),
        ...(report.trackLabel !== undefined ? { trackLabel: report.trackLabel } : {}),
        ...(report.silentWarning !== undefined ? { silentWarning: report.silentWarning } : {}),
      }
      if (report.silentWarning === '') delete this.capture.silentWarning
      if (report.captureActive) {
        delete this.capture.error
        if (this.streamState === 'starting') {
          this.streamState = this.client ? 'connecting' : 'waiting'
        }
      }
    }
    if (report.silentWarning !== undefined) {
      if (report.silentWarning) this.capture.silentWarning = report.silentWarning
      else delete this.capture.silentWarning
    }
    if (typeof report.audioLevel === 'number' && Number.isFinite(report.audioLevel)) {
      this.audioLevel = Math.max(0, Math.min(1, report.audioLevel))
    }
    if (report.stats) {
      this.stats = { ...this.stats, ...report.stats }
    }
    this.emitSnapshot()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stopInternal(undefined, false)
  }

  private applyOptions(partial: Partial<PhoneAudioOptions>): void {
    if (partial.captureMode === 'loopback' || partial.captureMode === 'device') {
      this.options.captureMode = partial.captureMode
    }
    if (typeof partial.muteLocalPlayback === 'boolean') {
      this.options.muteLocalPlayback = partial.muteLocalPlayback
    }
    if (typeof partial.inputDeviceId === 'string') {
      const cleaned = partial.inputDeviceId.trim()
      if (cleaned) this.options.inputDeviceId = cleaned
      else delete this.options.inputDeviceId
    }
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

  private resolveSelectedInterface(): PhoneAudioInterfaceInfo | undefined {
    if (this.interfaces.length === 0) return undefined
    if (this.options.preferredInterfaceId) {
      const match = this.interfaces.find((item) => item.id === this.options.preferredInterfaceId)
      if (match) return match
    }
    return this.interfaces[0]
  }

  private mergedOutputDevices(): PhoneAudioOutputDevice[] {
    const labeledRenderer = this.rendererOutputDevices.filter(
      (d) => d.label.trim().length > 0 && !/^output device /i.test(d.label.trim()),
    )
    if (labeledRenderer.length === 0 && this.systemOutputDevices.length > 0) {
      return [...this.systemOutputDevices]
    }
    const result = [...labeledRenderer]
    const seen = new Set(result.map((d) => d.label.toLowerCase()))
    for (const sys of this.systemOutputDevices) {
      if (!seen.has(sys.label.toLowerCase())) {
        result.push(sys)
        seen.add(sys.label.toLowerCase())
      }
    }
    return result.length > 0 ? result : [...this.rendererOutputDevices]
  }

  private async refreshSystemAndInterfaces(): Promise<void> {
    try {
      this.systemVolume = await this.readSystemVolumeFn()
    } catch {
      this.systemVolume = { available: false, reason: 'System audio endpoint unavailable' }
    }
    try {
      this.systemOutputDevices = await this.readOutputDevicesFn()
    } catch {
      this.systemOutputDevices = []
    }
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
      await this.stopInternal(`Pairing session expired after ${Math.round(this.tokenTtlMs / 60_000)} minutes. Start streaming again to get a new pairing code.`, true)
      return
    }
    await this.refreshSystemAndInterfaces()
    this.emitSnapshot()
  }

  private async startNetworkServer(): Promise<void> {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
    this.wss = wss
    wss.on('connection', (socket, req) => this.handleWsConnection(socket, req))

    // Bind 127.0.0.1 first to obtain a concrete ephemeral port guaranteed free on loopback,
    // then bind each discovered physical Wi-Fi / USB / Ethernet interface on that exact port.
    const primary = await this.listenOnAddress('127.0.0.1', 0)
    this.listeners.push(primary)
    const addr = primary.server.address() as AddressInfo | null
    if (!addr || typeof addr.port !== 'number') {
      throw new Error('Could not bind local audio signaling port')
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
        this.onLogFn(`[phone-audio] Could not bind ${iface.address}:${this.port}: ${err instanceof Error ? err.message : String(err)}`)
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
        this.onLogFn(`[phone-audio] Could not bind new interface ${address}:${this.port}: ${err instanceof Error ? err.message : String(err)}`)
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
      const server = createServer((req, res) => {
        void this.handleHttpRequest(req, res)
      })
      server.on('upgrade', (req, socket, head) => {
        this.handleHttpUpgrade(req, socket, head)
      })
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
      'content-security-policy': RECEIVER_CSP,
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
      res.end(JSON.stringify({ ok: true, state: this.streamState }))
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
          res.end(
            renderPhoneAudioReceiverHtml({
              error: 'This QR link expired or is invalid. Enter the current 6-digit pairing code or rescan QR.',
            }),
          )
          return
        }
        res.writeHead(200, { ...securityHeaders, 'content-type': 'text/html; charset=utf-8' })
        res.end(renderPhoneAudioReceiverHtml({ initialToken: providedToken }))
        return
      }
      res.writeHead(200, { ...securityHeaders, 'content-type': 'text/html; charset=utf-8' })
      res.end(renderPhoneAudioReceiverHtml({}))
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

    // Enforce single active Android receiver at a time.
    if (this.activeSocket && this.activeSocket.readyState <= 1) {
      socket.close(4008, 'Another Android receiver is already connected')
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
      paused: false,
      volume: 1,
    }
    this.streamState = 'connecting'
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
        this.onCommandCb?.({ kind: 'client-ready', clientId })
        this.emitSnapshot()
        return
      }
      if (type === 'ping' && typeof msg.t === 'number') {
        this.sendWs(socket, { type: 'pong', t: msg.t })
        return
      }
      if (type === 'sdp-answer' && typeof msg.sdp === 'string') {
        this.onSignalToRendererCb?.({ kind: 'sdp-answer', clientId, sdp: msg.sdp })
        return
      }
      if (type === 'ice-candidate' && msg.candidate && typeof msg.candidate === 'object') {
        const c = msg.candidate as Record<string, unknown>
        if (typeof c.candidate === 'string') {
          this.onSignalToRendererCb?.({
            kind: 'ice-candidate',
            clientId,
            candidate: {
              candidate: c.candidate,
              ...(typeof c.sdpMid === 'string' || c.sdpMid === null ? { sdpMid: c.sdpMid } : {}),
              ...(typeof c.sdpMLineIndex === 'number' || c.sdpMLineIndex === null ? { sdpMLineIndex: c.sdpMLineIndex } : {}),
            },
          })
        }
        return
      }
      if (type === 'client-telemetry' && this.client) {
        if (typeof msg.paused === 'boolean') this.client.paused = msg.paused
        if (typeof msg.volume === 'number' && Number.isFinite(msg.volume)) this.client.volume = Math.max(0, Math.min(1, msg.volume))
        if (typeof msg.audioLevel === 'number' && Number.isFinite(msg.audioLevel)) this.client.audioLevel = msg.audioLevel
        if (typeof msg.latencyMs === 'number' && Number.isFinite(msg.latencyMs)) this.client.latencyMs = msg.latencyMs
        if (typeof msg.jitterMs === 'number' && Number.isFinite(msg.jitterMs)) this.client.jitterMs = msg.jitterMs
        this.emitSnapshot()
        return
      }
      if (type === 'client-disconnect') {
        socket.close(1000, 'Client disconnected')
      }
    })

    socket.on('close', () => {
      if (this.activeSocket !== socket) return
      this.activeSocket = null
      const departedId = this.activeClientId
      this.activeClientId = null
      this.client = null
      this.stats = {}
      if (departedId) {
        this.onCommandCb?.({ kind: 'client-disconnected', clientId: departedId })
      }
      if (this.serverRunning) {
        this.streamState = this.capture.active ? 'waiting' : 'starting'
      }
      this.emitSnapshot()
    })
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
      this.sendWs(this.activeSocket, {
        type: 'server-stop',
        reason: reason || 'Streaming stopped by desktop.',
      })
      try {
        this.activeSocket.close(1000, 'Server stopped')
      } catch {
        // Ignore close errors.
      }
      this.activeSocket = null
    }
    this.activeClientId = null
    this.client = null
    this.stats = {}

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

    this.onCommandCb?.({ kind: 'stop', ...(reason ? { reason } : {}) })

    this.serverRunning = false
    this.port = null
    this.sessionId = null
    this.token = null
    this.pairingCode = null
    this.tokenExpiresAt = null
    this.audioLevel = 0
    this.capture = {
      ...this.capture,
      active: false,
    }
    delete this.capture.silentWarning
    delete this.capture.error
    this.lastError = isError && reason ? reason : null
    this.streamState = isError ? 'error' : 'stopped'
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
