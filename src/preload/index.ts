import './design.js'
import './organization.js'
import './local-runtime.js'
import './terminal.js'
import { contextBridge, ipcRenderer } from 'electron'
import { CAPABILITIES_IPC, type CapabilityAssignmentSnapshot, type CapabilityKind, type CapabilitySubjectType } from '../shared/capabilities.js'
import {
  BROWSER_COMPANION_IPC,
  type BrowserCompanionLeaseScope,
  type BrowserCompanionState,
  type BrowserTabLease,
} from '../shared/browser-companion.js'
import {
  BROWSER_PLATFORM_IPC,
  type BrowserCredentialSummary,
  type BrowserExtensionRecord,
  type BrowserHistoryEntry,
  type BrowserPlatformState,
  type BrowserSelection,
  type BrowserSitePermission,
  type BrowserSiteToolDescriptor,
  type BrowserTabDescriptor,
} from '../shared/browser-platform.js'
import { IPC, type DesktopApi, type ModelProvider } from '../shared/contracts.js'
import { EXTENSIONS_IPC, type AgentExtensionManifest, type ExtensionsDesktopApi } from '../shared/extensions.js'
import {
  ND_EXTENSIONS_IPC,
  ND_HOME_IPC,
  type NdCaptureResultView,
  type NdExtensionsDesktopApi,
  type NdExtensionsStateView,
  type NdHomeDesktopApi,
  type NdHomeNoteView,
  type NdHomeStateView,
  type NdInvocationRequest,
  type NdInvocationResult,
  type NdScreenRect,
  type NdViewData,
  type NdBrowserFocusEvent,
} from '../shared/nd-invocations.js'
import { USAGE_IPC, type UsageDesktopApi, type UsageScope, type UsageSummary } from '../shared/usage.js'
import {
  WORKFLOW_PLUGINS_IPC,
  type WorkflowDetectionPreview,
  type WorkflowPluginInstallSource,
  type WorkflowPluginsDesktopApi,
  type WorkflowPluginsState,
  type WorkflowProjectView,
} from '../shared/workflow-plugins.js'

const extensionsApi: ExtensionsDesktopApi = {
  list: () => ipcRenderer.invoke(EXTENSIONS_IPC.list),
  save: (manifest: AgentExtensionManifest) => ipcRenderer.invoke(EXTENSIONS_IPC.save, manifest),
  remove: (id: string) => ipcRenderer.invoke(EXTENSIONS_IPC.remove, id),
  resetDemos: () => ipcRenderer.invoke(EXTENSIONS_IPC.resetDemos),
  preview: (id: string) => ipcRenderer.invoke(EXTENSIONS_IPC.preview, id),
  runDemo: (id: string, engineId?: string, providerId?: string) => ipcRenderer.invoke(EXTENSIONS_IPC.runDemo, id, engineId, providerId),
  onChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, extensions: AgentExtensionManifest[]) => listener(extensions)
    ipcRenderer.on(EXTENSIONS_IPC.changedEvent, handler)
    return () => ipcRenderer.removeListener(EXTENSIONS_IPC.changedEvent, handler)
  },
}

const workflowPluginsApi: WorkflowPluginsDesktopApi = {
  list: () => ipcRenderer.invoke(WORKFLOW_PLUGINS_IPC.list) as Promise<WorkflowPluginsState>,
  install: (source: WorkflowPluginInstallSource) => ipcRenderer.invoke(WORKFLOW_PLUGINS_IPC.install, source) as Promise<WorkflowPluginsState>,
  remove: (pluginId: string) => ipcRenderer.invoke(WORKFLOW_PLUGINS_IPC.remove, pluginId) as Promise<WorkflowPluginsState>,
  detect: (companyId: string, projectId: string, pluginId?: string) =>
    ipcRenderer.invoke(WORKFLOW_PLUGINS_IPC.detect, companyId, projectId, pluginId) as Promise<WorkflowDetectionPreview[]>,
  enable: (companyId: string, projectId: string, pluginId: string) => ipcRenderer.invoke(WORKFLOW_PLUGINS_IPC.enable, companyId, projectId, pluginId) as Promise<WorkflowPluginsState>,
  disable: (companyId: string, projectId: string, pluginId: string) => ipcRenderer.invoke(WORKFLOW_PLUGINS_IPC.disable, companyId, projectId, pluginId) as Promise<WorkflowPluginsState>,
  refresh: (companyId: string, projectId: string) => ipcRenderer.invoke(WORKFLOW_PLUGINS_IPC.refresh, companyId, projectId) as Promise<WorkflowPluginsState>,
  snapshot: (companyId: string, projectId: string) => ipcRenderer.invoke(WORKFLOW_PLUGINS_IPC.snapshot, companyId, projectId) as Promise<WorkflowProjectView>,
  onChanged: (listener: (state: WorkflowPluginsState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: WorkflowPluginsState) => listener(state)
    ipcRenderer.on(WORKFLOW_PLUGINS_IPC.changedEvent, handler)
    return () => ipcRenderer.removeListener(WORKFLOW_PLUGINS_IPC.changedEvent, handler)
  },
}

