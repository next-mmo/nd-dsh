import { app, clipboard, ipcMain, nativeTheme, session, WebContentsView, type BrowserWindow, type IpcMainEvent, type Rectangle } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import type { BrowserBounds } from '../../shared/contracts.js'
import { type DesignFreeformState } from '../../shared/design.js'
import { ND_PENCIL_HOST_IPC } from '../../shared/nd-pencil-host.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import { bundledResourceRoot } from '../app-paths.js'
import { backgroundProcessEnvironment } from '../core/background-process-environment.js'

const ND_PENCIL_PARTITION = 'nd-dsh-nd-pencil'
const MAX_BRIDGE_MESSAGE_BYTES = 16 * 1024 * 1024
const INIT_RETRY_MS = 500
const INIT_MAX_TRIES = 20
const SNAPSHOT_TIMEOUT_MS = 12_000
const DAEMON_HANDSHAKE_TIMEOUT_MS = 10_000
const DAEMON_EXIT_TIMEOUT_MS = 3_000
const UPSTREAM_TOP_BAR_HEIGHT = 40
const BLOCKED_ND_PENCIL_PATH_PREFIXES = ['/api/auth/', '/api/collab/', '/api/ai/', '/auth/']

interface DaemonHandshake {
  port: number
  token: string
  version: string
}

interface DaemonRuntime extends DaemonHandshake {
  child: ChildProcessWithoutNullStreams
  baseUrl: string
}

interface SnapshotResult {
  requestId: string
  docJson: string
  generation: number
  revision: number
}

interface SnapshotWaiter {
  resolve(value: SnapshotResult): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

type BridgeInbound =
  | { type: 'op-bridge/ready'; generation: number; revision: number }
  | { type: 'op-bridge/dirty-changed'; generation: number; revision: number; dirty: boolean }
  | { type: 'op-bridge/opened'; generation: number }
  | { type: 'op-bridge/snapshot-result'; requestId: string; docJson: string; generation: number; revision: number }
  | { type: 'op-bridge/snapshot-conflict'; requestId: string; serverVersion: number }
  | { type: 'op-bridge/sync-conflict'; generation: number; revision: number; serverVersion: number }
  | { type: 'op-bridge/conflict-resolved'; requestId: string }

type BridgeOutbound =
  | { type: 'op-bridge/init'; token: string }
  | { type: 'op-bridge/open-document'; json: string }
  | { type: 'op-bridge/snapshot'; purpose: 'save' | 'backup'; requestId: string }
  | { type: 'op-bridge/save-committed'; generation: number; revision: number }

/**
 * ND Pencil host.
 *
 * ND owns the product surface, active project/workspace, save lifecycle,
 * security policy and IPC. The pinned MIT OpenPencil checkout is implementation
 * provenance only: its account, collaboration and built-in AI product routes
 * are intentionally unavailable inside ND Pencil.
 */
export class NdPencilController {
  private readonly view: WebContentsView
  private binaryPath: string | undefined
  private available = false
  private visible = false
  private status: DesignFreeformState['status'] = 'unavailable'
  private dirty = false
  private documentPath: string | undefined
  private documentAbsolutePath: string | undefined
  private initialDocumentJson: string | undefined
  private sourceHash: string | undefined
  private version: string | undefined
  private error: string | undefined
  private daemon: DaemonRuntime | undefined
  private shellServer: Server | undefined
  private shellOrigin: string | undefined
  private onStateChanged?: ((state: DesignFreeformState) => void) | undefined
  private initTimer: NodeJS.Timeout | undefined
  private initTries = 0
  private requestCounter = 0
  private readonly snapshotWaiters = new Map<string, SnapshotWaiter>()
  private saveInFlight: Promise<DesignFreeformState> | undefined
  private setupInFlight: Promise<DesignFreeformState> | undefined
  private closingDaemon = false
  private readonly pageMessageHandler: (event: IpcMainEvent, payload: unknown) => void

  constructor(
    private readonly window: BrowserWindow,
    private readonly workspace: WorkspaceService,
    private readonly projectRoot: string,
    ndPencilPreload: string,
  ) {
    const ndPencilSession = session.fromPartition(ND_PENCIL_PARTITION)
    ndPencilSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ndPencilSession.setPermissionCheckHandler(() => false)
    ndPencilSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (details, callback) => callback({ cancel: !isAllowedNdPencilNetworkUrl(details.url) }),
    )

