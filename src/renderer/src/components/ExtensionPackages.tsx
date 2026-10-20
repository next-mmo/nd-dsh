import { normalizeExtensionRuntimePolicy } from '../../../shared/extension-runtime-policy'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Braces, Check, ChevronLeft, ChevronRight, Download, ExternalLink, Eye, FolderOpen, FolderPlus, Gamepad2, HardDrive, Image, Languages, Layers, Link2, ListChecks, MonitorPlay, Package, PanelsTopLeft, Pencil, Plus, Power, Puzzle, RefreshCw, Repeat, Search, Settings2, ShieldCheck, Shuffle, SkipBack, SkipForward, Sparkles, SquareTerminal, Trash2, Undo2, Upload, Users, Workflow, Globe } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../lib/utils'
import type { NdContext } from '../../../shared/nd-context'
import { contextKey } from '../../../shared/nd-context'
import type {
  NdAvailablePackageView,
  NdExtensionsStateView,
  NdInstalledPackageView,
  NdViewData,
  NdViewRow,
} from '../../../shared/nd-invocations'
import type { WallpaperCollection, WallpaperCollectionEntryKind, WallpaperLink } from '../../../shared/wallpaper-links'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { describeContextForUi, optionIdForContext, type ContextOption } from '../lib/nd-context-model'
import type { OrganizationSnapshot } from '../../../shared/organization'
import { SurfaceErrorBoundary } from './surface-error-boundary'
import { admitKeepAliveView, dockKeepAliveView, extensionViewKey, lookupKeepAliveView, useExtensionKeepAlive } from './extension-view-keepalive'

const NdTranslateView = lazy(() => import('./NdTranslateView'))
const ExtensionGuideDialog = lazy(() => import('./ExtensionGuideDialog'))

type ExtensionViewTarget = { extensionId: string; viewId: string; context: NdContext }

/** Recheck authorization and cancel a route when its dialog was closed or replaced. */
export async function openExtensionProviderTab(
  target: ExtensionViewTarget,
  tabId: string,
  isCurrent: () => boolean,
  onOpenBrowser: (tabId: string) => Promise<void>,
  onClose: () => void,
): Promise<void> {
  const assertCurrent = (): void => {
    if (!isCurrent()) throw new Error('The translation view was closed. Open it again to continue.')
  }
  assertCurrent()
  const authorized = await window.ndDsh.ndExtensions.loadView(target.extensionId, target.viewId, target.context)
  assertCurrent()
  if (authorized.extensionId !== target.extensionId || authorized.viewId !== target.viewId
    || contextKey(authorized.context) !== contextKey(target.context)) {
    throw new Error('The translation view is no longer available in this context.')
  }
  await onOpenBrowser(tabId)
  assertCurrent()
  onClose()
}

const EXTENSION_ACCENTS: Record<string, { icon: LucideIcon; tileClassName: string }> = {
  'nd.daily-essentials': { icon: Sparkles, tileClassName: 'border-amber-500/25 bg-amber-500/15 text-amber-500' },
  'nd.wallpaper-manager': { icon: Image, tileClassName: 'border-violet-500/25 bg-violet-500/15 text-violet-500' },
  'nd.project-workflow': { icon: ListChecks, tileClassName: 'border-sky-500/25 bg-sky-500/15 text-sky-500' },
  'nd.translate': { icon: Languages, tileClassName: 'border-emerald-500/25 bg-emerald-500/15 text-emerald-500' },
  'nd.quit-process': { icon: Power, tileClassName: 'border-rose-500/25 bg-rose-500/15 text-rose-500' },
  'nd.tic-tac-toe': { icon: Gamepad2, tileClassName: 'border-teal-500/25 bg-teal-500/15 text-teal-500' },
  'nd.account-mgt': { icon: Users, tileClassName: 'border-blue-500/25 bg-blue-500/15 text-blue-500' },
  'nd.wizard-chess-3d': { icon: Gamepad2, tileClassName: 'border-amber-500/25 bg-amber-500/15 text-amber-500' },
  'nd.mini-browser': { icon: Globe, tileClassName: 'border-red-500/25 bg-red-500/15 text-red-500' },
  'nd.pay-guard': { icon: ShieldCheck, tileClassName: 'border-indigo-500/25 bg-indigo-500/15 text-indigo-500' },
  'nd.disk-cleaner': { icon: HardDrive, tileClassName: 'border-cyan-500/25 bg-cyan-500/15 text-cyan-500' },
  'nd.api-studio': { icon: Braces, tileClassName: 'border-fuchsia-500/25 bg-fuchsia-500/15 text-fuchsia-500' },
  'nd.computer-use': { icon: MonitorPlay, tileClassName: 'border-lime-500/25 bg-lime-500/15 text-lime-500' },
}

function ExtensionIconTile({ id, large = false }: { id: string; large?: boolean }): React.ReactNode {
  const accent = EXTENSION_ACCENTS[id]
  const Icon = accent?.icon ?? Package
  return (
    <span className={cn(
      'grid shrink-0 place-items-center rounded-2xl border border-border-soft bg-surface-1 text-primary',
      large ? 'size-12 rounded-[14px]' : 'size-11',
      accent?.tileClassName,
    )}>
      <Icon className={large ? 'size-6' : 'size-5'} aria-hidden="true" />
    </span>
  )
}

type ExtensionDetailTarget =
  | { kind: 'installed'; item: NdInstalledPackageView }
  | { kind: 'available'; item: NdAvailablePackageView }

/** Cards open their detail on click; inner controls keep their own behavior. */
function interactiveTarget(event: React.MouseEvent<HTMLElement>): boolean {
  return Boolean((event.target as HTMLElement).closest('button, a, input, select, textarea, label, [role="button"]'))
}

interface Props {
  state: NdExtensionsStateView
  organization: OrganizationSnapshot | null
  contexts: ContextOption[]
  requestedView?: { extensionId: string; viewId: string; context: NdContext } | null
  onRequestedViewHandled?(): void
  /** Bumped whenever a Mini Browser action surfaced a site in the ND browser pane; the open view dialog auto-hides for it. */
  browserFocusNudge?: number
  onOpenBrowser?: ((tabId: string) => Promise<void>) | undefined
  onError(message: string): void
  onChanged(): Promise<void>
}

/**
 * Extensions management: packages, versions and source, per-context
 * activation, settings, grants, pending agent approvals, and the audit trail.
 * Installation is global; activation and grants are per context, and the two
 * are never implied by each other.
 */