const usageApi: UsageDesktopApi = {
  summary: (scope?: UsageScope, id?: string, since?: number) =>
    ipcRenderer.invoke(USAGE_IPC.summary, scope, id, since) as Promise<UsageSummary>,
}

const ndExtensionsApi: NdExtensionsDesktopApi = {
  state: () => ipcRenderer.invoke(ND_EXTENSIONS_IPC.state) as Promise<NdExtensionsStateView>,
  installLocal: () => ipcRenderer.invoke(ND_EXTENSIONS_IPC.installLocal) as Promise<NdExtensionsStateView | null>,
  installFromPath: (path: string) => ipcRenderer.invoke(ND_EXTENSIONS_IPC.installFromPath, path) as Promise<NdExtensionsStateView>,
  installAvailable: (extensionId: string) => ipcRenderer.invoke(ND_EXTENSIONS_IPC.installAvailable, extensionId) as Promise<NdExtensionsStateView>,
  exportStarterKit: () => ipcRenderer.invoke(ND_EXTENSIONS_IPC.exportStarterKit) as Promise<{ saved: boolean; path?: string } | null>,
  update: (extensionId: string, sourcePath?: string) => ipcRenderer.invoke(ND_EXTENSIONS_IPC.update, extensionId, sourcePath) as Promise<NdExtensionsStateView>,
  rollback: (extensionId: string) => ipcRenderer.invoke(ND_EXTENSIONS_IPC.rollback, extensionId) as Promise<NdExtensionsStateView>,
  uninstall: (extensionId: string) => ipcRenderer.invoke(ND_EXTENSIONS_IPC.uninstall, extensionId) as Promise<NdExtensionsStateView>,
  setActivation: (extensionId, context, enabled) => ipcRenderer.invoke(ND_EXTENSIONS_IPC.setActivation, extensionId, context, enabled) as Promise<NdExtensionsStateView>,
  setSetting: (extensionId, context, key, value) => ipcRenderer.invoke(ND_EXTENSIONS_IPC.setSetting, extensionId, context, key, value) as Promise<NdExtensionsStateView>,
  revokeGrant: (grantId: string) => ipcRenderer.invoke(ND_EXTENSIONS_IPC.revokeGrant, grantId) as Promise<NdExtensionsStateView>,
  commands: (context) => ipcRenderer.invoke(ND_EXTENSIONS_IPC.commands, context),
  invoke: (request: NdInvocationRequest) => ipcRenderer.invoke(ND_EXTENSIONS_IPC.invoke, request) as Promise<NdInvocationResult>,
  loadView: (extensionId: string, viewId: string, context) => ipcRenderer.invoke(ND_EXTENSIONS_IPC.view, extensionId, viewId, context) as Promise<NdViewData>,
  closeWebView: (token: string) => ipcRenderer.invoke(ND_EXTENSIONS_IPC.closeWebView, token) as Promise<void>,
  approve: (approvalId: string, remember?: boolean) => ipcRenderer.invoke(ND_EXTENSIONS_IPC.approve, approvalId, remember) as Promise<NdInvocationResult>,
  deny: (approvalId: string) => ipcRenderer.invoke(ND_EXTENSIONS_IPC.deny, approvalId) as Promise<void>,
  onChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: NdExtensionsStateView) => listener(state)
    ipcRenderer.on(ND_EXTENSIONS_IPC.changedEvent, handler)
    return () => ipcRenderer.removeListener(ND_EXTENSIONS_IPC.changedEvent, handler)
  },
  onBrowserFocus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, focus: NdBrowserFocusEvent) => listener(focus)
    ipcRenderer.on(ND_EXTENSIONS_IPC.browserFocusEvent, handler)
    return () => ipcRenderer.removeListener(ND_EXTENSIONS_IPC.browserFocusEvent, handler)
  },
}

