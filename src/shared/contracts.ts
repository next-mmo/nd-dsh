import type { LauncherHandoffTarget, QuickLauncherShortcutMode } from './quick-launcher.js'
import type { GlobalShortcutId, GlobalShortcutState, CaptureDelaySeconds } from './shortcuts.js'
import type { NdMediaSessionState } from './media-session.js'
import type { WorkspaceProfile } from './workspace-profile.js'

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export type UiSourceConfidence = 'exact' | 'mapped' | 'framework' | 'inferred'

export interface UiSourceLocation {
  file: string
  line: number
  column?: number
  confidence: UiSourceConfidence
}

export interface UiReactInfo {
  component?: string
  hierarchy: string[]
  source?: UiSourceLocation
}

export interface UiCssDeclaration {
  name: string
  value: string
  important?: boolean
  source?: UiSourceLocation
}

export interface UiCssRule {
  selector: string
  origin: string
  declarations: UiCssDeclaration[]
  source?: UiSourceLocation
  sourceUrl?: string
  sourceMapUrl?: string
}

export interface UiTarget {
  id: string
  runtime: 'web'
  capturedAt: number
  url: string
  tagName: string
  text: string
  selector: string
  outerHtml: string
  attributes: Record<string, string>
  bounds: BrowserBounds
  computedStyle: Record<string, string>
  matchedCssRules: UiCssRule[]
  source?: UiSourceLocation
  react?: UiReactInfo
}

export interface UiAnnotationPoint {
  x: number
  y: number
}

export type UiAnnotationMarkKind = 'freehand' | 'rectangle' | 'point'

export interface UiAnnotationMark {
  kind: UiAnnotationMarkKind
  points: UiAnnotationPoint[]
  bounds: BrowserBounds
}

export interface UiAnnotationElementReference {
  selector: string
  tagName: string
  text: string
  bounds: BrowserBounds
  source?: UiSourceLocation
  react?: UiReactInfo
}

export interface UiAnnotation {
  id: string
  runtime: 'web'
  capturedAt: number
  url: string
  viewport: { width: number; height: number }
  marks: UiAnnotationMark[]
  elements: UiAnnotationElementReference[]
}

export type AgentBrowserState = 'binding' | 'ready' | 'unavailable'

export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  visible: boolean
  cdpPort: number
  targetId?: string
  profileId?: string
  activeTabId?: string
  tabs?: import('./browser-platform.js').BrowserTabDescriptor[]
  downloads?: import('./browser-platform.js').BrowserDownloadRecord[]
  agentBrowser: AgentBrowserState
  agentBrowserError?: string
  inspectMode?: boolean
  selectedTarget?: UiTarget
  annotationMode?: boolean
  annotation?: UiAnnotation
}

export interface WorkspaceEntry {
  name: string
  relativePath: string
  kind: 'file' | 'directory'
}

export type WorkspaceBinding = 'standalone' | 'project' | 'unlinked' | 'missing'

export interface WorkspaceState {
  root: string
  name: string
  /**
   * True only when this root came from an explicit selection: the folder picker,
   * a saved/open workspace, or the folder restored for a selected organization
   * project. The boot fallback (`process.cwd()` / `ND_DSH_WORKSPACE`) is never a
   * selection, so product surfaces must not present an unselected root as a
   * project.
   */
  selectedByUser?: boolean
  binding?: WorkspaceBinding
  companyId?: string
  companyName?: string
  companyMission?: string
  projectId?: string
  projectName?: string
  projectObjective?: string
  projectStatus?: string
  projectWorkspacePath?: string
  warning?: string
}

/** One pinned workspace in the persisted sidebar registry. */
export interface SavedWorkspace {
  id: string
  root: string
  name: string
  addedAt: number
  lastOpenedAt?: number
}

export interface WorkspaceRegistryView {
  version: 1
  activeId?: string
  items: SavedWorkspace[]
}

/** Result of opening a saved workspace: the new root state plus the refreshed registry. */
export interface WorkspaceOpenResult {
  state: WorkspaceState
  registry: WorkspaceRegistryView
}

export interface WorkspaceFile {
  relativePath: string
  content: string
  truncated: boolean
  /** Sanitized, inert DOCX preview produced by the trusted workspace reader. */
  previewHtml?: string
}

export interface WorkspaceSuggestion {
  relativePath: string
  kind: 'file' | 'directory'
}

