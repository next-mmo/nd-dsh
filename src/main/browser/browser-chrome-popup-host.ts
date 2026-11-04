import { WebContentsView, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  BROWSER_CHROME_POPUP_IPC,
  BROWSER_CHROME_POPUP_ROUTE,
  browserChromePopupActionDismisses,
  browserChromePopupBounds,
  type BrowserChromePopupAction,
  type BrowserChromePopupAnchor,
  type BrowserChromePopupKind,
  type BrowserChromePopupModel,
  type BrowserChromePopupOpenRequest,
  type BrowserChromePopupSize,
} from '../../shared/browser-chrome-popup.js'

/** A click on the trigger blurs the popup first; that same click must not reopen it. */
const TOGGLE_DEBOUNCE_MS = 300
/** Reveal anyway after the popup document has loaded if it never reports its size. */
const REVEAL_FALLBACK_MS = 350
/** Grace window after reveal so initial focus transfer cannot self-dismiss. */
const BLUR_GRACE_MS = 180
const INITIAL_CARD: Record<BrowserChromePopupKind, BrowserChromePopupSize> = {
  extensions: { width: 320, height: 240 },
  profiles: { width: 272, height: 200 },
}

type CloseReason = 'blur' | 'escape' | 'action' | 'host' | 'window'

/**
 * Owns the native surface for browser toolbar popups. The view is a sandboxed,
 * context-isolated renderer on ND's own bundle and preload (route
 * `#/browser-popup`), with a transparent background, re-stacked above the
 * embedded page's views every time it opens — the same layering Chrome gets
 * from its bubble widgets. Created lazily on first use.
 */
export class BrowserChromePopupHost {
  private view: WebContentsView | null = null
  private loaded = false
  private model: BrowserChromePopupModel | null = null
  private anchor: BrowserChromePopupAnchor | null = null
  private card: BrowserChromePopupSize | null = null
  private open = false
  private revealed = false
  private revealedAt = 0
  private revealTimer: NodeJS.Timeout | undefined
  private lastDismiss: { kind: BrowserChromePopupKind; at: number } | undefined
  private readonly onWindowResize = (): void => this.close('window')

  constructor(private readonly options: { window: BrowserWindow; preloadPath: string }) {
    options.window.on('resize', this.onWindowResize)
  }

  /** True only for the popup renderer's own main frame. */
  isPopupSender(event: IpcMainInvokeEvent): boolean {
    const contents = this.view?.webContents
    return Boolean(contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame)
  }

  show(request: BrowserChromePopupOpenRequest): boolean {
    const kind = request.model.kind
    if (this.open && this.model?.kind === kind) {
      this.close('host')
      return false
    }
    const dismissed = this.lastDismiss
    this.lastDismiss = undefined
    if (dismissed && dismissed.kind === kind && Date.now() - dismissed.at < TOGGLE_DEBOUNCE_MS) return false
    if (this.open) this.close('host')
    const view = this.ensureView()
    if (!view) return false
    this.model = request.model
    this.anchor = request.anchor
    this.card = null
    this.open = true
    this.revealed = false
    // Re-adding an existing child restacks it as the topmost view, above any
    // tab or extension-popup view created since the last open.
    try {
      this.options.window.contentView.removeChildView(view)
    } catch {
      // Detached
    }
    this.options.window.contentView.addChildView(view)
    view.setVisible(false)
    this.layout()
    clearTimeout(this.revealTimer)
    if (this.loaded) {
      view.webContents.send(BROWSER_CHROME_POPUP_IPC.modelEvent, this.model)
      this.revealTimer = setTimeout(() => this.reveal(), REVEAL_FALLBACK_MS)
    }
    return true
  }

  getModel(): BrowserChromePopupModel | null {
    return this.open ? this.model : null
  }

  update(model: BrowserChromePopupModel): void {
    if (!this.open || this.model?.kind !== model.kind) return
    this.model = model
    const contents = this.view?.webContents
    if (this.loaded && contents && !contents.isDestroyed()) contents.send(BROWSER_CHROME_POPUP_IPC.modelEvent, model)
  }

