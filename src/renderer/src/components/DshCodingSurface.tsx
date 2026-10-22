import { useEffect, useRef, useState } from 'react'
import type { DshViewState, HarnessStatus, HarnessUpstreamStatus } from '../../../shared/contracts'
import { ExternalIcon, ReloadIcon } from './Icons'
import { BridgePill } from './bridge-pill'
import { cn } from '../lib/utils'
import { useNativeViewOcclusion } from '../lib/use-native-view-occlusion'

interface DshCodingSurfaceProps {
  active: boolean
  inspectOverlayVisible?: boolean
  state: DshViewState | null
  onNotify(message: string): void
}

export function shouldShowDshNativeView(active: boolean, inspectOverlayVisible: boolean): boolean {
  return active && !inspectOverlayVisible
}

/**
 * The DSH view reports load failures and renderer crashes through its page
 * title. Those are the only titles the header surfaces: the product name it
 * also reports is redundant with the app's own chrome.
 */
export function isDshViewFailureTitle(title: string | undefined): boolean {
  return typeof title === 'string' && /^(Load failed|UI renderer exited)/.test(title)
}

/**
 * Renderer-owned frame for the sandboxed DSH WebContentsView. The main
 * process owns navigation and security; this component only synchronizes the
 * visible rectangle and exposes narrow reload/open-external controls.
 */
