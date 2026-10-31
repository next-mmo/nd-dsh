import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  NINE_ROUTER_EXTERNAL_PROVIDER_ID,
  type NineRouterModel,
  type NineRouterState,
} from '../../../shared/nine-router'
import type { RouterState, RouterTestResult } from '../../../shared/router'
import {
  SettingsButton,
  SettingsNote,
  SettingsRow,
  SettingsSection,
  StatusChip,
  rowDesc,
  rowPathText,
  rowTitle,
} from './settings-primitives'
import { Input } from './ui/input'

interface Props { onError(message: string): void; onConnected?(): void; onNavigateToExtensions?(): void }

const DEFAULT_BASE_URL = 'http://127.0.0.1:20128/v1'

export function NineRouterSettings({ onError, onConnected, onNavigateToExtensions }: Props) {
  const [state, setState] = useState<NineRouterState | null>(null)
  const [routerState, setRouterState] = useState<RouterState | null>(null)
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL)
  const [baseUrlTouched, setBaseUrlTouched] = useState(false)
  const [key, setKey] = useState('')
  const [password, setPassword] = useState('')
  const [models, setModels] = useState<NineRouterModel[]>([])
  const [busy, setBusy] = useState(false)
  const [dashboard, setDashboard] = useState(false)
  const [guideOpen, setGuideOpen] = useState(true)
  const [success, setSuccess] = useState('')
  const surface = useRef<HTMLDivElement>(null)
  const baseUrlTouchedRef = useRef(false)

  const navigateToExtensions = () => {
    if (onNavigateToExtensions) {
      onNavigateToExtensions()
    } else {
      window.location.hash = '#/settings?tab=extensions'
    }
  }

  const refresh = useCallback(async () => {
    const [next, router] = await Promise.all([
      window.ndDshRouter.nineRouterState(),
      window.ndDshRouter.state(),
    ])
    setState(next)
    setRouterState(router)
    const saved = router.providers.find((provider) => provider.id === NINE_ROUTER_EXTERNAL_PROVIDER_ID)
    // The managed runtime allocates a new loopback port per start; its endpoint
    // is authoritative unless the user is deliberately editing an external URL.
    if (next.running && next.endpoint) {
      if (!baseUrlTouchedRef.current) setBaseUrl(next.endpoint)
    } else if (saved && !baseUrlTouchedRef.current) {
      setBaseUrl((current) => (current === DEFAULT_BASE_URL ? saved.baseUrl : current))
    }
  }, [])

  useEffect(() => {
    void refresh().catch(e => onError(errorMessage(e)))
  }, [refresh, onError])

  useEffect(() => {
    if (!dashboard) return
    const sync = () => {
      const node = surface.current
      if (!node) return
      const rect = node.getBoundingClientRect()
      const top = Math.max(0, rect.top)
      const bottom = Math.min(window.innerHeight, rect.bottom)
      const left = Math.max(0, rect.left)
      const right = Math.min(window.innerWidth, rect.right)
      void window.ndDshRouter.nineRouterDashboardBounds({
        x: left, y: top, width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      }).catch(() => undefined)
    }
    const observer = new ResizeObserver(sync)
    if (surface.current) observer.observe(surface.current)
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    sync()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
      void window.ndDshRouter.nineRouterDashboardClose().catch(() => undefined)
    }
  }, [dashboard])

  const run = (action: () => Promise<unknown>, message?: string): void => {
    setBusy(true)
    void action()
      .then(() => { if (message) setSuccess(message); return refresh() })
      .catch(async (e) => {
        onError(errorMessage(e))
        // A refused start still changes what the panel should show (last error,
        // integrity, trust); never leave the old state on screen.
        await refresh().catch(() => undefined)
      })
      .finally(() => setBusy(false))
  }

  const nineProvider = routerState?.providers.find((provider) => provider.id === NINE_ROUTER_EXTERNAL_PROVIDER_ID) ?? null
  const nineRouteCount = routerState?.combos.filter((combo) => combo.name.startsWith('9R: ')).length ?? 0
  const keySaved = Boolean(nineProvider?.hasSecret)
  const managedEndpoint = state?.running ? state.endpoint : undefined
  const managedReady = Boolean(state?.running && state.endpoint)
  const canOpenDashboard = managedReady || baseUrlTouched || key.trim().length > 0 || Boolean(nineProvider)
  const unverified = state?.verification === 'unverified'
  const integrityChanged = state?.integrity === 'changed'
  const startReady = Boolean(state?.installed && (unverified ? !integrityChanged : state.trusted))

  const openDashboard = async (): Promise<void> => {
    setBusy(true)
    try {
      // Start/stop may have changed the allocated port since the last render.
      const latest = await window.ndDshRouter.nineRouterState()
      setState(latest)
      if (!latest.running && !baseUrlTouched && !key.trim()) {
        throw new Error('Start the managed 9Router runtime or enter an external gateway URL/key before opening its dashboard.')
      }
      const target = latest.running && latest.endpoint ? latest.endpoint : baseUrl.trim()
      await window.ndDshRouter.nineRouterDashboardOpen(target)
      setDashboard(true)
      setSuccess('9Router dashboard opened in the protected ND browser view')
    } catch (error) {
      onError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SettingsSection title="9Router integration">
        <div className="space-y-1.5">
          <div className="rounded-lg border border-border-soft bg-surface-1">
            <button
              type="button"
              aria-expanded={guideOpen}
              className="flex w-full items-center justify-between gap-4 px-[13px] py-[11px] text-left"
              onClick={() => setGuideOpen(current => !current)}
            >
              <span className="flex min-w-0 flex-col gap-[3px]">
                <strong className={rowTitle}>How to install and use</strong>
                <span className={rowDesc}>Connect an existing local 9Router, or run a signed or explicitly unverified managed runtime.</span>
              </span>
              <StatusChip neutral>{guideOpen ? 'Hide' : 'Show'}</StatusChip>
            </button>
            {guideOpen ? (
              <div className="border-t border-border-soft px-[13px] py-[11px]">
                <ol className="space-y-2">
                  <GuideStep index={1}>
                    <strong>Existing 9Router</strong> — install and start it yourself, then create a gateway API key in its
                    dashboard.
                  </GuideStep>
                  <GuideStep index={2}>
                    <strong>ND-managed runtime</strong> — install the <strong>9Router</strong> extension on demand from the
                    <strong>Extensions</strong> page. Once installed, start and stop the runtime here or from the launcher.
                  </GuideStep>
                  <GuideStep index={3}>
                    For an existing gateway, enter its loopback URL (usually <code className="font-mono text-[10px]">{DEFAULT_BASE_URL}</code>)
                    and key below. For the managed runtime, press <strong>Start</strong>, then create or copy a gateway key from
                    its dashboard.
                  </GuideStep>
                  <GuideStep index={4}>
                    Press <strong>Discover models</strong>, then <strong>Connect to ND Router</strong>. Each model becomes a
                    <code className="font-mono text-[10px]"> 9R: </code> route.
                  </GuideStep>
                  <GuideStep index={5}>
                    Use the route in the Playground or a chat. Toggle <strong>Personal chat</strong> per route in Routes to keep
                    a model private. Keep 9Router running while you use its routes.
                  </GuideStep>
                </ol>
                <SettingsNote>
                  Loopback gateways only. ND stores the gateway key in its secure store and never reads 9Router account
                  passwords. Signed releases are signature-verified; unverified imports are hash-pinned and never described
                  as verified.
                </SettingsNote>
              </div>
            ) : null}
          </div>

          <SettingsRow className="items-start">
            <div className="flex w-full flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <strong className={rowTitle}>ND-managed runtime</strong>
                <StatusChip good={state?.running} neutral={!state?.running}>
                  {state?.running ? 'Running' : state?.installed ? 'Installed, stopped' : 'Not installed'}
                </StatusChip>
                {state?.version ? <StatusChip neutral>v{state.version}</StatusChip> : null}
                {state?.installed && unverified ? (
                  <>
                    <StatusChip warn>Unverified local import</StatusChip>
                    <StatusChip good={!integrityChanged} warn={integrityChanged}>
                      {integrityChanged ? 'Files changed after import' : 'Files hash-pinned'}
                    </StatusChip>
                  </>
                ) : null}
                {state?.installed && !unverified ? (
                  <StatusChip good={state.trusted} warn={!state.trusted}>
                    {state.trusted ? 'Release verified' : 'Release verification failed'}
                  </StatusChip>
                ) : null}
              </div>
              <span className={rowDesc}>
                {state?.installed
                  ? 'Manage the local 9Router runtime. Start or stop the gateway and connect its models to ND Router.'
                  : '9Router is available as an on-demand ND extension. Set it up from the Extensions page, then start or stop the runtime here.'}
              </span>
              {state?.lastError ? <span className={rowPathText}>{state.lastError}</span> : null}
              <div className="flex flex-wrap gap-1">
                {!state?.installed ? (
                  <SettingsButton onClick={navigateToExtensions}>
                    Set up in Extensions
                  </SettingsButton>
                ) : null}
                <SettingsButton disabled={busy || !startReady || Boolean(state?.running)} onClick={() => run(async () => {
                  const next = await window.ndDshRouter.nineRouterStart()
                  if (next.endpoint) {
                    baseUrlTouchedRef.current = false
                    setBaseUrlTouched(false)
                    setBaseUrl(next.endpoint)
                  }
                  onConnected?.()
                  return next
                }, 'Managed runtime started')}>
                  Start
                </SettingsButton>
                <SettingsButton disabled={busy || !state?.running} onClick={() => run(() => window.ndDshRouter.nineRouterStop(), 'Managed runtime stopped')}>
                  Stop
                </SettingsButton>
                <SettingsButton disabled={busy} onClick={() => run(refresh)}>Refresh status</SettingsButton>
              </div>
            </div>
          </SettingsRow>

          <SettingsRow className="items-start">
            <div className="flex w-full flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <strong className={rowTitle}>Existing 9Router</strong>
                {nineProvider ? (
                  <StatusChip good>Connected · {nineProvider.models.length} models</StatusChip>
                ) : (
                  <StatusChip neutral>Not connected</StatusChip>
                )}
                {keySaved ? <StatusChip neutral>Key saved in ND</StatusChip> : null}
              </div>
              <div className="flex min-w-0 flex-wrap gap-2">
                <Input
                  aria-label="9Router API URL"
                  value={baseUrl}
                  onChange={event => {
                    baseUrlTouchedRef.current = true
                    setBaseUrl(event.target.value)
                    setBaseUrlTouched(true)
                  }}
                  placeholder={DEFAULT_BASE_URL}
                  className="min-w-[260px] flex-1 font-mono text-[11px]"
                />
                <Input
                  type="password"
                  autoComplete="off"
                  aria-label="9Router gateway API key"
                  value={key}
                  onChange={event => setKey(event.target.value)}
                  placeholder={keySaved ? 'Key saved in ND — enter to replace' : 'Gateway API key'}
                  className="min-w-[190px] flex-1 font-mono text-[11px]"
                />
              </div>
              {managedEndpoint && baseUrl !== managedEndpoint ? (
                <span className={rowDesc}>
                  Managed runtime is on <span className="font-mono">{managedEndpoint}</span>.{' '}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      baseUrlTouchedRef.current = false
                      setBaseUrlTouched(false)
                      setBaseUrl(managedEndpoint)
                    }}
                  >
                    Use it
                  </button>
                </span>
              ) : null}
              {nineProvider ? (
                <span className={rowDesc}>
                  Saved target {nineProvider.baseUrl} · {nineRouteCount} 9R: routes. ND keeps the gateway key; enter it again
                  only to replace it or refresh the model list.
                </span>
              ) : null}
              <div className="flex flex-wrap gap-1">
                <SettingsButton disabled={busy || !key.trim()} onClick={() => run(async () => {
                  setModels(await window.ndDshRouter.nineRouterDiscover({ baseUrl, apiKey: key }))
                }, 'Model discovery completed')}>Discover models</SettingsButton>
                <SettingsButton disabled={busy || !key.trim()} onClick={() => run(async () => {
                  const connected = await window.ndDshRouter.nineRouterConnect({ baseUrl, apiKey: key })
                  setSuccess(`Connected ${connected.connected} models as 9R: routes. The key is stored in ND. Toggle Personal chat per route if you want it private.`)
                  setGuideOpen(false)
                  onConnected?.()
                })}>Connect to ND Router</SettingsButton>
                {nineProvider && keySaved ? (
                  <SettingsButton disabled={busy} onClick={() => run(async () => {
                    const result = await window.ndDshRouter.testProvider(NINE_ROUTER_EXTERNAL_PROVIDER_ID)
                    if (!result.ok) throw new Error(savedConnectionError(result))
                    return result
                  }, 'Saved 9Router connection answered')}>Test saved connection</SettingsButton>
                ) : null}
                <SettingsButton disabled={busy || !canOpenDashboard} onClick={openDashboard}>Open dashboard inside ND</SettingsButton>
                {dashboard ? (
                  <SettingsButton disabled={busy} onClick={() => {
                    void window.ndDshRouter.nineRouterDashboardClose()
                    setDashboard(false)
                  }}>Close dashboard</SettingsButton>
                ) : null}
              </div>
              {!canOpenDashboard ? (
                <p className="text-[10px] text-faint">
                  Open dashboard becomes available when the managed runtime is running, or after you enter an external gateway
                  URL or key.
                </p>
              ) : null}
            </div>
          </SettingsRow>

          {success ? <p role="status" className="px-[13px] text-[11px] text-strong">{success}</p> : null}
          {models.length > 0 ? (
            <div className="max-h-[120px] overflow-auto rounded-md border border-border-soft bg-surface-1 p-2 text-[11px] text-soft">
              {models.map(model => <div className="font-mono" key={model.id}>{model.id}</div>)}
            </div>
          ) : null}
          {dashboard ? (
            <div
              ref={surface}
              aria-label="Protected embedded 9Router administration browser"
              className="relative h-[480px] w-full overflow-hidden rounded-lg border border-border bg-background"
            >
              <span className="sr-only">9Router dashboard is displayed in a separate sandboxed Electron WebContentsView</span>
            </div>
          ) : null}
        </div>
      </SettingsSection>
    </>
  )
}

function GuideStep({ index, children }: { index: number; children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="grid size-5 shrink-0 place-items-center rounded-full border border-border bg-secondary text-[9px] font-bold text-faint">
        {index}
      </span>
      <span className="min-w-0 text-[11px] leading-[1.5] text-soft">{children}</span>
    </li>
  )
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // Keep IPC mechanics out of the user-facing notice.
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}

/**
 * A 9Router 404 for missing provider credentials still proves the gateway and
 * the saved key are reachable; never present that as a bad key.
 */
function savedConnectionError(result: RouterTestResult): string {
  let message = typeof result.error === 'string' ? result.error : ''
  try {
    const parsed = JSON.parse(message) as { error?: { message?: unknown }; message?: unknown }
    const nested = parsed?.error?.message ?? parsed?.message
    if (typeof nested === 'string') message = nested
  } catch {
    // Keep the raw text.
  }
  if (/no active credentials|model_not_found/i.test(message)) {
    return `9Router is reachable with the saved key, but ${result.model} has no credentials in 9Router. Add an account in its dashboard or use a model that already has one.`
  }
  return message || `9Router test failed (HTTP ${result.statusCode})`
}