  resize(size: BrowserChromePopupSize): void {
    if (!this.open) return
    this.card = size
    this.layout()
    this.reveal()
  }

  action(action: BrowserChromePopupAction): void {
    if (!this.open) return
    const main = this.options.window
    if (!main.isDestroyed()) main.webContents.send(BROWSER_CHROME_POPUP_IPC.actionEvent, action)
    if (browserChromePopupActionDismisses(action)) this.close('action')
  }

  close(reason: CloseReason = 'host'): void {
    clearTimeout(this.revealTimer)
    this.revealTimer = undefined
    if (!this.open) return
    const kind = this.model?.kind
    const hadFocus = this.revealed && this.view?.webContents.isFocused() === true
    this.open = false
    this.revealed = false
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.setVisible(false)
      if (this.loaded) this.view.webContents.send(BROWSER_CHROME_POPUP_IPC.modelEvent, null)
    }
    if (kind && reason === 'blur') this.lastDismiss = { kind, at: Date.now() }
    const main = this.options.window
    if (main.isDestroyed()) return
    // Escape and actions leave focus on a hidden view; hand it back to the shell.
    if (hadFocus && reason !== 'blur') main.webContents.focus()
    if (kind) main.webContents.send(BROWSER_CHROME_POPUP_IPC.closedEvent, kind)
  }

  dispose(): void {
    this.close('host')
    const main = this.options.window
    main.removeListener('resize', this.onWindowResize)
    this.destroyView()
  }

  private reveal(): void {
    clearTimeout(this.revealTimer)
    this.revealTimer = undefined
    const view = this.view
    if (!this.open || this.revealed || !view || view.webContents.isDestroyed()) return
    this.revealed = true
    this.revealedAt = Date.now()
    view.setVisible(true)
    view.webContents.focus()
  }

  private layout(): void {
    const view = this.view
    if (!view || !this.anchor || !this.model) return
    const content = this.options.window.getContentBounds()
    const card = this.card ?? INITIAL_CARD[this.model.kind]
    view.setBounds(browserChromePopupBounds(this.anchor, card, { width: content.width, height: content.height }))
  }

  private ensureView(): WebContentsView | null {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view
    const main = this.options.window
    if (main.isDestroyed()) return null
    const baseUrl = main.webContents.getURL().split('#')[0]
    if (!baseUrl) return null
    const view = new WebContentsView({
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    })
    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    const contents = view.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(baseUrl)) event.preventDefault()
    })
    contents.on('blur', () => {
      if (this.view !== view || !this.revealed) return
      const delay = Math.max(60, BLUR_GRACE_MS - (Date.now() - this.revealedAt))
      setTimeout(() => {
        if (this.view === view && this.revealed && !contents.isFocused()) {
          this.close('blur')
        }
      }, delay)
    })
    contents.on('did-finish-load', () => {
      if (this.view !== view) return
      this.loaded = true
      if (this.open && this.model) {
        contents.send(BROWSER_CHROME_POPUP_IPC.modelEvent, this.model)
        clearTimeout(this.revealTimer)
        this.revealTimer = setTimeout(() => this.reveal(), REVEAL_FALLBACK_MS)
      }
    })
    contents.on('render-process-gone', () => {
      if (this.view !== view) return
      this.close('host')
      this.destroyView()
    })
    this.view = view
    this.loaded = false
    main.contentView.addChildView(view)
    void contents.loadURL(`${baseUrl}#/${BROWSER_CHROME_POPUP_ROUTE}`).catch((cause) => {
      if (this.view !== view) return
      console.error('ND browser popup surface could not load:', cause)
      this.close('host')
      this.destroyView()
    })
    return view
  }

  private destroyView(): void {
    const view = this.view
    this.view = null
    this.loaded = false
    if (!view) return
    const main = this.options.window
    if (!main.isDestroyed()) {
      try {
        main.contentView.removeChildView(view)
      } catch {
        // Already detached.
      }
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }
}