/** One changed path from `git status --porcelain -z`: x = index status, y = worktree status. Derived from microsoft/vscode extensions/git (MIT). */
export interface GitFileChange {
  path: string
  originalPath?: string | undefined
  x: string
  y: string
}

export interface GitCommitInfo {
  hash: string
  message: string
  authorName: string
  authorEmail: string
  date: string
}

export interface GitBranch {
  name: string
  current: boolean
  upstream?: string | undefined
  ahead?: number | undefined
  behind?: number | undefined
}

export interface GitStatusSnapshot {
  root: string
  /** Worktree root of the containing repository, or null when the workspace is not inside a Git repository. */
  repoRoot: string | null
  branch: string | null
  ahead: number
  behind: number
  heads: GitCommitInfo[]
  branches: GitBranch[]
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: GitFileChange[]
  conflicts: GitFileChange[]
  remotes: string[]
  timestamp: number
}

export type HarnessState = 'stopped' | 'starting' | 'ready' | 'running' | 'error'

export interface HarnessStatus {
  state: HarnessState
  sourceReady: boolean
  apiKeyPresent: boolean
  /** Whether the active provider route normally requires a credential. */
  apiKeyRequired: boolean
  provider: string
  model: string
  sessionId?: string
  url?: string
  port?: number
  error?: string
  /** Semver of the active @deepseek-ai/dsh runtime package, when known. */
  runtimeVersion?: string
}

export interface HarnessRunResult {
  sessionId: string
  messageId?: string
}

export interface HarnessRunImage {
  data: string
  mediaType: string
  name: string
}

export interface HarnessRunOptions {
  /** Opaque ND catalog scope; checked again before skill dispatch. */
  skillScope?: string
  skillSelectionId?: string
  sessionId?: string
  engineId?: string
  provider?: string
  model?: string
  image?: HarnessRunImage
  /** User-pasted images riding with this prompt (base64 payloads, no data URL prefix). */
  images?: HarnessRunImage[]
  permissionMode?: string
  /**
   * Exact working directory for this session/turn. It is used when a session
   * is created and keeps the trusted prompt metadata aligned with an existing
   * task worktree or ND Home chat directory. Defaults to the active workspace.
   * A path alone is not a sandbox — higher-level workspace policy owns safety.
   */
  workspaceCwd?: string
}

/** ND-managed non-harness chat session surfaced alongside gateway sessions. */
export interface EngineSessionSummary {
  sessionId: string
  engineId: string
  title: string
  cwd?: string
  createdAt: number
  updatedAt: number
  running: boolean
  /** ND-side archival flag, resolved from the desktop archive store. */
  archived?: boolean
}

/** Replayed session events for a non-harness chat session. */
export interface EngineSessionTranscript {
  sessionId: string
  engineId: string
  events: SessionEventEnvelope[]
}

export type CodingEngineIntegration = 'primary' | 'delegated'

export interface CodingEngineCapabilities {
  workspace: boolean
  filesystem: boolean
  shell: boolean
  browser: boolean
  skills: boolean
  mcp: boolean
  modelProviderRouting: boolean
  humanApprovals: boolean
  streaming: boolean
  persistentSessions: boolean
}

export type CodingEngineInstallPlatform = 'win32' | 'darwin' | 'linux'

/** End-user install guidance for a third-party CLI engine; ND never installs it. */
export interface CodingEngineInstallHelp {
  /** Official install/download page; absolute https. */
  url?: string
  /** Copyable official command; a plain string is platform-agnostic. */
  command?: string | Partial<Record<CodingEngineInstallPlatform, string>>
}

export interface CodingEngineDescriptor {
  id: string
  name: string
  integration: CodingEngineIntegration
  available: boolean
  description: string
  unavailableReason?: string
  capabilities: CodingEngineCapabilities
  /** Engine-owned execution guidance injected into organization worker prompts. */
  workerInstructions?: string
  installHelp?: CodingEngineInstallHelp
}

/** A model selectable for an engine's native configuration; empty name means display the id. */
export interface ChatGptProjectBinding {
  workspaceRoot: string
  projectId?: string
  projectName: string
  chatGptProjectRef: string
  chatGptProjectId: string
  chatGptProjectUrl: string
  source: 'auto' | 'manual'
  updatedAt: number
}

export interface EngineModelOption {
  id: string
  name?: string
}

export type DshSurface = 'dsh' | 'workbench'