export function DshCodingSurface({ active, inspectOverlayVisible = false, state, onNotify }: DshCodingSurfaceProps) {
  const occluded = useNativeViewOcclusion()
  const surfaceRef = useRef<HTMLDivElement>(null)
  const uiPreview = window.ndDshRuntimeMode === 'ui-preview'
  const [runtimeStatus, setRuntimeStatus] = useState<HarnessStatus | null>(null)
  const [upstreamStatus, setUpstreamStatus] = useState<HarnessUpstreamStatus | null>(null)
  const [statusReadError, setStatusReadError] = useState<string>()
  // Native WebContentsViews always composite above renderer DOM. Yield the
  // view briefly so inspect result dialogs and their controls stay reachable.
  const nativeViewVisible = shouldShowDshNativeView(active, inspectOverlayVisible || occluded)
  const runtimeError = statusReadError
    ?? (runtimeStatus?.state === 'error'
      ? runtimeStatus.error || 'The DSH runtime failed to start.'
      : runtimeStatus && !runtimeStatus.sourceReady
        ? 'The DSH runtime is not set up on this install. Set it up in Settings → Capabilities, or reinstall ND.'
        : undefined)
  const viewFailure = runtimeError ?? (isDshViewFailureTitle(state?.title) ? state?.title : undefined)

  useEffect(() => {
    let disposed = false
    void window.ndDsh.harness.status()
      .then((status) => {
        if (!disposed) {
          setRuntimeStatus(status)
          setStatusReadError(undefined)
        }
      })
      .catch((cause) => {
        if (!disposed) setStatusReadError(cause instanceof Error ? cause.message : String(cause))
      })
    const off = window.ndDsh.harness.onStatus((status) => {
      if (!disposed) {
        setRuntimeStatus(status)
        setStatusReadError(undefined)
      }
    })
    return () => {
      disposed = true
      off()
    }
  }, [])

  useEffect(() => {
    if (!active) return
    // Renderer HMR can outrun a preload reload; skip until the app restarts with the bridge method.
    const checkUpstream = window.ndDsh.harness.upstream
    if (typeof checkUpstream !== 'function') return
    let disposed = false
    void checkUpstream()
      .then((status) => {
        if (!disposed) setUpstreamStatus(status)
      })
      // An offline or rejected check stays neutral; the version badge must not
      // claim an update it could not verify.
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [active])

  useEffect(() => {
    const host = surfaceRef.current
    if (!host) return
    let animationFrame = 0
    const syncBounds = (): void => {
      if (!active) return
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(() => {
        const rect = host.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return
        void window.ndDsh.dshView
          .setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
          .catch((cause) => onNotify(cause instanceof Error ? cause.message : String(cause)))
      })
    }
    const observer = new ResizeObserver(syncBounds)
    observer.observe(host)
    window.addEventListener('resize', syncBounds)
    syncBounds()
    return () => {
      cancelAnimationFrame(animationFrame)
      observer.disconnect()
      window.removeEventListener('resize', syncBounds)
    }
  }, [active, onNotify])

  useEffect(() => {
    void window.ndDsh.dshView
      .setVisible(nativeViewVisible)
      .catch((cause) => onNotify(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      void window.ndDsh.dshView.setVisible(false).catch(() => undefined)
    }
  }, [nativeViewVisible, onNotify])

  const reload = (): void => {
    void window.ndDsh.dshView.reload().catch((cause) => onNotify(cause instanceof Error ? cause.message : String(cause)))
  }

  return (
    <section className="flex h-full w-full min-h-0 min-w-0 flex-col bg-background" aria-label="DSH coding surface">
      <div className="flex h-[39px] shrink-0 items-center gap-2 border-b border-border-soft bg-secondary px-2">
        {runtimeStatus?.runtimeVersion && (
          <span
            className={cn('font-mono text-[9px]', upstreamStatus?.updateAvailable ? 'font-semibold text-destructive' : 'text-faint')}
            title={upstreamStatus?.updateAvailable && upstreamStatus.latestVersion
              ? `DeepSeek Harness ${upstreamStatus.latestVersion} is available upstream; this runtime is ${runtimeStatus.runtimeVersion}.`
              : 'DeepSeek Harness version'}
          >
            v{runtimeStatus.runtimeVersion}
          </span>
        )}
        <BridgePill state={runtimeError ? 'unavailable' : state?.ready ? 'ready' : 'binding'} className="ml-1 py-1" title={runtimeError}>
          {runtimeError ? 'Runtime error' : state?.ready ? `Gateway :${state.port ?? ''}` : 'Starting runtime'}
        </BridgePill>
        {viewFailure && (
          <span role="status" className="min-w-0 flex-1 truncate font-mono text-[9px] text-destructive" title={viewFailure}>
            {viewFailure}
          </span>
        )}
        <button
          type="button"
          aria-label="Reload DSH coding surface"
          className="ml-auto grid size-[27px] shrink-0 place-items-center rounded-[5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:text-fainter [&_svg]:size-[15px]"
          disabled={!state?.ready}
          onClick={reload}
          title="Reload DSH coding surface"
        >
          <ReloadIcon className={state?.loading ? 'animate-spin' : ''} />
        </button>
        <button
          type="button"
          aria-label="Open DSH coding surface externally"
          className="grid size-[27px] shrink-0 place-items-center rounded-[5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:text-fainter [&_svg]:size-[15px]"
          disabled={!state?.url}
          onClick={() => void window.ndDsh.browser.openExternal(state?.url ?? '').catch((cause) => onNotify(cause instanceof Error ? cause.message : String(cause)))}
          title="Open DSH coding surface in the system browser"
        >
          <ExternalIcon />
        </button>
      </div>
      <div ref={surfaceRef} className="relative min-h-0 min-w-0 flex-1 bg-surface-0">
        <div className="absolute inset-0 grid place-items-center px-6 text-xs text-faint">
          {inspectOverlayVisible ? (
            <span>DSH coding remains active while the inspection result is open.</span>
          ) : runtimeError ? (
            <div role="alert" className="max-w-[640px] rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-left">
              <strong className="block text-sm text-destructive">DSH runtime unavailable</strong>
              <p className="mb-0 mt-2 break-words text-[11px]/[1.55] text-muted-foreground">{runtimeError}</p>
              <p className="mb-0 mt-2 text-[10px]/[1.5] text-faint">Set it up in Settings → Capabilities, then reload. Packaged installs ship the runtime, so reinstall ND if that action is unavailable.</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="size-[34px] animate-spin rounded-full border border-border-strong border-t-primary" />
              <span>
                {uiPreview
                  ? 'DSH coding is hosted by the desktop runtime.'
                  : state?.loading
                    ? 'Loading DSH coding'
                    : state?.ready
                      ? 'Connecting to DSH coding'
                      : 'Waiting for the runtime'}
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
