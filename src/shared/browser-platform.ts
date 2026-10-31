export type BrowserTargetKind = 'builtin' | 'companion'
export type BrowserSelectionMode = 'auto' | 'target' | 'tab'

/** Record id of the seeded Chrome-style profile that owns ND's historical partition. */
export const DEFAULT_BROWSER_PROFILE_ID = 'default'

/**
 * Renderer-free settings handed to the built-in browser's frame preload.
 * The seed is stable for one Chrome-style profile, so fingerprint noise does
 * not change between page loads inside that profile but differs between
 * profiles.
 */
export interface BrowserSafeModeConfig {
  enabled: boolean
  seed: number
  gpuVendor: string
  gpuRenderer: string
}

/** Chrome-like identity colors offered by the profile manager. */
export const BROWSER_PROFILE_COLORS = [
  '#4f7cff',
  '#12a594',
  '#e5484d',
  '#f5a623',
  '#8e4ec6',
  '#46a758',
  '#e93d82',
  '#65717b',
] as const

/** One isolated identity inside ND's built-in browser. */
export interface BrowserProfileSummary {
  id: string
  name: string
  color: string
  createdAt: number
  updatedAt: number
  isDefault: boolean
  active: boolean
  tabCount: number
}

export interface BrowserTargetCapabilities {
  tabs: boolean
  semanticDom: boolean
  screenshots: boolean
  downloads: boolean
  uploads: boolean
  history: boolean
  credentials: boolean
  extensions: boolean
  siteTools: boolean
  backgroundControl: boolean
}

export interface BrowserTargetDescriptor {
  id: string
  kind: BrowserTargetKind
  label: string
  profileId: string
  profileLabel: string
  connected: boolean
  visible: boolean
  capabilities: BrowserTargetCapabilities
}

export interface BrowserTabDescriptor {
  id: string
  targetId: string
  /** Fully-qualified profile identity, e.g. `builtin:default`. */
  profileId: string
  nativeTabId?: number | undefined
  title: string
  url: string
  origin?: string | undefined
  /** Page icon for the tab strip, restricted to renderer-loadable schemes. */
  favicon?: string | undefined
  active: boolean
  visible: boolean
  loading?: boolean | undefined
  canGoBack?: boolean | undefined
  canGoForward?: boolean | undefined
}

export interface BrowserSelection {
  mode: BrowserSelectionMode
  targetId?: string | undefined
  tabId?: string | undefined
}

export interface BrowserExecutionScope {
  sessionId?: string | undefined
  companyId?: string | undefined
  projectId?: string | undefined
  taskId?: string | undefined
  runId?: string | undefined
}

export interface BrowserTabLease {
  id: string
  ownerId: string
  targetId: string
  profileId: string
  tabId: string
  scope?: BrowserExecutionScope | undefined
  acquiredAt: number
}

export type BrowserNormalizedAction =
  | 'browser.read'
  | 'browser.navigate'
  | 'browser.interact'
  | 'browser.history'
  | 'browser.extension.manage'
  | 'credential.use'
  | 'file.download'
  | 'file.upload'
  | 'external.publish'
  | 'production.deploy'
  | 'money.spend'
  | 'data.destructive'

export interface BrowserActionEnvelope {
  id: string
  action: BrowserNormalizedAction
  operation: string
  targetId: string
  profileId: string
  tabId?: string | undefined
  origin?: string | undefined
  scope?: BrowserExecutionScope | undefined
  destructive?: boolean | undefined
  externality?: 'internal' | 'external' | undefined
  createdAt: number
}

export interface BrowserApprovalRequest {
  id: string
  action: BrowserNormalizedAction
  operation: string
  targetId: string
  tabId?: string | undefined
  origin?: string | undefined
  companyId: string
  projectId: string
  taskId?: string | undefined
  runId: string
  sessionId: string
  createdAt: number
  expiresAt: number
}

export interface BrowserActionReceipt {
  id: string
  actionId: string
  action: BrowserNormalizedAction
  operation: string
  targetId: string
  profileId: string
  tabId?: string | undefined
  origin?: string | undefined
  scope?: BrowserExecutionScope | undefined
  decision: 'allow' | 'deny' | 'ask-allowed' | 'ask-rejected' | 'manual'
  success: boolean
  error?: string | undefined
  createdAt: number
  completedAt: number
}

export interface BrowserDownloadRecord {
  id: string
  targetId: string
  profileId?: string | undefined
  tabId?: string | undefined
  url: string
  origin?: string | undefined
  filename: string
  path?: string | undefined
  receivedBytes: number
  totalBytes: number
  state: 'starting' | 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  startedAt: number
  completedAt?: number | undefined
}

