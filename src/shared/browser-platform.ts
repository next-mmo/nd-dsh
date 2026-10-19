export type BrowserTargetKind = 'builtin' | 'companion'
export type BrowserSelectionMode = 'auto' | 'target' | 'tab'

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
}

export interface BrowserSitePermission {
  origin: string
  permission: string
  effect: 'allow' | 'deny'
  updatedAt: number
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
  tabs: BrowserTabDescriptor[]
  selection: BrowserSelection
  leases: BrowserTabLease[]
  downloads: BrowserDownloadRecord[]
  extensions: BrowserExtensionRecord[]
  extensionCatalog: BrowserExtensionCatalogItem[]
  extensionPopupId?: string | undefined
  browserUseEnabled: boolean
  developerMode: boolean
  credentials: BrowserCredentialSummary[]
  sitePermissions: BrowserSitePermission[]
  approvals: BrowserApprovalRequest[]
  receipts: BrowserActionReceipt[]
}

export interface BrowserPlatformDesktopApi {
  state(): Promise<BrowserPlatformState>
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
