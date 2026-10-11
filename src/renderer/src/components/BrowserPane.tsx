import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import type { BrowserPlatformState } from '../../../shared/browser-platform'
import type { BrowserState } from '../../../shared/contracts'
import { ArrowLeftIcon, ArrowRightIcon, CameraIcon, ContextIcon, ExternalIcon, PencilIcon, PuzzleIcon, ReloadIcon } from './Icons'
import { BridgePill } from './bridge-pill'
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

export function BrowserPane({ active, state, onSnapshot, onError, onOpenSettings }: BrowserPaneProps) {
  const uiPreview = window.ndDshRuntimeMode === 'ui-preview'
  const surfaceRef = useRef<HTMLDivElement>(null)
  const addressFocused = useRef(false)
  const [address, setAddress] = useState(state?.url ?? 'about:blank')
  const [platform, setPlatform] = useState<BrowserPlatformState | null>(null)
  const [siteToolCount, setSiteToolCount] = useState(0)
  const [extensionsMenuOpen, setExtensionsMenuOpen] = useState(false)

  const builtinTabs = state?.tabs ?? []
  const activeTabId = state?.activeTabId
  const selectedTargetId = platform?.selection.targetId
    ?? (platform?.selection.mode === 'auto' ? 'auto' : 'builtin')
  const targetForTabs = selectedTargetId === 'auto' ? 'builtin' : selectedTargetId
  const targetTabs = useMemo(
    () => platform?.tabs.filter((tab) => tab.targetId === targetForTabs) ?? [],
    [platform?.tabs, targetForTabs],
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

  const selectTargetTab = (tabId: string): void => {
    if (!targetForTabs || !tabId) return
    void runBrowserAction(async () => {
      await window.ndDsh.browserPlatform.select({ mode: 'tab', targetId: targetForTabs, tabId })
      if (targetForTabs === 'builtin') await window.ndDsh.browserPlatform.activateTab('builtin', tabId)
    })
  }

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

      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border-soft bg-secondary px-[7px] py-[3px]" role="tablist" aria-label="Built-in browser tabs">
        {builtinTabs.map((tab, index) => {
          const tabActive = tab.id === activeTabId
          const label = tab.title && tab.title !== 'Browser'
            ? tab.title
            : tab.url === 'about:blank'
              ? `Tab ${index + 1}`
              : tab.url.replace(/^https?:\/\//, '').split(/[/?]/)[0] || `Tab ${index + 1}`
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tabActive}
              className={cn(
                'group flex max-w-[180px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-[5px] px-2 py-[3px] text-[9px]',
                tabActive ? 'bg-surface-0 text-strong' : 'text-soft hover:bg-accent/60',
              )}
              title={tab.url}
              onClick={() => switchTab(tab.id)}
            >
              <span className="truncate">{label}</span>
              <button
                type="button"
                aria-label={`Close ${label}`}
                className={cn(
                  'shrink-0 rounded px-1 text-[10px] leading-none text-faint hover:bg-border-soft hover:text-foreground',
                  tabActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
                onClick={(event) => { event.stopPropagation(); closeTab(tab.id) }}
              >
                ×
              </button>
            </div>
          )
        })}
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-[2px] text-[11px] leading-none text-faint transition-colors hover:bg-accent hover:text-foreground"
          title="New built-in browser tab"
          onClick={createTab}
        >
          +
        </button>
      </div>

      {approval ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[10px]">
          <strong className="text-strong">Browser approval</strong>
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
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[10px] text-fainter">
          {state?.loading ? <div className="size-[34px] animate-spin rounded-full border border-border-strong border-t-primary" /> : null}
          <span>{state?.loading ? `Loading ${state.url}` : uiPreview ? 'Browser canvas is desktop-only; controls are simulated in UI preview.' : state?.url === 'about:blank' ? 'Enter a URL to open the ND browser.' : 'ND built-in browser surface'}</span>
        </div>
      </div>
    </section>
  )
}
