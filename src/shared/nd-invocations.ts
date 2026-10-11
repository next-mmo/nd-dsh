/**
 * Invocation, grant, and ND Home contracts shared by main, preload, and the
 * renderer. The invocation envelope is the only way a contribution runs: it
 * names the extension, the contribution, and exactly one authorized context,
 * and every layer re-checks it against trusted records.
 */

import type { NdContext, NdContextKind } from './nd-context.js'
import type {
  NdContributionKind,
  NdExtensionPermission,
  NdHostMethod,
  NdPackageSettingField,
} from './extension-package.js'

export type NdCallerKind = 'user' | 'agent'

export interface NdInvocationRequest {
  extensionId: string
  contributionId: string
  contributionKind: NdContributionKind
  context: NdContext
  caller: NdCallerKind
  runId?: string
  input: Record<string, unknown>
}

export type NdInvocationErrorCode = 'invalid' | 'denied' | 'unavailable' | 'failed' | 'approval-required' | 'cancelled'

export interface NdInvocationError {
  code: NdInvocationErrorCode
  message: string
}

export interface NdInvocationResult {
  ok: boolean
  value?: unknown
  error?: NdInvocationError
}

export interface NdPendingApprovalView {
  approvalId: string
  extensionId: string
  contributionId: string
  host: NdHostMethod
  context: NdContext
  title: string
  requestedAt: number
}

/**
 * A real browser tab was opened or focused by an ND context. The tab belongs to
 * exactly that context, so the shell presents it there: Personal browsing is
 * Personal, never a company's or a project's.
 */
export interface NdBrowserFocusEvent {
  url: string
  tabId?: string
  context: NdContext
}

export interface NdCommandView {
  extensionId: string
  contributionId: string
  title: string
  description?: string
  keywords: string[]
  contexts: NdContextKind[]
  startsAgent: boolean
  host: NdHostMethod
  openViewId?: string
  permission: NdExtensionPermission
}

export interface NdViewActionView {
  id: string
  title: string
  host: NdHostMethod
}

export interface NdViewRow {
  id: string
  title: string
  body?: string
  meta?: string
  thumbnail?: string
  path?: string
  actionsDisabled?: boolean
  sortValues?: Record<string, number>
}

export interface NdWebViewData {
  /** Package-relative UI entry from the manifest's web-view contribution. */
  entry: string
  /** Attached by main for the renderer: the token-scoped asset URL to load. */
  url?: string
  /** Opaque serving token; revoke it when the hosting dialog closes. */
  token?: string
}

export interface NdViewData {
  extensionId: string
  viewId: string
  title: string
  kind: 'list' | 'detail' | 'web'
  context: NdContext
  rows: NdViewRow[]
  actions: NdViewActionView[]
  refreshIntervalMs?: number
  empty?: string
  /** Present only for `kind: 'web'` views. */
  webView?: NdWebViewData
}

export type NdPackageSourceKind = 'builtin' | 'local' | 'git'

export interface NdPackageSourceView {
  kind: NdPackageSourceKind
  location: string
  revision?: string
}

export interface NdContributionCounts {
  tools: number
  skills: number
  commands: number
  views: number
  workflows: number
}

export interface NdInstalledPackageView {
  id: string
  name: string
  description: string
  version: string
  protocol: string
  apiVersion: number
  source: NdPackageSourceView
  installedAt: number
  updatedAt: number
  /** Contexts this package declares; contributions may narrow but never widen these. */
  contexts: NdContextKind[]
  permissions: NdExtensionPermission[]
  settings: NdPackageSettingField[]
  contributions: NdContributionCounts
  /** Typed views this package offers, in manifest order. */
  views: Array<{ id: string; title: string; description?: string }>
  /** Command contributions with display metadata, in manifest order. */
  commands: Array<{ id: string; title: string; description?: string }>
  hasExecutable: boolean
  previousVersion?: string
}

