import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Building2,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  FolderOpen,
  Globe,
  Image,
  ListTodo,
  MessageSquare,
  MonitorUp,
  Pause,
  Play,
  Puzzle,
  Shuffle,
  SkipBack,
  SkipForward,
  StickyNote,
  Zap,
} from 'lucide-react'
import type { OrganizationSnapshot } from '../../../shared/organization'
import type { NdMediaSessionState } from '../../../shared/media-session'
import type { NdCommandView } from '../../../shared/nd-invocations'
import { commandRunPlan, type ContextOption } from '../lib/nd-context-model'
import { cn } from '@renderer/lib/utils'
import { MediaArtwork } from './MediaArtwork'
import { SystemVolumeControl } from './SystemVolumeControl'
import {
  DEFAULT_LAUNCHER_COMMAND_REGISTRY,
  launcherCommandGroups,
  type LauncherCommandIcon,
  type LauncherCommandItem,
} from '../lib/command-registry'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from './ui/command'

interface Props {
  open: boolean
  onOpenChange(open: boolean): void
  /** The popup owns dismissal after validation or successful execution. */
  closeBeforeRun?: boolean
  organization: OrganizationSnapshot | null
  currentUrl?: string | undefined
  /** Explicit context selector; the popup defaults to Personal, the in-app launcher to the current context. */
  contexts?: ContextOption[]
  activeContextId?: string
  contextLabel?: string
  onSelectContext?(id: string): void
  /** Extension commands available in the selected context. */
  extensionCommands?: NdCommandView[]
  onRunExtensionCommand?(command: NdCommandView, typed: string): void | Promise<void>
  onOpenKanban(): void
  onOpenAgent(): void
  onOpenMedia(tabId: string): void | Promise<void>
  onActivateProject(projectId: string): void | Promise<void>
  onSwitchCompany(companyId: string): void | Promise<void>
  onCreateTask(text: string): void | Promise<void>
  onQuickNote(text: string): void | Promise<void>
  onAskAgent(text: string): void | Promise<void>
  onCaptureScreen(): void | Promise<void>
  onOpenCaptureTools(): void | Promise<void>
  onCaptureClipboard(): void | Promise<void>
  onCaptureUrl(url: string): void | Promise<void>
}

function launcherIcon(command: LauncherCommandItem): ReactNode {
  if (command.sourceId === 'core.context' && command.shortcut === 'Active') return <Check />
  const icons: Record<LauncherCommandIcon, ReactNode> = {
    task: <ListTodo />,
    note: <StickyNote />,
    agent: <MessageSquare />,
    context: <Building2 />,
    kanban: <ListTodo />,
    'capture-screen': <Camera />,
    'capture-tools': <MonitorUp />,
    clipboard: <Clipboard />,
    link: <FolderOpen />,
    extension: <Puzzle />,
    project: <FolderOpen />,
    company: <Building2 />,
  }
  return icons[command.icon]
}

function Keycap({ children }: { children: ReactNode }): ReactNode {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-border bg-surface-2/80 px-1 font-mono text-[10px] leading-none text-soft">
      {children}
    </kbd>
  )
}

const QUICK_PICKS_EXPANDED_KEY = 'nd.launcher.quick-picks-expanded'
const QUICK_PICKS_LIMIT = 16

const QUICK_PICK_PRIORITY: ReadonlyArray<readonly [string, string]> = [
  ['extensions', 'nd.wallpaper-manager:next-wallpaper'],
  ['extensions', 'nd.wallpaper-manager:open-wallpaper-studio'],
  ['extensions', 'nd.wallpaper-manager:previous-wallpaper'],
  ['extensions', 'nd.wallpaper-manager:random-wallpaper'],
  ['core.capture', 'capture-screen'],
  ['core.capture', 'capture-clipboard'],
  ['core.quick-actions', 'open-kanban'],
  ['core.quick-actions', 'open-agent'],
  ['extensions', 'nd.daily-essentials:capture-area'],
  ['extensions', 'nd.daily-essentials:search-notes'],
  ['extensions', 'nd.daily-essentials:open-google'],
  ['core.capture', 'capture-tools'],
]

const QUICK_PICK_TITLES: Record<string, string> = {
  'core.capture:capture-screen': 'Capture screen',
  'core.capture:capture-clipboard': 'Clipboard',
  'core.capture:capture-tools': 'Capture tools',
  'core.quick-actions:open-kanban': 'Kanban',
  'core.quick-actions:open-agent': 'Agent',
  'nd.wallpaper-manager:next-wallpaper': 'Next wallpaper',
  'nd.wallpaper-manager:previous-wallpaper': 'Previous wallpaper',
  'nd.wallpaper-manager:random-wallpaper': 'Random wallpaper',
  'nd.wallpaper-manager:open-wallpaper-studio': 'Wallpaper Studio',
  'nd.daily-essentials:capture-area': 'Capture area',
  'nd.daily-essentials:search-notes': 'Notes',
  'nd.daily-essentials:open-google': 'Google',
}