    this.view = new WebContentsView({
      webPreferences: {
        preload: ndPencilPreload,
        partition: ND_PENCIL_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    })
    this.window.contentView.addChildView(this.view)
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    this.view.setVisible(false)
    this.installViewGuards()

    this.pageMessageHandler = (event, payload) => {
      if (event.sender !== this.view.webContents || typeof payload !== 'string' || payload.length > MAX_BRIDGE_MESSAGE_BYTES) return
      this.handlePageMessage(payload)
    }
    ipcMain.on(ND_PENCIL_HOST_IPC.pageMessage, this.pageMessageHandler)
    nativeTheme.on('updated', () => {
      if (this.visible && this.status === 'ready') {
        void this.syncChildFramePreferences()
      }
    })
  }

  async initialize(): Promise<void> {
    this.binaryPath = await this.findBundledBinary()
    this.available = Boolean(this.binaryPath)
    this.status = this.available ? 'idle' : 'unavailable'
    this.error = this.available
      ? undefined
      : app.isPackaged
        ? 'ND Pencil is missing from this installation. Reinstall or repair ND to restore its bundled runtime.'
        : 'The bundled ND Pencil runtime has not been set up in this source checkout. Select Set up ND Pencil to build it.'
    this.emitState()
  }

  async reinitialize(): Promise<DesignFreeformState> {
    if (!this.available) await this.initialize()
    return this.state()
  }

  /**
   * Source checkouts do not track the platform runtime payload. Let a developer
   * set it up from the product UI without exposing Node or arbitrary commands
   * to the renderer. Packaged builds must already contain the runtime.
   */
  async setup(): Promise<DesignFreeformState> {
    if (this.available) return this.state()
    if (this.setupInFlight) return this.setupInFlight

    this.setupInFlight = this.setupRuntime().finally(() => {
      this.setupInFlight = undefined
    })
    return this.setupInFlight
  }

  private async setupRuntime(): Promise<DesignFreeformState> {
    if (app.isPackaged) {
      this.status = 'unavailable'
      this.error = 'ND Pencil is missing from this installation. Reinstall or repair ND to restore its bundled runtime.'
      this.emitState()
      return this.state()
    }

    const buildScript = join(this.projectRoot, 'scripts', 'build-nd-pencil.mjs')
    try {
      await fs.access(buildScript, fsConstants.R_OK)
    } catch {
      this.status = 'unavailable'
      this.error = 'ND Pencil setup is unavailable because this source checkout is incomplete.'
      this.emitState()
      return this.state()
    }

    this.status = 'installing'
    this.error = 'Setting up the bundled ND Pencil runtime…'
    this.emitState()
    try {
      await runSourceRuntimeSetup(process.execPath, buildScript, this.projectRoot)
      await this.initialize()
      if (!this.available) throw new Error('The runtime build completed but did not produce the bundled ND Pencil binary.')
    } catch (cause) {
      this.status = 'unavailable'
      this.error = `ND Pencil setup failed: ${errorMessage(cause)}`
      this.emitState()
    }
    return this.state()
  }

  setStateListener(listener: ((state: DesignFreeformState) => void) | undefined): void {
    this.onStateChanged = listener
    listener?.(this.state())
  }

  state(): DesignFreeformState {
    return {
      engine: 'nd-pencil',
      status: this.status,
      available: this.available,
      visible: this.visible,
      dirty: this.dirty,
      ...(this.documentPath ? { documentPath: this.documentPath, documentName: basename(this.documentPath) } : {}),
      ...(this.version ? { version: this.version } : {}),
      ...(this.error ? { error: this.error } : {}),
    }
  }

  async setBounds(bounds: BrowserBounds): Promise<void> {
    const safe: Rectangle = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    }
    this.view.setBounds(safe)
  }

  async setVisible(visible: boolean): Promise<DesignFreeformState> {
    this.visible = Boolean(visible)
    this.view.setVisible(this.visible)
    this.emitState()
    return this.state()
  }

  setBackgroundColor(color: string): void {
    this.view.setBackgroundColor(color)
  }

