import 'dotenv/config'
import { app, BrowserWindow, crashReporter, dialog, Menu, protocol, screen, type MenuItemConstructorOptions } from 'electron'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ND_ORG_MEMORY_ID, ND_WORKSPACE_CONTEXT_ID } from '../shared/capabilities.js'
import { workerAssignableCodingEngines } from '../shared/coding-engines.js'
import { IPC, type DshEventFrame } from '../shared/contracts.js'
import { DESIGN_IPC } from '../shared/design.js'
import { ND_WEBVIEW_SCHEME_PRIVILEGES } from '../shared/extension-webview.js'
import { ORGANIZATION_IPC, type OrganizationSnapshot } from '../shared/organization.js'
import { throttleLatest } from './latest-value-throttle.js'
import { TERMINAL_IPC } from '../shared/terminal.js'
import { resolveShortcutBehavior } from '../shared/quick-launcher.js'
import type { GlobalShortcutId } from '../shared/shortcuts.js'
import { bundledResourceRoot, codexBinPath, presetSourceDir, projectRoot } from './app-paths.js'

import { BrowserController } from './browser/browser-controller.js'
import { BrowserCompanionService } from './browser-companion/browser-companion-service.js'
import { registerBrowserCompanionIpc } from './browser-companion/ipc.js'
import { BrowserPlatformService } from './browser-platform/browser-platform-service.js'
import { registerBrowserPlatformIpc } from './browser-platform/ipc.js'
import { stopAppOwnedBrowserDaemons } from './browser/agent-browser-client.js'
import { DEFAULT_BROWSER_URL } from './browser/browser-url.js'
import { CapabilityAssignmentStore } from './capabilities/capability-assignment-store.js'
import { CapabilityRegistry } from './capabilities/capability-registry.js'
import { CapabilityStatusStore } from './capabilities/capability-status-store.js'
import { createEngineCliSetupAdapters } from './capabilities/engine-cli-setup.js'
import { createHarnessSourceSetupAdapters } from './capabilities/harness-runtime-setup.js'
import { ExternalElementStage, RecentPickStore } from './capture/external-inspect.js'
import { CoreClient } from './core/core-client.js'
import { createCoreSpawn, stopCoreManagedChildProcess } from './core/core-child-process.js'
import { createCorePtySpawner } from './core/core-pty.js'
import { CoreSessionJournalStore } from './core/core-session-journal.js'
import { createCorePackageSnapshot } from './core/core-extension-packages.js'
import { createCoreMedia } from './core/core-media.js'
import { createCoreClipboard } from './core/core-clipboard.js'
import { createCoreMediaKeys } from './core/core-media-keys.js'
import { createCoreSystemVolume } from './core/core-system-volume.js'
import { createCoreVault } from './core/core-vault.js'
import { createCoreDiskScan } from './core/core-disk.js'
import { createCoreComputer } from './core/core-computer.js'
import { createCoreApiHttp } from './core/core-api-http.js'
import { createCoreWorkspaceFileSystem } from './core/core-workspace.js'
import { createCoreWorktreeGit } from './core/core-worktree-git.js'
import { DesignService } from './design/design-service.js'
import { registerDesignIpc } from './design/ipc.js'
import { NdPencilController } from './design/nd-pencil-controller.js'
import { DshSurfaceController } from './dsh/dsh-surface.js'
import { pickFreePort } from './dsh/gateway-client.js'
import { AntigravityEngine } from './engines/antigravity/antigravity-engine.js'
import { ClaudeCodeCliEngine } from './engines/claude/claude-code-cli-engine.js'
import { CodexCliEngine } from './engines/codex/codex-cli-engine.js'
import { CursorCliEngine } from './engines/cursor/cursor-cli-engine.js'
import { CodingEngineRegistry } from './engines/coding-engine-registry.js'
import { EngineSessionRouter } from './engines/engine-session-router.js'
import { NdRestApiService } from './rest-api/rest-api-service.js'
import { NdNativeEngine } from './engines/nd-native/nd-native-engine.js'
import { NdNativeToolBroker } from './engines/nd-native/nd-native-tool-broker.js'
import { PiCodingEngine } from './engines/pi/pi-coding-engine.js'
import { ZcodeCliEngine } from './engines/zcode/zcode-cli-engine.js'
import { GitService } from './git/git-service.js'
import { GitCli } from './git/git-cli.js'
import { HarnessService } from './harness/harness-service.js'
import { registerIpc } from './ipc.js'
import { createLauncherPopup } from './launcher-popup.js'
import { ShortcutRegistry } from './shortcut-registry.js'
import { setTaskMetricsRecorder, taskMetricsRecorder, TaskMetricsRecorder } from './metrics/task-metrics.js'
import { OrganizationApprovalGate } from './organization/approval-gate.js'
import { createDecisionSupportFromEnv } from './organization/decision-support-config.js'
import { ExecutionCoordinator } from './organization/execution-coordinator.js'
import { registerOrganizationIpc } from './organization/ipc.js'
import { OrganizationOrchestrator } from './organization/orchestrator.js'
import { OrganizationStore } from './organization/store.js'
import { TaskWorktreeManager } from './organization/task-worktree.js'
import { ProviderStore } from './providers.js'
import { agentTaskBenchmarkScenarioFromEnv, runAgentTaskBenchmark } from './perf/agent-task-benchmark.js'
import { runBrowserPlatformBenchmark } from './perf/browser-platform-benchmark.js'
import { runCompanionChromeSmoke } from './perf/companion-chrome-smoke.js'
import { runPackagedRuntimeSmoke } from './perf/packaged-runtime-smoke.js'
import { runRuntimeBenchmark } from './perf/runtime-benchmark.js'
import { flushStartupBenchmark, markStartup } from './perf/startup-metrics.js'
import { QaService } from './qa/qa-service.js'
import { SessionArchiveStore } from './sessions/session-archive-store.js'
import { LogFile, logFilePathFor } from './logging/log-file.js'
import { LocalRuntimeService, type LocalRuntimeAppPort } from './local-runtime/local-runtime-service.js'
import { registerLocalRuntimeIpc } from './local-runtime/ipc.js'
import { UsageLedger } from './usage/usage-ledger.js'
import { ThemeService } from './theme.js'
import { registerTerminalIpc } from './terminal/ipc.js'
import { RouterService } from './router/router-service.js'
import { TerminalManager } from './terminal/terminal-manager.js'
import { ProjectWorkspaceCoordinator } from './workspace/project-workspace-coordinator.js'
import { ProjectRuntimeService } from './workspace/project-runtime.js'
import { WorkspaceRegistry } from './workspace/workspace-registry.js'
import { WorkspaceService } from './workspace/workspace-service.js'

markStartup('main-module')

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const requestedCdpPort = parsePort(process.env.ND_DSH_CDP_PORT, 0)
const startUrl = process.env.ND_DSH_BROWSER_URL?.trim() || DEFAULT_BROWSER_URL

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
const userDataOverride = process.env.ND_DSH_USER_DATA_DIR?.trim()
if (userDataOverride) app.setPath('userData', resolve(userDataOverride))
app.enableSandbox()

