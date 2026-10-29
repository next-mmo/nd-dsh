import { BrowserWindow, WebContentsView, dialog, session, shell, type Session } from 'electron'
import { parseNineRouterBaseUrl } from './nine-router-connector.js'

/**
 * Dedicated visible Chromium view for 9Router administration.
 * No ND preload is installed. It cannot reach ND's ordinary browser cookies,
 * extensions, file system, Node integration, privileged IPC or other local URLs.
 */
export class NineRouterDashboard {
  private view: WebContentsView | undefined
  private origin: string | undefined
  private profile: Session | undefined
  private downloadListener: ((event: Electron.Event, item: Electron.DownloadItem, contents: Electron.WebContents) => void) | undefined

  constructor(private readonly window: BrowserWindow) {}

  async open(baseUrl: string): Promise<void> {
    const base = parseNineRouterBaseUrl(baseUrl)
    const target = new URL(base.toString())
    target.pathname = '/dashboard'
    await probeDashboard(target)
    this.close()
    const profile = session.fromPartition('persist:nd-router-nine-admin')
    profile.setPermissionRequestHandler((_wc, _permission, respond) => respond(false))
    profile.setPermissionCheckHandler(() => false)
    // All network activity in this dedicated admin profile must stay on the
    // selected gateway origin. Open external OAuth through an explicit prompt
    // rather than allowing page scripts to contact other local services.
    const allowedNetworkOrigin = target.origin
    profile.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      try {
        const request = new URL(details.url)
        if (request.origin === allowedNetworkOrigin
          || request.protocol === 'data:' || request.protocol === 'blob:') {
          callback({ cancel: false })
        } else callback({ cancel: true })
      } catch { callback({ cancel: true }) }
    })
    const view = new WebContentsView({
      webPreferences: {
        session: profile,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    })
    const allowedOrigin = target.origin
    view.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url)
        if (target.protocol === 'https:' && target.hostname !== 'localhost' && target.hostname !== '127.0.0.1') {
          // Never auto-open a link from the third-party dashboard. OAuth links
          // may require a system browser, so make the user approve the exact host.
          void dialog.showMessageBox(this.window, {
            type: 'question',
            buttons: ['Cancel', 'Open in system browser'],
            defaultId: 0,
            cancelId: 0,
            title: '9Router external authentication',
            message: '9Router wants to open an external sign-in page.',
            detail: target.origin + '\nOnly continue if you trust this sign-in provider.',
          }).then(result => {
            if (result.response === 1) void shell.openExternal(url)
          }).catch(() => undefined)
        }
      } catch { /* refuse malformed URLs */ }
      return { action: 'deny' }
    })
    view.webContents.on('will-navigate', (event, url) => {
      try {
        const next = new URL(url)
        if (next.origin !== allowedOrigin || next.pathname.startsWith('/api/')) event.preventDefault()
      } catch { event.preventDefault() }
    })
    view.webContents.on('will-redirect', (event, url) => {
      try {
        if (new URL(url).origin !== allowedOrigin) event.preventDefault()
      } catch { event.preventDefault() }
    })
    this.profile = profile
    this.downloadListener = (_event, item, source) => {
      if (source === view.webContents) item.cancel()
    }
    profile.on('will-download', this.downloadListener)
    this.window.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    view.setVisible(false)
    this.view = view
    this.origin = allowedOrigin
    try { await view.webContents.loadURL(target.toString()) }
    catch (error) { this.close(); throw dashboardError(target, error) }
  }

  bounds(value: { x: number; y: number; width: number; height: number }): void {
    const view = this.view
    if (!view) return
    const [x, y, width, height] = [value.x, value.y, value.width, value.height]
    if (![x, y, width, height].every(Number.isFinite)) throw new Error('Invalid dashboard bounds')
    const content = this.window.getContentBounds()
    const left = Math.max(0, Math.floor(x))
    const top = Math.max(0, Math.floor(y))
    const w = Math.max(0, Math.min(Math.floor(width), content.width - left))
    const h = Math.max(0, Math.min(Math.floor(height), content.height - top))
    view.setBounds({ x: left, y: top, width: w, height: h })
    view.setVisible(w > 0 && h > 0 && !this.window.isMinimized())
  }

  close(): void {
    const view = this.view
    if (this.profile && this.downloadListener) this.profile.removeListener('will-download', this.downloadListener)
    this.profile?.webRequest.onBeforeRequest(null)
    this.profile = undefined
    this.downloadListener = undefined
    this.view = undefined
    this.origin = undefined
    if (!view) return
    if (!this.window.isDestroyed()) {
      try { this.window.contentView.removeChildView(view) } catch { /* detached */ }
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  get dashboardOrigin(): string | undefined { return this.origin }
}

const DASHBOARD_PROBE_TIMEOUT_MS = 2_500

/** Fail before creating a view when nothing is listening on the gateway port. */
async function probeDashboard(target: URL): Promise<void> {
  try {
    await fetch(target.toString(), {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(DASHBOARD_PROBE_TIMEOUT_MS),
    })
  } catch (error) {
    throw dashboardError(target, error)
  }
}

function dashboardError(target: URL, error: unknown): Error {
  const code = errorCode(error)
  if (code === 'ERR_CONNECTION_REFUSED' || code === 'ECONNREFUSED') {
    return new Error(`9Router is not reachable at ${target.origin}. Start your local 9Router and check the gateway URL.`)
  }
  if (code === 'ERR_CONNECTION_TIMED_OUT' || code === 'ERR_TIMED_OUT' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new Error(`9Router did not respond at ${target.origin}. Check that it is running and the gateway URL is correct.`)
  }
  return new Error(`9Router dashboard could not load at ${target.origin}${code ? ` (${code})` : ''}. Check the gateway URL and that 9Router is running.`)
}

function errorCode(error: unknown): string | undefined {
  const record = error as { code?: unknown; errno?: unknown; cause?: { code?: unknown } } | undefined
  if (record && typeof record.code === 'string') return record.code
  if (record && typeof record.errno === 'string') return record.errno
  if (record?.cause && typeof record.cause.code === 'string') return record.cause.code
  return undefined
}
