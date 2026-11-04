import { BrowserWindow, WebContentsView, shell, type Rectangle } from 'electron'
import type { BrowserBounds, DshViewState } from '../../shared/contracts.js'

const DSH_PARTITION = 'persist:nd-dsh-ui'

/**
 * The official DeepSeek Harness UI surface: a sandboxed WebContentsView pinned
 * to the loopback gateway origin the harness runtime serves. This view is a
 * product surface, never the agent browser — the agent still drives only the
 * visible BrowserPane through the pinned agent-browser MCP.
 */
export class DshSurfaceController {
  private view: WebContentsView | undefined
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  private backgroundColor: string | undefined
  private stateValue: DshViewState
  private onStateChanged?: (state: DshViewState) => void
  private targetUrl: string | undefined
  private loadUrl: string | undefined
  private loaded = false

  constructor(private readonly window: BrowserWindow) {
    this.stateValue = { ready: false, loading: false, title: 'ND Harness', visible: false }
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view
    const view = new WebContentsView({
      webPreferences: {
        partition: DSH_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    })
    this.window.contentView.addChildView(view)
    view.setBounds(this.bounds)
    if (this.backgroundColor) view.setBackgroundColor(this.backgroundColor)
    view.setVisible(this.stateValue.visible)
    this.view = view
    this.installListeners(view)
    return view
  }

  setStateListener(listener: (state: DshViewState) => void): void {
    this.onStateChanged = listener
    listener(this.state())
  }

  state(): DshViewState {
    return { ...this.stateValue }
  }

  /** Point the surface at the runtime's loopback gateway URL (called on harness readiness). */
  setTarget(url: string): void {
    const parsed = new URL(url)
    const nextTargetUrl = parsed.origin
    const nextLoadUrl = parsed.toString()
    const targetChanged = this.targetUrl !== nextTargetUrl || this.loadUrl !== nextLoadUrl
    this.targetUrl = nextTargetUrl
    this.loadUrl = nextLoadUrl
    if (targetChanged) this.loaded = false
    this.stateValue = {
      ...this.stateValue,
      ready: true,
      url: this.targetUrl,
      ...(parsed.port ? { port: Number(parsed.port) } : {}),
    }
    this.emitState()
    if (this.stateValue.visible && targetChanged) void this.load()
  }

  async setBounds(bounds: BrowserBounds): Promise<void> {
    const safe: Rectangle = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    }
    this.bounds = safe
    this.view?.setBounds(safe)
  }

  async setVisible(visible: boolean): Promise<void> {
    this.stateValue.visible = visible
    if (visible) {
      const view = this.ensureView()
      view.setVisible(true)
      if (!this.loaded) await this.load()
    } else {
      this.view?.setVisible(false)
    }
    this.emitState()
  }

  async reload(): Promise<void> {
    if (!this.targetUrl) return
    if (!this.loaded || !this.view) {
      await this.load()
      return
    }
    this.view.webContents.reload()
  }

  setBackgroundColor(color: string): void {
    this.backgroundColor = color
    this.view?.setBackgroundColor(color)
  }

  destroy(): void {
    if (!this.view) return
    if (!this.window.isDestroyed()) {
      try {
        this.window.contentView.removeChildView(this.view)
      } catch {
        // The BrowserWindow may already be tearing down its content view.
      }
    }
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close()
    this.view = undefined
  }

  private async load(): Promise<void> {
    if (!this.loadUrl || this.loaded) return
    const view = this.ensureView()
    this.loaded = true
    try {
      // New DSH releases mint their HttpOnly browser cookie by redirecting
      // this tokenized root URL to a clean `/`. The token never enters state
      // sent to the renderer; state.url remains the loopback origin above.
      await view.webContents.loadURL(this.loadUrl)
    } catch {
      this.loaded = false
    }
  }

  private installListeners(view: WebContentsView): void {
    const contents = view.webContents
    contents.setWindowOpenHandler(({ url }) => {
      void this.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!this.isAllowed(url)) {
        event.preventDefault()
        void this.openExternal(url)
      }
    })
    contents.on('did-start-loading', () => {
      this.stateValue.loading = true
      this.emitState()
    })
    contents.on('did-stop-loading', () => {
      this.stateValue.loading = false
      this.emitState()
    })
    contents.on('page-title-updated', (event, title) => {
      event.preventDefault()
      this.stateValue.title = title || 'ND Harness'
      this.emitState()
    })
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      this.stateValue.loading = false
      this.stateValue.title = `Load failed: ${errorDescription}`
      this.emitState()
    })
    contents.on('render-process-gone', (_event, details) => {
      this.stateValue.loading = false
      this.loaded = false
      this.stateValue.title = `UI renderer exited: ${details.reason}`
      this.emitState()
    })
  }

  /** Same-origin navigation stays in the view; other http(s) targets open in the system browser. */
  private isAllowed(url: string): boolean {
    if (!this.targetUrl) return false
    try {
      return new URL(url).origin === this.targetUrl
    } catch {
      return false
    }
  }

  private async openExternal(url: string): Promise<void> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    await shell.openExternal(parsed.toString())
  }

  private emitState(): void {
    this.onStateChanged?.(this.state())
  }
}
