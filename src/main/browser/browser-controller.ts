import { randomUUID } from 'node:crypto'
import {
  app,
  BrowserWindow,
  ipcMain,
  WebContentsView,
  session,
  type IpcMainInvokeEvent,
  type Rectangle,
  type Session,
  type WebContents,
} from 'electron'
import { join } from 'node:path'
import {
  BROWSER_EXTENSION_POPUP_IPC,
  BROWSER_SAFE_MODE_IPC,
  DEFAULT_BROWSER_PROFILE_ID,
  type BrowserDownloadRecord,
  type BrowserExtensionPopupContext,
  type BrowserSafeModeConfig,
  type BrowserSiteToolDescriptor,
  type BrowserTabDescriptor,
} from '../../shared/browser-platform.js'
import type { BrowserBounds, BrowserState, UiAnnotation, UiTarget } from '../../shared/contracts.js'
import type { NdMediaSessionState } from '../../shared/media-session.js'
import { AgentBrowserClient } from './agent-browser-client.js'
import { refreshAdBlockPage } from './ad-block-page-refresh.js'
import { BrowserDownloadManager, type BrowserDownloadAuthorizationRequest } from './browser-download-manager.js'
import { privacyRequestHeaders, shouldBlockTrackerRequest } from './browser-safe-mode.js'
import { BrowserHistoryStore } from './browser-history-store.js'
import { BrowserPermissionStore } from './browser-permission-store.js'
import { DEFAULT_BROWSER_URL, isAllowedBrowserUrl, normalizeBrowserUrl, sanitizeBrowserUserAgent } from './browser-url.js'
import { BrowserMediaTracker } from './media-session-tracker.js'
import { UiAnnotator, type UiAnnotationImage } from './ui-annotator.js'
import { UiInspector } from './ui-inspector.js'
import { translatePageReadScript } from './translate-page-reader.js'

export const BUILTIN_BROWSER_TARGET_ID = 'builtin'
const BROWSER_PARTITION = 'persist:nd-dsh-browser'

export interface BrowserControllerOptions {
  reservedOrigin?: () => string | undefined
  dataPath?: string
  extensionRuntimePreload?: string
  /** Frame preload that applies experimental Browser Safe Mode. */
  browserSafeModePreload?: string
  /** Now-playing changes across tabs, for the quick launcher transport row. */
  onMediaState?: (state: NdMediaSessionState | null) => void
  /** Chrome-style profile record the browser opens with. */
  initialProfileId?: string
  /** Electron partition that holds one profile's cookies and storage. */
  partitionForProfile?: (profileId: string) => string
  /** Human label for a profile, surfaced on target descriptors. */
  profileLabel?: (profileId: string) => string
  /** Whether a profile record still exists; deleted profiles must not resurrect. */
  profileExists?: (profileId: string) => boolean
  /** The profile ND treats as its primary identity (the global default). */
  defaultProfileId?: () => string
}

const EXTENSION_RUNTIME_PRELOAD_ID = 'nd-extension-runtime'
const BROWSER_SAFE_MODE_PRELOAD_ID = 'nd-browser-safe-mode'
const DISABLED_SAFE_MODE_CONFIG: BrowserSafeModeConfig = {
  enabled: false,
  seed: 0,
  gpuVendor: '',
  gpuRenderer: '',
}

interface BrowserExtensionPopupRuntime {
  extensionId: string
  view: WebContentsView
  // `view.webContents` reads as undefined once the popup closes itself; this
  // reference stays safe to query.
  contents: WebContents
  hostWebContentsId: number
  preferredWidth?: number
  preferredHeight?: number
}

// ipcMain allows one handler per channel; a replacement controller (window
// re-created on activate) takes ownership while the old one tears down.
let extensionPopupContextOwner: BrowserController | undefined
let extensionPopupContextRegistered = false
let safeModeConfigOwner: BrowserController | undefined
let safeModeConfigRegistered = false

function claimSafeModeConfig(controller: BrowserController): void {
  safeModeConfigOwner = controller
  if (safeModeConfigRegistered) return
  safeModeConfigRegistered = true
  ipcMain.on(BROWSER_SAFE_MODE_IPC.config, (event) => {
    event.returnValue = safeModeConfigOwner?.safeModeConfigForSession(event.sender.session) ?? DISABLED_SAFE_MODE_CONFIG
  })
}

function claimExtensionPopupContext(controller: BrowserController): void {
  extensionPopupContextOwner = controller
  if (extensionPopupContextRegistered) return
  extensionPopupContextRegistered = true
  ipcMain.handle(BROWSER_EXTENSION_POPUP_IPC.context, (event) => {
    if (!extensionPopupContextOwner) throw new Error('No extension popup is open')
    return extensionPopupContextOwner.extensionPopupContext(event)
  })
}

interface BrowserTabRuntime {
  id: string
  /** Chrome-style profile record that owns this tab's session. */
  profileId: string
  view: WebContentsView
  inspector: UiInspector
  annotator: UiAnnotator
  annotationImage?: UiAnnotationImage | undefined
  state: {
    url: string
    title: string
    favicon?: string
    loading: boolean
    canGoBack: boolean
    canGoForward: boolean
    targetId?: string
    inspectMode: boolean
    selectedTarget?: UiTarget
    annotationMode: boolean
    annotation?: UiAnnotation
  }
}

export class BrowserController {
  private readonly sessionsByProfile = new Map<string, Session>()
  private readonly downloadsByProfile = new Map<string, BrowserDownloadManager>()
  private readonly tabs = new Map<string, BrowserTabRuntime>()
  private readonly lastTabByProfile = new Map<string, string>()
  private readonly agentBrowser: AgentBrowserClient
  private readonly historyStore: BrowserHistoryStore
  private readonly permissionStore: BrowserPermissionStore
  private readonly mediaTracker: BrowserMediaTracker
  private readonly reservedOrigin: (() => string | undefined) | undefined
  private readonly extensionRuntimePreload: string | undefined
  private readonly browserSafeModePreload: string | undefined
  private safeModeProvider: {
    enabled(): boolean
    setEnabled(enabled: boolean): void
    configForProfile(profileId: string): BrowserSafeModeConfig
  } | undefined
  private readonly partitionForProfile: (profileId: string) => string
  private readonly profileLabelFor: (profileId: string) => string
  private readonly profileExistsFor: (profileId: string) => boolean
  private readonly defaultProfileFor: () => string
  private sessionCreatedListener: ((profileId: string, session: Session) => void) | undefined
  private downloadAuthorizationHandler: ((request: BrowserDownloadAuthorizationRequest) => Promise<boolean>) | undefined
  private extensionPopup: BrowserExtensionPopupRuntime | undefined
  private activeProfileValue: string
  private activeTabIdValue: string
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  private visible = false
  private onStateChanged: ((state: BrowserState) => void) | undefined
  private onTabClosed: ((tabId: string) => void) | undefined
  private binding: Promise<void> | undefined
  private lastBoundTarget: string | undefined
  private destroyPromise: Promise<void> | undefined
  private destroying = false
  private readonly backgroundAttached = new Set<string>()
  private readonly routerHeadless = new Set<string>()
  private readonly safeModeWebRequest = new WeakSet<Session>()

  constructor(
    private readonly window: BrowserWindow,
    private readonly cdpPort: number,
    projectRoot: string,
    options: BrowserControllerOptions = {},
  ) {
    this.reservedOrigin = options.reservedOrigin
    this.extensionRuntimePreload = options.extensionRuntimePreload
    this.browserSafeModePreload = options.browserSafeModePreload
    this.partitionForProfile = options.partitionForProfile ?? (() => BROWSER_PARTITION)
    this.profileLabelFor = options.profileLabel ?? (() => 'ND Browser')
    this.profileExistsFor = options.profileExists ?? (() => true)
    this.defaultProfileFor = options.defaultProfileId ?? (() => DEFAULT_BROWSER_PROFILE_ID)
    this.activeProfileValue = options.initialProfileId ?? DEFAULT_BROWSER_PROFILE_ID
    this.mediaTracker = new BrowserMediaTracker(options.onMediaState ?? (() => undefined))
    claimExtensionPopupContext(this)
    claimSafeModeConfig(this)

    this.agentBrowser = new AgentBrowserClient(cdpPort, projectRoot)
    const dataPath = options.dataPath ?? app.getPath('userData')
    this.historyStore = new BrowserHistoryStore(join(dataPath, 'browser-history.json'))
    this.permissionStore = new BrowserPermissionStore(join(dataPath, 'browser-site-permissions.json'))
    // Opening the launch profile creates its session, permission handlers and
    // download tracker; other profiles get theirs on first use.
    this.ensureSession(this.activeProfileValue)

    const initial = this.createTabRuntime(this.activeProfileValue)
    this.tabs.set(initial.id, initial)
    this.activeTabIdValue = initial.id
    this.lastTabByProfile.set(initial.profileId, initial.id)
    this.syncViewVisibility()
  }