export interface DshViewState {
  ready: boolean
  loading: boolean
  title: string
  visible: boolean
  url?: string
  port?: number
}

export interface SurfaceState {
  surface: DshSurface
  view: DshViewState
}

export interface SessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  origin?: 'subagent'
  cwd?: string
  agentPreset?: string
  /** ND-side archival flag; the pinned runtime list is annotated by the main process. */
  archived?: boolean
  projections?: { asOfSeq: number; values: Record<string, unknown> }
}

export interface ModelReasoningEffort {
  id: string
  name: string
  description?: string
}

export interface ModelCatalogModel {
  id: string
  name?: string
  description?: string
  reasoning?: { efforts: ModelReasoningEffort[]; defaultEffort?: string }
}

export interface ModelProviderGroup {
  id: string
  name: string
  models: ModelCatalogModel[]
}

export interface SessionModels {
  current: { provider: string; model: string; reasoningEffort?: string }
  routable: boolean
  groups: ModelProviderGroup[]
  failures: { id: string; name: string; message: string }[]
}

export interface AgentPresetSummary {
  id: string
  name?: string
  description?: string
  order?: number
  broken?: string
  /** ND product policy marks this preset unselectable for new sessions. */
  blocked?: boolean
  blockedReason?: string
}

export interface SessionEventEnvelope {
  type: string
  seq: number
  time: number
  data?: unknown
  surfaceOp?: unknown
}

export interface DshEventFrame {
  kind:
    | 'session-event'
    | 'approval-requested'
    | 'approval-resolved'
    | 'question-requested'
    | 'question-resolved'
    | 'session-status'
    | 'session-added'
    | 'session-removed'
    | 'agent-error'
    | 'stream-error'
    | 'other'
  sessionId?: string
  event?: SessionEventEnvelope
  approvalId?: string
  toolName?: string
  callId?: string
  reason?: string
  outcome?: string
  running?: boolean
  questions?: unknown
  message?: string
  rpcId?: string
  meta?: unknown
}

export interface GatewayRpcResult {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}

export interface AppInfo {
  name: string
  version: string
  platform: string
  projectRoot: string
}

export type ThemeMode = 'system' | 'light' | 'dark'
export type EffectiveTheme = 'light' | 'dark'

export interface ThemeState {
  mode: ThemeMode
  effective: EffectiveTheme
}

export interface ProviderModel {
  id: string
  context: string
  /** Omitted means inherit the runtime catalog's supported inputs. */
  inputTypes?: Array<'text' | 'image'>
  /** Optional model output limit, in tokens. */
  maxOutputTokens?: number
}

/**
 * Renderer-safe provider metadata. ProviderStore.list() always returns
 * `apiKey: ''`; `hasApiKey` is the only signal that an existing credential is
 * present. The non-empty key is held only by the trusted main process and the
 * temporary child-process environment used for model execution.
 */
export interface ModelProvider {
  id: string
  name: string
  enabled: boolean
  baseUrl: string
  apiFormat: string
  apiKey: string
  hasApiKey?: boolean
  models: ProviderModel[]
  headers?: Record<string, string> | undefined
  maxRetries?: number | undefined
}

/** Result of a real HTTP probe against a provider's server. */
export interface ProviderPingResult {
  providerId: string
  /** ok = server answered; auth = answered but rejected the credential; unreachable = no answer. */
  state: 'ok' | 'auth' | 'unreachable'
  latencyMs?: number
  status?: number
  hasApiKey: boolean
  at: number
  /** First line of a provider-reported failure detail (completion probes only). */
  detail?: string
}

/**
 * Which app the titlebar inspect buttons aim at: 'external' targets another
 * application (screen capture, loopback CDP picker); 'self' targets this
 * ND-DSH window (window capture, in-renderer picker).
 */
export type InspectScope = 'external' | 'self'

export type AppInspectMode = 'full' | 'area' | 'annotate'

export interface AppInspectArea {
  x: number
  y: number
  width: number
  height: number
}

export interface AppInspectOptions {
  mode?: AppInspectMode
  rect?: AppInspectArea
  customPrompt?: string
}

/** Cross-app inspect: a screen capture bridged into the ND chat session. */
export interface AppInspectResult {
  sessionId: string
  messageId?: string
  copiedToClipboard: boolean
  width: number
  height: number
  displayLabel: string
  mode?: AppInspectMode
}

