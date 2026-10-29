import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import type { BrowserPlatformState, BrowserTabDescriptor } from '../../../shared/browser-platform'
import type { BrowserState } from '../../../shared/contracts'
import { ArrowLeftIcon, ArrowRightIcon, CameraIcon, CheckIcon, ChevronDownIcon, CloseIcon, ContextIcon, ExternalIcon, GlobeIcon, PencilIcon, PlusIcon, PuzzleIcon, ReloadIcon, SpinnerIcon, StarIcon } from './Icons'
import { BridgePill } from './bridge-pill'
import { BrowserProfileAvatar } from './BrowserProfileAvatar'
import { BrowserProfileDialog } from './BrowserProfileDialog'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { SettingsSwitch } from './settings-primitives'
import { cn } from '../lib/utils'

interface BrowserPaneProps {
  active: boolean
  state: BrowserState | null
  onSnapshot(result: string): void
  onError(message: string): void
  /** Opens Settings → General → Browser, the canonical extension manager. */
  onOpenSettings?(): void
  /**
   * The pane's new-tab page, shown in the canvas while the active tab is blank.
   * Only Personal passes one: the Agent workbench stays a work surface without
   * a personal speed dial.
   */
  newTabPage?: ReactNode | undefined
  /** Saves the current site to the dialpad. Absent means no star is offered. */
  onSaveSite?: (() => void) | undefined
  siteSaved?: boolean | undefined
}

const iconButtonClasses = cn(
  'grid size-[27px] shrink-0 place-items-center rounded-[5px] text-muted-foreground transition-colors',
  'hover:bg-accent hover:text-foreground',
  'disabled:pointer-events-none disabled:text-fainter [&_svg]:size-[15px]',
)

const activeIconButtonClasses = cn(
  'inline-flex h-[27px] w-auto items-center gap-[5px] rounded-[5px] border border-border bg-secondary px-[7px]',
  'text-muted-foreground transition-colors hover:border-(--border-focus) hover:text-foreground',
  'disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-[15px]',
)