  async open(relativePath: string): Promise<DesignFreeformState> {
    this.assertAvailable()
    const document = await this.resolveDocument(relativePath, true)
    const json = await fs.readFile(document.absolute, 'utf8')
    try {
      JSON.parse(json)
    } catch {
      throw new Error(`${document.relative} is not a valid ND Pencil .op document`)
    }
    await this.startDocument(document.relative, document.absolute, json, false)
    return this.state()
  }

  async create(relativePath: string): Promise<DesignFreeformState> {
    this.assertAvailable()
    const document = await this.resolveDocument(relativePath, false)
    await fs.mkdir(dirname(document.absolute), { recursive: true })
    try {
      await fs.lstat(document.absolute)
      throw new Error(`Freeform document already exists: ${document.relative}`)
    } catch (cause) {
      if (!isMissingFileError(cause)) throw cause
    }
    await this.startDocument(document.relative, document.absolute, undefined, true)
    return this.state()
  }

  async save(): Promise<DesignFreeformState> {
    if (this.saveInFlight) return this.saveInFlight
    this.saveInFlight = this.performSave().finally(() => {
      this.saveInFlight = undefined
    })
    return this.saveInFlight
  }

  async close(): Promise<DesignFreeformState> {
    if (this.dirty) {
      if (this.status !== 'ready') {
        throw new Error('Freeform has unsaved changes but the ND Pencil editor is not ready to snapshot them. Keep ND open and recover the canvas before closing.')
      }
      await this.save()
    }
    await this.closeRuntime()
    return this.state()
  }

  async handleWorkspaceChanged(nextRoot: string): Promise<void> {
    if (!this.documentAbsolutePath) return
    if (isInside(nextRoot, this.documentAbsolutePath)) return
    await this.setVisible(false)
    try {
      await this.close()
    } catch (cause) {
      this.status = 'error'
      this.error = `ND Pencil could not close the previous project safely: ${errorMessage(cause)}`
      this.emitState()
    }
  }

  async destroy(): Promise<void> {
    ipcMain.removeListener(ND_PENCIL_HOST_IPC.pageMessage, this.pageMessageHandler)
    this.stopInitLoop()
    this.rejectSnapshots(new Error('ND Pencil host was closed'))
    await this.closeRuntime(true).catch(() => undefined)
    await this.closeShellServer().catch(() => undefined)
    if (!this.window.isDestroyed()) {
      try { this.window.contentView.removeChildView(this.view) } catch { /* window teardown */ }
    }
    // Electron may clear a WebContentsView's webContents while the parent window
    // is already tearing down, even though the controller still holds the view.
    const contents = this.view.webContents
    if (contents && !contents.isDestroyed()) contents.close()
  }

  private async startDocument(relativePath: string, absolutePath: string, json: string | undefined, creating: boolean): Promise<void> {
    if (this.documentAbsolutePath) await this.close()
    this.assertAvailable()
    const binary = this.binaryPath
    if (!binary) throw new Error('Bundled ND Pencil runtime is unavailable')

    const shellOrigin = await this.ensureShellServer()
    this.documentPath = relativePath
    this.documentAbsolutePath = absolutePath
    this.initialDocumentJson = json
    this.sourceHash = json === undefined ? undefined : hashText(json)
    this.dirty = creating
    this.status = 'starting'
    this.error = undefined
    this.version = undefined
    this.emitState()

    try {
      const daemon = await spawnManagedDaemon(binary, shellOrigin, creating ? undefined : absolutePath)
      this.daemon = daemon
      this.version = daemon.version
      this.wireDaemonExit(daemon)
      const frameUrl = `${daemon.baseUrl}/?embed=vscode&nd=1`
      const shellUrl = `${shellOrigin}/?frame=${encodeURIComponent(frameUrl)}`
      await this.view.webContents.loadURL(shellUrl)
      this.startInitLoop()
    } catch (cause) {
      await this.disposeDaemon().catch(() => undefined)
      this.documentPath = undefined
      this.documentAbsolutePath = undefined
      this.initialDocumentJson = undefined
      this.sourceHash = undefined
      this.dirty = false
      this.version = undefined
      this.status = 'error'
      this.error = `ND Pencil failed to start: ${errorMessage(cause)}`
      this.emitState()
      throw cause
    }
  }