const QUICK_PICK_SAFE_HOSTS = new Set([
  'capture.area',
  'capture.screen',
  'clipboard.read',
  'note.search',
  'os.wallpaper.next',
  'os.wallpaper.previous',
  'os.wallpaper.random',
  'os.wallpaper.status',
])

/** A quick pick must be able to run without typed input. */
function quickPickRunnable(command: NdCommandView): boolean {
  if (commandRunPlan(command, '').missing) return false
  return Boolean(command.openViewId) || QUICK_PICK_SAFE_HOSTS.has(command.host)
}

function quickPickIcon(command: LauncherCommandItem): ReactNode {
  const icons: Record<string, ReactNode> = {
    'core.capture:capture-screen': <Camera />,
    'core.capture:capture-clipboard': <Clipboard />,
    'core.capture:capture-tools': <MonitorUp />,
    'core.quick-actions:open-kanban': <ListTodo />,
    'core.quick-actions:open-agent': <MessageSquare />,
    'nd.wallpaper-manager:next-wallpaper': <ChevronRight />,
    'nd.wallpaper-manager:previous-wallpaper': <ChevronLeft />,
    'nd.wallpaper-manager:random-wallpaper': <Shuffle />,
    'nd.wallpaper-manager:open-wallpaper-studio': <Image />,
    'nd.daily-essentials:capture-area': <MonitorUp />,
    'nd.daily-essentials:search-notes': <StickyNote />,
    'nd.daily-essentials:open-google': <Globe />,
  }
  return icons[`${command.sourceId}:${command.id}`] ?? <Puzzle />
}

function readQuickPicksExpanded(): boolean {
  try {
    return globalThis.localStorage?.getItem(QUICK_PICKS_EXPANDED_KEY) === '1'
  } catch {
    return false
  }
}

function QuickPickChip({ command, onSelect }: { command: LauncherCommandItem; onSelect(): void }): ReactNode {
  return (
    <button
      type="button"
      title={command.title}
      onClick={onSelect}
      className="group inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border-soft bg-surface-2/60 px-2.5 text-[11px] font-medium text-soft transition-colors hover:border-border-strong hover:bg-surface-3 hover:text-strong focus-visible:outline-2 focus-visible:outline-primary"
    >
      <span className="text-faint transition-colors group-hover:text-primary [&_svg]:size-3.5">
        {quickPickIcon(command)}
      </span>
      <span className="max-w-[140px] truncate">
        {QUICK_PICK_TITLES[`${command.sourceId}:${command.id}`] ?? command.title}
      </span>
    </button>
  )
}

