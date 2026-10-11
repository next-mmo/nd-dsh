import { app, clipboard, dialog, ipcMain, nativeImage, protocol, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { asNdContext, contextKey, type NdContext } from '../../shared/nd-context.js'
import { ND_HOST_METHODS, manifestPermissionIssues, validateNdExtensionManifest, type NdHostMethod } from '../../shared/extension-package.js'
import {
  ND_EXTENSIONS_IPC,
  ND_HOME_IPC,
  type NdExtensionsStateView,
  type NdAvailablePackageView,
  type NdInvocationRequest,
  type NdBrowserFocusEvent,
} from '../../shared/nd-invocations.js'
import type { OrganizationMutation, OrganizationSnapshot } from '../../shared/organization.js'
import { BUILTIN_EXTENSION_PACKAGES, defaultActivationContexts, WALLPAPER_MANAGER_ID } from '../../shared/builtin-extension-packages.js'
import { captureDisplayUnderPointer, captureScreenRegion } from '../capture/app-capture.js'
import {
  applyWallpaperFromFolder,
  cycleWallpaper,
  getActiveWallpaperState,
  listWallpapersInFolder,
  normalizeWallpaperPath,
  resolveDefaultWallpaperFolder,
  resolveWallpaperFolder,
  setDesktopWallpaper,
  setActiveWallpaperState,
  type WallpaperEntry,
} from '../os/wallpaper.js'
import { WallpaperThumbnailCache, type CachedThumbnail } from '../os/wallpaper-thumbnails.js'
import {
  WallpaperLinkStore,
  addBundledWallpaperLink,
  bundledLinkFromSeed,
  bundledWallpaperLinksPath,
  collectionEntryId,
  downloadWallpaperImage,
  findCachedImage,
  linkIdForUrl,
  readWallpaperLinksBundle,
  removeBundledWallpaperLink,
  updateBundledWallpaperLink,
  writeBundledCollections,
} from '../os/wallpaper-links.js'
import { parseWallpaperLinkUrl, parseWallpaperLinksBundle, type WallpaperCollection, type WallpaperCollectionEntry, type WallpaperCollectionItemInput, type WallpaperLink } from '../../shared/wallpaper-links.js'
import type { CoreMedia } from '../core/core-media.js'
import type { CoreClipboard } from '../core/core-clipboard.js'
import type { CoreVault } from '../core/core-vault.js'
import { ProcessInventory } from '../os/process-inventory.js'
import { BUILTIN_BROWSER_TARGET_ID, type BrowserController } from '../browser/browser-controller.js'
import type { BrowserPlatformService } from '../browser-platform/browser-platform-service.js'
import type { WorkflowService } from '../workflows/workflow-service.js'
import type { HomeStore } from '../home/home-store.js'
import type { ExtensionPackageStore } from './package-store.js'
import type { InvocationBroker, NdOrganizationPort } from './invocation-broker.js'
import type { InvocationStateStore } from './invocation-state.js'
import type { NativeHostRegistry, NdHostCallContext } from './native-host.js'
import { NdTranslateService, type TranslateBrowserPort } from './translate-service.js'
import { translateWithLlm } from './translate-llm.js'
import { TranslateHistoryStore } from './translate-history-store.js'
import {
  attachClipboardHistory,
  capsFromSettings,
  CLIPBOARD_HISTORY_ID,
  type ClipboardHistoryAttachment,
  type ClipboardHistoryStore,
} from './clipboard-history.js'
import { starterKitFiles } from './starter-kit.js'
import { createZipFile } from './zip.js'
import { promptVaultEntry, type VaultPromptValues } from './vault-prompt.js'
import { ExtensionWebViewAssets } from './webview-assets.js'
import { TicTacToeStatsStore, asTicTacToeOutcome } from './tic-tac-toe-store.js'
import { MiniBrowserStore, browserTabUrl, asMiniEntryId, miniTabTitle, legacyYouTubeQueuePath, type MiniLink } from './mini-browser-store.js'
import { ND_TRANSLATE_ID, ND_TRANSLATE_MAX_TEXT, isLlmProvider } from '../../shared/nd-translate.js'
import { ND_WEBVIEW_URL_SCHEME } from '../../shared/extension-webview.js'
import type { ProviderStore } from '../providers.js'

export interface NdOrganizationPortFull extends NdOrganizationPort {
  mutate(mutation: OrganizationMutation): Promise<unknown>
  policy(companyId: string, action: string): Promise<'allow' | 'ask' | 'deny'>
}

export interface NdIpcDependencies {
  window: BrowserWindow
  /** The launcher popup renderer; admitted for launcher-facing extension channels only. */
  launcherPopup?: () => BrowserWindow | null
  home: HomeStore
  packages: ExtensionPackageStore
  state: InvocationStateStore
  broker: InvocationBroker
  host: NativeHostRegistry
  organization: NdOrganizationPortFull
  browser: Pick<BrowserController, 'navigate'> & TranslateBrowserPort
  /** Multi-tab platform surface for extension hosts that manage real browser tabs. */
  browserPlatform?: Pick<BrowserPlatformService, 'createTab' | 'activateTab' | 'closeTab' | 'tabs'>
  providers: ProviderStore
  workflow: Pick<WorkflowService, 'projectView' | 'refresh'>
  /**
   * nd-core's native image and wallpaper surface. Optional because the sidecar
   * can be unavailable; the wallpaper handlers fail closed without it rather
   * than silently doing nothing.
   */
  media?: CoreMedia
  /**
   * nd-core's clipboard surface (read, write, watcher). Optional for the same
   * reason; the clipboard.read and clipboard.write host methods fall back to
   * Electron's in-process clipboard, and history recording stays off.
   */
  coreClipboard?: CoreClipboard
  /**
   * nd-core's encrypted local password vault. Optional like the other sidecar
   * surfaces; the vault host methods fail closed without it.
   */
  coreVault?: CoreVault
  /** Notified after ND Home records change, so other services can re-derive views. */
  onHomeChanged?: () => void
}

const NOTE_TITLE_MAX = 80
const MAX_OPEN_TARGETS = 1
const QUIT_PROCESS_ID = 'nd.quit-process'
const PASSWORD_VAULT_ID = 'nd.password-vault'
const TIC_TAC_TOE_ID = 'nd.tic-tac-toe'
const MINI_BROWSER_ID = 'nd.mini-browser'

/**
 * The bundled on-demand packages. Not built-ins: nothing here is registered or
 * activated automatically, and each is installed only by explicit user action
 * through the catalog. Clipboard History in particular must never appear in
 * `BUILTIN_EXTENSION_PACKAGES` — a clipboard watcher that starts by default is
 * surveillance, not a feature.
 */
const AVAILABLE_PACKAGES: readonly { id: string; path: () => string }[] = [
  { id: ND_TRANSLATE_ID, path: translatePackagePath },
  { id: QUIT_PROCESS_ID, path: quitProcessPackagePath },
  { id: CLIPBOARD_HISTORY_ID, path: clipboardHistoryPackagePath },
  { id: PASSWORD_VAULT_ID, path: passwordVaultPackagePath },
  // Discovery is dev-only for this one: the package (with its vendored
  // three.js) is fully external and is never staged into packaged releases,
  // where it would only ever show as unavailable. Developers install it from
  // Discover; packaged users install it from a folder.
  ...(app.isPackaged ? [] : [{ id: TIC_TAC_TOE_ID, path: ticTacToePackagePath }, { id: MINI_BROWSER_ID, path: miniBrowserPackagePath }]),
]

/**
 * Bridges the auto-rotate timer (wired early, in the IPC layer) to the
 * rotation player (wired with the native hosts below). The player reads the
 * current play sources on every tick, so edits take effect without a resync;
 * before registration, and when nothing is playable, rotation walks the
 * default Pictures folder exactly as it always has.
 */
let applyWallpaperRotation: ((mode: 'next' | 'random' | 'previous') => Promise<unknown>) | null = null
let refreshWallpaperRotation: (() => void) | null = null

/** Linked folders: the `folders` list, falling back to the legacy single `folder`. */
function readLinkedFolders(settings: Record<string, unknown> | undefined): string[] {
  const raw = settings?.folders
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const legacy = typeof settings?.folder === 'string' ? settings.folder.trim() : ''
  return legacy ? [legacy] : []
}

/** Playback sources as `folder:<path>` / `collection:<id>` refs; empty means all linked folders. */
function readPlaySources(settings: Record<string, unknown> | undefined): string[] {
  const raw = settings?.playSources
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is string => typeof value === 'string' && /^(folder|collection):/.test(value))
}

function quitProcessPackagePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'nd-extensions', 'quit-process')
    : join(app.getAppPath(), 'extensions', 'quit-process')
}

function translatePackagePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'nd-extensions', 'translate')
    : join(app.getAppPath(), 'extensions', 'translate')
}

function clipboardHistoryPackagePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'nd-extensions', 'clipboard-history')
    : join(app.getAppPath(), 'extensions', 'clipboard-history')
}

function passwordVaultPackagePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'nd-extensions', 'password-vault')
    : join(app.getAppPath(), 'extensions', 'password-vault')
}

function ticTacToePackagePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'nd-extensions', 'tic-tac-toe')
    : join(app.getAppPath(), 'extensions', 'tic-tac-toe')
}

function miniBrowserPackagePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'nd-extensions', 'nd-mini-browser')
    : join(app.getAppPath(), 'extensions', 'nd-mini-browser')
}

/**
 * The ND extension invocation surface plus the ND Home personal surface. Every
 * handler runs in the trusted main process, is registered on narrow channels
 * admitted only from the primary renderer (or the launcher popup for the
 * launcher-facing subset), and delegates authorization to the broker.
 */