let mainWindow: BrowserWindow | undefined
let activeHarness: HarnessService | undefined
let activeQa: QaService | undefined
let activeProjectRuntime: ProjectRuntimeService | undefined
let activeBrowser: BrowserController | undefined
let activeBrowserCompanion: BrowserCompanionService | undefined
let activeBrowserPlatform: BrowserPlatformService | undefined
let activeCodexEngine: CodexCliEngine | undefined
let activeAntigravityEngine: AntigravityEngine | undefined
let activeZcodeEngine: ZcodeCliEngine | undefined
let activePiEngine: PiCodingEngine | undefined
let activeCursorEngine: CursorCliEngine | undefined
let activeClaudeEngine: ClaudeCodeCliEngine | undefined
let activeEngineRouter: EngineSessionRouter | undefined
let activeRestApiService: NdRestApiService | undefined
let activeNdPencil: NdPencilController | undefined
let activeTerminalManager: TerminalManager | undefined
let activeCore: CoreClient | undefined
let activeExecutionCoordinator: ExecutionCoordinator | undefined
let localRuntime: LocalRuntimeService | undefined
let shutdownStarted = false
const closingServices = new Set<Promise<void>>()

// Must run before app ready: the extension web-view asset scheme parses as a
// standard, secure URL but deliberately supports no fetch API and no CORS.
protocol.registerSchemesAsPrivileged([{ scheme: ND_WEBVIEW_SCHEME_PRIVILEGES.scheme, privileges: { ...ND_WEBVIEW_SCHEME_PRIVILEGES.privileges } }])

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

const theme = new ThemeService()
const LAUNCHER_PRELOAD_PATH = join(currentDirectory, '../preload/index.cjs')
const ORGANIZATION_BROADCAST_INTERVAL_MS = 100
const launcherPopup = createLauncherPopup({
  preloadPath: LAUNCHER_PRELOAD_PATH,
  getMainWindow: () => mainWindow,
})

// Diagnostics exist before anything else can fail: a packaged build has no
// console, so without this a startup crash leaves nothing to inspect.
const log = new LogFile({ path: logFilePathFor(app.getPath('userData')) })
void log.open()
try {
  // Local dumps only; ND never uploads a customer's crash data on its own.
  crashReporter.start({ uploadToServer: false })
} catch (error) {
  console.warn('Native crash reporting is unavailable:', error)
}

/** Bring the full app window forward with the in-app launcher open. */
function showMainWindowAndOpenLauncher(): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  localRuntime?.setBackground(false)
  window.setAlwaysOnTop(true)
  window.focus()
  window.setAlwaysOnTop(false)
  window.webContents.send(IPC.windowQuickLauncherEvent)
}

function showQuickLauncher(): void {
  const behavior = resolveShortcutBehavior(theme.quickLauncherMode())
  if (behavior.kind === 'toggle-popup') {
    launcherPopup.toggle()
    return
  }
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  if (behavior.kind === 'toggle-window') {
    if (window.isVisible() && window.isFocused() && !window.isMinimized()) {
      window.hide()
      localRuntime?.setBackground(true)
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    localRuntime?.setBackground(false)
    window.setAlwaysOnTop(true)
    window.focus()
    window.setAlwaysOnTop(false)
    return
  }
  showMainWindowAndOpenLauncher()
}

/**
 * Ask the primary renderer to run a capture flow. The window is deliberately
 * left alone: raising ND here would put ND itself into the screenshot.
 */
function requestCapture(action: GlobalShortcutId): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  window.webContents.send(IPC.windowCaptureRequestEvent, action)
}

/** Owns every OS-wide hotkey; bindings come from the user's persisted settings. */
const shortcutRegistry = new ShortcutRegistry({
  store: theme,
  handlers: {
    quickLauncher: showQuickLauncher,
    areaCapture: () => requestCapture('areaCapture'),
    fullCapture: () => requestCapture('fullCapture'),
    delayedCapture: () => requestCapture('delayedCapture'),
  },
})

app.on('second-instance', () => {
  showMainWindowAndOpenLauncher()
})