const homeApi: NdHomeDesktopApi = {
  state: () => ipcRenderer.invoke(ND_HOME_IPC.state) as Promise<NdHomeStateView>,
  createNote: (input) => ipcRenderer.invoke(ND_HOME_IPC.noteCreate, input) as Promise<NdHomeStateView>,
  updateNote: (id, input) => ipcRenderer.invoke(ND_HOME_IPC.noteUpdate, id, input) as Promise<NdHomeStateView>,
  deleteNote: (id) => ipcRenderer.invoke(ND_HOME_IPC.noteDelete, id) as Promise<NdHomeStateView>,
  searchNotes: (query) => ipcRenderer.invoke(ND_HOME_IPC.noteSearch, query) as Promise<NdHomeNoteView[]>,
  captureScreen: () => ipcRenderer.invoke(ND_HOME_IPC.captureScreen) as Promise<NdCaptureResultView>,
  captureArea: (rect: NdScreenRect) => ipcRenderer.invoke(ND_HOME_IPC.captureArea, rect) as Promise<NdCaptureResultView | null>,
  readCapture: (id) => ipcRenderer.invoke(ND_HOME_IPC.captureRead, id) as Promise<NdCaptureResultView | null>,
  deleteCapture: (id) => ipcRenderer.invoke(ND_HOME_IPC.captureDelete, id) as Promise<NdHomeStateView>,
  attachCapture: (id, sessionId) => ipcRenderer.invoke(ND_HOME_IPC.captureAttach, id, sessionId) as Promise<NdHomeStateView>,
  ensureChat: (context) => ipcRenderer.invoke(ND_HOME_IPC.chatEnsure, context),
  bindChat: (chatId, sessionId) => ipcRenderer.invoke(ND_HOME_IPC.chatBind, chatId, sessionId),
  setChatTitle: (sessionId, title) => ipcRenderer.invoke(ND_HOME_IPC.chatTitle, sessionId, title) as Promise<NdHomeStateView>,
  saveLink: (input) => ipcRenderer.invoke(ND_HOME_IPC.linkSave, input) as Promise<NdHomeStateView>,
  removeLink: (id) => ipcRenderer.invoke(ND_HOME_IPC.linkRemove, id) as Promise<NdHomeStateView>,
  revealStorage: () => ipcRenderer.invoke(ND_HOME_IPC.reveal) as Promise<void>,
  onChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: NdHomeStateView) => listener(state)
    ipcRenderer.on(ND_HOME_IPC.changedEvent, handler)
    return () => ipcRenderer.removeListener(ND_HOME_IPC.changedEvent, handler)
  },
}