/** Element picked in an external Electron app via the injected CDP inspector. */
export interface ExternalElementPickView {
  tag: string
  id?: string
  classes?: string[]
  role?: string
  ariaLabel?: string
  text?: string
  attributes?: string[]
  html?: string
  box: { x: number; y: number; width: number; height: number }
  url?: string
  pageTitle?: string
  /** CSS path from the document root to the element (id/position based). */
  selector?: string
  /** Key computed styles captured at pick time. */
  styles?: Record<string, string>
  /** Best-effort dev-build source location, e.g. "src/App.tsx:42". */
  source?: string
}

/** One pick round from the crosshair button; the renderer offers Add-to-chat. */
export interface ExternalElementPickResult {
  outcome: 'picked' | 'canceled' | 'unreachable'
  message?: string
  element?: ExternalElementPickView
  targetTitle?: string
  shortName?: string
  hover?: string
  /** Id of this pick in the main-process store; enables context/screenshot copy. */
  pickId?: string
  /** Whether a cropped element screenshot was captured for this pick. */
  hasShot?: boolean
}

/** A staged element chip waiting in the composer for the next prompt. */
export interface ExternalElementAttachmentView {
  id: string
  shortName: string
  hover: string
}

/**
 * QA targets. `script:<name>` runs a check detected in the user's project
 * package.json; `unit`/`e2e` are ND-DSH's own developer suites (Settings).
 */
export type QaSuiteId = 'unit' | 'e2e' | `script:${string}`

/** `project` suites belong to the user's workspace; `internal` suites test ND-DSH itself. */
export type QaSuiteKind = 'project' | 'internal'

export type QaRunStatus = 'idle' | 'running' | 'passed' | 'failed' | 'unavailable'

export interface QaSuiteState {
  id: QaSuiteId
  kind: QaSuiteKind
  label: string
  /** Plain-language sentence describing what the check verifies. */
  description: string
  runner: string
  command: string
  status: QaRunStatus
  lastExitCode?: number
  lastDurationMs?: number
  lastFinishedAt?: number
  /** Shown when a check cannot run at all (e.g. Node.js missing on this computer). */
  notice?: string
}

export interface QaState {
  suites: QaSuiteState[]
  activeRun: QaSuiteId | null
}

/** One decoded stdout/stderr chunk streamed from a running suite. */
export interface QaOutputChunk {
  suite: QaSuiteId
  stream: 'stdout' | 'stderr'
  text: string
}

/** A finished capture handed to the chat composer as an unsent attachment. */
export interface ComposerImageAttachment {
  id: string
  dataUrl: string
}