async function createWindow(cdpPort: number): Promise<void> {
  const preload = join(currentDirectory, '../preload/index.cjs')
  if (!localRuntime) {
    localRuntime = new LocalRuntimeService(
      join(app.getPath('userData'), 'local-runtime.json'),
      app as unknown as LocalRuntimeAppPort,
      process.platform,
    )
    await localRuntime.initialize()
  }
  const ndPencilPreload = join(currentDirectory, '../preload/nd-pencil.cjs')
  const workspace = new WorkspaceService(process.env.ND_DSH_WORKSPACE?.trim() || process.cwd())
  const providers = new ProviderStore()
  // Per-task cost measurement is always on; it never waits for a benchmark to
  // switch it on, and the benchmark reads these samples back.
  setTaskMetricsRecorder(new TaskMetricsRecorder())
  const userData = app.getPath('userData')
  const core = new CoreClient({
    log: (line) => console.log(line),
    onUnexpectedExit: (code, signal) => {
      console.error('ND Core exited unexpectedly:', { code, signal })
    },
  })
  // nd-core is the production desktop runtime boundary. Startup fails closed
  // when the bundled sidecar is unavailable instead of changing semantics.
  await core.start()
  await core.request('effectJournal.configure', {
    path: join(userData, 'effect-journal.jsonl'),
  }, 5_000)
  // ND Router lives in the Rust sidecar. Initialization is best-effort: a stale
  // sidecar build must not block startup, and the managed provider only appears
  // once the router answers with combos.
  const routerService = new RouterService(core, providers, join(userData, 'nd-router'))
  await routerService.initialize()
  markStartup('core-ready')
  activeCore = core
  workspace.attachFileSystem(createCoreWorkspaceFileSystem(core))
  const sessionArchive = new SessionArchiveStore(join(userData, 'session-archive.json'))
  const usageLedger = new UsageLedger(join(userData, 'usage-ledger.jsonl'))
  const isMac = process.platform === 'darwin'

  // On displays narrower than the intended 1640×980 the window would hang off
  // the screen and hide the right-hand surfaces. Clamp the default and the
  // minimum to the primary work area so the whole shell stays reachable.
  const { workArea } = screen.getPrimaryDisplay()
  const window = new BrowserWindow({
    width: Math.min(1640, workArea.width),
    height: Math.min(980, workArea.height),
    minWidth: Math.min(1180, workArea.width),
    minHeight: Math.min(720, workArea.height),
    show: false,
    backgroundColor: theme.windowBackgroundColor(),
    autoHideMenuBar: true,
    title: 'ND · AI Company OS',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 14, y: 13 } } : { titleBarOverlay: theme.titleBarOverlay() }),
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  const terminalManager = new TerminalManager({
    storePath: join(userData, 'terminals.json'),
    workspace,
    spawn: createCorePtySpawner(core),
    onOutput: (event) => { if (!window.isDestroyed()) window.webContents.send(TERMINAL_IPC.outputEvent, event) },
    onExit: (event) => { if (!window.isDestroyed()) window.webContents.send(TERMINAL_IPC.exitEvent, event) },
    onState: (event) => { if (!window.isDestroyed()) window.webContents.send(TERMINAL_IPC.stateEvent, event) },
  })
  await terminalManager.initialize()
  activeTerminalManager = terminalManager

  const workspaces = new WorkspaceRegistry(join(userData, 'workspaces.json'))
  // Only a folder the user already saved becomes the active entry. The boot root
  // itself is never pinned, so ND never presents an implicit default project.
  await workspaces.activateSaved(workspace.state().root)

  // The window's own origin is reserved: neither the project runtime nor a
  // browser-pane navigation may load ND's renderer into ND's browser view.
  // A file:// renderer has an opaque origin serialized as "null"; that must
  // never be treated as a reservable http(s) origin, or about:blank (also
  // "null") would be refused as self-hosted.
  const reservedOrigin = (): string | undefined => {
    try {
      if (window.isDestroyed()) return undefined
      const origin = new URL(window.webContents.getURL()).origin
      return origin === 'null' ? undefined : origin
    } catch { return undefined }
  }

  const browser = new BrowserController(window, cdpPort, projectRoot(), {
    reservedOrigin,
    dataPath: userData,
    extensionRuntimePreload: join(currentDirectory, '../preload/extension-runtime.cjs'),
    onMediaState: (state) => {
      if (!window.isDestroyed()) window.webContents.send(IPC.mediaStateEvent, state)
      const popup = launcherPopup.window()
      if (popup && !popup.isDestroyed()) popup.webContents.send(IPC.mediaStateEvent, state)
    },
  })
  activeBrowser = browser
  const browserCompanion = new BrowserCompanionService({
    dataPath: userData,
    runtimePath: join(bundledResourceRoot(), 'scripts', 'nd-browser-companion-runtime.mjs'),
  })
  await browserCompanion.start().catch((error) => {
    console.warn('Browser companion is unavailable; the embedded browser remains usable:', error instanceof Error ? error.message : String(error))
  })
  activeBrowserCompanion = browserCompanion
  const dshSurface = new DshSurfaceController(window)
  const externalElements = new ExternalElementStage()
  const recentPicks = new RecentPickStore()
  const organizationStore = new OrganizationStore(join(userData, 'organization.json'))
  const browserPlatform = new BrowserPlatformService(browser, browserCompanion, organizationStore, userData)
  await browserPlatform.initialize()
  activeBrowserPlatform = browserPlatform
  const executionCoordinator = new ExecutionCoordinator(core)
  activeExecutionCoordinator = executionCoordinator
  // Core RPCs are issued deep inside the organization work that owns them, so
  // the active runtime permit — not the caller — attributes a crossing to a task.
  taskMetricsRecorder()?.setPermitResolver(() => {
    const permit = executionCoordinator.currentPermit()
    if (!permit) return undefined
    return { ...(permit.input.taskId ? { taskId: permit.input.taskId } : {}), ...(permit.sessionId ? { sessionId: permit.sessionId } : {}) }
  })
  const interruptedRuns = await organizationStore.reconcileInterruptedRuns()
  if (interruptedRuns > 0) console.warn(`Recovered ${interruptedRuns} interrupted organization run(s) from the previous app session.`)
  const disposeCoreReady = core.onEvent('core.ready', () => {
    // A terminal whose shell belongs to a previous sidecar generation is gone, so
    // the session stops claiming it is running instead of showing a live terminal
    // that cannot accept input.
    void terminalManager.reconcileShells()
      .then((count) => {
        if (count > 0) console.warn(`Marked ${count} terminal(s) exited after the ND Core restart.`)
      })
      .catch((error) => { console.error('Failed to reconcile session terminals after an ND Core restart:', error) })
    if (!executionCoordinator.recoveryRequired()) return
    void organizationStore.reconcileInterruptedRuns('ND Core exited before the run finished.')
      .then((count) => {
        console.warn(`Reconciled ${count} organization run(s) after ND Core restart.`)
        executionCoordinator.resumeAfterReconciliation()
      })
      .catch((error) => {
        console.error('ND Core restarted, but organization reconciliation failed; dispatch remains blocked:', error)
      })
  })
  const backgroundPolicyPath = join(bundledResourceRoot(), 'scripts', 'nd-background-process.cjs')
  const engineSpawn = createCoreSpawn(core, executionCoordinator, backgroundPolicyPath)
  // Project dev servers and machine verification are ND-owned system work,
  // not engine children: keep them Rust-owned without inheriting a worker permit.
  const unscopedCoreSpawn = createCoreSpawn(core, undefined, backgroundPolicyPath)
  const git = new GitService(workspace, { core })
  const harnessJournal = new CoreSessionJournalStore(core)
  const directEngineJournal = new CoreSessionJournalStore(core, {
    maxEvents: 500,
    maxBytes: 2 * 1024 * 1024,
  })
  const harness = new HarnessService(workspace, browser, providers, externalElements, sessionArchive, usageLedger, harnessJournal)
  const disposeHarnessJournalRecovery = core.onEvent('core.ready', () => {
    void harness.rehydrateEventJournal().catch((error) => {
      console.error('Failed to rebuild Harness history after ND Core restart:', error)
    })
  })
  const codexEngine = new CodexCliEngine({ log: (line) => console.log(line), spawnProcess: engineSpawn })
  activeCodexEngine = codexEngine
  const antigravityEngine = new AntigravityEngine({ log: (line) => console.log(line), spawnProcess: engineSpawn })
  activeAntigravityEngine = antigravityEngine
  const zcodeEngine = new ZcodeCliEngine({ log: (line) => console.log(line), spawnProcess: engineSpawn })
  activeZcodeEngine = zcodeEngine
  const piEngine = new PiCodingEngine({
    log: (line) => console.log(line),
    spawnProcess: engineSpawn,
    providers: () => providers,
    skillsDir: () => presetSourceDir(),
  })
  activePiEngine = piEngine
  const cursorEngine = new CursorCliEngine({ log: (line) => console.log(line), spawnProcess: engineSpawn })
  activeCursorEngine = cursorEngine
  const claudeEngine = new ClaudeCodeCliEngine({ log: (line) => console.log(line), spawnProcess: engineSpawn })
  activeClaudeEngine = claudeEngine
  let nativeAgent: NdNativeEngine
  let taskWorktrees: TaskWorktreeManager | undefined
  const nativeBroker = new NdNativeToolBroker({
    core,
    browser: browserPlatform,
    workspace,
    ownsWorktree: (cwd) => taskWorktrees?.ownsRoot(cwd) === true,
    engine: () => nativeAgent,
  })
  await nativeBroker.reconcile().then((count) => {
    if (count > 0) console.warn(`Marked ${count} interrupted ND Agent tool effect(s) uncertain; none will be replayed.`)
  }).catch((error) => {
    console.warn('ND Agent effect reconciliation is unavailable:', error instanceof Error ? error.message : String(error))
  })
  nativeAgent = new NdNativeEngine({
    providers,
    dataDir: join(userData, 'nd-agent-sessions'),
    tool: (request) => nativeBroker.call(request),
    spawnProcess: unscopedCoreSpawn,
  })
  const engineRouter = new EngineSessionRouter(harness, codexEngine, workspace, antigravityEngine, {
    browser,
    storePath: join(userData, 'chatgpt-web-sessions.json'),
    log: (line) => console.warn(line),
  }, {
    browser,
    storePath: join(userData, 'gemini-web-sessions.json'),
    log: (line) => console.warn(line),
  }, zcodeEngine, piEngine, cursorEngine, claudeEngine, engineSpawn, directEngineJournal, nativeAgent)
  activeEngineRouter = engineRouter
  engineRouter.setBrowserAccessProvider(browserPlatform)
  const restApiService = new NdRestApiService({
    engineRouter,
    workspace,
    userDataPath: userData,
    log: (line) => console.log(line),
  })
  await restApiService.start().catch((error) => {
    console.warn('ND REST API server could not start:', error instanceof Error ? error.message : String(error))
  })
  activeRestApiService = restApiService
  const projectWorkspace = new ProjectWorkspaceCoordinator(
    organizationStore,
    workspace,
    harness,
    workspaces,
    () => {
      harness.refreshWorkspaceIdentity()
      if (theme.surface() === 'dsh') harness.warmup()
    },
  )
  await projectWorkspace.initialize()
  // One durable routing store for every pluggable capability (engine, memory,
  // context) across agents, roles, and teams; engines resolve through it too.
  // Interactive browser-only engines stay in the chat catalog but are excluded
  // from organization capability assignment until they expose ND workspaces.
  const capabilityAssignments = new CapabilityAssignmentStore(join(userData, 'capability-assignments.json'))
  const capabilityStatuses = new CapabilityStatusStore(join(userData, 'capability-statuses.json'))
  const engines = new CodingEngineRegistry(capabilityAssignments)
  const workerEngines: Pick<CodingEngineRegistry, 'list' | 'assign'> = {
    list: () => workerAssignableCodingEngines(engines.list()),
    assign: (agentId, engineId) => engines.assign(agentId, engineId),
  }
  // Approved-package setup for engine CLIs published on npm (Pi, Claude Code)
  // joins the harness source-runtime adapters; each engine id only gains a
  // setup block while its binary probe fails.
  const capabilitySetupAdapters = { ...createHarnessSourceSetupAdapters(), ...createEngineCliSetupAdapters() }
  const capabilities = new CapabilityRegistry(capabilityAssignments, workerEngines, capabilityStatuses, {
    [ND_ORG_MEMORY_ID]: async () => { await organizationStore.state() },
    [ND_WORKSPACE_CONTEXT_ID]: async () => {
      const state = workspace.state()
      if (state.binding === 'missing') throw new Error(state.warning ?? 'The project workspace is unavailable on disk.')
    },
  }, capabilitySetupAdapters)
  // Validate → Start → health check → open the built-in browser on the app
  // under development. The ND renderer origin is reserved so a project can
  // never load ND-DSH's own preview recursively inside the browser pane.
  const projectRuntime = new ProjectRuntimeService({
    store: organizationStore,
    spawnProcess: unscopedCoreSpawn,
    stopProcess: stopCoreManagedChildProcess,
    reservedOrigin,
    onTargetReady: (_projectId, url) => {
      void browser.navigate(url).catch((error) => {
        console.warn(`Browser could not open the project target ${url}:`, error instanceof Error ? error.message : String(error))
      })
    },
  })
  activeProjectRuntime = projectRuntime
  const design = new DesignService(workspace, browser)
  const ndPencil = new NdPencilController(window, workspace, projectRoot(), ndPencilPreload)
  await ndPencil.initialize()
  const coreWorktreeGit = createCoreWorktreeGit(core)
  taskWorktrees = new TaskWorktreeManager(coreWorktreeGit)
  // Task worktrees are ND's own isolated checkouts for this project, so the
  // engine router admits them by the exact roots ND created — never by a path
  // shape a caller could construct.
  engineRouter.setWorktreeGuard((cwd) => taskWorktrees.ownsRoot(cwd))
  harness.setSessionCwdGuard((cwd) => taskWorktrees.ownsRoot(cwd))
  const decisionSupport = createDecisionSupportFromEnv(process.env, fetch, core)
  const organization = new OrganizationOrchestrator(organizationStore, harness, workspace, engines, engineRouter, projectRuntime, capabilities, executionCoordinator, taskWorktrees, core, { spawnProcess: unscopedCoreSpawn, stopProcess: stopCoreManagedChildProcess, runGit: coreWorktreeGit }, browserPlatform, decisionSupport)
  const approvalGate = new OrganizationApprovalGate(organizationStore, engineRouter, core)
  const qa = new QaService({ spawnProcess: unscopedCoreSpawn, stopProcess: stopCoreManagedChildProcess })
  activeQa = qa
  qa.setProjectRoot(workspace.state().root)
  const coreGit = new GitCli({ core })
  const coreMedia = createCoreMedia(core)
  const coreClipboard = createCoreClipboard(core)
  const coreMediaKeys = createCoreMediaKeys(core)
  const coreSystemVolume = createCoreSystemVolume(core)
  const coreVault = createCoreVault(core)
  const coreApiHttp = createCoreApiHttp(core)
  const disposeIpc = registerIpc({ window, preloadPath: preload, launcherPopup, shortcuts: shortcutRegistry, browser, browserPlatform, dshSurface, engines, engineRouter, nativeToolBroker: nativeBroker, ownsWorktree: (cwd) => taskWorktrees?.ownsRoot(cwd) === true, harness, projectWorkspace, workspaces, theme, providers, externalElements, recentPicks, git, corePackageSnapshot: createCorePackageSnapshot(core), coreGit: coreGit.exec.bind(coreGit), coreMedia, coreClipboard, coreMediaKeys, coreSystemVolume, coreVault, coreApiHttp, coreDisk: createCoreDiskScan(core), coreComputer: createCoreComputer(core), qa, sessionArchive, usageLedger, capabilities, organizationStore })
  if (nativeAgent.ready()) void nativeAgent.start().catch((error) => {
    console.warn('ND Agent private runtime could not initialize:', error instanceof Error ? error.message : String(error))
  })
  const disposeBrowserCompanionIpc = registerBrowserCompanionIpc(window, browserCompanion)
  const disposeBrowserPlatformIpc = registerBrowserPlatformIpc(window, browserPlatform)
  browserPlatform.setListener((state) => {
    if (!window.isDestroyed()) window.webContents.send('browser-platform:changed-event', state)
  })
  browserCompanion.setListener((state) => {
    if (!window.isDestroyed()) window.webContents.send('browser-companion:changed-event', state)
    void browserPlatform.notifyCompanionChanged()
  })
  const disposeTerminalIpc = registerTerminalIpc(window, terminalManager, routerService)
  const disposeDesignIpc = registerDesignIpc(window, design, ndPencil)
  const disposeOrganizationIpc = registerOrganizationIpc(window, organizationStore, organization, projectWorkspace, projectRuntime, executionCoordinator, () => launcherPopup.window(), localRuntime)
  const disposeLocalRuntimeIpc = registerLocalRuntimeIpc(window, localRuntime)
  mainWindow = window
  activeHarness = harness
  activeNdPencil = ndPencil

  projectRuntime.setListener((status) => {
    if (!window.isDestroyed()) window.webContents.send(ORGANIZATION_IPC.runtimeChanged, status)
  })

  // Agent runs mutate the organization in bursts and every broadcast re-renders the
  // workbench from full state, so only the latest snapshot per window is sent.
  const broadcastOrganization = throttleLatest<OrganizationSnapshot>(ORGANIZATION_BROADCAST_INTERVAL_MS, (state) => {
    if (!window.isDestroyed()) window.webContents.send(ORGANIZATION_IPC.changed, state)
  })
  organizationStore.setOnChanged(broadcastOrganization)
  let lastWorkspaceRoot = workspace.state().root
  workspace.setStateListener((state) => {
    // Project checks and a running dev server always belong to the active
    // workspace; both services dedupe no-op updates themselves.
    qa.setProjectRoot(state.root)
    void projectRuntime.handleWorkspaceChanged(state.root).catch((error) => {
      console.warn('Project runtime workspace synchronization failed:', error instanceof Error ? error.message : String(error))
    })
    const rootChanged = lastWorkspaceRoot !== state.root
    lastWorkspaceRoot = state.root
    if (rootChanged) void ndPencil.setVisible(false)
    // Git belongs to the active workspace/project context. A project can
    // become unlinked or change identity without changing the filesystem root,
    // so refresh on every workspace state event rather than only root changes.
    void git.handleWorkspaceChanged().catch((error) => {
      console.warn('Git workspace synchronization failed:', error instanceof Error ? error.message : String(error))
    })
    if (!window.isDestroyed()) window.webContents.send(IPC.workspaceStateEvent, state)
    void design.handleWorkspaceChanged(state).catch((error) => {
      console.warn('Design workspace synchronization failed:', error instanceof Error ? error.message : String(error))
    })
    void ndPencil.handleWorkspaceChanged(state.root).catch((error) => {
      console.warn('ND Pencil workspace synchronization failed:', error instanceof Error ? error.message : String(error))
    })
  })
  git.setStateListener((state) => {
    if (!window.isDestroyed()) window.webContents.send(IPC.gitStateEvent, state)
  })
  void git.refresh().catch((error) => {
    console.warn('Initial Git status failed:', error instanceof Error ? error.message : String(error))
  })
  qa.setListener((event) => {
    if (window.isDestroyed()) return
    if (event.kind === 'state') window.webContents.send(IPC.qaStateEvent, event.state)
    else window.webContents.send(IPC.qaOutputEvent, event.chunk)
  })
  theme.attach(window, (color) => {
    browser.setBackgroundColor(color)
    dshSurface.setBackgroundColor(color)
    ndPencil.setBackgroundColor(color)
  })
  theme.setOnChanged((state) => {
    if (!window.isDestroyed()) window.webContents.send(IPC.themeChangedEvent, state)
    const popup = launcherPopup.window()
    if (popup && !popup.isDestroyed()) popup.webContents.send(IPC.themeChangedEvent, state)
  })
  theme.setOnSurfaceChanged((surface) => {
    if (!window.isDestroyed()) window.webContents.send(IPC.surfaceChangedEvent, { surface, view: dshSurface.state() })
  })

  browser.setStateListener((state) => {
    if (!window.isDestroyed()) window.webContents.send(IPC.browserStateEvent, state)
    browserPlatform.notifyBrowserChanged()
  })
  ndPencil.setStateListener((state) => {
    if (!window.isDestroyed()) window.webContents.send(DESIGN_IPC.freeformChanged, state)
  })
  dshSurface.setStateListener((state) => {
    if (!window.isDestroyed()) window.webContents.send(IPC.dshViewStateEvent, state)
  })
  // Every engine's translated frames share one fan-out: the organization
  // orchestrator consumes run semantics, and the renderer sees the same
  // DshEventFrame vocabulary regardless of which engine produced it.
  let rendererEventChain = Promise.resolve()
  const dispatchEngineFrame = (frame: DshEventFrame): void => {
    rendererEventChain = rendererEventChain.then(async () => {
      const restored = frame.sessionId ? await engineRouter.restoreMessages(frame.sessionId, frame) : frame
      dispatchRestoredFrame(restored)
    }).catch((error) => console.error('Chat event reconciliation failed:', error))
  }
  const dispatchRestoredFrame = (frame: DshEventFrame): void => {
    // One fan-out for every engine, so tool calls and escalations are counted
    // for harness and direct-engine sessions through the same production path
    // the renderer and the organization orchestrator already consume.
    taskMetricsRecorder()?.noteFrame(frame)
    void organization.handleHarnessEvent(frame).catch((error) => {
      console.error('Organization event handling failed:', error)
    })

    if (frame.kind === 'approval-requested') {
      void approvalGate.shouldForward(frame)
        .then((forward) => {
          if (forward && !window.isDestroyed()) window.webContents.send(IPC.dshEvent, frame)
        })
        .catch((error) => {
          console.error('Organization approval policy gate failed:', error)
          if (!window.isDestroyed()) window.webContents.send(IPC.dshEvent, frame)
        })
      return
    }

    if (!window.isDestroyed()) window.webContents.send(IPC.dshEvent, frame)
  }
  harness.setListeners({
    status: (status) => {
      if (!window.isDestroyed()) window.webContents.send(IPC.harnessStatusEvent, status)
    },
    event: dispatchEngineFrame,
    gatewayReady: (url) => {
      console.log(`ND-DSH gateway ready at ${new URL(url).origin}`)
      dshSurface.setTarget(url)
      // Sessions created before ND began naming them still show the runtime's
      // "You are…" first-prompt fallback; rename them once per runtime boot.
      void organization.backfillSessionTitles()
    },
  })
  codexEngine.setEmitter(dispatchEngineFrame)
  antigravityEngine.setEmitter(dispatchEngineFrame)
  zcodeEngine.setEmitter(dispatchEngineFrame)
  piEngine.setEmitter(dispatchEngineFrame)
  cursorEngine.setEmitter(dispatchEngineFrame)
  claudeEngine.setEmitter(dispatchEngineFrame)
  engineRouter.setEmitter(dispatchEngineFrame)

  const rendererUrl = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL
  const rendererFile = join(currentDirectory, '../renderer/index.html')
  const allowedRenderer = createRendererUrlGuard(rendererUrl, rendererFile)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!allowedRenderer(url)) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!allowedRenderer(url)) event.preventDefault()
  })
  // Native edit context menu: chat text copies like desktop text (select →
  // right-click → Copy), inputs get the standard editing verbs, images copy
  // directly. Roles only — no navigation; image copy uses the copyImageAt
  // webContents call because Electron ships no `copyImage` menu role.
  window.webContents.on('context-menu', (_event, props) => {
    const items: MenuItemConstructorOptions[] = []
    if (props.isEditable) {
      if (props.selectionText.trim().length > 0) items.push({ role: 'cut' }, { role: 'copy' })
      items.push({ role: 'paste' }, { role: 'selectAll' })
    } else {
      if (props.selectionText.trim().length > 0) items.push({ role: 'copy' })
      if (props.mediaType === 'image' && props.srcURL) {
        items.push({
          label: 'Copy image',
          click: () => window.webContents.copyImageAt(props.x, props.y),
        })
      }
    }
    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window })
  })
  window.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && input.key.toLowerCase() === 's' && input.type === 'keyDown') {
      if (ndPencil.state().visible && ndPencil.state().dirty) {
        event.preventDefault()
        void ndPencil.save().catch((error) => console.error('Shortcut save failed:', error))
      }
    }
  })

  const launchInBackground = localRuntime.shouldLaunchInBackground(process.argv)
  window.once('ready-to-show', () => {
    if (launchInBackground) {
      window.hide()
      localRuntime?.setBackground(true)
      return
    }
    window.show()
    window.focus()
    localRuntime?.setBackground(false)
  })
  if (rendererUrl) await window.loadURL(rendererUrl)
  else await window.loadFile(rendererFile)
  markStartup('renderer-loaded')
  // Hotkeys go live as soon as the window exists. createWindow still runs a long
  // benchmark tail afterwards, and a launcher key that only works once startup
  // benchmarks finish is a key that appears broken.
  shortcutRegistry.sync()

  await browser.initialize(startUrl).catch((error) => {
    console.warn('Initial browser navigation failed:', error)
  })
  markStartup('usable')
  const startupCoreMetrics = core ? await core.request('metrics.snapshot', {}, 5_000).catch(() => null) : null
  await flushStartupBenchmark({ core: core?.health ?? null, coreMetrics: startupCoreMetrics })
  const runtimeBenchmarkOutput = process.env.ND_DSH_RUNTIME_BENCH_OUTPUT?.trim()
  const browserPlatformBenchmarkOutput = process.env.ND_DSH_BROWSER_PLATFORM_BENCH_OUTPUT?.trim()
  const companionChromeSmokeOutput = process.env.ND_DSH_COMPANION_SMOKE_OUTPUT?.trim()
  const packagedSmokeOutput = process.env.ND_DSH_PACKAGED_SMOKE_OUTPUT?.trim()
  const agentTaskBenchmarkOutput = process.env.ND_DSH_AGENT_TASK_BENCH_OUTPUT?.trim()
  if (browserPlatformBenchmarkOutput) {
    try {
      await runBrowserPlatformBenchmark({
        outputPath: browserPlatformBenchmarkOutput,
        browser,
        browserPlatform,
      })
      console.log('Unified browser platform benchmark completed.')
      setTimeout(() => app.quit(), 25)
    } catch (error) {
      console.error('Unified browser platform benchmark failed:', error)
      app.exit(1)
      return
    }
  } else if (companionChromeSmokeOutput) {
    try {
      await runCompanionChromeSmoke({
        outputPath: companionChromeSmokeOutput,
        browser,
        browserPlatform,
      })
      setTimeout(() => app.quit(), 25)
    } catch (error) {
      console.error('Browser companion Chrome smoke failed:', error)
      app.exit(1)
      return
    }
  } else if (runtimeBenchmarkOutput) {
    try {
      await runRuntimeBenchmark({
        outputPath: runtimeBenchmarkOutput,
        workspaceRoot: workspace.state().root,
        ...(core ? { core } : {}),
        terminal: terminalManager,
        git,
        coordinator: executionCoordinator,
        spawnProcess: engineSpawn,
      })
      console.log('Runtime benchmark completed.')
      setTimeout(() => app.quit(), 25)
    } catch (error) {
      console.error('Runtime benchmark failed:', error)
      app.exit(1)
      return
    }
  } else if (packagedSmokeOutput) {
    if (!core) throw new Error('Packaged runtime smoke requires the Rust core backend.')
    try {
      await runPackagedRuntimeSmoke({
        outputPath: packagedSmokeOutput,
        workspaceRoot: workspace.state().root,
        core,
        terminal: terminalManager,
        git,
        harness,
        browser,
        spawnProcess: unscopedCoreSpawn,
        codingCliPath: codexBinPath(),
      })
      console.log('Packaged runtime smoke passed.')
      setTimeout(() => app.quit(), 25)
    } catch (error) {
      console.error('Packaged runtime smoke failed:', error)
      app.exit(1)
      return
    }
  } else if (agentTaskBenchmarkOutput) {
    try {
      const metrics = taskMetricsRecorder()
      if (!metrics) throw new Error('Agent-task benchmark requires the main-process task metrics recorder.')
      await runAgentTaskBenchmark({
        outputPath: agentTaskBenchmarkOutput,
        scenario: agentTaskBenchmarkScenarioFromEnv(process.env.ND_DSH_AGENT_TASK_BENCH_SCENARIO),
        store: organizationStore,
        orchestrator: organization,
        engines,
        capabilities,
        recorder: metrics,
        workspaceRoot: workspace.state().root,
      })
      console.log('Agent-task benchmark completed.')
      setTimeout(() => app.quit(), 25)
    } catch (error) {
      console.error('Agent-task benchmark failed:', error)
      app.exit(1)
      return
    }
  } else if (process.env.ND_DSH_BENCHMARK_EXIT === '1') {
    setTimeout(() => app.quit(), 25)
  }
  if (theme.surface() === 'dsh') harness.warmup()
  if (!launchInBackground && !window.isVisible()) {
    window.show()
    window.focus()
  }

  let closeAfterFreeformSave = false
  let savingFreeformForClose = false
  window.on('close', (event) => {
    if (shutdownStarted) return
    if (localRuntime?.isAlwaysOn()) {
      event.preventDefault()
      const hide = (): void => {
        if (!window.isDestroyed()) {
          window.hide()
          localRuntime?.setBackground(true)
        }
      }
      if (!ndPencil.state().dirty) {
        hide()
        return
      }
      if (savingFreeformForClose) return
      savingFreeformForClose = true
      void ndPencil.close()
        .then(() => {
          savingFreeformForClose = false
          hide()
        })
        .catch((error) => {
          savingFreeformForClose = false
          console.error('Refusing to background ND with an unsaved Freeform document:', error)
        })
      return
    }
    if (closeAfterFreeformSave || !ndPencil.state().dirty) return
    event.preventDefault()
    if (savingFreeformForClose) return
    savingFreeformForClose = true
    void ndPencil.close()
      .then(() => {
        closeAfterFreeformSave = true
        if (!window.isDestroyed()) window.close()
      })
      .catch((error) => {
        savingFreeformForClose = false
        console.error('Refusing to close ND with an unsaved Freeform document:', error)
      })
  })

  window.on('closed', () => {
    launcherPopup.dispose()
    organizationStore.setOnChanged(undefined)
    broadcastOrganization.cancel()
    workspace.setStateListener(undefined)
    ndPencil.setStateListener(undefined)
    disposeOrganizationIpc()
    disposeLocalRuntimeIpc()
    disposeBrowserPlatformIpc()
    browserPlatform.setListener(undefined)
    disposeBrowserCompanionIpc()
    browserCompanion.setListener(undefined)
    disposeDesignIpc()
    disposeTerminalIpc()
    disposeIpc()
    disposeCoreReady()
    disposeHarnessJournalRecovery()
    if (activeQa === qa) { activeQa = undefined; beginQaClose(qa) }
    if (activeProjectRuntime === projectRuntime) { activeProjectRuntime = undefined; beginProjectRuntimeClose(projectRuntime) }
    design.destroy()
    if (activeNdPencil === ndPencil) { activeNdPencil = undefined; beginNdPencilClose(ndPencil) }
    if (activeEngineRouter === engineRouter) { activeEngineRouter = undefined; beginEngineRouterClose(engineRouter) }
    if (activeRestApiService === restApiService) { activeRestApiService = undefined; beginRestApiClose(restApiService) }
    if (activeBrowserPlatform === browserPlatform) { activeBrowserPlatform = undefined; beginBrowserPlatformClose(browserPlatform) }
    if (activeBrowser === browser) { activeBrowser = undefined; beginBrowserClose(browser) }
    if (activeBrowserCompanion === browserCompanion) { activeBrowserCompanion = undefined; beginBrowserCompanionClose(browserCompanion) }
    dshSurface.destroy()
    if (mainWindow === window) mainWindow = undefined
    if (activeHarness === harness) activeHarness = undefined
    if (activeCodexEngine === codexEngine) activeCodexEngine = undefined
    if (activeAntigravityEngine === antigravityEngine) activeAntigravityEngine = undefined
    if (activeZcodeEngine === zcodeEngine) activeZcodeEngine = undefined
    if (activePiEngine === piEngine) activePiEngine = undefined
    if (activeCursorEngine === cursorEngine) activeCursorEngine = undefined
    if (activeClaudeEngine === claudeEngine) activeClaudeEngine = undefined
    if (activeTerminalManager === terminalManager) { activeTerminalManager = undefined; beginTerminalClose(terminalManager) }
    if (activeExecutionCoordinator === executionCoordinator) { activeExecutionCoordinator = undefined; beginExecutionCoordinatorClose(executionCoordinator) }
    const coreToClose = core && activeCore === core ? core : undefined
    if (coreToClose) activeCore = undefined
    beginCodexClose(codexEngine)
    beginAntigravityClose(antigravityEngine)
    beginZcodeClose(zcodeEngine)
    beginPiClose(piEngine)
    beginCursorClose(cursorEngine)
    beginClaudeClose(claudeEngine)
    beginHarnessClose(harness)
    if (coreToClose) beginCoreCloseAfterTrackedServices(coreToClose)
  })
}

