import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { BrowserState, HarnessStatus, UiSourceLocation, UiTarget, WorkspaceState } from '../../../shared/contracts'
import type {
  DesignComponentEntry,
  DesignFreeformDocumentEntry,
  DesignFreeformState,
  DesignProjectState,
  DesignTemplateEntry,
} from '../../../shared/design'
import { DesignWorkspace } from '../design/DesignWorkspace'
import { BrowserPane } from './BrowserPane'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Card } from './ui/card'
import { TooltipProvider } from './ui/tooltip'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable'
import {
  BrowserIcon,
  ChevronRightIcon,
  SparkIcon,
  SidebarToggleIcon,
} from './Icons'
import { LucidePenTool, LucideLayout, LucideCode, LucideLayers, LucidePlus } from 'lucide-react'

interface DesignViewProps {
  active: boolean
  workspace: WorkspaceState | null
  /**
   * Whether the active root was selected by the user. The boot fallback root is
   * a runtime cwd, never a project, so design surfaces never label it as one.
   */
  workspaceSelected: boolean
  browser: BrowserState | null
  harness: HarnessStatus | null
  onWorkspaceChanged(workspace: WorkspaceState): void
  onAskAgent(prompt: string): void
  onAskAgentInPlace(prompt: string): void
  onError(message: string): void
  /** Transient user feedback (toasts) for actions without a dedicated surface. */
  onNotify?(message: string): void
}

type DesignSurface = 'live' | 'freeform' | 'templates' | 'library' | 'canvas'

