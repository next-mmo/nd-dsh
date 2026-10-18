import { normalizeExtensionRuntimePolicy, type ExtensionRuntimePolicy } from '../../../shared/extension-runtime-policy'
import type { NdExtensionsStateView } from '../../../shared/nd-invocations'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { asNdContext, contextKey, isNdContext } from '../../../shared/nd-context'
import type { NdContext } from '../../../shared/nd-context'
import type { NdViewData } from '../../../shared/nd-invocations'
import type { OrganizationSnapshot } from '../../../shared/organization'
import { describeContextForUi } from '../lib/nd-context-model'
import { cn } from '../lib/utils'
import { SparkIcon } from './Icons'
import { ExtensionWebView } from './ExtensionWebView'
import { SurfaceErrorBoundary } from './surface-error-boundary'

/**
 * React keep-alive for `kind: 'web'` extension views (games, mini-apps). An
 * foreground view owns one iframe. Background retention is profile-owned,
 * opt-in, count-bounded, and subject to idle expiry; release disposes its heap.
 *
 * The live iframes are owned by {@link ExtensionKeepAliveHost}, mounted once
 * at the app shell. While the extension view dialog is open for a view, the
 * host moves that view's stable container into the dialog's placeholder slot; when the
 * dialog closes, the same container moves to hidden parking and the view
 * keeps running in the background. Reopening never reloads the frame: the
 * dialog reuses the admitted view data (and its asset token) instead of
 * calling `loadView` again.
 *
 * Store state is module-level (like self-element-picker): one app shell, one
 * keep-alive registry, consumed from the header tabs, the host, and the
 * extension dialog through `useSyncExternalStore`.
 */

export interface ExtensionKeepAliveView {
  key: string
  data: NdViewData
}

interface ExtensionKeepAliveState {
  views: ExtensionKeepAliveView[]
  dockedKey: string | null
}

interface PersistedKeepAliveEntry {
  key: string
  extensionId: string
  viewId: string
  context: NdContext
  title: string
  version?: string
  updatedAt?: number
  backgroundedAt?: number
}

const KEEP_ALIVE_STORAGE_KEY = 'nd-dsh:extension-keepalive-views'

let runtimePolicy = normalizeExtensionRuntimePolicy(undefined)
const backgroundedAt = new Map<string, number>()
const persistedViews = new Map<string, PersistedKeepAliveEntry>()
const restoringKeys = new Set<string>()
let keepAliveState: ExtensionKeepAliveState = { views: [], dockedKey: null }
const keepAliveListeners = new Set<() => void>()
// Dialog placeholder elements per docked view (not render state: the host
// moves the live iframe container into the slot when it docks).
const keepAliveSlots = new Map<string, HTMLElement>()
const keepAliveParking = new Map<string, HTMLElement>()

function getKeepAliveStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage && typeof window.localStorage.getItem === 'function') {
      return window.localStorage
    }
    if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      return localStorage
    }
  } catch {
    // Storage can be unavailable in restricted or headless test contexts.
  }
  return null
}