if (hasSingleInstanceLock) {
  void (async () => {
    const cdpPort = await resolveCdpPort(requestedCdpPort)
    console.log(`ND-DSH CDP port: ${cdpPort}`)
    app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort))
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
    await app.whenReady()
    markStartup('app-ready')
    await createWindow(cdpPort)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow(cdpPort).catch(reportFatalStartupError)
    })
  })().catch(reportFatalStartupError)
}

app.on('will-quit', () => {
  shortcutRegistry.dispose()
})

app.on('before-quit', (event) => {
  if (shutdownStarted) return
  const ndPencilForRetry = activeNdPencil
  let coreToClose: CoreClient | undefined
  if (activeHarness) {
    const harness = activeHarness
    activeHarness = undefined
    beginHarnessClose(harness)
  }
  if (activeQa) {
    const qa = activeQa
    activeQa = undefined
    beginQaClose(qa)
  }
  if (activeProjectRuntime) {
    const projectRuntime = activeProjectRuntime
    activeProjectRuntime = undefined
    beginProjectRuntimeClose(projectRuntime)
  }
  if (activeBrowserPlatform) {
    const browserPlatform = activeBrowserPlatform
    activeBrowserPlatform = undefined
    beginBrowserPlatformClose(browserPlatform)
  }
  if (activeBrowser) {
    const browser = activeBrowser
    activeBrowser = undefined
    beginBrowserClose(browser)
  }
  if (activeBrowserCompanion) {
    const browserCompanion = activeBrowserCompanion
    activeBrowserCompanion = undefined
    beginBrowserCompanionClose(browserCompanion)
  }
  if (activeCodexEngine) {
    const codexEngine = activeCodexEngine
    activeCodexEngine = undefined
    beginCodexClose(codexEngine)
  }
  if (activeAntigravityEngine) {
    const antigravityEngine = activeAntigravityEngine
    activeAntigravityEngine = undefined
    beginAntigravityClose(antigravityEngine)
  }
  if (activeZcodeEngine) {
    const zcodeEngine = activeZcodeEngine
    activeZcodeEngine = undefined
    beginZcodeClose(zcodeEngine)
  }
  if (activePiEngine) {
    const piEngine = activePiEngine
    activePiEngine = undefined
    beginPiClose(piEngine)
  }
  if (activeCursorEngine) {
    const cursorEngine = activeCursorEngine
    activeCursorEngine = undefined
    beginCursorClose(cursorEngine)
  }
  if (activeClaudeEngine) {
    const claudeEngine = activeClaudeEngine
    activeClaudeEngine = undefined
    beginClaudeClose(claudeEngine)
  }
  if (activeEngineRouter) {
    const engineRouter = activeEngineRouter
    activeEngineRouter = undefined
    beginEngineRouterClose(engineRouter)
  }
  if (activeRestApiService) {
    const restApiService = activeRestApiService
    activeRestApiService = undefined
    beginRestApiClose(restApiService)
  }
  if (activeTerminalManager) {
    const terminalManager = activeTerminalManager
    activeTerminalManager = undefined
    beginTerminalClose(terminalManager)
  }
  if (activeExecutionCoordinator) {
    const executionCoordinator = activeExecutionCoordinator
    activeExecutionCoordinator = undefined
    beginExecutionCoordinatorClose(executionCoordinator)
  }
  if (activeCore) {
    coreToClose = activeCore
    activeCore = undefined
  }
  if (activeNdPencil) {
    const ndPencil = activeNdPencil
    activeNdPencil = undefined
    beginNdPencilClose(ndPencil)
  }
  if (coreToClose) beginCoreCloseAfterTrackedServices(coreToClose)
  if (closingServices.size === 0) {
    // Nothing tracked is left to close, but a browser daemon can still be running:
    // it may have been started by a child that already exited.
    console.log('[nd] exit sweep (no tracked services)')
    event.preventDefault()
    shutdownStarted = true
    void (async () => {
      await stopAppOwnedBrowserDaemons()
        .then((stopped) => console.log(`[nd] exit sweep pass 1 stopped ${stopped} app-owned browser daemon(s)`))
        .catch((error) => console.error('Failed to stop app-owned browser daemons:', error))
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 750))
      await stopAppOwnedBrowserDaemons()
        .then((stopped) => console.log(`[nd] exit sweep pass 2 stopped ${stopped} app-owned browser daemon(s)`))
        .catch((error) => console.error('Failed to stop app-owned browser daemons:', error))
    })().finally(() => {
      void log.flush()
      app.exit(0)
    })
    return
  }
  event.preventDefault()
  shutdownStarted = true
  const pending = [...closingServices]
  const shutdownTimeout = setTimeout(() => {
    console.warn('ND shutdown timed out waiting for background services; exiting forcefully.')
    // Cleanup that has not settled never runs, so reap browser daemons here: a
    // daemon that outlives this process keeps inherited pipes open after it, and
    // the failed quit path is exactly when that happens.
    const swept = stopAppOwnedBrowserDaemons()
      .then((stopped) => console.log(`[nd] forced-exit sweep stopped ${stopped} app-owned browser daemon(s)`))
      .catch(() => undefined)
    void Promise.race([swept, new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500))])
      .finally(() => app.exit(0))
  }, 5_000)
  void Promise.allSettled(pending).then(async (results) => {
    clearTimeout(shutdownTimeout)
    void log.flush()
    if (results.some((result) => result.status === 'rejected')) {
      shutdownStarted = false
      if (ndPencilForRetry) activeNdPencil = ndPencilForRetry
      if (coreToClose) activeCore = coreToClose
      console.error('ND quit was canceled because the Freeform document could not be saved safely.')
      return
    }
    // An engine or the Harness runtime can still start a browser daemon while it
    // stops. A daemon that outlives this process keeps inherited pipes open, so
    // take a last pass once every service close has settled — twice, with a beat
    // between, because a child that is still tearing down can spawn its daemon
    // just after the first pass has already looked.
    await stopAppOwnedBrowserDaemons()
      .then((stopped) => console.log(`[nd] exit sweep pass 1 stopped ${stopped} app-owned browser daemon(s)`))
      .catch((error) => console.error('Failed to stop app-owned browser daemons:', error))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 750))
    await stopAppOwnedBrowserDaemons()
      .then((stopped) => console.log(`[nd] exit sweep pass 2 stopped ${stopped} app-owned browser daemon(s)`))
      .catch((error) => console.error('Failed to stop app-owned browser daemons:', error))
    app.exit(0)
  })
})