export interface NdActivationView {
  extensionId: string
  contextKey: string
  context: NdContext
  enabled: boolean
  settings: Record<string, unknown>
  updatedAt: number
}

export type NdGrantScope = 'once' | 'remembered'

export interface NdGrantView {
  id: string
  extensionId: string
  host: NdHostMethod
  contextKey: string
  scope: NdGrantScope
  grantedAt: number
  /** Nonsecret target descriptor the grant is bound to (for example a chosen app path). */
  resource?: string
}

export type NdAuditDecision = 'allowed' | 'denied' | 'approval-required'

export interface NdAuditEntryView {
  at: number
  extensionId: string
  contributionId: string
  host: NdHostMethod
  contextKey: string
  caller: NdCallerKind
  decision: NdAuditDecision
  reason?: string
  outcome?: 'ok' | 'failed'
  durationMs?: number
}

export interface NdExtensionsStateView {
  packages: NdInstalledPackageView[]
  available?: NdAvailablePackageView[]
  activations: NdActivationView[]
  grants: NdGrantView[]
  audit: NdAuditEntryView[]
  pendingApprovals: NdPendingApprovalView[]
}

export interface NdAvailablePackageView {
  id: string
  name: string
  description: string
  version: string
  permissions: NdExtensionPermission[]
  commands: Array<{ id: string; title: string; description?: string }>
  installed: boolean
  available: boolean
}

export interface NdHomeNoteView {
  id: string
  title: string
  body: string
  tags: string[]
  contextKey: string
  createdAt: number
  updatedAt: number
}

export interface NdHomeCaptureView {
  id: string
  name: string
  width: number
  height: number
  displayLabel: string
  contextKey: string
  createdAt: number
  attachedSessionId?: string
}

export interface NdHomeChatView {
  chatId: string
  /** Gateway session id, recorded once the first turn returns. */
  sessionId?: string
  title: string
  context: NdContext
  workDir: string
  createdAt: number
  updatedAt: number
}

/** One saved dialpad link of the Personal browser. */
export interface NdHomeLinkView {
  id: string
  url: string
  title: string
  addedAt: number
}

export interface NdHomeStateView {
  storageRoot: string
  notes: NdHomeNoteView[]
  captures: NdHomeCaptureView[]
  chats: NdHomeChatView[]
  /** Saved Personal browser dialpad links, newest first. */
  links: NdHomeLinkView[]
}

export interface NdCaptureResultView {
  captureId: string
  width: number
  height: number
  displayLabel: string
  /** Base64 PNG bytes for preview only; never persisted outside ND-managed storage. */
  data: string
}

/** Desktop-coordinate rectangle for area capture (multi-monitor, negative origins allowed). */
export interface NdScreenRect {
  x: number
  y: number
  width: number
  height: number
}

export interface NdHomeNoteInput {
  body: string
  title?: string
  tags?: string[]
  context?: NdContext
}

export interface NdExtensionsDesktopApi {
  state(): Promise<NdExtensionsStateView>
  /** Opens a native directory picker, validates, and installs the chosen package. */
  installLocal(): Promise<NdExtensionsStateView | null>
  installFromPath(path: string): Promise<NdExtensionsStateView>
  installAvailable(extensionId: string): Promise<NdExtensionsStateView>
  /**
   * Builds the extension starter kit (a complete, installable sample package)
   * and saves it as a ZIP through a native save dialog. Null when cancelled.
   */
  exportStarterKit(): Promise<{ saved: boolean; path?: string } | null>
  update(extensionId: string, sourcePath?: string): Promise<NdExtensionsStateView>
  rollback(extensionId: string): Promise<NdExtensionsStateView>
  uninstall(extensionId: string): Promise<NdExtensionsStateView>
  setActivation(extensionId: string, context: NdContext, enabled: boolean): Promise<NdExtensionsStateView>
  setSetting(extensionId: string, context: NdContext, key: string, value: unknown): Promise<NdExtensionsStateView>
  revokeGrant(grantId: string): Promise<NdExtensionsStateView>
  commands(context: NdContext): Promise<NdCommandView[]>
  invoke(request: NdInvocationRequest): Promise<NdInvocationResult>
  loadView(extensionId: string, viewId: string, context: NdContext): Promise<NdViewData>
  /** Invalidates the asset-serving token of a closed web-view dialog. */
  closeWebView(token: string): Promise<void>
  approve(approvalId: string, remember?: boolean): Promise<NdInvocationResult>
  deny(approvalId: string): Promise<void>
  onChanged(listener: (state: NdExtensionsStateView) => void): () => void
  /** The host opened or focused a real browser tab: the app surfaces it in the tab's own context. */
  onBrowserFocus(listener: (focus: NdBrowserFocusEvent) => void): () => void
}