function readPersistedKeepAliveViews(): PersistedKeepAliveEntry[] {
  const storage = getKeepAliveStorage()
  if (!storage) return []
  try {
    const raw = storage.getItem(KEEP_ALIVE_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const entries: PersistedKeepAliveEntry[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      if (typeof record.extensionId !== 'string' || !record.extensionId.trim()) continue
      if (typeof record.viewId !== 'string' || !record.viewId.trim()) continue
      if (!isNdContext(record.context)) continue
      const context = asNdContext(record.context)
      const extensionId = record.extensionId.trim()
      const viewId = record.viewId.trim()
      const key = extensionViewKey({ extensionId, viewId, context })
      entries.push({
        key,
        extensionId,
        viewId,
        context,
        title: typeof record.title === 'string' && record.title.trim() ? record.title : viewId,
        ...(typeof record.version === 'string' && record.version ? { version: record.version } : {}),
        ...(typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? { updatedAt: record.updatedAt } : {}),
        ...(typeof record.backgroundedAt === 'number' && Number.isFinite(record.backgroundedAt) ? { backgroundedAt: record.backgroundedAt } : {}),
      })
    }
    return entries
  } catch {
    return []
  }
}

function writePersistedKeepAliveViews(): void {
  const storage = getKeepAliveStorage()
  if (!storage) return
  try {
    if (persistedViews.size === 0) {
      storage.removeItem(KEEP_ALIVE_STORAGE_KEY)
      return
    }
    storage.setItem(KEEP_ALIVE_STORAGE_KEY, JSON.stringify([...persistedViews.values()]))
  } catch {
    // Ignore quota or storage errors; in-memory keep-alive still works.
  }
}

function hydratePersistedKeepAliveViews(): void {
  for (const entry of readPersistedKeepAliveViews()) {
    if (!persistedViews.has(entry.key)) {
      persistedViews.set(entry.key, entry)
    }
  }
}

hydratePersistedKeepAliveViews()

function persistKeepAliveView(key: string, data: NdViewData): void {
  if (data.kind !== 'web') return
  const backgrounded = backgroundedAt.get(key)
  persistedViews.set(key, {
    key,
    extensionId: data.extensionId,
    viewId: data.viewId,
    context: data.context,
    title: data.title,
    ...(data.webView?.version !== undefined ? { version: data.webView.version } : {}),
    ...(data.webView?.updatedAt !== undefined ? { updatedAt: data.webView.updatedAt } : {}),
    ...(backgrounded !== undefined ? { backgroundedAt: backgrounded } : {}),
  })
  writePersistedKeepAliveViews()
}

function emitKeepAliveChange(): void {
  for (const listener of keepAliveListeners) listener()
}

function subscribeKeepAlive(listener: () => void): () => void {
  keepAliveListeners.add(listener)
  return () => {
    keepAliveListeners.delete(listener)
  }
}

export function extensionViewKey(view: Pick<NdViewData, 'extensionId' | 'viewId' | 'context'> & { context: NdContext }): string {
  return `${view.extensionId}:${view.viewId}:${contextKey(view.context)}`
}

/**
 * The context a keep-alive view belongs to, in plain language. The strip sits
 * on the company/project row, so a Personal view must say Personal there — it
 * is not part of the company or project the rest of the row is showing.
 */
export function extensionKeepAliveContextLabel(view: ExtensionKeepAliveView, organization: OrganizationSnapshot | null): string {
  return describeContextForUi(view.data.context, organization)
}

/** Registers a loaded web view as alive (idempotent) and returns its key. */
export function admitKeepAliveView(data: NdViewData): string {
  const key = extensionViewKey(data)
  const existing = keepAliveState.views.find((view) => view.key === key)
  if (!existing) {
    keepAliveState = { ...keepAliveState, views: [...keepAliveState.views, { key, data }] }
    emitKeepAliveChange()
  } else if (existing.data !== data) {
    keepAliveState = {
      ...keepAliveState,
      views: keepAliveState.views.map((view) => (view.key === key ? { key, data } : view)),
    }
    emitKeepAliveChange()
  }
  persistKeepAliveView(key, data)
  return key
}

export function lookupKeepAliveView(key: string): NdViewData | undefined {
  const data = keepAliveState.views.find((view) => view.key === key)?.data
  if (data?.webView?.expiresAt && data.webView.expiresAt <= Date.now()) {
    closeKeepAliveView(key)
    return undefined
  }
  return data
}

/**
 * Marks which view's dialog is open. The dialog mounts/unmounts its slot
 * element through this; a view without a slot is backgrounded but stays alive.
 */
export function dockKeepAliveView(key: string, slot: HTMLElement | null): void {
  if (slot) keepAliveSlots.set(key, slot)
  else {
    // Park before React removes the dialog slot: detaching an iframe first
    // would reload it when reopened. Chromium's atomic move preserves it.
    const container = keepAliveSlots.get(key)?.firstElementChild
    const parking = keepAliveParking.get(key)
    if (container && parking && container.isConnected) parking.moveBefore(container, null)
    keepAliveSlots.delete(key)
  }
  if (slot) backgroundedAt.delete(key)
  else backgroundedAt.set(key, Date.now())
  const persisted = persistedViews.get(key)
  if (persisted) {
    if (slot) delete persisted.backgroundedAt
    else persisted.backgroundedAt = backgroundedAt.get(key)!
    writePersistedKeepAliveViews()
  }
  const dockedKey = slot ? key : (keepAliveState.dockedKey === key ? null : keepAliveState.dockedKey)
  if (dockedKey !== keepAliveState.dockedKey) {
    keepAliveState = { ...keepAliveState, dockedKey }
    emitKeepAliveChange()
  }
  // React StrictMode briefly detaches refs before reattaching the same slot.
  // Reconcile after that cycle so a development mount never destroys its frame.
  queueMicrotask(() => pruneKeepAliveViews())
}

/** Truly closes a view: unmounts its iframe and revokes its asset token. */
export function closeKeepAliveView(key: string): void {
  const hadPersisted = persistedViews.delete(key)
  restoringKeys.delete(key)
  if (hadPersisted) writePersistedKeepAliveViews()
  const view = keepAliveState.views.find((entry) => entry.key === key)
  if (!view) return
  keepAliveSlots.delete(key)
  backgroundedAt.delete(key)
  keepAliveState = {
    views: keepAliveState.views.filter((entry) => entry.key !== key),
    dockedKey: keepAliveState.dockedKey === key ? null : keepAliveState.dockedKey,
  }
  emitKeepAliveChange()
  const token = view.data.webView?.token
  if (token && typeof window !== 'undefined') void window.ndDsh?.ndExtensions?.closeWebView?.(token).catch(() => { /* token TTL cleans up anyway */ })
}

function isPersistedEntryEligible(
  entry: PersistedKeepAliveEntry,
  packages: Map<string, NdExtensionsStateView['packages'][number]>,
  enabled: Set<string>,
  policy: ExtensionRuntimePolicy,
  now: number,
): boolean {
  const installed = packages.get(entry.extensionId)
  if (!installed) return false
  if (Array.isArray(installed.views) && !installed.views.some((view) => view.id === entry.viewId && view.kind === 'web')) {
    return false
  }
  if (!enabled.has(JSON.stringify([entry.extensionId, contextKey(entry.context)]))) return false
  if (entry.version && installed.version !== entry.version) return false
  if (entry.updatedAt && installed.updatedAt !== entry.updatedAt) return false
  if (keepAliveState.dockedKey !== entry.key) {
    if (!policy.backgroundExtensionIds.includes(entry.extensionId) || policy.maxBackgroundViews <= 0) return false
    if (entry.backgroundedAt !== undefined && now - entry.backgroundedAt >= policy.idleTimeoutMinutes * 60_000) return false
  }
  return true
}

function reconcilePersistedKeepAliveViews(
  packages: Map<string, NdExtensionsStateView['packages'][number]>,
  enabled: Set<string>,
  policy: ExtensionRuntimePolicy,
  now = Date.now(),
): void {
  if (keepAliveState.views.length === 0 && persistedViews.size === 0 && restoringKeys.size === 0) {
    hydratePersistedKeepAliveViews()
  }
  let dirty = false
  for (const entry of [...persistedViews.values()]) {
    if (!isPersistedEntryEligible(entry, packages, enabled, policy, now)) {
      persistedViews.delete(entry.key)
      restoringKeys.delete(entry.key)
      dirty = true
    }
  }
  const backgroundEntries = [...persistedViews.values()]
    .filter((entry) => entry.key !== keepAliveState.dockedKey)
    .sort((a, b) => (a.backgroundedAt ?? now) - (b.backgroundedAt ?? now))
  for (const entry of backgroundEntries.slice(0, Math.max(0, backgroundEntries.length - policy.maxBackgroundViews))) {
    persistedViews.delete(entry.key)
    restoringKeys.delete(entry.key)
    dirty = true
  }
  if (dirty) writePersistedKeepAliveViews()

  if (typeof window === 'undefined' || typeof window.ndDsh?.ndExtensions?.loadView !== 'function') return
  for (const entry of [...persistedViews.values()]) {
    if (keepAliveState.views.some((view) => view.key === entry.key) || restoringKeys.has(entry.key)) continue
    restoringKeys.add(entry.key)
    void window.ndDsh.ndExtensions.loadView(entry.extensionId, entry.viewId, entry.context)
      .then((next) => {
        restoringKeys.delete(entry.key)
        const current = persistedViews.get(entry.key)
        if (!current
          || keepAliveState.views.some((view) => view.key === entry.key)
          || next.kind !== 'web'
          || !next.webView?.url
          || !runtimePolicy.backgroundExtensionIds.includes(next.extensionId)
          || runtimePolicy.maxBackgroundViews <= 0) {
          if (next.webView?.token && typeof window !== 'undefined') {
            void window.ndDsh?.ndExtensions?.closeWebView?.(next.webView.token).catch(() => undefined)
          }
          return
        }
        if (!keepAliveSlots.has(entry.key)) {
          backgroundedAt.set(entry.key, current.backgroundedAt ?? Date.now())
        }
        admitKeepAliveView(next)
        pruneKeepAliveViews()
      })
      .catch(() => {
        restoringKeys.delete(entry.key)
        if (persistedViews.delete(entry.key)) writePersistedKeepAliveViews()
      })
  }
}

/**
 * Resets in-memory keep-alive state while retaining storage, simulating a hard
 * renderer reload before {@link reconcileExtensionKeepAlive} runs on boot.
 */
export function resetKeepAliveForReload(): void {
  keepAliveSlots.clear()
  keepAliveParking.clear()
  backgroundedAt.clear()
  persistedViews.clear()
  restoringKeys.clear()
  keepAliveState = { views: [], dockedKey: null }
  hydratePersistedKeepAliveViews()
  emitKeepAliveChange()
}

/** Reconcile live views with current profile authority, including update/uninstall. */
export function reconcileExtensionKeepAlive(state: NdExtensionsStateView): void {
  runtimePolicy = normalizeExtensionRuntimePolicy(state.runtimePolicy)
  const packages = new Map(state.packages.map((item) => [item.id, item]))
  const enabled = new Set(state.activations.filter((item) => item.enabled).map((item) => JSON.stringify([item.extensionId, item.contextKey])))
  for (const view of [...keepAliveState.views]) {
    const installed = packages.get(view.data.extensionId)
    if (!installed || !enabled.has(JSON.stringify([view.data.extensionId, contextKey(view.data.context)]))
      || (view.data.webView?.version && installed.version !== view.data.webView.version)
      || (view.data.webView?.updatedAt && installed.updatedAt !== view.data.webView.updatedAt)) closeKeepAliveView(view.key)
  }
  pruneKeepAliveViews()
  reconcilePersistedKeepAliveViews(packages, enabled, runtimePolicy)
}

export function pruneKeepAliveViews(now = Date.now(), policy: ExtensionRuntimePolicy = runtimePolicy): void {
  const background = keepAliveState.views.filter((view) => view.key !== keepAliveState.dockedKey && backgroundedAt.has(view.key))
    .sort((a, b) => (backgroundedAt.get(a.key) ?? now) - (backgroundedAt.get(b.key) ?? now))
  for (const view of background) {
    if (!policy.backgroundExtensionIds.includes(view.data.extensionId)
      || now - (backgroundedAt.get(view.key) ?? now) >= policy.idleTimeoutMinutes * 60_000
      || (view.data.webView?.expiresAt && view.data.webView.expiresAt <= now)) closeKeepAliveView(view.key)
  }
  const retained = background.filter((view) => lookupKeepAliveView(view.key))
  for (const view of retained.slice(0, Math.max(0, retained.length - policy.maxBackgroundViews))) closeKeepAliveView(view.key)
}

let keepAliveReopenHandler: ((view: ExtensionKeepAliveView) => void) | null = null

/** The app shell registers where a header-tab click reopens the view. */
export function setExtensionKeepAliveReopenHandler(handler: (view: ExtensionKeepAliveView) => void): () => void {
  keepAliveReopenHandler = handler
  return () => {
    if (keepAliveReopenHandler === handler) keepAliveReopenHandler = null
  }
}

export function reopenKeepAliveView(key: string): void {
  const view = keepAliveState.views.find((entry) => entry.key === key)
  if (view) keepAliveReopenHandler?.(view)
}

export function useExtensionKeepAlive(): ExtensionKeepAliveState {
  return useSyncExternalStore(subscribeKeepAlive, getKeepAliveSnapshot, getKeepAliveSnapshot)
}

function getKeepAliveSnapshot(): ExtensionKeepAliveState {
  return keepAliveState
}

/** Keep one portal target for the lifetime of the frame, including while hidden. */
function KeepAliveFrame({ view, docked, onError }: {
  view: ExtensionKeepAliveView
  docked: boolean
  onError: (message: string) => void
}): ReactNode {
  const parkingRef = useRef<HTMLDivElement>(null)
  const [container] = useState(() => document.createElement('div'))

  useLayoutEffect(() => {
    const destination = docked ? keepAliveSlots.get(view.key) : parkingRef.current
    if (!destination) return
    // Move the same DOM/portal target into the dialog. A sibling overlay is
    // hidden by Radix's modal accessibility boundary on every reopen, and its
    // controls also sit outside the dialog's keyboard focus scope.
    if (container.isConnected) destination.moveBefore(container, null)
    else destination.appendChild(container)
  }, [container, docked, view.key])

  useLayoutEffect(() => () => { container.remove() }, [container])

  return (
    <>
      <div ref={(el) => {
        parkingRef.current = el
        if (el) keepAliveParking.set(view.key, el)
        else keepAliveParking.delete(view.key)
      }} hidden />
      {createPortal(
        <SurfaceErrorBoundary label={view.data.title} resetKey={view.key} onError={onError}>
          <ExtensionWebView data={view.data} onError={onError} />
        </SurfaceErrorBoundary>,
        container,
      )}
    </>
  )
}

/** Keeps each iframe mounted, docking its stable container inside the open dialog. */
export function ExtensionKeepAliveHost({ onError }: { onError: (message: string) => void }): ReactNode {
  const { views, dockedKey } = useExtensionKeepAlive()
  useEffect(() => {
    if (!views.some((view) => backgroundedAt.has(view.key))) return
    const timer = window.setInterval(() => pruneKeepAliveViews(), 15_000)
    return () => window.clearInterval(timer)
  }, [views, dockedKey])
  return <>{views.map((view) => (
    <KeepAliveFrame key={view.key} view={view} docked={view.key === dockedKey} onError={onError} />
  ))}</>
}

/**
 * Browser-style tab strip for alive extension views, rendered inline on the
 * header's company/project row (after Manage) — a sub-row item, not part of
 * the main nav. Each tab names the context its view belongs to, and marks
 * itself when that context is not the one the row is currently showing, so a
 * Personal view is never mistaken for the active company's or project's.
 */
export function ExtensionKeepAliveTabs({ organization, activeContext }: {
  organization: OrganizationSnapshot | null
  activeContext: NdContext
}): ReactNode {
  const { views, dockedKey } = useExtensionKeepAlive()
  if (views.length === 0) return null
  return (
    <div
      role="tablist"
      aria-label="Running extension views"
      className="flex shrink-0 items-center gap-[6px]"
    >
      {views.map((view) => {
        const active = view.key === dockedKey
        const contextLabel = extensionKeepAliveContextLabel(view, organization)
        const elsewhere = contextKey(view.data.context) !== contextKey(activeContext)
        return (
          <div
            key={view.key}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            title={`${view.data.title} · ${contextLabel} — click to bring back, × to close`}
            onClick={() => reopenKeepAliveView(view.key)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                reopenKeepAliveView(view.key)
              }
            }}
            className={cn(
              'group flex h-6 w-[240px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs font-semibold transition-colors',
              active
                ? 'border-primary/25 bg-primary/12 text-primary shadow-[0_1px_3px_rgba(0,0,0,0.2)]'
                : 'border-border-strong bg-surface-1/50 text-soft hover:bg-accent hover:text-foreground',
              elsewhere && !active ? 'border-dashed' : '',
            )}
          >
            <SparkIcon className="size-3 shrink-0" />
            <span className="max-w-[62px] shrink-0 truncate text-[9px] font-semibold tracking-[0.04em] text-faint uppercase">{contextLabel}</span>
            <span className="min-w-0 flex-1 truncate">{view.data.title}</span>
            <button
              type="button"
              aria-label={`Close ${view.data.title}`}
              className="ml-0.5 shrink-0 rounded px-0.5 text-[11px] leading-none text-faint hover:bg-border-soft hover:text-destructive"
              onClick={(event) => {
                event.stopPropagation()
                closeKeepAliveView(view.key)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** App-shell glue: a header tab click reopens the view's dialog. */
export function useExtensionKeepAliveReopenHandler(handler: (view: ExtensionKeepAliveView) => void): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  useEffect(() => setExtensionKeepAliveReopenHandler((view) => handlerRef.current(view)), [])
}