app.on('window-all-closed', () => {
  if (localRuntime?.isAlwaysOn()) return
  if (process.platform !== 'darwin') app.quit()
})

function beginBrowserClose(browser: BrowserController): void {
  trackClose(browser.destroy().catch((error) => console.error('Failed to close the browser integration cleanly:', error)))
}

function beginBrowserPlatformClose(browserPlatform: BrowserPlatformService): void {
  trackClose(browserPlatform.close().catch((error) => console.error('Failed to close the unified browser platform cleanly:', error)))
}

function beginBrowserCompanionClose(browserCompanion: BrowserCompanionService): void {
  trackClose(browserCompanion.stop().catch((error) => console.error('Failed to close the browser companion cleanly:', error)))
}

function beginExecutionCoordinatorClose(coordinator: ExecutionCoordinator): void {
  trackClose(coordinator.close().catch((error) => console.error('Failed to close ND runtime permits cleanly:', error)))
}

function beginCoreCloseAfterTrackedServices(core: CoreClient): void {
  // Services use ND Core for their final flush, terminal close, and permit
  // release. Snapshot their shutdown promises before tracking this dependent
  // close so the core remains available until all clients have finished.
  const dependencies = [...closingServices]
  trackClose(Promise.all(dependencies).then(() => core.close()).catch((error) => {
    console.error('Failed to close ND Core after its clients stopped:', error)
  }))
}