  browserSession(): Session {
    return this.ensureSession(this.activeProfileValue)
  }

  /** Notified when a profile's session is first created, so extensions attach. */
  setSessionCreatedListener(listener: ((profileId: string, session: Session) => void) | undefined): void {
    this.sessionCreatedListener = listener
  }

  /** Supplies the durable Safe Mode setting and per-profile fingerprint seed. */
  setSafeModeProvider(provider: {
    enabled(): boolean
    setEnabled(enabled: boolean): void
    configForProfile(profileId: string): BrowserSafeModeConfig
  } | undefined): void {
    this.safeModeProvider = provider
    if (provider) {
      safeModeConfigOwner = this
      this.applySafeModeToSessions(provider.enabled())
    }
  }

  safeModeEnabled(): boolean {
    return this.safeModeProvider?.enabled() ?? false
  }

  setSafeModeEnabled(enabled: boolean): void {
    this.safeModeProvider?.setEnabled(enabled)
    this.applySafeModeToSessions(enabled)
  }

  safeModeConfigForSession(target: Session): BrowserSafeModeConfig {
    if (!this.safeModeProvider?.enabled()) return DISABLED_SAFE_MODE_CONFIG
    for (const [profileId, profileSession] of this.sessionsByProfile) {
      if (profileSession === target) return this.safeModeProvider.configForProfile(profileId)
    }
    return DISABLED_SAFE_MODE_CONFIG
  }

  /** Reload real pages so the frame preload's patches start or stop applying. */
  reloadPagesForSafeMode(): void {
    for (const tab of this.tabs.values()) {
      const contents = tab.view.webContents
      if (contents.isDestroyed()) continue
      if (!/^https?:/i.test(tab.state.url)) continue
      contents.reload()
    }
  }

  private applySafeModeToSessions(enabled: boolean): void {
    for (const profileSession of this.sessionsByProfile.values()) {
      if (enabled) this.installSafeModeWebRequest(profileSession)
      else this.removeSafeModeWebRequest(profileSession)
    }
  }

  async refreshAdBlockPages(): Promise<void> {
    await Promise.all([...this.tabs.values()].map(tab => refreshAdBlockPage(tab.view.webContents)))
  }

  /** Fully-qualified identity of the active Chrome-style profile. */
  profileId(): string {
    return `builtin:${this.activeProfileValue}`
  }

  /** Record id of the active profile (`default` keeps the legacy partition). */
  activeProfileId(): string {
    return this.activeProfileValue
  }

  profileLabel(): string {
    return this.profileLabelFor(this.activeProfileValue)
  }

  /** False once a profile has been deleted, so engines rebind instead of resurrecting it. */
  profileExists(profileId: string): boolean {
    return this.profileExistsFor(profileId)
  }

  /** The global default profile: ND's primary identity and fallback. */
  defaultProfileId(): string {
    return this.defaultProfileFor()
  }

  /** True while a router web turn owns the visible/background browser surface. */
  externalActivity(): 'router-turn' | 'background-render' | undefined {
    if (this.routerHeadless.size > 0) return 'router-turn'
    if (this.backgroundAttached.size > 0) return 'background-render'
    return undefined
  }

  /**
   * Chrome-style identity switch: the active tab defines the visible profile,
   * so switching activates that profile's most recent tab (or opens a blank
   * one). Tabs of other profiles stay alive for in-flight engine work.
   */
  async switchProfile(profileId: string): Promise<BrowserState> {
    if (this.destroying) throw new Error('Built-in browser is shutting down')
    const clean = profileId.trim()
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(clean)) throw new Error('Browser profile id is invalid')
    this.ensureSession(clean)
    if (clean === this.activeProfileValue) return this.state()