export function DesignView({ active, workspace, workspaceSelected, browser, harness, onWorkspaceChanged, onAskAgent, onAskAgentInPlace, onError, onNotify }: DesignViewProps) {
  const [project, setProject] = useState<DesignProjectState | null>(null)
  const [freeform, setFreeform] = useState<DesignFreeformState | null>(null)
  const [surface, setSurface] = useState<DesignSurface>('live')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false)

  const updateFreeform = useCallback((next: DesignFreeformState): void => {
    setFreeform(next)
  }, [])

  useEffect(() => {
    let mounted = true
    if (!active) return undefined

    const updateState = (next: DesignProjectState): void => {
      if (mounted) setProject(next)
    }
    const refreshProject = (): void => {
      void window.ndDshDesign.refresh().then(updateState).catch(() => undefined)
    }

    window.ndDshDesign.state()
      .then(updateState)
      .catch((cause: unknown) => { if (mounted) onError(errorMessage(cause)) })

    window.ndDshDesign.designState()
      .then((next) => { if (mounted) updateFreeform(next) })
      .catch((cause: unknown) => { if (mounted) onError(errorMessage(cause)) })

    const unsubscribe = window.ndDshDesign.onDesignChanged((event) => {
      if (!mounted) return
      updateFreeform(event.state)
      if (event.reason === 'open' || event.reason === 'close') refreshProject()
    })

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [active, onError, updateFreeform])

  const selected = browser?.selectedTarget
  const source = selected?.source

  const chooseWorkspace = async (): Promise<void> => {
    try {
      onWorkspaceChanged(await window.ndDsh.workspace.pick())
    } catch (cause: unknown) {
      onError(errorMessage(cause))
    }
  }

  const previewTemplate = async (template: DesignTemplateEntry): Promise<void> => {
    setBusy(`template:${template.path}`)
    try {
      await window.ndDshDesign.previewHtml(template.path)
      setSurface('live')
    } catch (cause: unknown) {
      onError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const useTemplate = (template: DesignTemplateEntry): void => {
    onAskAgent(`Use template ${template.name} (${template.path}) as reference for the active project. Keep the layout and copy structure, map it to our design tokens and components, edit real source files, and verify in the live app.`)
  }

  const startDevPreview = async (): Promise<void> => {
    setBusy('dev-preview')
    try {
      await window.ndDshDesign.startDevPreview()
    } catch (cause: unknown) {
      onError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const stopDevPreview = async (): Promise<void> => {
    setBusy('dev-preview')
    try {
      await window.ndDshDesign.stopPreview()
    } catch (cause: unknown) {
      onError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const createFreeform = async (): Promise<void> => {
    setBusy('freeform:create')
    try {
      const path = nextFreeformPath(project)
      const sync = await window.ndDshDesign.designCreate(path)
      updateFreeform(sync.state)
      setProject(await window.ndDshDesign.refresh())
      setSurface('freeform')
    } catch (cause: unknown) {
      onError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const openFreeform = async (path: string): Promise<void> => {
    setBusy(`freeform:${path}`)
    try {
      const sync = await window.ndDshDesign.designOpen(path)
      updateFreeform(sync.state)
      setSurface('freeform')
    } catch (cause: unknown) {
      onError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const submitPrompt = (event: FormEvent): void => {
    event.preventDefault()
    const text = prompt.trim()
    if (!text) return
    const context = selected
      ? `\n\nSelected UI: ${selected.react?.component ?? selected.tagName}${source ? ` at ${source.file}:${source.line}` : ''}.`
      : designSurfaceContext(surface, project, freeform)
    onAskAgent(`${text}${context}`)
    setPrompt('')
  }

  const useComponent = (component: DesignComponentEntry): void => {
    onAskAgent(`Use the existing shadcn component ${component.name} from ${component.path} in the current UI. Preserve the project's component conventions, tokens, variants, accessibility, and responsive behavior. Edit the real source files and verify the result in the live app.`)
  }

  return (
    <TooltipProvider>
      <div className="flex h-full w-full min-h-0 min-w-0 flex-col bg-surface-0">
        {/* Top bar: Design surface switcher */}
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-border-soft bg-surface-1/80 px-3 backdrop-blur">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-[11px] font-black tracking-wider text-primary">
                ND
              </span>
              <span className="text-xs font-bold text-strong truncate max-w-[160px]">
                {workspaceSelected ? (workspace?.projectName ?? workspace?.name ?? 'Design Mode') : 'No project'}
              </span>
            </div>

            <div className="h-4 w-px bg-border-soft" />

            {/* Surface navigation tabs */}
            <nav className="flex items-center gap-1">
              <SurfaceTab
                active={surface === 'live'}
                icon={<BrowserIcon className="size-3.5" />}
                label="Live App"
                onClick={() => setSurface('live')}
              />
              <SurfaceTab
                active={surface === 'freeform'}
                icon={<LucidePenTool className="size-3.5" />}
                label="ND Pencil"
                badge={freeform?.documentPath ? (freeform.dirty ? '●' : 'ready') : (project?.freeform.documents.length ? String(project.freeform.documents.length) : undefined)}
                badgeVariant={freeform?.dirty ? 'warning' : 'default'}
                onClick={() => setSurface('freeform')}
              />
              <SurfaceTab
                active={surface === 'templates'}
                icon={<LucideLayout className="size-3.5" />}
                label="Templates"
                badge={project?.templates.length ? String(project.templates.length) : undefined}
                onClick={() => setSurface('templates')}
              />
              <SurfaceTab
                active={surface === 'library'}
                icon={<LucideLayers className="size-3.5" />}
                label="Components"
                badge={project?.shadcn.components.length ? String(project.shadcn.components.length) : undefined}
                onClick={() => setSurface('library')}
              />
              <SurfaceTab
                active={surface === 'canvas'}
                icon={<LucideCode className="size-3.5" />}
                label="Code Canvas"
                onClick={() => setSurface('canvas')}
              />
            </nav>
          </div>

          {!(surface === 'freeform' && freeform?.documentPath) ? (
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon-xs"
                title={sidebarCollapsed ? 'Expand left panel' : 'Collapse left panel'}
                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              >
                <SidebarToggleIcon collapsed={sidebarCollapsed} className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                title={inspectorCollapsed ? 'Expand right panel' : 'Collapse right panel'}
                onClick={() => setInspectorCollapsed(!inspectorCollapsed)}
              >
                <SidebarToggleIcon collapsed={!inspectorCollapsed} className="size-3.5" />
              </Button>
            </div>
          ) : null}
        </header>

        {surface === 'freeform' && freeform?.documentPath && workspace ? (
          <DesignWorkspace
            key={freeform.documentPath}
            active={active}
            state={freeform}
            onState={updateFreeform}
            onAgentPrompt={onAskAgentInPlace}
            onClose={() => {
              setSurface('live')
              void window.ndDshDesign.refresh().then(setProject).catch(() => undefined)
            }}
            onError={onError}
            {...(onNotify ? { onNotify } : {})}
          />
        ) : (
        /* Resizable 3-pane body */
        <div className="flex flex-1 min-h-0 min-w-0">
          <ResizablePanelGroup direction={'horizontal' as const} className="h-full w-full">
            {/* Left Sidebar Panel */}
            {!sidebarCollapsed ? (
              <ResizablePanel defaultSize={248} minSize={208} maxSize={420} groupResizeBehavior="preserve-pixel-size">
                <aside aria-label="Design workspace" className="flex h-full w-full flex-col overflow-y-auto border-r border-border-soft bg-sidebar">
                  <div className="flex flex-col gap-1 border-b border-border-soft p-3">
                    <small className="text-[10px] font-bold tracking-widest text-primary uppercase">Workspace</small>
                    <strong className="truncate text-sm font-semibold text-strong">
                      {workspaceSelected ? (workspace?.projectName ?? workspace?.name ?? 'No project') : 'No project'}
                    </strong>
                    <span className="truncate text-xs text-faint">
                      {project ? projectLabel(project) : workspaceSelected ? (workspace?.companyName ?? 'Standalone workspace') : 'Open a folder or select a project'}
                    </span>
                  </div>

                  {/* Context actions */}
                  <div className="flex flex-col gap-1 border-b border-border-soft p-3">
                    <header className="mb-1 text-[10px] font-bold tracking-widest text-faint uppercase">AI Design Actions</header>
                    <Button
                      variant="outline"
                      size="xs"
                      className="justify-start gap-1.5 text-xs"
                      onClick={() => {
                        if (selected) {
                          onAskAgent(`Improve the selected UI component ${selected.react?.component ?? selected.tagName}. Make it polished, accessible, responsive, and aligned with project tokens.`)
                        } else {
                          onAskAgent(`Review the active UI in Design Mode. Recommend visual, spacing, hierarchy, and token refinements.`)
                        }
                      }}
                    >
                      <SparkIcon className="size-3 text-primary" />
                      {selected ? `Improve ${selected.react?.component ?? selected.tagName}` : 'Improve active UI'}
                    </Button>

                    <Button
                      variant="ghost"
                      size="xs"
                      className="justify-start text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => onAskAgent(`Make the active page layout fully responsive across desktop, tablet, and mobile breakpoints.`)}
                    >
                      <ChevronRightIcon className="size-3 text-faint" />
                      Make responsive
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="justify-start text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => onAskAgent(`Audit accessibility for the active screen. Improve color contrast, focus rings, ARIA roles, and keyboard navigation.`)}
                    >
                      <ChevronRightIcon className="size-3 text-faint" />
                      Fix accessibility
                    </Button>
                  </div>

                  {/* Project Context & Preview Server control */}
                  {project ? (
                    <div className="flex flex-col gap-2 border-b border-border-soft p-3 text-xs">
                      <header className="text-[10px] font-bold tracking-widest text-faint uppercase">Project Info</header>
                      <div className="flex flex-col gap-1 text-muted-foreground">
                        <div className="flex justify-between">
                          <span>Framework:</span>
                          <span className="font-medium text-strong">{project.frameworks.join(', ') || 'Custom HTML/JS'}</span>
                        </div>
                        {project.preview?.url ? (
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-emerald-500 font-medium">● Dev Server</span>
                            <Button
                              variant="ghost"
                              size="xs"
                              className="h-5 px-1.5 text-[10px] text-destructive hover:bg-destructive/10"
                              disabled={busy === 'dev-preview'}
                              onClick={stopDevPreview}
                            >
                              Stop
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-faint">Preview offline</span>
                            <Button
                              variant="outline"
                              size="xs"
                              className="h-5 px-1.5 text-[10px]"
                              disabled={busy === 'dev-preview'}
                              onClick={startDevPreview}
                            >
                              Start preview
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null}

                  {/* AI Prompt Input at bottom of sidebar */}
                  <div className="mt-auto flex flex-col border-t border-border-soft p-3">
                    <form onSubmit={submitPrompt} className="flex flex-col gap-2">
                      <textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                            e.preventDefault()
                            submitPrompt(e)
                          }
                        }}
                        placeholder={selected ? `Ask about ${selected.react?.component ?? selected.tagName}…` : 'Ask agent to design or edit… (Ctrl+Enter)'}
                        className="w-full min-h-[70px] resize-none rounded-md border border-border-soft bg-surface-2 p-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none"
                      />
                      <Button type="submit" size="xs" className="w-full gap-1.5 font-medium" disabled={!prompt.trim()}>
                        <SparkIcon className="size-3" />
                        Send to Agent
                      </Button>
                    </form>
                  </div>
                </aside>
              </ResizablePanel>
            ) : null}

            {!sidebarCollapsed ? <ResizableHandle withHandle /> : null}

            {/* Main Surface Panel */}
            <ResizablePanel minSize="40%" className="relative flex min-h-0 min-w-0 flex-col bg-surface-0">
              {workspace?.binding === 'missing' || !workspace ? (
                <WorkspaceEmpty workspace={workspace} onChoose={chooseWorkspace} />
              ) : (
                <>
                  {surface === 'live' && (
                    <BrowserPane
                      active={active && surface === 'live'}
                      state={browser}
                      onSnapshot={(result) => {
                        navigator.clipboard.writeText(result)
                          .then(() => onNotify?.('Live-app snapshot copied to the clipboard.'))
                          .catch(() => onNotify?.('Live-app snapshot captured, but copying to the clipboard failed.'))
                      }}
                      onError={onError}
                    />
                  )}
                  {surface === 'freeform' && (
                    <FreeformSurface
                      project={project}
                      state={freeform}
                      busy={busy}
                      onOpen={openFreeform}
                      onCreate={createFreeform}
                    />
                  )}
                  {surface === 'templates' && (
                    <TemplateSurface project={project} busy={busy} onPreview={previewTemplate} onUse={useTemplate} />
                  )}
                  {surface === 'library' && (
                    <ShadcnSurface project={project} onUse={useComponent} />
                  )}
                  {surface === 'canvas' && (
                    <CodeCanvas project={project} onAskAgent={onAskAgent} />
                  )}
                </>
              )}
            </ResizablePanel>

            {!inspectorCollapsed ? <ResizableHandle withHandle /> : null}

            {/* Right Inspector Panel */}
            {!inspectorCollapsed ? (
              <ResizablePanel defaultSize={268} minSize={228} maxSize={480} groupResizeBehavior="preserve-pixel-size">
                <aside aria-label="Design inspector" className="flex h-full w-full flex-col overflow-y-auto border-l border-border-soft bg-sidebar">
                  <header className="flex h-9 shrink-0 items-center justify-between border-b border-border-soft px-3">
                    <span className="text-[10px] font-bold tracking-widest text-faint uppercase">
                      {inspectorTitle(surface, selected)}
                    </span>
                  </header>

                  <div className="flex flex-col flex-1 overflow-y-auto">
                    {selected ? (
                      <DomInspector selected={selected} source={source} onAskAgent={onAskAgent} />
                    ) : (
                      <SurfaceOverview surface={surface} project={project} freeform={freeform} />
                    )}
                  </div>
                </aside>
              </ResizablePanel>
            ) : null}
          </ResizablePanelGroup>
        </div>
        )}
      </div>
    </TooltipProvider>
  )
}

function SurfaceTab({
  active,
  icon,
  label,
  badge,
  badgeVariant = 'default',
  onClick,
}: {
  active: boolean
  icon: ReactNode
  label: string
  badge?: string | undefined
  badgeVariant?: 'default' | 'warning' | undefined
  onClick(): void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-primary/10 text-primary font-semibold'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
      )}
    >
      {icon}
      <span>{label}</span>
      {badge ? (
        <Badge
          variant={badgeVariant === 'warning' ? 'destructive' : 'secondary'}
          className={cn(
            'ml-0.5 h-4 px-1 text-[10px] font-semibold',
            badgeVariant === 'warning' && 'bg-amber-500/20 text-amber-500 border-amber-500/30'
          )}
        >
          {badge}
        </Badge>
      ) : null}
    </button>
  )
}

function FreeformSurface({
  project,
  state,
  busy,
  onOpen,
  onCreate,
}: {
  project: DesignProjectState | null
  state: DesignFreeformState | null
  busy: string | null
  onOpen(path: string): Promise<void>
  onCreate(): Promise<void>
}) {
  if (state?.documentPath) return null
  const docs = project?.freeform.documents ?? []

  return (
    <div className="h-full w-full min-h-0 min-w-0 overflow-y-auto bg-surface-0 p-6">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <header className="flex items-start justify-between gap-4 border-b border-border-soft pb-4">
          <div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="border-primary/30 text-primary">
                ND Pencil Native Canvas
              </Badge>
            </div>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-strong">Freeform Vector & UI Design</h2>
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">
              Create and edit vector concepts using ND Pencil. Documents (`.op`) stay in your project directory as design intent.
            </p>
          </div>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={busy === 'freeform:create'}
            onClick={() => onCreate()}
          >
            <LucidePlus className="size-4" />
            New ND Pencil Canvas
          </Button>
        </header>

        {docs.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
            {docs.map((doc) => (
              <Card
                key={doc.path}
                className="group relative flex flex-col justify-between border-border-soft bg-surface-1 p-4 transition-all hover:border-primary/40 hover:shadow-sm cursor-pointer"
                onClick={() => onOpen(doc.path)}
              >
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <LucidePenTool className="size-4" />
                    </span>
                  </div>
                  <strong className="truncate text-sm font-bold text-strong group-hover:text-primary">
                    {doc.name}
                  </strong>
                  <span className="truncate text-xs text-faint">{doc.path}</span>
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-border-soft/60 pt-2.5">
                  <span className="text-[10px] text-muted-foreground">.op design artifact</span>
                  <Button size="xs" variant="ghost" className="h-6 gap-1 text-xs text-primary">
                    Open <ChevronRightIcon className="size-3" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-soft p-12 text-center">
            <span className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary mb-3">
              <LucidePenTool className="size-6" />
            </span>
            <h3 className="text-base font-semibold text-strong">No ND Pencil documents yet</h3>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Start a new freeform canvas to sketch components, layout ideas, or high-fidelity UI designs.
            </p>
            <Button size="sm" className="mt-4 gap-1.5" disabled={busy === 'freeform:create'} onClick={() => onCreate()}>
              <LucidePlus className="size-4" />
              Create First Design
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function DomInspector({
  selected,
  source,
  onAskAgent,
}: {
  selected: UiTarget
  source?: UiSourceLocation | undefined
  onAskAgent(prompt: string): void
}) {
  return (
    <div className="flex flex-col gap-4 p-3.5 text-xs">
      <div className="flex flex-col gap-2 rounded-lg border border-border-soft bg-surface-1 p-3">
        <header className="text-[10px] font-bold tracking-widest text-primary uppercase">Selected Element</header>
        <Property label="Tag" value={`<${selected.tagName.toLowerCase()}>`} />
        {selected.react?.component ? <Property label="React Component" value={selected.react.component} /> : null}
        {source ? <Property label="Source" value={`${source.file}:${source.line}`} /> : null}
      </div>

      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        onClick={() => onAskAgent(`Refactor component ${selected.react?.component ?? selected.tagName} at ${source?.file ?? 'active view'} to match project design system.`)}
      >
        <SparkIcon className="size-3 text-primary" />
        Edit Element Source
      </Button>
    </div>
  )
}

function SurfaceOverview({
  surface,
  project,
  freeform,
}: {
  surface: DesignSurface
  project: DesignProjectState | null
  freeform: DesignFreeformState | null
}) {
  return (
    <div className="flex flex-col gap-3 p-3.5 text-xs text-muted-foreground">
      <header className="text-[10px] font-bold tracking-widest text-faint uppercase">Surface Context</header>
      <div className="rounded-lg border border-border-soft bg-surface-1 p-3 flex flex-col gap-2">
        <strong className="text-strong text-xs">{surfaceLabel(surface)}</strong>
        <p className="text-[11px] leading-relaxed">
          {inspectorSubtitle(surface, freeform)}
        </p>
      </div>

      {project ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between">
            <span>Shadcn components:</span>
            <span className="font-semibold text-strong">{project.shadcn.components.length}</span>
          </div>
          <div className="flex justify-between">
            <span>HTML Templates:</span>
            <span className="font-semibold text-strong">{project.templates.length}</span>
          </div>
          <div className="flex justify-between">
            <span>Freeform Docs:</span>
            <span className="font-semibold text-strong">{project.freeform.documents.length}</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function WorkspaceEmpty({ workspace, onChoose }: { workspace: WorkspaceState | null; onChoose(): void }) {
  return (
    <div className="mx-auto my-auto flex w-[min(520px,calc(100%-48px))] flex-col items-center text-center">
      <div className="grid size-[54px] place-items-center rounded-[14px] border border-primary/30 bg-primary/10 text-lg font-black tracking-[0.08em] text-primary">
        ND
      </div>
      <h2 className="mb-[5px] mt-3.5 text-[22px] font-bold text-strong">
        {workspace?.binding === 'missing' ? 'Project workspace unavailable' : 'Link this project to a workspace'}
      </h2>
      <p className="mb-3.5 max-w-[460px] text-sm/[1.55] text-muted-foreground">
        {workspace?.warning ?? 'Design Mode always follows the active project workspace. Select the project folder to continue.'}
      </p>
      <Button onClick={onChoose}>Select workspace</Button>
    </div>
  )
}

function TemplateSurface({
  project,
  busy,
  onPreview,
  onUse,
}: {
  project: DesignProjectState | null
  busy: string | null
  onPreview(template: DesignTemplateEntry): void
  onUse(template: DesignTemplateEntry): void
}) {
  const templates = project?.templates ?? []
  return (
    <div className="h-full w-full min-h-0 min-w-0 overflow-auto bg-surface-0 p-7">
      <header className="mx-auto mb-[22px] flex max-w-[980px] items-start justify-between gap-6">
        <div className="min-w-0">
          <small className="mb-[7px] block text-[11px] font-extrabold tracking-[0.12em] text-primary">HTML & TEMPLATE SOURCES</small>
          <h2 className="m-0 text-[26px] font-bold tracking-tight text-strong">Use existing markup as the design.</h2>
          <p className="mt-[7px] max-w-[660px] text-sm/[1.6] text-muted-foreground">Plain HTML runs in ND's loopback preview. Server-side templates stay source-first and are handed to the agent/project runtime.</p>
        </div>
        <Badge variant="secondary" className="shrink-0">{templates.length} found</Badge>
      </header>
      {templates.length ? (
        <div className="mx-auto grid max-w-[980px] grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
          {templates.map((template) => (
            <SourceCard
              key={template.path}
              icon={template.kind === 'html' ? 'HTML' : 'TPL'}
              name={template.name}
              path={template.path}
              note={template.previewable ? 'Static preview + inspect' : `${template.kind} · project runtime`}
              actionLabel={busy === `template:${template.path}` ? 'Opening…' : 'Preview'}
              secondaryLabel="Use with agent"
              onAction={() => onPreview(template)}
              onSecondaryAction={() => onUse(template)}
            />
          ))}
        </div>
      ) : (
        <SurfaceEmpty title="No template or HTML sources found" text="Add .html or project template files under the workspace to use them as design sources." />
      )}
    </div>
  )
}

function ShadcnSurface({
  project,
  onUse,
}: {
  project: DesignProjectState | null
  onUse(component: DesignComponentEntry): void
}) {
  const components = project?.shadcn.components ?? []
  return (
    <div className="h-full w-full min-h-0 min-w-0 overflow-auto bg-surface-0 p-7">
      <header className="mx-auto mb-[22px] flex max-w-[980px] items-start justify-between gap-6">
        <div className="min-w-0">
          <small className="mb-[7px] block text-[11px] font-extrabold tracking-[0.12em] text-primary">SHADCN / COMPONENT LIBRARY</small>
          <h2 className="m-0 text-[26px] font-bold tracking-tight text-strong">Reuse verified project UI components.</h2>
          <p className="mt-[7px] max-w-[660px] text-sm/[1.6] text-muted-foreground">ND indexes installed shadcn components directly from your workspace so design changes reuse existing design tokens instead of duplicating UI.</p>
        </div>
        <Badge variant="secondary" className="shrink-0">{components.length} components</Badge>
      </header>
      {components.length ? (
        <div className="mx-auto grid max-w-[980px] grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
          {components.map((component) => (
            <SourceCard
              key={component.path}
              icon="UI"
              name={component.name}
              path={component.path}
              note="Installed UI component"
              actionLabel="Use in design"
              onAction={() => onUse(component)}
            />
          ))}
        </div>
      ) : (
        <SurfaceEmpty title="No installed shadcn components detected" text="Install shadcn/ui components in your project folder to reuse them here." />
      )}
    </div>
  )
}

function CodeCanvas({ project, onAskAgent }: { project: DesignProjectState | null; onAskAgent(prompt: string): void }) {
  return (
    <div className="h-full w-full min-h-0 min-w-0 overflow-auto bg-surface-0 p-7">
      <div className="mx-auto max-w-[980px]">
        <small className="mb-[7px] block text-[11px] font-extrabold tracking-[0.12em] text-primary">CODE CANVAS</small>
        <h2 className="m-0 text-[26px] font-bold tracking-tight text-strong">Direct source-first design.</h2>
        <p className="mt-[7px] max-w-[660px] text-sm/[1.6] text-muted-foreground">Edit real code files directly and verify instantly in the live runtime.</p>
        <div className="mt-6 flex flex-wrap gap-2">
          {project?.frameworks.map((f) => (
            <Badge key={f} variant="outline" className="border-primary/20 bg-primary/5 text-primary">
              {f}
            </Badge>
          ))}
        </div>
        <Button
          size="sm"
          className="mt-6 gap-1.5"
          onClick={() => onAskAgent(`Open the primary entry point file for this project and start editing the UI.`)}
        >
          <SparkIcon className="size-4" />
          Edit Code with Agent
        </Button>
      </div>
    </div>
  )
}

function SourceCard({
  icon,
  name,
  path,
  note,
  actionLabel,
  secondaryLabel,
  onAction,
  onSecondaryAction,
}: {
  icon: string
  name: string
  path: string
  note: string
  actionLabel: string
  secondaryLabel?: string
  onAction(): void
  onSecondaryAction?(): void
}) {
  return (
    <Card className="flex flex-col justify-between border-border-soft bg-surface-1 p-3.5 transition-all hover:border-primary/30">
      <div>
        <div className="flex items-center justify-between">
          <Badge variant="outline" className="text-[10px] text-primary">{icon}</Badge>
        </div>
        <strong className="mt-2 block truncate text-sm font-semibold text-strong">{name}</strong>
        <span className="block truncate text-xs text-faint">{path}</span>
        <p className="mt-1 text-[11px] text-muted-foreground">{note}</p>
      </div>
      <div className="mt-3 flex gap-1.5">
        <Button size="xs" variant="default" className="flex-1 text-xs" onClick={onAction}>{actionLabel}</Button>
        {secondaryLabel && onSecondaryAction ? (
          <Button size="xs" variant="outline" className="text-xs" onClick={onSecondaryAction}>{secondaryLabel}</Button>
        ) : null}
      </div>
    </Card>
  )
}

function SurfaceEmpty({
  title,
  text,
  actionLabel,
  actionDisabled,
  onAction,
}: {
  title: string
  text: string
  actionLabel?: string
  actionDisabled?: boolean
  onAction?(): void
}) {
  return (
    <div className="mx-auto my-auto flex max-w-[420px] flex-col items-center text-center p-6">
      <strong className="text-base font-bold text-strong">{title}</strong>
      <p className="mt-1 text-xs text-muted-foreground">{text}</p>
      {actionLabel && onAction && (
        <Button size="sm" className="mt-4" disabled={actionDisabled} onClick={onAction}>{actionLabel}</Button>
      )}
    </div>
  )
}

function Property({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold text-strong truncate max-w-[140px] text-right">{value}</span>
    </div>
  )
}

function nextFreeformPath(project: DesignProjectState | null): string {
  const paths = new Set(project?.freeform.documents.map((doc) => doc.path) ?? [])
  if (!paths.has('.nd/design/home.op')) return '.nd/design/home.op'
  let index = 2
  while (paths.has(`.nd/design/design-${index}.op`)) index += 1
  return `.nd/design/design-${index}.op`
}

function projectLabel(project: DesignProjectState): string {
  if (!project.frameworks.length) return 'Generic HTML/JS project'
  return project.frameworks.join(' · ')
}

function surfaceLabel(surface: DesignSurface): string {
  if (surface === 'templates') return 'Template Source'
  if (surface === 'library') return 'Component Library'
  if (surface === 'canvas') return 'Code Canvas'
  if (surface === 'freeform') return 'ND Pencil Canvas'
  return 'Live Application'
}

function inspectorTitle(surface: DesignSurface, selected: UiTarget | undefined): string {
  if (selected) return 'Selected Element'
  if (surface === 'freeform') return 'ND Pencil Canvas'
  return 'Inspector'
}

function inspectorSubtitle(surface: DesignSurface, freeform: DesignFreeformState | null): string {
  if (surface === 'freeform') return freeform?.documentPath ?? 'Open or create an ND Pencil design'
  return 'Source of truth: active workspace'
}

function designSurfaceContext(surface: DesignSurface, project: DesignProjectState | null, freeform: DesignFreeformState | null): string {
  if (surface === 'templates') return '\n\nDesign source: the active workspace HTML/template library. Work from existing templates and edit real source files.'
  if (surface === 'library') return '\n\nDesign source: the active project shadcn/component library. Reuse installed components rather than recreating them visually.'
  if (surface === 'canvas') return `\n\nDesign source: code-first canvas. Detect the project stack (${project?.frameworks.join(', ') || 'currently unknown'}) and create/edit real production source; make the running app the canvas.`
  if (surface === 'freeform') return `\n\nDesign source: ND Pencil Freeform.${freeform?.documentPath ? ` Active .op document: ${freeform.documentPath}.` : ''} Treat .op as exploratory design intent unless I explicitly ask to build it into production source.`
  return '\n\nDesign source: the live running application. Edit real source and verify the result in the runtime.'
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