function beginHarnessClose(harness: HarnessService): void {
  trackClose(harness.close().catch((error) => console.error('Failed to close ND runtime cleanly:', error)))
}

function beginQaClose(qa: QaService): void {
  trackClose(qa.dispose().catch((error) => console.error('Failed to stop project checks cleanly:', error)))
}

function beginProjectRuntimeClose(projectRuntime: ProjectRuntimeService): void {
  trackClose(projectRuntime.dispose().catch((error) => console.error('Failed to stop the project runtime cleanly:', error)))
}

function beginCodexClose(codexEngine: CodexCliEngine): void {
  trackClose(codexEngine.close().catch((error) => console.error('Failed to close the Codex engine cleanly:', error)))
}

function beginAntigravityClose(antigravityEngine: AntigravityEngine): void {
  trackClose(antigravityEngine.close().catch((error) => console.error('Failed to close the Antigravity engine cleanly:', error)))
}

function beginZcodeClose(zcodeEngine: ZcodeCliEngine): void {
  trackClose(zcodeEngine.close().catch((error) => console.error('Failed to close the ZCode engine cleanly:', error)))
}

function beginPiClose(piEngine: PiCodingEngine): void {
  trackClose(piEngine.close().catch((error) => console.error('Failed to close the Pi engine cleanly:', error)))
}