    const preferredId = this.lastTabByProfile.get(clean)
    const existing = [...this.tabs.values()].filter((tab) => tab.profileId === clean)
    const target = existing.find((tab) => tab.id === preferredId) ?? existing[existing.length - 1]
    if (target) {
      await this.activateTab(target.id)
    } else {
      const tab = this.createTabRuntime(clean)
      this.tabs.set(tab.id, tab)
      await this.activateTab(tab.id)
    }
    this.emitState()
    return this.state()
  }

  /** Close a deleted profile's tabs and wipe its Chromium data and ND metadata. */
  async purgeProfile(profileId: string): Promise<void> {
    if (profileId === this.activeProfileValue) {
      throw new Error('Switch away from a browser profile before deleting it')
    }
    for (const tab of [...this.tabs.values()].filter((item) => item.profileId === profileId)) {
      await this.closeTab(tab.id)
    }
    const downloads = this.downloadsByProfile.get(profileId)
    downloads?.dispose()
    this.downloadsByProfile.delete(profileId)
    const profileSession = this.sessionsByProfile.get(profileId)
    if (profileSession) {
      await profileSession.clearStorageData().catch(() => undefined)
      await profileSession.clearCache().catch(() => undefined)
      this.sessionsByProfile.delete(profileId)
    }
    await this.permissionStore.clear(undefined, profileId).catch(() => undefined)
    await this.historyStore.clear({ profileId }).catch(() => undefined)
    this.lastTabByProfile.delete(profileId)
    this.emitState()
  }

  /** Now-playing tracking and the OS-style transport over playing tabs. */
  media(): BrowserMediaTracker {
    return this.mediaTracker
  }

  activeTabId(): string {
    return this.activeTabIdValue
  }

  extensionPopupId(): string | undefined {
    return this.extensionPopup?.extensionId
  }

  async showExtensionPopup(extensionId: string, popupPath: string): Promise<void> {
    if (this.destroying) throw new Error('Built-in browser is shutting down')
    const cleanId = extensionId.trim()
    const cleanPath = popupPath.trim().replace(/^\/+/, '')
    if (!/^[a-p]{32}$/i.test(cleanId) && !/^[a-z0-9_-]{8,128}$/i.test(cleanId)) {
      throw new Error('Browser extension id is invalid')
    }
    if (!cleanPath) throw new Error('Browser extension does not declare an action popup')

    const base = `chrome-extension://${cleanId}/`
    const popupUrl = new URL(cleanPath, base)
    if (popupUrl.protocol !== 'chrome-extension:' || popupUrl.host !== cleanId) {
      throw new Error('Browser extension popup must stay inside its extension origin')
    }

    this.closeExtensionPopup()
    const hostContents = this.activeTab().view.webContents
    const view = new WebContentsView({
      webPreferences: {
        session: this.browserSession(),
        ...(this.extensionRuntimePreload ? { preload: this.extensionRuntimePreload } : {}),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        enablePreferredSizeMode: true,
        focusOnNavigation: false,
      },
    })
    view.webContents.setUserAgent(sanitizeBrowserUserAgent(app.userAgentFallback))
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedBrowserUrl(url)) void this.createTab(url, true).catch(() => undefined)
      return { action: 'deny' }
    })
    view.webContents.on('will-navigate', (event, url) => {
      try {
        const target = new URL(url)
        if (target.protocol === 'chrome-extension:' && target.host === cleanId) return
        event.preventDefault()
        if (isAllowedBrowserUrl(url)) void this.createTab(url, true).catch(() => undefined)
      } catch {
        event.preventDefault()
      }
    })
    view.webContents.on('render-process-gone', () => {
      if (this.extensionPopup?.view === view) this.closeExtensionPopup()
    })
    view.webContents.on('destroyed', () => {
      if (this.extensionPopup?.view === view) this.closeExtensionPopup()
    })
    view.webContents.on('blur', () => {
      if (this.extensionPopup?.view === view) this.closeExtensionPopup()
    })
    view.webContents.on('preferred-size-changed', (_event, preferredSize) => {
      const popup = this.extensionPopup
      if (!popup || popup.view !== view) return
      popup.preferredWidth = preferredSize.width
      popup.preferredHeight = preferredSize.height
      this.syncExtensionPopupBounds()
    })

    this.window.contentView.addChildView(view)
    this.extensionPopup = { extensionId: cleanId, view, contents: view.webContents, hostWebContentsId: hostContents.id }
    this.syncExtensionPopupBounds()
    view.setVisible(false)
    // Electron's chrome.tabs.query({ active: true }) matches the focused WebContents.
    // The runtime preload corrects the popup's own view; extension service workers
    // still see Electron's semantics, so the page tab holds focus while the popup initializes.
    if (this.visible && !hostContents.isDestroyed()) hostContents.focus()
    try {
      await view.webContents.loadURL(popupUrl.toString())
      if (this.extensionPopup?.view === view && this.visible) {
        view.setVisible(true)
        view.webContents.focus()
        this.emitState()
      }
    } catch (cause) {
      // A newer popup (or a close) may have replaced this one mid-load; leave it alone.
      if (this.extensionPopup?.view !== view) return
      this.closeExtensionPopup()
      throw cause
    }
  }

  extensionPopupContext(event: IpcMainInvokeEvent): BrowserExtensionPopupContext {
    const popup = this.extensionPopup
    const frame = event.senderFrame
    const trusted = Boolean(
      popup
      && !popup.contents.isDestroyed()
      && event.sender === popup.contents
      && frame
      && frame === event.sender.mainFrame
      && URL.canParse(frame.url)
      && new URL(frame.url).protocol === 'chrome-extension:'
      && new URL(frame.url).host === popup.extensionId,
    )
    if (!popup || !trusted) throw new Error('Extension popup context is only available to the open extension popup')
    return {
      hostTabId: popup.hostWebContentsId,
      tabIds: [...this.tabs.values()]
        .filter((tab) => !tab.view.webContents.isDestroyed())
        .map((tab) => tab.view.webContents.id),
      windowId: this.window.id,
    }
  }

  closeExtensionPopup(): void {
    const popup = this.extensionPopup
    this.extensionPopup = undefined
    if (!popup) return
    try {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(popup.view)
    } catch {
    }
    if (!popup.contents.isDestroyed()) popup.contents.close()
    if (!this.destroying) this.emitState()
  }

  setTabClosedListener(listener: ((tabId: string) => void) | undefined): void {
    this.onTabClosed = listener
  }

  async initialize(initialUrl = DEFAULT_BROWSER_URL): Promise<void> {
    await this.permissionStore.initialize()
    try {
      await this.navigate(initialUrl)
    } catch {
    }
    await this.ensureAgentBinding()
  }

  setStateListener(listener: (state: BrowserState) => void): void {
    this.onStateChanged = listener
    listener(this.state())
  }

  state(): BrowserState {
    const active = this.activeTab()
    const agentStatus = this.agentBrowser.status()
    return {
      url: active.state.url,
      title: active.state.title,
      loading: active.state.loading,
      canGoBack: active.state.canGoBack,
      canGoForward: active.state.canGoForward,
      visible: this.visible,
      cdpPort: this.cdpPort,
      ...(active.state.targetId ? { targetId: active.state.targetId } : {}),
      profileId: this.profileId(),
      activeTabId: active.id,
      tabs: this.listTabs(),
      downloads: this.listDownloads(),
      agentBrowser: agentStatus.state,
      ...(agentStatus.error ? { agentBrowserError: agentStatus.error } : {}),
      inspectMode: active.state.inspectMode,
      ...(active.state.selectedTarget ? { selectedTarget: active.state.selectedTarget } : {}),
      annotationMode: active.state.annotationMode,
      ...(active.state.annotation ? { annotation: active.state.annotation } : {}),
    }
  }

  listTabs(): BrowserTabDescriptor[] {
    return [...this.tabs.values()].map((tab) => this.describeTab(tab))
  }

  async createTab(url = 'about:blank', activate = true, profileId = this.activeProfileValue): Promise<BrowserTabDescriptor> {
    if (this.destroying) throw new Error('Built-in browser is shutting down')
    const tab = this.createTabRuntime(profileId)
    this.tabs.set(tab.id, tab)
    if (activate) await this.activateTab(tab.id)
    if (url !== 'about:blank') await this.navigate(url, tab.id)
    this.emitState()
    return this.describeTab(tab)
  }

  async activateTab(tabId: string): Promise<BrowserTabDescriptor> {
    const tab = this.requireTab(tabId)
    this.closeExtensionPopup()
    this.lastTabByProfile.set(tab.profileId, tabId)
    if (tab.profileId !== this.activeProfileValue) {
      // A tab of another profile (agent, engine, router lane) became active:
      // the visible identity follows the tab, exactly like focusing a Chrome
      // window of a different profile.
      this.activeProfileValue = tab.profileId
    }
    if (this.activeTabIdValue === tabId) return this.describeTab(tab)
    const previous = this.activeTab()
    if (previous.state.inspectMode) await previous.inspector.stop().catch(() => undefined)
    previous.state.inspectMode = false
    if (previous.state.annotationMode) await previous.annotator.cancel().catch(() => undefined)
    previous.state.annotationMode = false

    // Never wait for the agent re-bind here: a cold agent-browser daemon takes
    // seconds to pin a target, and this call owns the tab pill the user just
    // clicked. ensureAgentBinding() re-binds for the new active tab when the
    // in-flight attempt finishes.
    this.activeTabIdValue = tabId
    this.lastBoundTarget = undefined
    this.agentBrowser.resetBinding()
    this.syncViewVisibility()
    this.emitState()
    void this.ensureAgentBinding()
    return this.describeTab(tab)
  }

  async closeTab(tabId: string): Promise<boolean> {
    const tab = this.tabs.get(tabId)
    if (!tab) return false
    if (this.extensionPopup?.hostWebContentsId === tab.view.webContents.id) this.closeExtensionPopup()
    const wasActive = tabId === this.activeTabIdValue
    await Promise.allSettled([tab.inspector.stop(), tab.annotator.cancel()])
    try {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view)
    } catch {
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    this.tabs.delete(tabId)
    this.backgroundAttached.delete(tabId)
    this.routerHeadless.delete(tabId)
    if (this.lastTabByProfile.get(tab.profileId) === tabId) this.lastTabByProfile.delete(tab.profileId)
    this.onTabClosed?.(tabId)

    if (this.tabs.size === 0) {
      const replacement = this.createTabRuntime(this.activeProfileValue)
      this.tabs.set(replacement.id, replacement)
      this.activeTabIdValue = replacement.id
      this.lastTabByProfile.set(replacement.profileId, replacement.id)
    } else if (wasActive) {
      const next = this.tabs.get(this.tabs.keys().next().value as string)!
      this.activeTabIdValue = next.id
      this.activeProfileValue = next.profileId
      this.lastTabByProfile.set(next.profileId, next.id)
    }

    if (wasActive) {
      this.lastBoundTarget = undefined
      this.agentBrowser.resetBinding()
      this.syncViewVisibility()
      void this.ensureAgentBinding()
    }
    this.emitState()
    return true
  }

  selectedUiTarget(): UiTarget | undefined {
    return this.activeTab().state.selectedTarget
  }

  selectedUiAnnotation(): UiAnnotation | undefined {
    return this.activeTab().state.annotation
  }

  selectedUiAnnotationImage(expectedAnnotationId?: string): UiAnnotationImage | undefined {
    const active = this.activeTab()
    if (expectedAnnotationId && active.state.annotation?.id !== expectedAnnotationId) return undefined
    return active.annotationImage
  }

  agentBrowserEnvironment(): NodeJS.ProcessEnv {
    return this.agentBrowser.environment()
  }

  assertAgentConfigReady(): void {
    this.agentBrowser.assertConfigReady()
  }

  async setBounds(bounds: BrowserBounds): Promise<void> {
    this.bounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    }
    const active = this.activeTab()
    if (!this.backgroundAttached.has(active.id) && !this.routerHeadless.has(active.id)) active.view.setBounds(this.bounds)
    for (const id of this.backgroundAttached) {
      const tab = this.tabs.get(id)
      if (tab) tab.view.setBounds(this.visible ? this.bounds : this.backgroundRenderBounds())
    }
    for (const id of this.routerHeadless) {
      const tab = this.tabs.get(id)
      if (tab) tab.view.setBounds(this.headlessRenderBounds())
    }
    this.syncExtensionPopupBounds()
  }

  async setVisible(visible: boolean): Promise<void> {
    this.visible = visible
    if (!visible) this.closeExtensionPopup()
    this.syncViewVisibility()
    if (visible && this.extensionPopup && !this.extensionPopup.contents.isDestroyed()) {
      this.extensionPopup.contents.focus()
    }
    this.emitState()
  }

  setBackgroundColor(color: string): void {
    for (const tab of this.tabs.values()) tab.view.setBackgroundColor(color)
  }

  async navigate(input: string, tabId = this.activeTabIdValue): Promise<BrowserState> {
    this.closeExtensionPopup()
    const tab = this.requireTab(tabId)
    const url = normalizeBrowserUrl(input)
    this.assertNotSelfHosted(url)
    await tab.view.webContents.loadURL(url)
    return this.state()
  }

  async back(tabId = this.activeTabIdValue): Promise<BrowserState> {
    this.closeExtensionPopup()
    const tab = this.requireTab(tabId)
    const history = tab.view.webContents.navigationHistory
    if (history.canGoBack()) history.goBack()
    return this.state()
  }

  async forward(tabId = this.activeTabIdValue): Promise<BrowserState> {
    this.closeExtensionPopup()
    const tab = this.requireTab(tabId)
    const history = tab.view.webContents.navigationHistory
    if (history.canGoForward()) history.goForward()
    return this.state()
  }

  async reload(tabId = this.activeTabIdValue): Promise<BrowserState> {
    this.closeExtensionPopup()
    this.requireTab(tabId).view.webContents.reload()
    return this.state()
  }

  async history(targetId = BUILTIN_BROWSER_TARGET_ID, profileId = this.activeProfileValue) {
    return this.historyStore.list(targetId, profileId)
  }

  sitePermissions() {
    return this.permissionStore.list(this.activeProfileValue)
  }

  async setSitePermission(origin: string, permission: string, effect: 'allow' | 'deny') {
    const record = await this.permissionStore.set(origin, permission, effect, this.activeProfileValue)
    this.emitState()
    return record
  }

  async clearBrowserData(origin?: string, clearHistory = true): Promise<void> {
    if (origin) {
      let parsed: URL
      try { parsed = new URL(origin) } catch { throw new Error('Browser data origin must be a valid URL') }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Browser data clearing supports http/https origins')
      await this.browserSession().clearStorageData({ origin: parsed.origin })
      await this.permissionStore.clear(parsed.origin, this.activeProfileValue)
      if (clearHistory) await this.historyStore.clear({ targetId: BUILTIN_BROWSER_TARGET_ID, origin: parsed.origin, profileId: this.activeProfileValue })
    } else {
      await this.browserSession().clearStorageData()
      await this.browserSession().clearCache()
      await this.permissionStore.clear(undefined, this.activeProfileValue)
      if (clearHistory) await this.historyStore.clear({ targetId: BUILTIN_BROWSER_TARGET_ID, profileId: this.activeProfileValue })
    }
    this.emitState()
  }

  setDownloadAuthorizationHandler(
    handler: ((request: BrowserDownloadAuthorizationRequest) => Promise<boolean>) | undefined,
  ): void {
    this.downloadAuthorizationHandler = handler
    for (const manager of this.downloadsByProfile.values()) manager.setAuthorizationHandler(handler)
  }

  armAgentDownload(tabId: string, sessionId: string): void {
    const tab = this.requireTab(tabId)
    this.downloadManagerFor(tab.profileId).armAgentDownload(tabId, sessionId)
  }

  listDownloads(): BrowserDownloadRecord[] {
    return [...this.downloadsByProfile.values()]
      .flatMap((manager) => manager.list())
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  downloadPath(downloadId: string): string | undefined {
    for (const manager of this.downloadsByProfile.values()) {
      const path = manager.path(downloadId)
      if (path) return path
    }
    return undefined
  }

  cancelDownload(downloadId: string): boolean {
    for (const manager of this.downloadsByProfile.values()) {
      if (manager.cancel(downloadId)) return true
    }
    return false
  }

  clearFinishedDownloads(): number {
    let removed = 0
    for (const manager of this.downloadsByProfile.values()) removed += manager.clearFinished()
    return removed
  }

  async snapshot(): Promise<unknown> {
    await this.ensureAgentReady()
    return this.agentBrowser.snapshot()
  }

  async semanticSnapshot(tabId = this.activeTabIdValue): Promise<unknown> {
    const contents = this.requireTab(tabId).view.webContents
    await this.ensureSemanticDriver(contents)
    return contents.executeJavaScript('window.__ND_BROWSER_BUILTIN_DRIVER__.snapshot()', true)
  }

  /** Fixed provider DOM reads for ND Translate. No renderer-supplied JavaScript. */
  async readTranslatePage(tabId: string, provider: import('../../shared/nd-translate.js').NdTranslateProvider): Promise<import('../../shared/nd-translate.js').NdTranslatePage> {
    const contents = this.requireTab(tabId).view.webContents
    return contents.executeJavaScript(translatePageReadScript(provider), true) as Promise<import('../../shared/nd-translate.js').NdTranslatePage>
  }

  /** Current URL of a tab, or `undefined` once the tab has been closed. */
  tabUrl(tabId = this.activeTabIdValue): string | undefined {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return undefined
    return tab.view.webContents.getURL() || tab.state.url
  }

  /**
   * Run a main-owned script in an isolated world of `tabId` (content-script
   * style: shares the DOM, isolates `window` globals from page scripts). Never
   * expose this channel directly to renderer IPC.
   */
  async evaluateInTab(tabId: string, expression: string): Promise<unknown> {
    const contents = this.requireTab(tabId).view.webContents
    // Fail closed: falling back to the main world would expose main-owned
    // scripts to page globals and break the isolation this channel promises.
    return contents.executeJavaScriptInIsolatedWorld(917, [{ code: expression }], true)
  }


  /**
   * Attach a tab offscreen so provider pages keep rendering while the app UI
   * covers the browser surface. Hidden views report a zero viewport and a
   * hidden visibility state, which defers provider rendering (Google Translate
   * never inserts its result span) even though its translation API completes.
   * Returns a restore callback that reapplies the normal visibility sync.
   */
  attachTabForBackgroundRendering(tabId: string): () => void {
    const tab = this.requireTab(tabId)
    this.backgroundAttached.add(tabId)
    tab.view.setVisible(true)
    tab.view.setBounds(this.backgroundRenderBounds())
    let restored = false
    return () => {
      if (restored) return
      restored = true
      this.backgroundAttached.delete(tabId)
      this.syncViewVisibility()
    }
  }

  /** Offscreen but overlapping the window by one pixel: fully offscreen views
   * are occluded by Chromium, hiding the page and zeroing its viewport, which
   * makes provider pages defer rendering. The overlap must sit at the window's
   * own corner — anchoring to the pane rect puts a large slice of the view
   * inside the window, where it paints over the app UI. */
  private backgroundRenderBounds(): Rectangle {
    const content = this.window.getContentBounds()
    return { x: Math.max(0, content.width - 1), y: Math.max(0, content.height - 1), width: 1280, height: 900 }
  }

  /** A full page viewport whose view exposes exactly one pixel in the window's
   * top-left corner, so the page stays visible to Chromium without covering
   * the app. */
  private headlessRenderBounds(): Rectangle {
    return { x: 1 - 1280, y: 1 - 900, width: 1280, height: 900 }
  }

  /**
   * Keep one router lane tab live without painting the provider page over the
   * app. The page needs real bounds and a visible view — Chromium hides pages
   * whose view is fully outside the window — so the view keeps a 1px corner
   * inside the window and the rest of its 1280x900 rect outside it. The app's
   * UI stays on screen, the window is never raised, and the lane keeps a normal
   * desktop viewport for the provider's own layout.
   */
  attachTabForRouterTurn(tabId: string): () => void {
    const tab = this.requireTab(tabId)
    this.routerHeadless.add(tabId)
    tab.view.setBounds(this.headlessRenderBounds())
    tab.view.setVisible(true)
    let restored = false
    return () => {
      if (restored) return
      restored = true
      this.routerHeadless.delete(tabId)
      if (this.tabs.has(tabId)) this.syncViewVisibility()
    }
  }

  /** True while the window itself can keep a headless page visible. */
  windowIsOnScreen(): boolean {
    return !this.window.isDestroyed() && this.window.isVisible() && !this.window.isMinimized()
  }

  /** CDP target for any tab, including router lanes that never become active. */
  async targetIdForTab(tabId: string): Promise<string> {
    const tab = this.requireTab(tabId)
    if (tab.state.targetId) return tab.state.targetId
    const targetId = await this.getTargetId(tab.view.webContents)
    tab.state.targetId = targetId
    return targetId
  }

  async click(tabId: string, ref: string, revision: number): Promise<unknown> {
    return this.semanticAction(tabId, 'click', { ref, revision })
  }

  async fill(tabId: string, ref: string, revision: number, text: string): Promise<unknown> {
    return this.semanticAction(tabId, 'fill', { ref, revision, text: text.slice(0, 100_000) })
  }

  async press(tabId: string, ref: string, revision: number, key: string): Promise<unknown> {
    return this.semanticAction(tabId, 'press', { ref, revision, key: key.slice(0, 64) })
  }

  async scroll(tabId: string, deltaX: number, deltaY: number): Promise<unknown> {
    return this.semanticAction(tabId, 'scroll', { deltaX: finite(deltaX), deltaY: finite(deltaY) })
  }

  async waitFor(tabId: string, input: { text?: string; urlIncludes?: string; timeoutMs?: number }): Promise<unknown> {
    const contents = this.requireTab(tabId).view.webContents
    const timeoutMs = Math.max(100, Math.min(30_000, Number(input.timeoutMs ?? 10_000)))
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = await contents.executeJavaScript(`({
        url: location.href,
        text: (document.body?.innerText || '').slice(0, 200000)
      })`, true) as { url: string; text: string }
      const textOk = input.text === undefined || state.text.includes(input.text)
      const urlOk = input.urlIncludes === undefined || state.url.includes(input.urlIncludes)
      if (textOk && urlOk) return { ok: true, url: state.url }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
    throw new Error('Browser wait condition timed out')
  }

  async screenshot(tabId = this.activeTabIdValue): Promise<{ tabId: string; dataUrl: string }> {
    const image = await this.requireTab(tabId).view.webContents.capturePage()
    return { tabId, dataUrl: image.toDataURL() }
  }

  async discoverSiteTools(tabId = this.activeTabIdValue): Promise<BrowserSiteToolDescriptor[]> {
    const contents = this.requireTab(tabId).view.webContents
    const result = await contents.executeJavaScript(`(async () => {
      const context = document.modelContext;
      if (!context || typeof context.getTools !== 'function') return [];
      const tools = await context.getTools();
      return tools.slice(0, 128).map((tool) => ({
        name: String(tool.name || ''),
        title: typeof tool.title === 'string' ? tool.title : undefined,
        description: String(tool.description || ''),
        inputSchema: (() => { try { return JSON.parse(JSON.stringify(tool.inputSchema ?? {})); } catch { return {}; } })(),
        origin: typeof tool.origin === 'string' ? tool.origin : location.origin,
        annotations: tool.annotations ? {
          readOnlyHint: tool.annotations.readOnlyHint === true,
          consequentialHint: tool.annotations.consequentialHint === true,
          untrustedContentHint: tool.annotations.untrustedContentHint === true
        } : undefined
      })).filter((tool) => tool.name);
    })()`, true)
    return Array.isArray(result) ? result as BrowserSiteToolDescriptor[] : []
  }

  async callSiteTool(tabId: string, name: string, input: unknown): Promise<unknown> {
    const contents = this.requireTab(tabId).view.webContents
    const encodedName = JSON.stringify(name)
    const encodedInput = JSON.stringify(input ?? {})
    return contents.executeJavaScript(`(async () => {
      const context = document.modelContext;
      if (!context || typeof context.getTools !== 'function' || typeof context.executeTool !== 'function') {
        throw new Error('WebMCP site tools are unavailable on this page');
      }
      const tools = await context.getTools();
      const tool = tools.find((item) => item.name === ${encodedName});
      if (!tool) throw new Error('WebMCP site tool not found');
      const value = await context.executeTool(tool, ${encodedInput});
      try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
    })()`, true)
  }

  async autofillCredential(tabId: string, username: string, password: string): Promise<{ ok: true }> {
    const contents = this.requireTab(tabId).view.webContents
    const payload = JSON.stringify({ username, password })
    await contents.executeJavaScript(`(() => {
      const credential = ${payload};
      const password = document.querySelector('input[type="password"]');
      if (!(password instanceof HTMLInputElement)) throw new Error('No password field is available on this page');
      const candidates = [
        document.querySelector('input[autocomplete="username"]'),
        document.querySelector('input[type="email"]'),
        document.querySelector('input[name*="user" i]'),
        document.querySelector('input[name*="email" i]'),
        document.querySelector('input[type="text"]')
      ];
      const username = candidates.find((item) => item instanceof HTMLInputElement);
      const setValue = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(element, value); else element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      };
      if (username instanceof HTMLInputElement) setValue(username, credential.username);
      setValue(password, credential.password);
      password.focus();
      return true;
    })()`, true)
    return { ok: true }
  }

  async setInspectMode(enabled: boolean): Promise<BrowserState> {
    const active = this.activeTab()
    if (enabled) {
      if (active.state.annotationMode) {
        await active.annotator.cancel()
        active.state.annotationMode = false
      }
      delete active.state.selectedTarget
      delete active.state.annotation
      await active.inspector.start()
      active.state.inspectMode = true
    } else {
      await active.inspector.stop()
      active.state.inspectMode = false
    }
    this.emitState()
    return this.state()
  }

  clearSelection(expectedTargetId?: string): BrowserState {
    const active = this.activeTab()
    if (expectedTargetId && active.state.selectedTarget?.id !== expectedTargetId) return this.state()
    delete active.state.selectedTarget
    this.emitState()
    return this.state()
  }

  async setAnnotationMode(enabled: boolean): Promise<BrowserState> {
    const active = this.activeTab()
    if (enabled) {
      if (active.state.inspectMode) {
        await active.inspector.stop()
        active.state.inspectMode = false
      }
      active.annotationImage = undefined
      delete active.state.annotation
      delete active.state.selectedTarget
      await active.annotator.start()
      active.state.annotationMode = true
      this.emitState()
      return this.state()
    }

    if (!active.state.annotationMode) return this.state()
    try {
      const capture = await active.annotator.finish()
      active.state.annotationMode = false
      if (capture) {
        active.state.annotation = capture.annotation
        active.annotationImage = capture.image
      } else {
        delete active.state.annotation
        active.annotationImage = undefined
      }
      this.emitState()
      return this.state()
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      active.state.annotationMode = false
      active.annotationImage = undefined
      delete active.state.annotation
      this.agentBrowser.recordFailure(new Error(`UI annotation failed: ${error.message}`))
      this.emitState()
      throw error
    }
  }

  async clearAnnotation(expectedAnnotationId?: string): Promise<BrowserState> {
    const active = this.activeTab()
    if (expectedAnnotationId && active.state.annotation?.id !== expectedAnnotationId) return this.state()
    if (active.state.annotationMode) await active.annotator.cancel()
    active.state.annotationMode = false
    active.annotationImage = undefined
    delete active.state.annotation
    this.emitState()
    return this.state()
  }

  async ensureAgentReady(): Promise<void> {
    await this.ensureAgentBinding()
    const status = this.agentBrowser.status()
    if (status.state !== 'ready') {
      throw new Error(status.error ?? 'agent-browser could not bind to the visible browser target')
    }
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise
    this.destroyPromise = this.destroyInternal()
    return this.destroyPromise
  }

  private async destroyInternal(): Promise<void> {
    this.destroying = true
    this.closeExtensionPopup()
    if (extensionPopupContextOwner === this) extensionPopupContextOwner = undefined
    if (safeModeConfigOwner === this) safeModeConfigOwner = undefined
    this.onStateChanged = undefined
    this.onTabClosed = undefined
    // Chromium writes cookies and site storage lazily. Quit is the only chance
    // to commit them for every profile, or a sign-in made minutes earlier can
    // vanish on restart.
    await Promise.allSettled([...this.sessionsByProfile.values()].map(async (profileSession) => {
      await profileSession.cookies.flushStore().catch(() => undefined)
      profileSession.flushStorageData()
    }))
    const binding = this.binding
    if (binding) await binding.catch(() => undefined)
    for (const manager of this.downloadsByProfile.values()) manager.dispose()
    this.downloadsByProfile.clear()
    const cleanup: Promise<unknown>[] = [this.agentBrowser.close()]
    for (const tab of this.tabs.values()) {
      cleanup.push(tab.inspector.stop(), tab.annotator.cancel())
    }
    await Promise.allSettled(cleanup)
    for (const tab of this.tabs.values()) {
      if (!this.window.isDestroyed()) {
        try { this.window.contentView.removeChildView(tab.view) } catch {
        }
      }
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    }
    this.tabs.clear()
    this.sessionsByProfile.clear()
    this.lastTabByProfile.clear()
    this.routerHeadless.clear()
  }

  /**
   * One Electron session per Chrome-style profile. Each session gets its own
   * permission handlers, extension-runtime preload and download tracker, so
   * cookies, storage and decisions never leak across identities.
   */
  private ensureSession(profileId: string): Session {
    const existing = this.sessionsByProfile.get(profileId)
    if (existing) return existing
    const profileSession = session.fromPartition(this.partitionForProfile(profileId))
    if (this.extensionRuntimePreload
      && !profileSession.getPreloadScripts().some((script) => script.id === EXTENSION_RUNTIME_PRELOAD_ID)) {
      profileSession.registerPreloadScript({
        id: EXTENSION_RUNTIME_PRELOAD_ID,
        type: 'service-worker',
        filePath: this.extensionRuntimePreload,
      })
    }
    if (this.browserSafeModePreload
      && !profileSession.getPreloadScripts().some((script) => script.id === BROWSER_SAFE_MODE_PRELOAD_ID)) {
      profileSession.registerPreloadScript({
        id: BROWSER_SAFE_MODE_PRELOAD_ID,
        type: 'frame',
        filePath: this.browserSafeModePreload,
      })
    }
    if (this.safeModeEnabled()) this.installSafeModeWebRequest(profileSession)
    profileSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const pageOrigin = permissionOrigin(details.requestingUrl || webContents.getURL())
      callback(Boolean(pageOrigin && this.permissionStore.effect(pageOrigin, permission, profileId) === 'allow'))
    })
    profileSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
      const pageOrigin = permissionOrigin(requestingOrigin)
      return Boolean(pageOrigin && this.permissionStore.effect(pageOrigin, permission, profileId) === 'allow')
    })
    this.sessionsByProfile.set(profileId, profileSession)
    const downloads = new BrowserDownloadManager(
      profileSession,
      BUILTIN_BROWSER_TARGET_ID,
      (webContentsId) => this.tabIdForWebContents(webContentsId),
      () => this.emitState(),
      profileId,
    )
    if (this.downloadAuthorizationHandler) downloads.setAuthorizationHandler(this.downloadAuthorizationHandler)
    this.downloadsByProfile.set(profileId, downloads)
    this.sessionCreatedListener?.(profileId, profileSession)
    return profileSession
  }

  private downloadManagerFor(profileId: string): BrowserDownloadManager {
    this.ensureSession(profileId)
    const manager = this.downloadsByProfile.get(profileId)
    if (!manager) throw new Error('Browser download manager is unavailable')
    return manager
  }

  private createTabRuntime(profileId: string): BrowserTabRuntime {
    const id = randomUUID()
    this.ensureSession(profileId)
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partitionForProfile(profileId),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    })
    view.webContents.setUserAgent(sanitizeBrowserUserAgent(app.userAgentFallback))
    this.window.contentView.addChildView(view)
    view.setBounds(this.bounds)
    view.setVisible(false)

    const tab = {} as BrowserTabRuntime
    tab.id = id
    tab.profileId = profileId
    tab.view = view
    tab.state = {
      url: 'about:blank',
      title: 'Browser',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      inspectMode: false,
      annotationMode: false,
    }
    tab.inspector = new UiInspector(view.webContents, {
      selected: (target) => {
        tab.state.inspectMode = false
        tab.state.selectedTarget = target
        this.emitState()
      },
      canceled: () => {
        tab.state.inspectMode = false
        this.emitState()
      },
      error: (error) => {
        tab.state.inspectMode = false
        this.agentBrowser.recordFailure(new Error(`UI inspection failed: ${error.message}`))
        this.emitState()
      },
    })
    tab.annotator = new UiAnnotator(view.webContents, {
      canceled: () => {
        tab.annotationImage = undefined
        tab.state.annotationMode = false
        delete tab.state.annotation
        this.emitState()
      },
    })
    this.installListeners(tab)
    this.mediaTracker.attach(tab.id, view.webContents)
    return tab
  }

  private installListeners(tab: BrowserTabRuntime): void {
    const contents = tab.view.webContents
    contents.setWindowOpenHandler(({ url }) => {
      void this.createTab(url, true).catch(() => undefined)
      return { action: 'deny' }
    })
    contents.on('console-message', (details) => {
      tab.inspector.handleConsoleMessage(details.message)
      tab.annotator.handleConsoleMessage(details.message)
    })
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedBrowserUrl(url)) event.preventDefault()
    })
    // ND owns navigation in the embedded pane, and Electron has no native
    // leave prompt: without this, any page with a beforeunload guard (YouTube
    // Music, web editors) vetoes every subsequent load with ERR_ABORTED.
    contents.on('will-prevent-unload', (event) => {
      event.preventDefault()
    })
    contents.on('did-start-loading', () => {
      tab.inspector.reset()
      tab.annotator.reset()
      tab.state.inspectMode = false
      tab.state.annotationMode = false
      tab.annotationImage = undefined
      delete tab.state.selectedTarget
      delete tab.state.annotation
      tab.state.loading = true
      this.emitState()
    })
    contents.on('did-stop-loading', () => {
      tab.state.loading = false
      this.refreshNavigationState(tab)
      this.emitState()
      if (tab.id === this.activeTabIdValue) void this.ensureAgentBinding()
    })
    contents.on('did-navigate', (_event, url) => {
      tab.state.url = url
      delete tab.state.favicon
      this.refreshNavigationState(tab)
      this.emitState()
      void this.recordHistory(tab)
    })
    contents.on('did-navigate-in-page', (_event, url) => {
      if (tab.state.annotationMode) void tab.annotator.cancel()
      tab.state.annotationMode = false
      tab.annotationImage = undefined
      delete tab.state.selectedTarget
      delete tab.state.annotation
      tab.state.url = url
      this.refreshNavigationState(tab)
      this.emitState()
      void this.recordHistory(tab)
    })
    contents.on('page-title-updated', (event, title) => {
      event.preventDefault()
      tab.state.title = title || 'Browser'
      this.emitState()
    })
    contents.on('page-favicon-updated', (_event, favicons) => {
      const favicon = displayableFavicon(favicons)
      if (!favicon || favicon === tab.state.favicon) return
      tab.state.favicon = favicon
      this.emitState()
    })
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      tab.state.loading = false
      tab.state.title = `Load failed: ${errorDescription}`
      tab.state.url = validatedURL
      this.emitState()
    })
    contents.on('render-process-gone', (_event, details) => {
      tab.inspector.reset()
      tab.annotator.reset()
      tab.state.inspectMode = false
      tab.state.annotationMode = false
      tab.annotationImage = undefined
      delete tab.state.selectedTarget
      delete tab.state.annotation
      tab.state.loading = false
      tab.state.title = `Browser renderer exited: ${details.reason}`
      delete tab.state.targetId
      if (tab.id === this.activeTabIdValue) {
        this.lastBoundTarget = undefined
        this.agentBrowser.resetBinding()
      }
      this.emitState()
    })
  }

  private async recordHistory(tab: BrowserTabRuntime): Promise<void> {
    if (!/^https?:/i.test(tab.state.url)) return
    await this.historyStore.record({
      targetId: BUILTIN_BROWSER_TARGET_ID,
      tabId: tab.id,
      url: tab.state.url,
      title: tab.state.title,
      profileId: tab.profileId,
    }).catch(() => undefined)
  }

  /**
   * Safe Mode is opt-in. The listeners are attached only while enabled so a
   * normal ND session pays no webRequest interception cost.
   */
  private installSafeModeWebRequest(profileSession: Session): void {
    if (this.safeModeWebRequest.has(profileSession)) return
    this.safeModeWebRequest.add(profileSession)
    const filter = { urls: ['<all_urls>'] }
    profileSession.webRequest.onBeforeRequest(filter, (details, callback) => {
      if (!this.safeModeEnabled()) return callback({})
      const initiatorUrl = details.frame?.url || details.referrer || this.urlForWebContents(details.webContentsId)
      if (shouldBlockTrackerRequest({
        url: details.url,
        ...(initiatorUrl ? { initiatorUrl } : {}),
        resourceType: details.resourceType,
      })) {
        callback({ cancel: true })
        return
      }
      callback({})
    })
    profileSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      if (!this.safeModeEnabled()) {
        callback({ requestHeaders: details.requestHeaders })
        return
      }
      const initiatorUrl = details.frame?.url || details.referrer || this.urlForWebContents(details.webContentsId)
      callback({
        requestHeaders: privacyRequestHeaders({
          requestHeaders: details.requestHeaders,
          targetUrl: details.url,
          ...(initiatorUrl ? { initiatorUrl } : {}),
        }),
      })
    })
  }

  private removeSafeModeWebRequest(profileSession: Session): void {
    if (!this.safeModeWebRequest.has(profileSession)) return
    this.safeModeWebRequest.delete(profileSession)
    profileSession.webRequest.onBeforeRequest(null)
    profileSession.webRequest.onBeforeSendHeaders(null)
  }

  private urlForWebContents(webContentsId?: number): string | undefined {
    if (webContentsId === undefined) return undefined
    for (const tab of this.tabs.values()) {
      if (tab.view.webContents.id === webContentsId) return tab.state.url
    }
    return undefined
  }

  private describeTab(tab: BrowserTabRuntime): BrowserTabDescriptor {
    return {
      id: tab.id,
      targetId: BUILTIN_BROWSER_TARGET_ID,
      profileId: `builtin:${tab.profileId}`,
      title: tab.state.title,
      url: tab.state.url,
      ...(tab.state.favicon ? { favicon: tab.state.favicon } : {}),
      ...(pageOrigin(tab.state.url) ? { origin: pageOrigin(tab.state.url) } : {}),
      active: tab.id === this.activeTabIdValue,
      visible: tab.id === this.activeTabIdValue && this.visible,
      loading: tab.state.loading,
      canGoBack: tab.state.canGoBack,
      canGoForward: tab.state.canGoForward,
    }
  }

  private activeTab(): BrowserTabRuntime {
    return this.requireTab(this.activeTabIdValue)
  }

  private requireTab(tabId: string): BrowserTabRuntime {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('Built-in browser tab not found')
    return tab
  }

  private tabIdForWebContents(webContentsId: number): string | undefined {
    for (const tab of this.tabs.values()) {
      if (tab.view.webContents.id === webContentsId) return tab.id
    }
    return undefined
  }

  private syncViewVisibility(): void {
    for (const tab of this.tabs.values()) {
      if (this.routerHeadless.has(tab.id)) {
        // Router lanes keep their page on screen for Chromium while the app UI
        // stays on top; they never fill the pane, even if the user opens it.
        tab.view.setBounds(this.headlessRenderBounds())
        tab.view.setVisible(true)
        continue
      }
      if (this.backgroundAttached.has(tab.id)) {
        // Attached tabs render offscreen while the surface is hidden and fill
        // the pane when the user opens the browser during a translation.
        tab.view.setBounds(this.visible ? this.bounds : this.backgroundRenderBounds())
        tab.view.setVisible(true)
        continue
      }
      const active = tab.id === this.activeTabIdValue
      // A blank tab belongs to the shell, not the page: the native view steps
      // aside so the renderer can paint its new-tab page into the same rect.
      // The WebContents stays alive, so the agent still drives a blank tab.
      tab.view.setBounds(this.bounds)
      tab.view.setVisible(active && this.visible && tab.state.url !== DEFAULT_BROWSER_URL)
    }
    if (this.extensionPopup) {
      this.syncExtensionPopupBounds()
      this.extensionPopup.view.setVisible(this.visible)
    }
  }

  private syncExtensionPopupBounds(): void {
    const popup = this.extensionPopup
    if (!popup) return
    const margin = 8
    const availableWidth = Math.max(1, this.bounds.width - margin * 2)
    const availableHeight = Math.max(1, this.bounds.height - margin * 2)
    const requestedWidth = popup.preferredWidth ?? 360
    const requestedHeight = popup.preferredHeight ?? 420
    const width = Math.min(availableWidth, Math.max(240, Math.min(420, requestedWidth)))
    const height = Math.min(availableHeight, Math.max(120, Math.min(520, requestedHeight)))
    const x = Math.max(this.bounds.x + margin, this.bounds.x + this.bounds.width - width - margin)
    const y = this.bounds.y + margin
    popup.view.setBounds({ x, y, width, height })
  }

  private assertNotSelfHosted(url: string): void {
    const reserved = this.reservedOrigin?.()
    if (!reserved || reserved === 'null') return
    let origin: string
    try { origin = new URL(url).origin } catch { return }
    if (origin === 'null' || origin !== reserved) return
    throw new Error(`Refusing to open ${origin} in the built-in browser: that is ND-DSH's own control-plane surface. Point the browser at the app under development instead.`)
  }

  private refreshNavigationState(tab: BrowserTabRuntime): void {
    const history = tab.view.webContents.navigationHistory
    tab.state.url = tab.view.webContents.getURL() || tab.state.url
    tab.state.canGoBack = history.canGoBack()
    tab.state.canGoForward = history.canGoForward()
    // The address can cross to or from blank here, which is what decides
    // whether the native view or the shell's new-tab page owns the rect.
    this.syncViewVisibility()
  }

  private async ensureAgentBinding(): Promise<void> {
    if (this.destroying) return
    if (this.binding) return this.binding
    const tabId = this.activeTabIdValue
    this.binding = (async () => {
      try {
        const tab = this.requireTab(tabId)
        const targetId = tab.state.targetId ?? await this.getTargetId(tab.view.webContents)
        tab.state.targetId = targetId
        this.emitState()
        if (this.activeTabIdValue !== tabId) return
        if (this.lastBoundTarget !== targetId || this.agentBrowser.status().state !== 'ready') {
          await this.agentBrowser.bindTarget(targetId)
          if (this.activeTabIdValue === tabId) this.lastBoundTarget = targetId
        }
      } catch (error) {
        this.agentBrowser.recordFailure(error)
      } finally {
        this.emitState()
      }
    })().finally(() => {
      this.binding = undefined
      if (!this.destroying && this.activeTabIdValue !== tabId) void this.ensureAgentBinding()
    })
    return this.binding
  }

  private async getTargetId(contents: WebContents): Promise<string> {
    const debuggerApi = contents.debugger
    const attachedHere = !debuggerApi.isAttached()
    if (attachedHere) debuggerApi.attach('1.3')
    try {
      const response = (await debuggerApi.sendCommand('Target.getTargetInfo')) as {
        targetInfo?: { targetId?: string }
      }
      const targetId = response.targetInfo?.targetId
      if (!targetId) throw new Error('Electron did not return a CDP target id for the browser tab')
      return targetId
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach()
    }
  }

  private async semanticAction(tabId: string, method: 'click' | 'fill' | 'press' | 'scroll', input: Record<string, unknown>): Promise<unknown> {
    const contents = this.requireTab(tabId).view.webContents
    await this.ensureSemanticDriver(contents)
    const methodJson = JSON.stringify(method)
    const inputJson = JSON.stringify(input)
    // A page-thrown error does not survive the executeJavaScript boundary with
    // its message intact (main sees only "Script failed to execute"), so the
    // driver result crosses as a value and is re-thrown here with its coded
    // reason — e.g. STALE_BROWSER_REFERENCE — preserved.
    const wrapped = await contents.executeJavaScript(
      `(() => { try { return { ok: true, value: window.__ND_BROWSER_BUILTIN_DRIVER__[${methodJson}](${inputJson}) } } catch (error) { return { ok: false, code: error?.code, message: error?.message ?? String(error) } } })()`,
      true,
    ) as { ok?: boolean; code?: unknown; message?: unknown; value?: unknown }
    if (!wrapped || wrapped.ok !== true) {
      const message = typeof wrapped?.message === 'string' && wrapped.message ? wrapped.message : 'Browser semantic action failed'
      const error = new Error(message)
      if (typeof wrapped?.code === 'string' && wrapped.code) {
        ;(error as Error & { code?: string }).code = wrapped.code
      }
      throw error
    }
    return wrapped.value
  }

  private async ensureSemanticDriver(contents: WebContents): Promise<void> {
    const installed = await contents.executeJavaScript('Boolean(window.__ND_BROWSER_BUILTIN_DRIVER__)', true).catch(() => false)
    if (installed) return
    await contents.executeJavaScript(SEMANTIC_DRIVER_SCRIPT, true)
  }

  private emitState(): void {
    this.onStateChanged?.(this.state())
  }
}