export function registerNdExtensionIpc(deps: NdIpcDependencies): () => void {
  const channels: string[] = []
  let seeded: Promise<void> | undefined
  let wallpaperTimer: NodeJS.Timeout | null = null

  /**
   * Clipboard History: store + watcher reconcile + event recorder. Exists only
   * in full when the sidecar is available; it never records unless the user
   * both activates the package and turns on `recordHistory`.
   */
  const clipboardHistory = attachClipboardHistory({
    state: deps.state,
    ...(deps.coreClipboard ? { coreClipboard: deps.coreClipboard } : {}),
    userDataDir: app.getPath('userData'),
  })
  const syncClipboardWatcher = (): void => {
    void clipboardHistory.sync().catch(() => undefined)
  }

  const syncWallpaperRotation = async (): Promise<void> => {
    if (wallpaperTimer) {
      clearInterval(wallpaperTimer)
      wallpaperTimer = null
    }
    try {
      const personalContext: NdContext = { kind: 'personal' }
      const activation = await deps.state.activation(WALLPAPER_MANAGER_ID, personalContext)
      if (!activation?.enabled) return
      const intervalMinutes = typeof activation.settings.intervalMinutes === 'number' ? activation.settings.intervalMinutes : 0
      if (intervalMinutes <= 0) return
      const mode = activation.settings.mode === 'random' ? 'random' : 'next'
      const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000
      wallpaperTimer = setInterval(() => {
        if (applyWallpaperRotation) {
          void applyWallpaperRotation(mode).catch(() => undefined)
        } else {
          void cycleWallpaper({ mode }).catch(() => undefined)
        }
      }, intervalMs)
    } catch {
      // Ignore background rotation failure
    }
  }
  refreshWallpaperRotation = () => { void syncWallpaperRotation() }

  const ensureSeeded = (): Promise<void> => {
    seeded ??= seedBuiltinPackages(deps).then(async () => {
      await refreshAvailablePackages(deps)
      void syncWallpaperRotation()
      syncClipboardWatcher()
    })
    return seeded
  }

  /**
   * Token-scoped serving of installed package UI assets for `kind: 'web'`
   * views. The scheme itself is privileged at the top of main; this handler
   * validates token, package binding, containment, type, and size per request.
   */
  const webViews = new ExtensionWebViewAssets(deps.packages)
  protocol.handle(ND_WEBVIEW_URL_SCHEME, async (request) => {
    const response = await webViews.respond(request.url)
    const body = response.body ? new Uint8Array(response.body) : null
    return new Response(body, { status: response.status, headers: response.headers })
  })

  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      assertNdSender(event, deps.window)
      await ensureSeeded()
      return listener(event, ...args)
    })
    channels.push(channel)
  }

  // The launcher popup is a separate sandboxed renderer; it may list and run
  // contributions but reaches no management or Home channel.
  const handleLauncherSurface = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.sender !== deps.window.webContents || event.senderFrame !== deps.window.webContents.mainFrame) {
        const popup = deps.launcherPopup?.() ?? null
        if (!popup || popup.isDestroyed() || event.sender !== popup.webContents || event.senderFrame !== popup.webContents.mainFrame) {
          throw new Error('Rejected ND extension IPC from an untrusted renderer frame')
        }
      }
      await ensureSeeded()
      return listener(event, ...args)
    })
    channels.push(channel)
  }

  const stateView = async (): Promise<NdExtensionsStateView> => {
    const state = await deps.broker.stateView()
    return {
      ...state,
      available: await Promise.all([
        quitProcessCatalogView(state),
        translateCatalogView(state),
        clipboardHistoryCatalogView(state),
        passwordVaultCatalogView(state),
        ...(app.isPackaged ? [] : [ticTacToeCatalogView(state), miniBrowserCatalogView(state)]),
      ]),
    }
  }
  const emitState = async (): Promise<void> => {
    if (deps.window.isDestroyed()) return
    deps.window.webContents.send(ND_EXTENSIONS_IPC.changedEvent, await stateView())
  }
  const homeView = async () => deps.home.state()
  const emitHome = async (): Promise<void> => {
    if (deps.window.isDestroyed()) return
    deps.window.webContents.send(ND_HOME_IPC.changedEvent, await homeView())
  }

  const disposeNativeHost = registerNativeHostHandlers(deps, clipboardHistory)

  deps.broker.setOnApprovalRequested(() => { void emitState() })
  deps.home.setOnChanged(() => { void emitHome(); deps.onHomeChanged?.() })

  // --- Extension packages ----------------------------------------------------

  handle(ND_EXTENSIONS_IPC.state, () => stateView())

  handle(ND_EXTENSIONS_IPC.installLocal, async () => {
    const result = await dialog.showOpenDialog(deps.window, {
      title: 'Choose an extension package folder',
      properties: ['openDirectory'],
    })
    const selected = result.filePaths[0]
    if (result.canceled || !selected) return null
    await deps.packages.installFromDirectory(selected)
    await emitState()
    return stateView()
  })

  handle(ND_EXTENSIONS_IPC.installFromPath, async (_event, rawPath) => {
    await deps.packages.installFromDirectory(absolutePath(rawPath))
    await emitState()
    return stateView()
  })

  handle(ND_EXTENSIONS_IPC.exportStarterKit, async () => {
    const result = await dialog.showSaveDialog(deps.window, {
      title: 'Save extension starter kit',
      defaultPath: 'nd-extension-starter.zip',
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    })
    if (result.canceled || !result.filePath) return null
    const archive = createZipFile(starterKitFiles())
    await fs.writeFile(result.filePath, archive)
    return { saved: true, path: result.filePath }
  })

  handle(ND_EXTENSIONS_IPC.installAvailable, async (_event, extensionId) => {
    const requestedId = shortId(extensionId, 'Extension id')
    const available = AVAILABLE_PACKAGES.find((entry) => entry.id === requestedId)
    if (!available) throw new Error('Unknown available ND extension')
    const packagePath = available.path()
    if (!existsSync(join(packagePath, 'nd-extension.json'))) throw new Error('This extension is missing from this ND build')
    await deps.packages.installFromDirectory(packagePath, { expectId: requestedId })
    syncClipboardWatcher()
    await emitState()
    return stateView()
  })

  handle(ND_EXTENSIONS_IPC.update, async (_event, extensionId, rawPath) => {
    const id = shortId(extensionId, 'Extension id')
    const record = await deps.packages.record(id)
    if (!record) throw new Error(`Unknown extension package: ${id}`)
    const sourcePath = typeof rawPath === 'string' && rawPath.trim()
      ? absolutePath(rawPath)
      : record.source.kind === 'local' || record.source.kind === 'git' ? record.source.location : undefined
    if (!sourcePath) throw new Error('This package records no local source; choose the updated package folder')
    await deps.packages.installFromDirectory(sourcePath, { expectId: id })
    syncClipboardWatcher()
    await emitState()
    return stateView()
  })

  handle(ND_EXTENSIONS_IPC.rollback, async (_event, extensionId) => {
    const id = shortId(extensionId, 'Extension id')
    await deps.packages.rollback(id)
    syncClipboardWatcher()
    await emitState()
    return stateView()
  })

  handle(ND_EXTENSIONS_IPC.uninstall, async (_event, extensionId) => {
    const id = shortId(extensionId, 'Extension id')
    await deps.packages.uninstall(id)
    // Uninstall revokes activation and executable access; personal notes and
    // captures are user data and stay untouched.
    await deps.state.revokeActivationsForExtension(id)
    await deps.state.revokeGrantsForExtension(id)
    syncClipboardWatcher()
    await emitState()
    return stateView()
  })

  handle(ND_EXTENSIONS_IPC.setActivation, async (_event, extensionId, context, enabled) => {
    const id = shortId(extensionId, 'Extension id')
    const target = await deps.broker.resolveContext(asNdContext(context))
    const manifest = await deps.packages.activeManifest(id)
    if (!manifest) throw new Error(`Unknown extension package: ${id}`)
    await deps.state.setActivation(id, target, enabled === true)
    if (enabled !== true) await deps.state.revokeGrantsForExtension(id)
    if (id === WALLPAPER_MANAGER_ID) void syncWallpaperRotation()
    if (id === CLIPBOARD_HISTORY_ID) syncClipboardWatcher()
    await emitState()
    return stateView()
  })

  handle(ND_EXTENSIONS_IPC.setSetting, async (_event, extensionId, context, key, value) => {
    const id = shortId(extensionId, 'Extension id')
    const target = await deps.broker.resolveContext(asNdContext(context))
    const manifest = await deps.packages.activeManifest(id)
    if (!manifest) throw new Error(`Unknown extension package: ${id}`)
    const field = manifest.settings.find((setting) => setting.key === key)
    if (!field) throw new Error(`Unknown setting for ${manifest.name}: ${String(key)}`)
    if (typeof value !== field.type) throw new Error(`"${field.title}" must be a ${field.type}`)
    await deps.state.setSetting(id, target, field.key, value)
    if (id === WALLPAPER_MANAGER_ID) void syncWallpaperRotation()
    if (id === CLIPBOARD_HISTORY_ID) syncClipboardWatcher()
    await emitState()
    return stateView()
  })

  handle(ND_EXTENSIONS_IPC.revokeGrant, async (_event, grantId) => {
    await deps.state.revokeGrant(shortId(grantId, 'Grant id'))
    await emitState()
    return stateView()
  })

  handleLauncherSurface(ND_EXTENSIONS_IPC.commands, async (_event, context) => deps.broker.commands(await deps.broker.resolveContext(asNdContext(context))))

  handleLauncherSurface(ND_EXTENSIONS_IPC.invoke, async (_event, request) => {
    if (!request || typeof request !== 'object') throw new Error('An invocation request is required')
    // A renderer can only ever act as the user: agent authority arrives solely
    // through run credentials minted trusted-side.
    const result = await deps.broker.invoke({ ...(request as NdInvocationRequest), caller: 'user' })
    if (!result.ok && result.error?.code !== 'approval-required') await emitState()
    return result
  })

  handle(ND_EXTENSIONS_IPC.view, async (_event, extensionId, viewId, context) => {
    const data = await deps.broker.loadView(
      shortId(extensionId, 'Extension id'),
      shortId(viewId, 'View id'),
      await deps.broker.resolveContext(asNdContext(context)),
    )
    if (data.kind !== 'web' || !data.webView) return data
    const issued = await webViews.issue(data.extensionId, data.webView.entry)
    if (!issued) throw new Error('The extension view assets could not be opened')
    return { ...data, webView: { ...data.webView, url: issued.url, token: issued.token } }
  })

  handle(ND_EXTENSIONS_IPC.closeWebView, (_event, token) => {
    if (typeof token === 'string' && token) webViews.revoke(token)
  })

  handle(ND_EXTENSIONS_IPC.approve, async (_event, approvalId, remember) => {
    const result = await deps.broker.approve(shortId(approvalId, 'Approval id'), remember === true)
    await emitState()
    return result
  })

  handle(ND_EXTENSIONS_IPC.deny, async (_event, approvalId) => {
    await deps.broker.deny(shortId(approvalId, 'Approval id'))
    await emitState()
  })

  // --- ND Home ---------------------------------------------------------------

  handle(ND_HOME_IPC.state, () => homeView())

  handle(ND_HOME_IPC.noteCreate, async (_event, input) => {
    const request = asNoteInput(input)
    await deps.home.createNote({ ...request, context: request.context ?? { kind: 'personal' } })
    return homeView()
  })

  handle(ND_HOME_IPC.noteUpdate, async (_event, id, input) => {
    await deps.home.updateNote(shortId(id, 'Note id'), asNoteInput(input))
    return homeView()
  })

  handle(ND_HOME_IPC.noteDelete, async (_event, id) => {
    await deps.home.deleteNote(shortId(id, 'Note id'))
    return homeView()
  })

  handle(ND_HOME_IPC.noteSearch, (_event, query) => deps.home.searchNotes(typeof query === 'string' ? query : ''))

  handle(ND_HOME_IPC.captureScreen, async () => {
    const image = await captureDisplayUnderPointer()
    const record = await deps.home.addCapture(image, { kind: 'personal' })
    return { captureId: record.id, width: record.width, height: record.height, displayLabel: record.displayLabel, data: image.data }
  })

  handle(ND_HOME_IPC.captureArea, async (_event, rawRect) => {
    const rect = asRect(rawRect)
    if (!rect) return null
    const image = await captureScreenRegion(rect)
    const record = await deps.home.addCapture(image, { kind: 'personal' })
    return { captureId: record.id, width: record.width, height: record.height, displayLabel: record.displayLabel, data: image.data }
  })

  handle(ND_HOME_IPC.captureRead, async (_event, id) => deps.home.readCapture(shortId(id, 'Capture id')))

  handle(ND_HOME_IPC.captureDelete, async (_event, id) => {
    await deps.home.deleteCapture(shortId(id, 'Capture id'))
    return homeView()
  })

  handle(ND_HOME_IPC.captureAttach, async (_event, id, sessionId) => {
    await deps.home.attachCapture(shortId(id, 'Capture id'), shortId(sessionId, 'Session id'))
    return homeView()
  })

  handle(ND_HOME_IPC.chatEnsure, async (_event, context) => deps.home.ensureChat(await deps.broker.resolveContext(asNdContext(context))))

  handle(ND_HOME_IPC.chatBind, async (_event, chatId, sessionId) =>
    deps.home.bindChatSession(shortId(chatId, 'Chat id'), shortId(sessionId, 'Session id')))

  handle(ND_HOME_IPC.chatTitle, async (_event, sessionId, title) => {
    await deps.home.setChatTitle(shortId(sessionId, 'Session id'), typeof title === 'string' ? title : '')
    return homeView()
  })

  // Personal browser dialpad links. The store normalizes and validates the
  // address with the browser's own rules, so the renderer only sends what the
  // user typed or the address bar currently shows.
  handle(ND_HOME_IPC.linkSave, async (_event, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>
    await deps.home.saveLink({
      url: typeof record.url === 'string' ? record.url : '',
      ...(typeof record.title === 'string' ? { title: record.title } : {}),
    })
    return homeView()
  })

  handle(ND_HOME_IPC.linkRemove, async (_event, id) => {
    await deps.home.removeLink(shortId(id, 'Link id'))
    return homeView()
  })

  handle(ND_HOME_IPC.reveal, async () => {
    const root = deps.home.storageRoot()
    if (!existsSync(root)) await fs.mkdir(root, { recursive: true })
    const error = await shell.openPath(root)
    if (error) throw new Error(error)
  })

  // Seeding happens before the first state read; failures stay visible instead
  // of silently shipping a half-registered platform.
  void ensureSeeded().catch((error) => console.warn('ND built-in extension packages failed to seed:', error))

  return () => {
    disposeNativeHost.dispose()
    if (wallpaperTimer) clearInterval(wallpaperTimer)
    for (const channel of channels) ipcMain.removeHandler(channel)
    void clipboardHistory.dispose()
    deps.broker.setOnApprovalRequested(undefined)
    deps.home.setOnChanged(undefined)
    protocol.unhandle(ND_WEBVIEW_URL_SCHEME)
  }
}

/**
 * Register the allowlisted native host methods. These closures are the only
 * bridge between extension contributions and trusted services: no arbitrary
 * IPC, shell strings, or renderer code ever crosses this boundary.
 */