export function QuickLauncher({
  open,
  onOpenChange,
  closeBeforeRun = true,
  organization,
  currentUrl,
  contexts = [],
  activeContextId,
  contextLabel,
  onSelectContext,
  extensionCommands = [],
  onRunExtensionCommand,
  onOpenKanban,
  onOpenAgent,
  onOpenMedia,
  onActivateProject,
  onSwitchCompany,
  onCreateTask,
  onQuickNote,
  onAskAgent,
  onCaptureScreen,
  onOpenCaptureTools,
  onCaptureClipboard,
  onCaptureUrl,
}: Props) {
  const [query, setQuery] = useState('')
  const [media, setMedia] = useState<NdMediaSessionState | null>(null)
  const running = useRef(false)
  const companies = organization?.companies ?? []
  const projects = organization?.projects ?? []
  const activeCompany = companies.find((item) => item.id === organization?.activeCompanyId) ?? companies[0]
  const activeProject = projects.find((item) => item.id === organization?.activeProjectId)

  const commands = DEFAULT_LAUNCHER_COMMAND_REGISTRY.list({
    query,
    organization,
    ...(currentUrl ? { currentUrl } : {}),
    contexts,
    ...(activeContextId ? { activeContextId } : {}),
    extensionCommands,
    actions: {
      selectContext: (id) => onSelectContext?.(id),
      openKanban: onOpenKanban,
      openAgent: onOpenAgent,
      activateProject: onActivateProject,
      switchCompany: onSwitchCompany,
      createTask: onCreateTask,
      quickNote: onQuickNote,
      askAgent: onAskAgent,
      captureScreen: onCaptureScreen,
      openCaptureTools: onOpenCaptureTools,
      captureClipboard: onCaptureClipboard,
      captureUrl: onCaptureUrl,
      runExtension: (command, typed) => onRunExtensionCommand?.(command, typed),
    },
  })
  const groups = launcherCommandGroups(commands)
  // The popup window is inset from its card so the CSS shadow can paint on the
  // transparent surface. Anchor the card near the top like Raycast instead of
  // centering it, so the footer can never fall below the window edge.
  const popupSurface = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] === 'launcher'
  const collapsedQuickPickCount = popupSurface ? 5 : 4

  const [quickPicksExpanded, setQuickPicksExpanded] = useState(readQuickPicksExpanded)
  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(QUICK_PICKS_EXPANDED_KEY, quickPicksExpanded ? '1' : '0')
    } catch {
      // Storage can be unavailable in hardened profiles; the toggle still works per open.
    }
  }, [quickPicksExpanded])

  // Quick picks surface the commands people reach for most without opening the
  // full registry. Only no-input commands are eligible, so a click can never
  // fail with a "type something first" validation.
  const extensionViews = new Map<string, NdCommandView>(
    extensionCommands.map((command) => [`${command.extensionId}:${command.contributionId}`, command] as const),
  )
  const quickPicks: LauncherCommandItem[] = []
  const quickPickKeys = new Set<string>()
  const addQuickPick = (sourceId: string, id: string): void => {
    if (quickPicks.length >= QUICK_PICKS_LIMIT) return
    const key = `${sourceId}:${id}`
    if (quickPickKeys.has(key)) return
    const command = commands.find((candidate) => candidate.sourceId === sourceId && candidate.id === id)
    if (!command) return
    quickPickKeys.add(key)
    quickPicks.push(command)
  }
  for (const [sourceId, id] of QUICK_PICK_PRIORITY) addQuickPick(sourceId, id)
  for (const command of commands) {
    if (quickPicks.length >= QUICK_PICKS_LIMIT) break
    // Daily Essentials duplicates core capture/notes actions under different
    // ids; its unique commands are already in the priority list.
    if (command.sourceId !== 'extensions' || command.id.startsWith('nd.daily-essentials:')) continue
    if (quickPickKeys.has(`extensions:${command.id}`)) continue
    const view = extensionViews.get(command.id)
    if (!view || !quickPickRunnable(view)) continue
    quickPickKeys.add(`extensions:${command.id}`)
    quickPicks.push(command)
  }
  const showQuickPicks = query.trim().length === 0 && quickPicks.length > 0
  const leadingQuickPicks = quickPicks.slice(0, collapsedQuickPickCount)
  const extraQuickPicks = quickPicks.slice(collapsedQuickPickCount)

  // The transport row mirrors whatever the embedded browser is playing; main
  // pushes changes, so pausing from the page updates the row too.
  useEffect(() => {
    let mounted = true
    void window.ndDsh.media?.state()
      .then((next) => { if (mounted) setMedia(next) })
      .catch(() => undefined)
    const off = window.ndDsh.media?.onState((next) => { if (mounted) setMedia(next) })
    return () => {
      mounted = false
      off?.()
    }
  }, [])

  const closeAndRun = (command: LauncherCommandItem): void => {
    if (command.closeOnRun === false) {
      void Promise.resolve(command.run())
      return
    }
    if (!closeBeforeRun) {
      if (running.current) return
      running.current = true
      void Promise.resolve().then(() => command.run()).finally(() => { running.current = false })
      return
    }
    setQuery('')
    onOpenChange(false)
    void Promise.resolve(command.run())
  }

  const handleOpenChange = (next: boolean): void => {
    if (!next) setQuery('')
    onOpenChange(next)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="ND Quick Launcher"
      description="Search one registry of ND, company, project, and extension commands."
      className={cn(
        'rounded-[18px] border-border-strong bg-surface-1/98',
        popupSurface
          ? 'top-10 h-[min(640px,calc(100vh-80px))] translate-y-0 max-w-[780px] sm:max-w-[780px]'
          : 'max-w-[720px] shadow-[0_28px_90px_rgba(0,0,0,0.58)] sm:max-w-[720px]',
      )}
      showCloseButton={false}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border-soft px-4">
        <span className="grid size-7 shrink-0 place-items-center rounded-[8px] bg-gradient-to-br from-primary to-[#0066e6] text-[10px] font-extrabold tracking-[0.08em] text-white shadow-[0_2px_10px_rgba(10,132,255,0.35)]">
          ND
        </span>
        <CommandInput
          autoFocus
          showIcon={false}
          wrapperClassName="h-14 flex-1 border-b-0 px-0"
          className="h-14 text-base placeholder:text-faint"
          value={query}
          onValueChange={setQuery}
          placeholder="Search ND or type something to capture…"
        />
      </div>
      {quickPicks.length > 0 ? (
        <div
          id="launcher-quick-picks"
          inert={!showQuickPicks}
          aria-hidden={!showQuickPicks}
          className={cn(
            'shrink-0 overflow-hidden transition-[max-height,opacity] duration-200 ease-out',
            showQuickPicks ? (quickPicksExpanded ? 'max-h-48 opacity-100' : 'max-h-11 opacity-100') : 'max-h-0 opacity-0',
          )}
        >
          <div className="border-b border-border-soft">
            <div className="flex items-center gap-2 px-4 py-2">
              <span className="flex shrink-0 items-center gap-1 text-[9px] font-semibold uppercase tracking-[0.1em] text-fainter">
                <Zap className="size-3" />
                Quick
              </span>
              <div className="flex min-w-0 flex-1 gap-1.5 overflow-hidden">
                {leadingQuickPicks.map((command) => (
                  <QuickPickChip
                    key={`${command.sourceId}:${command.id}`}
                    command={command}
                    onSelect={() => closeAndRun(command)}
                  />
                ))}
              </div>
              {quickPicks.length > collapsedQuickPickCount ? (
                <button
                  type="button"
                  aria-expanded={quickPicksExpanded}
                  aria-controls="launcher-quick-picks"
                  aria-label={quickPicksExpanded ? 'Collapse quick picks' : `Show all ${quickPicks.length} quick picks`}
                  title={quickPicksExpanded ? 'Collapse quick picks' : `Show all ${quickPicks.length} quick picks`}
                  onClick={() => setQuickPicksExpanded((value) => !value)}
                  className="grid size-6 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-strong focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <ChevronDown
                    className={cn('size-3.5 transition-transform duration-200', quickPicksExpanded ? 'rotate-0' : '-rotate-90')}
                  />
                </button>
              ) : null}
            </div>
            {quickPicksExpanded && extraQuickPicks.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 px-4 pb-2">
                {extraQuickPicks.map((command) => (
                  <QuickPickChip
                    key={`${command.sourceId}:${command.id}`}
                    command={command}
                    onSelect={() => closeAndRun(command)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <CommandList
        className={cn(
          'px-2 py-1.5',
          popupSurface
            ? 'min-h-0 max-h-none flex-1'
            : 'max-h-[420px]',
        )}
      >
        <CommandEmpty>No matching ND command.</CommandEmpty>

        {groups.map((group) => (
          <CommandGroup key={group.group} heading={group.group}>
            {group.items.map((command) => (
              <CommandItem
                key={`${command.sourceId}:${command.id}`}
                value={command.searchText}
                onSelect={() => closeAndRun(command)}
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-[7px] border border-border-soft bg-surface-2/70 text-soft">
                  {launcherIcon(command)}
                </span>
                <span className="min-w-0 flex-1 truncate">{command.title}</span>
                {command.shortcut ? (
                  <CommandShortcut className={command.id === 'capture-url' ? 'max-w-[230px] truncate' : undefined}>
                    {command.shortcut}
                  </CommandShortcut>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>

      {media ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-border-soft px-4 py-2">
          <button
            type="button"
            aria-label={`Open ${media.site || 'media'} in browser`}
            title="Go to playing tab"
            onClick={() => {
              if (closeBeforeRun) onOpenChange(false)
              void onOpenMedia(media.tabId)
            }}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary"
          >
            <MediaArtwork key={JSON.stringify([media.tabId, media.url, media.artworkUrl])} media={media} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-strong">{media.title}</span>
              <span className="block truncate text-[10px] text-faint">
                {media.artist ? `${media.artist} · ` : ''}{media.site || 'media'}
              </span>
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label="Previous track"
              title="Previous track"
              onClick={() => void window.ndDsh.media?.previous()}
              className="rounded-md p-1.5 text-faint transition-colors hover:bg-surface-2 hover:text-strong"
            >
              <SkipBack className="size-4" />
            </button>
            <button
              type="button"
              aria-label={media.playing ? 'Pause' : 'Play'}
              title={media.playing ? 'Pause' : 'Play'}
              onClick={() => void window.ndDsh.media?.playPause()}
              className="rounded-md p-1.5 text-strong transition-colors hover:bg-surface-2"
            >
              {media.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </button>
            <button
              type="button"
              aria-label="Next track"
              title="Next track"
              onClick={() => void window.ndDsh.media?.next()}
              className="rounded-md p-1.5 text-faint transition-colors hover:bg-surface-2 hover:text-strong"
            >
              <SkipForward className="size-4" />
            </button>
          </div>
        </div>
      ) : null}

      <SystemVolumeControl active={open} />

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border-soft px-4 py-2 text-[10px] text-faint">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="size-1.5 shrink-0 rounded-full bg-primary/70" />
          <span className="truncate">
            {contextLabel ?? (activeCompany?.name ?? 'No company')}{activeProject && !contextLabel ? ` · ${activeProject.name}` : ''}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-1"><Keycap>↑</Keycap><Keycap>↓</Keycap>Navigate</span>
          <span className="flex items-center gap-1"><Keycap>↵</Keycap>Run</span>
          <span className="flex items-center gap-1"><Keycap>esc</Keycap>Close</span>
        </span>
      </div>
    </CommandDialog>
  )
}