export interface BrowserHistoryEntry {
  id: string
  targetId: string
  tabId: string
  url: string
  title: string
  visitedAt: number
  /** Profile record id; entries from before profiles existed belong to `default`. */
  profileId?: string | undefined
}

export type BrowserExtensionSource = 'unpacked' | 'bundled'

export interface BrowserExtensionRecord {
  id: string
  name: string
  version: string
  path: string
  enabled: boolean
  status: 'compatible' | 'limited' | 'unsupported' | 'error'
  permissions: string[]
  manifestVersion?: number | undefined
  error?: string | undefined
  installedAt: number
  source?: BrowserExtensionSource | undefined
  catalogId?: string | undefined
  storeId?: string | undefined
  publisher?: string | undefined
  actionTitle?: string | undefined
  actionPopup?: string | undefined
  compatibilityNotes?: string[] | undefined
}

export interface BrowserExtensionInstallPreview {
  path: string
  name: string
  version: string
  permissions: string[]
  manifestVersion?: number | undefined
  status: BrowserExtensionRecord['status']
  compatibilityNotes: string[]
  actionTitle?: string | undefined
  actionPopup?: string | undefined
}

export interface BrowserExtensionCatalogItem {
  id: string
  name: string
  publisher: string
  description: string
  storeId?: string | undefined
  storeUrl?: string | undefined
  packagePolicy: 'bundled' | 'reference-only'
  compatibility: 'experimental' | 'limited' | 'compatible'
  bundleAvailable: boolean
  installed: boolean
  installedExtensionId?: string | undefined
  installedSource?: BrowserExtensionSource | undefined
  note?: string | undefined
}

export interface BrowserCredentialSummary {
  id: string
  origin: string
  username: string
  label?: string | undefined
  createdAt: number
  updatedAt: number
  /** Profile record id that owns this credential. */
  profileId?: string | undefined
}

export interface BrowserSitePermission {
  origin: string
  permission: string
  effect: 'allow' | 'deny'
  updatedAt: number
  /** Profile record id this decision belongs to. */
  profileId?: string | undefined
}

export interface BrowserSiteToolDescriptor {
  name: string
  title?: string | undefined
  description: string
  inputSchema?: unknown | undefined
  origin?: string | undefined
  annotations?: {
    readOnlyHint?: boolean | undefined
    consequentialHint?: boolean | undefined
    untrustedContentHint?: boolean | undefined
  } | undefined
}

export interface BrowserPlatformState {
  targets: BrowserTargetDescriptor[]
  profiles: BrowserProfileSummary[]
  tabs: BrowserTabDescriptor[]
  selection: BrowserSelection
  leases: BrowserTabLease[]
  downloads: BrowserDownloadRecord[]
  extensions: BrowserExtensionRecord[]
  extensionCatalog: BrowserExtensionCatalogItem[]
  extensionPopupId?: string | undefined
  browserUseEnabled: boolean
  safeModeEnabled: boolean
  developerMode: boolean
  credentials: BrowserCredentialSummary[]
  sitePermissions: BrowserSitePermission[]
  approvals: BrowserApprovalRequest[]
  receipts: BrowserActionReceipt[]
}