function beginCursorClose(cursorEngine: CursorCliEngine): void {
  trackClose(cursorEngine.close().catch((error) => console.error('Failed to close the Cursor engine cleanly:', error)))
}

function beginClaudeClose(claudeEngine: ClaudeCodeCliEngine): void {
  trackClose(claudeEngine.close().catch((error) => console.error('Failed to close the Claude Code engine cleanly:', error)))
}

function beginEngineRouterClose(engineRouter: EngineSessionRouter): void {
  trackClose(engineRouter.close().catch((error) => console.error('Failed to close the engine router cleanly:', error)))
}

function beginRestApiClose(restApi: NdRestApiService): void {
  trackClose(restApi.stop().catch((error) => console.error('Failed to close the ND REST API server cleanly:', error)))
}

function beginTerminalClose(terminalManager: TerminalManager): void {
  trackClose(terminalManager.shutdown().catch((error) => console.error('Failed to close session terminals cleanly:', error)))
}

function beginNdPencilClose(ndPencil: NdPencilController): void {
  trackClose(ndPencil.close()
    .catch((error) => {
      console.error('Failed to save/close ND Pencil cleanly:', error)
      throw error
    })
    .then(() => ndPencil.destroy()))
}

function trackClose(promise: Promise<void>): void {
  let task: Promise<void>
  task = promise.finally(() => closingServices.delete(task))
  closingServices.add(task)
  // Keep rejection visible to the quit handler, while preventing an
  // unhandled-rejection if a macOS window closes before the app quits.
  void task.catch(() => undefined)
}