export interface NdHomeDesktopApi {
  state(): Promise<NdHomeStateView>
  createNote(input: NdHomeNoteInput): Promise<NdHomeStateView>
  updateNote(id: string, input: NdHomeNoteInput): Promise<NdHomeStateView>
  deleteNote(id: string): Promise<NdHomeStateView>
  searchNotes(query: string): Promise<NdHomeNoteView[]>
  captureScreen(): Promise<NdCaptureResultView>
  /** Area selection; resolves null when the user cancels. */
  captureArea(rect: NdScreenRect): Promise<NdCaptureResultView | null>
  readCapture(id: string): Promise<NdCaptureResultView | null>
  deleteCapture(id: string): Promise<NdHomeStateView>
  attachCapture(id: string, sessionId: string): Promise<NdHomeStateView>
  ensureChat(context: NdContext): Promise<NdHomeChatView>
  bindChat(chatId: string, sessionId: string): Promise<NdHomeChatView>
  setChatTitle(sessionId: string, title: string): Promise<NdHomeStateView>
  /** Personal browser dialpad: the user's own one-click sites. */
  saveLink(input: { url: string; title?: string }): Promise<NdHomeStateView>
  removeLink(id: string): Promise<NdHomeStateView>
  revealStorage(): Promise<void>
  onChanged(listener: (state: NdHomeStateView) => void): () => void
}

export const ND_EXTENSIONS_IPC = {
  state: 'nd-ext:state',
  installLocal: 'nd-ext:install-local',
  installFromPath: 'nd-ext:install-path',
  installAvailable: 'nd-ext:install-available',
  exportStarterKit: 'nd-ext:export-starter-kit',
  update: 'nd-ext:update',
  rollback: 'nd-ext:rollback',
  uninstall: 'nd-ext:uninstall',
  setActivation: 'nd-ext:activation',
  setSetting: 'nd-ext:setting',
  revokeGrant: 'nd-ext:grant:revoke',
  commands: 'nd-ext:commands',
  invoke: 'nd-ext:invoke',
  view: 'nd-ext:view',
  closeWebView: 'nd-ext:webview:close',
  approve: 'nd-ext:approve',
  deny: 'nd-ext:deny',
  changedEvent: 'nd-ext:changed',
  browserFocusEvent: 'nd-ext:browser-focus',
} as const

export const ND_HOME_IPC = {
  state: 'nd-home:state',
  noteCreate: 'nd-home:note:create',
  noteUpdate: 'nd-home:note:update',
  noteDelete: 'nd-home:note:delete',
  noteSearch: 'nd-home:note:search',
  captureScreen: 'nd-home:capture:screen',
  captureArea: 'nd-home:capture:area',
  captureRead: 'nd-home:capture:read',
  captureDelete: 'nd-home:capture:delete',
  captureAttach: 'nd-home:capture:attach',
  chatEnsure: 'nd-home:chat:ensure',
  chatBind: 'nd-home:chat:bind',
  chatTitle: 'nd-home:chat:title',
  linkSave: 'nd-home:link:save',
  linkRemove: 'nd-home:link:remove',
  reveal: 'nd-home:reveal',
  changedEvent: 'nd-home:changed',
} as const