function finite(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) throw new Error('Browser numeric argument is invalid')
  return value
}

function permissionOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

function pageOrigin(value: string): string | undefined {
  try {
    const origin = new URL(value).origin
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

/**
 * The tab strip is a sandboxed renderer whose CSP only loads https and data
 * images, so an http:// or chrome-extension:// icon would render as a broken
 * frame. Pick the first icon the shell can actually display.
 */
function displayableFavicon(favicons: string[]): string | undefined {
  return favicons.find((favicon) => favicon.startsWith('https://') || favicon.startsWith('data:image/'))
}

const SEMANTIC_DRIVER_SCRIPT = `(() => {
  if (window.__ND_BROWSER_BUILTIN_DRIVER__) return true;
  const refs = new Map();
  const elementRefs = new WeakMap();
  let nextRef = 1;
  let revision = 1;

  const observer = new MutationObserver(() => { revision += 1; });
  if (document.documentElement) {
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }

  const coded = (code, message) => {
    const error = new Error(message);
    error.code = code;
    return error;
  };
  const visible = (element) => {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const textOf = (element) => {
    if (element instanceof HTMLInputElement) {
      if (element.type === 'password') return '';
      return (element.placeholder || '').trim().slice(0, 300);
    }
    if (element instanceof HTMLTextAreaElement) return (element.placeholder || '').trim().slice(0, 300);
    return (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500);
  };
  const implicitRole = (element) => {
    if (element instanceof HTMLButtonElement) return 'button';
    if (element instanceof HTMLAnchorElement) return 'link';
    if (element instanceof HTMLInputElement) {
      if (element.type === 'checkbox') return 'checkbox';
      if (element.type === 'radio') return 'radio';
      return 'textbox';
    }
    if (element instanceof HTMLTextAreaElement) return 'textbox';
    if (element instanceof HTMLSelectElement) return 'combobox';
    return undefined;
  };
  const accessibleName = (element) => {
    const aria = element.getAttribute('aria-label')?.trim();
    if (aria) return aria.slice(0, 300);
    if (element instanceof HTMLInputElement && element.labels?.length) {
      return Array.from(element.labels).map((label) => label.textContent?.trim()).filter(Boolean).join(' ').slice(0, 300);
    }
    const title = element.getAttribute('title')?.trim();
    return title ? title.slice(0, 300) : textOf(element);
  };
  const requireElement = (input) => {
    if (!Number.isInteger(input.revision) || input.revision !== revision) {
      throw coded('STALE_BROWSER_REFERENCE', 'Page changed after the snapshot; take a fresh snapshot before acting');
    }
    const element = refs.get(String(input.ref || ''));
    if (!(element instanceof Element) || !element.isConnected) {
      throw coded('STALE_BROWSER_REFERENCE', 'Element reference is stale; take a fresh snapshot');
    }
    return element;
  };
  const setNativeValue = (element, value) => {
    if (element instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(element, value); else element.value = value;
    } else if (element instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(element, value); else element.value = value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };

  window.__ND_BROWSER_BUILTIN_DRIVER__ = {
    snapshot() {
      refs.clear();
      const elements = Array.from(document.querySelectorAll(
        'a[href],button,input,textarea,select,summary,[role],[tabindex],[contenteditable="true"]'
      )).filter(visible).slice(0, 750).map((element) => {
        let ref = elementRefs.get(element);
        if (!ref) {
          ref = '@e' + nextRef++;
          elementRefs.set(element, ref);
        }
        refs.set(ref, element);
        const type = element instanceof HTMLInputElement ? element.type : undefined;
        return {
          ref,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || implicitRole(element),
          name: accessibleName(element),
          text: textOf(element),
          type,
          disabled: 'disabled' in element || element.hasAttribute('aria-disabled')
            ? Boolean(('disabled' in element && element.disabled) || element.getAttribute('aria-disabled') === 'true')
            : undefined,
          href: element instanceof HTMLAnchorElement ? element.href : undefined,
          sensitive: type === 'password' ? true : undefined,
          editable: element instanceof HTMLElement && element.isContentEditable ? true : undefined
        };
      });
      return {
        revision,
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
        elements
      };
    },
    click(input) {
      const element = requireElement(input);
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.click();
      revision += 1;
      return { ok: true, revision };
    },
    fill(input) {
      const element = requireElement(input);
      const value = String(input.text ?? '');
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        element.focus();
        setNativeValue(element, value);
        revision += 1;
        return { ok: true, revision };
      }
      if (element instanceof HTMLElement && element.isContentEditable) {
        element.focus();
        const selection = window.getSelection?.();
        if (selection && typeof document.createRange === 'function') {
          const range = document.createRange();
          range.selectNodeContents(element);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        if (typeof document.execCommand === 'function') {
          document.execCommand('delete');
          if (!document.execCommand('insertText', false, value)) element.textContent = value;
        } else {
          element.textContent = value;
        }
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        revision += 1;
        return { ok: true, revision };
      }
      throw coded('NOT_EDITABLE', 'Referenced element is not editable');
    },
    press(input) {
      const element = requireElement(input);
      const key = String(input.key || '');
      if (!key) throw coded('INVALID_KEY', 'A key is required');
      element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
      if (key === 'Enter' && (element instanceof HTMLInputElement || element instanceof HTMLButtonElement)) {
        const form = element.closest('form');
        if (form instanceof HTMLFormElement) form.requestSubmit();
      }
      revision += 1;
      return { ok: true, revision };
    },
    scroll(input) {
      const deltaX = Number(input.deltaX || 0);
      const deltaY = Number(input.deltaY || 0);
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) throw coded('INVALID_SCROLL', 'Scroll delta is invalid');
      window.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
      return { ok: true, revision, scrollX, scrollY };
    }
  };
  return true;
})()`