export interface BrowserPlatformDesktopApi {
  state(): Promise<BrowserPlatformState>
  /** Create a Chrome-style profile and switch the browser to it. */
  createProfile(name: string, color?: string): Promise<BrowserPlatformState>
  /** Switch the visible browser identity; returns the new platform state. */
  selectProfile(profileId: string): Promise<BrowserPlatformState>
  updateProfile(profileId: string, input: { name?: string | undefined; color?: string | undefined }): Promise<BrowserPlatformState>
  /** Choose the profile ND opens with (the global default). */
  setDefaultProfile(profileId: string): Promise<BrowserPlatformState>
  deleteProfile(profileId: string): Promise<BrowserPlatformState>
  select(selection: BrowserSelection): Promise<BrowserPlatformState>
  createTab(targetId?: string, url?: string): Promise<BrowserTabDescriptor>
  activateTab(targetId: string, tabId: string): Promise<BrowserTabDescriptor>
  closeTab(targetId: string, tabId: string): Promise<boolean>
  history(targetId?: string): Promise<BrowserHistoryEntry[]>
  clearBrowserData(input: { targetId?: string | undefined; origin?: string | undefined; history?: boolean | undefined }): Promise<void>
  cancelDownload(downloadId: string): Promise<boolean>
  openDownload(downloadId: string): Promise<boolean>
  revealDownload(downloadId: string): Promise<boolean>
  clearFinishedDownloads(): Promise<number>
  installExtension(): Promise<BrowserExtensionRecord | null>
  setExtensionEnabled(extensionId: string, enabled: boolean): Promise<BrowserExtensionRecord[]>
  removeExtension(extensionId: string): Promise<BrowserExtensionRecord[]>
  reloadExtensions(): Promise<BrowserExtensionRecord[]>
  setDeveloperMode(enabled: boolean): Promise<BrowserPlatformState>
  setBrowserUseEnabled(enabled: boolean): Promise<BrowserPlatformState>
  /** Experimental privacy + anti-detect mode; off by default until validated. */
  setSafeModeEnabled(enabled: boolean): Promise<BrowserPlatformState>
  installCatalogExtension(catalogId: string): Promise<BrowserExtensionRecord | null>
  openCatalogExtension(catalogId: string): Promise<BrowserTabDescriptor>
  showExtensionPopup(extensionId: string): Promise<BrowserPlatformState>
  closeExtensionPopup(): Promise<BrowserPlatformState>
  saveCredential(input: { origin: string; username: string; password: string; label?: string | undefined }): Promise<BrowserCredentialSummary>
  removeCredential(credentialId: string): Promise<boolean>
  autofillCredential(credentialId: string, targetId?: string, tabId?: string): Promise<{ ok: true; credentialId: string; username: string }>
  siteTools(targetId?: string, tabId?: string): Promise<BrowserSiteToolDescriptor[]>
  setSitePermission(origin: string, permission: string, effect: 'allow' | 'deny'): Promise<BrowserSitePermission>
  resolveApproval(approvalId: string, allowed: boolean): Promise<boolean>
  onChanged(listener: (state: BrowserPlatformState) => void): () => void
}

export const BROWSER_PLATFORM_IPC = {
  state: 'browser-platform:state',
  createProfile: 'browser-platform:create-profile',
  selectProfile: 'browser-platform:select-profile',
  updateProfile: 'browser-platform:update-profile',
  setDefaultProfile: 'browser-platform:set-default-profile',
  deleteProfile: 'browser-platform:delete-profile',
  select: 'browser-platform:select',
  createTab: 'browser-platform:create-tab',
  activateTab: 'browser-platform:activate-tab',
  closeTab: 'browser-platform:close-tab',
  history: 'browser-platform:history',
  clearData: 'browser-platform:clear-data',
  cancelDownload: 'browser-platform:cancel-download',
  openDownload: 'browser-platform:open-download',
  revealDownload: 'browser-platform:reveal-download',
  clearFinishedDownloads: 'browser-platform:clear-finished-downloads',
  installExtension: 'browser-platform:install-extension',
  extensionEnabled: 'browser-platform:extension-enabled',
  removeExtension: 'browser-platform:remove-extension',
  reloadExtensions: 'browser-platform:reload-extensions',
  developerMode: 'browser-platform:developer-mode',
  browserUseEnabled: 'browser-platform:browser-use-enabled',
  safeModeEnabled: 'browser-platform:safe-mode-enabled',
  installCatalogExtension: 'browser-platform:install-catalog-extension',
  openCatalogExtension: 'browser-platform:open-catalog-extension',
  showExtensionPopup: 'browser-platform:show-extension-popup',
  closeExtensionPopup: 'browser-platform:close-extension-popup',
  saveCredential: 'browser-platform:save-credential',
  removeCredential: 'browser-platform:remove-credential',
  autofillCredential: 'browser-platform:autofill-credential',
  siteTools: 'browser-platform:site-tools',
  setSitePermission: 'browser-platform:set-site-permission',
  resolveApproval: 'browser-platform:resolve-approval',
  changedEvent: 'browser-platform:changed-event',
} as const

// Served only to the extension action popup ND is currently hosting. Carries
// Electron tab ids, never URLs or titles; tab contents still come from
// Electron's own chrome.tabs implementation.
export interface BrowserExtensionPopupContext {
  hostTabId: number
  tabIds: number[]
  windowId: number
}

export const BROWSER_EXTENSION_POPUP_IPC = {
  context: 'browser-extension-popup:context',
} as const

/** Sync-only frame-preload channel. The value is duplicated in the preload
 * because sandboxed preloads cannot require the shared module. */
export const BROWSER_SAFE_MODE_IPC = {
  config: 'browser-safe-mode:config',
} as const