export interface DesktopApi {
  app: {
    info(): Promise<AppInfo>
    restart(): Promise<void>
  }
  /** Pluggable capability providers (engine/memory/context) and subject routing. */
  capabilities: {
    providers(): Promise<import('./capabilities.js').CapabilityDescriptor[]>
    assignments(): Promise<import('./capabilities.js').CapabilityAssignmentSnapshot>
    assign(subjectType: import('./capabilities.js').CapabilitySubjectType, subjectId: string, kind: import('./capabilities.js').CapabilityKind, providerId: string): Promise<import('./capabilities.js').CapabilityAssignmentSnapshot>
    onChanged(listener: (assignments: import('./capabilities.js').CapabilityAssignmentSnapshot) => void): () => void
    statuses(): Promise<Record<string, import('./capabilities.js').CapabilityProviderStatus>>
    checkSetup(providerId: string): Promise<import('./capabilities.js').CapabilitySetupCheck>
    setup(providerId: string, values: Record<string, string>): Promise<Record<string, import('./capabilities.js').CapabilityProviderStatus>>
    verify(providerId: string): Promise<Record<string, import('./capabilities.js').CapabilityProviderStatus>>
    setEnabled(providerId: string, enabled: boolean): Promise<Record<string, import('./capabilities.js').CapabilityProviderStatus>>
    onStatusChanged(listener: (statuses: Record<string, import('./capabilities.js').CapabilityProviderStatus>) => void): () => void
  }
  providers: {
    list(): Promise<ModelProvider[]>
    save(providers: ModelProvider[]): Promise<ModelProvider[]>
    setApiKey(providerId: string, apiKey: string): Promise<ModelProvider[]>
    clearApiKey(providerId: string): Promise<ModelProvider[]>
    ping(providerId: string, force?: boolean): Promise<ProviderPingResult>
    testCompletion(providerId: string): Promise<ProviderPingResult>
    onChanged(listener: (providers: ModelProvider[]) => void): () => void
  }
  skills: {
    detail(selectionId: string): Promise<{ skill: import('./skill-catalog.js').SkillSuggestion; markdown: string }>
    catalog(projectId: string | null): Promise<{ scope: string; skills: import('./skill-catalog.js').SkillSuggestion[] }>
  }
  engines: {
    list(): Promise<CodingEngineDescriptor[]>
    assignments(): Promise<Record<string, string>>
    assign(agentId: string, engineId: string): Promise<Record<string, string>>
    sessions(): Promise<EngineSessionSummary[]>
    transcript(sessionId: string): Promise<EngineSessionTranscript>
    /** Native model catalog for engines that expose one; empty for the rest. */
    models(engineId: string): Promise<EngineModelOption[]>
  }
  /**
   * ND's GUI for the ZCode CLI's own model-provider config
   * (`~/.zcode/cli/config.json`). Reads never return API keys; writes are
   * validated against the shared ZCode schema and restart the ZCode runtime
   * so the next turn picks the new provider up.
   */
  zcodeConfig: {
    read(): Promise<import('./zcode-config.js').ZcodeCliConfigSnapshot>
    write(update: import('./zcode-config.js').ZcodeCliConfigUpdate): Promise<import('./zcode-config.js').ZcodeCliConfigSnapshot>
  }
  sessions: {
    /** Archive or unarchive any chat thread (harness or engine-backed); resolves with the refreshed archived id list. */
    setArchived(sessionId: string, archived: boolean): Promise<string[]>
    /** Archive or unarchive several chat threads atomically; resolves with the refreshed archived id list. */
    setArchivedMany(sessionIds: string[], archived: boolean): Promise<string[]>
  }
  capture: {
    inspectApp(copyToClipboard: boolean, scope?: InspectScope, options?: AppInspectOptions): Promise<AppInspectResult>
    /**
     * Capture without touching the session: the bytes come back to the trusted
     * renderer so a capture can sit in the composer as an unsent attachment.
     */
    forComposer(scope?: InspectScope, options?: AppInspectOptions): Promise<{
      data: string
      mediaType: 'image/png'
      width: number
      height: number
      displayLabel: string
      mode: AppInspectMode
      copiedToClipboard: boolean
    }>
    inspectElement(scope?: InspectScope): Promise<ExternalElementPickResult>
    stageElement(element: ExternalElementPickView, targetTitle: string, pickId?: string): Promise<ExternalElementAttachmentView[]>
    elementAttachments(): Promise<ExternalElementAttachmentView[]>
    removeElement(id: string): Promise<ExternalElementAttachmentView[]>
    /** Copy the full agent-ready context block for a stored pick to the clipboard. */
    copyElementContext(pickId: string): Promise<boolean>
    /** Copy the cropped element screenshot (if captured) to the clipboard. */
    copyElementShot(pickId: string): Promise<boolean>
  }
  browserCompanion: import('./browser-companion.js').BrowserCompanionDesktopApi
  browserPlatform: import('./browser-platform.js').BrowserPlatformDesktopApi
  /** ND extension packages: contexts, activation, grants, commands, typed views. */
  ndExtensions: import('./nd-invocations.js').NdExtensionsDesktopApi
  /** ND Home personal storage: notes, captures, and context-bound chats. */
  home: import('./nd-invocations.js').NdHomeDesktopApi
  browser: {
    state(): Promise<BrowserState>
    setBounds(bounds: BrowserBounds): Promise<void>
    setVisible(visible: boolean): Promise<void>
    navigate(url: string): Promise<BrowserState>
    back(): Promise<BrowserState>
    forward(): Promise<BrowserState>
    reload(): Promise<BrowserState>
    snapshot(): Promise<unknown>
    setInspectMode?(enabled: boolean): Promise<BrowserState>
    clearSelection?(): Promise<BrowserState>
    setAnnotationMode?(enabled: boolean): Promise<BrowserState>
    clearAnnotation?(): Promise<BrowserState>
    openExternal(url: string): Promise<void>
    onState(listener: (state: BrowserState) => void): () => void
  }
  workspace: {
    state(): Promise<WorkspaceState>
    pick(): Promise<WorkspaceState>
    /** Native folder picker for form fields; returns the chosen path or null on cancel without touching the active workspace. */
    pickPath(options?: { title?: string | undefined; defaultPath?: string | undefined }): Promise<string | null>
    setRoot(path: string): Promise<WorkspaceState>
    list(relativePath?: string): Promise<WorkspaceEntry[]>
    read(relativePath: string): Promise<WorkspaceFile>
    suggest(query: string): Promise<WorkspaceSuggestion[]>
    onState(listener: (state: WorkspaceState) => void): () => void
    registry(): Promise<WorkspaceRegistryView>
    addSaved(): Promise<WorkspaceRegistryView>
    removeSaved(id: string): Promise<WorkspaceRegistryView>
    openSaved(id: string): Promise<WorkspaceOpenResult>
  }
  harness: {
    status(): Promise<HarnessStatus>
    run(prompt: string, options?: HarnessRunOptions): Promise<HarnessRunResult>
    stop(): Promise<HarnessStatus>
    /** Cancel one response without stopping other sessions or project servers. */
    stopSession(sessionId: string): Promise<void>
    getPermissionMode(): Promise<string>
    setPermissionMode(mode: string): Promise<string>
    onStatus(listener: (status: HarnessStatus) => void): () => void
  }
  dsh: {
    rpc(method: string, payload?: unknown): Promise<GatewayRpcResult>
    respond(rpcId: string, value: unknown): Promise<void>
    onEvent(listener: (frame: DshEventFrame) => void): () => void
  }
  surface: {
    state(): Promise<SurfaceState>
    set(surface: DshSurface): Promise<SurfaceState>
    onChanged(listener: (state: SurfaceState) => void): () => void
  }
  /** Human-facing workspace profile; never an execution/pause state. */
  workspaceProfile: {
    get(): Promise<WorkspaceProfile>
    set(profile: WorkspaceProfile): Promise<WorkspaceProfile>
  }
  dshView: {
    setBounds(bounds: BrowserBounds): Promise<void>
    setVisible(visible: boolean): Promise<void>
    reload(): Promise<void>
    onState(listener: (state: DshViewState) => void): () => void
  }
  theme: {
    state(): Promise<ThemeState>
    set(mode: ThemeMode): Promise<ThemeState>
    onChanged(listener: (state: ThemeState) => void): () => void
  }
  git: {
    configureRemote(root: string, name: string, url: string): Promise<GitStatusSnapshot>
    connectGitHub(root: string, name: string, url: string): Promise<GitStatusSnapshot>
    state(): Promise<GitStatusSnapshot>
    refresh(): Promise<GitStatusSnapshot>
    stage(relativePaths: string[]): Promise<GitStatusSnapshot>
    unstage(relativePaths: string[]): Promise<GitStatusSnapshot>
    discard(relativePaths: string[]): Promise<GitStatusSnapshot>
    commit(message: string): Promise<GitStatusSnapshot>
    diff(relativePath: string, staged?: boolean): Promise<string>
    checkout(branch: string): Promise<GitStatusSnapshot>
    createBranch(name: string): Promise<GitStatusSnapshot>
    push(): Promise<GitStatusSnapshot>
    pull(): Promise<GitStatusSnapshot>
    fetch(): Promise<GitStatusSnapshot>
    onState(listener: (state: GitStatusSnapshot) => void): () => void
  }
  qa: {
    state(): Promise<QaState>
    run(suite: QaSuiteId): Promise<QaState>
    stop(): Promise<QaState>
    onState(listener: (state: QaState) => void): () => void
    onOutput(listener: (chunk: QaOutputChunk) => void): () => void
  }
  chatGptWeb: {
    getProjectBinding(workspaceRoot?: string): Promise<ChatGptProjectBinding | null>
    setProjectBinding(workspaceRoot: string, input: string): Promise<ChatGptProjectBinding>
    clearProjectBinding(workspaceRoot: string): Promise<void>
  }
  /** OS-style media transport over whatever the embedded browser is playing. */
  media?: {
    state(): Promise<NdMediaSessionState | null>
    onState(listener: (state: NdMediaSessionState | null) => void): () => void
    playPause(): Promise<{ ok: boolean }>
    next(): Promise<{ ok: boolean }>
    previous(): Promise<{ ok: boolean }>
  }
  window?: {
    setFloatMode(enabled: boolean): Promise<{ float: boolean }>
    resizeFloatWindow(width: number, height: number): Promise<void>
    moveFloatWindow(deltaX: number, deltaY: number): Promise<void>
    setCaptureOverlay?(active: boolean): Promise<{ width: number; height: number }>
    onFloatMode?(listener: (enabled: boolean) => void): () => void
    onQuickLauncher?(listener: () => void): () => void
    onLauncherHandoff?(listener: (target: LauncherHandoffTarget, text?: string, context?: import('./nd-context.js').NdContext) => void): () => void
    quickLauncherMode?(): Promise<QuickLauncherShortcutMode>
    setQuickLauncherMode?(mode: QuickLauncherShortcutMode): Promise<QuickLauncherShortcutMode>
    toggleLauncherPopup?(): Promise<{ visible: boolean }>
    hideLauncherPopup?(): Promise<void>
    handoffLauncherPopup?(target: LauncherHandoffTarget, text?: string, context?: import('./nd-context.js').NdContext): Promise<void>
    /** A global capture hotkey fired in main; the renderer runs the matching flow. */
    onCaptureRequest?(listener: (action: GlobalShortcutId) => void): () => void
    /** Full window asks main to deliver a capture request to the float overlay. */
    forwardCaptureRequest?(action: GlobalShortcutId): Promise<{ delivered: boolean }>
    /** Overlay frame collects a capture request queued while it was still loading. */
    pullPendingCapture?(): Promise<GlobalShortcutId | null>
    /** Overlay frame announces it can receive capture requests. */
    markCaptureReady?(): Promise<boolean>
    /** Overlay frame hands a finished capture back to the window hosting the composer. */
    forwardCaptureAttach?(shot: ComposerImageAttachment): Promise<boolean>
    onCaptureAttach?(listener: (shot: ComposerImageAttachment) => void): () => void
    captureDelay?(): Promise<CaptureDelaySeconds>
    setCaptureDelay?(seconds: CaptureDelaySeconds): Promise<CaptureDelaySeconds>
  }
  /** OS-wide hotkeys. Rebinding is validated in main against keys the operating system reserves. */
  shortcuts?: {
    state(): Promise<GlobalShortcutState>
    /** Pass null to restore the shipped default for that action. */
    rebind(id: GlobalShortcutId, accelerator: string | null): Promise<GlobalShortcutState>
  }
}