  private async performSave(): Promise<DesignFreeformState> {
    if (this.status !== 'ready' || !this.documentAbsolutePath) throw new Error('ND Pencil document is not ready to save')
    await this.assertSourceUnchanged()
    const snapshot = await this.requestSnapshot('save')
    await atomicWrite(this.documentAbsolutePath, snapshot.docJson)
    this.sourceHash = hashText(snapshot.docJson)
    this.initialDocumentJson = snapshot.docJson
    this.dirty = false
    this.postToPage({
      type: 'op-bridge/save-committed',
      generation: snapshot.generation,
      revision: snapshot.revision,
    })
    this.emitState()
    return this.state()
  }

  private async assertSourceUnchanged(): Promise<void> {
    const path = this.documentAbsolutePath
    if (!path) return
    try {
      const current = await fs.readFile(path, 'utf8')
      if (this.sourceHash === undefined) {
        throw new Error(`ND Pencil save conflict: ${this.documentPath ?? path} was created outside ND while this canvas was open`)
      }
      if (hashText(current) !== this.sourceHash) {
        throw new Error(`ND Pencil save conflict: ${this.documentPath ?? path} changed on disk. Reopen it before saving.`)
      }
    } catch (cause) {
      if (isMissingFileError(cause) && this.sourceHash === undefined) return
      throw cause
    }
  }