const api: DesktopApi = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    restart: () => ipcRenderer.invoke(IPC.appRestart),
  },
  capabilities: {
    providers: () => ipcRenderer.invoke(CAPABILITIES_IPC.providers),
    assignments: () => ipcRenderer.invoke(CAPABILITIES_IPC.assignments),
    assign: (subjectType: CapabilitySubjectType, subjectId: string, kind: CapabilityKind, providerId: string) =>
      ipcRenderer.invoke(CAPABILITIES_IPC.assign, subjectType, subjectId, kind, providerId) as Promise<CapabilityAssignmentSnapshot>,
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, assignments: CapabilityAssignmentSnapshot) => listener(assignments)
      ipcRenderer.on(CAPABILITIES_IPC.changedEvent, handler)
      return () => ipcRenderer.removeListener(CAPABILITIES_IPC.changedEvent, handler)
    },
    statuses: () => ipcRenderer.invoke(CAPABILITIES_IPC.statuses),
    checkSetup: (providerId: string) => ipcRenderer.invoke(CAPABILITIES_IPC.checkSetup, providerId),
    setup: (providerId: string, values: Record<string, string>) => ipcRenderer.invoke(CAPABILITIES_IPC.setup, providerId, values),
    verify: (providerId: string) => ipcRenderer.invoke(CAPABILITIES_IPC.verify, providerId),
    setEnabled: (providerId: string, enabled: boolean) => ipcRenderer.invoke(CAPABILITIES_IPC.setEnabled, providerId, enabled),
    onStatusChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, statuses: Parameters<typeof listener>[0]) => listener(statuses)
      ipcRenderer.on(CAPABILITIES_IPC.statusChangedEvent, handler)
      return () => ipcRenderer.removeListener(CAPABILITIES_IPC.statusChangedEvent, handler)
    },
  },
  window: {
    setFloatMode: (enabled) => ipcRenderer.invoke(IPC.windowSetFloatMode, enabled),
    resizeFloatWindow: (width, height) => ipcRenderer.invoke(IPC.windowResizeFloatWindow, width, height),
    moveFloatWindow: (deltaX, deltaY) => ipcRenderer.invoke(IPC.windowMoveFloatWindow, deltaX, deltaY),
    setCaptureOverlay: (active) => ipcRenderer.invoke(IPC.windowSetCaptureOverlay, active),
    onFloatMode: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, enabled: boolean) => listener(enabled)
      ipcRenderer.on(IPC.windowFloatModeEvent, handler)
      return () => ipcRenderer.removeListener(IPC.windowFloatModeEvent, handler)
    },
    onQuickLauncher: (listener) => {
      const handler = () => listener()
      ipcRenderer.on(IPC.windowQuickLauncherEvent, handler)
      return () => ipcRenderer.removeListener(IPC.windowQuickLauncherEvent, handler)
    },
    onLauncherHandoff: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        target: Parameters<typeof listener>[0],
        text?: string,
        context?: Parameters<typeof listener>[2],
      ) => listener(target, text, context)
      ipcRenderer.on(IPC.windowLauncherHandoffEvent, handler)
      return () => ipcRenderer.removeListener(IPC.windowLauncherHandoffEvent, handler)
    },
    quickLauncherMode: () => ipcRenderer.invoke(IPC.windowQuickLauncherMode),
    setQuickLauncherMode: (mode) => ipcRenderer.invoke(IPC.windowQuickLauncherModeSet, mode),
    toggleLauncherPopup: () => ipcRenderer.invoke(IPC.windowToggleLauncherPopup),
    hideLauncherPopup: () => ipcRenderer.invoke(IPC.windowHideLauncherPopup),
    handoffLauncherPopup: (target, text, context) => ipcRenderer.invoke(IPC.windowLauncherHandoff, target, text, context),
    onCaptureRequest: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, action: Parameters<typeof listener>[0]) => listener(action)
      ipcRenderer.on(IPC.windowCaptureRequestEvent, handler)
      return () => ipcRenderer.removeListener(IPC.windowCaptureRequestEvent, handler)
    },
    captureDelay: () => ipcRenderer.invoke(IPC.windowCaptureDelay),
    setCaptureDelay: (seconds) => ipcRenderer.invoke(IPC.windowCaptureDelaySet, seconds),
    forwardCaptureRequest: (action) => ipcRenderer.invoke(IPC.windowCaptureForward, action),
    pullPendingCapture: () => ipcRenderer.invoke(IPC.windowCapturePull),
    markCaptureReady: () => ipcRenderer.invoke(IPC.windowCaptureReady),
    forwardCaptureAttach: (shot) => ipcRenderer.invoke(IPC.windowCaptureAttach, shot),
    onCaptureAttach: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, shot: Parameters<typeof listener>[0]) => listener(shot)
      ipcRenderer.on(IPC.windowCaptureAttachEvent, handler)
      return () => ipcRenderer.removeListener(IPC.windowCaptureAttachEvent, handler)
    },
  },
  media: {
    state: () => ipcRenderer.invoke(IPC.mediaState),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
      ipcRenderer.on(IPC.mediaStateEvent, handler)
      return () => ipcRenderer.removeListener(IPC.mediaStateEvent, handler)
    },
    playPause: () => ipcRenderer.invoke(IPC.mediaPlayPause),
    next: () => ipcRenderer.invoke(IPC.mediaNext),
    previous: () => ipcRenderer.invoke(IPC.mediaPrevious),
  },
  shortcuts: {
    state: () => ipcRenderer.invoke(IPC.shortcutsState),
    rebind: (id, accelerator) => ipcRenderer.invoke(IPC.shortcutsRebind, id, accelerator),
  },
  providers: {
    list: () => ipcRenderer.invoke(IPC.providersList),
    save: (providers) => ipcRenderer.invoke(IPC.providersSave, providers),
    setApiKey: (providerId, apiKey) => ipcRenderer.invoke(IPC.providersSetApiKey, providerId, apiKey),
    clearApiKey: (providerId) => ipcRenderer.invoke(IPC.providersClearApiKey, providerId),
    ping: (providerId, force) => ipcRenderer.invoke(IPC.providersPing, providerId, force),
    testCompletion: (providerId) => ipcRenderer.invoke(IPC.providersTestCompletion, providerId),
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, providers: ModelProvider[]) => listener(providers)
      ipcRenderer.on(IPC.providersChangedEvent, handler)
      return () => ipcRenderer.removeListener(IPC.providersChangedEvent, handler)
    },
  },
  skills: { detail: (selectionId) => ipcRenderer.invoke(IPC.skillsDetail, selectionId), catalog: (projectId) => ipcRenderer.invoke(IPC.skillsCatalog, projectId) },
  engines: {
    list: () => ipcRenderer.invoke(IPC.enginesList),
    assignments: () => ipcRenderer.invoke(IPC.enginesAssignments),
    assign: (agentId, engineId) => ipcRenderer.invoke(IPC.enginesAssign, agentId, engineId),
    sessions: () => ipcRenderer.invoke(IPC.enginesSessions),
    transcript: (sessionId) => ipcRenderer.invoke(IPC.enginesTranscript, sessionId),
    models: (engineId) => ipcRenderer.invoke(IPC.enginesModels, engineId),
  },
  zcodeConfig: {
    read: () => ipcRenderer.invoke(IPC.zcodeConfigRead),
    write: (update) => ipcRenderer.invoke(IPC.zcodeConfigWrite, update),
  },
  sessions: {
    setArchived: (sessionId, archived) => ipcRenderer.invoke(IPC.sessionsSetArchived, sessionId, archived),
    setArchivedMany: (sessionIds, archived) => ipcRenderer.invoke(IPC.sessionsSetArchivedMany, sessionIds, archived),
  },
  capture: {
    inspectApp: (copyToClipboard, scope, options) => ipcRenderer.invoke(IPC.captureInspectApp, copyToClipboard, scope, options),
    forComposer: (scope, options) => ipcRenderer.invoke(IPC.captureForComposer, scope, options),
    inspectElement: (scope) => ipcRenderer.invoke(IPC.captureInspectElement, scope),
    stageElement: (element, targetTitle, pickId) => ipcRenderer.invoke(IPC.captureStageElement, element, targetTitle, pickId),
    elementAttachments: () => ipcRenderer.invoke(IPC.captureElementAttachments),
    removeElement: (id) => ipcRenderer.invoke(IPC.captureRemoveElement, id),
    copyElementContext: (pickId) => ipcRenderer.invoke(IPC.captureCopyElementContext, pickId),
    copyElementShot: (pickId) => ipcRenderer.invoke(IPC.captureCopyElementShot, pickId),
  },
  chatGptWeb: {
    getProjectBinding: (workspaceRoot) => ipcRenderer.invoke(IPC.chatGptWebProjectGet, workspaceRoot),
    setProjectBinding: (workspaceRoot, input) => ipcRenderer.invoke(IPC.chatGptWebProjectSet, workspaceRoot, input),
    clearProjectBinding: (workspaceRoot) => ipcRenderer.invoke(IPC.chatGptWebProjectClear, workspaceRoot),
  },
  browserCompanion: {
    state: () => ipcRenderer.invoke(BROWSER_COMPANION_IPC.state) as Promise<BrowserCompanionState>,    acquireLease: (connectionId: string, tabId: number, ownerId: string, scope?: BrowserCompanionLeaseScope) =>
      ipcRenderer.invoke(BROWSER_COMPANION_IPC.acquireLease, connectionId, tabId, ownerId, scope) as Promise<BrowserTabLease>,
    releaseLease: (leaseId: string) => ipcRenderer.invoke(BROWSER_COMPANION_IPC.releaseLease, leaseId) as Promise<boolean>,
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: BrowserCompanionState) => listener(state)
      ipcRenderer.on(BROWSER_COMPANION_IPC.changedEvent, handler)
      return () => ipcRenderer.removeListener(BROWSER_COMPANION_IPC.changedEvent, handler)
    },
  },
  browserPlatform: {
    state: () => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.state) as Promise<BrowserPlatformState>,
    select: (selection: BrowserSelection) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.select, selection) as Promise<BrowserPlatformState>,
    createTab: (targetId?: string, url?: string) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.createTab, targetId, url) as Promise<BrowserTabDescriptor>,
    activateTab: (targetId: string, tabId: string) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.activateTab, targetId, tabId) as Promise<BrowserTabDescriptor>,
    closeTab: (targetId: string, tabId: string) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.closeTab, targetId, tabId) as Promise<boolean>,
    history: (targetId?: string) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.history, targetId) as Promise<BrowserHistoryEntry[]>,
    clearBrowserData: (input: { targetId?: string; origin?: string; history?: boolean }) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.clearData, input) as Promise<void>,
    cancelDownload: (downloadId: string) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.cancelDownload, downloadId) as Promise<boolean>,
    openDownload: (downloadId: string) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.openDownload, downloadId) as Promise<boolean>,
    revealDownload: (downloadId: string) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.revealDownload, downloadId) as Promise<boolean>,
    clearFinishedDownloads: () => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.clearFinishedDownloads) as Promise<number>,
    installExtension: () => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.installExtension) as Promise<BrowserExtensionRecord | null>,
    setExtensionEnabled: (extensionId: string, enabled: boolean) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.extensionEnabled, extensionId, enabled) as Promise<BrowserExtensionRecord[]>,
    removeExtension: (extensionId: string) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.removeExtension, extensionId) as Promise<BrowserExtensionRecord[]>,
    reloadExtensions: () => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.reloadExtensions) as Promise<BrowserExtensionRecord[]>,
    setDeveloperMode: (enabled: boolean) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.developerMode, enabled) as Promise<BrowserPlatformState>,
    setBrowserUseEnabled: (enabled: boolean) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.browserUseEnabled, enabled) as Promise<BrowserPlatformState>,
    installCatalogExtension: (catalogId: string) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.installCatalogExtension, catalogId) as Promise<BrowserExtensionRecord | null>,
    openCatalogExtension: (catalogId: string) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.openCatalogExtension, catalogId) as Promise<BrowserTabDescriptor>,
    showExtensionPopup: (extensionId: string) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.showExtensionPopup, extensionId) as Promise<BrowserPlatformState>,
    closeExtensionPopup: () => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.closeExtensionPopup) as Promise<BrowserPlatformState>,
    saveCredential: (input: { origin: string; username: string; password: string; label?: string }) =>
      ipcRenderer.invoke(BROWSER_PLATFORM_IPC.saveCredential, input) as Promise<BrowserCredentialSummary>,
    removeCredential: (credentialId: string) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.removeCredential, credentialId) as Promise<boolean>,
    autofillCredential: (credentialId: string, targetId?: string, tabId?: string) =>
      ipcRenderer.invoke(BROWSER_PLATFORM_IPC.autofillCredential, credentialId, targetId, tabId) as Promise<{ ok: true; credentialId: string; username: string }>,
    siteTools: (targetId?: string, tabId?: string) =>
      ipcRenderer.invoke(BROWSER_PLATFORM_IPC.siteTools, targetId, tabId) as Promise<BrowserSiteToolDescriptor[]>,
    setSitePermission: (origin: string, permission: string, effect: 'allow' | 'deny') =>
      ipcRenderer.invoke(BROWSER_PLATFORM_IPC.setSitePermission, origin, permission, effect) as Promise<BrowserSitePermission>,
    resolveApproval: (approvalId: string, allowed: boolean) => ipcRenderer.invoke(BROWSER_PLATFORM_IPC.resolveApproval, approvalId, allowed) as Promise<boolean>,
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: BrowserPlatformState) => listener(state)
      ipcRenderer.on(BROWSER_PLATFORM_IPC.changedEvent, handler)
      return () => ipcRenderer.removeListener(BROWSER_PLATFORM_IPC.changedEvent, handler)
    },
  },
  ndExtensions: ndExtensionsApi,
  home: homeApi,
  browser: {
    state: () => ipcRenderer.invoke(IPC.browserState),
    setBounds: (bounds) => ipcRenderer.invoke(IPC.browserSetBounds, bounds),
    setVisible: (visible) => ipcRenderer.invoke(IPC.browserSetVisible, visible),
    navigate: (url) => ipcRenderer.invoke(IPC.browserNavigate, url),
    back: () => ipcRenderer.invoke(IPC.browserBack),
    forward: () => ipcRenderer.invoke(IPC.browserForward),
    reload: () => ipcRenderer.invoke(IPC.browserReload),
    snapshot: () => ipcRenderer.invoke(IPC.browserSnapshot),
    setInspectMode: (enabled) => ipcRenderer.invoke(IPC.browserSetInspectMode, enabled),
    clearSelection: () => ipcRenderer.invoke(IPC.browserClearSelection),
    setAnnotationMode: (enabled) => ipcRenderer.invoke(IPC.browserSetAnnotationMode, enabled),
    clearAnnotation: () => ipcRenderer.invoke(IPC.browserClearAnnotation),
    openExternal: (url) => ipcRenderer.invoke(IPC.browserOpenExternal, url),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
      ipcRenderer.on(IPC.browserStateEvent, handler)
      return () => ipcRenderer.removeListener(IPC.browserStateEvent, handler)
    },
  },
  workspace: {
    state: () => ipcRenderer.invoke(IPC.workspaceState),
    pick: () => ipcRenderer.invoke(IPC.workspacePick),
    pickPath: (options) => ipcRenderer.invoke(IPC.workspacePickPath, options),
    setRoot: (path) => ipcRenderer.invoke(IPC.workspaceSetRoot, path),
    list: (relativePath) => ipcRenderer.invoke(IPC.workspaceList, relativePath),
    read: (relativePath) => ipcRenderer.invoke(IPC.workspaceRead, relativePath),
    suggest: (query) => ipcRenderer.invoke(IPC.workspaceSuggest, query),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
      ipcRenderer.on(IPC.workspaceStateEvent, handler)
      return () => ipcRenderer.removeListener(IPC.workspaceStateEvent, handler)
    },
    registry: () => ipcRenderer.invoke(IPC.workspaceRegistry),
    addSaved: () => ipcRenderer.invoke(IPC.workspaceAddSaved),
    removeSaved: (id) => ipcRenderer.invoke(IPC.workspaceRemoveSaved, id),
    openSaved: (id) => ipcRenderer.invoke(IPC.workspaceOpenSaved, id),
  },
  harness: {
    status: () => ipcRenderer.invoke(IPC.harnessStatus),
    run: (prompt, options) => ipcRenderer.invoke(IPC.harnessRun, prompt, options),
    stop: () => ipcRenderer.invoke(IPC.harnessStop),
    stopSession: (sessionId) => ipcRenderer.invoke(IPC.harnessStopSession, sessionId),
    getPermissionMode: () => ipcRenderer.invoke(IPC.harnessPermissionGet),
    setPermissionMode: (mode) => ipcRenderer.invoke(IPC.harnessPermissionSet, mode),
    onStatus: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, status: Parameters<typeof listener>[0]) => listener(status)
      ipcRenderer.on(IPC.harnessStatusEvent, handler)
      return () => ipcRenderer.removeListener(IPC.harnessStatusEvent, handler)
    },
  },
  dsh: {
    rpc: (method, payload) => ipcRenderer.invoke(IPC.dshRpc, method, payload),
    respond: (rpcId, value) => ipcRenderer.invoke(IPC.dshRespond, rpcId, value),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, frame: Parameters<typeof listener>[0]) => listener(frame)
      ipcRenderer.on(IPC.dshEvent, handler)
      return () => ipcRenderer.removeListener(IPC.dshEvent, handler)
    },
  },
  surface: {
    state: () => ipcRenderer.invoke(IPC.surfaceState),
    set: (surface) => ipcRenderer.invoke(IPC.surfaceSet, surface),
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
      ipcRenderer.on(IPC.surfaceChangedEvent, handler)
      return () => ipcRenderer.removeListener(IPC.surfaceChangedEvent, handler)
    },
  },
  workspaceProfile: {
    get: () => ipcRenderer.invoke(IPC.workspaceProfileGet),
    set: (profile) => ipcRenderer.invoke(IPC.workspaceProfileSet, profile),
  },
  dshView: {
    setBounds: (bounds) => ipcRenderer.invoke(IPC.dshViewSetBounds, bounds),
    setVisible: (visible) => ipcRenderer.invoke(IPC.dshViewSetVisible, visible),
    reload: () => ipcRenderer.invoke(IPC.dshViewReload),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
      ipcRenderer.on(IPC.dshViewStateEvent, handler)
      return () => ipcRenderer.removeListener(IPC.dshViewStateEvent, handler)
    },
  },
  theme: {
    state: () => ipcRenderer.invoke(IPC.themeState),
    set: (mode) => ipcRenderer.invoke(IPC.themeSet, mode),
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
      ipcRenderer.on(IPC.themeChangedEvent, handler)
      return () => ipcRenderer.removeListener(IPC.themeChangedEvent, handler)
    },
  },
  git: {
    configureRemote: (root, name, url) => ipcRenderer.invoke(IPC.gitConfigureRemote, root, name, url),
    connectGitHub: (root, name, url) => ipcRenderer.invoke(IPC.gitConnectGitHub, root, name, url),
    state: () => ipcRenderer.invoke(IPC.gitState),
    refresh: () => ipcRenderer.invoke(IPC.gitRefresh),
    stage: (relativePaths) => ipcRenderer.invoke(IPC.gitStage, relativePaths),
    unstage: (relativePaths) => ipcRenderer.invoke(IPC.gitUnstage, relativePaths),
    discard: (relativePaths) => ipcRenderer.invoke(IPC.gitDiscard, relativePaths),
    commit: (message) => ipcRenderer.invoke(IPC.gitCommit, message),
    diff: (relativePath, staged) => ipcRenderer.invoke(IPC.gitDiff, relativePath, staged),
    checkout: (branch) => ipcRenderer.invoke(IPC.gitCheckout, branch),
    createBranch: (name) => ipcRenderer.invoke(IPC.gitCreateBranch, name),
    push: () => ipcRenderer.invoke(IPC.gitPush),
    pull: () => ipcRenderer.invoke(IPC.gitPull),
    fetch: () => ipcRenderer.invoke(IPC.gitFetch),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
      ipcRenderer.on(IPC.gitStateEvent, handler)
      return () => ipcRenderer.removeListener(IPC.gitStateEvent, handler)
    },
  },
  qa: {
    state: () => ipcRenderer.invoke(IPC.qaState),
    run: (suite) => ipcRenderer.invoke(IPC.qaRun, suite),
    stop: () => ipcRenderer.invoke(IPC.qaStop),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
      ipcRenderer.on(IPC.qaStateEvent, handler)
      return () => ipcRenderer.removeListener(IPC.qaStateEvent, handler)
    },
    onOutput: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, chunk: Parameters<typeof listener>[0]) => listener(chunk)
      ipcRenderer.on(IPC.qaOutputEvent, handler)
      return () => ipcRenderer.removeListener(IPC.qaOutputEvent, handler)
    },
  },
}

contextBridge.exposeInMainWorld('ndDsh', api)
contextBridge.exposeInMainWorld('ndDshExtensions', extensionsApi)
contextBridge.exposeInMainWorld('ndDshWorkflowPlugins', workflowPluginsApi)
contextBridge.exposeInMainWorld('ndDshUsage', usageApi)
