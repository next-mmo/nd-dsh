import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { NineRouterModel, NineRouterState } from '../../../shared/nine-router'
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

interface Props { onError(message: string): void; onConnected?(): void }

const DEFAULT_BASE_URL = 'http://127.0.0.1:20128/v1'

export function NineRouterSettings({ onError, onConnected }: Props) {
  const [state, setState] = useState<NineRouterState | null>(null)
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

  const refresh = useCallback(async () => {
    const next = await window.ndDshRouter.nineRouterState()
    setState(next)
    // Managed instances use an allocated port, not a fixed 20128 endpoint.
    if (next.running && next.endpoint) {
      setBaseUrl(previous => previous === DEFAULT_BASE_URL ? next.endpoint! : previous)
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
    void action().then(() => { if (message) setSuccess(message); return refresh() })
      .catch(e => onError(errorMessage(e)))
      .finally(() => setBusy(false))
  }

  const managedReady = Boolean(state?.running && state.endpoint)
  const canOpenDashboard = managedReady || baseUrlTouched || key.trim().length > 0

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
                <span className={rowDesc}>Connect an existing local 9Router, or install an ND-signed managed runtime.</span>
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
                    <strong>ND-managed runtime</strong> — ND Security verifies an ND-signed release before install and again
                    before launch. The direct install stays disabled until a signing key is provisioned.
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
                  passwords. Managed releases are signature-verified; unsigned or tampered builds are rejected.
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
                <StatusChip good={state?.signingKeyConfigured} warn={!state?.signingKeyConfigured}>
                  {state?.signingKeyConfigured ? 'ND Security verifier ready' : 'ND Security: signing key not provisioned'}
                </StatusChip>
                {state?.installed ? (
                  <StatusChip good={state.trusted} warn={!state.trusted}>
                    {state.trusted ? 'Release verified' : 'Release verification failed'}
                  </StatusChip>
                ) : null}
              </div>
              <span className={rowDesc}>
                ND Security verifies an ND-signed 9Router release before install and again before launch. Unsigned or tampered
                builds are rejected.
              </span>
              {state?.lastError ? <span className={rowPathText}>{state.lastError}</span> : null}
              <div className="flex flex-wrap gap-1">
                <SettingsButton disabled={busy || !state?.signingKeyConfigured} onClick={() => run(() => window.ndDshRouter.nineRouterInstall(), 'Signed release verified and installed')}>
                  Install signed 9Router
                </SettingsButton>
                <SettingsButton disabled={busy || !state?.installed || !state?.trusted} onClick={() => run(() => window.ndDshRouter.nineRouterStart(), 'Managed runtime started')}>
                  Start
                </SettingsButton>
                <SettingsButton disabled={busy || !state?.installed} onClick={() => run(() => window.ndDshRouter.nineRouterStop(), 'Managed runtime stopped')}>
                  Stop
                </SettingsButton>
                <SettingsButton disabled={busy} onClick={() => run(refresh)}>Refresh status</SettingsButton>
              </div>
              {state?.installed && !state?.running ? (
                <div className="flex flex-wrap gap-2">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    aria-label="Initial 9Router dashboard password"
                    placeholder="Initial dashboard password (12+ characters)"
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    className="min-w-[240px] max-w-[360px]"
                  />
                  <SettingsButton disabled={busy || password.length < 12} onClick={() => run(async () => {
                    await window.ndDshRouter.nineRouterPrepare(password)
                    setPassword('')
                  }, 'Encrypted initial dashboard password saved')}>Set initial password</SettingsButton>
                </div>
              ) : null}
              {!state?.signingKeyConfigured ? (
                <p className="text-[10px] text-faint">
                  Managed install is unavailable until ND provisions a signed 9Router release and publisher key. Connect an
                  existing local 9Router instead.
                </p>
              ) : null}
            </div>
          </SettingsRow>

          <SettingsRow className="items-start">
            <div className="flex w-full flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <strong className={rowTitle}>Existing 9Router</strong>
                <StatusChip neutral>External gateway</StatusChip>
              </div>
              <div className="flex min-w-0 flex-wrap gap-2">
                <Input
                  aria-label="9Router API URL"
                  value={baseUrl}
                  onChange={event => { setBaseUrl(event.target.value); setBaseUrlTouched(true) }}
                  placeholder={DEFAULT_BASE_URL}
                  className="min-w-[260px] flex-1 font-mono text-[11px]"
                />
                <Input
                  type="password"
                  autoComplete="off"
                  aria-label="9Router gateway API key"
                  value={key}
                  onChange={event => setKey(event.target.value)}
                  placeholder="Gateway API key"
                  className="min-w-[190px] flex-1 font-mono text-[11px]"
                />
              </div>
              <div className="flex flex-wrap gap-1">
                <SettingsButton disabled={busy || !key.trim()} onClick={() => run(async () => {
                  setModels(await window.ndDshRouter.nineRouterDiscover({ baseUrl, apiKey: key }))
                }, 'Model discovery completed')}>Discover models</SettingsButton>
                <SettingsButton disabled={busy || !key.trim()} onClick={() => run(async () => {
                  const connected = await window.ndDshRouter.nineRouterConnect({ baseUrl, apiKey: key })
                  setSuccess(`Connected ${connected.connected} models as 9R: routes. Toggle Personal chat per route if you want it private.`)
                  setKey('')
                  setGuideOpen(false)
                  onConnected?.()
                })}>Connect to ND Router</SettingsButton>
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