  private requestSnapshot(purpose: 'save' | 'backup'): Promise<SnapshotResult> {
    const requestId = `nd-${Date.now()}-${++this.requestCounter}`
    return new Promise<SnapshotResult>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.snapshotWaiters.delete(requestId)
        reject(new Error('ND Pencil snapshot timed out'))
      }, SNAPSHOT_TIMEOUT_MS)
      this.snapshotWaiters.set(requestId, { resolve: resolvePromise, reject, timer })
      this.postToPage({ type: 'op-bridge/snapshot', purpose, requestId })
    })
  }

  private handlePageMessage(raw: string): void {
    if (raw === '{"type":"nd-shell/frame-loaded"}') {
      void this.syncChildFramePreferences()
      this.startInitLoop()
      return
    }

    const shell = parseShellMessage(raw)
    if (shell?.type === 'save') {
      void this.save().catch((cause) => {
        this.status = 'error'
        this.error = errorMessage(cause)
        this.emitState()
      })
      return
    }
    if (shell?.type === 'copy') {
      clipboard.writeText(shell.text)
      return
    }
    if (shell) return

    const message = parseBridgeInbound(raw)
    if (!message) return
    switch (message.type) {
      case 'op-bridge/ready':
        this.handleReady()
        return
      case 'op-bridge/opened':
        this.status = 'ready'
        this.dirty = false
        this.error = undefined
        this.emitState()
        return
      case 'op-bridge/dirty-changed':
        this.dirty = message.dirty
        if (this.status !== 'ready') this.status = 'ready'
        this.emitState()
        return
      case 'op-bridge/snapshot-result': {
        const waiter = this.snapshotWaiters.get(message.requestId)
        if (!waiter) return
        this.snapshotWaiters.delete(message.requestId)
        clearTimeout(waiter.timer)
        waiter.resolve(message)
        return
      }
      case 'op-bridge/snapshot-conflict': {
        const waiter = this.snapshotWaiters.get(message.requestId)
        if (!waiter) return
        this.snapshotWaiters.delete(message.requestId)
        clearTimeout(waiter.timer)
        waiter.reject(new Error(`ND Pencil snapshot conflict at server version ${message.serverVersion}`))
        return
      }
      case 'op-bridge/sync-conflict':
        this.status = 'error'
        this.error = `ND Pencil sync conflict at server version ${message.serverVersion}. Reopen the design before saving.`
        this.emitState()
        return
      case 'op-bridge/conflict-resolved':
        return
    }
  }

  private handleReady(): void {
    this.stopInitLoop()
    if (!this.daemon) return
    if (this.initialDocumentJson !== undefined) {
      this.postToPage({ type: 'op-bridge/open-document', json: this.initialDocumentJson })
      return
    }
    this.status = 'ready'
    this.error = undefined
    this.emitState()
    // A new design starts from the upstream engine's canonical starter state.
    // Snapshot it so the workspace receives a real .op document rather than an
    // ND-made approximation of the schema.
    void this.save().catch((cause) => {
      this.status = 'error'
      this.error = `Could not create Freeform document: ${errorMessage(cause)}`
      this.emitState()
    })
  }

  private startInitLoop(): void {
    if (!this.daemon || this.status !== 'starting') return
    this.stopInitLoop()
    this.initTries = 0
    const tick = (): void => {
      if (!this.daemon || this.status !== 'starting') return
      this.postToPage({ type: 'op-bridge/init', token: this.daemon.token })
      this.initTries += 1
      if (this.initTries >= INIT_MAX_TRIES) {
        this.status = 'error'
        this.error = 'ND Pencil editor did not become ready'
        this.emitState()
        return
      }
      this.initTimer = setTimeout(tick, INIT_RETRY_MS)
    }
    tick()
  }

  private stopInitLoop(): void {
    if (this.initTimer) clearTimeout(this.initTimer)
    this.initTimer = undefined
  }

  private postToPage(message: BridgeOutbound): void {
    if (this.view.webContents.isDestroyed()) return
    this.view.webContents.send(ND_PENCIL_HOST_IPC.hostMessage, JSON.stringify(message))
  }

  private async closeRuntime(force = false): Promise<void> {
    if (!force && this.dirty) {
      if (this.status !== 'ready') throw new Error('Cannot close a dirty Freeform document while its editor is unavailable')
      await this.save()
    }
    this.stopInitLoop()
    this.rejectSnapshots(new Error('ND Pencil document was closed'))
    await this.disposeDaemon()
    this.documentPath = undefined
    this.documentAbsolutePath = undefined
    this.initialDocumentJson = undefined
    this.sourceHash = undefined
    this.version = undefined
    this.dirty = false
    this.error = this.available ? undefined : this.error
    this.status = this.available ? 'idle' : 'unavailable'
    this.visible = false
    this.view.setVisible(false)
    if (!this.view.webContents.isDestroyed()) await this.view.webContents.loadURL('about:blank').catch(() => undefined)
    this.emitState()
  }

  private async disposeDaemon(): Promise<void> {
    const daemon = this.daemon
    this.daemon = undefined
    if (!daemon) return
    this.closingDaemon = true
    try {
      await disposeManagedDaemon(daemon.child)
    } finally {
      this.closingDaemon = false
    }
  }

  private wireDaemonExit(daemon: DaemonRuntime): void {
    daemon.child.once('exit', (code, signal) => {
      if (this.daemon !== daemon) return
      this.daemon = undefined
      if (this.closingDaemon) return
      this.status = 'error'
      this.error = `ND Pencil runtime exited unexpectedly (${signal ?? String(code ?? 'unknown')})`
      this.emitState()
    })
  }

  private rejectSnapshots(error: Error): void {
    for (const waiter of this.snapshotWaiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.snapshotWaiters.clear()
  }

  private async ensureShellServer(): Promise<string> {
    if (this.shellServer && this.shellOrigin) return this.shellOrigin
    const server = createServer((request, response) => this.serveShell(request.url ?? '/', response))
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
      throw new Error('ND Pencil shell could not bind to loopback')
    }
    this.shellServer = server
    this.shellOrigin = `http://127.0.0.1:${address.port}`
    return this.shellOrigin
  }

  private serveShell(requestUrl: string, response: ServerResponse): void {
    let frame: string | null = null
    try {
      frame = new URL(requestUrl, 'http://127.0.0.1').searchParams.get('frame')
    } catch {
      sendShellError(response, 400, 'Invalid ND Freeform request')
      return
    }
    if (!frame || !isLoopbackHttpUrl(frame)) {
      sendShellError(response, 400, 'Invalid ND Pencil frame target')
      return
    }
    const frameOrigin = new URL(frame).origin
    const html = buildShellHtml(frame, frameOrigin)
    response.statusCode = 200
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Security-Policy', `default-src 'none'; frame-src ${frameOrigin}; script-src 'unsafe-inline'; style-src 'unsafe-inline'`)
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.end(html)
  }

  private async closeShellServer(): Promise<void> {
    const server = this.shellServer
    this.shellServer = undefined
    this.shellOrigin = undefined
    if (!server) return
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  }

  private async findBundledBinary(): Promise<string | undefined> {
    const binary = process.platform === 'win32' ? 'op-host-web-server.exe' : 'op-host-web-server'
    const candidates = [
      process.env.ND_PENCIL_BINARY?.trim(),
      join(process.resourcesPath, 'nd-pencil', 'bin', binary),
      join(process.resourcesPath, 'nd-pencil', binary),
      join(this.projectRoot, 'resources', 'nd-pencil', 'bin', binary),
      join(this.projectRoot, 'vendor', 'openpencil', 'target', 'release', binary),
      join(this.projectRoot, 'vendor', 'openpencil', 'target', 'debug', binary),
    ].filter((value): value is string => Boolean(value))

    for (const candidate of candidates) {
      try {
        await fs.access(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
        return candidate
      } catch {
        // Search only ND-bundled locations and the explicit developer override.
        // ND Pencil never probes PATH or a separately installed OpenPencil app.
      }
    }
    return undefined
  }

  private async resolveDocument(input: string, mustExist: boolean): Promise<{ relative: string; absolute: string }> {
    const workspace = this.workspace.state()
    if (workspace.binding === 'unlinked' || workspace.binding === 'missing') {
      throw new Error(workspace.warning ?? 'The active project has no usable workspace')
    }
    const value = input.trim().replaceAll('\\', '/')
    if (!value || value.length > 4_096 || isAbsolute(value)) throw new Error('Freeform path must be workspace-relative')
    if (extname(value).toLowerCase() !== '.op') throw new Error('Freeform documents must use the .op extension')
    const root = resolve(workspace.root)
    const absolute = resolve(root, value)
    if (!isInside(root, absolute)) throw new Error('Freeform path escapes the active workspace')
    await assertNoSymlinkParents(root, dirname(absolute))
    if (mustExist) {
      const stats = await fs.lstat(absolute)
      if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('Freeform document must be a regular file')
    }
    return { relative: relative(root, absolute).split(sep).join('/'), absolute }
  }

  private assertAvailable(): void {
    if (!this.available || !this.binaryPath) throw new Error(this.error ?? 'Bundled ND Pencil runtime is unavailable')
  }

  private installViewGuards(): void {
    const contents = this.view.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      if (url === 'about:blank') return
      if (!this.shellOrigin || new URL(url).origin !== this.shellOrigin) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (!this.shellOrigin || new URL(url).origin !== this.shellOrigin) event.preventDefault()
    })
    contents.on('render-process-gone', (_event, details) => {
      this.status = 'error'
      this.error = `ND Pencil renderer exited: ${details.reason}`
      this.emitState()
    })
    contents.on('did-frame-finish-load', (_event, isMainFrame) => {
      if (!isMainFrame) {
        void this.syncChildFramePreferences()
      }
    })
  }

  private async syncChildFramePreferences(): Promise<void> {
    const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    const script = childFramePreferencesScript(theme)
    const frames = this.view.webContents.mainFrame?.frames ?? []
    for (const frame of frames) {
      try {
        await frame.executeJavaScript(script)
      } catch {
        // Frame may be navigating or destroyed
      }
    }
  }

  private emitState(): void {
    this.onStateChanged?.(this.state())
  }
}

