import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { toast } from 'sonner'
import type { AppInspectArea, AppInspectMode, AppInspectResult, BrowserState, ComposerImageAttachment, DshSurface, DshViewState, ExternalElementPickView, HarnessStatus, InspectScope, SurfaceState, ThemeMode, ThemeState, WorkspaceFile, WorkspaceState } from '../../shared/contracts'
import type { OrganizationSnapshot } from '../../shared/organization'
import { BrowserPane } from './components/BrowserPane'
import { ProjectGitControls } from './components/ProjectGitControls'
import { Button } from './components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from './components/ui/dialog'
import { Input } from './components/ui/input'
import { Badge } from './components/ui/badge'
import { Toaster } from './components/ui/sonner'
import { ChatPanel } from './components/ChatPanel'
import { SurfaceErrorBoundary } from './components/surface-error-boundary'
import { useNativeViewOcclusion } from './lib/use-native-view-occlusion'
import { DesignView } from './components/DesignView'
import { DiffView } from './components/DiffView'
import { DshCodingSurface } from './components/DshCodingSurface'
import { EditorPane } from './components/EditorPane'
import { Explorer } from './components/Explorer'
import { BrowserIcon, CameraIcon, CompanyIcon, CrosshairIcon, ExternalIcon, FileIcon, HomeIcon, MonitorIcon, PencilIcon, QualityIcon, SettingsIcon, SidebarToggleIcon, SparkIcon, TrashIcon } from './components/Icons'
import { OrganizationDashboard, type CompanyView } from './components/OrganizationDashboard'
import { QaView } from './components/QaView'
import { RuntimePrompts } from './components/RuntimePrompts'
import { ThemeToggle } from './components/ThemeToggle'
import { TitlebarIconButton } from './components/titlebar-icon-button'
import { CaptureOverlay, type CaptureOverlayMode } from './components/CaptureOverlay'
import { ModalInspectDock } from './components/modal-inspect-dock'
import { ScreenshotDropdown } from './components/ScreenshotDropdown'
import { QuickLauncher } from './components/QuickLauncher'
import { HomeView } from './components/HomeView'
import { PersonalSurface, type PersonalPane } from './components/personal-surface'
import { PersonalDialpad } from './components/personal-dialpad'
import { ExtensionPackagesCard } from './components/ExtensionPackages'
import { ExtensionKeepAliveHost, ExtensionKeepAliveTabs, useExtensionKeepAliveReopenHandler } from './components/extension-view-keepalive'
import { cn } from './lib/utils'
import { fileAccent } from './lib/file-accents'
import { isWorkspaceSelected } from './lib/workspace-selection'
import { useModalDialogOpen } from './lib/modal-dialog-presence'
import {
  buildLauncherMemoryMutation,
  buildLauncherTaskMutation,
  isQuickLauncherKey,
} from './lib/quick-launcher-model'
import {
  commandRunPlan,
  contextForOptionId,
  contextOptions,
  currentContext,
  describeContextForUi,
  optionIdForContext,
  browserFocusView,
} from './lib/nd-context-model'
import type { LauncherHandoffTarget } from '../../shared/quick-launcher'
import { DEFAULT_CAPTURE_DELAY_SECONDS, type GlobalShortcutId } from '../../shared/shortcuts'
import { asNdContext, type NdContext } from '../../shared/nd-context'
import type { WorkspaceProfile } from '../../shared/workspace-profile'
import type {
  NdCaptureResultView,
  NdCommandView,
  NdExtensionsStateView,
  NdHomeStateView,
  NdInvocationResult,
} from '../../shared/nd-invocations'
import { pickSelfElement } from './lib/self-element-picker'
import {
  capabilitySubTabFromLocation,
  enginesSubTabFromLocation,
  generalSubTabFromLocation,
  settingsHash,
  settingsTabFromLocation,
  type CapabilitySubTab,
  type EnginesSubTab,
  type GeneralSubTab,
  type SettingsTab,
} from './lib/settings-route'

const SettingsPane = lazy(() => import('./components/SettingsPane').then((module) => ({ default: module.SettingsPane })))

type ProductView = 'home' | 'company' | 'agent' | 'design' | 'qa' | 'settings'

type AgentPane = 'files' | 'browser'

const VIEWS: ProductView[] = ['home', 'company', 'agent', 'design', 'qa', 'settings']

const CHAT_MIN_PX = 580
const CHAT_DEFAULT_PX = 640
const CHAT_MIN_PX_SIDEBAR_COLLAPSED = 420
const WORKSPACE_MIN_PX = 480
const CHAT_SEPARATOR_PX = 5
/**
 * Width the workbench needs to render its three-pane surfaces (Design) at the
 * minimums they declare: 208 + 228 for the side panes plus the center's 40%.
 */
const WORKSPACE_PREFERRED_PX = 744

/**
 * The window opens narrower than the 1640 px default on small displays. The
 * chat column then starts smaller — with its sessions sidebar collapsed once it
 * would fall under its expanded minimum — so the workbench keeps enough width
 * for its own pane minimums. At desktop widths this is the shipped default.
 * Dragging the separator still overrides the width.
 */
function initialChatLayout(): { width: number; sessionsCollapsed: boolean } {
  const forWorkbench = window.innerWidth - CHAT_SEPARATOR_PX - WORKSPACE_PREFERRED_PX
  const width = Math.max(CHAT_MIN_PX_SIDEBAR_COLLAPSED, Math.min(CHAT_DEFAULT_PX, forWorkbench))
  return { width, sessionsCollapsed: width < CHAT_MIN_PX }
}

function viewFromHash(): ProductView {
  const route = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0]
  return VIEWS.includes(route as ProductView) ? (route as ProductView) : 'agent'
}

function hashForView(view: ProductView, settingsTab: SettingsTab, settingsSubTabs: SettingsSubTabs): string {
  if (view !== 'settings') return `#/${view}`
  const subTab = settingsTab === 'general'
    ? settingsSubTabs.general
    : settingsTab === 'capabilities'
      ? settingsSubTabs.capabilities
      : settingsTab === 'engines'
        ? settingsSubTabs.engines
        : undefined
  return settingsHash(settingsTab, subTab)
}

interface SettingsSubTabs {
  general: GeneralSubTab
  capabilities: CapabilitySubTab
  engines: EnginesSubTab
}

function settingsSubTabsFromLocation(): SettingsSubTabs {
  return {
    general: generalSubTabFromLocation(),
    capabilities: capabilitySubTabFromLocation(),
    engines: enginesSubTabFromLocation(),
  }
}

function isFloatOverlayRoute(): boolean {
  return window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] === 'float'
}

function harnessDotClasses(state: HarnessStatus['state'] | undefined): string {
  if (state === 'ready' || state === 'running') return 'bg-primary'
  if (state === 'starting') return 'bg-info animate-pulse-dot'
  if (state === 'error') return 'bg-destructive'
  return 'bg-faint'
}

const paneTabClasses = (active: boolean): string =>
  cn(
    'flex h-6 shrink-0 items-center gap-[5px] rounded-[5px] border border-transparent px-2.5 text-xs whitespace-nowrap transition-colors [&_svg]:size-3',
    active
      ? 'border-primary/20 bg-primary/[0.06] text-primary'
      : 'text-faint hover:bg-accent hover:text-muted-foreground',
  )

const navButtonClasses = (active: boolean): string =>
  cn(
    'relative flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] border px-2.5 text-xs font-medium whitespace-nowrap outline-none transition-[color,background-color,border-color,box-shadow]',
    'focus-visible:border-primary/45 focus-visible:ring-2 focus-visible:ring-primary/15 [&_svg]:size-[14px]',
    active
      ? 'border-primary/20 bg-primary/[0.10] text-strong shadow-[0_1px_0_rgba(255,255,255,0.03),0_3px_10px_rgba(0,0,0,0.16)] [&_svg]:text-primary'
      : 'border-transparent text-faint hover:border-border-soft hover:bg-accent/70 hover:text-foreground',
  )