function tabLabel(tab: BrowserTabDescriptor, index: number): string {
  if (tab.title && tab.title !== 'Browser') return tab.title
  if (tab.url === 'about:blank') return 'New tab'
  return tab.url.replace(/^https?:\/\//, '').split(/[/?]/)[0] || `Tab ${index + 1}`
}

/** Chrome's leading tab slot: spinner while loading, then the site icon. */
function TabFavicon({ tab }: { tab: BrowserTabDescriptor }) {
  const [failed, setFailed] = useState(false)
  if (tab.loading) return <SpinnerIcon className="size-[13px] shrink-0 text-soft" />
  if (tab.favicon && !failed) {
    return <img src={tab.favicon} alt="" className="size-[14px] shrink-0 rounded-[3px] object-contain" onError={() => setFailed(true)} />
  }
  return <GlobeIcon className="size-[13px] shrink-0 text-faint" />
}

export function BrowserPane({ active, state, onSnapshot, onError, onOpenSettings, newTabPage, onSaveSite, siteSaved }: BrowserPaneProps) {
  const uiPreview = window.ndDshRuntimeMode === 'ui-preview'
  const surfaceRef = useRef<HTMLDivElement>(null)
  const tabStripRef = useRef<HTMLDivElement>(null)
  const addressFocused = useRef(false)
  const [address, setAddress] = useState(state?.url ?? 'about:blank')
  const [platform, setPlatform] = useState<BrowserPlatformState | null>(null)
  const [siteToolCount, setSiteToolCount] = useState(0)
  const [extensionsMenuOpen, setExtensionsMenuOpen] = useState(false)
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [profileDialogOpen, setProfileDialogOpen] = useState(false)

  // Tabs of every profile stay alive, but the strip shows the visible identity.
  const builtinTabs = useMemo(
    () => (state?.tabs ?? []).filter((tab) => !state?.profileId || tab.profileId === state.profileId),
    [state?.tabs, state?.profileId],
  )
  const activeTabId = state?.activeTabId
  const profiles = platform?.profiles ?? []
  const activeProfile = profiles.find((profile) => profile.active)
  // The native view is hidden for a blank tab, so this is the only thing the
  // canvas can show there.
  const showsNewTabPage = Boolean(newTabPage) && !state?.loading && (state?.url ?? 'about:blank') === 'about:blank'
  const savableSite = /^https?:\/\//i.test(state?.url ?? '')
  const selectedTargetId = platform?.selection.targetId
    ?? (platform?.selection.mode === 'auto' ? 'auto' : 'builtin')
  const targetForTabs = selectedTargetId === 'auto' ? 'builtin' : selectedTargetId
  const targetTabs = useMemo(
    () => (platform?.tabs ?? []).filter((tab) =>
      tab.targetId === targetForTabs && (targetForTabs !== 'builtin' || tab.profileId === state?.profileId)),
    [platform?.tabs, targetForTabs, state?.profileId],
  )

  useEffect(() => {
    if (!addressFocused.current && state?.url) setAddress(state.url)
  }, [state?.url])

  useEffect(() => {
    let mounted = true
    void window.ndDsh.browserPlatform.state()
      .then((value) => { if (mounted) setPlatform(value) })
      .catch(() => undefined)
    const dispose = window.ndDsh.browserPlatform.onChanged((value) => {
      if (mounted) setPlatform(value)
    })
    return () => {
      mounted = false
      dispose()
    }
  }, [])

  useEffect(() => {
    let mounted = true
    const selectedTabId = platform?.selection.mode === 'tab' && platform.selection.targetId === targetForTabs
      ? platform.selection.tabId
      : targetForTabs === 'builtin'
        ? state?.activeTabId
        : targetTabs.find((tab) => tab.active)?.id
    void window.ndDsh.browserPlatform.siteTools(targetForTabs, selectedTabId)
      .then((tools) => { if (mounted) setSiteToolCount(tools.length) })
      .catch(() => { if (mounted) setSiteToolCount(0) })
    return () => { mounted = false }
  }, [platform?.selection, state?.activeTabId, state?.url, targetForTabs, targetTabs])

  const runBrowserAction = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const createTab = (): void => {
    void runBrowserAction(async () => {
      const tab = await window.ndDsh.browserPlatform.createTab('builtin', 'about:blank')
      await window.ndDsh.browserPlatform.select({ mode: 'tab', targetId: 'builtin', tabId: tab.id })
      setAddress('about:blank')
    })
  }

  const switchTab = (tabId: string): void => {
    void runBrowserAction(async () => {
      await window.ndDsh.browserPlatform.activateTab('builtin', tabId)
      await window.ndDsh.browserPlatform.select({ mode: 'tab', targetId: 'builtin', tabId })
    })
  }

  const closeTab = (tabId: string): void => {
    void runBrowserAction(() => window.ndDsh.browserPlatform.closeTab('builtin', tabId))
  }

  const selectTarget = (value: string): void => {
    void runBrowserAction(async () => {
      if (value === 'auto') await window.ndDsh.browserPlatform.select({ mode: 'auto' })
      else await window.ndDsh.browserPlatform.select({ mode: 'target', targetId: value })
    })
  }

  const switchProfile = (profileId: string): void => {
    if (activeProfile?.id === profileId) {
      setProfileMenuOpen(false)
      return
    }
    void runBrowserAction(async () => {
      await window.ndDsh.browserPlatform.selectProfile(profileId)
      setProfileMenuOpen(false)
    })
  }

  const createProfile = async (input: { name: string; color: string }): Promise<void> => {
    try {
      await window.ndDsh.browserPlatform.createProfile(input.name, input.color)
      setProfileMenuOpen(false)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    }
  }

  const selectTargetTab = (tabId: string): void => {
    if (!targetForTabs || !tabId) return
    void runBrowserAction(async () => {
      await window.ndDsh.browserPlatform.select({ mode: 'tab', targetId: targetForTabs, tabId })
      if (targetForTabs === 'builtin') await window.ndDsh.browserPlatform.activateTab('builtin', tabId)
    })
  }

  /** A tab switched from the keyboard or an agent can sit outside the scrolled strip. */
  useEffect(() => {
    const selected = tabStripRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, builtinTabs])

  useEffect(() => {
    if (!active) return
    const cycleTab = (delta: number): void => {
      if (builtinTabs.length < 2) return
      const index = builtinTabs.findIndex((tab) => tab.id === activeTabId)
      const next = builtinTabs[(Math.max(index, 0) + delta + builtinTabs.length) % builtinTabs.length]
      if (next) switchTab(next.id)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || !(event.ctrlKey || event.metaKey)) return
      // Never steal a chord from a focused field: the composer and address bar own their keys.
      if ((event.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return
      const key = event.key.toLowerCase()
      if (key === 't') {
        event.preventDefault()
        createTab()
      } else if (key === 'w') {
        if (!activeTabId) return
        event.preventDefault()
        closeTab(activeTabId)
      } else if (key === 'tab') {
        event.preventDefault()
        cycleTab(event.shiftKey ? -1 : 1)
      } else if (/^[1-9]$/.test(key)) {
        const tab = key === '9' ? builtinTabs[builtinTabs.length - 1] : builtinTabs[Number(key) - 1]
        if (tab) {
          event.preventDefault()
          switchTab(tab.id)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, activeTabId, builtinTabs])

  /**
   * Bounds only: the native view is one shared child view, so the app shell
   * owns whether it is visible (see the shell's surface decision). A pane that
   * is not the active surface must never write bounds either.
   */
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    let animationFrame = 0
    const syncBounds = (): void => {
      if (!active) return
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(() => {
        const rect = surface.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return
        void window.ndDsh.browser.setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
          .catch((cause) => onError(cause instanceof Error ? cause.message : String(cause)))
      })
    }
    const observer = new ResizeObserver(syncBounds)
    observer.observe(surface)
    window.addEventListener('resize', syncBounds)
    if (active) syncBounds()
    return () => {
      cancelAnimationFrame(animationFrame)
      observer.disconnect()
      window.removeEventListener('resize', syncBounds)
    }
  }, [active, onError])

  const navigate = async (): Promise<void> => {
    try {
      await window.ndDsh.browser.navigate(address)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const snapshot = async (): Promise<void> => {
    try {
      const result = await window.ndDsh.browser.snapshot()
      onSnapshot(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const toggleInspectMode = async (): Promise<void> => {
    const setInspectMode = window.ndDsh.browser.setInspectMode
    if (!setInspectMode) {
      onError('UI inspect mode is available in the ND-DSH desktop app.')
      return
    }
    await runBrowserAction(() => setInspectMode(!state?.inspectMode))
  }

  const clearSelection = async (): Promise<void> => {
    const clear = window.ndDsh.browser.clearSelection
    if (!clear) return
    await runBrowserAction(() => clear())
  }

  const toggleAnnotationMode = async (): Promise<void> => {
    const setAnnotationMode = window.ndDsh.browser.setAnnotationMode
    if (!setAnnotationMode) {
      onError('UI annotation mode is available in the ND-DSH desktop app.')
      return
    }
    await runBrowserAction(() => setAnnotationMode(!state?.annotationMode))
  }

  const clearAnnotation = async (): Promise<void> => {
    const clear = window.ndDsh.browser.clearAnnotation
    if (!clear) return
    await runBrowserAction(() => clear())
  }

  const selected = state?.selectedTarget
  const selectedSource = selected?.source ?? selected?.react?.source
  const selectedName = selected?.react?.component ?? selected?.tagName
  const selectedTitle = selected
    ? `${selectedName ?? 'element'} · ${selectedSource ? `${selectedSource.file}:${selectedSource.line}` : selected.selector}`
    : undefined
  const annotation = state?.annotation
  const annotationTitle = annotation
    ? `${annotation.marks.length} mark${annotation.marks.length === 1 ? '' : 's'} · ${annotation.elements.length} referenced element${annotation.elements.length === 1 ? '' : 's'} · click to clear`
    : undefined
  const approval = platform?.approvals[0]

  return (
    <section className="flex flex-1 flex-col h-full w-full min-h-0 min-w-0 bg-background" aria-label="Built-in browser">
      <div
        ref={tabStripRef}
        role="tablist"
        aria-label="Built-in browser tabs"
        className="flex h-[38px] shrink-0 items-center gap-[3px] overflow-x-auto border-b border-border-soft bg-secondary px-2"
      >
        {builtinTabs.map((tab, index) => {
          const tabActive = tab.id === activeTabId
          const label = tabLabel(tab, index)
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tabActive}
              aria-label={label}
              data-active={tabActive ? 'true' : undefined}
              tabIndex={tabActive ? 0 : -1}
              title={label}
              className={cn(
                'group flex h-[28px] min-w-[68px] max-w-[220px] basis-[190px] cursor-pointer items-center gap-[7px] rounded-[8px] px-[9px] text-[11px] outline-none transition-colors',
                'focus-visible:ring-2 focus-visible:ring-(--border-focus)',
                tabActive ? 'bg-background text-strong shadow-[0_1px_2px_rgb(0_0_0/18%)]' : 'text-soft hover:bg-accent/70',
              )}
              onClick={() => switchTab(tab.id)}
              onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); closeTab(tab.id) } }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); switchTab(tab.id) }
              }}
            >
              <TabFavicon key={tab.favicon ?? 'none'} tab={tab} />
              <span className="min-w-0 flex-1 truncate leading-none">{label}</span>
              <button
                type="button"
                aria-label={`Close ${label}`}
                title="Close tab (Ctrl+W)"
                className={cn(
                  'grid size-[16px] shrink-0 place-items-center rounded-full text-faint opacity-0 transition-opacity hover:bg-border-soft hover:text-foreground',
                  'focus-visible:opacity-100 group-hover:opacity-100',
                  tabActive && 'opacity-100',
                )}
                onClick={(event) => { event.stopPropagation(); closeTab(tab.id) }}
              >
                <CloseIcon className="size-[11px]" />
              </button>
            </div>
          )
        })}
        <button
          type="button"
          aria-label="New tab"
          title="New tab (Ctrl+T)"
          className="grid size-[28px] shrink-0 place-items-center rounded-[8px] text-soft transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-[16px]"
          onClick={createTab}
        >
          <PlusIcon />
        </button>
      </div>

      <div className="flex h-[39px] shrink-0 min-w-0 items-center gap-[3px] border-b border-border-soft bg-secondary px-[7px] py-[5px]">
        <button className={iconButtonClasses} disabled={!state?.canGoBack || state?.annotationMode} onClick={() => void runBrowserAction(() => window.ndDsh.browser.back())} title="Back"><ArrowLeftIcon /></button>
        <button className={iconButtonClasses} disabled={!state?.canGoForward || state?.annotationMode} onClick={() => void runBrowserAction(() => window.ndDsh.browser.forward())} title="Forward"><ArrowRightIcon /></button>
        <button className={iconButtonClasses} disabled={Boolean(state?.annotationMode)} onClick={() => void runBrowserAction(() => window.ndDsh.browser.reload())} title="Reload"><ReloadIcon className={state?.loading ? 'animate-spin' : ''} /></button>
        <form
          className="mx-1 flex h-7 min-w-0 flex-1 items-center gap-[7px] rounded-[7px] border border-border-strong bg-background px-[9px] transition-colors focus-within:border-(--border-focus)"
          onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!state?.annotationMode) void navigate() }}
        >
          <span className={cn('size-1.5 shrink-0 rounded-full', state?.url.startsWith('https:') ? 'bg-primary' : 'bg-warning')} />
          <input
            aria-label="Address"
            value={address}
            disabled={Boolean(state?.annotationMode)}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setAddress(event.target.value)}
            onFocus={() => { addressFocused.current = true }}
            onBlur={() => { addressFocused.current = false }}
            spellCheck={false}
            className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[9px] text-soft outline-none"
          />
        </form>
        {onSaveSite ? (
          <button
            className={cn(iconButtonClasses, siteSaved && 'text-warning')}
            aria-pressed={Boolean(siteSaved)}
            disabled={!savableSite || Boolean(state?.annotationMode)}
            onClick={onSaveSite}
            title={siteSaved ? 'This site is already on your dialpad' : 'Save this site to your dialpad'}
          >
            <StarIcon fill={siteSaved ? 'currentColor' : 'none'} />
          </button>
        ) : null}
        <select
          aria-label="Agent browser target"
          className="h-7 max-w-[150px] rounded-[6px] border border-border bg-background px-1.5 text-[9px] text-soft outline-none"
          value={selectedTargetId}
          onChange={(event) => selectTarget(event.target.value)}
          title="Agent browser target: @Browser, @Chrome, or Auto"
        >
          <option value="auto">Auto</option>
          {(platform?.targets ?? []).map((target) => (
            <option key={target.id} value={target.id}>{target.kind === 'builtin' ? '@Browser' : `@Chrome · ${target.profileLabel}`}</option>
          ))}
        </select>
        {targetTabs.length > 0 ? (
          <select
            aria-label="Agent browser tab"
            className="h-7 max-w-[140px] rounded-[6px] border border-border bg-background px-1.5 text-[9px] text-soft outline-none"
            value={platform?.selection.mode === 'tab' && platform.selection.targetId === targetForTabs ? platform.selection.tabId ?? '' : ''}
            onChange={(event) => selectTargetTab(event.target.value)}
            title="Bind the agent to an exact tab (@Tab)"
          >
            <option value="">Target default</option>
            {targetTabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.title || tab.url || tab.id}</option>)}
          </select>
        ) : null}
        <button className={activeIconButtonClasses} disabled={Boolean(state?.annotationMode)} onClick={() => void snapshot()} title="Interactive snapshot"><CameraIcon /></button>
        <button
          className={state?.inspectMode ? activeIconButtonClasses : iconButtonClasses}
          aria-pressed={Boolean(state?.inspectMode)}
          disabled={Boolean(state?.annotationMode)}
          onClick={() => void toggleInspectMode()}
          title={state?.inspectMode ? 'Cancel UI inspect mode (Esc)' : 'Inspect UI element and attach runtime context to the agent'}
        >
          <ContextIcon />
        </button>
        <button
          className={state?.annotationMode ? activeIconButtonClasses : iconButtonClasses}
          aria-pressed={Boolean(state?.annotationMode)}
          onClick={() => void toggleAnnotationMode()}
          title={state?.annotationMode ? 'Finish annotation and attach it to the next agent prompt' : 'Freeze the viewport and draw visual instructions for the agent'}
        >
          <PencilIcon />
        </button>
        <Popover
          open={extensionsMenuOpen}
          onOpenChange={(open) => {
            setExtensionsMenuOpen(open)
            if (open && platform?.extensionPopupId) {
              void window.ndDsh.browserPlatform.closeExtensionPopup().catch(() => undefined)
            }
          }}
        >
          <PopoverTrigger asChild>
            <button
              className={platform?.extensionPopupId ? activeIconButtonClasses : iconButtonClasses}
              disabled={Boolean(state?.annotationMode)}
              title="Extensions in the ND built-in browser"
              aria-label="Built-in browser extensions"
            >
              <PuzzleIcon />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={6} className="w-[320px] p-0">
            <div className="border-b border-border-soft px-3 py-2.5">
              <strong className="block text-[11px] font-semibold text-strong">Extensions</strong>
              <span className="text-[9px] text-faint">Runs inside ND's built-in Chromium browser</span>
            </div>
            <div className="max-h-[300px] space-y-1 overflow-auto p-2">
              {(platform?.extensions ?? []).length === 0 ? (
                <div className="rounded-md px-2 py-4 text-center text-[9px] text-faint">
                  No built-in browser extensions installed.
                </div>
              ) : (
                (platform?.extensions ?? []).map((extension) => (
                  <div key={extension.id} className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent/70">
                    <div className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-secondary text-soft">
                      <PuzzleIcon className="size-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <strong className="block truncate text-[10px] font-semibold text-strong">
                        {extension.actionTitle || extension.name}
                      </strong>
                      <span className="block truncate text-[8px] text-faint">
                        {extension.name} · {extension.version} · {extension.status}
                      </span>
                    </div>
                    {extension.enabled && extension.status !== 'error' && extension.actionPopup ? (
                      <button
                        type="button"
                        className="shrink-0 rounded border border-border bg-secondary px-2 py-1 text-[8px] font-semibold text-soft hover:bg-accent"
                        onClick={() => {
                          setExtensionsMenuOpen(false)
                          void runBrowserAction(() => window.ndDsh.browserPlatform.showExtensionPopup(extension.id))
                        }}
                      >
                        Open
                      </button>
                    ) : null}
                    <SettingsSwitch
                      label={`Enable ${extension.name}`}
                      checked={extension.enabled}
                      onCheckedChange={(enabled) => {
                        void runBrowserAction(() =>
                          window.ndDsh.browserPlatform.setExtensionEnabled(extension.id, enabled)
                        )
                      }}
                    />
                  </div>
                ))
              )}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-border-soft px-3 py-2">
              <span className="min-w-0 truncate text-[8px] text-faint">
                {platform?.developerMode ? 'Developer mode on' : ''}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                {platform?.developerMode ? (
                  <button
                    type="button"
                    className="rounded border border-border bg-secondary px-2 py-1 text-[8px] font-semibold text-soft hover:bg-accent"
                    onClick={() => {
                      setExtensionsMenuOpen(false)
                      void runBrowserAction(() => window.ndDsh.browserPlatform.installExtension())
                    }}
                  >
                    Load unpacked
                  </button>
                ) : null}
                {onOpenSettings ? (
                  <button
                    type="button"
                    className="rounded border border-border bg-secondary px-2 py-1 text-[8px] font-semibold text-soft hover:bg-accent"
                    onClick={() => {
                      setExtensionsMenuOpen(false)
                      onOpenSettings()
                    }}
                  >
                    Manage in Settings
                  </button>
                ) : null}
              </div>
            </div>
          </PopoverContent>
        </Popover>
        <button
          className={iconButtonClasses}
          disabled={!state?.url || state.url === 'about:blank' || Boolean(state?.annotationMode)}
          onClick={() => void runBrowserAction(() => window.ndDsh.browser.openExternal(state?.url ?? address))}
          title="Open in system browser"
        >
          <ExternalIcon />
        </button>
        <Popover open={profileMenuOpen} onOpenChange={setProfileMenuOpen}>
          <PopoverTrigger asChild>
            <button
              className={cn(activeIconButtonClasses, 'max-w-[132px]')}
              title={`Browser profile: ${activeProfile?.name ?? 'Default'}`}
              aria-label="Browser profile"
            >
              <BrowserProfileAvatar
                name={activeProfile?.name ?? 'Default'}
                color={activeProfile?.color ?? '#65717b'}
                size={16}
              />
              <span className="max-w-[76px] truncate text-[9px]">{activeProfile?.name ?? 'Default'}</span>
              <ChevronDownIcon className="size-[11px] shrink-0" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={6} className="w-[272px] p-0">
            <div className="border-b border-border-soft px-3 py-2.5">
              <strong className="block text-[11px] font-semibold text-strong">Browser profiles</strong>
              <span className="text-[9px] text-faint">Each profile keeps its own cookies and sign-ins</span>
            </div>
            <div className="max-h-[300px] space-y-0.5 overflow-auto p-2">
              {profiles.length === 0 ? (
                <div className="rounded-md px-2 py-4 text-center text-[9px] text-faint">Profiles are loading…</div>
              ) : profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  aria-pressed={profile.active}
                  onClick={() => switchProfile(profile.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/70',
                    profile.active && 'bg-accent/50',
                  )}
                >
                  <BrowserProfileAvatar name={profile.name} color={profile.color} size={20} />
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-[10px] font-semibold text-strong">{profile.name}</strong>
                    <span className="block text-[8px] text-faint">
                      {profile.tabCount} tab{profile.tabCount === 1 ? '' : 's'}
                      {profile.isDefault ? ' · Default' : ''}
                    </span>
                  </span>
                  {profile.active ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-border-soft px-3 py-2">
              <button
                type="button"
                className="rounded border border-border bg-secondary px-2 py-1 text-[8px] font-semibold text-soft hover:bg-accent"
                onClick={() => { setProfileMenuOpen(false); setProfileDialogOpen(true) }}
              >
                New profile
              </button>
              {onOpenSettings ? (
                <button
                  type="button"
                  className="rounded border border-border bg-secondary px-2 py-1 text-[8px] font-semibold text-soft hover:bg-accent"
                  onClick={() => { setProfileMenuOpen(false); onOpenSettings() }}
                >
                  Manage in Settings
                </button>
              ) : null}
            </div>
          </PopoverContent>
        </Popover>
        {state?.annotationMode ? (
          <BridgePill state="ready" onClick={() => void toggleAnnotationMode()} title="Finish drawing and attach this annotated frame">
            Annotating
          </BridgePill>
        ) : annotation ? (
          <BridgePill state="ready" onClick={() => void clearAnnotation()} title={annotationTitle}>
            Annotation: {annotation.marks.length}
          </BridgePill>
        ) : null}
        {selected ? (
          <BridgePill state="ready" onClick={() => void clearSelection()} title={`${selectedTitle ?? 'Selected UI'} · click to clear`}>
            UI: {selectedName ?? 'element'}
          </BridgePill>
        ) : null}
        {state?.downloads?.some((item) => item.state === 'progressing' || item.state === 'starting') ? (
          <BridgePill state="binding" title="Built-in browser download in progress">
            Downloading
          </BridgePill>
        ) : null}
        {siteToolCount > 0 ? (
          <BridgePill state="ready" title="Structured WebMCP site tools are available on the selected tab">
            Site tools: {siteToolCount}
          </BridgePill>
        ) : null}
        <BridgePill state={state?.agentBrowser ?? 'binding'} title={state?.agentBrowserError}>
          {state?.agentBrowser === 'ready' ? 'Agent linked' : state?.agentBrowser === 'unavailable' ? 'Agent offline' : 'Linking'}
        </BridgePill>
      </div>

      <BrowserProfileDialog
        open={profileDialogOpen}
        mode="create"
        onSubmit={createProfile}
        onClose={() => setProfileDialogOpen(false)}
      />

      {approval ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[10px]">          <strong className="text-strong">Browser approval</strong>
          <span className="min-w-0 flex-1 truncate text-soft" title={`${approval.action} · ${approval.operation} · ${approval.origin ?? approval.targetId}`}>
            {approval.action} · {approval.origin ?? approval.targetId}
          </span>
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 text-soft hover:bg-accent"
            onClick={() => void runBrowserAction(() => window.ndDsh.browserPlatform.resolveApproval(approval.id, false))}
          >
            Deny
          </button>
          <button
            type="button"
            className="rounded border border-border bg-secondary px-2 py-0.5 text-strong hover:bg-accent"
            onClick={() => void runBrowserAction(() => window.ndDsh.browserPlatform.resolveApproval(approval.id, true))}
          >
            Allow
          </button>
        </div>
      ) : null}

      <div className="relative flex-1 min-h-0 min-w-0 overflow-hidden bg-browser" ref={surfaceRef}>
        {showsNewTabPage ? (
          <div className="absolute inset-0 overflow-y-auto">{newTabPage}</div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[10px] text-fainter">
            {state?.loading ? <div className="size-[34px] animate-spin rounded-full border border-border-strong border-t-primary" /> : null}
            <span>{state?.loading ? `Loading ${state.url}` : uiPreview ? 'Browser canvas is desktop-only; controls are simulated in UI preview.' : state?.url === 'about:blank' ? 'Enter a URL to open the ND browser.' : 'ND built-in browser surface'}</span>
          </div>
        )}
      </div>
    </section>
  )
}