async function spawnManagedDaemon(binary: string, allowOrigin: string, filePath?: string): Promise<DaemonRuntime> {
  const args = ['--serve-web', '--managed', '--port', '0', ...(filePath ? ['--file', filePath] : []), '--allow-origin', allowOrigin]
  const child = spawn(binary, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: process.env,
  })

  try {
    const line = await readFirstLine(child, DAEMON_HANDSHAKE_TIMEOUT_MS)
    const handshake = parseHandshake(line)
    forwardRedactedLines(child.stdout, handshake.token, (message) => console.log(`[ND Pencil] ${message}`))
    forwardRedactedLines(child.stderr, handshake.token, (message) => console.warn(`[ND Pencil] ${message}`))
    return { ...handshake, child, baseUrl: `http://127.0.0.1:${handshake.port}` }
  } catch (cause) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    throw cause
  }
}

function runSourceRuntimeSetup(executable: string, buildScript: string, cwd: string): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const preload = join(bundledResourceRoot(), 'scripts', 'nd-background-process.cjs')
    const nodePolicyArgs = process.platform === 'win32' ? ['--require', preload] : []
    const child = spawn(executable, [...nodePolicyArgs, buildScript], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Electron is the current executable in development. This runs the fixed,
      // checked-in build script as Node; no renderer-provided command is used.
      env: backgroundProcessEnvironment({ ...process.env, ELECTRON_RUN_AS_NODE: '1' }, preload),
    })
    let output = ''
    const append = (chunk: string | Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-4_000)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolvePromise()
      else {
        const detail = output.trim().split(/\r?\n/).filter(Boolean).at(-1)
        reject(new Error(detail ?? `runtime build exited with code ${String(code)}`))
      }
    })
  })
}