export function registerNativeHostHandlers(
  deps: NdIpcDependencies,
  clipboardHistory?: ClipboardHistoryAttachment,
): { dispose: () => void } {
  const { host, providers } = deps
  const organization = deps.organization
  const translator = new NdTranslateService(deps.browser)
  const history = new TranslateHistoryStore(join(app.getPath('userData'), 'nd-translate-history.json'))
  void history.initialize().catch((error) => console.warn('ND Translate history failed to load:', error))
  const media = deps.media
  const coreClipboard = deps.coreClipboard
  const coreVault = deps.coreVault
  const clipboardStore: ClipboardHistoryStore | undefined = clipboardHistory?.store
  const thumbnailCache = media ? new WallpaperThumbnailCache(media) : null
  const applyWallpaper = media
    ? async (imagePath: string): Promise<void> => { await media.setWallpaper(imagePath) }
    : undefined

  /**
   * Decode through the sidecar, never in this process. Returns only the entries
   * the sidecar could actually read, in request order, so one unreadable file
   * leaves a gap in the grid instead of failing it.
   */
  const readThumbnails = async (
    root: string,
    sources: readonly WallpaperEntry[],
    width: number,
  ): Promise<CachedThumbnail[]> => {
    if (!thumbnailCache) throw new Error('The nd-core sidecar is required to render wallpaper thumbnails')
    const found = await thumbnailCache.get(root, sources, width)
    return sources
      .map((source) => found.get(source.path))
      .filter((entry): entry is CachedThumbnail => entry !== undefined)
  }
  host.register('browser.translate', async (input, context) => {
    const requestedProvider = input && typeof input === 'object' ? (input as Record<string, unknown>).provider : undefined
    const provider = typeof requestedProvider === 'string' ? requestedProvider : 'google'
    const result = isLlmProvider(provider)
      ? await translateWithLlm(providers, input)
      : await translator.translate(input)
    if (result.status === 'translated' && result.translatedText?.trim()) {
      void history.add(contextKey(context.context), {
        text: result.text.slice(0, ND_TRANSLATE_MAX_TEXT),
        translatedText: result.translatedText.slice(0, ND_TRANSLATE_MAX_TEXT),
        sourceLanguage: result.sourceLanguage,
        targetLanguage: result.targetLanguage,
        provider: result.provider,
        ...(result.model?.trim() ? { model: result.model.trim().slice(0, 128) } : {}),
      }).catch((error) => console.warn('ND Translate history write failed:', error))
    }
    return result
  })
  host.register('browser.translate.history', async (_input, context) => history.list(contextKey(context.context)))
  host.register('browser.translate.history.clear', async (input, context) => {
    const id = typeof input.id === 'string' ? input.id.slice(0, 160) : undefined
    return { removed: await history.remove(contextKey(context.context), id) }
  })
  const processes = new ProcessInventory(undefined, () => [
    process.pid,
    ...app.getAppMetrics().map((metric) => metric.pid),
  ])

  // --- Wallpaper Studio Discovery links ---------------------------------------
  //
  // Remote image links the user saved (JSON in userData) plus the read-only
  // ND-curated bundle shipped in resources. Images are downloaded only into
  // the local cache, through `downloadWallpaperImage`, so no renderer ever
  // talks to the network and every fetch is SSRF-checked and size-capped.

  const wallpaperLinkStore = new WallpaperLinkStore(join(app.getPath('userData'), 'wallpaper-links.json'))
  void wallpaperLinkStore.initialize().catch((error) => console.warn('Wallpaper links failed to load:', error))
  const wallpaperCacheDir = join(app.getPath('userData'), 'wallpaper-cache')
  const wallpaperThumbCacheDir = join(wallpaperCacheDir, 'thumbs')
  interface BundledDoc { links: WallpaperLink[]; collections: WallpaperCollection[] }
  let bundledDoc: BundledDoc | null = null
  const bundledDocOnce = async (): Promise<BundledDoc> => {
    if (bundledDoc) return bundledDoc
    let doc: BundledDoc
    try {
      const parsed = await readWallpaperLinksBundle(
        bundledWallpaperLinksPath({ appPath: app.getAppPath(), resourcesPath: app.isPackaged ? process.resourcesPath : undefined }),
      )
      doc = {
        links: parsed.links.map(bundledLinkFromSeed),
        collections: (parsed.collections ?? []).map((seed) => ({
          id: seed.id?.trim() || `col-${linkIdForUrl(seed.name)}`,
          name: seed.name,
          createdAt: seed.createdAt ?? 0,
          entries: seed.entries.map((entry) => ({
            id: entry.id?.trim() || collectionEntryId(entry.kind, entry.ref),
            kind: entry.kind,
            ref: entry.ref,
            title: entry.title,
            addedAt: 0,
          })),
          source: 'bundle' as const,
        })),
      }
    } catch (error) {
      console.warn('ND wallpaper bundle failed to load:', error)
      doc = { links: [], collections: [] }
    }
    bundledDoc = doc
    return doc
  }
  const bundledLinksOnce = async (): Promise<WallpaperLink[]> => (await bundledDocOnce()).links

  /** Collections resolve from the user's store first, then the curated bundle. */
  const findCollectionAnywhere = async (id: string): Promise<WallpaperCollection | null> =>
    wallpaperLinkStore.findCollection(id) ?? (await bundledDocOnce()).collections.find((entry) => entry.id === id) ?? null

  /** Curated collections ship read-only; edits belong in the user's own copy. */
  const assertCollectionEditable = async (id: string): Promise<void> => {
    if (wallpaperLinkStore.findCollection(id)) return
    if ((await bundledDocOnce()).collections.some((entry) => entry.id === id)) {
      throw new Error('Curated ND collections are read-only — save its images into one of your own collections to edit them')
    }
  }

  /** Dev builds mirror the user's collections into the in-repo bundle document. */
  const mirrorCollectionsToBundle = async (): Promise<void> => {
    if (app.isPackaged) return
    await writeBundledCollections(bundledWallpaperLinksPath({ appPath: app.getAppPath() }), wallpaperLinkStore.listCollections())
    bundledDoc = null
  }

  /** `source` marks which list a caller is addressing: `user` links or `bundle` links. */
  const findLink = async (id: string, source: string): Promise<WallpaperLink | null> => {
    if (source === 'bundle') return (await bundledLinksOnce()).find((link) => link.id === id) ?? null
    return wallpaperLinkStore.find(id)
  }

  /**
   * The on-disk image a link's cover should render from: the cached full-size
   * wallpaper when present, otherwise the bundle's small thumb URL (fetched
   * once into `thumbs/` so Discovery shows real artwork before any apply).
   */
  const ensureLinkCover = async (link: WallpaperLink): Promise<WallpaperEntry | null> => {
    if (link.cachedPath) {
      try {
        const fileStat = await fs.stat(link.cachedPath)
        return { filename: basename(link.cachedPath), path: link.cachedPath, size: fileStat.size, modifiedAt: fileStat.mtimeMs }
      } catch {
        // Cached file vanished; fall back to the thumb if there is one.
      }
    }
    if (!link.thumbUrl) return null
    const existing = await findCachedImage(wallpaperThumbCacheDir, link.thumbUrl)
    if (existing) {
      return { filename: basename(existing.path), path: existing.path, size: existing.size, modifiedAt: existing.modifiedAt }
    }
    try {
      const cached = await downloadWallpaperImage(link.thumbUrl, {
        cacheDir: wallpaperThumbCacheDir,
        maxBytes: WALLPAPER_THUMB_MAX_BYTES,
      })
      return { filename: basename(cached.path), path: cached.path, size: cached.size, modifiedAt: Date.now() }
    } catch {
      // No cover available; the card keeps its placeholder.
      return null
    }
  }

  /** Thumbnails for links whose image is already in the cache; uncached links are simply skipped. */
  const readLinkThumbnails = async (links: readonly WallpaperLink[]): Promise<Map<string, CachedThumbnail>> => {
    if (!thumbnailCache) throw new Error('The nd-core sidecar is required to render wallpaper thumbnails')
    const sources: WallpaperEntry[] = []
    const pathToLinkId = new Map<string, string>()
    for (const link of links) {
      const entry = await ensureLinkCover(link)
      if (!entry) continue
      sources.push(entry)
      pathToLinkId.set(entry.path, link.id)
    }
    if (sources.length === 0) return new Map()
    const found = await thumbnailCache.get(wallpaperCacheDir, sources, GRID_THUMBNAIL_WIDTH)
    const byLinkId = new Map<string, CachedThumbnail>()
    for (const source of sources) {
      const thumbnail = found.get(source.path)
      const id = pathToLinkId.get(source.path)
      if (thumbnail && id) byLinkId.set(id, thumbnail)
    }
    return byLinkId
  }

  const ensureLinkCached = async (link: WallpaperLink): Promise<WallpaperLink> => {
    if (link.cachedPath) {
      try {
        await fs.access(link.cachedPath)
        return link
      } catch {
        // Cached file is gone; fall through and download again.
      }
    }
    const cached = await downloadWallpaperImage(link.url, { cacheDir: wallpaperCacheDir })
    if (link.source === 'user') {
      const updated = await wallpaperLinkStore.recordCache(link.id, cached)
      if (updated) return updated
    }
    return { ...link, cachedPath: cached.path, cachedSize: cached.size, cachedAt: Date.now() }
  }

  host.register('os.wallpaper.links.list', async () => {
    await wallpaperLinkStore.initialize()
    const active = getActiveWallpaperState()
    const withActive = (link: WallpaperLink) => ({
      ...link,
      active: Boolean(link.cachedPath && active.path && link.cachedPath === active.path),
    })
    return {
      user: wallpaperLinkStore.list().map(withActive),
      bundle: (await bundledLinksOnce()).map(withActive),
      defaultFolder: resolveDefaultWallpaperFolder(),
      bundleEditable: !app.isPackaged,
    }
  })

  host.register('os.wallpaper.links.add', async (input) => {
    await wallpaperLinkStore.initialize()
    const url = requiredText(input.url, 'Image link', 2_048)
    const title = typeof input.title === 'string' ? input.title.slice(0, 200) : undefined
    // Download first so a link is only ever saved after proving it is a real,
    // supported image the sidecar can render.
    const cached = await downloadWallpaperImage(url, { cacheDir: wallpaperCacheDir })
    const { link, created } = await wallpaperLinkStore.add(url, title, cached)
    const thumbnailMap = await readLinkThumbnails([link])
    return { link: { ...link, active: false }, created, thumbnail: thumbnailMap.get(link.id)?.dataUrl }
  })

  host.register('os.wallpaper.links.remove', async (input) => {
    await wallpaperLinkStore.initialize()
    const id = requiredText(input.id, 'Link selection', 200)
    const result = await wallpaperLinkStore.remove(id)
    if (result.cachedPath) await fs.unlink(result.cachedPath).catch(() => undefined)
    return { removed: result.removed }
  })

  host.register('os.wallpaper.links.apply', async (input) => {
    await wallpaperLinkStore.initialize()
    const id = requiredText(input.id, 'Link selection', 200)
    const link = await findLink(id, typeof input.source === 'string' ? input.source : 'user')
    if (!link) throw new Error('That wallpaper link no longer exists')
    const ensured = await ensureLinkCached(link)
    await setDesktopWallpaper(ensured.cachedPath!, process.platform, applyWallpaper)
    setActiveWallpaperState(ensured.cachedPath!)
    return { changed: true, name: ensured.title, path: ensured.cachedPath }
  })

  // Discovery collects, it does not touch the desktop: saving copies a bundle
  // entry into the user's own list, where applying stays a deliberate act.
  host.register('os.wallpaper.links.save', async (input) => {
    await wallpaperLinkStore.initialize()
    const id = requiredText(input.id, 'Link selection', 200)
    const link = await findLink(id, typeof input.source === 'string' ? input.source : 'bundle')
    if (!link) throw new Error('That wallpaper link no longer exists')
    const existing = wallpaperLinkStore.list().find((entry) => entry.url === link.url)
    if (existing) return { saved: false, exists: true, link: existing }
    const { link: saved } = await wallpaperLinkStore.add(link.url, link.title, undefined, link.thumbUrl)
    return { saved: true, exists: false, link: saved }
  })

  // Dev-only curation of the shipped ND bundle. Unpacked builds edit the
  // in-repo resources document so a curation pass shows up as a normal git
  // diff; packaged builds refuse here, keeping the shipped bundle read-only.
  const bundledLinksFilePath = (): string => {
    if (app.isPackaged) throw new Error('The ND bundle is read-only in packaged builds')
    return bundledWallpaperLinksPath({ appPath: app.getAppPath() })
  }
  const bundledUrlForId = async (id: string): Promise<string> => {
    const link = (await bundledLinksOnce()).find((entry) => entry.id === id)
    if (!link) throw new Error('That ND bundle link no longer exists')
    return link.url
  }
  host.register('os.wallpaper.bundle.add', async (input) => {
    const bundle = await addBundledWallpaperLink(bundledLinksFilePath(), {
      url: requiredText(input.url, 'Image link', 2_048),
      ...(typeof input.title === 'string' ? { title: input.title } : {}),
      ...(typeof input.thumb === 'string' ? { thumb: input.thumb } : {}),
      ...(typeof input.category === 'string' ? { category: input.category } : {}),
    })
    bundledDoc = null
    return { editable: true, count: bundle.links.length }
  })
  host.register('os.wallpaper.bundle.update', async (input) => {
    const url = await bundledUrlForId(requiredText(input.id, 'Link selection', 200))
    const bundle = await updateBundledWallpaperLink(bundledLinksFilePath(), url, {
      ...(typeof input.url === 'string' ? { url: input.url } : {}),
      ...(typeof input.title === 'string' ? { title: input.title } : {}),
      ...(typeof input.thumb === 'string' ? { thumb: input.thumb } : {}),
      ...(typeof input.category === 'string' ? { category: input.category } : {}),
    })
    bundledDoc = null
    return { editable: true, count: bundle.links.length }
  })
  host.register('os.wallpaper.bundle.remove', async (input) => {
    const url = await bundledUrlForId(requiredText(input.id, 'Link selection', 200))
    const { removed, bundle } = await removeBundledWallpaperLink(bundledLinksFilePath(), url)
    bundledDoc = null
    return { removed, count: bundle.links.length }
  })

  /**
   * Play the saved links like a queue. `next` walks the list in order;
   * `random` avoids repeating the current wallpaper. Missing images download
   * on the way, so the first pass through the queue is the slow one.
   */
  const applyLinkFromQueue = async (mode: 'next' | 'random'): Promise<{ changed: boolean; name?: string; path?: string | undefined }> => {
    await wallpaperLinkStore.initialize()
    const links = wallpaperLinkStore.list()
    if (links.length === 0) throw new Error('Save some wallpaper links in Discovery first')
    const active = getActiveWallpaperState()
    let chosen: WallpaperLink | undefined
    if (mode === 'random') {
      const candidates = links.filter((link) => !link.cachedPath || link.cachedPath !== active.path)
      const pool = candidates.length > 0 ? candidates : links
      chosen = pool[Math.floor(Math.random() * pool.length)]
    } else {
      const currentIndex = links.findIndex((link) => link.cachedPath === active.path)
      chosen = links[currentIndex >= 0 ? (currentIndex + 1) % links.length : 0]
    }
    if (!chosen) throw new Error('No wallpaper link could be selected')
    const ensured = await ensureLinkCached(chosen)
    await setDesktopWallpaper(ensured.cachedPath!, process.platform, applyWallpaper)
    setActiveWallpaperState(ensured.cachedPath!)
    return { changed: true, name: ensured.title, path: ensured.cachedPath }
  }

  host.register('os.wallpaper.links.next', async () => applyLinkFromQueue('next'))
  host.register('os.wallpaper.links.random', async () => applyLinkFromQueue('random'))

  // --- Wallpaper Studio collections -------------------------------------------
  //
  // Named, user-curated sets ("Nature", "Cities") that mix saved remote links
  // and local folder images. Collections are the playable unit: next/random
  // walk one collection, and the auto-rotate timer can be pointed at one so a
  // whole day stays on theme.

  const collectionEntryFromInput = async (input: Record<string, unknown>): Promise<WallpaperCollectionEntry> => {
    await wallpaperLinkStore.initialize()
    const collectionId = requiredText(input.collectionId ?? input.id, 'Collection', 100)
    const entryId = requiredText(input.entryId ?? input.id, 'Collection entry', 100)
    const collection = await findCollectionAnywhere(collectionId)
    if (!collection) throw new Error('That collection no longer exists')
    const entry = collection.entries.find((item) => item.id === entryId)
    if (!entry) throw new Error('That image is no longer in the collection')
    return entry
  }

  /** The user link backing a collection's link entry, when it is still known. */
  const knownLinkForRef = async (ref: string): Promise<WallpaperLink | null> => {
    const normalized = parseWallpaperLinkUrl(ref).toString()
    return wallpaperLinkStore.list().find((link) => link.url === normalized)
      ?? (await bundledLinksOnce()).find((link) => link.url === normalized)
      ?? null
  }

  const applyCollectionEntry = async (entry: WallpaperCollectionEntry): Promise<{ changed: boolean; name: string; path?: string | undefined }> => {
    if (entry.kind === 'link') {
      const known = await knownLinkForRef(entry.ref)
      const link: WallpaperLink = known ?? { id: entry.id, url: parseWallpaperLinkUrl(entry.ref).toString(), title: entry.title, source: 'user', addedAt: 0 }
      const ensured = await ensureLinkCached(link)
      await setDesktopWallpaper(ensured.cachedPath!, process.platform, applyWallpaper)
      setActiveWallpaperState(ensured.cachedPath!)
      return { changed: true, name: ensured.title, path: ensured.cachedPath }
    }
    await setDesktopWallpaper(entry.ref, process.platform, applyWallpaper)
    setActiveWallpaperState(entry.ref)
    return { changed: true, name: entry.title, path: entry.ref }
  }

  /**
   * Picks from a flat list of playable entries — links resolve through their
   * cached file, files apply directly — walking in order for next/previous
   * and avoiding the current wallpaper for random.
   */
  const applyFromEntries = async (entries: readonly WallpaperCollectionEntry[], mode: 'next' | 'random' | 'previous'): Promise<{ changed: boolean; name?: string; path?: string | undefined }> => {
    if (entries.length === 0) throw new Error('There are no wallpapers to play')
    const active = getActiveWallpaperState()
    const resolved: { entry: WallpaperCollectionEntry; path: string | null }[] = []
    for (const entry of entries) {
      if (entry.kind === 'file') {
        resolved.push({ entry, path: entry.ref })
        continue
      }
      const known = wallpaperLinkStore.list().find((link) => link.url === entry.ref)
      resolved.push({ entry, path: known?.cachedPath ?? null })
    }
    const currentIndex = resolved.findIndex((item) => item.path !== null && item.path === active.path)
    let chosen: WallpaperCollectionEntry
    if (mode === 'random') {
      const candidates = resolved.filter((_, index) => index !== currentIndex)
      const pool = candidates.length > 0 ? candidates : resolved
      chosen = (pool[Math.floor(Math.random() * pool.length)] ?? pool[0]!).entry
    } else if (mode === 'previous') {
      chosen = resolved[currentIndex > 0 ? currentIndex - 1 : resolved.length - 1]!.entry
    } else {
      chosen = resolved[currentIndex >= 0 ? (currentIndex + 1) % resolved.length : 0]!.entry
    }
    return applyCollectionEntry(chosen)
  }

  const applyCollectionQueue = async (collectionId: string, mode: 'next' | 'random'): Promise<{ changed: boolean; name?: string; path?: string | undefined }> => {
    await wallpaperLinkStore.initialize()
    const collection = await findCollectionAnywhere(collectionId)
    if (!collection) throw new Error('That collection no longer exists')
    if (collection.entries.length === 0) throw new Error('This collection is empty — save some images into it first')
    return applyFromEntries(collection.entries, mode)
  }

  /**
   * The rotation pool: the union of the selected play sources. Sources are
   * `folder:<path>` / `collection:<id>` refs; when none are selected the pool
   * is every linked folder. Nothing linked means nothing plays — the library
   * is only what the user linked, never an implicit default folder.
   */
  const buildRotationPool = async (settings: Record<string, unknown> | undefined): Promise<WallpaperCollectionEntry[]> => {
    const folders = readLinkedFolders(settings)
    const sources = readPlaySources(settings)
    const folderRefs = sources.filter((ref) => ref.startsWith('folder:')).map((ref) => ref.slice('folder:'.length))
    const collectionRefs = sources.filter((ref) => ref.startsWith('collection:')).map((ref) => ref.slice('collection:'.length))
    const activeFolders = sources.length > 0 ? folderRefs : folders
    const pool: WallpaperCollectionEntry[] = []
    const addFolder = async (folder: string): Promise<void> => {
      const items = await listWallpapersInFolder(folder)
      for (const item of items) {
        pool.push({ id: `pool-${item.path}`, kind: 'file', ref: item.path, title: item.filename, addedAt: 0 })
      }
    }
    for (const folder of activeFolders) await addFolder(folder)
    for (const id of collectionRefs) {
      const collection = await findCollectionAnywhere(id)
      if (collection) pool.push(...collection.entries)
    }
    const seen = new Set<string>()
    return pool.filter((entry) => {
      const key = `${entry.kind}:${entry.ref}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  const applyRotationPool = async (mode: 'next' | 'random' | 'previous', settings?: Record<string, unknown> | undefined): Promise<{ changed: boolean; name?: string; path?: string | undefined }> => {
    await wallpaperLinkStore.initialize()
    const resolvedSettings = settings ?? await deps.state.activation(WALLPAPER_MANAGER_ID, { kind: 'personal' }).then((activation) => (activation?.settings ?? {}) as Record<string, unknown>)
    const pool = await buildRotationPool(resolvedSettings)
    return applyFromEntries(pool, mode)
  }
  applyWallpaperRotation = (mode) => applyRotationPool(mode)

  // Play walks the pool: the Next/Shuffle/Prev buttons and the auto-rotate
  // timer all draw from the same selected folders + collections.
  host.register('os.wallpaper.next', async (_input, context) => applyRotationPool('next', context.settings as Record<string, unknown> | undefined))
  host.register('os.wallpaper.previous', async (_input, context) => applyRotationPool('previous', context.settings as Record<string, unknown> | undefined))
  host.register('os.wallpaper.random', async (_input, context) => applyRotationPool('random', context.settings as Record<string, unknown> | undefined))

  host.register('os.wallpaper.folders.list', async (_input, context) => {
    const settings = context.settings as Record<string, unknown> | undefined
    const folders = await Promise.all(readLinkedFolders(settings).map(async (path) => ({
      path,
      count: (await listWallpapersInFolder(path)).length,
    })))
    return {
      folders,
      defaultFolder: resolveDefaultWallpaperFolder(),
      sources: readPlaySources(settings),
    }
  })

  host.register('os.wallpaper.folders.add', async (_input, context) => {
    const result = await dialog.showOpenDialog(deps.window, {
      title: 'Link wallpaper folder',
      defaultPath: resolveDefaultWallpaperFolder(),
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length !== 1) return { changed: false }
    const selected = result.filePaths[0]!
    const settings = context.settings as Record<string, unknown> | undefined
    const folders = readLinkedFolders(settings)
    if (!folders.includes(selected)) folders.push(selected)
    await deps.state.setSetting(WALLPAPER_MANAGER_ID, context.context, 'folders', folders)
    refreshWallpaperRotation?.()
    return { changed: true, folder: selected, count: (await listWallpapersInFolder(selected)).length }
  })

  host.register('os.wallpaper.folders.remove', async (input, context) => {
    const path = requiredText(input.path, 'Folder', 4096)
    const settings = context.settings as Record<string, unknown> | undefined
    const folders = readLinkedFolders(settings).filter((folder) => folder !== path)
    await deps.state.setSetting(WALLPAPER_MANAGER_ID, context.context, 'folders', folders)
    const before = readPlaySources(settings)
    const sources = before.filter((ref) => ref !== `folder:${path}`)
    if (sources.length !== before.length) {
      await deps.state.setSetting(WALLPAPER_MANAGER_ID, context.context, 'playSources', sources)
    }
    refreshWallpaperRotation?.()
    return { removed: true, folders, sources }
  })

  host.register('os.wallpaper.playSources.set', async (input, context) => {
    await wallpaperLinkStore.initialize()
    const settings = context.settings as Record<string, unknown> | undefined
    const folders = readLinkedFolders(settings)
    const requested = Array.isArray(input.sources)
      ? input.sources.filter((value): value is string => typeof value === 'string').slice(0, 100)
      : []
    const valid: string[] = []
    for (const ref of requested) {
      if (ref.startsWith('folder:')) {
        if (folders.includes(ref.slice('folder:'.length))) valid.push(ref)
      } else if (ref.startsWith('collection:')) {
        if (wallpaperLinkStore.findCollection(ref.slice('collection:'.length))) valid.push(ref)
      }
    }
    await deps.state.setSetting(WALLPAPER_MANAGER_ID, context.context, 'playSources', valid)
    refreshWallpaperRotation?.()
    return { sources: valid }
  })

  host.register('os.wallpaper.collections.list', async (_input, context) => {
    await wallpaperLinkStore.initialize()
    const sources = readPlaySources(context.settings as Record<string, unknown> | undefined)
    // The collections panel marks a collection "Rotating" when it is the solo play source.
    const soloCollectionId = sources.length === 1 && sources[0]!.startsWith('collection:')
      ? sources[0]!.slice('collection:'.length)
      : ''
    const own = wallpaperLinkStore.listCollections()
    const ownNames = new Set(own.map((collection) => collection.name.toLowerCase()))
    // Curated collections ship in the bundle; a same-named personal copy wins.
    const curated = (await bundledDocOnce()).collections.filter((collection) => !ownNames.has(collection.name.toLowerCase()))
    return {
      collections: [...own.map((collection) => ({ ...collection, source: 'user' as const })), ...curated],
      rotateCollectionId: soloCollectionId,
    }
  })

  host.register('os.wallpaper.collections.create', async (input) => {
    await wallpaperLinkStore.initialize()
    const name = requiredText(input.name, 'Collection name', 80)
    const collection = await wallpaperLinkStore.createCollection(name)
    await mirrorCollectionsToBundle()
    return { collection }
  })

  host.register('os.wallpaper.collections.delete', async (input) => {
    await wallpaperLinkStore.initialize()
    const id = requiredText(input.id, 'Collection', 100)
    await assertCollectionEditable(id)
    const result = await wallpaperLinkStore.deleteCollection(id)
    // Deleting the rotating collection falls rotation back to the folder.
    if (result.deleted) {
      await deps.state.setSetting(WALLPAPER_MANAGER_ID, { kind: 'personal' }, 'rotateCollectionId', '')
      refreshWallpaperRotation?.()
      await mirrorCollectionsToBundle()
    }
    return result
  })

  /**
   * Saves items into one or more collections in a single call. With
   * `saveLink`, link items also land in My links (Discovery saves), keeping
   * the curated title and cover thumb when the same link is known.
   */
  host.register('os.wallpaper.collections.add', async (input) => {
    await wallpaperLinkStore.initialize()
    const collectionIds = Array.isArray(input.collectionIds)
      ? input.collectionIds.filter((value): value is string => typeof value === 'string').slice(0, 50)
      : []
    if (collectionIds.length === 0) throw new Error('Choose at least one collection')
    const rawItems = Array.isArray(input.items) ? input.items.slice(0, 100) : []
    const items: WallpaperCollectionItemInput[] = rawItems
      .map((item) => {
        const record = (item ?? {}) as Record<string, unknown>
        return {
          kind: record.kind === 'file' ? 'file' as const : 'link' as const,
          ref: typeof record.ref === 'string' ? record.ref.trim() : '',
          ...(typeof record.title === 'string' ? { title: record.title } : {}),
        }
      })
      .filter((item) => item.ref)
    if (items.length === 0) throw new Error('Nothing to save')
    if (input.saveLink === true) {
      for (const item of items.filter((item) => item.kind === 'link')) {
        const known = await knownLinkForRef(item.ref)
        await wallpaperLinkStore.add(item.ref, item.title ?? known?.title, undefined, known?.thumbUrl)
      }
    }
    const results: Array<Record<string, unknown>> = []
    let mutated = false
    for (const id of collectionIds) {
      try {
        await assertCollectionEditable(id)
        const outcome = await wallpaperLinkStore.addToCollection(id, items)
        results.push({ id, ok: true, added: outcome.added, skipped: outcome.skipped })
        mutated = true
      } catch (error) {
        results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (mutated) await mirrorCollectionsToBundle()
    return { results }
  })

  host.register('os.wallpaper.collections.removeEntry', async (input) => {
    await wallpaperLinkStore.initialize()
    const collectionId = requiredText(input.collectionId ?? input.id, 'Collection', 100)
    const entryId = requiredText(input.entryId, 'Collection entry', 100)
    await assertCollectionEditable(collectionId)
    const result = await wallpaperLinkStore.removeFromCollection(collectionId, entryId)
    if (result.removed) await mirrorCollectionsToBundle()
    return result
  })

  host.register('os.wallpaper.collections.apply', async (input) => {
    const entry = await collectionEntryFromInput(input)
    return applyCollectionEntry(entry)
  })

  host.register('os.wallpaper.collections.next', async (input) => {
    const collectionId = requiredText(input.id, 'Collection', 100)
    return applyCollectionQueue(collectionId, 'next')
  })

  host.register('os.wallpaper.collections.random', async (input) => {
    const collectionId = requiredText(input.id, 'Collection', 100)
    return applyCollectionQueue(collectionId, 'random')
  })

  host.register('os.wallpaper.collections.rotate', async (input, context) => {
    await wallpaperLinkStore.initialize()
    const requested = typeof input.id === 'string' ? input.id.trim() : ''
    if (requested && !(await findCollectionAnywhere(requested))) {
      throw new Error('That collection no longer exists')
    }
    const settings = context.settings as Record<string, unknown> | undefined
    const current = readPlaySources(settings)
    const ref = `collection:${requested}`
    // Solo-plays that collection on the timer; toggling off returns rotation
    // to the default (every linked folder).
    const sources = requested
      ? (current.includes(ref) ? current.filter((item) => item !== ref) : [ref])
      : []
    await deps.state.setSetting(WALLPAPER_MANAGER_ID, context.context, 'playSources', sources)
    refreshWallpaperRotation?.()
    return { sources }
  })

  host.register('os.wallpaper.collections.preview', async (input) => {
    const entry = await collectionEntryFromInput(input)
    let source: WallpaperEntry
    let root: string
    if (entry.kind === 'link') {
      const known = await knownLinkForRef(entry.ref)
      const link: WallpaperLink = known ?? { id: entry.id, url: parseWallpaperLinkUrl(entry.ref).toString(), title: entry.title, source: 'user', addedAt: 0 }
      const ensured = await ensureLinkCached(link)
      source = { filename: basename(ensured.cachedPath!), path: ensured.cachedPath!, size: ensured.cachedSize ?? 0, modifiedAt: ensured.cachedAt ?? 0 }
      root = wallpaperCacheDir
    } else {
      const fileStat = await fs.stat(entry.ref)
      source = { filename: basename(entry.ref), path: entry.ref, size: fileStat.size, modifiedAt: fileStat.mtimeMs }
      root = dirname(entry.ref)
    }
    const [preview] = await readThumbnails(root, [source], PREVIEW_WIDTH)
    const [thumbnail] = await readThumbnails(root, [source], GRID_THUMBNAIL_WIDTH)
    if (!preview) throw new Error('Could not render the image')
    return {
      id: entry.id,
      filename: entry.title,
      path: entry.ref,
      dataUrl: preview.dataUrl,
      thumbnail: thumbnail?.dataUrl ?? preview.dataUrl,
      width: preview.sourceWidth,
      height: preview.sourceHeight,
      size: source.size,
      modifiedAt: source.modifiedAt,
    }
  })

  host.register('os.wallpaper.collections.thumbnails', async (input) => {
    if (!thumbnailCache) throw new Error('The nd-core sidecar is required to render wallpaper thumbnails')
    await wallpaperLinkStore.initialize()
    const collectionId = requiredText(input?.id, 'Collection', 100)
    const ids = readThumbnailIds(input?.ids)
    const collection = await findCollectionAnywhere(collectionId)
    if (!collection || ids.length === 0) return { thumbnails: [] }
    const byEntryId = new Map(collection.entries.map((entry) => [entry.id, entry]))
    const linkEntries: WallpaperLink[] = []
    const fileGroups = new Map<string, { entry: WallpaperCollectionEntry; source: WallpaperEntry }[]>()
    for (const id of ids) {
      const entry = byEntryId.get(id)
      if (!entry) continue
      if (entry.kind === 'link') {
        const known = await knownLinkForRef(entry.ref)
        linkEntries.push(known ? { ...known, id: entry.id } : { id: entry.id, url: entry.ref, title: entry.title, source: 'user', addedAt: 0 })
        continue
      }
      try {
        const fileStat = await fs.stat(entry.ref)
        const root = dirname(entry.ref)
        const group = fileGroups.get(root) ?? []
        group.push({ entry, source: { filename: basename(entry.ref), path: entry.ref, size: fileStat.size, modifiedAt: fileStat.mtimeMs } })
        fileGroups.set(root, group)
      } catch {
        // File moved or deleted; the card keeps its placeholder until removed.
      }
    }
    const results = new Map<string, CachedThumbnail>()
    for (const [id, thumbnail] of await readLinkThumbnails(linkEntries)) results.set(id, thumbnail)
    for (const [root, group] of fileGroups) {
      const found = await thumbnailCache.get(root, group.map((item) => item.source), GRID_THUMBNAIL_WIDTH)
      for (const item of group) {
        const thumbnail = found.get(item.source.path)
        if (thumbnail) results.set(item.entry.id, thumbnail)
      }
    }
    return {
      thumbnails: [...results].map(([id, thumbnail]) => ({
        id,
        path: thumbnail.path,
        dataUrl: thumbnail.dataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
      })),
    }
  })

  host.register('os.wallpaper.links.preview', async (input) => {
    await wallpaperLinkStore.initialize()
    const id = requiredText(input.id, 'Link selection', 200)
    const link = await findLink(id, typeof input.source === 'string' ? input.source : 'user')
    if (!link) throw new Error('That wallpaper link no longer exists')
    const ensured = await ensureLinkCached(link)
    const root = wallpaperCacheDir
    const source: WallpaperEntry = {
      filename: basename(ensured.cachedPath!),
      path: ensured.cachedPath!,
      size: ensured.cachedSize ?? 0,
      modifiedAt: ensured.cachedAt ?? 0,
    }
    const [preview] = await readThumbnails(root, [source], PREVIEW_WIDTH)
    const [thumbnail] = await readThumbnails(root, [source], GRID_THUMBNAIL_WIDTH)
    if (!preview) throw new Error('Could not render the linked image')
    return {
      id: link.id,
      filename: link.title,
      path: link.url,
      dataUrl: preview.dataUrl,
      thumbnail: thumbnail?.dataUrl ?? preview.dataUrl,
      width: preview.sourceWidth,
      height: preview.sourceHeight,
      size: ensured.cachedSize ?? 0,
      modifiedAt: ensured.cachedAt ?? 0,
      source: link.source,
    }
  })

  host.register('os.wallpaper.links.thumbnails', async (input) => {
    await wallpaperLinkStore.initialize()
    const ids = readThumbnailIds(input?.ids)
    if (ids.length === 0) return { thumbnails: [] }
    const byId = new Map(wallpaperLinkStore.list().filter((link) => ids.includes(link.id)).map((link) => [link.id, link]))
    const bundleById = new Map((await bundledLinksOnce()).filter((link) => ids.includes(link.id)).map((link) => [link.id, link]))
    const wanted: WallpaperLink[] = []
    for (const id of ids) {
      const link = byId.get(id) ?? bundleById.get(id)
      if (link) wanted.push(link)
    }
    const found = await readLinkThumbnails(wanted.filter(Boolean))
    return {
      thumbnails: [...found].map(([id, thumbnail]) => ({
        id,
        path: thumbnail.path,
        dataUrl: thumbnail.dataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
      })),
    }
  })

  host.register('os.wallpaper.links.import', async () => {
    await wallpaperLinkStore.initialize()
    const result = await dialog.showOpenDialog(deps.window, {
      title: 'Import wallpaper links',
      properties: ['openFile'],
      filters: [{ name: 'Wallpaper links (JSON)', extensions: ['json'] }],
    })
    if (result.canceled || result.filePaths.length !== 1) return { imported: false, added: 0, skipped: 0 }
    const raw = await fs.readFile(result.filePaths[0]!, 'utf8')
    const bundle = parseWallpaperLinksBundle(JSON.parse(raw))
    const summary = await wallpaperLinkStore.importLinks(bundle.links)
    return { imported: true, name: bundle.name, ...summary }
  })

  host.register('os.wallpaper.links.export', async () => {
    await wallpaperLinkStore.initialize()
    const payload = wallpaperLinkStore.exportBundle()
    if (payload.links.length === 0) throw new Error('There are no saved links to export yet')
    const result = await dialog.showSaveDialog(deps.window, {
      title: 'Export wallpaper links',
      defaultPath: 'nd-wallpaper-links.json',
      filters: [{ name: 'Wallpaper links (JSON)', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { saved: false }
    await fs.writeFile(result.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    return { saved: true, path: result.filePath, count: payload.links.length }
  })

  host.register('note.create', async (input, context) => {
    const text = requiredText(input.text, 'Note text', 64_000)
    const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === 'string') : []
    if (context.context.kind === 'personal') {
      const note = await deps.home.createNote({ body: text, tags, context: context.context })
      return { noteId: note.id, title: note.title }
    }
    await organization.mutate({
      type: 'memory.add',
      companyId: context.context.companyId,
      ...(context.context.kind === 'project' ? { projectId: context.context.projectId } : {}),
      title: firstLine(text, NOTE_TITLE_MAX),
      content: text,
      tags,
    })
    return { noteId: `memory:${firstLine(text, NOTE_TITLE_MAX)}`, title: firstLine(text, NOTE_TITLE_MAX) }
  })

  host.register('note.search', async (input, context) => {
    const query = typeof input.query === 'string' ? input.query : ''
    const target = context.context
    if (target.kind === 'personal') {
      const notes = await deps.home.searchNotes(query, target)
      return notes.map((note) => ({ id: note.id, title: note.title, body: note.body, updatedAt: note.updatedAt }))
    }
    const snapshot = await organization.state()
    const needle = query.trim().toLowerCase()
    return snapshot.memory
      .filter((entry) => entry.companyId === target.companyId)
      .filter((entry) => target.kind !== 'project' || entry.projectId === target.projectId || entry.projectId === undefined)
      .filter((entry) => !needle || entry.title.toLowerCase().includes(needle) || entry.content.toLowerCase().includes(needle))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((entry) => ({ id: entry.id, title: entry.title, body: entry.content, updatedAt: entry.updatedAt }))
  })

  host.register('note.open', async (input, context) => {
    const id = requiredText(input.noteId, 'Note id', 160)
    const target = context.context
    if (target.kind === 'personal') {
      const notes = await deps.home.listNotes(target)
      const note = notes.find((item) => item.id === id)
      if (!note) throw new Error('That note no longer exists')
      return { id: note.id, title: note.title, body: note.body }
    }
    const snapshot = await organization.state()
    const entry = snapshot.memory.find((item) => item.id === id && item.companyId === target.companyId)
    if (!entry) throw new Error('That note no longer exists in this company')
    return { id: entry.id, title: entry.title, body: entry.content }
  })

  host.register('note.delete', async (input, context) => {
    const id = requiredText(input.noteId, 'Note id', 160)
    if (context.context.kind !== 'personal') {
      // Company/project memory belongs to the organization store, which has no
      // removal mutation yet; fail closed instead of pretending it was deleted.
      throw new Error('Company and project notes cannot be deleted from an extension yet; delete them in the Company workspace')
    }
    await deps.home.deleteNote(id)
    return { deleted: true }
  })

  host.register('capture.screen', async (input, context) => {
    const displayId = typeof input.displayId === 'number' && Number.isFinite(input.displayId) ? input.displayId : undefined
    const image = await captureDisplayUnderPointer(displayId)
    const record = await deps.home.addCapture(image, context.context)
    return { captureId: record.id, width: record.width, height: record.height, displayLabel: record.displayLabel }
  })

  host.register('capture.area', async (input, context) => {
    const rect = asRect(input.rect)
    if (!rect) throw new Error('Capture area needs the selected rectangle from the overlay')
    const image = await captureScreenRegion(rect)
    const record = await deps.home.addCapture(image, context.context)
    return { captureId: record.id, width: record.width, height: record.height, displayLabel: record.displayLabel }
  })

  host.register('capture.list', async (_input, context) => {
    const state = await deps.home.state()
    const key = contextKey(context.context)
    return state.captures
      .filter((capture) => capture.contextKey === key)
      .map((capture) => ({
        id: capture.id,
        title: capture.name,
        detail: `${capture.displayLabel} · ${new Date(capture.createdAt).toLocaleString()}`,
        status: capture.attachedSessionId ? 'attached' : 'local',
      }))
  })

  host.register('capture.copy', async (input) => {
    const id = requiredText(input.captureId, 'Capture id', 160)
    const capture = await deps.home.readCapture(id)
    if (!capture) throw new Error('That capture is no longer available')
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(capture.data, 'base64')))
    return { copied: true }
  })

  host.register('capture.export', async (input) => {
    const id = requiredText(input.captureId, 'Capture id', 160)
    const path = await deps.home.capturePath(id)
    if (!path) throw new Error('That capture is no longer available')
    const result = await dialog.showSaveDialog(deps.window, {
      title: 'Export capture',
      defaultPath: join(app.getPath('pictures'), basename(path)),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    })
    if (result.canceled || !result.filePath) return { exported: false }
    await fs.copyFile(path, result.filePath)
    return { exported: true, path: result.filePath }
  })

  host.register('clipboard.read', async (_input, context) => {
    // An explicit user command authorizes exactly this one read; agent callers
    // reach this handler only through a grant or a per-action approval.
    // Reading through the sidecar keeps read and write in one process (which
    // is what echo suppression relies on); without a sidecar, fall back to
    // Electron's clipboard so note capture keeps working.
    const text = (await readClipboardText()).trim()
    if (!text) throw new Error('The clipboard does not contain text to capture')
    if (context.context.kind === 'personal') {
      const note = await deps.home.createNote({ body: text, tags: ['capture', 'clipboard'], context: context.context })
      return { noteId: note.id, title: note.title }
    }
    await organization.mutate({
      type: 'memory.add',
      companyId: context.context.companyId,
      ...(context.context.kind === 'project' ? { projectId: context.context.projectId } : {}),
      title: firstLine(text, NOTE_TITLE_MAX),
      content: text,
      tags: ['capture', 'clipboard'],
    })
    return { title: firstLine(text, NOTE_TITLE_MAX) }
  })

  host.register('clipboard.write', async (input) => {
    const text = typeof input.text === 'string' ? input.text : ''
    if (!text.trim()) throw new Error('There is nothing to copy')
    const bounded = text.slice(0, 256_000)
    if (coreClipboard) {
      try {
        await coreClipboard.writeText(bounded)
        return { copied: true }
      } catch {
        // Sidecar unavailable: fall back to the in-process clipboard.
      }
    }
    clipboard.writeText(bounded)
    return { copied: true }
  })

  // --- Clipboard History -------------------------------------------------------
  //
  // Personal-context only host methods over the local history store. Reads
  // stay on the `clipboard.read` permission and keep its `sensitive` flag, so
  // an agent caller needs the existing explicit grant path — recording being
  // on grants nothing new.

  const requireClipboardHistory = (): ClipboardHistoryStore => {
    if (!clipboardStore) throw new Error('Clipboard history is not available in this build')
    return clipboardStore
  }
  const requirePersonalContext = (context: { context: { kind: string } }): void => {
    if (context.context.kind !== 'personal') {
      throw new Error('This action is available only in the Personal context')
    }
  }

  /**
   * Read clipboard text through the sidecar when it is available — keeping
   * read and write in the process that owns the watcher — and fall back to
   * Electron's clipboard when it is not. A non-text clipboard is a content
   * error, not an availability error, and never retries on the fallback path.
   */
  const readClipboardText = async (): Promise<string> => {
    if (coreClipboard) {
      try {
        const content = await coreClipboard.read()
        if (content.kind === 'text') return content.text ?? ''
        throw new Error('The clipboard does not contain text to capture')
      } catch (error) {
        if (error instanceof Error && error.message.includes('does not contain text')) throw error
        // The sidecar is unavailable; fall through to Electron.
      }
    }
    return clipboard.readText()
  }

  const historyEntryTitle = (entry: { kind: string; text?: string | undefined; fileName?: string | undefined; names?: string[] | undefined }): string => {
    if (entry.kind === 'text') return firstLine(entry.text ?? '', 120)
    if (entry.kind === 'image') return entry.fileName ? `Image · ${entry.fileName}` : 'Image'
    return entry.names?.length === 1 ? basename(entry.names[0]!) : `${entry.names?.length ?? 0} files`
  }

  host.register('clipboard.history.list', async (_input, context) => {
    requirePersonalContext(context)
    const store = requireClipboardHistory()
    const entries = await store.list()
    // Image rows render through the sidecar's bounded thumbnail path; a
    // missing sidecar simply omits previews rather than failing the list.
    const withImage = entries.filter((entry) => entry.imageFile)
    const thumbnails = new Map<string, string>()
    if (media && withImage.length > 0 && thumbnailCache) {
      try {
        const sources = []
        for (const entry of withImage) {
          const buffer = await store.readImageFile(entry)
          if (!buffer) continue
          const path = join(store.imageDirectory, entry.imageFile!)
          try {
            const fileStat = await fs.stat(path)
            sources.push({ id: entry.id, entry: { filename: entry.imageFile!, path, size: fileStat.size, modifiedAt: fileStat.mtimeMs } })
          } catch {
            // The image file is gone; the row keeps its placeholder.
          }
        }
        if (sources.length > 0) {
          const found = await thumbnailCache.get(
            store.imageDirectory,
            sources.map((item) => item.entry),
            GRID_THUMBNAIL_WIDTH,
          )
          for (const item of sources) {
            const thumbnail = found.get(item.entry.path)
            if (thumbnail) thumbnails.set(item.id, thumbnail.dataUrl)
          }
        }
      } catch {
        // Thumbnails are cosmetic; never fail the list over them.
      }
    }
    // A plain row array: the broker's toRows maps itemTitleKey/itemBodyKey, and
    // an object wrapper here would silently render the view's empty state.
    return entries.map((entry) => ({
      id: entry.id,
      title: historyEntryTitle(entry),
      detail: entry.kind === 'text'
        ? (entry.text ?? '').slice(0, 400)
        : `${new Date(entry.lastCopiedAt).toLocaleString()} · copied ${entry.occurrences}×`,
      status: entry.pinned ? 'Pinned' : entry.kind,
      ...(thumbnails.get(entry.id) ? { thumbnail: thumbnails.get(entry.id) } : {}),
      sortValues: { date: entry.lastCopiedAt },
    }))
  })

  host.register('clipboard.history.get', async (input, context) => {
    requirePersonalContext(context)
    const store = requireClipboardHistory()
    const id = requiredText(input.id, 'History entry', 160)
    const entry = await store.get(id)
    if (!entry) throw new Error('That history entry no longer exists')
    if (entry.kind === 'image' && entry.imageFile) {
      const buffer = await store.readImageFile(entry)
      return {
        id: entry.id,
        kind: entry.kind,
        pinned: entry.pinned,
        ...(buffer ? { dataUrl: `data:image/png;base64,${buffer.toString('base64')}` } : {}),
        ...(entry.imageWidth ? { width: entry.imageWidth } : {}),
        ...(entry.imageHeight ? { height: entry.imageHeight } : {}),
        ...(entry.fileName ? { fileName: entry.fileName } : {}),
      }
    }
    return {
      id: entry.id,
      kind: entry.kind,
      pinned: entry.pinned,
      ...(entry.text ? { text: entry.text } : {}),
      ...(entry.names ? { names: entry.names } : {}),
    }
  })

  host.register('clipboard.history.pin', async (input, context) => {
    requirePersonalContext(context)
    const store = requireClipboardHistory()
    const id = requiredText(input.id, 'History entry', 160)
    const pinned = input.pinned === undefined ? undefined : input.pinned === true
    const entry = await store.get(id)
    if (!entry) throw new Error('That history entry no longer exists')
    await store.setPinned(id, pinned ?? !entry.pinned, capsFromSettings(context.settings))
    return { id, pinned: pinned ?? !entry.pinned }
  })

  host.register('clipboard.history.delete', async (input, context) => {
    requirePersonalContext(context)
    const store = requireClipboardHistory()
    const id = requiredText(input.id, 'History entry', 160)
    return { removed: await store.delete(id) }
  })

  host.register('clipboard.history.clear', async (_input, context) => {
    requirePersonalContext(context)
    const store = requireClipboardHistory()
    return store.clear()
  })

  host.register('clipboard.history.copyAgain', async (input, context) => {
    requirePersonalContext(context)
    const store = requireClipboardHistory()
    const id = requiredText(input.id, 'History entry', 160)
    const entry = await store.get(id)
    if (!entry) throw new Error('That history entry no longer exists')
    if (entry.kind === 'text' && entry.text) {
      if (coreClipboard) {
        try {
          await coreClipboard.writeText(entry.text.slice(0, 256_000))
          return { copied: true }
        } catch {
          // Fall through to the in-process clipboard.
        }
      }
      clipboard.writeText(entry.text.slice(0, 256_000))
      return { copied: true }
    }
    if (entry.kind === 'image') {
      const buffer = await store.readImageFile(entry)
      if (!buffer) throw new Error('That image is no longer stored')
      // Electron writes the pixels; the sidecar observes the change and
      // history dedups it into this same entry by pixel fingerprint.
      clipboard.writeImage(nativeImage.createFromBuffer(buffer))
      return { copied: true }
    }
    const names = entry.names ?? []
    if (names.length === 0) throw new Error('That entry has no file list to copy')
    clipboard.writeText(names.join('\n'))
    return { copied: true }
  })

  // --- Password Vault ----------------------------------------------------------
  //
  // Secrets live in one AES-GCM-encrypted file in userData, written by the
  // sidecar under an OS-protected key (Windows DPAPI). This process only
  // composes the user-visible flow: typed input arrives through the ND-owned
  // prompt window, the list returns metadata rows the launcher can render, and
  // every path that moves a secret out (`vault.get`, `vault.copy`) is marked
  // sensitive at the broker so an agent needs an explicit grant. Create and
  // edit are user-only actions because their input IS the prompt window.

  const vaultPath = join(app.getPath('userData'), 'nd-vault', 'vault.ndvault')
  const requireVault = (): CoreVault => {
    if (!coreVault) throw new Error('The nd-core sidecar is required for the password vault')
    return coreVault
  }
  const requireUserCaller = (context: { caller: string }): void => {
    if (context.caller === 'agent') throw new Error('Changing the vault on ND\u2019s behalf is a user action; ask the user to do it in ND')
  }
  const vaultField = (value: unknown, label: string, max: number): string => {
    if (typeof value !== 'string') throw new Error(`${label} must be text`)
    if (value.length > max) throw new Error(`${label} must be at most ${max} characters`)
    if (value.includes('\0')) throw new Error(`${label} must not contain NUL`)
    return value
  }
  const vaultTitle = (value: unknown): string => {
    const title = vaultField(value, 'Title', 200).trim()
    if (!title) throw new Error('Title is required')
    return title
  }
  const vaultEntryInput = (values: VaultPromptValues) => ({
    title: vaultTitle(values.title),
    username: vaultField(values.username, 'Username', 320),
    url: vaultField(values.url, 'Website', 2_048),
    notes: vaultField(values.notes, 'Notes', 10_000),
    secret: vaultField(values.secret, 'Secret', 8_192),
  })

  host.register('vault.list', async (input, context) => {
    requirePersonalContext(context)
    const vault = requireVault()
    const query = typeof input.query === 'string' ? input.query.slice(0, 200) : undefined
    const result = await vault.list(vaultPath, query)
    // A plain row array: the broker's toRows maps itemTitleKey/itemBodyKey.
    return result.entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      detail: [entry.username, entry.url].filter(Boolean).join(' · '),
      sortValues: { date: entry.updatedAt },
    }))
  })

  host.register('vault.get', async (input, context) => {
    requirePersonalContext(context)
    const vault = requireVault()
    const id = requiredText(input.id, 'Vault entry', 128)
    const entry = await vault.get(vaultPath, id)
    return {
      id: entry.id,
      title: entry.title,
      username: entry.username,
      url: entry.url,
      notes: entry.notes,
      secret: entry.secret,
      updatedAt: entry.updatedAt,
    }
  })

  host.register('vault.create', async (_input, context) => {
    requirePersonalContext(context)
    requireUserCaller(context)
    const vault = requireVault()
    const prompt = await promptVaultEntry(deps.window, { mode: 'create' })
    if (!prompt.submitted || !prompt.values) return { created: false }
    const entry = await vault.create(vaultPath, vaultEntryInput(prompt.values))
    return { created: true, id: entry.id, title: entry.title }
  })

  host.register('vault.update', async (input, context) => {
    requirePersonalContext(context)
    requireUserCaller(context)
    const vault = requireVault()
    const id = requiredText(input.id, 'Vault entry', 128)
    const current = await vault.get(vaultPath, id)
    const prompt = await promptVaultEntry(deps.window, {
      mode: 'edit',
      initial: {
        title: current.title,
        username: current.username,
        url: current.url,
        notes: current.notes,
        secret: current.secret,
      },
    })
    if (!prompt.submitted || !prompt.values) return { updated: false }
    const entry = await vault.update(vaultPath, id, vaultEntryInput(prompt.values))
    return { updated: true, id: entry.id, title: entry.title }
  })

  host.register('vault.delete', async (input, context) => {
    requirePersonalContext(context)
    const vault = requireVault()
    const id = requiredText(input.id, 'Vault entry', 128)
    return { deleted: await vault.delete(vaultPath, id) }
  })

  host.register('vault.copy', async (input, context) => {
    requirePersonalContext(context)
    const vault = requireVault()
    const id = requiredText(input.id, 'Vault entry', 128)
    const entry = await vault.get(vaultPath, id)
    if (!entry.secret) throw new Error('That entry has no secret to copy')
    // Prefer the sidecar write: it arms echo suppression, so a clipboard
    // watcher can mistake this for a user copy. The in-process fallback only
    // exists when the sidecar is gone entirely — and with it, any watcher.
    const text = entry.secret.slice(0, 256_000)
    if (coreClipboard) {
      try {
        await coreClipboard.writeText(text)
        return { copied: true }
      } catch {
        // Fall through to the in-process clipboard.
      }
    }
    clipboard.writeText(text)
    return { copied: true }
  })

  // --- 3D Tic-Tac-Toe ----------------------------------------------------------
  //
  // The game UI itself is the package's web view (sandboxed iframe); this side
  // only owns the durable scoreboard. Personal-only and non-sensitive: the
  // worst thing an agent could do here is inflate a win counter, and even that
  // still goes through the broker's grant path.

  const ticTacToeStats = new TicTacToeStatsStore(join(app.getPath('userData'), 'nd-tic-tac-toe', 'stats.json'))

  host.register('tictactoe.stats.get', async (_input, context) => {
    requirePersonalContext(context)
    return ticTacToeStats.get()
  })

  host.register('tictactoe.stats.record', async (input, context) => {
    requirePersonalContext(context)
    return ticTacToeStats.record(asTicTacToeOutcome(input.outcome))
  })

  host.register('tictactoe.stats.reset', async (_input, context) => {
    requirePersonalContext(context)
    return ticTacToeStats.reset()
  })

  // --- Mini ND Browser ----------------------------------------------------------
  //
  // The browser chrome is the package's web view (sandboxed iframe, no
  // network): it keep-alives as a persistent tab dashboard. The pages themselves
  // are REAL tabs of the ND built-in browser — the canonical WebContentsView
  // engine — created, activated, and closed through the platform; the store
  // remembers the session so sleeping tabs can resume after a restart.
  // Personal-only and non-sensitive: it is a list of already-public links.

  const miniBrowser = new MiniBrowserStore(
    join(app.getPath('userData'), 'nd-mini-browser', 'session.json'),
    legacyYouTubeQueuePath(app.getPath('userData')),
  )
  const requireBrowserPlatform = (): Pick<NonNullable<NdIpcDependencies['browserPlatform']>, 'createTab' | 'activateTab' | 'closeTab' | 'tabs'> => {
    if (!deps.browserPlatform) throw new Error('The multi-tab browser platform is unavailable in this runtime')
    return deps.browserPlatform
  }

  /** A chrome row: a live engine tab, or a remembered session tab that can resume. */
  interface LiveMiniTab {
    id: string
    url: string
    title: string
    active: boolean
    alive: boolean
    lastActiveAt: number
  }

  const asChromeRow = (descriptor: { id: string; url: string; title: string; active: boolean }): LiveMiniTab => ({
    id: descriptor.id,
    url: descriptor.url,
    title: miniTabTitle(descriptor.title, descriptor.url),
    active: descriptor.active,
    alive: true,
    lastActiveAt: Date.now(),
  })

  /**
   * The renderer presents a focused tab in the context that opened it, so the
   * owning context travels with the event instead of being re-derived from
   * whatever company or project happens to be active.
   */
  const asBrowserFocus = (tabId: string, url: string, context: NdHostCallContext): NdBrowserFocusEvent => ({
    url,
    tabId,
    context: asNdContext(context.context),
  })

  const sessionFor = async (): Promise<{ tabs: LiveMiniTab[]; links: MiniLink[] }> => {
    const live = await requireBrowserPlatform().tabs(BUILTIN_BROWSER_TARGET_ID)
    const rows = live
      .filter((tab) => tab.targetId === BUILTIN_BROWSER_TARGET_ID)
      .map((tab) => asChromeRow(tab))
    for (const entry of await miniBrowser.tabs()) {
      if (rows.some((row) => row.id === entry.id)) continue
      rows.push({ ...entry, active: false, alive: false })
    }
    return { tabs: rows, links: await miniBrowser.links() }
  }

  host.register('minibrowser.session.list', async (_input, context) => {
    requirePersonalContext(context)
    return sessionFor()
  })

  host.register('minibrowser.link.list', async (_input, context) => {
    requirePersonalContext(context)
    return miniBrowser.links()
  })

  host.register('minibrowser.tab.open', async (input, context) => {
    requirePersonalContext(context)
    const href = browserTabUrl(requiredText(input.url, 'Address', 2_048))
    if (!href) throw new Error('Type an http(s) address to open')
    const tab = await requireBrowserPlatform().createTab(BUILTIN_BROWSER_TARGET_ID, href)
    await miniBrowser.rememberTab(tab.id, tab.url, tab.title)
    // The chrome auto-hides and the app surfaces the ND browser pane so the
    // site is visible right away, not behind a dashboard.
    deps.window.webContents.send(ND_EXTENSIONS_IPC.browserFocusEvent, asBrowserFocus(tab.id, tab.url, context))
    return { tab: asChromeRow(tab), session: await sessionFor() }
  })

  host.register('minibrowser.tab.activate', async (input, context) => {
    requirePersonalContext(context)
    const id = asMiniEntryId(input.id)
    const activated = await requireBrowserPlatform().activateTab(BUILTIN_BROWSER_TARGET_ID, id)
    await miniBrowser.touchTab(id)
    deps.window.webContents.send(ND_EXTENSIONS_IPC.browserFocusEvent, asBrowserFocus(id, activated.url, context))
    return { session: await sessionFor() }
  })

  host.register('minibrowser.tab.close', async (input, context) => {
    requirePersonalContext(context)
    const id = asMiniEntryId(input.id)
    try {
      await requireBrowserPlatform().closeTab(BUILTIN_BROWSER_TARGET_ID, id)
    } catch {
      // A remembered-only (sleeping) tab has no engine tab to close.
    }
    await miniBrowser.forgetTab(id)
    return { session: await sessionFor() }
  })

  host.register('minibrowser.link.save', async (input, context) => {
    requirePersonalContext(context)
    const href = requiredText(input.url, 'Link', 2_048)
    return { links: await miniBrowser.saveLink(href, typeof input.title === 'string' ? input.title : href), session: await sessionFor() }
  })

  host.register('minibrowser.link.remove', async (input, context) => {
    requirePersonalContext(context)
    return { links: await miniBrowser.removeLink(asMiniEntryId(input.id)), session: await sessionFor() }
  })

  host.register('browser.openUrl', async (input) => {
    const url = typeof input.url === 'string' && input.url.trim() ? httpUrl(input.url) : 'https://www.google.com'
    await deps.browser.navigate(url)
    return { url, surface: 'browser' }
  })

  host.register('browser.search', async (input, context) => {
    const query = requiredText(input.query, 'Search query', 512)
    const prefix = typeof context.settings.searchPrefix === 'string' ? context.settings.searchPrefix : 'https://www.google.com/search?q='
    const base = httpUrl(prefix.endsWith('=') || prefix.endsWith('/') ? prefix : `${prefix}${prefix.includes('?') ? '&q=' : '?q='}`)
    const url = `${base}${encodeURIComponent(query)}`
    await deps.browser.navigate(url)
    return { url, surface: 'browser' }
  })

  host.register('browser.openExternal', async (input) => {
    const url = httpUrl(requiredText(input.url, 'URL', 8_192))
    await shell.openExternal(url)
    return { url, surface: 'external' }
  })

  host.register('os.openTarget', async (input) => {
    const kind = input.kind === 'app' ? 'app' : input.kind === 'folder' ? 'folder' : 'file'
    const filters = kind === 'app' && process.platform === 'win32'
      ? [{ name: 'Applications', extensions: ['exe', 'lnk', 'bat', 'cmd'] }]
      : undefined
    const result = await dialog.showOpenDialog(deps.window, {
      title: kind === 'app' ? 'Choose an application' : kind === 'folder' ? 'Choose a folder' : 'Choose a file',
      properties: kind === 'folder' ? ['openDirectory'] : ['openFile'],
      ...(filters ? { filters } : {}),
    })
    if (result.canceled || result.filePaths.length === 0 || result.filePaths.length > MAX_OPEN_TARGETS) return { opened: false }
    const target = result.filePaths[0]!
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
    return { opened: true, path: target }
  })

  host.register('os.wallpaper.chooseAndSet', async () => {
    // The extension never supplies a filesystem path. ND owns the native picker
    // and passes the selected image directly to a fixed OS adapter.
    const result = await dialog.showOpenDialog(deps.window, {
      title: 'Choose desktop wallpaper',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] },
      ],
    })
    if (result.canceled || result.filePaths.length !== 1) return { changed: false }
    const target = result.filePaths[0]!
    await setDesktopWallpaper(target, process.platform, applyWallpaper)
    return { changed: true, path: target, platform: process.platform }
  })

  host.register('os.wallpaper.applySelected', async (input, context) => {
    const filename = requiredText(input.id ?? input.filename ?? input.path, 'Wallpaper file', 4096)
    const folder = normalizeWallpaperPath(typeof input?.folder === 'string' ? input.folder : undefined)
      || normalizeWallpaperPath(typeof context.settings?.folder === 'string' ? context.settings.folder : undefined)
      || undefined
    const result = await applyWallpaperFromFolder(folder, filename, undefined, applyWallpaper)
    return { changed: result.changed, name: result.name, path: result.path }
  })

  host.register('os.wallpaper.preview', async (input, context) => {
    const filename = requiredText(input.id ?? input.filename ?? input.path, 'Wallpaper file', 4096)
    const folder = normalizeWallpaperPath(typeof input?.folder === 'string' ? input.folder : undefined)
      || normalizeWallpaperPath(typeof context.settings?.folder === 'string' ? context.settings.folder : undefined)
      || undefined
    const targetPath = await resolveWallpaperTarget(filename, folder)
    const safeName = basename(targetPath)
    const fileStat = await fs.stat(targetPath)
    const source: WallpaperEntry = {
      filename: safeName,
      path: targetPath,
      size: fileStat.size,
      modifiedAt: fileStat.mtimeMs,
    }
    // The previewed file may live outside the library folder, so its own
    // directory is the confinement root for this read.
    const root = dirname(targetPath)
    const [preview] = await readThumbnails(root, [source], PREVIEW_WIDTH)
    const [thumbnail] = await readThumbnails(root, [source], GRID_THUMBNAIL_WIDTH)
    if (!preview) throw new Error('Could not read image file')
    return {
      id: safeName,
      filename: safeName,
      path: targetPath,
      dataUrl: preview.dataUrl,
      thumbnail: thumbnail?.dataUrl ?? preview.dataUrl,
      width: preview.sourceWidth,
      height: preview.sourceHeight,
      size: fileStat.size,
      modifiedAt: fileStat.mtimeMs,
    }
  })

  /**
   * Library metadata only. Thumbnails are deliberately not part of this
   * response: they are fetched per visible row through
   * `os.wallpaper.thumbnails`, because eagerly decoding the first 60 images here
   * blocked the main process for seconds on a 4K library.
   */
  host.register('os.wallpaper.status', async (input, context) => {
    const inputFolder = normalizeWallpaperPath(typeof input?.folder === 'string' ? input.folder : undefined)
    const settingFolder = normalizeWallpaperPath(typeof context.settings?.folder === 'string' ? context.settings.folder : undefined)
      || readLinkedFolders(context.settings)[0]
      || undefined
    const folder = inputFolder || settingFolder || undefined
    const items = await listWallpapersInFolder(folder)
    const active = getActiveWallpaperState()
    return items.map((item) => {
      const isActive = active.path === item.path || (active.path !== null && active.path.endsWith(item.filename))
      return {
        id: item.filename,
        title: item.filename,
        detail: `${Math.round(item.size / 1024)} KB · ${item.path}`,
        status: isActive ? 'Active' : undefined,
        path: item.path,
        size: item.size,
        modifiedAt: item.modifiedAt,
        sortValues: { size: item.size, date: item.modifiedAt },
      }
    })
  })

  host.register('os.wallpaper.thumbnails', async (input, context) => {
    const ids = readThumbnailIds(input?.ids)
    if (ids.length === 0) return { thumbnails: [] }
    const inputFolder = normalizeWallpaperPath(typeof input?.folder === 'string' ? input.folder : undefined)
    const settingFolder = normalizeWallpaperPath(typeof context.settings?.folder === 'string' ? context.settings.folder : undefined)
      || readLinkedFolders(context.settings)[0]
      || undefined
    const folder = inputFolder || settingFolder || undefined
    const root = await resolveWallpaperFolder(folder)
    const items = await listWallpapersInFolder(folder)
    const byId = new Map(items.map((item) => [item.filename, item]))
    const wanted: WallpaperEntry[] = []
    for (const id of ids) {
      const item = byId.get(id)
      if (item) wanted.push(item)
    }
    const thumbnails = await readThumbnails(root, wanted, GRID_THUMBNAIL_WIDTH)
    return {
      thumbnails: thumbnails.map((thumbnail) => ({
        id: basename(thumbnail.path),
        path: thumbnail.path,
        dataUrl: thumbnail.dataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
      })),
    }
  })

  host.register('process.list', async () => processes.list())

  const quitProcess = async (input: Record<string, unknown>, force: boolean): Promise<{ quit: boolean }> => {
    const id = requiredText(input.id, 'Process selection', 160)
    const selected = await processes.resolve(id)
    const result = await dialog.showMessageBox(deps.window, {
      type: 'warning',
      title: force ? 'Force quit process?' : 'Quit process?',
      message: `${force ? 'Force quit' : 'Quit'} ${selected.name} (PID ${selected.pid})?`,
      detail: force
        ? 'The process will stop immediately and may lose unsaved work.'
        : 'The process will be asked to stop. Unsaved work may be lost.',
      buttons: ['Cancel', force ? 'Force quit' : 'Quit'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (result.response !== 1) return { quit: false }
    await processes.quit(id, force)
    return { quit: true }
  }
  host.register('process.quit', async (input) => quitProcess(input, false))
  host.register('process.forceQuit', async (input) => quitProcess(input, true))

  host.register('chat.ask', async (input, context) => {
    if (context.caller === 'agent') throw new Error('Starting a chat on ND’s behalf is a user action; ask the user to open ND Home')
    const text = requiredText(input.text, 'Chat prompt', 20_000)
    return { text, contextKey: contextKey(context.context) }
  })

  host.register('workflow.list', async (_input, context) => {
    const view = await workflowView(deps, context.context)
    return view
  })

  host.register('workflow.refresh', async (_input, context) => {
    if (context.context.kind !== 'project') throw new Error('Repository tasks require a project context')
    await deps.workflow.refresh(context.context.companyId, context.context.projectId)
    return workflowView(deps, context.context)
  })
  return { dispose: () => translator.dispose() }
}

async function translateCatalogView(state: NdExtensionsStateView): Promise<NdAvailablePackageView> {
  return packageCatalogView(state, ND_TRANSLATE_ID, translatePackagePath(), {
    name: 'ND Translate', description: 'Translate text with Google Translate, ChatGPT, or Gemini in the ND browser.', permissions: ['browser.navigate', 'translate.history'],
  })
}

async function quitProcessCatalogView(state: NdExtensionsStateView): Promise<NdAvailablePackageView> {
  return packageCatalogView(state, QUIT_PROCESS_ID, quitProcessPackagePath(), {
    name: 'Quit Processes', description: 'Inspect running processes and quit a selected process from ND.', permissions: ['process.read', 'process.quit'],
  })
}

async function clipboardHistoryCatalogView(state: NdExtensionsStateView): Promise<NdAvailablePackageView> {
  return packageCatalogView(state, CLIPBOARD_HISTORY_ID, clipboardHistoryPackagePath(), {
    name: 'Clipboard History',
    description: 'Records your clipboard only after you turn recording on. Nothing is saved at install, at activation, or by default.',
    permissions: ['clipboard.read', 'clipboard.write'],
  })
}

async function passwordVaultCatalogView(state: NdExtensionsStateView): Promise<NdAvailablePackageView> {
  return packageCatalogView(state, PASSWORD_VAULT_ID, passwordVaultPackagePath(), {
    name: 'Password Vault',
    description: 'A local-first vault for passwords and API keys, encrypted on this device. Nothing is synced, nothing leaves ND.',
    permissions: ['vault.read', 'vault.write'],
  })
}

async function ticTacToeCatalogView(state: NdExtensionsStateView): Promise<NdAvailablePackageView> {
  return packageCatalogView(state, TIC_TAC_TOE_ID, ticTacToePackagePath(), {
    name: 'ND 3D Tic-Tac-Toe',
    description: 'Play tic-tac-toe on a 3D board rendered with three.js, on demand from the launcher. Ships its own sandboxed UI; the package stays fully external to the app bundle.',
    permissions: ['tictactoe.read', 'tictactoe.write'],
  })
}

async function miniBrowserCatalogView(state: NdExtensionsStateView): Promise<NdAvailablePackageView> {
  return packageCatalogView(state, MINI_BROWSER_ID, miniBrowserPackagePath(), {
    name: 'ND Mini Browser',
    description: 'A keep-alive browser dashboard: manage many real tabs of the ND built-in browser from a persistent chrome, with quick links and launcher quick-open. Stays fully external to the app bundle.',
    permissions: ['minibrowser.read', 'minibrowser.write'],
  })
}

async function packageCatalogView(state: NdExtensionsStateView, id: string, packagePath: string, metadata: Pick<NdAvailablePackageView, 'name' | 'description' | 'permissions'>): Promise<NdAvailablePackageView> {
  const path = join(packagePath, 'nd-extension.json')
  const fallback: NdAvailablePackageView = {
    id,
    ...metadata,
    version: '1.0.0',
    commands: [],
    installed: state.packages.some((item) => item.id === id),
    available: false,
  }
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path, 'utf8'))
    const validated = validateNdExtensionManifest(parsed)
    if (!validated.ok || validated.manifest.id !== id || manifestPermissionIssues(validated.manifest).length > 0) return fallback
    return {
      id: validated.manifest.id,
      name: validated.manifest.name,
      description: validated.manifest.description,
      version: validated.manifest.version,
      permissions: validated.manifest.permissions,
      commands: validated.manifest.contributions.commands.map((command) => ({
        id: command.id,
        title: command.title,
        ...(command.description ? { description: command.description } : {}),
      })),
      installed: fallback.installed,
      available: true,
    }
  } catch {
    return fallback
  }
}

async function workflowView(deps: NdIpcDependencies, context: { kind: string; companyId?: string; projectId?: string }): Promise<unknown[]> {
  if (context.kind !== 'project' || !context.companyId || !context.projectId) {
    throw new Error('Repository tasks require a project context')
  }
  const view = await deps.workflow.projectView(context.companyId, context.projectId)
  if (!view.binding && !view.snapshot) throw new Error('Bind the project workflow integration before opening repository tasks')
  const tasks = view.snapshot?.tasks ?? []
  return tasks
    .filter((task) => !task.archived)
    .map((task) => ({
      id: task.key ?? task.sourcePath,
      title: task.title,
      detail: [task.displayStatus ?? task.lifecycle, task.outcome, task.prdRefs.join(' ')].filter(Boolean).join(' · '),
      status: task.displayStatus ?? task.lifecycle,
    }))
}

/** Seed ND-maintained packages and their Personal activations exactly once. */
async function seedBuiltinPackages(deps: NdIpcDependencies): Promise<void> {
  for (const manifest of BUILTIN_EXTENSION_PACKAGES) {
    await deps.packages.registerBuiltin(manifest)
    for (const kind of defaultActivationContexts(manifest)) {
      const context = kind === 'personal' ? { kind: 'personal' as const } : undefined
      if (!context) continue
      const existing = await deps.state.activation(manifest.id, context)
      if (!existing) await deps.state.setActivation(manifest.id, context, true)
    }
  }
}

/** Re-snapshot installed ND-bundled on-demand packages when their bundled manifest changed. */
async function refreshAvailablePackages(deps: NdIpcDependencies): Promise<void> {
  for (const { id, path } of AVAILABLE_PACKAGES) {
    const packagePath = path()
    const installed = await deps.packages.record(id)
    if (!installed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(join(packagePath, 'nd-extension.json'), 'utf8'))
    } catch {
      continue
    }
    const validated = validateNdExtensionManifest(parsed)
    if (!validated.ok || validated.manifest.id !== id || manifestPermissionIssues(validated.manifest).length > 0) continue
    if (JSON.stringify(validated.manifest) === JSON.stringify(installed.manifest)) continue
    await deps.packages.installFromDirectory(packagePath, { expectId: id })
  }
}

async function installPreparedPackage(deps: NdIpcDependencies, sourcePath: string): Promise<void> {
  await deps.packages.installFromDirectory(sourcePath)
}

function assertNdSender(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Rejected ND extension IPC from an untrusted renderer frame')
  }
}

function absolutePath(value: unknown): string {
  const path = requiredText(value, 'Package folder', 4_096)
  if (!/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith('/') && !path.startsWith('\\\\')) {
    throw new Error('Package folder must be an absolute path')
  }
  return path
}

function shortId(value: unknown, label: string): string {
  return requiredText(value, label, 160)
}

const GRID_THUMBNAIL_WIDTH = 240
/** Bound for Discovery cover thumbs, which are small preview images, not wallpapers. */
const WALLPAPER_THUMB_MAX_BYTES = 8 * 1024 * 1024
const PREVIEW_WIDTH = 1920
/** One screenful at a time, matching the sidecar's own per-batch bound. */
const MAX_THUMBNAIL_IDS = 64

/**
 * Validate a thumbnail request from the renderer. Unknown, blank, oversized, and
 * duplicate ids are dropped rather than trusted; the id is only ever used to look
 * up an entry ND itself listed, so nothing here reaches the filesystem.
 */
function readThumbnailIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const entry of value) {
    if (ids.length >= MAX_THUMBNAIL_IDS) break
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (!id || id.length > 4096 || ids.includes(id)) continue
    ids.push(id)
  }
  return ids
}

/** Resolve a caller-supplied filename to a file that actually exists. */
async function resolveWallpaperTarget(filename: string, folder: string | undefined): Promise<string> {
  const targetFolder = folder || resolveDefaultWallpaperFolder()
  try {
    await fs.access(filename)
    return filename
  } catch {
    // Not a directly usable path; try it inside the library folder.
  }
  const inFolder = join(targetFolder, filename)
  try {
    await fs.access(inFolder)
    return inFolder
  } catch {
    // Fall through to the basename form, whose failure surfaces the real error.
  }
  const fallback = join(targetFolder, basename(filename))
  await fs.access(fallback)
  return fallback
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new Error(`${label} must be at most ${max} characters`)
  return trimmed
}

function firstLine(text: string, max: number): string {
  const line = text.split(/\r?\n/)[0]?.trim() ?? ''
  return line.slice(0, max) || 'Quick note'
}

function httpUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('URL must be a valid absolute web address')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http and https URLs are supported')
  return parsed.toString()
}

function asRect(value: unknown): { x: number; y: number; width: number; height: number } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const numbers = [record.x, record.y, record.width, record.height]
  if (!numbers.every((item) => typeof item === 'number' && Number.isFinite(item))) return undefined
  const rect = { x: record.x as number, y: record.y as number, width: record.width as number, height: record.height as number }
  if (rect.width <= 0 || rect.height <= 0) return undefined
  return rect
}

function asNoteInput(value: unknown): { body: string; title?: string; tags?: string[]; context?: NdContext } {
  if (!value || typeof value !== 'object') throw new Error('Note input is required')
  const record = value as Record<string, unknown>
  const body = requiredText(record.body, 'Note text', 64_000)
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).map((tag) => tag.trim().slice(0, 48)).slice(0, 16)
    : undefined
  const context = record.context === undefined ? undefined : asNdContext(record.context)
  return {
    body,
    ...(typeof record.title === 'string' && record.title.trim() ? { title: record.title.trim().slice(0, 160) } : {}),
    ...(tags ? { tags } : {}),
    ...(context ? { context } : {}),
  }
}

/** Probe that the host allowlist and the registry cannot drift apart. */
export function missingNativeHostMethods(host: NativeHostRegistry): NdHostMethod[] {
  return host.missing(ND_HOST_METHODS.map((method) => method.id))
}
