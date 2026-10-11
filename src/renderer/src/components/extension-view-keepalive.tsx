import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { contextKey } from '../../../shared/nd-context'
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
 * opened view stays mounted — iframe, JS heap, and game state included — until
 * the user closes it from the header tab strip, exactly like a browser tab
 * kept alive in the background.
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

let keepAliveState: ExtensionKeepAliveState = { views: [], dockedKey: null }
const keepAliveListeners = new Set<() => void>()
// Dialog placeholder elements per docked view (not render state: the host
// moves the live iframe container into the slot when it docks).
const keepAliveSlots = new Map<string, HTMLElement>()
const keepAliveParking = new Map<string, HTMLElement>()

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
  if (!keepAliveState.views.some((view) => view.key === key)) {
    keepAliveState = { ...keepAliveState, views: [...keepAliveState.views, { key, data }] }
    emitKeepAliveChange()
  }
  return key
}

export function lookupKeepAliveView(key: string): NdViewData | undefined {
  return keepAliveState.views.find((view) => view.key === key)?.data
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
  const dockedKey = slot ? key : (keepAliveState.dockedKey === key ? null : keepAliveState.dockedKey)
  if (dockedKey !== keepAliveState.dockedKey) {
    keepAliveState = { ...keepAliveState, dockedKey }
    emitKeepAliveChange()
  }
}

/** Truly closes a view: unmounts its iframe and revokes its asset token. */
export function closeKeepAliveView(key: string): void {
  const view = keepAliveState.views.find((entry) => entry.key === key)
  if (!view) return
  keepAliveSlots.delete(key)
  keepAliveState = {
    views: keepAliveState.views.filter((entry) => entry.key !== key),
    dockedKey: keepAliveState.dockedKey === key ? null : keepAliveState.dockedKey,
  }
  emitKeepAliveChange()
  const token = view.data.webView?.token
  if (token) void window.ndDsh.ndExtensions.closeWebView(token).catch(() => { /* token TTL cleans up anyway */ })
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
              'group flex h-6 min-w-0 max-w-[150px] cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs font-semibold transition-colors',
              active
                ? 'border-primary/25 bg-primary/12 text-primary shadow-[0_1px_3px_rgba(0,0,0,0.2)]'
                : 'border-border-strong bg-surface-1/50 text-soft hover:bg-accent hover:text-foreground',
              elsewhere && !active ? 'border-dashed' : '',
            )}
          >
            <SparkIcon className="size-3 shrink-0" />
            <span className="max-w-[62px] shrink-0 truncate text-[9px] font-semibold tracking-[0.04em] text-faint uppercase">{contextLabel}</span>
            <span className="truncate">{view.data.title}</span>
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