export function ExtensionPackagesCard({ state, organization, contexts, requestedView, onRequestedViewHandled, browserFocusNudge, onOpenBrowser, onError, onChanged }: Props): React.ReactNode {
  const [manageContextId, setManageContextId] = useState('personal')
  const manageContext = contexts.find((option) => option.id === manageContextId)?.context ?? { kind: 'personal' as const }
  const [view, setView] = useState<{ extensionId: string; viewId: string; context: NdContext } | null>(null)
  const [detailTarget, setDetailTarget] = useState<ExtensionDetailTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const [visibleCount, setVisibleCount] = useState(48)
  const [catalogTab, setCatalogTab] = useState<'discover' | 'installed'>('installed')
  const [query, setQuery] = useState('')
  const [guideOpen, setGuideOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const policy = normalizeExtensionRuntimePolicy(state.runtimePolicy)
  const webPackages = state.packages.filter((item) => item.views.some((view) => view.kind === 'web')
    && `${item.name} ${item.id}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 48)
  const packageIndex = useMemo(() => new Map(state.packages.map((item) => [item.id, item])), [state.packages])
  const activeIndex = useMemo(() => new Set(state.activations.filter((item) => item.enabled).map((item) => JSON.stringify([item.extensionId, item.contextKey]))), [state.activations])
  useEffect(() => setVisibleCount(48), [query, catalogTab])
  const normalizedQuery = query.trim().toLowerCase()
  const available = (state.available ?? []).filter((item) =>
    !normalizedQuery || `${item.name} ${item.description} ${item.id}`.toLowerCase().includes(normalizedQuery))
  const installed = state.packages.filter((item) =>
    !normalizedQuery || `${item.name} ${item.description} ${item.id}`.toLowerCase().includes(normalizedQuery))

  // Scrim bookkeeping: a browser-focus nudge only belongs to the dialog that
  // was open when the tab was opened. Consuming a view request acknowledges
  // every nudge so far, so the stale signal cannot close a dialog the user just
  // asked for (reopening a kept-alive view, for example).
  const scrimmedNudge = useRef(browserFocusNudge)
  const latestNudge = useRef(browserFocusNudge)
  latestNudge.current = browserFocusNudge

  useEffect(() => {
    if (!requestedView) return
    scrimmedNudge.current = latestNudge.current
    setManageContextId(optionIdForContext(contexts, requestedView.context) ?? 'personal')
    setView(requestedView)
    onRequestedViewHandled?.()
  }, [requestedView])

  useEffect(() => {
    // A Mini Browser action opened or switched a real browser tab and the app
    // is now showing the site; scrim the chrome dialog out of the way. The
    // keep-alive layer keeps the view alive on its header tab.
    if (scrimmedNudge.current === browserFocusNudge) return
    scrimmedNudge.current = browserFocusNudge
    setView(null)
    setDetailTarget(null)
  }, [browserFocusNudge])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'k') return
      if (document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await action()
      await onChanged()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const isActive = (extensionId: string, context: NdContext): boolean =>
    activeIndex.has(JSON.stringify([extensionId, contextKey(context)]))

  return (
    <div className="mx-auto w-full max-w-[1120px] space-y-7 pb-8">
      <header className="border-b border-border-soft pb-5">
        <div className="max-w-[620px]">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-primary">
            <Puzzle className="size-4" aria-hidden="true" /> Extension directory
          </div>
          <h2 className="m-0 text-2xl font-semibold tracking-tight text-foreground">Extensions</h2>
          <p className="mt-1.5 text-xs leading-5 text-faint">
            Add tools and workflows to ND. Installations are shared across your profile; activation and access stay under your control for each context.
          </p>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Extension views" className="flex items-center gap-1 rounded-full border border-border-soft bg-surface-0/60 p-1">
          {([
            ['installed', 'Installed', state.packages.length],
            ['discover', 'Discover', state.available?.length ?? 0],
          ] as const).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              aria-pressed={catalogTab === id}
              onClick={() => {
                setCatalogTab(id)
                if (id === 'discover') void run(() => window.ndDsh.ndExtensions.refreshCatalog())
              }}
              className={cn(
                'inline-flex h-8 items-center gap-2 rounded-full px-3.5 text-xs font-medium transition-colors',
                catalogTab === id ? 'bg-primary/15 text-primary shadow-sm' : 'text-faint hover:bg-accent hover:text-foreground',
              )}
            >
              {label}<span className="text-[10px] opacity-75">{count}</span>
            </button>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
            <Input
              ref={searchRef}
              aria-label="Search extensions"
              placeholder="Search extensions"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 w-[230px] pl-8 pr-14 text-xs"
            />
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border-soft bg-surface-1 px-1.5 py-0.5 text-[9px] font-medium text-faint">Ctrl K</span>
          </label>
          <Button size="sm" variant="outline" onClick={() => setGuideOpen(true)}>
            <BookOpen className="size-3.5" /> Developer guide
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => window.ndDsh.ndExtensions.installLocal())}>
            <FolderOpen className="size-3.5" /> Install from folder
          </Button>
        </div>
      </div>

      <details className="rounded-xl border border-border-soft bg-surface-0/60 p-4">
        <summary className="cursor-pointer text-sm font-semibold">Background extension limits</summary>
        <p className="mt-2 text-xs text-faint">Views stop when closed unless you enable background use below. Idle views can lose unsaved state when released. Native reminders and clipboard recording use their own settings.</p>
        <div className="mt-3 flex flex-wrap gap-4">
          <label className="text-xs">Maximum background views
            <select aria-label="Maximum background extension views" className="ml-2 rounded border border-border-soft bg-surface-1 p-1" value={policy.maxBackgroundViews} disabled={busy}
              onChange={(event) => void run(() => window.ndDsh.ndExtensions.setRuntimePolicy({ ...policy, maxBackgroundViews: Number(event.target.value) }))}>
              {Array.from({ length: 17 }, (_, value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="text-xs">Release after idle minutes
            <select aria-label="Extension idle timeout minutes" className="ml-2 rounded border border-border-soft bg-surface-1 p-1" value={policy.idleTimeoutMinutes} disabled={busy}
              onChange={(event) => void run(() => window.ndDsh.ndExtensions.setRuntimePolicy({ ...policy, idleTimeoutMinutes: Number(event.target.value) }))}>
              {Array.from({ length: 20 }, (_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}
            </select>
          </label>
        </div>
        <p className="mt-2 text-xs text-faint">Use the extension search to find background options. Up to 48 matching views are shown.</p>
        <div className="mt-3 flex flex-wrap gap-4">
          {webPackages.map((item) => <label key={item.id} className="flex items-center gap-2 text-xs">
            <input type="checkbox" disabled={busy} checked={policy.backgroundExtensionIds.includes(item.id)}
              onChange={(event) => void run(() => window.ndDsh.ndExtensions.setRuntimePolicy({ ...policy, backgroundExtensionIds: event.target.checked
                ? [...policy.backgroundExtensionIds, item.id] : policy.backgroundExtensionIds.filter((id) => id !== item.id) }))} />
            Keep {item.name} in background
          </label>)}
        </div>
      </details>

      {state.pendingApprovals.length > 0 ? (
        <section className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4" aria-label="Pending extension approvals">
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-200">
            <ShieldCheck className="size-3.5" /> Agent requests waiting for your approval
          </div>
          <div className="mt-3 space-y-2">
            {state.pendingApprovals.map((approval) => (
              <div key={approval.approvalId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-soft bg-surface-0/50 p-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-soft">
                    {approval.title} · {describeContextForUi(approval.context, organization)}
                  </div>
                  {approval.detail ? (
                    <div className="mt-0.5 text-[10px] leading-4 text-faint">{approval.detail}</div>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" className="h-7" disabled={busy} onClick={() => void run(() => window.ndDsh.ndExtensions.approve(approval.approvalId))}>Allow once</Button>
                  <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => void run(() => window.ndDsh.ndExtensions.approve(approval.approvalId, true))}>Allow always</Button>
                  <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => void run(() => window.ndDsh.ndExtensions.deny(approval.approvalId))}>Deny</Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="m-0 text-sm font-semibold text-foreground">{catalogTab === 'discover' ? 'Discover extensions' : 'Installed extensions'}</h3>
            <p className="mt-1 text-[11px] text-faint">{catalogTab === 'discover' ? 'Explore ND-maintained extensions and add the ones you need.' : 'Choose where each extension is active and review its available controls.'}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-faint">
              {catalogTab === 'discover'
                ? `${available.length} ${available.length === 1 ? 'extension' : 'extensions'}`
                : `${installed.length} ${installed.length === 1 ? 'extension' : 'extensions'}`}
            </span>
            <label className="flex items-center gap-2 text-[11px] text-faint">
              Manage context
              <select
                className="h-8 rounded-md border border-border-soft bg-surface-0/60 px-2 text-xs text-foreground"
                value={manageContextId}
                onChange={(event) => setManageContextId(event.target.value)}
                aria-label="Context for extension settings and grants"
              >
                {contexts.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
          </div>
        </div>

        {catalogTab === 'discover' ? (
          <section aria-label="Discover extensions">
            {available.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {available.slice(0, visibleCount).map((item) => {
                  const installed = packageIndex.get(item.id)
                  const updateAvailable = installed && installed.version !== item.version
                  return (
                    <article
                      key={item.id}
                      onClick={(event) => { if (!interactiveTarget(event)) setDetailTarget({ kind: 'available', item }) }}
                      className="flex min-h-[172px] cursor-pointer flex-col rounded-2xl border border-border-soft bg-surface-0/40 p-4 transition-colors hover:border-border-strong hover:bg-surface-1"
                    >
                      <div className="flex items-start gap-3">
                        <ExtensionIconTile id={item.id} />
                        <div className="min-w-0 flex-1">
                          <h4 className="m-0 truncate text-sm font-semibold text-foreground">{item.name}</h4>
                          <p className="mt-0.5 truncate text-[10px] text-faint">ND-maintained · v{item.version}</p>
                        </div>
                        <Button
                          size="sm"
                          variant={installed && !updateAvailable ? 'outline' : 'default'}
                          className="shrink-0"
                          title={updateAvailable ? `Update to v${item.version}` : undefined}
                          disabled={busy || !item.available || Boolean(installed && !updateAvailable)}
                          onClick={() => void run(() => window.ndDsh.ndExtensions.installAvailable(item.id))}
                        >
                          {installed && !updateAvailable ? <><Check className="size-3.5" /> Installed</> : updateAvailable ? <><RefreshCw className="size-3.5" /> Update</> : item.available ? <><Download className="size-3.5" /> Install</> : 'Unavailable'}
                        </Button>
                      </div>
                      <p className="mt-3 line-clamp-2 min-h-9 text-[11px] leading-[1.45] text-soft">{item.description}</p>
                      <div className="mt-auto border-t border-border-soft pt-3">
                        <p className="flex min-w-0 gap-1.5 text-[10px] leading-4 text-faint" title={`Access: ${describePermissions(item.permissions) || 'No special access'}`}>
                          <ShieldCheck className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                          <span className="truncate"><strong className="font-medium text-soft">Access:</strong> {describePermissions(item.permissions) || 'No special access'}</span>
                        </p>
                      </div>
                    </article>
                  )
                })}
              </div>
            ) : (
              <EmptyExtensions title={normalizedQuery ? 'No extensions found' : 'No extensions to discover'} detail={normalizedQuery ? 'Try a different search.' : 'ND-maintained extensions will appear here when available.'} />
            )}
          </section>
        ) : (
          <section aria-label="Installed extensions">
            {installed.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {installed.slice(0, visibleCount).map((item) => (
                  <PackageRow
                    key={item.id}
                    item={item}
                    state={state}
                    contexts={contexts}
                    manageContext={manageContext}
                    busy={busy}
                    isActive={isActive}
                    run={run}
                    onOpenDetail={() => setDetailTarget({ kind: 'installed', item })}
                    onOpenView={(viewId, targetCtx) => setView({ extensionId: item.id, viewId, context: targetCtx ?? manageContext })}
                  />
                ))}
              </div>
            ) : (
              <EmptyExtensions title={normalizedQuery ? 'No installed extensions found' : 'Your extensions will show up here'} detail={normalizedQuery ? 'Try a different search.' : 'Browse the directory to add an extension, or install one from a local folder.'} />
            )}
          </section>
        )}
      </div>

      {(catalogTab === 'discover' ? available.length : installed.length) > visibleCount ? (
        <Button variant="outline" onClick={() => setVisibleCount((count) => count + 48)}>Show more extensions</Button>
      ) : null}

      <details className="group rounded-xl border border-border-soft bg-surface-0/30">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-xs font-semibold text-foreground [&::-webkit-details-marker]:hidden">
          <span>Access and activity</span>
          <span className="text-[10px] font-normal text-faint">{state.grants.length} grants · {state.audit.length} decisions</span>
        </summary>
        <div className="space-y-4 border-t border-border-soft p-4">
        <div>
          <span className="text-xs font-semibold text-foreground">Grants for {contexts.find((option) => option.id === manageContextId)?.label ?? 'Personal'}</span>
        </div>
        {(() => {
          const key = contextKey(manageContext)
          const grants = state.grants.filter((grant) => grant.contextKey === key)
          if (grants.length === 0) return <p className="mt-1 text-[11px] text-faint">No remembered grants in this context.</p>
          return (
            <div className="mt-2 space-y-1.5">
              {grants.map((grant) => (
                <div key={grant.id} className="flex items-center justify-between gap-2 rounded border border-border-soft bg-surface-0/40 px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-soft">
                    {grant.extensionId} · {grant.host} · {grant.scope === 'once' ? 'one-time' : 'remembered'}
                    {grant.resource ? ` · ${grant.resource}` : ''}
                  </span>
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={busy} onClick={() => void run(() => window.ndDsh.ndExtensions.revokeGrant(grant.id))}>
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          )
        })()}

        <div>
        <span className="text-xs font-semibold text-foreground">Recent extension decisions</span>
        {state.audit.length === 0 ? (
          <p className="mt-1 text-[11px] text-faint">No extension activity recorded yet.</p>
        ) : (
          <div className="mt-2 space-y-1">
            {state.audit.slice(0, 12).map((entry, index) => (
              <div key={`${entry.at}-${index}`} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="min-w-0 flex-1 truncate text-faint">
                  {new Date(entry.at).toLocaleTimeString()} · {entry.extensionId} · {entry.host} · {entry.contextKey} · {entry.caller}
                </span>
                <Badge variant={entry.decision === 'allowed' ? 'secondary' : 'destructive'}>{entry.decision}</Badge>
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-[10px] text-faint">Decisions are logged without clipboard contents, screenshots, or credentials.</p>
        </div>
        </div>
      </details>

      <ExtensionDetailDialog
        target={detailTarget}
        state={state}
        contexts={contexts}
        manageContext={manageContext}
        busy={busy}
        isActive={isActive}
        run={run}
        onOpenView={(extensionId, viewId, context) => {
          setDetailTarget(null)
          setView({ extensionId, viewId, context })
        }}
        onClose={() => setDetailTarget(null)}
      />

      <ExtensionViewDialog
        target={view}
        organization={organization}
        state={state}
        onClose={() => setView(null)}
        onError={onError}
        onChanged={onChanged}
        onOpenBrowser={onOpenBrowser}
      />

      {/* Mounted on demand so the bundled guide text stays out of the initial chunk. */}
      <Suspense fallback={null}>
        {guideOpen ? <ExtensionGuideDialog open={guideOpen} onOpenChange={setGuideOpen} /> : null}
      </Suspense>
    </div>
  )
}

type WallpaperPreviewDetail = {
  id: string
  filename: string
  path: string
  dataUrl?: string
  thumbnail?: string
  width?: number
  height?: number
  size?: number
  modifiedAt?: number
}

function formatFileSize(bytes?: number): string | null {
  if (typeof bytes !== 'number' || bytes <= 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function WallpaperSettingsPreview({
  folder,
  context,
  onOpenStudio,
  onWallpaperChanged,
}: {
  folder: string
  context: NdContext
  onOpenStudio(): void
  onWallpaperChanged?(): void
}): React.ReactNode {
  const [items, setItems] = useState<NdViewRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [previewDetail, setPreviewDetail] = useState<WallpaperPreviewDetail | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  // The settings filmstrip always shows the Personal wallpaper library, so its
  // thumbnail target never changes and is memoised to keep the hook's cache.
  const thumbTarget = useMemo(() => ({
    extensionId: 'nd.wallpaper-manager',
    viewId: 'wallpaper-studio',
    context: { kind: 'personal' as const },
  }), [])
  const { thumbs, queueThumbnail } = useLazyWallpaperThumbnails(thumbTarget)

  const cleanFolder = folder.trim().replace(/^["']|["']$/g, '').trim()

  const loadWallpapers = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const targetCtx = context.kind === 'personal' ? context : { kind: 'personal' as const }
      const res = await window.ndDsh.ndExtensions.invoke({
        extensionId: 'nd.wallpaper-manager',
        contributionId: 'wallpaper-studio',
        contributionKind: 'view',
        context: targetCtx,
        caller: 'user',
        input: cleanFolder ? { folder: cleanFolder } : {},
      })
      if (res.ok && Array.isArray(res.value)) {
        const rows: NdViewRow[] = (res.value as Record<string, unknown>[]).map((rec, idx) => ({
          id: typeof rec.id === 'string' ? rec.id : `row-${idx}`,
          title: typeof rec.title === 'string' ? rec.title : String(rec.id ?? `Wallpaper ${idx + 1}`),
          ...(typeof rec.detail === 'string' ? { body: rec.detail } : {}),
          ...(typeof rec.status === 'string' ? { meta: rec.status } : {}),
          ...(typeof rec.thumbnail === 'string' ? { thumbnail: rec.thumbnail } : {}),
          ...(typeof rec.path === 'string' ? { path: rec.path } : {}),
        }))
        setItems(rows)
        const activeIdx = rows.findIndex((r) => r.meta === 'Active')
        setSelectedIndex(activeIdx >= 0 ? activeIdx : 0)
      } else {
        setItems([])
        if (!res.ok && res.error) {
          setError(res.error.message)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadWallpapers()
  }, [folder, context])

  const selectedItem = items[selectedIndex] ?? null
  const isSelectedActive = selectedItem?.meta === 'Active'

  useEffect(() => {
    if (!selectedItem) {
      setPreviewDetail(null)
      return
    }
    let active = true
    setPreviewLoading(true)
    setPreviewDetail({
      id: selectedItem.id,
      filename: selectedItem.title,
      path: selectedItem.path ?? selectedItem.body ?? '',
      ...(selectedItem.thumbnail ? { thumbnail: selectedItem.thumbnail } : {}),
    })

    const targetCtx = context.kind === 'personal' ? context : { kind: 'personal' as const }
    void window.ndDsh.ndExtensions.invoke({
      extensionId: 'nd.wallpaper-manager',
      contributionId: 'wallpaper-studio',
      contributionKind: 'view',
      context: targetCtx,
      caller: 'user',
      input: { action: 'preview', id: selectedItem.id, ...(selectedItem.path ? { path: selectedItem.path } : {}) },
    }).then((res) => {
      if (!active) return
      if (res.ok && res.value && typeof res.value === 'object') {
        setPreviewDetail(res.value as WallpaperPreviewDetail)
      }
    }).catch(() => {
      // fallback to thumbnail
    }).finally(() => {
      if (active) setPreviewLoading(false)
    })

    return () => { active = false }
  }, [selectedItem?.id, selectedItem?.path, context])

  const handlePrev = useCallback((): void => {
    if (items.length <= 1) return
    setSelectedIndex((prev) => (prev <= 0 ? items.length - 1 : prev - 1))
  }, [items.length])

  const handleNext = useCallback((): void => {
    if (items.length <= 1) return
    setSelectedIndex((prev) => (prev >= items.length - 1 ? 0 : prev + 1))
  }, [items.length])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        handlePrev()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        handleNext()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handlePrev, handleNext])

  const handleSetWallpaper = async (): Promise<void> => {
    if (!selectedItem) return
    setApplying(true)
    try {
      const targetCtx = context.kind === 'personal' ? context : { kind: 'personal' as const }
      const res = await window.ndDsh.ndExtensions.invoke({
        extensionId: 'nd.wallpaper-manager',
        contributionId: 'wallpaper-studio',
        contributionKind: 'view',
        context: targetCtx,
        caller: 'user',
        input: { action: 'apply', id: selectedItem.id, ...(selectedItem.path ? { path: selectedItem.path } : {}) },
      })
      if (res.ok) {
        await loadWallpapers()
        onWallpaperChanged?.()
      } else {
        setError(res.error?.message ?? 'Failed to set wallpaper')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-border-soft bg-surface-0/60 p-3.5 w-full min-w-0 max-w-full overflow-x-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-border-soft/60 pb-2.5">
        <div className="flex items-center gap-2">
          <Image className="size-4 text-primary" />
          <h4 className="text-xs font-semibold text-foreground">Wallpaper Picture Previews</h4>
          <span className="text-[10px] text-faint">
            {loading ? 'Scanning folder…' : items.length > 0 ? `${items.length} wallpapers` : 'No pictures found'}
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-[11px] px-2 text-primary hover:text-primary"
          onClick={onOpenStudio}
        >
          <ExternalLink className="mr-1 size-3" /> Open Wallpaper Studio
        </Button>
      </div>

      {error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center py-8 text-faint">
          <RefreshCw className="mr-2 size-4 animate-spin text-primary" />
          <span className="text-xs">Loading picture previews…</span>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-6 text-center text-faint">
          <Image className="mb-2 size-8 opacity-40" />
          <p className="text-xs font-medium text-foreground">
            {error ? 'Could not load wallpapers' : cleanFolder ? `No images found in “${cleanFolder}”` : 'No images found in this folder'}
          </p>
          <p className="mt-0.5 text-[11px] text-faint">
            {error || 'Use the “Browse…” button above to select a folder containing images (.jpg, .png, .webp).'}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2.5 h-7 text-xs"
            onClick={() => void loadWallpapers()}
          >
            <RefreshCw className="mr-1.5 size-3" /> Retry scan
          </Button>
        </div>
      ) : (
        <div className="space-y-3 min-w-0 w-full max-w-full">
          {selectedItem ? (
            <div className="relative group/feat flex flex-col overflow-hidden rounded-xl border border-border-soft bg-surface-2/40 w-full min-w-0 max-w-full shadow-sm">
              <div className="relative flex aspect-video max-h-[380px] w-full min-w-0 items-center justify-center overflow-hidden bg-black/90 p-2">
                {items.length > 1 ? (
                  <button
                    type="button"
                    aria-label="Previous picture"
                    onClick={handlePrev}
                    className="absolute left-3 top-1/2 -translate-y-1/2 z-20 flex size-9 items-center justify-center rounded-full bg-black/70 text-white shadow-lg backdrop-blur-sm transition-all hover:bg-black/95 hover:scale-110 active:scale-95"
                    title="Previous wallpaper (Left arrow)"
                  >
                    <ChevronLeft className="size-5" />
                  </button>
                ) : null}

                {items.length > 1 ? (
                  <button
                    type="button"
                    aria-label="Next picture"
                    onClick={handleNext}
                    className="absolute right-3 top-1/2 -translate-y-1/2 z-20 flex size-9 items-center justify-center rounded-full bg-black/70 text-white shadow-lg backdrop-blur-sm transition-all hover:bg-black/95 hover:scale-110 active:scale-95"
                    title="Next wallpaper (Right arrow)"
                  >
                    <ChevronRight className="size-5" />
                  </button>
                ) : null}

                {previewDetail?.dataUrl || previewDetail?.thumbnail || selectedItem.thumbnail ? (
                  <img
                    src={previewDetail?.dataUrl || previewDetail?.thumbnail || selectedItem.thumbnail}
                    alt={selectedItem.title}
                    className="size-full object-contain select-none shadow-md"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center text-faint">
                    <Image className="size-8 opacity-40" />
                    <span className="mt-1 text-[11px]">Loading preview…</span>
                  </div>
                )}

                {previewLoading ? (
                  <div className="absolute top-2.5 right-2.5 z-20 flex items-center gap-1 rounded bg-black/75 px-2 py-0.5 text-[10px] text-white backdrop-blur-sm shadow">
                    <RefreshCw className="size-2.5 animate-spin" /> High-res
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-soft/60 bg-surface-1/95 px-3 py-2 text-xs min-w-0 w-full">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 truncate">
                    <span className="font-semibold text-foreground truncate" title={selectedItem.title}>
                      {selectedItem.title}
                    </span>
                    {previewDetail?.width && previewDetail?.height ? (
                      <Badge variant="outline" className="text-[9px] font-mono px-1 py-0 shrink-0">
                        {previewDetail.width} × {previewDetail.height}
                      </Badge>
                    ) : null}
                    {typeof previewDetail?.size === 'number' && previewDetail.size > 0 ? (
                      <Badge variant="outline" className="text-[9px] font-mono px-1 py-0 shrink-0">
                        {formatFileSize(previewDetail.size)}
                      </Badge>
                    ) : null}
                    {isSelectedActive ? (
                      <Badge variant="default" className="text-[9px] px-1 py-0 shrink-0">
                        Active
                      </Badge>
                    ) : null}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
                    disabled={items.length <= 1}
                    onClick={handlePrev}
                    title="Previous wallpaper (Left arrow)"
                  >
                    <ChevronLeft className="mr-0.5 size-3" /> Prev
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
                    disabled={items.length <= 1}
                    onClick={handleNext}
                    title="Next wallpaper (Right arrow)"
                  >
                    Next <ChevronRight className="ml-0.5 size-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant={isSelectedActive ? "secondary" : "default"}
                    className="h-6 px-2.5 text-[11px]"
                    disabled={applying || isSelectedActive}
                    onClick={() => void handleSetWallpaper()}
                  >
                    {isSelectedActive ? (
                      <><Check className="mr-1 size-3" /> Active</>
                    ) : (
                      <><Image className="mr-1 size-3" /> Set as Wallpaper</>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="space-y-1.5 min-w-0 w-full max-w-full">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-faint">
                Wallpapers in this folder ({selectedIndex + 1} of {items.length}):
              </span>
              <span className="text-[10px] text-faint">Click thumbnail to preview</span>
            </div>
            <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-1.5 max-h-36 overflow-y-auto overflow-x-hidden p-1 rounded-md border border-border-soft/50 bg-surface-1/40">
              {items.map((item, idx) => {
                const isSelected = idx === selectedIndex
                const isActive = item.meta === 'Active'
                return (
                  <div
                    key={item.id}
                    onClick={() => setSelectedIndex(idx)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedIndex(idx) } }}
                    className={cn(
                      "group/thumb relative aspect-video cursor-pointer overflow-hidden rounded-md border transition-all",
                      isSelected
                        ? "border-primary ring-2 ring-primary/40 shadow-sm"
                        : isActive
                          ? "border-primary/60 bg-primary/10"
                          : "border-border-soft hover:border-foreground/40 bg-surface-2/40"
                    )}
                    title={item.title}
                  >
                    <LazyWallpaperThumb
                      id={item.id}
                      alt={item.title}
                      dataUrl={thumbs[item.id] ?? item.thumbnail}
                      onVisible={queueThumbnail}
                      imgClassName="size-full object-cover transition-transform group-hover/thumb:scale-105"
                      iconClassName="size-4"
                    />
                    {isActive ? (
                      <span className="absolute bottom-1 right-1 rounded bg-primary px-1 text-[8px] font-medium text-primary-foreground shadow">
                        Active
                      </span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PackageRow({
  item,
  state,
  contexts,
  manageContext,
  busy,
  isActive,
  run,
  onOpenView,
  onOpenDetail,
}: {
  item: NdInstalledPackageView
  state: NdExtensionsStateView
  contexts: ContextOption[]
  manageContext: NdContext
  busy: boolean
  isActive(extensionId: string, context: NdContext): boolean
  run(action: () => Promise<unknown>): Promise<void>
  onOpenView(viewId: string, context?: NdContext): void
  onOpenDetail(): void
}): React.ReactNode {
  const [settingsDraft, setSettingsDraft] = useState<Record<string, string>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const supported = contexts.filter((option) => item.contexts.includes(option.context.kind))
  const isManageSupported = supported.some((option) => contextKey(option.context) === contextKey(manageContext))
  const effectiveContext = isManageSupported ? manageContext : (supported[0]?.context ?? manageContext)
  const effectiveKey = contextKey(effectiveContext)
  const activation = state.activations.find((record) => record.extensionId === item.id && record.contextKey === effectiveKey)
  const primaryView = item.views[0]

  return (
    <>
      <article
        onClick={(event) => { if (!interactiveTarget(event)) onOpenDetail() }}
        className="flex min-h-[230px] min-w-0 cursor-pointer flex-col rounded-2xl border border-border-soft bg-surface-0/40 p-4 transition-colors hover:border-border-strong hover:bg-surface-1"
      >
        <div className="flex items-start gap-3">
          <ExtensionIconTile id={item.id} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h4 className="m-0 text-sm font-semibold text-foreground">{item.name}</h4>
              <Badge variant="secondary">v{item.version}</Badge>
              {item.source.kind === 'builtin' ? <Badge variant="outline">ND-maintained</Badge> : null}
              {item.hasExecutable ? <Badge variant="outline">executable</Badge> : null}
            </div>
            {item.previousVersion ? <p className="mt-1 text-[10px] text-faint">Previous version v{item.previousVersion} is available for rollback.</p> : null}
          </div>
        </div>

        <p className="mt-3 min-h-9 text-[11px] leading-[1.45] text-soft">{item.description}</p>
        <div className="mt-auto border-t border-border-soft pt-3">
          <div className="flex items-start gap-1.5 text-[10px] leading-4 text-faint">
            <ShieldCheck className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            <span><strong className="font-medium text-soft">Access:</strong> {describePermissions(item.permissions) || 'No special access'}</span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[10px] font-medium text-faint">Active in</span>
            {supported.length > 0 ? supported.map((option) => {
              const active = isActive(item.id, option.context)
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={busy}
                  aria-pressed={active}
                  className={cn('rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors disabled:opacity-50', active ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border-soft text-faint hover:bg-accent hover:text-foreground')}
                  onClick={() => void run(() => window.ndDsh.ndExtensions.setActivation(item.id, option.context, !active))}
                >
                  {option.label}{active ? ' ✓' : ''}
                </button>
              )
            }) : <span className="text-[10px] text-faint">No compatible context available.</span>}
          </div>

          <div
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-faint"
            title={`${item.source.location}${item.source.revision ? ` @ ${item.source.revision.slice(0, 10)}` : ''}`}
          >
            <span className="inline-flex items-center gap-1"><Layers className="size-3 opacity-70" aria-hidden="true" /> {describeSource(item.source.kind)}</span>
            <span className="inline-flex items-center gap-1"><SquareTerminal className="size-3 opacity-70" aria-hidden="true" /> {item.contributions.commands} commands</span>
            <span className="inline-flex items-center gap-1"><PanelsTopLeft className="size-3 opacity-70" aria-hidden="true" /> {item.contributions.views} views</span>
            {item.contributions.workflows > 0 ? (
              <span className="inline-flex items-center gap-1"><Workflow className="size-3 opacity-70" aria-hidden="true" /> {item.contributions.workflows} workflows</span>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {item.views.length > 0 ? (
              <Button size="sm" disabled={busy || !activation?.enabled} onClick={() => onOpenView(primaryView!.id, effectiveContext)}>
                <Image className="size-3.5" /> Open{item.views.length === 1 ? '' : ` ${primaryView!.title}`}
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="size-3.5" /> Settings
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => window.ndDsh.ndExtensions.update(item.id))}>
              <RefreshCw className="size-3" /> Update
            </Button>
            {item.source.kind !== 'builtin' ? (
              <Button size="sm" variant="ghost" className="ml-auto text-destructive" disabled={busy} onClick={() => void run(() => window.ndDsh.ndExtensions.uninstall(item.id))}>
                Uninstall
              </Button>
            ) : null}
          </div>
          {item.views.length > 1 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.views.slice(1).map((view) => (
                <Button key={view.id} size="sm" variant="ghost" className="h-7 px-2 text-[10px]" disabled={busy || !activation?.enabled} onClick={() => onOpenView(view.id, effectiveContext)}>
                  Open {view.title}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </article>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className={cn("max-h-[88vh] overflow-y-auto overflow-x-hidden border-border-strong bg-surface-1 min-w-0 w-full", item.id === 'nd.wallpaper-manager' ? "sm:max-w-3xl md:max-w-4xl" : "sm:max-w-xl")}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Settings2 className="size-4 text-primary" /> {item.name} settings</DialogTitle>
            <DialogDescription>Settings apply to {contexts.find((option) => contextKey(option.context) === effectiveKey)?.label ?? 'this context'}.</DialogDescription>
          </DialogHeader>
          {item.settings.length > 0 ? (
            <div className="space-y-4 py-1 min-w-0 w-full max-w-full overflow-x-hidden">
              {item.settings.map((field) => {
                const current = activation?.settings[field.key] ?? field.default
                const draftKey = `${item.id}:${effectiveKey}:${field.key}`
                const draft = settingsDraft[draftKey] ?? String(current ?? '')
                return (
                  <div key={field.key} className="space-y-1.5 min-w-0 w-full max-w-full">
                    <label className="block text-xs font-medium text-foreground" htmlFor={`${item.id}-${field.key}`}>{field.title}</label>
                    {field.description ? <p className="m-0 text-[10px] leading-4 text-faint">{field.description}</p> : null}
                    {field.type === 'boolean' ? (
                      <label className="flex items-center gap-2 text-xs text-soft">
                        <input
                          id={`${item.id}-${field.key}`}
                          type="checkbox"
                          checked={draft === 'true'}
                          disabled={busy}
                          onChange={(event) => setSettingsDraft((prev) => ({ ...prev, [draftKey]: String(event.target.checked) }))}
                        />
                        {draft === 'true' ? 'On' : 'Off'}
                      </label>
                    ) : (field.key === 'folder' || field.key.toLowerCase().includes('folder') || field.title.toLowerCase().includes('folder')) ? (
                      <div className="space-y-2 min-w-0 w-full max-w-full">
                        <div className="flex items-center gap-2">
                          <Input
                            id={`${item.id}-${field.key}`}
                            type="text"
                            className="h-9 flex-1 text-xs"
                            placeholder={field.key === 'folder' ? 'Default system Pictures folder' : undefined}
                            value={draft}
                            disabled={busy}
                            onChange={(event) => setSettingsDraft((prev) => ({ ...prev, [draftKey]: event.target.value }))}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-9 shrink-0 gap-1.5"
                            disabled={busy}
                            onClick={async () => {
                              if (item.id === 'nd.wallpaper-manager' && field.key === 'folder') {
                                try {
                                  const result = await window.ndDsh.ndExtensions.invoke({
                                    extensionId: item.id,
                                    contributionId: 'wallpaper-studio',
                                    contributionKind: 'view',
                                    context: effectiveContext,
                                    caller: 'user',
                                    input: { action: 'folders-add' },
                                  })
                                  if (result.ok && result.value && typeof (result.value as { folder?: unknown }).folder === 'string') {
                                    const chosen = (result.value as { folder: string }).folder
                                    setSettingsDraft((prev) => ({ ...prev, [draftKey]: chosen }))
                                    await run(() => Promise.resolve())
                                    return
                                  }
                                  if (result.ok) return
                                } catch {
                                  // fall through to workspace pickPath
                                }
                              }
                              const picked = await window.ndDsh.workspace.pickPath({
                                title: `Choose ${field.title.toLowerCase()}`,
                                ...(draft.trim() ? { defaultPath: draft.trim() } : {}),
                              })
                              if (picked) {
                                setSettingsDraft((prev) => ({ ...prev, [draftKey]: picked }))
                                await run(() => window.ndDsh.ndExtensions.setSetting(item.id, effectiveContext, field.key, picked))
                              }
                            }}
                          >
                            <FolderOpen className="size-3.5" /> Browse…
                          </Button>
                        </div>
                        {item.id === 'nd.wallpaper-manager' && field.key === 'folder' ? (
                          <WallpaperSettingsPreview
                            folder={draft}
                            context={effectiveContext}
                            onOpenStudio={() => {
                              setSettingsOpen(false)
                              onOpenView('wallpaper-studio', effectiveContext)
                            }}
                            onWallpaperChanged={() => void run(() => Promise.resolve())}
                          />
                        ) : null}
                      </div>
                    ) : (
                      <Input
                        id={`${item.id}-${field.key}`}
                        type={field.type === 'number' ? 'number' : 'text'}
                        className="h-9 text-xs"
                        value={draft}
                        disabled={busy}
                        onChange={(event) => setSettingsDraft((prev) => ({ ...prev, [draftKey]: event.target.value }))}
                      />
                    )}
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void run(() => window.ndDsh.ndExtensions.setSetting(
                          item.id,
                          effectiveContext,
                          field.key,
                          field.type === 'number' ? Number(draft) : field.type === 'boolean' ? draft === 'true' : draft,
                        ))}
                      >
                        Save {field.title}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="py-3 text-xs text-faint">This extension has no configurable settings. Use the context controls on its card to manage activation.</p>
          )}
          <div className="border-t border-border-soft pt-3">
            <p className="m-0 text-[10px] text-faint">{describeSource(item.source.kind)} · {item.id}</p>
            {item.previousVersion ? (
              <div className="mt-2 flex justify-end">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => window.ndDsh.ndExtensions.rollback(item.id))}>
                  <Undo2 className="size-3.5" /> Roll back to v{item.previousVersion}
                </Button>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ExtensionDetailDialog({
  target,
  state,
  contexts,
  manageContext,
  busy,
  isActive,
  run,
  onOpenView,
  onClose,
}: {
  target: ExtensionDetailTarget | null
  state: NdExtensionsStateView
  contexts: ContextOption[]
  manageContext: NdContext
  busy: boolean
  isActive(extensionId: string, context: NdContext): boolean
  run(action: () => Promise<unknown>): Promise<void>
  onOpenView(extensionId: string, viewId: string, context: NdContext): void
  onClose(): void
}): React.ReactNode {
  const item = target?.item ?? null
  const installedRecord = item ? state.packages.find((pack) => pack.id === item.id) ?? null : null
  const catalogRecord = item ? state.available?.find((pack) => pack.id === item.id) ?? null : null
  const updateAvailable = Boolean(catalogRecord && installedRecord && catalogRecord.version !== installedRecord.version)

  const supported = installedRecord ? contexts.filter((option) => installedRecord.contexts.includes(option.context.kind)) : []
  const isManageSupported = supported.some((option) => contextKey(option.context) === contextKey(manageContext))
  const effectiveContext = isManageSupported ? manageContext : (supported[0]?.context ?? manageContext)
  const activation = installedRecord
    ? state.activations.find((record) => record.extensionId === installedRecord.id && record.contextKey === contextKey(effectiveContext))
    : null

  const commands = installedRecord?.commands ?? item?.commands ?? []
  const views = installedRecord?.views ?? []
  const permissions = installedRecord?.permissions ?? item?.permissions ?? []
  const primaryView = views[0]

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[86vh] gap-3 overflow-y-auto overflow-x-hidden border-border-strong bg-surface-1 sm:max-w-2xl">
        {item ? (
          <>
            <DialogHeader>
              <div className="flex items-start gap-3">
                <ExtensionIconTile id={item.id} large />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <DialogTitle className="text-lg">{item.name}</DialogTitle>
                    <Badge variant="secondary">v{installedRecord?.version ?? item.version}</Badge>
                    {installedRecord?.hasExecutable ? <Badge variant="outline">executable</Badge> : null}
                  </div>
                  <DialogDescription className="mt-0.5 text-[11px]">
                    {installedRecord
                      ? `${describeSource(installedRecord.source.kind)} · v${installedRecord.version}`
                      : `ND-maintained · v${item.version}`}
                  </DialogDescription>
                </div>
                <div className="shrink-0 pr-8">
                  {installedRecord ? (
                    primaryView ? (
                      <Button size="sm" disabled={busy || !activation?.enabled} onClick={() => onOpenView(installedRecord.id, primaryView.id, effectiveContext)}>
                        <PanelsTopLeft className="size-3.5" /> Open{views.length === 1 ? '' : ` ${primaryView.title}`}
                      </Button>
                    ) : null
                  ) : catalogRecord ? (
                    <Button
                      size="sm"
                      variant={catalogRecord.installed ? 'outline' : 'default'}
                      disabled={busy || !catalogRecord.available || catalogRecord.installed}
                      onClick={() => void run(() => window.ndDsh.ndExtensions.installAvailable(catalogRecord.id))}
                    >
                      {catalogRecord.installed ? <><Check className="size-3.5" /> Installed</> : catalogRecord.available ? <><Download className="size-3.5" /> Install</> : 'Unavailable'}
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled>Unavailable</Button>
                  )}
                </div>
              </div>
            </DialogHeader>

            <p className="line-clamp-2 text-[11px] leading-4 text-soft" title={item.description}>{item.description}</p>

            <section>
              <h4 className="m-0 flex items-center gap-1.5 text-[11px] font-semibold text-faint">
                <SquareTerminal className="size-3.5" aria-hidden="true" /> Commands
                <span className="font-normal opacity-70">{commands.length}</span>
              </h4>
              {commands.length > 0 ? (
                <div className="mt-1.5 grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {commands.map((command) => (
                    <div key={command.id} className="flex items-baseline gap-2 rounded-md border border-border-soft bg-surface-0/40 px-2.5 py-1">
                      <span className="shrink-0 text-xs font-medium text-foreground">{command.title}</span>
                      {command.description ? <span className="min-w-0 truncate text-[11px] text-faint" title={command.description}>{command.description}</span> : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-1.5 text-[11px] text-faint">This extension registers no commands.</p>
              )}
            </section>

            {views.length > 0 ? (
              <section>
                <h4 className="m-0 flex items-center gap-1.5 text-[11px] font-semibold text-faint">
                  <PanelsTopLeft className="size-3.5" aria-hidden="true" /> Views
                  <span className="font-normal opacity-70">{views.length}</span>
                </h4>
                <div className="mt-1.5 divide-y divide-border-soft rounded-lg border border-border-soft bg-surface-0/40">
                  {views.map((view) => (
                    <div key={view.id} className="flex items-center gap-3 px-2.5 py-1.5">
                      <span className="shrink-0 text-xs font-medium text-foreground">{view.title}</span>
                      {view.description ? <span className="min-w-0 flex-1 truncate text-[11px] text-faint" title={view.description}>{view.description}</span> : <span className="flex-1" />}
                      {installedRecord ? (
                        <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[11px]" disabled={busy || !activation?.enabled} onClick={() => onOpenView(installedRecord.id, view.id, effectiveContext)}>
                          Open
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section>
              <h4 className="m-0 flex items-center gap-1.5 text-[11px] font-semibold text-faint">
                <ShieldCheck className="size-3.5" aria-hidden="true" /> Access
              </h4>
              {permissions.length > 0 ? (
                <div className="mt-1.5 grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {Array.from(new Set(permissions)).map((permission) => (
                    <div key={permission} className="flex items-center justify-between gap-2 rounded-md border border-border-soft bg-surface-0/40 px-2.5 py-1">
                      <span className="truncate text-[11px] text-soft">{PERMISSION_LABELS[permission] ?? permission}</span>
                      {PERMISSION_LABELS[permission] ? <code className="shrink-0 text-[10px] text-faint">{permission}</code> : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-1.5 text-[11px] text-faint">No special access.</p>
              )}
            </section>

            {installedRecord ? (
              <section>
                <h4 className="m-0 text-[11px] font-semibold text-faint">Active in</h4>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {supported.length > 0 ? supported.map((option) => {
                    const active = isActive(installedRecord.id, option.context)
                    return (
                      <button
                        key={option.id}
                        type="button"
                        disabled={busy}
                        aria-pressed={active}
                        className={cn('rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors disabled:opacity-50', active ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border-soft text-faint hover:bg-accent hover:text-foreground')}
                        onClick={() => void run(() => window.ndDsh.ndExtensions.setActivation(installedRecord.id, option.context, !active))}
                      >
                        {option.label}{active ? ' ✓' : ''}
                      </button>
                    )
                  }) : <span className="text-[10px] text-faint">No compatible context available.</span>}
                </div>
              </section>
            ) : null}

            <section>
              <h4 className="m-0 text-[11px] font-semibold text-faint">Details</h4>
              <dl className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                <MetaItem label="Identifier" title={item.id}><code className="font-mono text-[10px]">{item.id}</code></MetaItem>
                <MetaItem label="Version">v{installedRecord?.version ?? item.version}</MetaItem>
                {installedRecord ? (
                  <>
                    <MetaItem label="Source">{describeSource(installedRecord.source.kind)}</MetaItem>
                    <MetaItem label="Location" title={installedRecord.source.location}>{installedRecord.source.location}</MetaItem>
                    <MetaItem label="Protocol">{installedRecord.protocol} · API v{installedRecord.apiVersion}</MetaItem>
                    <MetaItem label="Contexts">{installedRecord.contexts.map((kind) => kind.charAt(0).toUpperCase() + kind.slice(1)).join(', ')}</MetaItem>
                    <MetaItem label="Installed">{new Date(installedRecord.installedAt).toLocaleDateString()}</MetaItem>
                    <MetaItem label="Updated">{new Date(installedRecord.updatedAt).toLocaleDateString()}</MetaItem>
                  </>
                ) : (
                  <MetaItem label="Status">{catalogRecord?.available ? 'Available to install' : 'Unavailable'}</MetaItem>
                )}
              </dl>
              {installedRecord?.source.revision ? (
                <p className="mt-1.5 truncate text-[10px] text-faint" title={installedRecord.source.revision}>Revision {installedRecord.source.revision.slice(0, 12)}</p>
              ) : null}
            </section>

            {installedRecord ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-border-soft pt-2.5">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => window.ndDsh.ndExtensions.update(installedRecord.id))}>
                  <RefreshCw className="size-3.5" /> Update
                </Button>
                {installedRecord.previousVersion ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => window.ndDsh.ndExtensions.rollback(installedRecord.id))}>
                    <Undo2 className="size-3.5" /> Roll back to v{installedRecord.previousVersion}
                  </Button>
                ) : null}
                {updateAvailable && catalogRecord ? <span className="text-[10px] text-faint">v{catalogRecord.version} is available</span> : null}
                {installedRecord.source.kind !== 'builtin' ? (
                  <Button size="sm" variant="ghost" className="ml-auto text-destructive" disabled={busy} onClick={() => void run(() => window.ndDsh.ndExtensions.uninstall(installedRecord.id))}>
                    Uninstall
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function MetaItem({ label, title, children }: { label: string; title?: string; children: React.ReactNode }): React.ReactNode {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <dt className="m-0 shrink-0 text-[10px] text-faint">{label}</dt>
      <dd className="m-0 min-w-0 truncate text-[11px] text-soft" title={title}>{children}</dd>
    </div>
  )
}

function EmptyExtensions({ title, detail }: { title: string; detail: string }): React.ReactNode {
  return (
    <div className="rounded-xl border border-dashed border-border-soft bg-surface-0/20 px-6 py-12 text-center">
      <Package className="mx-auto size-6 text-faint" aria-hidden="true" />
      <h4 className="mt-3 text-sm font-semibold text-foreground">{title}</h4>
      <p className="mx-auto mt-1 max-w-[360px] text-[11px] leading-5 text-faint">{detail}</p>
    </div>
  )
}

const THUMBNAIL_FLUSH_MS = 60

/**
 * Fetches wallpaper thumbnails on demand for the rows a surface actually shows.
 *
 * Rows announce themselves through `queueThumbnail` as they scroll into view;
 * the ids collected within one flush window go out as a single broker call. The
 * decode happens in the nd-core sidecar, so the main process never blocks and a
 * repeat view of the same library is served from its cache.
 */
function useLazyWallpaperThumbnails(
  target: { extensionId: string; viewId: string; context: NdContext } | null,
  channel?: { actionId?: string; folder?: string | null | undefined; extra?: Record<string, unknown> | undefined } | undefined,
): { thumbs: Record<string, string>; queueThumbnail(id: string): void } {
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const thumbsRef = useRef<Record<string, string>>({})
  const queued = useRef<Set<string>>(new Set())
  const inFlight = useRef(false)
  const flushHandle = useRef<number | null>(null)
  const targetRef = useRef(target)
  targetRef.current = target
  const channelRef = useRef(channel)
  channelRef.current = channel

  const scheduleFlush = (): void => {
    if (flushHandle.current !== null) return
    flushHandle.current = window.setTimeout(() => {
      flushHandle.current = null
      void pump()
    }, THUMBNAIL_FLUSH_MS)
  }

  const pump = async (): Promise<void> => {
    const current = targetRef.current
    if (!current || inFlight.current) return
    const ids = [...queued.current]
    if (ids.length === 0) return
    queued.current.clear()
    inFlight.current = true
    try {
      const folder = channelRef.current?.folder
      const result = await window.ndDsh.ndExtensions.invoke({
        extensionId: current.extensionId,
        contributionId: current.viewId,
        contributionKind: 'view',
        context: current.context,
        caller: 'user',
        input: {
          action: channelRef.current?.actionId ?? 'thumbnails',
          ids,
          ...(folder ? { folder } : {}),
          ...(channelRef.current?.extra ?? {}),
        },
      })
      const fetched = result.ok && result.value && typeof result.value === 'object'
        ? (result.value as { thumbnails?: Array<{ id?: unknown; dataUrl?: unknown }> }).thumbnails
        : undefined
      if (Array.isArray(fetched) && fetched.length > 0) {
        const next = { ...thumbsRef.current }
        for (const entry of fetched) {
          if (typeof entry?.id === 'string' && typeof entry?.dataUrl === 'string') next[entry.id] = entry.dataUrl
        }
        thumbsRef.current = next
        setThumbs(next)
      }
    } catch {
      // A row that never resolves keeps its placeholder; not worth an error toast.
    } finally {
      inFlight.current = false
      if (queued.current.size > 0) scheduleFlush()
    }
  }

  const queueThumbnail = (id: string): void => {
    if (thumbsRef.current[id] !== undefined || queued.current.has(id)) return
    queued.current.add(id)
    scheduleFlush()
  }

  // Switching library, context, source folder, or collection invalidates every
  // id seen so far; the same filename can exist in two folders with different
  // images.
  useEffect(() => {
    thumbsRef.current = {}
    queued.current.clear()
    setThumbs({})
  }, [target, channel?.folder, (channel?.extra as { id?: string } | undefined)?.id])

  useEffect(() => () => {
    if (flushHandle.current !== null) {
      window.clearTimeout(flushHandle.current)
      flushHandle.current = null
    }
  }, [])

  return { thumbs, queueThumbnail }
}

/**
 * One wallpaper grid cell's image. Reports itself the first time it scrolls near
 * the viewport so the parent can batch a thumbnail request; until the decode
 * comes back it shows the same placeholder as a row with no image at all.
 */
function LazyWallpaperThumb({ id, alt, dataUrl, onVisible, imgClassName, iconClassName }: {
  id: string
  alt: string
  dataUrl?: string | undefined
  onVisible(id: string): void
  imgClassName?: string | undefined
  iconClassName?: string | undefined
}): React.ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const onVisibleRef = useRef(onVisible)
  onVisibleRef.current = onVisible

  useEffect(() => {
    if (dataUrl !== undefined) return
    const node = ref.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      onVisibleRef.current(id)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        onVisibleRef.current(id)
        observer.disconnect()
        return
      }
    }, { rootMargin: '240px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [id, dataUrl])

  return (
    <div ref={ref} className="size-full">
      {dataUrl ? (
        <img
          src={dataUrl}
          alt={alt}
          className={imgClassName ?? "size-full object-cover transition-transform duration-200 group-hover/thumb:scale-105"}
          loading="lazy"
        />
      ) : (
        <div className="flex size-full items-center justify-center text-faint">
          <Image className={iconClassName ?? "size-6"} />
        </div>
      )}
    </div>
  )
}

/**
 * The wallpaper card grid shared by the play-folder library and Discovery's
 * setup-folder listing. Images decode lazily: each cell reports itself through
 * `queueThumbnail` the first time it scrolls near the viewport.
 */
function WallpaperLibraryGrid({ rows, thumbs, queueThumbnail, busy, onPreview, onApply, onCollect }: {
  rows: NdViewRow[]
  thumbs: Record<string, string>
  queueThumbnail(id: string): void
  busy: boolean
  onPreview(row: NdViewRow): void
  onApply(row: NdViewRow): void
  onCollect?(row: NdViewRow): void
}): React.ReactNode {
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3 max-h-[440px] overflow-y-auto pr-1">
      {rows.map((row) => {
        const isActive = row.meta === 'Active'
        return (
          <div
            key={row.id}
            className={cn(
              "group/card relative flex flex-col justify-between rounded-lg border p-3 transition-colors",
              isActive
                ? "border-primary/60 bg-primary/10 shadow-sm ring-1 ring-primary/40"
                : "border-border-soft bg-surface-0/50 hover:bg-surface-0/80"
            )}
          >
            <div
              className="group/thumb relative mb-2.5 h-28 w-full cursor-pointer overflow-hidden rounded-md border border-border-soft bg-surface-2/60 transition-colors hover:border-primary/50"
              onClick={() => onPreview(row)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPreview(row) } }}
              title={`Preview ${row.title}`}
            >
              <LazyWallpaperThumb
                id={row.id}
                alt={row.title}
                dataUrl={thumbs[row.id] ?? row.thumbnail}
                onVisible={queueThumbnail}
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover/thumb:opacity-100">
                <span className="flex items-center gap-1 rounded bg-black/75 px-2 py-1 text-[11px] font-medium text-white shadow">
                  <Eye className="size-3.5" /> Preview
                </span>
              </div>
            </div>

            <div className="flex items-start justify-between gap-2 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <div className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded",
                  isActive ? "bg-primary text-primary-foreground" : "bg-surface-2 text-foreground/80"
                )}>
                  <Image className="size-3.5" />
                </div>
                <div className="min-w-0">
                  <span className="block truncate text-xs font-medium text-foreground" title={row.title}>
                    {row.title}
                  </span>
                  {row.body ? (
                    <span className="block truncate text-[10px] text-faint" title={row.body}>
                      {row.body}
                    </span>
                  ) : null}
                </div>
              </div>
              {row.meta ? (
                <Badge variant={isActive ? "default" : "outline"} className="text-[10px] shrink-0">
                  {row.meta}
                </Badge>
              ) : null}
            </div>

            <div className="mt-3 flex items-center justify-between border-t border-border-soft/60 pt-2">
              <span className="text-[10px] text-faint">
                {isActive ? 'Active wallpaper' : 'Available'}
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[11px] px-2"
                  disabled={busy}
                  onClick={() => onPreview(row)}
                  title="Preview wallpaper"
                >
                  <Eye className="mr-1 size-3" /> Preview
                </Button>
                {onCollect ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 text-faint hover:text-primary"
                    disabled={busy}
                    onClick={() => onCollect(row)}
                    title="Save to collections"
                  >
                    <FolderPlus className="size-3.5" />
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant={isActive ? "secondary" : "outline"}
                  className="h-6 text-[11px] px-2.5"
                  disabled={busy || isActive}
                  onClick={() => onApply(row)}
                >
                  {isActive ? 'Active' : 'Apply'}
                </Button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Discovery's remote-link cards. Rows carry the link source in `path`
 * (`user` or `bundle`); bundle rows are read-only and save into My links
 * instead of applying — collecting from Discovery never touches the desktop.
 */
function WallpaperLinksGrid({ rows, thumbs, queueThumbnail, busy, onPreview, onApply, onRemove, onSave, savedUrls, onCollect, onEdit, rowCategories, bundleEditable }: {
  rows: NdViewRow[]
  thumbs: Record<string, string>
  queueThumbnail(id: string): void
  busy: boolean
  onPreview(row: NdViewRow): void
  onApply(row: NdViewRow): void
  /** Omit for read-only row lists (curated collections) to hide the trash. */
  onRemove?: ((row: NdViewRow) => void) | undefined
  /** When present, the primary action saves to My links instead of applying. */
  onSave?(row: NdViewRow): void
  savedUrls?: Set<string>
  /** Dev-only: edit affordance for bundle cards. */
  onEdit?(row: NdViewRow): void
  /** When present, cards get a "save to collections" affordance. */
  onCollect?(row: NdViewRow): void
  /** row id → bundle category label, rendered as a small chip on the card. */
  rowCategories?: Record<string, string>
  /** Dev-only: bundle cards gain edit/remove affordances. */
  bundleEditable?: boolean
}): React.ReactNode {
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3 max-h-[400px] overflow-y-auto pr-1">
      {rows.map((row) => {
        const isActive = row.meta === 'Active'
        const isBundle = row.path === 'bundle'
        const isSaved = onSave ? (savedUrls?.has(row.body ?? '') ?? false) : false
        return (
          <div
            key={row.id}
            className={cn(
              "group/card relative flex flex-col justify-between rounded-lg border p-3 transition-colors",
              isActive
                ? "border-primary/60 bg-primary/10 shadow-sm ring-1 ring-primary/40"
                : "border-border-soft bg-surface-0/50 hover:bg-surface-0/80"
            )}
          >
            <div
              className="group/thumb relative mb-2.5 h-28 w-full cursor-pointer overflow-hidden rounded-md border border-border-soft bg-surface-2/60 transition-colors hover:border-primary/50"
              onClick={() => onPreview(row)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPreview(row) } }}
              title={`Preview ${row.title}`}
            >
              <LazyWallpaperThumb
                id={row.id}
                alt={row.title}
                dataUrl={thumbs[row.id] ?? row.thumbnail}
                onVisible={queueThumbnail}
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover/thumb:opacity-100">
                <span className="flex items-center gap-1 rounded bg-black/75 px-2 py-1 text-[11px] font-medium text-white shadow">
                  <Eye className="size-3.5" /> Preview
                </span>
              </div>
            </div>

            <div className="flex items-start justify-between gap-2 min-w-0">
              <div className="min-w-0">
                <span className="block truncate text-xs font-medium text-foreground" title={row.title}>
                  {row.title}
                </span>
                <span className="block truncate text-[10px] text-faint font-mono" title={row.body}>
                  {row.body}
                </span>
              </div>
              <Badge variant="outline" className={cn("text-[10px] shrink-0", isBundle && "border-violet-500/30 text-violet-500")}>
                {isBundle ? 'ND' : row.path === 'file' ? 'File' : 'Yours'}
              </Badge>
              {rowCategories?.[row.id] ? (
                <Badge variant="outline" className="text-[10px] shrink-0" title="Bundle category">
                  {rowCategories[row.id]}
                </Badge>
              ) : null}
            </div>

            <div className="mt-3 flex items-center justify-between border-t border-border-soft/60 pt-2">
              <span className="text-[10px] text-faint" title={isActive ? undefined : onSave ? 'Saved links live in My links; apply them from there' : 'Applying downloads the image to your wallpaper cache first'}>
                {isActive ? 'Active wallpaper' : isBundle ? 'Curated by ND' : 'Saved by you'}
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[11px] px-2"
                  disabled={busy}
                  onClick={() => onPreview(row)}
                  title="Preview linked image"
                >
                  <Eye className="mr-1 size-3" /> Preview
                </Button>
                {onSave ? (
                  <Button
                    size="sm"
                    variant={isSaved ? "secondary" : "outline"}
                    className="h-6 text-[11px] px-2.5"
                    disabled={busy || isSaved}
                    onClick={() => onSave(row)}
                    title={isSaved ? 'Already in My links' : 'Add this link to My links without changing your wallpaper'}
                  >
                    {isSaved ? <><Check className="mr-1 size-3" /> Saved</> : <><Plus className="mr-1 size-3" /> Save</>}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant={isActive ? "secondary" : "outline"}
                    className="h-6 text-[11px] px-2.5"
                    disabled={busy || isActive}
                    onClick={() => onApply(row)}
                    title={isActive ? undefined : 'Download (if needed) and set as wallpaper'}
                  >
                    {isActive ? 'Active' : 'Apply'}
                  </Button>
                )}
                {onCollect ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 text-faint hover:text-primary"
                    disabled={busy}
                    onClick={() => onCollect(row)}
                    title="Save to collections"
                  >
                    <FolderPlus className="size-3.5" />
                  </Button>
                ) : null}
                {!isBundle && onRemove ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 text-faint hover:text-destructive"
                    disabled={busy}
                    onClick={() => onRemove(row)}
                    title="Remove this link"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                ) : bundleEditable ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 text-faint hover:text-foreground"
                      disabled={busy}
                      onClick={() => onEdit?.(row)}
                      title="Edit this ND bundle link (dev builds write the in-repo bundle file)"
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 text-faint hover:text-destructive"
                      disabled={busy}
                      onClick={() => onRemove?.(row)}
                      title="Remove this link from the ND bundle (dev builds write the in-repo bundle file)"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ExtensionViewDialog({
  target,
  organization,
  state,
  onClose,
  onError,
  onChanged,
  onOpenBrowser,
}: {
  target: { extensionId: string; viewId: string; context: NdContext } | null
  organization: OrganizationSnapshot | null
  state?: NdExtensionsStateView | undefined
  onClose(): void
  onError(message: string): void
  onChanged(): Promise<void>
  onOpenBrowser?: ((tabId: string) => Promise<void>) | undefined
}): React.ReactNode {
  const [data, setData] = useState<NdViewData | null>(null)
  const [loadedTarget, setLoadedTarget] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ title: string; body?: string } | null>(null)
  const [previewItem, setPreviewItem] = useState<NdViewRow | null>(null)
  const [previewDetail, setPreviewDetail] = useState<WallpaperPreviewDetail | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState('name')
  // Wallpaper Studio surfaces. `studioTab` splits Library / Now playing; the
  // Library holds every source as a sub-tab (play folder, setup folder, links,
  // collections, bundle). `previewSource` says which row list an open preview
  // belongs to, so the overlay and its apply button reach the right host.
  const [studioTab, setStudioTab] = useState<'library' | 'now'>('library')
  const [discoveryTab, setDiscoveryTab] = useState<'folders' | 'links' | 'collections' | 'bundle'>('folders')
  const [previewSource, setPreviewSource] = useState<'library' | 'setup' | 'links' | 'collection'>('library')
  const [linksData, setLinksData] = useState<{ user: WallpaperLink[]; bundle: WallpaperLink[]; defaultFolder: string | null; bundleEditable: boolean } | null>(null)
  // ND bundle curation (dev builds only): the active category chip filter and
  // the inline add/edit form. `null` category means "All".
  const [bundleCategory, setBundleCategory] = useState<string | null>(null)
  const [bundleEdit, setBundleEdit] = useState<{ mode: 'add' } | { mode: 'edit'; link: WallpaperLink } | null>(null)
  const [bundleDraft, setBundleDraft] = useState({ url: '', title: '', thumb: '', category: '' })
  // Folders source: linked folders + the system Pictures default, with the
  // play-source multi-select that decides what rotation draws from.
  const [foldersData, setFoldersData] = useState<{ folders: { path: string; count: number }[]; defaultFolder: string; sources: string[] } | null>(null)
  // Which source the Folders grid browses: a linked folder (path) or a
  // collection (id) — exactly the things "Play from" can select, so an active
  // play source is always visible right here.
  const [activeFolder, setActiveFolder] = useState<string | null>(null)
  const [browseCollectionId, setBrowseCollectionId] = useState<string | null>(null)
  const [folderRows, setFolderRows] = useState<NdViewRow[] | null>(null)
  const [folderRowsFor, setFolderRowsFor] = useState<string | null>(null)
  const [folderQuery, setFolderQuery] = useState('')
  const [addUrl, setAddUrl] = useState('')
  const [addLinkBusy, setAddLinkBusy] = useState(false)
  const [nowDetail, setNowDetail] = useState<WallpaperPreviewDetail | null>(null)
  const [nowLoading, setNowLoading] = useState(false)
  // Collections: named playable sets, plus the "save to collections" picker
  // that every image card can open.
  const [collectionsData, setCollectionsData] = useState<{ collections: WallpaperCollection[]; rotateCollectionId: string } | null>(null)
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null)
  const [picker, setPicker] = useState<{ item: { kind: WallpaperCollectionEntryKind; ref: string; title: string }; saveLink: boolean } | null>(null)
  const [pickerChecked, setPickerChecked] = useState<Set<string>>(new Set())
  const [pickerNewName, setPickerNewName] = useState('')
  const [pickerBusy, setPickerBusy] = useState(false)
  const [newCollectionName, setNewCollectionName] = useState('')
  const [createCollectionBusy, setCreateCollectionBusy] = useState(false)
  // Thumbnails are fetched for rows that actually scroll into view instead of
  // arriving inside the view payload: a 4K library decoded eagerly in the main
  // process froze the whole app for seconds on every open.
  const { thumbs, queueThumbnail } = useLazyWallpaperThumbnails(target)
  const { thumbs: folderThumbs, queueThumbnail: queueFolderThumbnail } = useLazyWallpaperThumbnails(target, { folder: activeFolder ?? undefined })
  const { thumbs: linkThumbs, queueThumbnail: queueLinkThumbnail } = useLazyWallpaperThumbnails(target, { actionId: 'links-thumbnails' })
  const { thumbs: collectionThumbs, queueThumbnail: queueCollectionThumbnail } = useLazyWallpaperThumbnails(target, { actionId: 'collections-thumbnails', extra: { id: selectedCollectionId ?? '' } })
  const targetGeneration = useRef({ target, revision: 0 })
  if (targetGeneration.current.target !== target) {
    targetGeneration.current = { target, revision: targetGeneration.current.revision + 1 }
  }
  const closeDialog = (): void => {
    targetGeneration.current.revision += 1
    setSelected(null)
    setPreviewItem(null)
    setPreviewDetail(null)
    onClose()
  }

  useEffect(() => () => { targetGeneration.current.revision += 1 }, [])
  const targetKey = target ? `${target.extensionId}:${target.viewId}:${contextKey(target.context)}` : null
  const currentData = target && data && loadedTarget === targetKey
    && data.extensionId === target.extensionId && data.viewId === target.viewId
    && contextKey(data.context) === contextKey(target.context) ? data : null

  useEffect(() => {
    setQuery('')
    setSortBy('name')
  }, [target])

  useEffect(() => {
    setData(null)
    setLoadedTarget(null)
    setLoadError(null)
    setSelected(null)
    setPreviewItem(null)
    setPreviewDetail(null)
    setStudioTab('library')
    setDiscoveryTab('folders')
    setPreviewSource('library')
    setLinksData(null)
    setFoldersData(null)
    setActiveFolder(null)
    setBrowseCollectionId(null)
    setFolderRows(null)
    setFolderRowsFor(null)
    setFolderQuery('')
    setAddUrl('')
    setNowDetail(null)
    setCollectionsData(null)
    setSelectedCollectionId(null)
    setPicker(null)
    setPickerChecked(new Set())
    setPickerNewName('')
    if (!target || !targetKey) {
      return
    }
    // Keep-alive web views: an already-live view (opened before, backgrounded
    // from the header tab strip) keeps its iframe and game state — reuse the
    // admitted data instead of minting a fresh asset token via loadView.
    const live = lookupKeepAliveView(targetKey)
    if (live) {
      setData(live)
      setLoadedTarget(targetKey)
      return
    }
    let mounted = true
    void window.ndDsh.ndExtensions.loadView(target.extensionId, target.viewId, target.context)
      .then((next) => {
        if (!mounted) {
          // A canceled load never owned a frame. Revoke its unused capability
          // instead of consuming a live-token slot until TTL expiration.
          if (next.webView?.token) void window.ndDsh.ndExtensions.closeWebView(next.webView.token).catch(() => undefined)
          return
        }
        if (next.kind === 'web' && next.webView?.url) admitKeepAliveView(next)
        setData(next)
        setLoadedTarget(targetKey)
      })
      .catch((cause) => {
        if (!mounted) return
        const message = cause instanceof Error ? cause.message : String(cause)
        setLoadError(message)
        onError(message)
      })
    return () => { mounted = false }
  }, [target])

  useEffect(() => {
    // Web views are keep-alive surfaces: polling would mint fresh asset tokens
    // behind a live iframe. Package UIs drive their own updates via the bridge.
    if (!target || !currentData?.refreshIntervalMs || currentData.kind === 'web') return
    let mounted = true
    let loading = false
    let failed = false
    const timer = setInterval(() => {
      if (loading || failed) return
      loading = true
      void window.ndDsh.ndExtensions.loadView(target.extensionId, target.viewId, target.context)
        .then((next) => { if (mounted) setData(next) })
        .catch((cause) => {
          if (!mounted) return
          failed = true
          onError(cause instanceof Error ? cause.message : String(cause))
        })
        .finally(() => { loading = false })
    }, currentData.refreshIntervalMs)
    return () => { mounted = false; clearInterval(timer) }
  }, [target, currentData?.refreshIntervalMs])

  const sortKeys = currentData?.rows[0]?.sortValues ? Object.keys(currentData.rows[0].sortValues) : []
  const visibleRows = (currentData?.rows ?? [])
    .filter((row) => !query.trim() || `${row.title} ${row.body ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((left, right) => sortKeys.length === 0 ? 0 : sortBy === 'name'
      ? left.title.localeCompare(right.title)
      : (right.sortValues?.[sortBy] ?? -1) - (left.sortValues?.[sortBy] ?? -1))

  const isDetail = currentData?.kind === 'detail'
  const isWebView = currentData?.kind === 'web' && Boolean(currentData.webView?.url)
  // Keep-alive docking: the dialog renders a placeholder slot; the shell-level
  // host docks the live iframe container inside it. Unmounting the slot (dialog closed)
  // backgrounds the view without unmounting its iframe.
  const webViewDockKey = isWebView && currentData ? extensionViewKey(currentData) : null
  const dockWebViewSlot = useCallback((el: HTMLDivElement | null) => {
    if (webViewDockKey) dockKeepAliveView(webViewDockKey, el)
  }, [webViewDockKey])
  const keepAliveViews = useExtensionKeepAlive().views
  useEffect(() => {
    // Closing this view from the keep-alive tab strip while its dialog is open
    // must drop the dialog too, instead of leaving an empty slot behind.
    if (!webViewDockKey) return
    if (!keepAliveViews.some((view) => view.key === webViewDockKey)) onClose()
  }, [webViewDockKey, keepAliveViews, onClose])
  const isTranslate = target?.extensionId === 'nd.translate' && target.viewId === 'translator'
    && currentData?.extensionId === target.extensionId && currentData.viewId === target.viewId
    && contextKey(currentData.context) === contextKey(target.context)
  const isWallpaperStudio = target?.extensionId === 'nd.wallpaper-manager' && target.viewId === 'wallpaper-studio'
  const globalActions = isDetail
    ? currentData?.actions.filter((action) => action.id !== 'apply' && action.id !== 'preview' && action.id !== 'thumbnails' && !action.id.startsWith('links-') && !action.id.startsWith('collections-') && !action.id.startsWith('folders-') && !action.id.startsWith('play-sources')) ?? []
    : []

  // --- Wallpaper Studio Discovery & Now playing -------------------------------

  const loadDiscoveryLinks = useCallback(async (): Promise<void> => {
    if (!target) return
    try {
      const res = await window.ndDsh.ndExtensions.invoke({
        extensionId: target.extensionId,
        contributionId: target.viewId,
        contributionKind: 'view',
        context: target.context,
        caller: 'user',
        input: { action: 'links-list' },
      })
      if (!res.ok) throw new Error(res.error?.message ?? 'Could not load wallpaper links')
      const value = (res.value ?? {}) as { user?: WallpaperLink[]; bundle?: WallpaperLink[]; defaultFolder?: unknown; bundleEditable?: unknown }
      setLinksData({
        user: Array.isArray(value.user) ? value.user : [],
        bundle: Array.isArray(value.bundle) ? value.bundle : [],
        defaultFolder: typeof value.defaultFolder === 'string' ? value.defaultFolder : null,
        bundleEditable: value.bundleEditable === true,
      })
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [target, onError])

  const loadFolders = useCallback(async (): Promise<void> => {
    if (!target) return
    try {
      const res = await window.ndDsh.ndExtensions.invoke({
        extensionId: target.extensionId,
        contributionId: target.viewId,
        contributionKind: 'view',
        context: target.context,
        caller: 'user',
        input: { action: 'folders-list' },
      })
      if (!res.ok) throw new Error(res.error?.message ?? 'Could not load linked folders')
      const value = (res.value ?? {}) as { folders?: { path?: unknown; count?: unknown }[]; defaultFolder?: unknown; sources?: unknown }
      const folders = (Array.isArray(value.folders) ? value.folders : [])
        .filter((entry): entry is { path: string; count: number } => typeof entry?.path === 'string')
        .map((entry) => ({ path: entry.path, count: typeof entry.count === 'number' ? entry.count : 0 }))
      setFoldersData({
        folders,
        defaultFolder: typeof value.defaultFolder === 'string' ? value.defaultFolder : '',
        sources: Array.isArray(value.sources) ? value.sources.filter((item): item is string => typeof item === 'string') : [],
      })
      setActiveFolder((current) => {
        if (current && folders.some((folder) => folder.path === current)) return current
        return folders[0]?.path ?? null
      })
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [target, onError])

  const loadFolderRows = useCallback(async (): Promise<void> => {
    if (!target || !activeFolder) return
    try {
      const res = await window.ndDsh.ndExtensions.invoke({
        extensionId: target.extensionId,
        contributionId: target.viewId,
        contributionKind: 'view',
        context: target.context,
        caller: 'user',
        input: { folder: activeFolder },
      })
      if (!res.ok) throw new Error(res.error?.message ?? 'Could not load the folder')
      const records = Array.isArray(res.value) ? res.value as Record<string, unknown>[] : []
      setFolderRowsFor(activeFolder)
      setFolderRows(records.map((rec, idx) => ({
        id: typeof rec.id === 'string' ? rec.id : `folder-${idx}`,
        title: typeof rec.title === 'string' ? rec.title : `Wallpaper ${idx + 1}`,
        ...(typeof rec.detail === 'string' ? { body: rec.detail } : {}),
        ...(typeof rec.status === 'string' ? { meta: rec.status } : {}),
        ...(typeof rec.path === 'string' ? { path: rec.path } : {}),
      })))
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [target, activeFolder, onError])

  const setPlaySources = useCallback(async (sources: string[]): Promise<void> => {
    if (!target) return
    try {
      const res = await window.ndDsh.ndExtensions.invoke({
        extensionId: target.extensionId,
        contributionId: target.viewId,
        contributionKind: 'view',
        context: target.context,
        caller: 'user',
        input: { action: 'play-sources-set', sources },
      })
      if (!res.ok) {
        onError(res.error?.message ?? 'Could not update the play sources')
        return
      }
      const value = (res.value ?? {}) as { sources?: unknown }
      setFoldersData((current) => current ? {
        ...current,
        sources: Array.isArray(value.sources) ? value.sources.filter((item): item is string => typeof item === 'string') : [],
      } : current)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [target, onError])

  const loadCollections = useCallback(async (): Promise<void> => {
    if (!target) return
    try {
      const res = await window.ndDsh.ndExtensions.invoke({
        extensionId: target.extensionId,
        contributionId: target.viewId,
        contributionKind: 'view',
        context: target.context,
        caller: 'user',
        input: { action: 'collections-list' },
      })
      if (!res.ok) throw new Error(res.error?.message ?? 'Could not load collections')
      const value = (res.value ?? {}) as { collections?: WallpaperCollection[]; rotateCollectionId?: unknown }
      setCollectionsData({
        collections: Array.isArray(value.collections) ? value.collections : [],
        rotateCollectionId: typeof value.rotateCollectionId === 'string' ? value.rotateCollectionId : '',
      })
      setSelectedCollectionId((current) => {
        if (current && value.collections?.some((collection) => collection.id === current)) return current
        return value.collections?.[0]?.id ?? null
      })
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [target, onError])

  useEffect(() => {
    if (!isWallpaperStudio || !target || previewItem) return
    if (studioTab === 'library') {
      if (discoveryTab === 'folders') {
        if (!foldersData) void loadFolders()
        if (!collectionsData) void loadCollections()
        if (foldersData && activeFolder && folderRowsFor !== activeFolder) void loadFolderRows()
      } else if (discoveryTab === 'collections') {
        if (!collectionsData) void loadCollections()
      } else if ((discoveryTab === 'links' || discoveryTab === 'bundle') && !linksData) {
        void loadDiscoveryLinks()
      } else if (discoveryTab === 'bundle' && linksData?.bundleEditable && !collectionsData) {
        // The dev bundle editor offers collection names as category options.
        void loadCollections()
      }
    } else if (studioTab === 'now' && !linksData) {
      // Now playing also reports an active Discovery link as the current wallpaper.
      void loadDiscoveryLinks()
    }
  }, [isWallpaperStudio, target, studioTab, discoveryTab, foldersData, collectionsData, folderRowsFor, activeFolder, browseCollectionId, linksData, previewItem, loadFolders, loadFolderRows, loadDiscoveryLinks, loadCollections])

  // The Folders grid always shows something playable when there is anything
  // to play: pick the first linked folder, else the first collection, so an
  // active "Play from" source is never invisible.
  useEffect(() => {
    if (!foldersData || activeFolder || browseCollectionId) return
    if (foldersData.folders[0]) {
      setActiveFolder(foldersData.folders[0]!.path)
    } else if (collectionsData?.collections[0]) {
      setBrowseCollectionId(collectionsData.collections[0]!.id)
    }
  }, [foldersData, collectionsData, activeFolder, browseCollectionId])

  const selectedCollection = useMemo(
    () => collectionsData?.collections.find((collection) => collection.id === selectedCollectionId) ?? null,
    [collectionsData, selectedCollectionId],
  )
  const collectionRows: NdViewRow[] = useMemo(
    () => (selectedCollection?.entries ?? []).map((entry) => ({
      id: entry.id,
      title: entry.title,
      body: entry.ref,
      path: entry.kind,
      ...(collectionThumbs[entry.id] ? { thumbnail: collectionThumbs[entry.id] } : {}),
    })),
    [selectedCollection, collectionThumbs],
  )
  // The collection currently browsed from the Folders tab (its play source can
  // be checked there), rendered with the same thumbnails as the Collections tab.
  const browsedCollection = useMemo(
    () => collectionsData?.collections.find((collection) => collection.id === browseCollectionId) ?? null,
    [collectionsData, browseCollectionId],
  )
  const { thumbs: browseCollectionThumbs, queueThumbnail: queueBrowseCollectionThumbnail } = useLazyWallpaperThumbnails(
    target,
    { actionId: 'collections-thumbnails', extra: { id: browseCollectionId ?? '' } },
  )
  const browseCollectionRows: NdViewRow[] = useMemo(
    () => (browsedCollection?.entries ?? []).map((entry) => ({
      id: entry.id,
      title: entry.title,
      body: entry.ref,
      path: entry.kind,
      ...(browseCollectionThumbs[entry.id] ? { thumbnail: browseCollectionThumbs[entry.id] } : {}),
    })),
    [browsedCollection, browseCollectionThumbs],
  )

  /** Collections the user can save into: curated ND collections are read-only. */
  const editableCollections = useMemo(
    () => (collectionsData?.collections ?? []).filter((collection) => collection.source !== 'bundle'),
    [collectionsData],
  )

  // --- Save-to-collections picker ----------------------------------------------

  const openCollectionPicker = (item: { kind: WallpaperCollectionEntryKind; ref: string; title: string }, saveLink: boolean): void => {
    setPicker({ item, saveLink })
    setPickerChecked(new Set())
    setPickerNewName('')
    if (!collectionsData) void loadCollections()
  }

  const confirmPicker = async (): Promise<void> => {
    if (!picker || !target) return
    setPickerBusy(true)
    try {
      const ids = [...pickerChecked]
      if (ids.length > 0) {
        const res = await window.ndDsh.ndExtensions.invoke({
          extensionId: target.extensionId,
          contributionId: target.viewId,
          contributionKind: 'view',
          context: target.context,
          caller: 'user',
          input: {
            action: 'collections-add',
            collectionIds: ids,
            items: [{ kind: picker.item.kind, ref: picker.item.ref, title: picker.item.title }],
            saveLink: picker.saveLink,
          },
        })
        if (!res.ok) {
          onError(res.error?.message ?? 'Could not save to the collection')
          return
        }
      } else if (picker.saveLink) {
        // No collection chosen: a Discovery save still lands in My links.
        const res = await window.ndDsh.ndExtensions.invoke({
          extensionId: target.extensionId,
          contributionId: target.viewId,
          contributionKind: 'view',
          context: target.context,
          caller: 'user',
          input: { action: 'links-add', url: picker.item.ref, title: picker.item.title },
        })
        if (!res.ok) {
          onError(res.error?.message ?? 'Could not save that link')
          return
        }
      }
      setPicker(null)
      await Promise.all([
        picker.saveLink ? loadDiscoveryLinks() : Promise.resolve(),
        loadCollections(),
      ])
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPickerBusy(false)
    }
  }

  const createCollection = async (name: string): Promise<WallpaperCollection | null> => {
    if (!target || !name.trim()) return null
    try {
      const res = await window.ndDsh.ndExtensions.invoke({
        extensionId: target.extensionId,
        contributionId: target.viewId,
        contributionKind: 'view',
        context: target.context,
        caller: 'user',
        input: { action: 'collections-create', name: name.trim() },
      })
      if (!res.ok) {
        onError(res.error?.message ?? 'Could not create the collection')
        return null
      }
      const created = (res.value as { collection?: WallpaperCollection }).collection ?? null
      await loadCollections()
      if (created) setSelectedCollectionId(created.id)
      return created
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
      return null
    }
  }

  const handleCreateCollection = async (): Promise<void> => {
    if (!newCollectionName.trim()) return
    setCreateCollectionBusy(true)
    try {
      if (await createCollection(newCollectionName)) setNewCollectionName('')
    } finally {
      setCreateCollectionBusy(false)
    }
  }

  const createPickerCollection = async (): Promise<void> => {
    if (!picker || !pickerNewName.trim()) return
    setPickerBusy(true)
    try {
      const created = await createCollection(pickerNewName)
      setPickerNewName('')
      if (created) setPickerChecked((current) => new Set(current).add(created.id))
    } finally {
      setPickerBusy(false)
    }
  }


  const linkRowFrom = (link: WallpaperLink, source: 'user' | 'bundle'): NdViewRow => ({
    id: link.id,
    title: link.title,
    body: link.url,
    ...(link.active ? { meta: 'Active' } : {}),
    ...(linkThumbs[link.id] ? { thumbnail: linkThumbs[link.id] } : {}),
    path: source,
  })
  const userLinkRows: NdViewRow[] = useMemo(
    () => (linksData?.user ?? []).map((link) => linkRowFrom(link, 'user')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [linksData?.user, linkThumbs],
  )
  const bundleLinkRows: NdViewRow[] = useMemo(
    () => (linksData?.bundle ?? [])
      .filter((link) => bundleCategory === null || (link.category ?? '') === bundleCategory)
      .map((link) => linkRowFrom(link, 'bundle')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [linksData?.bundle, linkThumbs, bundleCategory],
  )
  /** Category chips for the ND bundle tab: label → entry count, sorted. */
  const bundleCategories = useMemo(() => {
    const counts = new Map<string, number>()
    for (const link of linksData?.bundle ?? []) {
      const key = link.category ?? ''
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [linksData?.bundle])
  const bundleCategoryLabels = useMemo(
    () => Object.fromEntries((linksData?.bundle ?? []).filter((link) => link.category).map((link) => [link.id, link.category as string])),
    [linksData?.bundle],
  )
  /** Category choices for the bundle editor: your collection names, plus any category already in use. */
  const bundleCategoryOptions = useMemo(() => {
    const names = new Set<string>()
    for (const collection of collectionsData?.collections ?? []) names.add(collection.name)
    for (const link of linksData?.bundle ?? []) if (link.category) names.add(link.category)
    if (bundleDraft.category) names.add(bundleDraft.category)
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [collectionsData?.collections, linksData?.bundle, bundleDraft.category])

  const activeLink = useMemo(
    () => [...(linksData?.user ?? []), ...(linksData?.bundle ?? [])].find((link) => link.active) ?? null,
    [linksData],
  )
  // Bundle cards check this set to flip their Save button into "Saved".
  const savedLinkUrls = useMemo(
    () => new Set((linksData?.user ?? []).map((link) => link.url)),
    [linksData],
  )

  // --- ND bundle curation (dev builds only) ------------------------------------
  // Packaged builds refuse these hosts in the main process; the UI only shows
  // the affordances when links-list reports bundleEditable.
  const invokeWallpaperAction = async (action: string, input: Record<string, unknown>): Promise<unknown> => {
    if (!target) throw new Error('Wallpaper Studio is not open')
    const res = await window.ndDsh.ndExtensions.invoke({
      extensionId: target.extensionId,
      contributionId: target.viewId,
      contributionKind: 'view',
      context: target.context,
      caller: 'user',
      input: { ...input, action },
    })
    if (!res.ok) throw new Error(res.error?.message ?? 'The ND bundle edit failed')
    return res.value
  }
  const openBundleAdd = (): void => {
    setBundleDraft({ url: '', title: '', thumb: '', category: bundleCategory ?? '' })
    setBundleEdit({ mode: 'add' })
  }
  const openBundleEdit = (row: NdViewRow): void => {
    const link = (linksData?.bundle ?? []).find((entry) => entry.id === row.id)
    if (!link) return
    setBundleDraft({ url: link.url, title: link.title, thumb: link.thumbUrl ?? '', category: link.category ?? '' })
    setBundleEdit({ mode: 'edit', link })
  }
  const submitBundleEdit = async (): Promise<void> => {
    if (!bundleEdit) return
    const draft = {
      url: bundleDraft.url.trim(),
      title: bundleDraft.title.trim(),
      thumb: bundleDraft.thumb.trim(),
      category: bundleDraft.category.trim(),
    }
    setBusy(true)
    try {
      if (bundleEdit.mode === 'add') await invokeWallpaperAction('bundle-add', draft)
      else await invokeWallpaperAction('bundle-update', { id: bundleEdit.link.id, ...draft })
      setBundleEdit(null)
      await loadDiscoveryLinks()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const removeBundleLink = async (row: NdViewRow): Promise<void> => {
    setBusy(true)
    try {
      await invokeWallpaperAction('bundle-remove', { id: row.id })
      await loadDiscoveryLinks()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const activeRow = useMemo(
    () => currentData?.rows.find((row) => row.meta === 'Active') ?? null,
    [currentData],
  )

  useEffect(() => {
    if (!isWallpaperStudio || studioTab !== 'now' || !target || (!activeRow && !activeLink)) {
      setNowDetail(null)
      return
    }
    let mounted = true
    setNowLoading(true)
    const input = activeLink
      ? { id: activeLink.id, source: activeLink.source, action: 'links-preview' }
      : { id: activeRow!.id, action: 'preview' }
    void window.ndDsh.ndExtensions.invoke({
      extensionId: target.extensionId,
      contributionId: target.viewId,
      contributionKind: 'view',
      context: target.context,
      caller: 'user',
      input,
    }).then((res) => {
      if (!mounted) return
      if (res.ok && res.value && typeof res.value === 'object') setNowDetail(res.value as WallpaperPreviewDetail)
    }).catch(() => {
      // Keep the placeholder; not every active image can be previewed.
    }).finally(() => {
      if (mounted) setNowLoading(false)
    })
    return () => { mounted = false }
  }, [isWallpaperStudio, studioTab, target, activeRow?.id, activeLink?.id, activeLink?.source, activeLink, activeRow])

  // A collection preview can come from the Collections tab or from browsing a
  // collection inside the Folders tab; both address the same host.
  const previewCollectionId = discoveryTab === 'folders' ? browseCollectionId : selectedCollectionId

  useEffect(() => {
    if (!previewItem || !target) {
      setPreviewDetail(null)
      setPreviewLoading(false)
      return
    }
    let active = true
    setPreviewLoading(true)
    setPreviewDetail({
      id: previewItem.id,
      filename: previewItem.title,
      path: previewItem.body ?? '',
      ...(previewItem.thumbnail ? { thumbnail: previewItem.thumbnail } : {}),
    })

    void window.ndDsh.ndExtensions.invoke({
      extensionId: target.extensionId,
      contributionId: target.viewId,
      contributionKind: 'view',
      context: target.context,
      caller: 'user',
      input: previewSource === 'links'
        ? { id: previewItem.id, source: previewItem.path === 'bundle' ? 'bundle' : 'user', action: 'links-preview' }
        : previewSource === 'collection' && previewCollectionId
          ? { id: previewItem.id, collectionId: previewCollectionId, action: 'collections-preview' }
          : previewSource === 'setup' && activeFolder
            ? { id: previewItem.id, folder: activeFolder, action: 'preview' }
            : { id: previewItem.id, action: 'preview' },
    }).then((res) => {
      if (!active) return
      if (res.ok && res.value && typeof res.value === 'object') {
        const val = res.value as WallpaperPreviewDetail
        setPreviewDetail(val)
      }
    }).catch(() => {
      // keep fallback previewDetail
    }).finally(() => {
      if (active) setPreviewLoading(false)
    })

    return () => { active = false }
  }, [previewItem, target, previewSource, activeFolder, previewCollectionId])

  // The rows an open preview can navigate across depend on where it was opened.
  const folderRowsFiltered: NdViewRow[] = useMemo(
    () => (folderRows ?? []).filter((row) => !folderQuery.trim() || `${row.title} ${row.body ?? ''}`.toLowerCase().includes(folderQuery.trim().toLowerCase())),
    [folderRows, folderQuery],
  )
  const browseRows = previewSource === 'links'
    ? (discoveryTab === 'bundle' ? bundleLinkRows : userLinkRows)
    : previewSource === 'collection'
      ? (discoveryTab === 'folders' ? browseCollectionRows : collectionRows)
      : previewSource === 'setup'
        ? folderRowsFiltered
        : visibleRows
  const openPreview = (row: NdViewRow, source: 'library' | 'setup' | 'links' | 'collection'): void => {
    setPreviewSource(source)
    setPreviewItem(row)
  }
  const previewIndex = previewItem ? browseRows.findIndex((r) => r.id === previewItem.id) : -1
  const isPreviewActive = Boolean(
    previewItem && browseRows.find((r) => r.id === previewItem.id)?.meta === 'Active'
  )

  const handlePrevPreview = (): void => {
    if (browseRows.length === 0) return
    const idx = previewIndex <= 0 ? browseRows.length - 1 : previewIndex - 1
    const nextRow = browseRows[idx]
    if (nextRow) setPreviewItem(nextRow)
  }

  const handleNextPreview = (): void => {
    if (browseRows.length === 0) return
    const idx = previewIndex >= browseRows.length - 1 ? 0 : previewIndex + 1
    const nextRow = browseRows[idx]
    if (nextRow) setPreviewItem(nextRow)
  }

  const runAction = async (actionId: string, host: string, row?: { id: string; title: string }, extraInput?: Record<string, unknown>): Promise<void> => {
    if (!target) return
    setBusy(true)
    try {
      const input = row
        ? host === 'note.open' || host === 'note.delete'
          ? { noteId: row.id }
          : host === 'capture.copy' || host === 'capture.export'
            ? { captureId: row.id }
            : { id: row.id }
        : {}
      const result = await window.ndDsh.ndExtensions.invoke({
        extensionId: target.extensionId,
        contributionId: target.viewId,
        contributionKind: 'view',
        context: target.context,
        caller: 'user',
        input: { ...input, ...(extraInput ?? {}), action: actionId },
      })
      if (!result.ok) {
        onError(result.error?.message ?? 'The action failed')
        return
      }
      if (host === 'note.open' && result.value && typeof result.value === 'object') {
        const value = result.value as { title?: string; body?: string }
        setSelected({
          title: value.title ?? row?.title ?? 'Note',
          ...(typeof value.body === 'string' ? { body: value.body } : {}),
        })
        return
      }
      await onChanged()
      const reloaded = await window.ndDsh.ndExtensions.loadView(target.extensionId, target.viewId, target.context)
      setData(reloaded)
      if (actionId.startsWith('links-')) await loadDiscoveryLinks()
      if (actionId.startsWith('folders-')) await loadFolders()
      if (actionId.startsWith('collections-')) await Promise.all([loadCollections(), loadDiscoveryLinks(), loadFolders()])
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const handleSetPreviewWallpaper = async (): Promise<void> => {
    if (!previewItem) return
    if (previewSource === 'links') {
      await runAction('links-apply', 'os.wallpaper.links.apply', previewItem, { source: previewItem.path === 'bundle' ? 'bundle' : 'user' })
      return
    }
    if (previewSource === 'collection' && previewCollectionId) {
      await runAction('collections-apply', 'os.wallpaper.collections.apply', previewItem, { collectionId: previewCollectionId })
      return
    }
    await runAction(
      'apply',
      'os.wallpaper.applySelected',
      previewItem,
      previewSource === 'setup' && linksData?.defaultFolder ? { folder: linksData.defaultFolder } : undefined,
    )
  }

  const handleAddLink = async (): Promise<void> => {
    if (!target || !addUrl.trim()) return
    setAddLinkBusy(true)
    try {
      const result = await window.ndDsh.ndExtensions.invoke({
        extensionId: target.extensionId,
        contributionId: target.viewId,
        contributionKind: 'view',
        context: target.context,
        caller: 'user',
        input: { action: 'links-add', url: addUrl.trim() },
      })
      if (!result.ok) {
        onError(result.error?.message ?? 'Could not add that link')
        return
      }
      setAddUrl('')
      await loadDiscoveryLinks()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAddLinkBusy(false)
    }
  }

  useEffect(() => {
    if (!previewItem) return
    const handleKeyDown = (e: KeyboardEvent) => {
      const targetEl = e.target as HTMLElement | null
      const tag = targetEl?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || targetEl?.isContentEditable) return

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        handlePrevPreview()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        handleNextPreview()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        void handleSetPreviewWallpaper()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setPreviewItem(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [previewItem, previewIndex, browseRows])

  return (
    <>
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) closeDialog() }}>
      <DialogContent className={cn("max-h-[90vh] overflow-y-auto border-border-strong bg-surface-1 transition-all", isDetail || isTranslate || isWebView ? "max-w-3xl sm:max-w-4xl" : "max-w-xl")}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isDetail && !isTranslate ? <Image className="size-4 text-primary" /> : null}
            {previewItem ? `Preview: ${previewItem.title}` : currentData?.title ?? 'Extension view'}
          </DialogTitle>
          <DialogDescription>
            {target ? `${target.extensionId} · ${describeContextForUi(target.context, organization)}` : ''}
          </DialogDescription>
        </DialogHeader>

        {isTranslate && target ? (
          <SurfaceErrorBoundary label="ND Translate" resetKey={targetKey ?? undefined} onError={onError}>
            <Suspense fallback={<p className="text-xs text-faint" role="status">Loading ND Translate…</p>}>
              <NdTranslateView key={targetKey} context={target.context} onOpenBrowser={onOpenBrowser ? async (tabId) => {
                const revision = targetGeneration.current.revision
                await openExtensionProviderTab(target, tabId,
                  () => targetGeneration.current.target === target && targetGeneration.current.revision === revision,
                  onOpenBrowser, closeDialog)
              } : undefined} />
            </Suspense>
          </SurfaceErrorBoundary>
        ) : isWebView && currentData?.webView ? (
          <div
            ref={dockWebViewSlot}
            title={currentData.title}
            className="h-[480px] w-full rounded-md border border-border-soft bg-black sm:h-[540px]"
          />
        ) : !currentData ? (
          <p className="text-xs text-faint" role={loadError ? 'alert' : 'status'}>{loadError ?? 'Loading extension view…'}</p>
        ) : <>
        {!previewItem && isDetail && globalActions.length > 0
          && (!isWallpaperStudio || (studioTab === 'library' && discoveryTab === 'folders')) ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-soft bg-surface-0/60 p-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold text-foreground mr-1">Actions:</span>
              {globalActions.map((action) => (
                <Button
                  key={action.id}
                  size="sm"
                  variant={action.id === 'next' ? 'default' : 'outline'}
                  className="h-7 text-xs"
                  disabled={busy}
                  onClick={() => void runAction(action.id, action.host)}
                >
                  {action.id === 'prev' ? <SkipBack className="mr-1.5 size-3.5" /> : null}
                  {action.id === 'next' ? <SkipForward className="mr-1.5 size-3.5" /> : null}
                  {action.id === 'random' ? <Shuffle className="mr-1.5 size-3.5" /> : null}
                  {action.id === 'choose' ? <Image className="mr-1.5 size-3.5" /> : null}
                  {action.title}
                </Button>
              ))}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => {
                if (!target) return
                void window.ndDsh.ndExtensions.loadView(target.extensionId, target.viewId, target.context)
                  .then(setData)
                  .catch((cause) => onError(cause instanceof Error ? cause.message : String(cause)))
              }}
            >
              <RefreshCw className="mr-1 size-3" /> Refresh
            </Button>
          </div>
        ) : null}

        {!previewItem && isWallpaperStudio ? (
          <div className="flex items-center gap-1 rounded-md border border-border-soft bg-surface-0/60 p-1" role="tablist" aria-label="Wallpaper Studio sections">
            {([
              ['library', 'Library', Image],
              ['now', 'Now playing', MonitorPlay],
            ] as const).map(([tabId, label, Icon]) => (
              <button
                key={tabId}
                type="button"
                role="tab"
                aria-selected={studioTab === tabId}
                onClick={() => setStudioTab(tabId)}
                className={cn(
                  'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
                  studioTab === tabId
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-soft hover:bg-surface-2 hover:text-foreground'
                )}
              >
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>
        ) : null}

        {!previewItem && isWallpaperStudio && studioTab === 'library' ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1 rounded-md border border-border-soft bg-surface-0/60 p-0.5" role="tablist" aria-label="Library sources">
                {([
                  ['folders', 'Folders', FolderOpen],
                  ['links', 'My links', Link2],
                  ['collections', 'Collections', Layers],
                  ['bundle', 'ND bundle', ShieldCheck],
                ] as const).map(([tabId, label, Icon]) => (
                  <button
                    key={tabId}
                    type="button"
                    role="tab"
                    aria-selected={discoveryTab === tabId}
                    onClick={() => setDiscoveryTab(tabId)}
                    className={cn(
                      'flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors',
                      discoveryTab === tabId
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'text-soft hover:bg-surface-2 hover:text-foreground'
                    )}
                  >
                    <Icon className="size-3.5" /> {label}
                  </button>
                ))}
              </div>
              {discoveryTab === 'links' ? (
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={busy || (linksData?.user.length ?? 0) === 0}
                    onClick={() => void runAction('links-next', 'os.wallpaper.links.next')}
                    title="Apply the next saved link in order"
                  >
                    <SkipForward className="mr-1 size-3.5" /> Next
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={busy || (linksData?.user.length ?? 0) === 0}
                    onClick={() => void runAction('links-random', 'os.wallpaper.links.random')}
                    title="Apply a random saved link"
                  >
                    <Shuffle className="mr-1 size-3.5" /> Shuffle
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={busy}
                    onClick={() => void runAction('links-export', 'os.wallpaper.links.export')}
                    title="Save your links as a shareable JSON bundle"
                  >
                    <Download className="mr-1 size-3.5" /> Export
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={busy}
                    onClick={() => void runAction('links-import', 'os.wallpaper.links.import')}
                    title="Merge links from a JSON bundle file"
                  >
                    <Upload className="mr-1 size-3.5" /> Import
                  </Button>
                </div>
              ) : null}
            </div>

            {discoveryTab === 'folders' ? (
              foldersData === null ? (
                <p className="text-xs text-faint" role="status">Loading your folders…</p>
              ) : (
                <div className="space-y-3">
                  {foldersData.folders.length > 0 || collectionsData?.collections.length ? (
                    <div className="rounded-md border border-border-soft bg-surface-0/40 px-3 py-2">
                      <p className="mb-1.5 text-[11px] font-semibold text-foreground">Play from</p>
                      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                        {foldersData.folders.map((folder) => {
                          const ref = `folder:${folder.path}`
                          return (
                            <label key={ref} className="flex cursor-pointer items-center gap-1.5 text-xs text-soft">
                              <input
                                type="checkbox"
                                style={{ accentColor: 'var(--primary)' }}
                                className="size-3.5 shrink-0"
                                checked={foldersData.sources.includes(ref)}
                                onChange={() => {
                                  const next = new Set(foldersData.sources)
                                  if (next.has(ref)) next.delete(ref)
                                  else next.add(ref)
                                  void setPlaySources([...next])
                                }}
                              />
                              {folder.path.split(/[\\/]/).pop() || folder.path}
                              <span className="text-[10px] text-faint">{folder.count}</span>
                            </label>
                          )
                        })}
                        {(collectionsData?.collections ?? []).map((collection) => {
                          const ref = `collection:${collection.id}`
                          return (
                            <label key={ref} className="flex cursor-pointer items-center gap-1.5 text-xs text-soft">
                              <input
                                type="checkbox"
                                style={{ accentColor: 'var(--primary)' }}
                                className="size-3.5 shrink-0"
                                checked={foldersData.sources.includes(ref)}
                                onChange={() => {
                                  const next = new Set(foldersData.sources)
                                  if (next.has(ref)) next.delete(ref)
                                  else next.add(ref)
                                  void setPlaySources([...next])
                                }}
                              />
                              {collection.name}
                              <span className="text-[10px] text-faint">{collection.entries.length}</span>
                            </label>
                          )
                        })}
                      </div>
                      <p className="mt-1.5 text-[10px] text-faint">
                        {foldersData.sources.length === 0
                          ? foldersData.folders.length === 0
                            ? 'Nothing checked: link a folder (or solo a collection below) to give rotation something to play.'
                            : 'Nothing checked: rotation plays every linked folder.'
                          : 'Rotation, Next, and Shuffle draw from exactly these folders and collections.'}
                      </p>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-1.5">
                    {foldersData.folders.map((folder) => (
                      <span
                        key={folder.path}
                        className={cn(
                          'flex items-center gap-1 rounded-full border py-1 pl-3 pr-1 text-xs font-medium transition-colors',
                          activeFolder === folder.path
                            ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                            : 'border-border-soft bg-surface-0/60 text-soft hover:bg-surface-2 hover:text-foreground'
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => { setActiveFolder(folder.path); setBrowseCollectionId(null) }}
                          className="flex items-center gap-1.5"
                          title={folder.path}
                        >
                          {folder.path.split(/[\\/]/).pop() || folder.path}
                          <span className={cn('rounded-full px-1.5 text-[10px]', activeFolder === folder.path ? 'bg-primary-foreground/20' : 'bg-surface-2')}>
                            {folder.count}
                          </span>
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove folder ${folder.path}`}
                          disabled={busy}
                          onClick={() => void runAction('folders-remove', 'os.wallpaper.folders.remove', undefined, { path: folder.path })}
                          className={cn(
                            'grid size-5 place-items-center rounded-full transition-colors',
                            activeFolder === folder.path ? 'hover:bg-primary-foreground/20' : 'hover:bg-surface-2 hover:text-destructive'
                          )}
                          title="Unlink this folder"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </span>
                    ))}
                    {(collectionsData?.collections ?? []).map((collection) => (
                      <span
                        key={collection.id}
                        className={cn(
                          'flex items-center rounded-full border py-1 text-xs font-medium transition-colors',
                          browseCollectionId === collection.id && !activeFolder
                            ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                            : 'border-border-soft bg-surface-0/60 text-soft hover:bg-surface-2 hover:text-foreground'
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => { setBrowseCollectionId(collection.id); setActiveFolder(null) }}
                          className="flex items-center gap-1.5 py-0 pl-3 pr-1"
                          title={`Browse the ${collection.name} collection`}
                        >
                          <Layers className="size-3" />
                          {collection.name}
                          <span className={cn('rounded-full px-1.5 text-[10px]', browseCollectionId === collection.id && !activeFolder ? 'bg-primary-foreground/20' : 'bg-surface-2')}>
                            {collection.entries.length}
                          </span>
                        </button>
                      </span>
                    ))}
                    <span
                      className={cn(
                        'flex items-center rounded-full border border-border-soft bg-surface-0/60 py-1 text-xs font-medium text-soft transition-colors',
                        foldersData.folders.length === 0 && !collectionsData?.collections.length && 'border-dashed'
                      )}
                    >
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void runAction('folders-add', 'os.wallpaper.folders.add')}
                        className="flex items-center gap-1.5 px-3 hover:text-foreground disabled:opacity-50"
                        title="Link a folder to your library"
                      >
                        <FolderPlus className="size-3.5" /> {foldersData.folders.length === 0 && !collectionsData?.collections.length ? 'Link your first folder…' : 'Link folder…'}
                      </button>
                    </span>
                  </div>

                  {browseCollectionId && !activeFolder && browsedCollection ? (
                    browsedCollection.entries.length === 0 ? (
                      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-soft py-8 px-4 text-center">
                        <Layers className="mb-2 size-8 text-faint" />
                        <p className="text-xs text-soft">The {browsedCollection.name} collection is empty.</p>
                        <p className="mt-1 max-w-sm text-[11px] text-faint">
                          Use the folder-plus button on any image card to save images into it.
                        </p>
                      </div>
                    ) : (
                      <WallpaperLinksGrid
                        rows={browseCollectionRows}
                        thumbs={browseCollectionThumbs}
                        queueThumbnail={queueBrowseCollectionThumbnail}
                        busy={busy}
                        onPreview={(row) => openPreview(row, 'collection')}
                        onApply={(row) => void runAction('collections-apply', 'os.wallpaper.collections.apply', row, { collectionId: browsedCollection.id })}
                        onRemove={browsedCollection.source === 'bundle' ? undefined : (row) => void runAction('collections-remove', 'os.wallpaper.collections.removeEntry', undefined, { collectionId: browsedCollection.id, entryId: row.id })}
                      />
                    )
                  ) : foldersData.folders.length === 0 ? (
                    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-soft py-8 px-4 text-center">
                      <FolderOpen className="mb-2 size-8 text-faint" />
                      <p className="text-xs text-soft">No folders or collections yet.</p>
                      <p className="mt-1 max-w-sm text-[11px] text-faint">
                        Link a folder of images to browse it here, save its pictures into collections, and play it as your wallpaper.
                      </p>
                    </div>
                  ) : folderRows === null || activeFolder !== folderRowsFor ? (
                    <p className="text-xs text-faint" role="status">Loading images…</p>
                  ) : folderRowsFiltered.length === 0 ? (
                    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-soft py-8 px-4 text-center">
                      <FolderOpen className="mb-2 size-8 text-faint" />
                      <p className="text-xs text-soft">
                        {folderQuery.trim() ? 'No images match your search.' : 'No images found in this folder.'}
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <Input
                          aria-label="Search folder images"
                          placeholder="Search this folder…"
                          value={folderQuery}
                          onChange={(event) => setFolderQuery(event.target.value)}
                          className="h-8 flex-1 text-xs"
                        />
                        <span className="shrink-0 text-xs text-faint">{folderRowsFiltered.length} images</span>
                      </div>
                      <WallpaperLibraryGrid
                        rows={folderRowsFiltered}
                        thumbs={folderThumbs}
                        queueThumbnail={queueFolderThumbnail}
                        busy={busy}
                        onPreview={(row) => openPreview(row, 'setup')}
                        onApply={(row) => void runAction(
                          'apply',
                          'os.wallpaper.applySelected',
                          row,
                          activeFolder ? { folder: activeFolder } : undefined,
                        )}
                        onCollect={(row) => openCollectionPicker({ kind: 'file', ref: row.path ?? row.body ?? '', title: row.title }, false)}
                      />
                    </>
                  )}
                </div>
              )
            ) : null}

            {discoveryTab === 'collections' ? (
              collectionsData === null ? (
                <p className="text-xs text-faint" role="status">Loading collections…</p>
              ) : (
                <div className="space-y-3">
                  {collectionsData.collections.length === 0 ? (
                    <p className="text-xs text-faint">
                      No collections yet — create one below, then save images into it from Discovery, your folders, or My links.
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {collectionsData.collections.map((collection) => (
                        <button
                          key={collection.id}
                          type="button"
                          onClick={() => setSelectedCollectionId(collection.id)}
                          className={cn(
                            'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                            selectedCollectionId === collection.id
                              ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                              : 'border-border-soft bg-surface-0/60 text-soft hover:bg-surface-2 hover:text-foreground'
                          )}
                        >
                          {collection.name}
                          {collection.source === 'bundle' ? (
                            <ShieldCheck className="size-3 opacity-80" aria-label="Curated by ND" />
                          ) : null}
                          <span className={cn('rounded-full px-1.5 text-[10px]', selectedCollectionId === collection.id ? 'bg-primary-foreground/20' : 'bg-surface-2')}>
                            {collection.entries.length}
                          </span>
                          {collectionsData.rotateCollectionId === collection.id ? <Repeat className="size-3" /> : null}
                        </button>
                      ))}
                    </div>
                  )}

                  <form
                    className="flex items-center gap-2"
                    onSubmit={(event) => { event.preventDefault(); void handleCreateCollection() }}
                  >
                    <Input
                      aria-label="New collection name"
                      placeholder="New collection (e.g. Nature)"
                      value={newCollectionName}
                      onChange={(event) => setNewCollectionName(event.target.value)}
                      className="h-8 flex-1 text-xs"
                    />
                    <Button type="submit" size="sm" className="h-8 shrink-0 text-xs" disabled={createCollectionBusy || !newCollectionName.trim()}>
                      {createCollectionBusy ? <RefreshCw className="mr-1 size-3.5 animate-spin" /> : <Plus className="mr-1 size-3.5" />}
                      Create
                    </Button>
                  </form>

                  {selectedCollection ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-soft bg-surface-0/40 px-3 py-1.5 text-xs">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="truncate font-semibold text-foreground">{selectedCollection.name}</span>
                          {selectedCollection.source === 'bundle' ? (
                            <Badge variant="outline" className="shrink-0 border-violet-500/30 text-[10px] text-violet-500" title="Ships in the ND bundle; read-only">
                              ND
                            </Badge>
                          ) : null}
                          <span className="shrink-0 text-faint">{selectedCollection.entries.length} images</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[11px] px-2"
                            disabled={busy || selectedCollection.entries.length === 0}
                            onClick={() => void runAction('collections-next', 'os.wallpaper.collections.next', undefined, { id: selectedCollection.id })}
                            title="Apply the next image in this collection"
                          >
                            <SkipForward className="mr-1 size-3" /> Next
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[11px] px-2"
                            disabled={busy || selectedCollection.entries.length === 0}
                            onClick={() => void runAction('collections-random', 'os.wallpaper.collections.random', undefined, { id: selectedCollection.id })}
                            title="Apply a random image from this collection"
                          >
                            <Shuffle className="mr-1 size-3" /> Shuffle
                          </Button>
                          <Button
                            size="sm"
                            variant={collectionsData.rotateCollectionId === selectedCollection.id ? 'secondary' : 'outline'}
                            className="h-6 text-[11px] px-2"
                            disabled={busy}
                            onClick={() => void runAction(
                              'collections-rotate',
                              'os.wallpaper.collections.rotate',
                              undefined,
                              { id: collectionsData.rotateCollectionId === selectedCollection.id ? '' : selectedCollection.id },
                            )}
                            title="Auto-rotate this collection on the timer configured in Wallpaper Manager → Settings (0 disables)"
                          >
                            <Repeat className="mr-1 size-3" /> {collectionsData.rotateCollectionId === selectedCollection.id ? 'Rotating' : 'Auto-rotate'}
                          </Button>
                          {selectedCollection.source === 'bundle' ? null : (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 w-6 p-0 text-faint hover:text-destructive"
                              disabled={busy}
                              onClick={() => void runAction('collections-delete', 'os.wallpaper.collections.delete', undefined, { id: selectedCollection.id })}
                              title="Delete this collection (saved links stay in My links)"
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>

                      {collectionRows.length === 0 ? (
                        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-soft py-8 px-4 text-center">
                          <Layers className="mb-2 size-8 text-faint" />
                          <p className="text-xs text-soft">No images in this collection yet.</p>
                          <p className="mt-1 max-w-sm text-[11px] text-faint">
                            Use the folder-plus button on any image card — bundle links, My links, or your folders — to save it here.
                          </p>
                        </div>
                      ) : (
                        <WallpaperLinksGrid
                          rows={collectionRows}
                          thumbs={collectionThumbs}
                          queueThumbnail={queueCollectionThumbnail}
                          busy={busy}
                          onPreview={(row) => openPreview(row, 'collection')}
                          onApply={(row) => void runAction('collections-apply', 'os.wallpaper.collections.apply', row, { collectionId: selectedCollection.id })}
                          onRemove={selectedCollection.source === 'bundle' ? undefined : (row) => void runAction('collections-remove', 'os.wallpaper.collections.removeEntry', undefined, { collectionId: selectedCollection.id, entryId: row.id })}
                        />
                      )}
                      <p className="text-[10px] text-faint">
                        Next and Shuffle play this collection. Auto-rotate keeps it going on the timer in Wallpaper Manager → Settings — set it above 0 minutes.
                      </p>
                    </div>
                  ) : null}
                </div>
              )
            ) : null}

            {discoveryTab === 'links' ? (
              <div className="space-y-3">
                <form
                  className="flex items-center gap-2"
                  onSubmit={(event) => { event.preventDefault(); void handleAddLink() }}
                >
                  <Input
                    aria-label="Image URL"
                    placeholder="Paste a direct image link (https://… .jpg, .png, .webp, .bmp)"
                    value={addUrl}
                    onChange={(event) => setAddUrl(event.target.value)}
                    className="h-8 flex-1 text-xs"
                    inputMode="url"
                    spellCheck={false}
                  />
                  <Button type="submit" size="sm" className="h-8 shrink-0 text-xs" disabled={addLinkBusy || !addUrl.trim()}>
                    {addLinkBusy
                      ? <RefreshCw className="mr-1 size-3.5 animate-spin" />
                      : <Plus className="mr-1 size-3.5" />}
                    {addLinkBusy ? 'Checking…' : 'Add link'}
                  </Button>
                </form>
                {userLinkRows.length === 0 ? (
                  <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-soft py-8 px-4 text-center">
                    <Link2 className="mb-2 size-8 text-faint" />
                    <p className="text-xs text-soft">No saved links yet.</p>
                    <p className="mt-1 max-w-sm text-[11px] text-faint">
                      Paste a direct image URL above to add one, or import a links bundle exported from another ND install.
                    </p>
                  </div>
                ) : (
                  <WallpaperLinksGrid
                    rows={userLinkRows}
                    thumbs={linkThumbs}
                    queueThumbnail={queueLinkThumbnail}
                    busy={busy}
                    onPreview={(row) => openPreview(row, 'links')}
                    onApply={(row) => void runAction('links-apply', 'os.wallpaper.links.apply', row, { source: 'user' })}
                    onRemove={(row) => void runAction('links-remove', 'os.wallpaper.links.remove', row)}
                    onCollect={(row) => openCollectionPicker({ kind: 'link', ref: row.body ?? '', title: row.title }, false)}
                  />
                )}
                <p className="text-[10px] text-faint">
                  Links live in a local JSON file — Export shares them in the same format as the ND bundle. Images download only when you preview or apply a link.
                </p>
              </div>
            ) : null}

            {discoveryTab === 'bundle' ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="ND bundle categories">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={bundleCategory === null}
                      onClick={() => setBundleCategory(null)}
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors',
                        bundleCategory === null
                          ? 'border-primary/50 bg-primary/10 text-primary'
                          : 'border-border-soft text-soft hover:bg-surface-2 hover:text-foreground'
                      )}
                    >
                      All {linksData?.bundle.length ?? 0}
                    </button>
                    {bundleCategories.map(([category, count]) => (
                      <button
                        key={category || 'uncategorized'}
                        type="button"
                        role="tab"
                        aria-selected={bundleCategory === category}
                        onClick={() => setBundleCategory(category)}
                        className={cn(
                          'rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors',
                          bundleCategory === category
                            ? 'border-primary/50 bg-primary/10 text-primary'
                            : 'border-border-soft text-soft hover:bg-surface-2 hover:text-foreground'
                        )}
                      >
                        {category || 'Uncategorized'} {count}
                      </button>
                    ))}
                  </div>
                  {linksData?.bundleEditable ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={busy}
                      onClick={openBundleAdd}
                      title="Add a link to the in-repo ND bundle (dev builds only)"
                    >
                      <Plus className="mr-1 size-3.5" /> Add link
                    </Button>
                  ) : null}
                </div>

                {bundleEdit ? (
                  <form
                    className="space-y-2 rounded-md border border-border-soft bg-surface-0/60 p-3"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void submitBundleEdit()
                    }}
                  >
                    <p className="text-[11px] font-semibold text-foreground">
                      {bundleEdit.mode === 'add' ? 'Add to the ND bundle' : 'Edit ND bundle link'}
                    </p>
                    <input
                      className="h-8 w-full rounded-[7px] border border-border-soft bg-surface-1 px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary/60"
                      placeholder="https://example.com/wallpaper.jpg"
                      title="Image URL (https only, public hosts only)"
                      value={bundleDraft.url}
                      onChange={(event) => setBundleDraft((draft) => ({ ...draft, url: event.target.value }))}
                      required={bundleEdit.mode === 'add'}
                    />
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <input
                        className="h-8 w-full rounded-[7px] border border-border-soft bg-surface-1 px-2 text-[11px] text-foreground outline-none focus:border-primary/60"
                        placeholder="Title"
                        value={bundleDraft.title}
                        onChange={(event) => setBundleDraft((draft) => ({ ...draft, title: event.target.value }))}
                      />
                      <input
                        className="h-8 w-full rounded-[7px] border border-border-soft bg-surface-1 px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary/60"
                        placeholder="Thumb URL (optional)"
                        title="Small cover image shown in the grid before the full image is downloaded"
                        value={bundleDraft.thumb}
                        onChange={(event) => setBundleDraft((draft) => ({ ...draft, thumb: event.target.value }))}
                      />
                      <select
                        className="h-8 w-full rounded-[7px] border border-border-soft bg-surface-1 px-2 text-[11px] text-foreground outline-none focus:border-primary/60"
                        title="Category — reuse a collection name so the filter chips and your collections stay aligned"
                        value={bundleDraft.category}
                        onChange={(event) => setBundleDraft((draft) => ({ ...draft, category: event.target.value }))}
                      >
                        <option value="">Uncategorized</option>
                        {bundleCategoryOptions.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button type="submit" size="sm" variant="outline" className="h-7 text-xs" disabled={busy}>
                        <Check className="mr-1 size-3.5" /> Save
                      </Button>
                      <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={() => setBundleEdit(null)}>
                        Cancel
                      </Button>
                    </div>
                    <p className="text-[10px] text-faint">
                      Dev builds write resources/nd-bundles/wallpaper-links.json in this repo, so the curation lands as a normal git diff.
                    </p>
                  </form>
                ) : null}

                {(linksData?.bundle.length ?? 0) === 0 ? (
                  <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-soft py-8 px-4 text-center">
                    <ShieldCheck className="mb-2 size-8 text-faint" />
                    <p className="text-xs text-soft">
                      {linksData?.bundleEditable
                        ? 'The ND bundle in this repo is empty. Add the first link above.'
                        : 'The ND-curated wallpaper bundle is not available in this install.'}
                    </p>
                  </div>
                ) : bundleLinkRows.length === 0 ? (
                  <p className="text-xs text-faint" role="status">No bundle links in this category yet.</p>
                ) : (
                  <WallpaperLinksGrid
                    rows={bundleLinkRows}
                    thumbs={linkThumbs}
                    queueThumbnail={queueLinkThumbnail}
                    busy={busy}
                    onPreview={(row) => openPreview(row, 'links')}
                    onApply={(row) => void runAction('links-apply', 'os.wallpaper.links.apply', row, { source: 'bundle' })}
                    onRemove={(row) => void removeBundleLink(row)}
                    onSave={(row) => openCollectionPicker({ kind: 'link', ref: row.body ?? '', title: row.title }, true)}
                    savedUrls={savedLinkUrls}
                    onCollect={(row) => openCollectionPicker({ kind: 'link', ref: row.body ?? '', title: row.title }, true)}
                    onEdit={openBundleEdit}
                    rowCategories={bundleCategoryLabels}
                    bundleEditable={linksData?.bundleEditable === true}
                  />
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {!previewItem && isWallpaperStudio && studioTab === 'now' ? (
          activeRow || activeLink ? (
            <div className="space-y-3">
              <div className="relative flex min-h-[280px] max-h-[50vh] items-center justify-center overflow-hidden rounded-xl border border-border-soft bg-black/70 p-3 shadow-inner">
                {nowDetail?.dataUrl || nowDetail?.thumbnail ? (
                  <img
                    src={nowDetail.dataUrl ?? nowDetail.thumbnail}
                    alt={activeLink?.title ?? activeRow?.title ?? 'Current wallpaper'}
                    className="max-h-[46vh] max-w-full rounded-md object-contain shadow-2xl"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center p-8 text-faint">
                    <Image className="mb-2 size-12 opacity-50" />
                    <p className="text-xs">{nowLoading ? 'Loading current wallpaper…' : 'No wallpaper preview available'}</p>
                  </div>
                )}
                {nowLoading ? (
                  <div className="absolute top-3 right-3 flex items-center gap-1.5 rounded-full bg-black/75 px-3 py-1 text-[11px] font-medium text-white shadow backdrop-blur-sm">
                    <RefreshCw className="size-3 animate-spin" /> Loading…
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-soft bg-surface-0/40 px-3 py-2 text-xs">
                <div className="min-w-0">
                  <span className="block max-w-xs truncate font-semibold text-foreground" title={activeLink?.title ?? activeRow?.title}>
                    {activeLink?.title ?? activeRow?.title}
                  </span>
                  {(activeLink?.url ?? activeRow?.body) ? (
                    <p className="mt-0.5 truncate text-[11px] text-faint font-mono" title={activeLink?.url ?? activeRow?.body}>
                      {activeLink?.url ?? activeRow?.body}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => void runAction('prev', 'os.wallpaper.previous')}>
                    <SkipBack className="mr-1 size-3.5" /> Prev
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => void runAction('next', 'os.wallpaper.next')}>
                    Next <SkipForward className="ml-1 size-3.5" />
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => void runAction('random', 'os.wallpaper.random')}>
                    <Shuffle className="mr-1 size-3.5" /> Random
                  </Button>
                </div>
              </div>
              <p className="text-[10px] text-faint">
                Auto-rotation (interval and order) is configured in Wallpaper Manager → Settings. Discovery links you apply appear here too.
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-soft py-8 px-4 text-center">
              <MonitorPlay className="mb-2 size-8 text-faint" />
              <p className="text-xs text-soft">No wallpaper is active yet.</p>
              <p className="mt-1 max-w-sm text-[11px] text-faint">
                Apply one from the Library tab and it will show up here.
              </p>
            </div>
          )
        ) : null}

        {!previewItem && data && !selected && !isDetail ? (
          <div className="flex items-center gap-2">
            <Input aria-label="Search extension view" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 flex-1 text-xs" />
            {sortKeys.length > 0 ? (
              <select aria-label="Sort extension view" value={sortBy} onChange={(event) => setSortBy(event.target.value)} className="h-8 rounded-md border border-border-soft bg-surface-0 px-2 text-xs">
                <option value="name">Name</option>
                {sortKeys.map((key) => <option key={key} value={key}>{key === 'cpu' ? 'CPU' : key === 'pid' ? 'PID' : key === 'memory' ? 'Memory' : key}</option>)}
              </select>
            ) : null}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => {
              if (!target) return
              void window.ndDsh.ndExtensions.loadView(target.extensionId, target.viewId, target.context).then(setData).catch((cause) => onError(cause instanceof Error ? cause.message : String(cause)))
            }}>Refresh</Button>
          </div>
        ) : null}

        {!previewItem && data && !selected && isDetail && visibleRows.length > 0 && !isWallpaperStudio ? (
          <div className="flex items-center gap-2">
            <Input aria-label="Search extension view" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 flex-1 text-xs" />
            <span className="text-xs text-faint shrink-0">{visibleRows.length} rows</span>
          </div>
        ) : null}

        {previewItem ? (
          <div className="flex flex-col space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-soft bg-surface-0/60 p-2">
              <div className="flex items-center gap-2 min-w-0">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => setPreviewItem(null)}
                >
                  <ChevronLeft className="mr-1 size-3.5" /> Back to library
                </Button>
                {previewIndex >= 0 ? (
                  <span className="text-xs text-faint">
                    {previewIndex + 1} of {browseRows.length}
                  </span>
                ) : null}
              </div>

              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2.5 text-xs"
                  disabled={busy || browseRows.length <= 1}
                  onClick={handlePrevPreview}
                  title="Previous wallpaper (Left arrow)"
                >
                  <ChevronLeft className="mr-1 size-3.5" /> Prev
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2.5 text-xs"
                  disabled={busy || browseRows.length <= 1}
                  onClick={handleNextPreview}
                  title="Next wallpaper (Right arrow)"
                >
                  Next <ChevronRight className="ml-1 size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant={isPreviewActive ? "secondary" : "default"}
                  className="h-7 text-xs font-medium"
                  disabled={busy || isPreviewActive}
                  onClick={() => void handleSetPreviewWallpaper()}
                >
                  {isPreviewActive ? (
                    <><Check className="mr-1.5 size-3.5" /> Active Wallpaper</>
                  ) : (
                    <><Image className="mr-1.5 size-3.5" /> Set as Wallpaper</>
                  )}
                </Button>
              </div>
            </div>

            <div className="relative group/viewport flex min-h-[340px] max-h-[58vh] items-center justify-center overflow-hidden rounded-xl border border-border-soft bg-black/70 p-3 shadow-inner">
              {visibleRows.length > 1 ? (
                <button
                  type="button"
                  aria-label="Previous wallpaper"
                  onClick={handlePrevPreview}
                  disabled={busy}
                  className="absolute left-3 top-1/2 -translate-y-1/2 z-10 flex size-9 items-center justify-center rounded-full bg-black/60 text-white shadow-lg backdrop-blur-sm transition-all hover:bg-black/90 hover:scale-110 active:scale-95 disabled:opacity-30"
                >
                  <ChevronLeft className="size-5" />
                </button>
              ) : null}

              {visibleRows.length > 1 ? (
                <button
                  type="button"
                  aria-label="Next wallpaper"
                  onClick={handleNextPreview}
                  disabled={busy}
                  className="absolute right-3 top-1/2 -translate-y-1/2 z-10 flex size-9 items-center justify-center rounded-full bg-black/60 text-white shadow-lg backdrop-blur-sm transition-all hover:bg-black/90 hover:scale-110 active:scale-95 disabled:opacity-30"
                >
                  <ChevronRight className="size-5" />
                </button>
              ) : null}

              {previewDetail?.dataUrl || previewDetail?.thumbnail || previewItem.thumbnail ? (
                <img
                  src={previewDetail?.dataUrl || previewDetail?.thumbnail || previewItem.thumbnail}
                  alt={previewItem.title}
                  className="max-h-[54vh] max-w-full rounded-md object-contain shadow-2xl transition-opacity duration-200"
                />
              ) : (
                <div className="flex flex-col items-center justify-center p-8 text-faint">
                  <Image className="mb-2 size-12 opacity-50" />
                  <p className="text-xs">Loading image preview…</p>
                </div>
              )}

              {previewLoading ? (
                <div className="absolute top-3 right-3 flex items-center gap-1.5 rounded-full bg-black/75 px-3 py-1 text-[11px] font-medium text-white shadow backdrop-blur-sm">
                  <RefreshCw className="size-3 animate-spin" /> Loading full image…
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-soft bg-surface-0/40 px-3 py-2 text-xs">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground truncate max-w-sm" title={previewItem.title}>
                    {previewItem.title}
                  </span>
                  {previewDetail?.width && previewDetail?.height ? (
                    <Badge variant="outline" className="text-[10px] shrink-0 font-mono">
                      {previewDetail.width} × {previewDetail.height}
                    </Badge>
                  ) : null}
                  {typeof previewDetail?.size === 'number' && previewDetail.size > 0 ? (
                    <Badge variant="outline" className="text-[10px] shrink-0 font-mono">
                      {formatFileSize(previewDetail.size)}
                    </Badge>
                  ) : null}
                  {isPreviewActive ? (
                    <Badge variant="default" className="text-[10px] shrink-0">
                      Active
                    </Badge>
                  ) : null}
                </div>
                {previewDetail?.path || previewItem.body ? (
                  <p className="mt-0.5 truncate text-[11px] text-faint font-mono" title={previewDetail?.path ?? previewItem.body}>
                    {previewDetail?.path ?? previewItem.body}
                  </p>
                ) : null}
              </div>

              <div className="flex items-center gap-2 text-[11px] text-faint">
                <span>
                  <kbd className="rounded border border-border-soft bg-surface-2 px-1 py-0.5 font-mono text-[10px]">←</kbd>{' '}
                  <kbd className="rounded border border-border-soft bg-surface-2 px-1 py-0.5 font-mono text-[10px]">→</kbd> Browse ·{' '}
                  <kbd className="rounded border border-border-soft bg-surface-2 px-1 py-0.5 font-mono text-[10px]">Enter</kbd> Set ·{' '}
                  <kbd className="rounded border border-border-soft bg-surface-2 px-1 py-0.5 font-mono text-[10px]">Esc</kbd> Back
                </span>
              </div>
            </div>
          </div>
        ) : selected ? (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-foreground">{selected.title}</h4>
            <p className="max-h-[320px] overflow-y-auto whitespace-pre-wrap text-xs text-soft">{selected.body}</p>
            <Button size="sm" variant="outline" onClick={() => setSelected(null)}>Back to list</Button>
          </div>
        ) : !isWallpaperStudio ? (
          data && visibleRows.length > 0 ? (
            isDetail ? (
              <WallpaperLibraryGrid
                rows={visibleRows}
                thumbs={thumbs}
                queueThumbnail={queueThumbnail}
                busy={busy}
                onPreview={(row) => openPreview(row, 'library')}
                onApply={(row) => void runAction('apply', 'os.wallpaper.applySelected', row)}
                onCollect={(row) => openCollectionPicker({ kind: 'file', ref: row.path ?? row.body ?? '', title: row.title }, false)}
              />
            ) : (
              <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                {visibleRows.map((row) => (
                  <div key={row.id} className="rounded-md border border-border-soft bg-surface-0/40 p-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <span className="block truncate text-xs font-medium text-foreground">{row.title}</span>
                        {row.body ? <span className="mt-0.5 block line-clamp-2 text-[11px] text-faint">{row.body}</span> : null}
                        {row.meta ? <Badge variant="outline">{row.meta}</Badge> : null}
                      </div>
                    </div>
                    {data.actions.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {data.actions.map((action) => (
                          <Button key={action.id} size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={busy || row.actionsDisabled} onClick={() => void runAction(action.id, action.host, row)}>
                            {action.title}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )
          ) : isDetail ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-soft py-10 px-4 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-primary mb-3">
                <Image className="size-6" />
              </div>
              <h4 className="text-sm font-medium text-foreground">No wallpapers in current library</h4>
              <p className="mt-1 max-w-sm text-xs text-faint">
                {data?.empty ?? 'Select a folder containing images (.png, .jpg, .webp) or pick a single file to set as your desktop wallpaper.'}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void runAction('folders-add', 'os.wallpaper.folders.add')}
                >
                  <FolderOpen className="mr-1.5 size-3.5" /> Link Wallpaper Folder
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void runAction('choose', 'os.wallpaper.chooseAndSet')}
                >
                  <Image className="mr-1.5 size-3.5" /> Pick Image File...
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-faint">{query && data?.rows.length ? 'No rows match your search.' : data?.empty ?? 'This view has no rows yet.'}</p>
          )
        ) : null}
        </>}
      </DialogContent>
    </Dialog>

    {picker ? (
      <Dialog open onOpenChange={(open) => { if (!open) setPicker(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Save to collections</DialogTitle>
            <DialogDescription className="truncate">{picker.item.title}</DialogDescription>
          </DialogHeader>
          <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
            {editableCollections.length === 0 ? (
              <p className="text-xs text-faint">
                {(collectionsData?.collections.length ?? 0) === 0
                  ? 'No collections yet — create one below.'
                  : 'Curated ND collections are read-only — create your own below.'}
              </p>
            ) : editableCollections.map((collection) => {
              const alreadyIn = collection.entries.some((entry) => entry.ref === picker.item.ref)
              return (
                <label
                  key={collection.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-border-soft bg-surface-0/40 px-2.5 py-1.5 text-xs transition-colors hover:bg-surface-0/70"
                >
                  <input
                    type="checkbox"
                    style={{ accentColor: 'var(--primary)' }}
                    className="size-3.5 shrink-0"
                    checked={pickerChecked.has(collection.id) || alreadyIn}
                    onChange={() => {
                      if (alreadyIn) return
                      setPickerChecked((current) => {
                        const next = new Set(current)
                        if (next.has(collection.id)) next.delete(collection.id)
                        else next.add(collection.id)
                        return next
                      })
                    }}
                  />
                  <span className="truncate font-medium text-foreground">{collection.name}</span>
                  {alreadyIn ? (
                    <Badge variant="outline" className="ml-auto shrink-0 text-[10px]">Saved</Badge>
                  ) : (
                    <span className="ml-auto shrink-0 text-[10px] text-faint">{collection.entries.length}</span>
                  )}
                </label>
              )
            })}
          </div>
          <div className="flex items-center gap-2">
            <Input
              aria-label="New collection name"
              placeholder="New collection"
              value={pickerNewName}
              onChange={(event) => setPickerNewName(event.target.value)}
              className="h-8 flex-1 text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0 text-xs"
              disabled={pickerBusy || !pickerNewName.trim()}
              onClick={() => void createPickerCollection()}
            >
              {pickerBusy ? <RefreshCw className="mr-1 size-3.5 animate-spin" /> : <Plus className="mr-1 size-3.5" />} Create
            </Button>
          </div>
          {picker.saveLink ? (
            <p className="text-[10px] text-faint">
              This link is also saved to My links, so you can apply or share it later.
            </p>
          ) : null}
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={pickerBusy} onClick={() => setPicker(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={pickerBusy || (pickerChecked.size === 0 && !picker.saveLink)}
              onClick={() => void confirmPicker()}
            >
              {pickerBusy ? <RefreshCw className="mr-1 size-3.5 animate-spin" /> : <Check className="mr-1 size-3.5" />}
              Save{pickerChecked.size > 0 ? ` to ${pickerChecked.size}` : ''}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    ) : null}
    </>
  )
}

/** Plain-language permission summaries; unknown slugs stay honest instead of guessing. */
const PERMISSION_LABELS: Record<string, string> = {
  'notes.read': 'Read your notes',
  'notes.write': 'Create and edit notes',
  'capture.screen': 'Take screen captures',
  'capture.area': 'Capture parts of the screen',
  'capture.read': 'Read saved captures',
  'clipboard.read': 'Read copied text',
  'clipboard.write': 'Write copied text',
  'browser.navigate': 'Navigate the built-in browser',
  'browser.openExternal': 'Open links in your system browser',
  'os.launch': 'Open apps and files on this device',
  'os.wallpaper.write': 'Change desktop wallpaper',
  'process.read': 'See running processes',
  'process.quit': 'Quit running processes',
  'computer.read': 'Read app window screenshots and accessibility trees',
  'vault.read': 'Read saved vault secrets',
  'vault.write': 'Create and delete vault entries',
  'workflow.read': 'Read the project task board',
  'chat.start': 'Start chats as you',
}

function describePermissions(permissions: string[]): string {
  return Array.from(new Set(permissions.map((permission) => PERMISSION_LABELS[permission] ?? permission))).join(', ')
}

function describeSource(kind: string): string {
  return kind === 'builtin' ? 'Bundled with ND' : kind === 'local' ? 'Installed from a folder' : kind === 'remote' ? 'Downloaded on demand' : kind
}