function readFirstLine(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    let buffer = ''
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stdout.off('end', onEnd)
      child.stdout.off('error', onError)
      child.off('exit', onExit)
    }
    const finish = (error?: Error, line?: string): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else if (line !== undefined) resolvePromise(line)
      else reject(new Error('ND Pencil handshake failed'))
    }
    const onData = (chunk: string): void => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline >= 0) finish(undefined, buffer.slice(0, newline))
    }
    const onEnd = (): void => finish(new Error('ND Pencil closed stdout before handshake'))
    const onError = (error: Error): void => finish(error)
    const onExit = (): void => finish(new Error('ND Pencil exited before handshake'))
    const timer = setTimeout(() => finish(new Error('ND Pencil handshake timed out')), timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', onData)
    child.stdout.once('end', onEnd)
    child.stdout.once('error', onError)
    child.once('exit', onExit)
  })
}

function parseHandshake(line: string): DaemonHandshake {
  let value: unknown
  try { value = JSON.parse(line) } catch { throw new Error('ND Pencil handshake is not JSON') }
  if (!value || typeof value !== 'object') throw new Error('ND Pencil handshake is invalid')
  const record = value as Record<string, unknown>
  if (record.ok !== true) throw new Error('ND Pencil handshake did not report ready')
  const port = record.port
  const token = record.token
  const version = record.version
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('ND Pencil handshake port is invalid')
  if (typeof token !== 'string' || !token) throw new Error('ND Pencil handshake token is invalid')
  if (typeof version !== 'string' || !version) throw new Error('ND Pencil handshake version is invalid')
  return { port, token, version }
}

async function disposeManagedDaemon(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise()))
  child.stdin.end()
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, DAEMON_EXIT_TIMEOUT_MS)
  try { await exited } finally { clearTimeout(timer) }
}

function forwardRedactedLines(stream: NodeJS.ReadableStream, token: string, write: (message: string) => void): void {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).split(token).join('<redacted>')
      buffer = buffer.slice(index + 1)
      if (line) write(line)
      index = buffer.indexOf('\n')
    }
  })
}

function parseBridgeInbound(raw: string): BridgeInbound | null {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const type = record.type
  if (typeof type !== 'string') return null
  const u64 = (candidate: unknown): candidate is number => typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0
  switch (type) {
    case 'op-bridge/ready':
      return u64(record.generation) && u64(record.revision) ? { type, generation: record.generation, revision: record.revision } : null
    case 'op-bridge/dirty-changed':
      return u64(record.generation) && u64(record.revision) && typeof record.dirty === 'boolean' ? { type, generation: record.generation, revision: record.revision, dirty: record.dirty } : null
    case 'op-bridge/opened':
      return u64(record.generation) ? { type, generation: record.generation } : null
    case 'op-bridge/snapshot-result':
      return typeof record.requestId === 'string' && typeof record.docJson === 'string' && u64(record.generation) && u64(record.revision) ? { type, requestId: record.requestId, docJson: record.docJson, generation: record.generation, revision: record.revision } : null
    case 'op-bridge/snapshot-conflict':
      return typeof record.requestId === 'string' && u64(record.serverVersion) ? { type, requestId: record.requestId, serverVersion: record.serverVersion } : null
    case 'op-bridge/sync-conflict':
      return u64(record.generation) && u64(record.revision) && u64(record.serverVersion) ? { type, generation: record.generation, revision: record.revision, serverVersion: record.serverVersion } : null
    case 'op-bridge/conflict-resolved':
      return typeof record.requestId === 'string' ? { type, requestId: record.requestId } : null
    default:
      return null
  }
}