export default function App() {
  const isFloatOverlay = isFloatOverlayRoute()
  const uiPreview = window.ndDshRuntimeMode === 'ui-preview'
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null)
  const [orgState, setOrgState] = useState<OrganizationSnapshot | null>(null)
  const [browserState, setBrowserState] = useState<BrowserState | null>(null)
  const [harnessStatus, setHarnessStatus] = useState<HarnessStatus | null>(null)
  const [surface, setSurface] = useState<DshSurface>('workbench')
  // Unknown until the trusted main-process preference is loaded. Do not assume
  // General here: doing so would redirect an existing Coding user's deep link
  // (for example #/qa) before their persisted profile arrives.
  const [workspaceProfile, setWorkspaceProfile] = useState<WorkspaceProfile | null>(null)
  const [workspaceProfilePending, setWorkspaceProfilePending] = useState(false)
  const [dshView, setDshView] = useState<DshViewState | null>(null)
  const [selectedFile, setSelectedFile] = useState<WorkspaceFile | null>(null)
  const [openFileTabs, setOpenFileTabs] = useState<WorkspaceFile[]>([])
  const [activeDiff, setActiveDiff] = useState<{ relativePath: string; staged: boolean } | null>(null)
  const [view, setView] = useState<ProductView>(viewFromHash)
  const [companyView, setCompanyView] = useState<CompanyView>('workspace')
  const [companyCreateOpen, setCompanyCreateOpen] = useState(false)
  const [companyDraft, setCompanyDraft] = useState({ name: '', mission: '' })
  const [failedCompanyIds, setFailedCompanyIds] = useState<Set<string>>(() => new Set())
  const [removeCompanyId, setRemoveCompanyId] = useState<string | null>(null)
  const [failedProjectIds, setFailedProjectIds] = useState<Set<string>>(() => new Set())
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(settingsTabFromLocation)
  const [settingsSubTabs, setSettingsSubTabs] = useState<SettingsSubTabs>(settingsSubTabsFromLocation)
  const [agentPane, setAgentPane] = useState<AgentPane>('files')
  const [initialChat] = useState(initialChatLayout)
  const [sessionsCollapsed, setSessionsCollapsed] = useState(initialChat.sessionsCollapsed)
  const [gitEditable, setGitEditable] = useState(false)
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(false)
  const [externalPrompt, setExternalPrompt] = useState<{ id: string; text: string } | null>(null)
  const [sessionOpenRequest, setSessionOpenRequest] = useState<{ id: string; sessionId: string } | null>(null)
  const [theme, setTheme] = useState<ThemeState | null>(null)
  const [appInspectCountdown, setAppInspectCountdown] = useState<number | null>(null)
  const [appInspectInFlight, setAppInspectInFlight] = useState(false)
  const [elementInspectActive, setElementInspectActive] = useState(false)
  // The dedicated overlay window loads the same bundle at #/float. Initialize
  // it directly in external mode so it never renders the full workbench into
  // the compact pill bounds before effects get a chance to run.
  const [inspectScope, setInspectScope] = useState<InspectScope>(() => isFloatOverlay ? 'external' : 'self')
  const [pendingPick, setPendingPick] = useState<{ element: ExternalElementPickView; targetTitle: string; shortName: string; hover: string; pickId?: string; hasShot?: boolean } | null>(null)
  const [pendingAppInspect, setPendingAppInspect] = useState<{ displayLabel: string; width: number; height: number; copiedToClipboard: boolean; scope: InspectScope; mode?: AppInspectMode } | null>(null)
  const [captureOverlay, setCaptureOverlay] = useState<{ active: boolean; mode: CaptureOverlayMode } | null>(null)
  const [floatDropdownOpen, setFloatDropdownOpen] = useState(false)
  const [quickLauncherOpen, setQuickLauncherOpen] = useState(false)
  // Keep-alive header: while a modal dialog is open, the titlebar stays live
  // above the overlay so company/project/navigation controls keep working.
  // The quick launcher is a spotlight surface that must keep its normal
  // click-outside dismissal, so it suspends the keep-alive header.
  const headerKeepAlive = useModalDialogOpen() && !quickLauncherOpen
  // Extension keep-alive tabs (browser-style): a tab click reopens that view's
  // dialog so the backgrounded view — game state included — is docked again.
  useExtensionKeepAliveReopenHandler((view) => {
    const request = { extensionId: view.data.extensionId, viewId: view.data.viewId, context: view.data.context }
    setExtensionViewRequest(request)
    setSettingsTab('extensions')
    switchToWorkbench('settings')
    // A hard-to-reproduce load race right after a browser-focus ping can
    // swallow the reopen (the dialog never mounts). When a ping was recent,
    // re-issue the request once after a short settle: the card keys each
    // request by identity, so a no-op re-issue is harmless. No recent ping
    // means no race, and a plain user click must never be replayed.
    if (Date.now() - lastBrowserFocusAt.current < 800) {
      const request = { extensionId: view.data.extensionId, viewId: view.data.viewId, context: view.data.context }
      window.setTimeout(() => {
        if (!document.querySelector('[data-slot="dialog-content"]')) {
          setExtensionViewRequest({ ...request })
        }
      }, 300)
    }
  })
  // Mini Browser actions emit a browser-focus ping: bring the site up right
  // away, and let the extensions card auto-hide its chrome dialog (the
  // keep-alive layer keeps it alive behind the surface). The event names the
  // context that opened the tab, and the site is presented there: Personal
  // browsing in the Personal space, everything else in the Agent workbench.
  const [browserFocusNudge, setBrowserFocusNudge] = useState(0)
  const lastBrowserFocusAt = useRef(0)
  const [personalPane, setPersonalPane] = useState<PersonalPane>('records')
  const [personalDialpadOpen, setPersonalDialpadOpen] = useState(true)
  useEffect(() => window.ndDsh.ndExtensions.onBrowserFocus((focus) => {
    lastBrowserFocusAt.current = Date.now()
    const context = asNdContext(focus.context)
    setBrowserFocusNudge((nudge) => nudge + 1)
    if (browserFocusView(context) === 'personal') {
      setPersonalPane('browser')
      switchToWorkbench('home')
      return
    }
    setAgentPane('browser')
    switchToWorkbench('agent')
  }), [])
  // The embedded browser is one shared native child view, so exactly one
  // surface may own it: the Agent workbench pane, or the Personal one. The
  // shell makes that decision in one place so two mounted panes can never
  // fight over visibility, and a dialog (occlusion) always wins.
  const nativeOverlayOpen = useNativeViewOcclusion()
  const browserSurface = view === 'agent' && agentPane === 'browser'
    ? 'agent'
    : view === 'home' && personalPane === 'browser'
      ? 'personal'
      : null
  useEffect(() => {
    // The float overlay owns no surface; letting it claim the shared native
    // browser view would both reject and fight the full window for it.
    if (isFloatOverlay) return
    void window.ndDsh.browser.setVisible(browserSurface !== null && !nativeOverlayOpen).catch(() => undefined)
  }, [browserSurface, nativeOverlayOpen, isFloatOverlay])
  // PRD 0006: ND Home personal records, extension packages, and the launcher's
  // explicit context selector (Personal by default, independent of the active
  // company/project selection).
  const [ndExtensions, setNdExtensions] = useState<NdExtensionsStateView | null>(null)
  const [extensionViewRequest, setExtensionViewRequest] = useState<{ extensionId: string; viewId: string; context: NdContext } | null>(null)
  const [homeState, setHomeState] = useState<NdHomeStateView | null>(null)
  const [homeBusy, setHomeBusy] = useState(false)
  const [launcherContextId, setLauncherContextId] = useState('personal')
  const [extensionCommands, setExtensionCommands] = useState<NdCommandView[]>([])
  const [localCaptureIntent, setLocalCaptureIntent] = useState(false)
  const inspectOverlayVisible = pendingPick !== null || pendingAppInspect !== null
  const [elementAttachmentVersion, setElementAttachmentVersion] = useState(0)
  const appInspectTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  // Keyed by message so a repeating failure refreshes one toast instead of stacking copies.
  const notify = useCallback((message: string) => toast(message, { id: message, duration: 5000 }), [])

  const pillDragRef = useRef<{ x: number; y: number } | null>(null)

  const toggleInspectScope = (): void => {
    const nextScope: InspectScope = inspectScope === 'external' ? 'self' : 'external'
    setInspectScope(nextScope)
    void window.ndDsh.window?.setFloatMode(nextScope === 'external')
  }

  useEffect(() => {
    if (inspectScope === 'external') {
      if (!isFloatOverlay) void window.ndDsh.window?.setFloatMode(true)
      document.documentElement.classList.add('float-mode')
      document.body.classList.add('float-mode')
      document.getElementById('root')?.classList.add('float-mode')
    } else {
      document.documentElement.classList.remove('float-mode')
      document.body.classList.remove('float-mode')
      document.getElementById('root')?.classList.remove('float-mode')
    }
  }, [inspectScope, isFloatOverlay])

  useEffect(() => {
    return window.ndDsh.window?.onFloatMode?.((enabled) => {
      if (!isFloatOverlay || enabled) setInspectScope(enabled ? 'external' : 'self')
    })
  }, [isFloatOverlay])

  useEffect(() => {
    if (isFloatOverlay) return
    // The global shortcut toggles: when the full window was just brought
    // forward the dialog is closed and opens; when it is already open the
    // same press dismisses it (Raycast-style toggle).
    return window.ndDsh.window?.onQuickLauncher?.(() => setQuickLauncherOpen((open) => !open))
  }, [isFloatOverlay])

  const launcherHandoffRef = useRef<(target: LauncherHandoffTarget, text?: string, context?: NdContext) => void>(() => {})

  useEffect(() => {
    if (isFloatOverlay) return
    return window.ndDsh.window?.onLauncherHandoff?.((target, text, context) => launcherHandoffRef.current(target, text, context))
  }, [isFloatOverlay])

  // The float overlay draws only the pill and the capture surface. It is a
  // separate sandboxed renderer, and main admits it to window/capture channels
  // only — so it must never request organization, home, or extension state.
  useEffect(() => {
    if (isFloatOverlay) return
    let mounted = true
    void window.ndDsh.ndExtensions.state()
      .then((next) => { if (mounted) setNdExtensions(next) })
      .catch(() => undefined)
    const off = window.ndDsh.ndExtensions.onChanged((next) => { if (mounted) setNdExtensions(next) })
    return () => { mounted = false; off() }
  }, [isFloatOverlay])

  useEffect(() => {
    if (isFloatOverlay) return
    let mounted = true
    void window.ndDsh.home.state()
      .then((next) => { if (mounted) setHomeState(next) })
      .catch(() => undefined)
    const off = window.ndDsh.home.onChanged((next) => { if (mounted) setHomeState(next) })
    return () => { mounted = false; off() }
  }, [isFloatOverlay])

  const extensionContextOptions = useMemo(() => contextOptions(orgState), [orgState])

  useEffect(() => {
    if (!quickLauncherOpen) return
    // The in-app launcher opens on the current company/project context; the OS
    // popup keeps its own Personal default (handled in the popup renderer).
    // Deliberately keyed on the open toggle only, so a context the user picked
    // while the launcher is open is not yanked away by background org updates.
    const id = optionIdForContext(extensionContextOptions, currentContext(orgState))
    if (id) setLauncherContextId(id)
  }, [quickLauncherOpen])

  useEffect(() => {
    if (isFloatOverlay) return
    const context = contextForOptionId(extensionContextOptions, launcherContextId) ?? { kind: 'personal' as const }
    let mounted = true
    void window.ndDsh.ndExtensions.commands(context)
      .then((next) => { if (mounted) setExtensionCommands(next) })
      .catch(() => { if (mounted) setExtensionCommands([]) })
    return () => { mounted = false }
  }, [extensionContextOptions, launcherContextId, ndExtensions, isFloatOverlay])

  const pendingApprovals = ndExtensions?.pendingApprovals.length ?? 0
  const notifiedApprovals = useRef(0)
  useEffect(() => {
    if (pendingApprovals > notifiedApprovals.current) {
      toast('An agent request is waiting for your approval — review it in Settings → Extensions.', { duration: 7000 })
    }
    notifiedApprovals.current = pendingApprovals
  }, [pendingApprovals])

  useEffect(() => {
    if (isFloatOverlay) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isQuickLauncherKey(event)) return
      event.preventDefault()
      setQuickLauncherOpen((open) => !open)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isFloatOverlay])

  useEffect(() => {
    if (!isFloatOverlay || captureOverlay || floatDropdownOpen) return
    const hasSummary = pendingAppInspect !== null
    const hasCountdown = appInspectCountdown !== null
    void window.ndDsh.window?.resizeFloatWindow(
      hasSummary ? 324 : hasCountdown ? 220 : 170,
      hasSummary ? 194 : hasCountdown ? 96 : 56,
    )
  }, [isFloatOverlay, pendingAppInspect, captureOverlay, floatDropdownOpen, appInspectCountdown])

  useEffect(() => {
    if (isFloatOverlay) return
    let mounted = true
    void window.ndDshOrganization.state()
      .then((next) => { if (mounted) setOrgState(next) })
      .catch((cause) => notify(errorMessage(cause)))
    const off = window.ndDshOrganization.onChanged((next) => {
      if (mounted) setOrgState(next)
    })
    return () => {
      mounted = false
      off()
    }
  }, [notify, isFloatOverlay])

  const handlePillPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // Buttons opt out of the draggable region. Capturing their pointer on the
    // parent retargets pointer-up and prevents their click handlers from firing.
    if (e.target instanceof Element && e.target.closest('.app-no-drag')) return
    pillDragRef.current = { x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const handlePillPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!pillDragRef.current) return
    const deltaX = e.clientX - pillDragRef.current.x
    const deltaY = e.clientY - pillDragRef.current.y
    if (deltaX !== 0 || deltaY !== 0) {
      void window.ndDsh.window?.moveFloatWindow(deltaX, deltaY)
    }
  }

  const handlePillPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    pillDragRef.current = null
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    } catch {
      // Ignore if pointer capture was already released
    }
  }

  const handleFloatDropdownOpen = (open: boolean): void => {
    setFloatDropdownOpen(open)
    if (open) {
      void window.ndDsh.window?.resizeFloatWindow(260, 230)
    } else {
      const hasSummary = pendingAppInspect !== null
      const hasCountdown = appInspectCountdown !== null
      void window.ndDsh.window?.resizeFloatWindow(
        hasSummary ? 324 : hasCountdown ? 220 : 170,
        hasSummary ? 194 : hasCountdown ? 96 : 56,
      )
    }
  }

  const openCaptureOverlay = async (mode: CaptureOverlayMode): Promise<void> => {
    setFloatDropdownOpen(false)
    if (isFloatOverlay || inspectScope === 'external') {
      await window.ndDsh.window?.setCaptureOverlay?.(true)
    }
    setCaptureOverlay({ active: true, mode })
  }

  const closeCaptureOverlay = async (): Promise<void> => {
    setCaptureOverlay(null)
    if (isFloatOverlay || inspectScope === 'external') {
      await window.ndDsh.window?.setCaptureOverlay?.(false)
    }
  }

  // Cross-app inspect: after a short countdown (so the user can focus the
  // target app), the trusted main process captures the screen, bridges the
  // screenshot into the ND chat session, and copies it to the clipboard.
  // Capture shortcuts attach their shot to the composer as an unsent
  // attachment: the user reviews it, writes a prompt, and sends deliberately.
  const [queuedCapture, setQueuedCapture] = useState<{ id: string; dataUrl: string } | null>(null)
  const [captureAttachIntent, setCaptureAttachIntent] = useState(false)

  const queueCaptureAttachment = (shot: ComposerImageAttachment): void => {
    setQueuedCapture(shot)
    switchToWorkbench('agent')
    // The capture happened while ND was out of the way; come back so the user
    // actually sees the attachment waiting in the composer.
    void window.ndDsh.window?.setFloatMode?.(false)
    toast('Capture attached to the chat composer and copied to the clipboard. Nothing sends until you do.', { duration: 5000 })
  }

  const attachCaptureToChat = async (mode: AppInspectMode, rect?: AppInspectArea): Promise<void> => {
    try {
      const shot = await window.ndDsh.capture.forComposer(inspectScope, { mode, ...(rect !== undefined ? { rect } : {}) })
      const attachment: ComposerImageAttachment = { id: `capture-${Date.now()}`, dataUrl: `data:${shot.mediaType};base64,${shot.data}` }
      // The overlay frame has no composer; main relays the attachment home.
      if (isFloatOverlay) {
        await window.ndDsh.window?.forwardCaptureAttach?.(attachment)
        return
      }
      queueCaptureAttachment(attachment)
    } catch (cause) {
      notify(errorMessage(cause))
    }
  }

  useEffect(() => window.ndDsh.window?.onCaptureAttach?.((shot) => {
    queueCaptureAttachment(shot)
  }))

  // In 'self' scope there is nothing to switch to, so capture immediately.
  const startAppInspect = (mode: AppInspectMode = 'full', rect?: AppInspectArea, scopeOverride?: InspectScope, delayOverride?: number, destination: 'agent' | 'attach' = 'agent'): Promise<AppInspectResult | undefined> => {
    if (appInspectCountdown !== null || appInspectInFlight) return Promise.resolve(undefined)
    const targetScope = scopeOverride ?? inspectScope
    const selfScope = targetScope === 'self'
    // External full captures count down by default so the user can focus the
    // target app first; a global hotkey may override that to capture at once.
    const delay = delayOverride ?? 3
    let remaining = delay
    if (!selfScope && mode === 'full' && delay > 0) setAppInspectCountdown(remaining)
    const fire = async (): Promise<AppInspectResult | undefined> => {
      setAppInspectInFlight(true)
      try {
        if (destination === 'attach') {
          await attachCaptureToChat(mode, rect)
          return undefined
        }
        const result = await window.ndDsh.capture.inspectApp(true, targetScope, { mode, ...(rect !== undefined ? { rect } : {}) })
        setPendingAppInspect({
          displayLabel: result.displayLabel,
          width: result.width,
          height: result.height,
          copiedToClipboard: result.copiedToClipboard,
          scope: targetScope,
          mode,
        })
        const prefix = mode === 'area'
          ? 'Area screenshot'
          : mode === 'annotate'
            ? 'Annotated screenshot'
            : `Screenshot of ${selfScope ? 'this app' : 'the screen'}`
        toast(result.copiedToClipboard
          ? `${prefix} sent to the agent and copied to the clipboard.`
          : `${prefix} sent to the agent.`, { duration: 5000 })
        return result
      } catch (cause) {
        notify(errorMessage(cause))
        throw cause
      } finally {
        setAppInspectInFlight(false)
      }
    }
    if (selfScope || mode !== 'full' || delay <= 0) {
      return fire()
    }
    return new Promise<AppInspectResult | undefined>((resolve) => {
      appInspectTimer.current = setInterval(() => {
        remaining -= 1
        if (remaining > 0) {
          setAppInspectCountdown(remaining)
          return
        }
        clearInterval(appInspectTimer.current)
        appInspectTimer.current = undefined
        setAppInspectCountdown(null)
        void fire().then(resolve, () => resolve(undefined))
      }, 1_000)
    })
  }

  useEffect(() => {
    if (!pendingAppInspect) return
    const timeout = window.setTimeout(() => setPendingAppInspect(null), 8_000)
    return () => window.clearTimeout(timeout)
  }, [pendingAppInspect])

  useEffect(() => () => {
    if (appInspectTimer.current !== undefined) clearInterval(appInspectTimer.current)
  }, [])

  // A pending countdown must be cancellable, like the Snipping Tool's delay.
  useEffect(() => {
    if (appInspectCountdown === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (appInspectTimer.current !== undefined) clearInterval(appInspectTimer.current)
      appInspectTimer.current = undefined
      setAppInspectCountdown(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [appInspectCountdown])

  useEffect(() => {
    if (!pendingPick) return
    const timeout = window.setTimeout(() => setPendingPick(null), 7_000)
    return () => window.clearTimeout(timeout)
  }, [pendingPick])

  // Keyboard accelerators for the two inspect entry points. Where the OS grab
  // consumes the key this never fires for a bound capture key; where it does
  // not (Wayland), the dedupe window keeps one press from firing twice.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.altKey || !event.ctrlKey) return
      const key = event.key.toLowerCase()
      if (key === 'e') {
        event.preventDefault()
        startElementInspect()
      } else if (key === 'c' || key === 'a') {
        if (Date.now() - lastGlobalCaptureAt.current < 750) return
        event.preventDefault()
        if (key === 'c') {
          void startAppInspect('full', undefined, undefined, undefined, 'attach')
        } else {
          setCaptureAttachIntent(true)
          void openCaptureOverlay('area')
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  // Global capture hotkeys arrive from main. The float overlay is the only
  // frame that can cover the whole screen, so the full window enters float
  // mode and hands the request on; the overlay frame then runs the capture.
  const lastGlobalCaptureAt = useRef(0)

  const runGlobalCapture = async (action: GlobalShortcutId): Promise<void> => {
    // One physical press must never run twice: the ready-handoff and the pull
    // can both deliver, and some platforms do not consume the global key.
    if (Date.now() - lastGlobalCaptureAt.current < 750) return
    lastGlobalCaptureAt.current = Date.now()
    if (isFloatOverlay) {
      if (action === 'areaCapture') {
        // A second press mid-snip must not reset an in-progress selection.
        if (captureOverlay) return
        setCaptureAttachIntent(true)
        await openCaptureOverlay('area')
        return
      }
      const delayApi = window.ndDsh.window?.captureDelay
      const configured = delayApi ? await delayApi().catch(() => undefined) : undefined
      const delay = action === 'delayedCapture' ? configured ?? DEFAULT_CAPTURE_DELAY_SECONDS : 0
      await startAppInspect('full', undefined, 'external', delay, 'attach')
      return
    }
    setInspectScope('external')
    await window.ndDsh.window?.setFloatMode?.(true)
    const forwarded = await window.ndDsh.window?.forwardCaptureRequest?.(action)
    if (forwarded && !forwarded.delivered) {
      notify('The capture overlay could not open. Try again in a moment.')
    }
  }

  useEffect(() => {
    const off = window.ndDsh.window?.onCaptureRequest?.((action) => {
      void runGlobalCapture(action)
    })
    return () => {
      off?.()
    }
  })

  // A request can land while this overlay frame is still booting — in dev the
  // renderer subscribes after did-finish-load — so main queues it, and this
  // frame announces readiness on mount to collect whatever is waiting.
  useEffect(() => {
    if (!isFloatOverlay) return
    let mounted = true
    const bridge = window.ndDsh.window
    void (async () => {
      await bridge?.markCaptureReady?.()
      const queued = await bridge?.pullPendingCapture?.()
      if (mounted && queued) void runGlobalCapture(queued)
    })()
    return () => {
      mounted = false
    }
  }, [isFloatOverlay])

  // Element-level inspect: in 'external' scope the picker is injected into
  // an external Electron app over its loopback debug port; in 'self' scope
  // it runs inside this app's own renderer. The picked element is offered
  // as an Add-to-chat chip (multiple chips can queue before one prompt).
  const startElementInspect = (): void => {
    if (elementInspectActive) return
    setElementInspectActive(true)
    const pick = inspectScope === 'self'
      ? pickSelfElement()
      : window.ndDsh.capture.inspectElement('external')
    void pick
      .then((result) => {
        if (result.outcome === 'picked' && result.element && result.targetTitle && result.shortName && result.hover) {
          setPendingPick({
            element: result.element,
            targetTitle: result.targetTitle,
            shortName: result.shortName,
            hover: result.hover,
            ...(result.pickId !== undefined ? { pickId: result.pickId } : {}),
            ...(result.hasShot !== undefined ? { hasShot: result.hasShot } : {}),
          })
        } else if (result.outcome === 'canceled') {
          notify('Element pick canceled.')
        } else {
          notify(result.message ?? 'No external app debug port found.')
        }
      })
      .catch((cause) => notify(errorMessage(cause)))
      .finally(() => setElementInspectActive(false))
  }

  const addElementToChat = async (): Promise<void> => {
    const pick = pendingPick
    if (!pick) return
    try {
      await window.ndDsh.capture.stageElement(pick.element, pick.targetTitle, pick.pickId)
      setPendingPick(null)
      setElementAttachmentVersion((version) => version + 1)
    } catch (cause) {
      notify(errorMessage(cause))
    }
  }

  // Full agent-ready context block (selector, styles, source, HTML) — the
  // exact text the agent receives with Add-to-chat. Falls back to the
  // compact hover summary if the main-process pick store has expired.
  const copyPickedElementContext = (): void => {
    const pick = pendingPick
    if (!pick) return
    const fallback = (): void => {
      navigator.clipboard
        .writeText(pick.hover)
        .then(() => toast('Element reference copied to the clipboard.', { duration: 5000 }))
        .catch((cause) => notify(errorMessage(cause)))
    }
    if (!pick.pickId) {
      fallback()
      return
    }
    void window.ndDsh.capture.copyElementContext(pick.pickId)
      .then((copied) => {
        if (copied) toast('Full element context copied to the clipboard.', { duration: 5000 })
        else fallback()
      })
      .catch((cause) => notify(errorMessage(cause)))
  }

  const copyPickedSelector = (): void => {
    const pick = pendingPick
    if (!pick) return
    navigator.clipboard
      .writeText(pick.element.selector ?? pick.shortName)
      .then(() => toast('CSS selector copied to the clipboard.', { duration: 5000 }))
      .catch((cause) => notify(errorMessage(cause)))
  }

  const copyPickedShot = (): void => {
    const pick = pendingPick
    if (!pick?.pickId || !pick.hasShot) return
    void window.ndDsh.capture.copyElementShot(pick.pickId)
      .then((copied) => {
        if (copied) toast('Element screenshot copied to the clipboard.', { duration: 5000 })
        else notify('No element screenshot is available for this pick.')
      })
      .catch((cause) => notify(errorMessage(cause)))
  }

  useEffect(() => {
    if (isFloatOverlay) return
    void Promise.all([
      window.ndDsh.workspace.state().then(setWorkspace),
      window.ndDsh.browser.state().then(setBrowserState),
      window.ndDsh.harness.status().then(setHarnessStatus),
      window.ndDsh.surface.state().then((state) => {
        setSurface(state.surface)
        setDshView(state.view)
      }),
      window.ndDsh.workspaceProfile.get().then(setWorkspaceProfile),
    ]).catch((cause) => notify(errorMessage(cause)))

    const offWorkspace = window.ndDsh.workspace.onState((next) => {
      setWorkspace(next)
      setSelectedFile(null)
      setOpenFileTabs([])
      setActiveDiff(null)
    })
    const offBrowser = window.ndDsh.browser.onState(setBrowserState)
    const offHarness = window.ndDsh.harness.onStatus(setHarnessStatus)
    const offDshView = window.ndDsh.dshView.onState(setDshView)
    const offSurface = window.ndDsh.surface.onChanged((state: SurfaceState) => {
      setSurface(state.surface)
      setDshView(state.view)
    })
    return () => {
      offWorkspace()
      offBrowser()
      offHarness()
      offDshView()
      offSurface()
      void window.ndDsh.browser.setVisible(false).catch(() => undefined)
      void window.ndDsh.dshView.setVisible(false).catch(() => undefined)
    }
  }, [isFloatOverlay, notify])

  useEffect(() => {
    if (isFloatOverlay) return
    let mounted = true
    void window.ndDsh.theme.state()
      .then((state) => { if (mounted) setTheme(state) })
      .catch((cause) => notify(errorMessage(cause)))
    const offTheme = window.ndDsh.theme.onChanged(setTheme)
    return () => {
      mounted = false
      offTheme()
    }
  }, [isFloatOverlay, notify])

  useEffect(() => {
    if (!theme) return
    document.documentElement.dataset.theme = theme.effective
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme.effective)
  }, [theme])

  useEffect(() => {
    if (isFloatOverlay) return
    const target = hashForView(view, settingsTab, settingsSubTabs)
    if (window.location.hash === target) return
    try {
      window.history.pushState(null, '', target)
    } catch {
      window.location.hash = target
    }
  }, [isFloatOverlay, settingsSubTabs, settingsTab, view])

  useEffect(() => {
    const onPopState = (): void => {
      setView(viewFromHash())
      setSettingsTab(settingsTabFromLocation())
      setSettingsSubTabs(settingsSubTabsFromLocation())
    }
    window.addEventListener('popstate', onPopState)
    window.addEventListener('hashchange', onPopState)
    return () => {
      window.removeEventListener('popstate', onPopState)
      window.removeEventListener('hashchange', onPopState)
    }
  }, [])

  const selectSurface = (next: DshSurface): void => {
    if (next === surface) return
    setSurface(next)
    void window.ndDsh.surface.set(next)
      .then((state) => {
        setSurface(state.surface)
        setDshView(state.view)
      })
      .catch((cause) => {
        void window.ndDsh.surface.state().then((current) => {
          setSurface(current.surface)
          setDshView(current.view)
        }).catch(() => undefined)
        notify(errorMessage(cause))
      })
  }

  const switchToWorkbench = (nextView?: ProductView): void => {
    if (nextView) setView(nextView)
    selectSurface('workbench')
  }

  const openSettings = (tab?: SettingsTab): void => {
    if (tab) setSettingsTab(tab)
    switchToWorkbench('settings')
  }

  const selectWorkspaceProfile = (next: WorkspaceProfile): void => {
    if (workspaceProfilePending || next === workspaceProfile) return
    // Commit in main before changing renderer-visible scope. This keeps the
    // Coding-only DSH button from becoming clickable before the persisted
    // profile guard has accepted Coding.
    setWorkspaceProfilePending(true)
    void window.ndDsh.workspaceProfile.set(next)
      .then(setWorkspaceProfile)
      .catch((cause) => notify(errorMessage(cause)))
      .finally(() => setWorkspaceProfilePending(false))
  }

  useEffect(() => {
    if (workspaceProfile === 'general' && view === 'qa') setView('home')
  }, [workspaceProfile, view])

  const selectTheme = (mode: ThemeMode): void => {
    void window.ndDsh.theme.set(mode).then(setTheme).catch((cause) => notify(errorMessage(cause)))
  }

  const changeWorkspace = (next: WorkspaceState): void => {
    setWorkspace(next)
    setSelectedFile(null)
    setOpenFileTabs([])
    setActiveDiff(null)
  }

  /** Opens the folder picker from the unselected sidebar/Explorer empty states. */
  const openWorkspaceFolder = (): void => {
    void window.ndDsh.workspace.pick()
      .then((next) => changeWorkspace(next))
      .catch((cause) => notify(errorMessage(cause)))
  }

  const openLink = async (url: string): Promise<void> => {
    try {
      switchToWorkbench('agent')
      setAgentPane('browser')
      await window.ndDsh.browser.navigate(url)
    } catch (cause) {
      notify(errorMessage(cause))
    }
  }

  const openFile = async (path: string): Promise<void> => {
    try {
      const file = await window.ndDsh.workspace.read(path)
      setSelectedFile(file)
      setOpenFileTabs((tabs) => {
        const existing = tabs.findIndex((tab) => tab.relativePath === file.relativePath)
        if (existing >= 0) {
          const next = [...tabs]
          next[existing] = file
          return next
        }
        return [...tabs, file]
      })
      setActiveDiff(null)
      setAgentPane('files')
      switchToWorkbench('agent')
    } catch (cause) {
      notify(errorMessage(cause))
    }
  }

  const closeFileTab = (relativePath: string): void => {
    setOpenFileTabs((tabs) => {
      const index = tabs.findIndex((tab) => tab.relativePath === relativePath)
      if (index < 0) return tabs
      const next = tabs.filter((_, i) => i !== index)
      setSelectedFile((current) =>
        current && current.relativePath === relativePath
          ? next[Math.min(index, next.length - 1)] ?? null
          : current
      )
      return next
    })
  }

  const openDiff = (relativePath: string, staged: boolean): void => {
    setActiveDiff({ relativePath, staged })
  }

  const askAgent = (prompt: string): void => {
    setExternalPrompt({ id: crypto.randomUUID(), text: prompt })
    switchToWorkbench('agent')
  }

  /** Opens an existing session in the Agent workbench from another surface. */
  const openSession = (sessionId: string): void => {
    setSessionOpenRequest({ id: crypto.randomUUID(), sessionId })
    switchToWorkbench('agent')
  }

  const company = orgState?.companies.find((item) => item.id === orgState.activeCompanyId) ?? orgState?.companies[0] ?? null
  const companyProjects = orgState && company ? orgState.projects.filter((item) => item.companyId === company.id) : []
  const companyRemovalTarget = useMemo(() => {
    if (!removeCompanyId || !orgState) return null
    const candidate = orgState.companies.find((item) => item.id === removeCompanyId)
    if (!candidate) return null
    return {
      company: candidate,
      projects: orgState.projects.filter((item) => item.companyId === candidate.id).length,
      tasks: orgState.tasks.filter((item) => item.companyId === candidate.id).length,
      goals: orgState.goals.filter((item) => item.companyId === candidate.id).length,
      milestones: orgState.milestones.filter((item) => item.companyId === candidate.id).length,
      runs: orgState.runs.filter((item) => item.companyId === candidate.id).length,
      activeRuns: orgState.runs.filter((item) => item.companyId === candidate.id && item.status === 'running').length,
      agents: orgState.agents.filter((item) => item.companyId === candidate.id).length,
    }
  }, [removeCompanyId, orgState])
  const project = companyProjects.find((item) => item.id === orgState?.activeProjectId) ?? companyProjects[0] ?? null
  // Every organization run records the session it ran in, so the chat sidebar
  // can scope its workspace-wide session list down to the active project.
  const runSessionProjects = useMemo(() => {
    const map: Record<string, string> = {}
    for (const run of orgState?.runs ?? []) map[run.sessionId] = run.projectId
    return map
  }, [orgState])

  // The boot fallback root is a runtime cwd, never a project: only a folder the
  // user opened — or the workspace of a selected organization project — may be
  // presented as one.
  const workspaceSelected = isWorkspaceSelected(workspace)

  // An unselected boot root is a runtime cwd, not a project: the title bar stays
  // neutral until the user opens a folder or selects an organization project.
  const headerWorkspaceLabel = !workspaceSelected
    ? 'No project'
    : orgState && company
      ? (project ? (workspace?.projectName ?? project.name ?? workspace?.name ?? 'No workspace') : 'No project')
      : (workspace?.projectName ?? workspace?.name ?? 'No workspace')

  const showGitControls = workspaceProfile === 'coding' && workspaceSelected && Boolean(
    workspace?.root && (!orgState || (project && (!workspace.projectId || workspace.projectId === project.id)))
  )

  const createCompany = (event: FormEvent): void => {
    event.preventDefault()
    void window.ndDshOrganization.mutate({ type: 'company.create', name: companyDraft.name, mission: companyDraft.mission })
      .then(() => { setCompanyDraft({ name: '', mission: '' }); setCompanyCreateOpen(false) })
      .catch((cause) => notify(errorMessage(cause)))
  }

  const switchCompany = (id: string): void => {
    void window.ndDshOrganization.mutate({ type: 'company.activate', id })
      .then(() => setFailedCompanyIds((prev) => (prev.has(id) ? new Set([...prev].filter((value) => value !== id)) : prev)))
      .catch(() => setFailedCompanyIds((prev) => new Set(prev).add(id)))
  }

  const switchProject = (id: string): void => {
    void window.ndDshOrganization.mutate({ type: 'project.activate', id })
      .then(() => setFailedProjectIds((prev) => (prev.has(id) ? new Set([...prev].filter((value) => value !== id)) : prev)))
      .catch(() => setFailedProjectIds((prev) => new Set(prev).add(id)))
  }

  const launcherCreateTask = async (text: string): Promise<void> => {
    if (activeLauncherContext().kind === 'personal') {
      notify('Tasks need a company and project. Switch the launcher context first.')
      return
    }
    if (!company || !project) {
      notify('Choose a company and project before creating a task.')
      return
    }
    try {
      await window.ndDshOrganization.mutate(buildLauncherTaskMutation(company.id, project.id, text))
      setCompanyView('workspace')
      switchToWorkbench('company')
      toast('Task created from ND Quick Launcher.')
    } catch (cause) {
      notify(errorMessage(cause))
    }
  }

  const launcherQuickNote = async (text: string, tags: string[] = ['launcher', 'manual']): Promise<void> => {
    const context = activeLauncherContext()
    if (context.kind === 'personal') {
      // Personal notes live in ND Home and work before any company exists.
      try {
        const result = await invokeDailyEssentials('quick-note', 'command', context, { text, tags })
        if (handleInvocationFailure(result)) return
        await refreshHome()
        toast('Note saved to Personal.')
      } catch (cause) {
        notify(errorMessage(cause))
      }
      return
    }
    if (!company) {
      notify('Choose a company before saving a note.')
      return
    }
    try {
      await window.ndDshOrganization.mutate(buildLauncherMemoryMutation(company.id, project?.id, text, tags))
      toast(project ? `Note saved to ${project.name}.` : `Note saved to ${company.name}.`)
    } catch (cause) {
      notify(errorMessage(cause))
    }
  }

  const launcherActivateProject = async (projectId: string): Promise<void> => {
    const target = orgState?.projects.find((item) => item.id === projectId)
    if (!target) return
    try {
      if (target.companyId !== orgState?.activeCompanyId) {
        await window.ndDshOrganization.mutate({ type: 'company.activate', id: target.companyId })
      }
      await window.ndDshOrganization.mutate({ type: 'project.activate', id: projectId })
      setCompanyView('workspace')
      switchToWorkbench('company')
    } catch (cause) {
      notify(errorMessage(cause))
    }
  }

  const launcherSwitchCompany = async (companyId: string): Promise<void> => {
    try {
      await window.ndDshOrganization.mutate({ type: 'company.activate', id: companyId })
      setCompanyView('workspace')
      switchToWorkbench('company')
    } catch (cause) {
      notify(errorMessage(cause))
    }
  }

  const captureClipboardToNote = async (contextOverride?: NdContext): Promise<void> => {
    const context = contextOverride ?? activeLauncherContext()
    if (context.kind === 'personal') {
      // One explicit command authorizes exactly this one clipboard read.
      try {
        const result = await invokeDailyEssentials('capture-clipboard', 'command', context, {})
        if (handleInvocationFailure(result)) return
        await refreshHome()
        toast('Clipboard captured into Personal.')
      } catch (cause) {
        notify(errorMessage(cause))
      }
      return
    }
    try {
      const text = (await navigator.clipboard.readText()).trim()
      if (!text) {
        notify('Clipboard does not contain text to capture.')
        return
      }
      await launcherQuickNote(text, ['capture', 'clipboard'])
    } catch (cause) {
      notify(errorMessage(cause))
    }
  }

  const refreshHome = async (): Promise<void> => {
    setHomeState(await window.ndDsh.home.state())
  }

  /**
   * Personal browser dialpad: a tile opens a real ND browser tab and the pane
   * gives the site the space, so the speed dial behaves like a new-tab page.
   * Links are personal records in ND-managed storage — never company or project
   * memory.
   */
  const openPersonalTab = (url: string): void => {
    setPersonalPane('browser')
    setPersonalDialpadOpen(false)
    void window.ndDsh.browserPlatform.createTab('builtin', url)
      .then(async (tab) => {
        await window.ndDsh.browserPlatform.activateTab('builtin', tab.id)
        await window.ndDsh.browserPlatform.select({ mode: 'tab', targetId: 'builtin', tabId: tab.id })
      })
      .catch((cause) => notify(errorMessage(cause)))
  }

  const savePersonalDialpadLink = (): void => {
    const url = browserState?.url
    if (!url) return
    void window.ndDsh.home.saveLink({ url })
      .then(setHomeState)
      .catch((cause) => notify(errorMessage(cause)))
  }

  const removePersonalDialpadLink = (id: string): void => {
    void window.ndDsh.home.removeLink(id)
      .then(setHomeState)
      .catch((cause) => notify(errorMessage(cause)))
  }

  const activeLauncherContext = (): NdContext =>
    contextForOptionId(extensionContextOptions, launcherContextId) ?? { kind: 'personal' }

  const DAILY_ESSENTIALS_ID = 'nd.daily-essentials'

  const invokeDailyEssentials = (
    contributionId: string,
    contributionKind: 'command' | 'view',
    context: NdContext,
    input: Record<string, unknown>,
  ): Promise<NdInvocationResult> =>
    window.ndDsh.ndExtensions.invoke({ extensionId: DAILY_ESSENTIALS_ID, contributionId, contributionKind, context, caller: 'user', input })

  /** Personal chats get a managed per-chat folder; other contexts keep the normal agent flow. */
  const startContextChat = async (prompt: string, context: NdContext): Promise<void> => {
    if (context.kind !== 'personal') {
      askAgent(prompt)
      return
    }
    setHomeBusy(true)
    try {
      const chat = await window.ndDsh.home.ensureChat(context)
      const result = await window.ndDsh.harness.run(prompt, { workspaceCwd: chat.workDir })
      await window.ndDsh.home.bindChat(chat.chatId, result.sessionId)
      await refreshHome()
      switchToWorkbench('agent')
    } catch (cause) {
      notify(errorMessage(cause))
    } finally {
      setHomeBusy(false)
    }
  }

  const applyHostEffect = async (host: NdCommandView['host'], value: unknown): Promise<void> => {
    const result = (value ?? {}) as Record<string, unknown>
    switch (host) {
      case 'browser.openUrl':
      case 'browser.search':
        switchToWorkbench('agent')
        setAgentPane('browser')
        return
      case 'chat.ask':
        if (typeof result.text === 'string') await startContextChat(result.text, activeLauncherContext())
        return
      case 'capture.screen':
      case 'capture.area':
        await refreshHome()
        setView('home')
        notify('Capture saved to Personal.')
        return
      case 'note.create':
      case 'clipboard.read':
        await refreshHome()
        notify(`Saved “${String(result.title ?? 'note')}”.`)
        return
      case 'os.openTarget':
        if (result.opened) notify(`Opened ${String(result.path)}`)
        return
      case 'os.wallpaper.chooseAndSet':
      case 'os.wallpaper.next':
      case 'os.wallpaper.previous':
      case 'os.wallpaper.random':
      case 'os.wallpaper.applySelected':
        if (result.changed) notify(typeof result.name === 'string' ? `Wallpaper changed to ${result.name}.` : 'Desktop wallpaper updated.')
        return
      case 'os.wallpaper.folders.add':
        if (result.changed) notify(typeof result.folder === 'string' ? `Wallpaper folder set to ${String(result.folder)}.` : 'Wallpaper folder updated.')
        return
      case 'browser.openExternal':
        notify('Opened in your system browser.')
        return
      case 'capture.copy':
        notify('Capture copied to the clipboard.')
        return
      case 'capture.export':
        if (result.exported) notify(`Exported to ${String(result.path)}`)
        return
      default:
        return
    }
  }

  const handleInvocationFailure = (result: NdInvocationResult): boolean => {
    if (result.ok) return false
    if (result.error?.code === 'approval-required') {
      notify('This needs your approval — check Settings → Extensions.')
      return true
    }
    notify(result.error?.message ?? 'The action could not run.')
    return true
  }

  const runExtensionCommand = async (command: NdCommandView, text = ''): Promise<void> => {
    const context = activeLauncherContext()
    const plan = commandRunPlan(command, text)
    if (plan.missing) {
      notify(plan.missing)
      return
    }
    if (command.openViewId) {
      setExtensionViewRequest({ extensionId: command.extensionId, viewId: command.openViewId, context })
      setSettingsTab('extensions')
      setView('settings')
      return
    }
    if (command.host === 'capture.area') {
      await openLocalAreaCapture()
      return
    }
    try {
      const result = await window.ndDsh.ndExtensions.invoke({
        extensionId: command.extensionId,
        contributionId: command.contributionId,
        contributionKind: 'command',
        context,
        caller: 'user',
        input: plan.input,
      })
      if (handleInvocationFailure(result)) return
      await applyHostEffect(command.host, result.value)
    } catch (cause) {
      notify(errorMessage(cause))
    }
  }

  const homeCaptureScreen = async (): Promise<void> => {
    setHomeBusy(true)
    try {
      const result = await invokeDailyEssentials('capture-screen', 'command', { kind: 'personal' }, {})
      if (handleInvocationFailure(result)) return
      await refreshHome()
      setView('home')
      notify('Capture saved to Personal.')
    } catch (cause) {
      notify(errorMessage(cause))
    } finally {
      setHomeBusy(false)
    }
  }

  const openLocalAreaCapture = async (): Promise<void> => {
    setLocalCaptureIntent(true)
    await openCaptureOverlay('area')
  }

  const homeCaptureArea = async (rect?: AppInspectArea): Promise<void> => {
    setHomeBusy(true)
    try {
      const result = rect
        ? await invokeDailyEssentials('capture-area', 'command', { kind: 'personal' }, { rect })
        : { ok: false as const, error: { code: 'cancelled' as const, message: 'Area capture was cancelled.' } }
      if (handleInvocationFailure(result)) return
      await refreshHome()
      setView('home')
      notify('Area capture saved to Personal.')
    } catch (cause) {
      notify(errorMessage(cause))
    } finally {
      setHomeBusy(false)
    }
  }

  const runHomeCaptureAction = async (actionId: string, captureId: string): Promise<void> => {
    try {
      const result = await invokeDailyEssentials('captures', 'view', { kind: 'personal' }, { action: actionId, captureId })
      if (handleInvocationFailure(result)) return
      await applyHostEffect(actionId === 'capture-export' ? 'capture.export' : 'capture.copy', result.value)
    } catch (cause) {
      notify(errorMessage(cause))
    }
  }

  const askWithCapture = async (capture: NdCaptureResultView, prompt: string): Promise<void> => {
    setHomeBusy(true)
    try {
      await window.ndDsh.harness.run(prompt, {
        image: { data: capture.data, mediaType: 'image/png', name: `${capture.captureId}.png` },
      })
      switchToWorkbench('agent')
    } catch (cause) {
      notify(errorMessage(cause))
    } finally {
      setHomeBusy(false)
    }
  }

  // Handoffs arrive from the launcher popup surface (a separate sandboxed
  // renderer) after main brings this window forward. The ref keeps the
  // subscription stable while the handler always sees the latest closures.
  useEffect(() => {
    launcherHandoffRef.current = (target, text, incomingContext) => {
      const context = incomingContext ?? activeLauncherContext()
      switch (target) {
        case 'launcher':
          setQuickLauncherOpen(true)
          return
        case 'home':
          setView('home')
          return
        case 'kanban':
          setCompanyView('workspace')
          switchToWorkbench('company')
          return
        case 'browser':
          switchToWorkbench('agent')
          setAgentPane('browser')
          if (text) void window.ndDsh.browser.navigate(text).catch((cause) => notify(errorMessage(cause)))
          return
        case 'agent':
          if (text && context.kind === 'personal') void startContextChat(text, context)
          else {
            switchToWorkbench('agent')
            if (text) askAgent(text)
          }
          return
        case 'capture-screen':
          if (context.kind === 'personal') void homeCaptureScreen()
          else void startAppInspect('full', undefined, 'external')
          return
        case 'capture-tools':
          if (context.kind === 'personal') {
            void openLocalAreaCapture()
            return
          }
          setInspectScope('external')
          void window.ndDsh.window?.setFloatMode(true)
          return
        case 'capture-clipboard':
          void captureClipboardToNote(context)
          return
        case 'extension-view': {
          const match = /^([a-z0-9][a-z0-9._-]{1,127}):([a-z0-9][a-z0-9._-]{0,127})$/.exec(text ?? '')
          if (!match) return
          setExtensionViewRequest({ extensionId: match[1]!, viewId: match[2]!, context })
          setSettingsTab('extensions')
          setView('settings')
          return
        }
      }
    }
  })

  const allNavItems: Array<{ id: ProductView; label: string; icon: ReactNode }> = [
    { id: 'home', label: 'Personal', icon: <HomeIcon /> },
    { id: 'company', label: 'Company', icon: <CompanyIcon /> },
    { id: 'agent', label: 'Agent', icon: <SparkIcon /> },
    { id: 'design', label: 'Design', icon: <PencilIcon /> },
    { id: 'qa', label: 'QA', icon: <QualityIcon /> },
    { id: 'settings', label: 'Settings', icon: <SettingsIcon /> },
  ]
  const navItems = workspaceProfile === 'coding'
    ? allNavItems
    : allNavItems.filter((item) => item.id !== 'qa')

  if (inspectScope === 'external') {
    return (
      <div className="float-mode flex h-screen w-screen flex-col items-center justify-start gap-2 bg-transparent p-1.5 select-none font-sans overflow-hidden">
        {!captureOverlay ? (
          <div
            className="app-drag flex items-center gap-1.5 rounded-full border-2 border-primary bg-surface-1/95 p-1.5 text-primary shadow-[0_10px_30px_rgba(0,0,0,0.6)] backdrop-blur cursor-grab active:cursor-grabbing"
            onPointerDown={handlePillPointerDown}
            onPointerMove={handlePillPointerMove}
            onPointerUp={handlePillPointerUp}
          >
            <ScreenshotDropdown
              scope={inspectScope}
              open={floatDropdownOpen}
              onOpenChange={handleFloatDropdownOpen}
              disabled={appInspectCountdown !== null || appInspectInFlight}
              onSelectMode={(selectedMode) => {
                setFloatDropdownOpen(false)
                if (selectedMode === 'full') void startAppInspect('full')
                else void openCaptureOverlay(selectedMode)
              }}
              side="bottom"
              align="start"
            >
              <button
                type="button"
                aria-label="Inspect screen"
                className="app-no-drag grid size-8 place-items-center rounded-full bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
                title="Inspect screen options (Full, Area, Direct Annotation)"
              >
                <CameraIcon className="size-4 text-primary" />
              </button>
            </ScreenshotDropdown>
            <button
              type="button"
              aria-label="Inspect element in external app"
              className="app-no-drag grid size-7 place-items-center rounded-full text-faint hover:bg-accent hover:text-foreground transition-colors"
              onClick={startElementInspect}
              title="Inspect element in external app (Ctrl+Alt+E)"
            >
              <CrosshairIcon className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="Restore full ND-DSH app window"
              className="app-no-drag grid size-7 place-items-center rounded-full text-faint hover:bg-accent hover:text-foreground transition-colors"
              onClick={() => {
                void window.ndDsh.window?.setFloatMode(false)
              }}
              title="Restore full ND-DSH app window"
            >
              <MonitorIcon className="size-3.5" />
            </button>
          </div>
        ) : null}
        {appInspectCountdown !== null && !captureOverlay ? (
          <div role="status" className="app-no-drag flex items-center gap-2 rounded-full border border-primary/40 bg-surface-1/95 px-3 py-1.5 text-xs font-medium text-primary shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur">
            <span className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
            <span>Capturing screen in {appInspectCountdown}s...</span>
          </div>
        ) : null}
        {pendingAppInspect && !captureOverlay ? (
          <div role="dialog" aria-label="Inspected app info" className="app-no-drag flex w-[300px] flex-col gap-2 rounded-[10px] border border-border-strong bg-surface-1 p-3 shadow-[0_14px_40px_rgba(0,0,0,0.5)]">
            <div className="flex min-w-0 items-center gap-[7px]">
              <CameraIcon className="size-[13px] shrink-0 text-primary" />
              <strong className="overflow-hidden font-mono text-[11px] text-ellipsis whitespace-nowrap">
                External App Inspect
              </strong>
              {pendingAppInspect.mode && pendingAppInspect.mode !== 'full' ? (
                <Badge variant="outline" className="text-[9px] font-normal text-primary border-primary/30">
                  {pendingAppInspect.mode === 'area' ? 'Area' : 'Annotated'}
                </Badge>
              ) : null}
              <Badge variant="outline" className="ml-auto text-[9px] font-normal">
                {pendingAppInspect.scope}
              </Badge>
            </div>
            <div className="flex flex-col gap-1 pl-[20px] text-[10px] text-muted-foreground font-mono">
              <div><span className="text-faint">Target:</span> {pendingAppInspect.displayLabel}</div>
              <div><span className="text-faint">Resolution:</span> {pendingAppInspect.width} × {pendingAppInspect.height}</div>
              <div className="text-primary font-medium">✓ Sent to ND Chat Agent</div>
              {pendingAppInspect.copiedToClipboard ? <div className="text-faint">✓ Copied image to clipboard</div> : null}
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto rounded-md px-2.5 py-1 text-[11px]"
                onClick={() => setPendingAppInspect(null)}
              >
                Dismiss
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto rounded-md px-2.5 py-1 text-[11px]"
                title="Copy summary information for this application inspection"
                onClick={() => {
                  navigator.clipboard.writeText(`App Inspect Info:\nScope: ${pendingAppInspect.scope}\nMode: ${pendingAppInspect.mode ?? 'full'}\nTarget: ${pendingAppInspect.displayLabel}\nResolution: ${pendingAppInspect.width}x${pendingAppInspect.height}`)
                    .then(() => toast('App inspect info copied to clipboard.'))
                    .catch((cause) => notify(errorMessage(cause)))
                }}
              >
                Copy info
              </Button>
            </div>
          </div>
        ) : null}
        {captureOverlay ? (
          <CaptureOverlay
            active={captureOverlay.active}
            initialMode={captureOverlay.mode}
            scope={inspectScope}
            onCapture={async ({ mode, rect }) => {
              if (localCaptureIntent) {
                setLocalCaptureIntent(false)
                await homeCaptureArea(rect)
                return
              }
              if (captureAttachIntent) {
                setCaptureAttachIntent(false)
                await startAppInspect(mode === 'area' ? 'area' : 'annotate', rect, undefined, 0, 'attach')
                return
              }
              await startAppInspect(mode === 'area' ? 'area' : 'annotate', rect)
            }}
            onClose={() => {
              setLocalCaptureIntent(false)
              void closeCaptureOverlay()
            }}
          />
        ) : null}
        <Toaster position="bottom-right" duration={5000} />
      </div>
    )
  }

  return (
    // Text stays selectable everywhere (chat transcripts, editor code):
    // the shell deliberately does not set `select-none`.
    <div className={cn('grid h-full w-full bg-[radial-gradient(circle_at_35%_-20%,var(--bg-glow),transparent_35%)]', uiPreview ? 'grid-rows-[25px_auto_minmax(0,1fr)]' : 'grid-rows-[auto_minmax(0,1fr)]')}>
      {uiPreview ? (
        <aside className="flex items-center justify-center border-b border-warning/25 bg-warning/10 px-3 text-[10px] font-bold tracking-[0.08em] text-warning">
          UI PREVIEW · DEVELOPMENT FIXTURES · ACTIONS ARE SIMULATED · LAUNCH ELECTRON FOR REAL RUNTIME FEATURES
        </aside>
      ) : null}
      <header
        data-nd-keepalive={headerKeepAlive ? '' : undefined}
        className={cn(
          // Left column sizes to content so the keep-alive tabs are not clipped; the right column absorbs the slack
          // and the nav keeps a content floor so it never shrinks under its buttons.
          'app-drag grid grid-cols-[minmax(180px,auto)_minmax(min-content,auto)_minmax(180px,1fr)] items-center gap-[18px] border-b border-border-soft bg-titlebar pr-[148px] pl-3',
          headerKeepAlive && 'pointer-events-auto relative z-[60]',
        )}
      >
        <div className="flex min-w-0 flex-col gap-[7px]">
          <div className="flex min-w-0 items-center gap-2">
            <TitlebarIconButton
              title={sessionsCollapsed ? 'Expand sessions sidebar' : 'Collapse sessions sidebar'}
              onClick={() => setSessionsCollapsed((collapsed) => !collapsed)}
            >
              <SidebarToggleIcon collapsed={sessionsCollapsed} />
            </TitlebarIconButton>
            <span className="grid size-6 shrink-0 place-items-center rounded-[7px] border border-primary/30 bg-primary/10 text-sm font-extrabold tracking-[0.08em] text-primary">ND</span>
            <div
              role="group"
              aria-label="Workspace profile"
              className="app-no-drag flex h-7 shrink-0 items-center rounded-lg border border-border-soft bg-inset p-[2px] shadow-[inset_0_1px_2px_rgba(0,0,0,0.18)]"
            >
              {(['general', 'coding'] as const).map((profile) => (
                <button
                  key={profile}
                  type="button"
                  aria-pressed={workspaceProfile === profile}
                  disabled={workspaceProfile === null || workspaceProfilePending}
                  className={cn(
                    'grid h-[22px] min-w-[52px] place-items-center rounded-md border px-2 text-[9px] font-extrabold tracking-[0.06em] transition-[color,background-color,border-color,box-shadow] disabled:cursor-not-allowed disabled:opacity-50',
                    workspaceProfile === profile
                      ? 'border-primary/25 bg-primary/12 text-primary shadow-[0_1px_3px_rgba(0,0,0,0.2)]'
                      : 'border-transparent text-faint hover:bg-accent hover:text-foreground',
                  )}
                  title={profile === 'general' ? 'General workspace for everyday AI work and extensions' : 'Coding workspace with developer tools and coding surfaces'}
                  onClick={() => selectWorkspaceProfile(profile)}
                >
                  {profile === 'general' ? 'GENERAL' : 'CODING'}
                </button>
              ))}
            </div>
            {workspaceProfile === 'coding' ? (
              <div
                role="group"
                aria-label="Coding surface"
                className="app-no-drag flex h-7 shrink-0 items-center rounded-lg border border-border-soft bg-inset p-[2px] shadow-[inset_0_1px_2px_rgba(0,0,0,0.18)]"
              >
                <button
                  type="button"
                  aria-pressed={surface === 'workbench'}
                  className={cn(
                    'grid h-[22px] min-w-[32px] place-items-center rounded-md border px-1.5 text-[9px] font-extrabold tracking-[0.08em] transition-[color,background-color,border-color,box-shadow]',
                    surface === 'workbench'
                      ? 'border-primary/25 bg-primary/12 text-primary shadow-[0_1px_3px_rgba(0,0,0,0.2)]'
                      : 'border-transparent text-faint hover:bg-accent hover:text-foreground',
                  )}
                  title="Use the ND coding workbench"
                  onClick={() => selectSurface('workbench')}
                >
                  ND
                </button>
                <button
                  type="button"
                  aria-pressed={surface === 'dsh'}
                  className={cn(
                    'grid h-[22px] min-w-[36px] place-items-center rounded-md border px-1.5 text-[9px] font-extrabold tracking-[0.08em] transition-[color,background-color,border-color,box-shadow]',
                    surface === 'dsh'
                      ? 'border-primary/25 bg-primary/12 text-primary shadow-[0_1px_3px_rgba(0,0,0,0.2)]'
                      : 'border-transparent text-faint hover:bg-accent hover:text-foreground',
                  )}
                  title="Use the DSH coding surface"
                  onClick={() => selectSurface('dsh')}
                >
                  DSH
                </button>
              </div>
            ) : null}
            <div className="flex min-w-0 flex-col">
              <strong className="text-[15px] tracking-[0.06em] text-strong">ND-DSH</strong>
              <span className="overflow-hidden text-xs text-faint text-ellipsis whitespace-nowrap">
                {headerWorkspaceLabel}
              </span>
            </div>
          </div>
          {orgState ? (
        <div className="app-no-drag flex min-w-0 items-center gap-[8px] overflow-hidden">
          <label className="flex items-center gap-[5px]">
            <span className="text-[10px] font-semibold tracking-[0.1em] text-faint">COMPANY</span>
                <Select value={company?.id ?? ''} onValueChange={switchCompany}>
                  <SelectTrigger size="sm" aria-label="Switch company" className="h-6! max-w-[220px]! min-w-0 gap-1.5 rounded-md border-border-strong bg-surface-1/50 px-2! text-xs! text-soft [&>svg]:size-3.5">
                    <SelectValue placeholder="No company" />
                  </SelectTrigger>
                  <SelectContent align="start" position="popper">
                    {orgState.companies.map((item) => <SelectItem key={item.id} value={item.id} disabled={failedCompanyIds.has(item.id)}>{item.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              <Dialog open={companyCreateOpen} onOpenChange={setCompanyCreateOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="xs" className="h-6 shrink-0 rounded-md px-2 text-xs" title="Create a new AI company">
                    + New
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[460px]">
                  <DialogHeader>
                    <DialogTitle>Create AI company</DialogTitle>
                    <DialogDescription>Seeds an AI PM, builder, reviewer, researcher, teams, skills, workflow, memory boundary, and safety policies for the new company.</DialogDescription>
                  </DialogHeader>
                  <form onSubmit={createCompany} className="grid gap-[9px]">
                    <Input placeholder="Company name" value={companyDraft.name} onChange={(event) => setCompanyDraft((value) => ({ ...value, name: event.target.value }))} required autoFocus />
                    <Input placeholder="Company mission" value={companyDraft.mission} onChange={(event) => setCompanyDraft((value) => ({ ...value, mission: event.target.value }))} required />
                    <DialogFooter>
                      <DialogClose asChild>
                        <Button variant="outline" type="button">Cancel</Button>
                      </DialogClose>
                      <Button type="submit">Create AI company</Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
              {company ? (
                <button
                  type="button"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-destructive/10 hover:text-destructive"
                  title={`Remove ${company.name} from ND`}
                  aria-label={`Remove company ${company.name} from ND`}
                  onClick={() => setRemoveCompanyId(company.id)}
                >
                  <TrashIcon className="size-3.5" />
                </button>
              ) : null}
              <Dialog open={companyRemovalTarget !== null} onOpenChange={(open) => { if (!open) setRemoveCompanyId(null) }}>
                <DialogContent className="sm:max-w-[470px]">
                  <DialogHeader>
                    <DialogTitle>Remove company from ND?</DialogTitle>
                    <DialogDescription>
                      {companyRemovalTarget
                        ? `ND will forget "${companyRemovalTarget.company.name}" and every record it owns: ${companyRemovalTarget.projects} project${companyRemovalTarget.projects === 1 ? '' : 's'}, ${companyRemovalTarget.tasks} task${companyRemovalTarget.tasks === 1 ? '' : 's'}, ${companyRemovalTarget.milestones} milestone${companyRemovalTarget.milestones === 1 ? '' : 's'}, ${companyRemovalTarget.goals} goal${companyRemovalTarget.goals === 1 ? '' : 's'}, ${companyRemovalTarget.runs} run receipt${companyRemovalTarget.runs === 1 ? '' : 's'}, ${companyRemovalTarget.agents} agent${companyRemovalTarget.agents === 1 ? '' : 's'}, plus roles, teams, memory, skills, workflows, and policies.`
                        : ''}
                    </DialogDescription>
                  </DialogHeader>
                  {companyRemovalTarget?.activeRuns ? (
                    <p className="m-0 text-xs/[1.5] text-muted-foreground">
                      Stopping first: {companyRemovalTarget.activeRuns} running run{companyRemovalTarget.activeRuns === 1 ? '' : 's'} will be cancelled (sessions stopped, task worktrees rolled back, employees released).
                    </p>
                  ) : null}
                  <p className="m-0 text-xs/[1.5] text-muted-foreground">Workspace folders on disk are not changed. Create a new company any time to start fresh.</p>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="outline" type="button">Cancel</Button>
                    </DialogClose>
                    <Button
                      variant="destructive"
                      disabled={!companyRemovalTarget}
                      onClick={() => {
                        const id = companyRemovalTarget?.company.id
                        if (!id) return
                        void window.ndDshOrganization.mutate({ type: 'company.remove', id })
                          .then(() => setRemoveCompanyId(null))
                          .catch((cause) => notify(errorMessage(cause)))
                      }}
                    >
                      Remove company
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <label className="flex items-center gap-[5px]">
                <span className="text-[10px] font-semibold tracking-[0.1em] text-faint">PROJECT</span>
                <Select value={project?.id ?? ''} onValueChange={switchProject}>
                  <SelectTrigger size="sm" aria-label="Switch project" className="h-6! max-w-[220px]! min-w-0 gap-1.5 rounded-md border-border-strong bg-surface-1/50 px-2! text-xs! text-soft [&>svg]:size-3.5">
                    <SelectValue placeholder="No project" />
                  </SelectTrigger>
                  <SelectContent align="start" position="popper">
                    {companyProjects.map((item) => <SelectItem key={item.id} value={item.id} disabled={failedProjectIds.has(item.id)}>{item.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              <Button variant="outline" size="xs" className="h-6 rounded-md px-2 text-xs" onClick={() => { switchToWorkbench('company'); setCompanyView('operations') }}>
                Manage
              </Button>
              {showGitControls && workspace?.root ? <ProjectGitControls key={`${workspace.projectId ?? 'workspace'}:${workspace.root}:${workspace.binding ?? 'standalone'}`} root={workspace.root} editable={gitEditable} workspaceBinding={workspace.binding} onError={notify} /> : null}
              <ExtensionKeepAliveTabs organization={orgState} activeContext={currentContext(orgState)} />
            </div>
          ) : null}
        </div>
        <nav className="app-no-drag flex min-w-0 self-start items-center justify-center pt-[2px]" aria-label="ND-DSH navigation">
          <div className="flex min-w-0 items-center justify-center gap-0.5 rounded-lg border border-border-soft bg-surface-1/70 p-[3px] shadow-[inset_0_1px_0_rgba(255,255,255,0.025),0_4px_14px_rgba(0,0,0,0.12)]">
            {navItems.map((item) => (
              <button
                key={item.id}
                className={navButtonClasses(surface === 'workbench' && view === item.id)}
                onClick={() => switchToWorkbench(item.id)}
                title={item.label}
                aria-current={surface === 'workbench' && view === item.id ? 'page' : undefined}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className="app-no-drag flex min-w-0 items-center justify-end gap-[7px] overflow-hidden font-mono text-xs text-faint">
          {workspace?.binding === 'project' ? (
            <Badge
              variant="outline"
              className="h-[17px] shrink-0 rounded-full border-primary/20 bg-primary/[0.06] px-[5px] font-sans text-[10px] font-extrabold tracking-[0.08em] text-primary"
            >
              SYNC
            </Badge>
          ) : null}
          <TitlebarIconButton
            active={true}
            title="Inspect target: this ND-DSH app — the camera captures this window, the crosshair picks elements here. Click to target external apps instead."
            onClick={toggleInspectScope}
          >
            <MonitorIcon />
          </TitlebarIconButton>
          <ScreenshotDropdown
            scope={inspectScope}
            disabled={appInspectCountdown !== null || appInspectInFlight}
            onSelectMode={(selectedMode) => {
              if (selectedMode === 'full') startAppInspect('full')
              else openCaptureOverlay(selectedMode)
            }}
          >
            <TitlebarIconButton
              title="Inspect screenshot options: Full, Area, or Direct Annotation"
              disabled={appInspectCountdown !== null || appInspectInFlight}
            >
              <CameraIcon />
            </TitlebarIconButton>
          </ScreenshotDropdown>
          <TitlebarIconButton
            title="Inspect an element in this app (Ctrl+Alt+E) — hover and click any element in ND-DSH, then Add to chat"
            disabled={elementInspectActive}
            onClick={startElementInspect}
          >
            <CrosshairIcon />
          </TitlebarIconButton>
          <ThemeToggle theme={theme} onSelect={selectTheme} />
          <span className={cn('inline-block size-1.5 shrink-0 rounded-full', harnessDotClasses(harnessStatus?.state))} title={harnessStatus?.model ?? 'Runtime offline'} />
          <TitlebarIconButton
            title={workspaceCollapsed ? 'Expand workspace pane' : 'Collapse workspace pane'}
            onClick={() => setWorkspaceCollapsed((collapsed) => !collapsed)}
          >
            <SidebarToggleIcon collapsed={!workspaceCollapsed} />
          </TitlebarIconButton>
        </div>
      </header>

      <main className="relative min-h-0 min-w-0 overflow-hidden bg-surface-0">
        {workspaceProfile === 'coding' && surface === 'dsh' ? (
          <SurfaceErrorBoundary label="ND Harness" resetKey={surface} onError={notify}>
            <DshCodingSurface active inspectOverlayVisible={inspectOverlayVisible} state={dshView} onNotify={notify} />
          </SurfaceErrorBoundary>
        ) : (
          <>
            <div className={cn('h-full w-full', view === 'settings' ? 'hidden' : 'block')}>
              <Group orientation="horizontal" className="h-full w-full">
            <Panel className="flex min-w-0 flex-col overflow-hidden" defaultSize={initialChat.width} minSize={sessionsCollapsed ? CHAT_MIN_PX_SIDEBAR_COLLAPSED : CHAT_MIN_PX}>
              <SurfaceErrorBoundary label="Chat" resetKey={workspace?.root ?? 'workspace-loading'} onError={notify}>
                <ChatPanel
                  key={workspace?.root ?? 'workspace-loading'}
                  status={harnessStatus}
                  workspaceRoot={workspace?.root}
                  onGitEditableChange={setGitEditable}
                  {...(workspace?.projectName || workspace?.name ? { workspaceName: workspace.projectName ?? workspace.name } : {})}
                  workspaceSelected={workspaceSelected}
                  onOpenWorkspace={openWorkspaceFolder}
                  sessionProjectScope={{ activeProjectId: project?.id, sessionProjects: runSessionProjects }}
                  {...(companyProjects.length ? {
                    projects: companyProjects.map((item) => ({
                      id: item.id,
                      name: item.name,
                      active: item.id === project?.id,
                      linked: Boolean(item.workspacePath),
                    })),
                    onSelectProject: switchProject,
                  } : {})}
                  sessionsCollapsed={sessionsCollapsed}
                  onError={notify}
                  onOpenSettings={openSettings}
                  onOpenFile={(path) => void openFile(path)}
                  onOpenLink={(url) => void openLink(url)}
                  externalPrompt={externalPrompt}
                  onExternalPromptConsumed={() => setExternalPrompt(null)}
                  incomingImage={queuedCapture}
                  onIncomingImageConsumed={() => setQueuedCapture(null)}
                  sessionOpenRequest={sessionOpenRequest}
                  onSessionOpenConsumed={() => setSessionOpenRequest(null)}
                  elementAttachmentVersion={elementAttachmentVersion}
                />
              </SurfaceErrorBoundary>
            </Panel>
            <Separator
              aria-label="Resize chat pane"
              className="w-[5px] shrink-0 cursor-col-resize touch-none [&_div]:transition-[width,background-color] [&_div]:duration-150 hover:[&_div]:w-0.5 hover:[&_div]:bg-primary active:[&_div]:w-0.5 active:[&_div]:bg-primary"
            >
              <div className="h-full w-px bg-border-strong" />
            </Separator>
            <Panel className="relative min-h-0 min-w-0 overflow-hidden bg-surface-0" minSize={WORKSPACE_MIN_PX}>
              <section aria-hidden={view !== 'home'} className={cn('absolute inset-0 overflow-hidden', view === 'home' ? 'block' : 'hidden')}>
                <SurfaceErrorBoundary label="Personal" resetKey={`home:${homeState?.notes.length ?? 0}`} onError={notify}>
                  {homeState ? (
                    <PersonalSurface
                      active={view === 'home'}
                      pane={personalPane}
                      onPaneChange={setPersonalPane}
                      dialpadOpen={personalDialpadOpen}
                      onDialpadOpenChange={setPersonalDialpadOpen}
                      dialpad={
                        <PersonalDialpad
                          links={homeState.links}
                          currentUrl={browserState?.url}
                          busy={homeBusy}
                          onOpen={openPersonalTab}
                          onSaveCurrent={savePersonalDialpadLink}
                          onRemoveLink={removePersonalDialpadLink}
                          onError={notify}
                        />
                      }
                      state={browserState}
                      onSnapshot={(result) => {
                        navigator.clipboard.writeText(result)
                          .then(() => notify('Browser snapshot copied to the clipboard.'))
                          .catch(() => notify('Browser snapshot captured, but copying to the clipboard failed.'))
                      }}
                      onError={notify}
                      onOpenSettings={() => {
                        setSettingsTab('general')
                        setSettingsSubTabs((current) => ({ ...current, general: 'browser' }))
                        switchToWorkbench('settings')
                      }}
                    >
                      <HomeView
                        state={homeState}
                        busy={homeBusy}
                        onError={notify}
                        onChanged={refreshHome}
                        onCaptureScreen={homeCaptureScreen}
                        onCaptureArea={openLocalAreaCapture}
                        onCopyCapture={(captureId) => runHomeCaptureAction('capture-copy', captureId)}
                        onExportCapture={(captureId) => runHomeCaptureAction('capture-export', captureId)}
                        onAskWithCapture={askWithCapture}
                        onOpenChat={openSession}
                        onStartChat={(prompt) => startContextChat(prompt?.trim() || 'Hello ND — this is my personal space.', { kind: 'personal' })}
                      />
                    </PersonalSurface>
                  ) : null}
                </SurfaceErrorBoundary>
              </section>

              <section aria-hidden={view !== 'company'} className={cn('absolute inset-0 overflow-hidden', view === 'company' ? 'block' : 'hidden')}>
                <SurfaceErrorBoundary label="Company" resetKey={`${companyView}:${company?.id ?? ''}:${project?.id ?? ''}`} onError={notify}>
                  <OrganizationDashboard workspace={workspace} onOpenDeepSeek={() => switchToWorkbench('agent')} onAskAgent={askAgent} onError={notify} companyView={companyView} onCompanyViewChange={setCompanyView} />
                </SurfaceErrorBoundary>
              </section>

              <section aria-hidden={view !== 'agent'} className={cn('absolute inset-0 overflow-hidden', view === 'agent' && !workspaceCollapsed ? 'flex' : 'hidden')}>
                <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
                  <div className="flex shrink-0 items-center gap-[3px] border-b border-border-soft bg-secondary px-2 py-1" role="tablist" aria-label="Agent workspace panes">
                    <button className={paneTabClasses(agentPane === 'files')} onClick={() => setAgentPane('files')}>
                      <FileIcon />
                      <span>Files</span>
                    </button>
                    <button className={paneTabClasses(agentPane === 'browser')} onClick={() => setAgentPane('browser')}>
                      <BrowserIcon />
                      <span>Browser</span>
                    </button>
                  </div>
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                    {agentPane === 'files' ? (
                      <div className="grid h-full w-full min-h-0 grid-cols-[minmax(0,1fr)_200px]">
                        <div className="min-h-0 min-w-0 overflow-hidden">
                          {activeDiff ? (
                            <SurfaceErrorBoundary label="Diff" resetKey={`${activeDiff.relativePath}:${String(activeDiff.staged)}`} onError={notify}>
                              <DiffView
                                relativePath={activeDiff.relativePath}
                                staged={activeDiff.staged}
                                onClose={() => setActiveDiff(null)}
                                onError={notify}
                              />
                            </SurfaceErrorBoundary>
                          ) : (
                            <>
                              {openFileTabs.length ? (
                                <div className="flex items-stretch overflow-x-auto border-b border-border-soft bg-secondary" role="tablist" aria-label="Open files">
                                  {openFileTabs.map((tab) => {
                                    const active = selectedFile?.relativePath === tab.relativePath
                                    return (
                                      <div
                                        key={tab.relativePath}
                                        className={cn(
                                          'group flex max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-border-soft px-[11px] py-[7px] text-[10px]',
                                          active ? 'bg-surface-0 text-strong' : 'text-soft hover:bg-accent/60'
                                        )}
                                        title={tab.relativePath}
                                        onClick={() => setSelectedFile(tab)}
                                      >
                                        <FileIcon style={{ color: fileAccent(tab.relativePath) }} className="size-[13px] shrink-0" />
                                        <span className="truncate">{tab.relativePath.split(/[\\/]/).at(-1)}</span>
                                        <button
                                          type="button"
                                          aria-label={`Close ${tab.relativePath}`}
                                          className={cn(
                                            'ml-0.5 shrink-0 rounded px-1 text-[11px] leading-none text-faint hover:bg-border-soft hover:text-foreground',
                                            active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                                          )}
                                          onClick={(e) => { e.stopPropagation(); closeFileTab(tab.relativePath) }}
                                        >
                                          ×
                                        </button>
                                      </div>
                                    )
                                  })}
                                </div>
                              ) : null}
                              <SurfaceErrorBoundary label="Editor" resetKey={selectedFile?.relativePath ?? ''} onError={notify}>
                                <EditorPane file={selectedFile} onAgentPrompt={askAgent} onOpenLink={(url) => void openLink(url)} onError={notify} />
                              </SurfaceErrorBoundary>
                            </>
                          )}
                        </div>
                        <div className="min-h-0 border-l border-border-soft">
                          <SurfaceErrorBoundary label="Files" resetKey={workspace?.root ?? ''} onError={notify}>
                            <Explorer
                              workspace={workspace}
                              workspaceSelected={workspaceSelected}
                              selectedPath={selectedFile?.relativePath}
                              onWorkspaceChanged={changeWorkspace}
                              onOpenFile={(path) => void openFile(path)}
                              onOpenDiff={openDiff}
                              onError={notify}
                            />
                          </SurfaceErrorBoundary>
                        </div>
                      </div>
                    ) : (
                      <SurfaceErrorBoundary label="Browser" resetKey={`${view}:${browserState?.url ?? ''}`} onError={notify}>
                        <BrowserPane
                          active={view === 'agent'}
                          state={browserState}
                          onSnapshot={(result) => {
                            navigator.clipboard.writeText(result)
                              .then(() => notify('Browser snapshot copied to the clipboard.'))
                              .catch(() => notify('Browser snapshot captured, but copying to the clipboard failed.'))
                          }}
                          onError={notify}
                          onOpenSettings={() => {
                            setSettingsTab('general')
                            setSettingsSubTabs((current) => ({ ...current, general: 'browser' }))
                            switchToWorkbench('settings')
                          }}
                        />
                      </SurfaceErrorBoundary>
                    )}
                  </div>
                </div>
              </section>

              <section aria-hidden={view !== 'design'} className={cn('absolute inset-0 overflow-hidden', view === 'design' ? 'block' : 'hidden')}>
                <SurfaceErrorBoundary label="Design" resetKey={`${view}:${workspace?.root ?? ''}`} onError={notify}>
                  <DesignView
                    active={view === 'design'}
                    workspace={workspace}
                    workspaceSelected={workspaceSelected}
                    browser={browserState}
                    harness={harnessStatus}
                    onWorkspaceChanged={changeWorkspace}
                    onAskAgent={askAgent}
                    onError={notify}
                    onNotify={notify}
                  />
                </SurfaceErrorBoundary>
              </section>

              <section aria-hidden={view !== 'qa'} className={cn('absolute inset-0 overflow-hidden', view === 'qa' ? 'block' : 'hidden')}>
                <SurfaceErrorBoundary label="QA" resetKey={view} onError={notify}>
                  <QaView active={view === 'qa'} {...(workspace?.root ? { workspaceRoot: workspace.root } : {})} onError={notify} onAskAgent={askAgent} />
                </SurfaceErrorBoundary>
              </section>
            </Panel>
          </Group>
        </div>
        {view === 'settings' ? (
          <section aria-hidden={view !== 'settings'} className="relative h-full w-full overflow-hidden">
            <Suspense fallback={<div className="grid h-full w-full place-items-center bg-surface-0"><div className="size-[34px] animate-spin rounded-full border border-border-strong border-t-primary" /></div>}>
              <SurfaceErrorBoundary label="Settings" resetKey={view} onError={notify}>
                <SettingsPane
                  theme={theme}
                  onSelectTheme={selectTheme}
                  workspace={workspace}
                  onWorkspaceChanged={changeWorkspace}
                  harness={harnessStatus}
                  browser={browserState}
                  onError={notify}
                  onOpenBrowser={() => {
                    switchToWorkbench('agent')
                    setAgentPane('browser')
                  }}
                  tab={settingsTab}
                  onSelectTab={setSettingsTab}
                  subTab={settingsSubTabs.general}
                  onSelectSubTab={(subTab) => setSettingsSubTabs((current) => ({ ...current, general: subTab }))}
                  capabilitySubTab={settingsSubTabs.capabilities}
                  onSelectCapabilitySubTab={(subTab) => setSettingsSubTabs((current) => ({ ...current, capabilities: subTab }))}
                  enginesSubTab={settingsSubTabs.engines}
                  onSelectEnginesSubTab={(subTab) => setSettingsSubTabs((current) => ({ ...current, engines: subTab }))}
                  onOpenSession={openSession}
                  extensionsExtra={ndExtensions ? (
                    <ExtensionPackagesCard
                      state={ndExtensions}
                      organization={orgState}
                      contexts={extensionContextOptions}
                      requestedView={extensionViewRequest}
                      onRequestedViewHandled={() => setExtensionViewRequest(null)}
                      browserFocusNudge={browserFocusNudge}
                      onOpenBrowser={async (tabId) => {
                        await window.ndDsh.browserPlatform.activateTab('builtin', tabId)
                        await window.ndDsh.browserPlatform.select({ mode: 'tab', targetId: 'builtin', tabId })
                        switchToWorkbench('agent')
                        setAgentPane('browser')
                      }}
                      onError={notify}
                      onChanged={async () => {
                        setNdExtensions(await window.ndDsh.ndExtensions.state())
                      }}
                    />
                  ) : null}
                />
              </SurfaceErrorBoundary>
            </Suspense>
          </section>
        ) : null}
      </>
    )}
      </main>

      {!isFloatOverlay ? (
        <QuickLauncher
          open={quickLauncherOpen}
          onOpenChange={setQuickLauncherOpen}
          organization={orgState}
          currentUrl={browserState?.url}
          onOpenKanban={() => {
            setCompanyView('workspace')
            switchToWorkbench('company')
          }}
          onOpenAgent={() => switchToWorkbench('agent')}
          onActivateProject={launcherActivateProject}
          onSwitchCompany={launcherSwitchCompany}
          onCreateTask={launcherCreateTask}
          contexts={extensionContextOptions}
          activeContextId={launcherContextId}
          contextLabel={describeContextForUi(activeLauncherContext(), orgState)}
          onSelectContext={setLauncherContextId}
          extensionCommands={extensionCommands}
          onRunExtensionCommand={(command, text) => runExtensionCommand(command, text)}
          onQuickNote={launcherQuickNote}
          onAskAgent={(text) => {
            const context = activeLauncherContext()
            if (context.kind === 'personal') void startContextChat(text, context)
            else askAgent(text)
          }}
          onCaptureScreen={() => startAppInspect('full', undefined, 'external').then(() => undefined)}
          onOpenCaptureTools={() => {
            setInspectScope('external')
            return window.ndDsh.window?.setFloatMode(true).then(() => undefined)
          }}
          onCaptureClipboard={() => captureClipboardToNote()}
          onCaptureUrl={(url) => launcherQuickNote(url, ['capture', 'url'])}
        />
      ) : null}
      <RuntimePrompts onError={notify} organization={orgState} />
      <ExtensionKeepAliveHost onError={notify} />
      <ModalInspectDock
        hidden={captureOverlay !== null}
        pickDisabled={elementInspectActive}
        screenshotDisabled={appInspectCountdown !== null || appInspectInFlight}
        onPickElement={startElementInspect}
        onScreenshot={() => {
          void startAppInspect('full')
        }}
      />
      {pendingPick ? (
        <div role="dialog" aria-label="Picked element" className="fixed right-4 bottom-[46px] z-[150] flex w-[300px] flex-col gap-2 rounded-[10px] border border-border-strong bg-surface-1 p-3 shadow-[0_14px_40px_rgba(0,0,0,0.5)]">
          <div title={pendingPick.hover} className="flex min-w-0 cursor-help items-center gap-[7px]">
            <CrosshairIcon className="size-[13px] shrink-0 text-primary" />
            <strong className="overflow-hidden font-mono text-[11px] text-ellipsis whitespace-nowrap">{pendingPick.shortName}</strong>
            <span className="overflow-hidden text-[9px] text-faint text-ellipsis whitespace-nowrap">{pendingPick.targetTitle}</span>
          </div>
          {pendingPick.element.selector ? (
            <div title={pendingPick.element.selector} className="flex min-w-0 items-center gap-[6px] pl-[19px]">
              <span className="overflow-hidden font-mono text-[9px] text-faint text-ellipsis whitespace-nowrap">{pendingPick.element.selector}</span>
            </div>
          ) : null}
          {pendingPick.element.source ? (
            <div title={`Dev-build source location: ${pendingPick.element.source}`} className="flex min-w-0 items-center gap-[5px] pl-[19px]">
              <FileIcon className="size-[10px] shrink-0 text-faint" />
              <span className="overflow-hidden font-mono text-[9px] text-faint text-ellipsis whitespace-nowrap">{pendingPick.element.source}</span>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-auto rounded-md px-2.5 py-1 text-[11px]"
              onClick={() => void addElementToChat()}
            >
              Add to chat
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-auto rounded-md px-2.5 py-1 text-[11px]"
              onClick={() => setPendingPick(null)}
            >
              Discard
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-auto rounded-md px-2.5 py-1 text-[11px]"
              title="Copy the full element context (selector, styles, source, HTML) the agent would receive"
              onClick={copyPickedElementContext}
            >
              Copy info
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-auto rounded-md px-2.5 py-1 text-[11px]"
              title="Copy the CSS selector path for this element"
              onClick={copyPickedSelector}
            >
              Copy selector
            </Button>
            {pendingPick.hasShot ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto rounded-md px-2.5 py-1 text-[11px]"
                title="Copy the cropped screenshot of this element"
                onClick={copyPickedShot}
              >
                Copy shot
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {pendingAppInspect ? (
        <div role="dialog" aria-label="Inspected app info" className="fixed right-4 bottom-[46px] z-[150] flex w-[300px] flex-col gap-2 rounded-[10px] border border-border-strong bg-surface-1 p-3 shadow-[0_14px_40px_rgba(0,0,0,0.5)]">
          <div className="flex min-w-0 items-center gap-[7px]">
            <CameraIcon className="size-[13px] shrink-0 text-primary" />
            <strong className="overflow-hidden font-mono text-[11px] text-ellipsis whitespace-nowrap">
              {pendingAppInspect.scope === 'external' ? 'External App Inspect' : 'Internal App Inspect'}
            </strong>
            {pendingAppInspect.mode && pendingAppInspect.mode !== 'full' ? (
              <Badge variant="outline" className="text-[9px] font-normal text-primary border-primary/30">
                {pendingAppInspect.mode === 'area' ? 'Area' : 'Annotated'}
              </Badge>
            ) : null}
            <Badge variant="outline" className="ml-auto text-[9px] font-normal">
              {pendingAppInspect.scope}
            </Badge>
          </div>
          <div className="flex flex-col gap-1 pl-[20px] text-[10px] text-muted-foreground font-mono">
            <div><span className="text-faint">Target:</span> {pendingAppInspect.displayLabel}</div>
            <div><span className="text-faint">Resolution:</span> {pendingAppInspect.width} × {pendingAppInspect.height}</div>
            <div className="text-primary font-medium">✓ Sent to ND Chat Agent</div>
            {pendingAppInspect.copiedToClipboard ? <div className="text-faint">✓ Copied image to clipboard</div> : null}
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-auto rounded-md px-2.5 py-1 text-[11px]"
              onClick={() => setPendingAppInspect(null)}
            >
              Dismiss
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-auto rounded-md px-2.5 py-1 text-[11px]"
              title="Copy summary information for this application inspection"
              onClick={() => {
                navigator.clipboard.writeText(`App Inspect Info:\nScope: ${pendingAppInspect.scope}\nMode: ${pendingAppInspect.mode ?? 'full'}\nTarget: ${pendingAppInspect.displayLabel}\nResolution: ${pendingAppInspect.width}x${pendingAppInspect.height}`)
                  .then(() => toast('App inspect info copied to clipboard.'))
                  .catch((cause) => notify(errorMessage(cause)))
              }}
            >
              Copy info
            </Button>
          </div>
        </div>
      ) : null}
      {appInspectCountdown !== null ? (
        <div role="status" className="fixed right-[18px] bottom-[38px] z-50 max-w-[min(420px,calc(100vw-36px))] rounded-lg border border-border-strong bg-secondary px-3 py-2 text-xs text-soft shadow-[0_18px_50px_rgba(0,0,0,0.46)]">
          {`Screen capture in ${appInspectCountdown}s — switch to the app you want to inspect`}
        </div>
      ) : null}
      {captureOverlay ? (
        <CaptureOverlay
          active={captureOverlay.active}
          initialMode={captureOverlay.mode}
          scope={inspectScope}
          onCapture={async ({ mode, rect }) => {
            if (localCaptureIntent) {
              setLocalCaptureIntent(false)
              await homeCaptureArea(rect)
              return
            }
            if (captureAttachIntent) {
              setCaptureAttachIntent(false)
              void startAppInspect(mode === 'area' ? 'area' : 'annotate', rect, undefined, 0, 'attach')
              return
            }
            startAppInspect(mode === 'area' ? 'area' : 'annotate', rect)
          }}
          onClose={() => {
            setLocalCaptureIntent(false)
            void closeCaptureOverlay()
          }}
        />
      ) : null}
      <Toaster position="bottom-right" duration={5000} />
    </div>
  )
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