function reportFatalStartupError(error: unknown): void {
  // A packaged Windows build has no console: quitting silently is how the app
  // "just vanishes" for a user. Name the failure, name the log, then exit.
  const message = error instanceof Error ? error.message : String(error)
  console.error('ND-DSH failed to start:', error)
  log.write('error', `fatal startup failure: ${message}`)
  void log.flush().finally(() => {
    try {
      dialog.showErrorBox('ND-DSH could not start', `${message}\n\nA diagnostic log was written to:\n${log.path}`)
    } catch {
      // A dialog can fail before the app is ready; the log is the durable record.
    }
    app.quit()
  })
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1_024 && parsed < 65_536 ? parsed : fallback
}

/**
 * Honor ND_DSH_CDP_PORT only when it is actually bindable. A stale ND-DSH
 * process (or a dev instance) holding the pinned port previously killed
 * Chromium's devtools server, which made the agent-browser binding time out
 * and blocked runtime startup entirely. Fall back to a free port instead.
 */
async function resolveCdpPort(requested: number): Promise<number> {
  if (requested <= 0) return pickFreePort()
  if (await canBindLoopback(requested)) return requested
  console.warn(`ND_DSH_CDP_PORT=${requested} is already in use (another ND-DSH process?); using a free port instead.`)
  return pickFreePort()
}

function canBindLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

function createRendererUrlGuard(devUrl: string | undefined, rendererFile: string): (url: string) => boolean {
  if (devUrl) {
    const allowedOrigin = new URL(devUrl).origin
    return (url) => {
      try { return new URL(url).origin === allowedOrigin } catch { return false }
    }
  }
  const allowedFile = pathToFileURL(rendererFile).href
  return (url) => url === allowedFile || url.startsWith(`${allowedFile}#`)
}
