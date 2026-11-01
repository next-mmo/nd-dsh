import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  NINE_ROUTER_EXTERNAL_PROVIDER_ID,
  type NineRouterModel,
  type NineRouterState,
} from '../../../shared/nine-router'
import type { RouterState, RouterTestResult } from '../../../shared/router'
import {
  SettingsButton,
  SettingsNote,
  StatusChip,
} from './settings-primitives'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { cn } from '../lib/utils'
import {
  AlertCircle,
  Check,
  Copy,
  Cpu,
  ExternalLink,
  FolderOpen,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Square,
  Terminal,
  Zap,
} from 'lucide-react'

interface Props { onError(message: string): void; onConnected?(): void; onNavigateToExtensions?(): void }

const DEFAULT_BASE_URL = 'http://127.0.0.1:20128/v1'

export function NineRouterSettings({ onError, onConnected, onNavigateToExtensions }: Props) {
  const [state, setState] = useState<NineRouterState | null>(null)
  const [routerState, setRouterState] = useState<RouterState | null>(null)
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL)
  const [baseUrlTouched, setBaseUrlTouched] = useState(false)
  const [key, setKey] = useState('')
  const [models, setModels] = useState<NineRouterModel[]>([])
  const [busy, setBusy] = useState(false)
  const [dashboard, setDashboard] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [success, setSuccess] = useState('')
  const [logFilter, setLogFilter] = useState('')
  const [copiedLogs, setCopiedLogs] = useState(false)
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
        await refresh().catch(() => undefined)
      })
      .finally(() => setBusy(false))
  }

  const nineProvider = routerState?.providers.find((provider) => provider.id === NINE_ROUTER_EXTERNAL_PROVIDER_ID) ?? null
  const nineRouteCombos = routerState?.combos.filter((combo) => combo.name.startsWith('9R: ')) ?? []
  const nineRouteCount = nineRouteCombos.length
  const keySaved = Boolean(nineProvider?.hasSecret)
  const managedEndpoint = state?.running ? state.endpoint : undefined
  const managedReady = Boolean(state?.running && state.endpoint)
  const canOpenDashboard = managedReady || baseUrlTouched || key.trim().length > 0 || Boolean(nineProvider)
  const unverified = state?.verification === 'unverified'
  const integrityChanged = state?.integrity === 'changed'
  const startReady = Boolean(state?.installed && (unverified ? !integrityChanged : state.trusted))

  // Consolidated list of models to display: from saved provider or newly discovered
  const displayModels = useMemo(() => {
    const list: Array<{ id: string; activeInWorkspace: boolean }> = []
    const seen = new Set<string>()
    if (nineProvider?.models) {
      for (const modelId of nineProvider.models) {
        if (!seen.has(modelId)) {
          seen.add(modelId)
          list.push({ id: modelId, activeInWorkspace: true })
        }
      }
    }
    for (const m of models) {
      if (!seen.has(m.id)) {
        seen.add(m.id)
        list.push({ id: m.id, activeInWorkspace: false })
      }
    }
    return list
  }, [nineProvider?.models, models])

  const openDashboard = async (): Promise<void> => {
    setBusy(true)
    try {
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

  const handleCopyLogs = () => {
    if (!state?.recentLogs || state.recentLogs.length === 0) return
    void navigator.clipboard.writeText(state.recentLogs.join('\n')).then(() => {
      setCopiedLogs(true)
      setTimeout(() => setCopiedLogs(false), 2000)
    })
  }

  const filteredLogs = useMemo(() => {
    const all = state?.recentLogs ?? []
    if (!logFilter.trim()) return all
    const q = logFilter.toLowerCase()
    return all.filter((l) => l.toLowerCase().includes(q))
  }, [state?.recentLogs, logFilter])

  return (
    <div className="space-y-4">
      {/* 1. Header Banner & Status Strip */}
      <section className="rounded-2xl border border-border-soft bg-surface-0/60 p-4 shadow-sm backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl border border-orange-500/30 bg-orange-500/10 text-orange-400">
              <Cpu className="size-5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="m-0 text-base font-semibold tracking-tight text-foreground">
                  9Router Gateway &amp; Runtime
                </h3>
                {state?.version ? (
                  <Badge variant="outline" className="text-[10px] font-mono">
                    v{state.version}
                  </Badge>
                ) : null}
                {state?.installed && unverified ? (
                  <Badge variant="secondary" className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300">
                    Unverified import
                  </Badge>
                ) : null}
                {state?.installed && !unverified && state?.trusted ? (
                  <Badge variant="secondary" className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-300">
                    <ShieldCheck className="mr-0.5 size-3" /> Release verified
                  </Badge>
                ) : null}
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs">
                <span className="flex items-center gap-1.5 font-medium">
                  {state?.running ? (
                    <>
                      <span className="size-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)] animate-pulse" />
                      <span className="text-emerald-400">Running on {state.endpoint ?? baseUrl}</span>
                    </>
                  ) : state?.installed ? (
                    <>
                      <span className="size-2 rounded-full bg-amber-500/80" />
                      <span className="text-soft">Installed, stopped</span>
                    </>
                  ) : (
                    <>
                      <span className="size-2 rounded-full bg-zinc-600" />
                      <span className="text-faint">Not installed</span>
                    </>
                  )}
                </span>
                <span className="text-faint">·</span>
                <span className="text-[11px] text-faint">
                  Local AI Proxy &amp; Gateway managed directly in ND
                </span>
              </div>
            </div>
          </div>

          {/* Quick Action Toolbar */}
          <div className="flex flex-wrap items-center gap-1.5">
            {!state?.installed ? (
              <Button size="sm" onClick={navigateToExtensions}>
                Set up in Extensions
              </Button>
            ) : null}

            <Button
              size="sm"
              variant={state?.running ? 'outline' : 'default'}
              disabled={busy || !startReady || Boolean(state?.running)}
              onClick={() => run(async () => {
                const next = await window.ndDshRouter.nineRouterStart()
                if (next.endpoint) {
                  baseUrlTouchedRef.current = false
                  setBaseUrlTouched(false)
                  setBaseUrl(next.endpoint)
                }
                onConnected?.()
                return next
              }, 'Managed runtime started')}
            >
              <Play className="size-3.5" /> Start
            </Button>

            <Button
              size="sm"
              variant="outline"
              disabled={busy || !state?.running}
              onClick={() => run(() => window.ndDshRouter.nineRouterStop(), 'Managed runtime stopped')}
            >
              <Square className="size-3.5" /> Stop
            </Button>

            <Button
              size="sm"
              variant="outline"
              disabled={busy || !state?.running}
              onClick={() => run(async () => {
                await window.ndDshRouter.nineRouterStop()
                const next = await window.ndDshRouter.nineRouterStart()
                if (next.endpoint) {
                  baseUrlTouchedRef.current = false
                  setBaseUrlTouched(false)
                  setBaseUrl(next.endpoint)
                }
                onConnected?.()
                return next
              }, 'Managed runtime restarted')}
              title="Restart 9Router managed runtime"
            >
              <RotateCcw className="size-3.5" /> Restart
            </Button>

            {state?.installed ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || Boolean(state?.running)}
                onClick={() => run(() => window.ndDshRouter.nineRouterImportUnverified(), '9Router release imported successfully')}
                title="Import an updated 9Router build or local folder (e.g. v0.5.112)"
              >
                <FolderOpen className="size-3.5" /> Update from folder…
              </Button>
            ) : null}

            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canOpenDashboard}
              onClick={openDashboard}
            >
              <ExternalLink className="size-3.5" /> Open 9Router Dashboard
            </Button>

            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy}
              onClick={() => run(refresh)}
              title="Refresh status"
            >
              <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
            </Button>
          </div>
        </div>

        {/* High-visibility Error Banner */}
        {state?.lastError ? (
          <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <div className="flex-1">
              <strong className="font-semibold">Runtime diagnostic notice:</strong>
              <div className="mt-0.5 font-mono text-[11px] leading-relaxed break-all text-destructive/90">
                {state.lastError}
              </div>
            </div>
          </div>
        ) : null}

        {success ? (
          <p role="status" className="mt-2 text-xs font-medium text-emerald-400">
            {success}
          </p>
        ) : null}
      </section>

      {/* 2. Endpoint Connection & Model Sync Bar */}
      <section className="rounded-2xl border border-border-soft bg-surface-0/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-soft/60 pb-3">
          <div>
            <h4 className="m-0 text-sm font-semibold text-foreground">Gateway Connection &amp; API Key</h4>
            <p className="mt-0.5 text-xs text-faint">
              Connect to 9Router on loopback. API keys are stored securely inside ND and never exposed to React renderer.
            </p>
          </div>
          {nineProvider ? (
            <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-xs">
              <Check className="mr-1 size-3" /> Connected · {nineProvider.models.length} models · {nineRouteCount} 9R: routes
            </Badge>
          ) : (
            <Badge variant="outline" className="text-xs text-faint">
              Not connected
            </Badge>
          )}
        </div>

        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            <div className="min-w-[280px] flex-1">
              <label className="mb-1 block text-[11px] font-medium text-soft">Loopback Gateway URL</label>
              <Input
                aria-label="9Router API URL"
                value={baseUrl}
                onChange={event => {
                  baseUrlTouchedRef.current = true
                  setBaseUrl(event.target.value)
                  setBaseUrlTouched(true)
                }}
                placeholder={DEFAULT_BASE_URL}
                className="font-mono text-xs"
              />
            </div>
            <div className="min-w-[240px] flex-1">
              <label className="mb-1 block text-[11px] font-medium text-soft">Gateway API Key</label>
              <Input
                type="password"
                autoComplete="off"
                aria-label="9Router gateway API key"
                value={key}
                onChange={event => setKey(event.target.value)}
                placeholder={keySaved ? 'Key saved in ND (enter to replace)' : 'Enter 9Router API Key'}
                className="font-mono text-xs"
              />
            </div>
          </div>

          {managedEndpoint && baseUrl !== managedEndpoint ? (
            <p className="text-xs text-faint">
              Managed runtime is listening on <span className="font-mono text-foreground">{managedEndpoint}</span>.{' '}
              <button
                type="button"
                className="text-primary underline hover:text-primary/80"
                onClick={() => {
                  baseUrlTouchedRef.current = false
                  setBaseUrlTouched(false)
                  setBaseUrl(managedEndpoint)
                }}
              >
                Use managed endpoint
              </button>
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              size="sm"
              disabled={busy || !key.trim()}
              onClick={() => run(async () => {
                setModels(await window.ndDshRouter.nineRouterDiscover({ baseUrl, apiKey: key }))
              }, 'Model discovery completed')}
            >
              <Search className="size-3.5" /> Discover models
            </Button>

            <Button
              size="sm"
              variant="default"
              disabled={busy || !key.trim()}
              onClick={() => run(async () => {
                const connected = await window.ndDshRouter.nineRouterConnect({ baseUrl, apiKey: key })
                setSuccess(`Connected ${connected.connected} models as 9R: routes in ND Router.`)
                onConnected?.()
              })}
            >
              <Zap className="size-3.5" /> Connect to ND Router
            </Button>

            {nineProvider && keySaved ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => run(async () => {
                  const result = await window.ndDshRouter.testProvider(NINE_ROUTER_EXTERNAL_PROVIDER_ID)
                  if (!result.ok) throw new Error(savedConnectionError(result))
                  return result
                }, 'Saved 9Router connection answered')}
              >
                Test saved connection
              </Button>
            ) : null}
          </div>
        </div>
      </section>

      {/* 3. Discovered Models & Workspace Routes Grid */}
      <section className="rounded-2xl border border-border-soft bg-surface-0/40 p-4">
        <div className="flex items-center justify-between gap-2 border-b border-border-soft/60 pb-3">
          <div className="flex items-center gap-2">
            <h4 className="m-0 text-sm font-semibold text-foreground">Discovered Models &amp; Workspace Routes</h4>
            <Badge variant="secondary" className="text-[10px]">
              {displayModels.length} models
            </Badge>
          </div>
          <span className="text-[11px] text-faint">
            Each model connects as a <code className="font-mono text-[10px] text-foreground">9R:</code> route in your workspace
          </span>
        </div>

        {displayModels.length > 0 ? (
          <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {displayModels.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-border-soft bg-surface-1 p-3 transition-colors hover:border-border-strong hover:bg-surface-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="rounded bg-orange-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-orange-400">
                      9R
                    </span>
                    <strong className="truncate font-mono text-xs text-foreground" title={item.id}>
                      {item.id}
                    </strong>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-faint">
                    <span className="inline-flex items-center gap-1 text-emerald-400">
                      <Zap className="size-2.5" /> RTK Token Saver
                    </span>
                    <span>·</span>
                    <span>Workspace Active</span>
                  </div>
                </div>

                <Badge
                  variant={item.activeInWorkspace ? 'default' : 'outline'}
                  className="shrink-0 text-[10px]"
                >
                  {item.activeInWorkspace ? 'Connected' : 'Discovered'}
                </Badge>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-6 text-center text-xs text-faint">
            No models discovered yet. Start 9Router, enter your Gateway API key, and click <strong>Discover models</strong>.
          </div>
        )}
      </section>

      {/* 4. Diagnostic Logger Terminal Console */}
      <section className="overflow-hidden rounded-2xl border border-border-soft bg-[#070a11] text-foreground shadow-md">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3.5 py-2">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1">
              <span className="size-2.5 rounded-full bg-rose-500/80" />
              <span className="size-2.5 rounded-full bg-amber-500/80" />
              <span className="size-2.5 rounded-full bg-emerald-500/80" />
            </span>
            <span className="ml-1 text-xs font-semibold text-zinc-300">
              Diagnostic Terminal <span className="font-mono text-[10px] text-zinc-500">(nd-dsh.log)</span>
            </span>
            <Badge variant="outline" className="border-zinc-700 bg-zinc-800/60 font-mono text-[10px] text-zinc-400">
              {state?.recentLogs?.length ?? 0} events
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                value={logFilter}
                onChange={e => setLogFilter(e.target.value)}
                placeholder="Filter logs…"
                className="h-6 w-32 rounded border border-zinc-800 bg-zinc-950 pl-6 pr-2 text-[10px] text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
              />
            </div>
            <Button
              size="xs"
              variant="outline"
              className="border-zinc-800 bg-zinc-900 text-[10px] text-zinc-300 hover:bg-zinc-800"
              onClick={handleCopyLogs}
              disabled={!state?.recentLogs || state.recentLogs.length === 0}
            >
              {copiedLogs ? <><Check className="size-3 text-emerald-400" /> Copied</> : <><Copy className="size-3" /> Copy logs</>}
            </Button>
          </div>
        </div>

        <div className="max-h-[180px] overflow-auto p-3 font-mono text-[11px] leading-relaxed">
          {filteredLogs.length > 0 ? (
            filteredLogs.map((line, idx) => {
              const isError = /(?:error|fail|cannot|exception|fatal)/i.test(line)
              const isWarn = /(?:warn|timeout)/i.test(line)
              const isInfo = /(?:listening|health check passed|started|ready)/i.test(line)
              return (
                <div
                  key={idx}
                  className={cn(
                    'whitespace-pre-wrap',
                    isError ? 'text-rose-400' : isWarn ? 'text-amber-300' : isInfo ? 'text-cyan-300' : 'text-zinc-400'
                  )}
                >
                  <span className="mr-2 select-none text-zinc-600">{idx + 1}</span>
                  {line}
                </div>
              )
            })
          ) : (
            <div className="text-zinc-600">
              {state?.running
                ? 'Listening for 9Router runtime output...'
                : 'Runtime is stopped. Logs will stream here when 9Router is active.'}
            </div>
          )}
        </div>
      </section>

      {/* 5. Embedded 9Router Native Web Dashboard (when toggled) */}
      {dashboard ? (
        <section className="space-y-2 rounded-2xl border border-border-strong bg-surface-0 p-3 shadow-lg">
          <div className="flex items-center justify-between gap-2 border-b border-border-soft pb-2">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
              <strong className="text-xs font-semibold text-foreground">
                9Router Native Web Dashboard
              </strong>
              <span className="text-[10px] text-faint">
                (Sandboxed Chromium WebContentsView — OAuth isolated)
              </span>
            </div>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void window.ndDshRouter.nineRouterDashboardClose()
                setDashboard(false)
              }}
            >
              Close dashboard
            </Button>
          </div>
          <div
            ref={surface}
            aria-label="Protected embedded 9Router administration browser"
            className="relative h-[520px] w-full overflow-hidden rounded-xl border border-border bg-background"
          >
            <span className="sr-only">9Router dashboard is displayed in a separate sandboxed Electron WebContentsView</span>
          </div>
        </section>
      ) : null}

      {/* 6. How-to Guide (Collapsible) */}
      <div className="rounded-xl border border-border-soft bg-surface-0/30">
        <button
          type="button"
          aria-expanded={guideOpen}
          className="flex w-full items-center justify-between gap-4 px-3.5 py-2.5 text-left text-xs font-medium text-soft hover:text-foreground"
          onClick={() => setGuideOpen(current => !current)}
        >
          <span>Need help? How to install, update, and route models</span>
          <StatusChip neutral>{guideOpen ? 'Hide guide' : 'Show guide'}</StatusChip>
        </button>
        {guideOpen ? (
          <div className="border-t border-border-soft p-3.5 text-xs">
            <ol className="space-y-2 text-soft">
              <GuideStep index={1}>
                <strong>Managed Runtime</strong>: Install the 9Router extension from Extensions. Then click <strong>Start</strong> above to run the gateway locally.
              </GuideStep>
              <GuideStep index={2}>
                <strong>Update to v0.5.112+</strong>: Click <strong>Update from folder…</strong> to import any new local 9Router release folder directly without OS terminal commands.
              </GuideStep>
              <GuideStep index={3}>
                <strong>Discover &amp; Connect</strong>: Enter your Gateway API Key, click <strong>Discover models</strong>, then <strong>Connect to ND Router</strong> to generate <code className="font-mono text-[10px]">9R:</code> routes in your workspace.
              </GuideStep>
              <GuideStep index={4}>
                <strong>Dashboard</strong>: Click <strong>Open 9Router Dashboard</strong> to configure providers directly in 9Router's native web interface.
              </GuideStep>
            </ol>
            <div className="mt-3">
              <SettingsNote>
                Loopback gateways only. ND stores the gateway key in its secure store and never reads 9Router account passwords.
              </SettingsNote>
            </div>
          </div>
        ) : null}
      </div>
    </div>
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
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}

function savedConnectionError(result: RouterTestResult): string {
  let message = typeof result.error === 'string' ? result.error : ''
  try {
    const parsed = JSON.parse(message) as { error?: { message?: unknown }; message?: unknown }
    const nested = parsed?.error?.message ?? parsed?.message
    if (typeof nested === 'string') message = nested
  } catch {
    // Keep raw text
  }
  if (/no active credentials|model_not_found/i.test(message)) {
    return `9Router is reachable with the saved key, but ${result.model} has no credentials in 9Router. Add an account in its dashboard or use a model that already has one.`
  }
  return message || `9Router test failed (HTTP ${result.statusCode})`
}