function parseShellMessage(raw: string): { type: 'save' } | { type: 'copy'; text: string } | { type: 'other' } | null {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.type === 'op-shell/save') return { type: 'save' }
  if (record.type === 'op-shell/copy' && typeof record.text === 'string') return { type: 'copy', text: record.text }
  if (typeof record.type === 'string' && record.type.startsWith('op-shell/')) return { type: 'other' }
  return null
}

function buildShellHtml(frameUrl: string, frameOrigin: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark light">
<style>
html,body{position:relative;margin:0;width:100%;height:100%;overflow:hidden;background:#111}
@media (prefers-color-scheme: light) {
  html,body{background:#f4f5f7}
  iframe{background:#f4f5f7}
}
iframe{position:absolute;left:0;top:-${UPSTREAM_TOP_BAR_HEIGHT}px;display:block;width:100%;height:calc(100% + ${UPSTREAM_TOP_BAR_HEIGHT}px);border:0;background:#111}
</style>
</head>
<body>
<iframe id="op-frame" src="${escapeAttribute(frameUrl)}" allow="clipboard-read; clipboard-write"></iframe>
<script>
(function(){
  var host=window.ndPencilHost;
  var frame=document.getElementById('op-frame');
  var origin=${JSON.stringify(frameOrigin)};
  if(!host||!frame)return;
  frame.addEventListener('load',function(){frame.focus();host.postMessage('{"type":"nd-shell/frame-loaded"}');});
  window.addEventListener('focus',function(){frame.focus();});
  window.addEventListener('message',function(event){if(event.source!==frame.contentWindow||event.origin!==origin||typeof event.data!=='string')return;host.postMessage(event.data);});
  host.onMessage(function(payload){if(typeof payload!=='string')return;frame.contentWindow.postMessage(payload,origin);});
}());
</script>
</body>
</html>`
}

function childFramePreferencesScript(theme: 'dark' | 'light'): string {
  return `(function() {
    document.title = 'ND Pencil';
    function brandEditor() {
      document.querySelectorAll('[role="application"][aria-label="OpenPencil editor"]').forEach(function(node) {
        node.setAttribute('aria-label', 'ND Pencil editor');
      });
    }
    brandEditor();
    new MutationObserver(brandEditor).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] });
    try {
      var key = 'openpencil-rust-web-settings::anon';
      var raw = localStorage.getItem(key);
      var data = raw ? JSON.parse(raw) : { version: 1 };
      var changed = false;
      if (data.locale !== 'en-US') {
        data.locale = 'en-US';
        changed = true;
      }
      if (changed) {
        localStorage.setItem(key, JSON.stringify(data));
      }
      if (localStorage.getItem('openpencil-rust-web-theme') !== ${JSON.stringify(theme)}) {
        localStorage.setItem('openpencil-rust-web-theme', ${JSON.stringify(theme)});
      }
    } catch (e) {}
  })();`
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function sendShellError(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'text/plain; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(message)
}

function isAllowedNdPencilNetworkUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol === 'ws:' || url.protocol === 'wss:') return false
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (!isLoopbackHost(url.hostname)) return false
    if (url.pathname === '/mcp-tokens') return false
    if (BLOCKED_ND_PENCIL_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return false
    return true
  } catch {
    return false
  }
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && isLoopbackHost(url.hostname)
  } catch {
    return false
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

async function assertNoSymlinkParents(root: string, directory: string): Promise<void> {
  const path = relative(resolve(root), resolve(directory))
  if (!path) return
  let current = resolve(root)
  for (const segment of path.split(sep)) {
    if (!segment) continue
    current = join(current, segment)
    try {
      const stats = await fs.lstat(current)
      if (stats.isSymbolicLink()) throw new Error(`Freeform path contains a symbolic link: ${current}`)
      if (!stats.isDirectory()) throw new Error(`Freeform parent is not a directory: ${current}`)
    } catch (cause) {
      if (isMissingFileError(cause)) return
      throw cause
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate))
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temp = `${path}.nd-${process.pid}-${Date.now()}.tmp`
  await fs.writeFile(temp, contents, 'utf8')
  try {
    await fs.rename(temp, path)
  } catch (cause) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw cause
  }
}

function isMissingFileError(cause: unknown): boolean {
  return Boolean(cause && typeof cause === 'object' && 'code' in cause && (cause as { code?: unknown }).code === 'ENOENT')
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