export const IPC = {
  appInfo: 'app:info',
  appRestart: 'app:restart',
  windowSetFloatMode: 'window:set-float-mode',
  windowResizeFloatWindow: 'window:resize-float-window',
  windowMoveFloatWindow: 'window:move-float-window',
  windowSetCaptureOverlay: 'window:set-capture-overlay',
  windowFloatModeEvent: 'window:float-mode-event',
  windowQuickLauncherEvent: 'window:quick-launcher-event',
  windowQuickLauncherMode: 'window:quick-launcher-mode',
  windowQuickLauncherModeSet: 'window:quick-launcher-mode:set',
  windowToggleLauncherPopup: 'window:toggle-launcher-popup',
  windowHideLauncherPopup: 'window:hide-launcher-popup',
  windowLauncherHandoff: 'window:launcher-handoff',
  windowLauncherHandoffEvent: 'window:launcher-handoff-event',
  browserState: 'browser:state',
  browserSetBounds: 'browser:set-bounds',
  browserSetVisible: 'browser:set-visible',
  browserNavigate: 'browser:navigate',
  browserBack: 'browser:back',
  browserForward: 'browser:forward',
  browserReload: 'browser:reload',
  browserSnapshot: 'browser:snapshot',
  browserSetInspectMode: 'browser:set-inspect-mode',
  browserClearSelection: 'browser:clear-selection',
  browserSetAnnotationMode: 'browser:set-annotation-mode',
  browserClearAnnotation: 'browser:clear-annotation',
  browserOpenExternal: 'browser:open-external',
  browserStateEvent: 'browser:state-event',
  mediaState: 'media:state',
  mediaStateEvent: 'media:state-event',
  mediaPlayPause: 'media:play-pause',
  mediaNext: 'media:next',
  mediaPrevious: 'media:previous',
  workspaceState: 'workspace:state',
  workspacePick: 'workspace:pick',
  workspacePickPath: 'workspace:pick-path',
  workspaceSetRoot: 'workspace:set-root',
  workspaceList: 'workspace:list',
  workspaceRead: 'workspace:read',
  workspaceSuggest: 'workspace:suggest',
  workspaceStateEvent: 'workspace:state-event',
  workspaceRegistry: 'workspace:registry',
  workspaceAddSaved: 'workspace:add-saved',
  workspaceRemoveSaved: 'workspace:remove-saved',
  workspaceOpenSaved: 'workspace:open-saved',
  harnessStatus: 'harness:status',
  harnessRun: 'harness:run',
  harnessStop: 'harness:stop',
  harnessStopSession: 'harness:stop-session',
  harnessPermissionGet: 'harness:permission:get',
  harnessPermissionSet: 'harness:permission:set',
  harnessStatusEvent: 'harness:status-event',
  dshRpc: 'dsh:rpc',
  dshRespond: 'dsh:respond',
  dshEvent: 'dsh:event',
  surfaceState: 'surface:state',
  surfaceSet: 'surface:set',
  surfaceChangedEvent: 'surface:changed',
  workspaceProfileGet: 'workspace-profile:get',
  workspaceProfileSet: 'workspace-profile:set',
  shortcutsState: 'shortcuts:state',
  shortcutsRebind: 'shortcuts:rebind',
  windowCaptureRequestEvent: 'window:capture-request',
  windowCaptureForward: 'window:capture-forward',
  windowCaptureReady: 'window:capture-ready',
  windowCapturePull: 'window:capture-pull',
  windowCaptureAttach: 'window:capture-attach',
  windowCaptureAttachEvent: 'window:capture-attach-event',
  windowCaptureDelay: 'window:capture-delay',
  windowCaptureDelaySet: 'window:capture-delay:set',
  dshViewSetBounds: 'dsh-view:set-bounds',
  dshViewSetVisible: 'dsh-view:set-visible',
  dshViewReload: 'dsh-view:reload',
  dshViewStateEvent: 'dsh-view:state-event',
  themeState: 'theme:state',
  themeSet: 'theme:set',
  themeChangedEvent: 'theme:changed',
  providersList: 'providers:list',
  providersSave: 'providers:save',
  providersChangedEvent: 'providers:changed',
  providersSetApiKey: 'providers:set-api-key',
  providersClearApiKey: 'providers:clear-api-key',
  providersPing: 'providers:ping',
  providersTestCompletion: 'providers:test-completion',
  skillsCatalog: 'skills:catalog',
  skillsDetail: 'skills:detail',
  enginesList: 'engines:list',
  enginesAssignments: 'engines:assignments',
  enginesAssign: 'engines:assign',
  enginesSessions: 'engines:sessions',
  enginesTranscript: 'engines:transcript',
  enginesModels: 'engines:models',
  zcodeConfigRead: 'zcode-config:read',
  zcodeConfigWrite: 'zcode-config:write',
  sessionsSetArchived: 'sessions:set-archived',
  sessionsSetArchivedMany: 'sessions:set-archived-many',
  captureInspectApp: 'capture:inspect-app',
  captureForComposer: 'capture:for-composer',
  captureInspectElement: 'capture:inspect-element',
  captureStageElement: 'capture:stage-element',
  captureElementAttachments: 'capture:element-attachments',
  captureRemoveElement: 'capture:remove-element',
  captureCopyElementContext: 'capture:copy-element-context',
  captureCopyElementShot: 'capture:copy-element-shot',
  gitState: 'git:state',
  gitConfigureRemote: 'git:configure-remote',
  gitConnectGitHub: 'git:connect-github',
  gitRefresh: 'git:refresh',
  gitStage: 'git:stage',
  gitUnstage: 'git:unstage',
  gitDiscard: 'git:discard',
  gitCommit: 'git:commit',
  gitDiff: 'git:diff',
  gitCheckout: 'git:checkout',
  gitCreateBranch: 'git:create-branch',
  gitPush: 'git:push',
  gitPull: 'git:pull',
  gitFetch: 'git:fetch',
  gitStateEvent: 'git:state-event',
  qaState: 'qa:state',
  qaRun: 'qa:run',
  qaStop: 'qa:stop',
  qaStateEvent: 'qa:state-event',
  qaOutputEvent: 'qa:output-event',
  chatGptWebProjectGet: 'chatgpt-web:project-get',
  chatGptWebProjectSet: 'chatgpt-web:project-set',
  chatGptWebProjectClear: 'chatgpt-web:project-clear',
} as const
