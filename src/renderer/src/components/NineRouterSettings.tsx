import { useCallback, useEffect, useRef, useState } from 'react'
import type { NineRouterModel, NineRouterState } from '../../../shared/nine-router'
import { SettingsButton, SettingsNote, SettingsRow, SettingsSection } from './settings-primitives'
import { Input } from './ui/input'

interface Props { onError(message: string): void; onConnected?(): void }

export function NineRouterSettings({ onError, onConnected }: Props) {
  const [state, setState] = useState<NineRouterState | null>(null)
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:20128/v1')
  const [key, setKey] = useState('')
  const [password, setPassword] = useState('')
  const [models, setModels] = useState<NineRouterModel[]>([])
  const [busy, setBusy] = useState(false)
  const [dashboard, setDashboard] = useState(false)
  const [success, setSuccess] = useState('')
  const surface = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    const next = await window.ndDshRouter.nineRouterState()
    setState(next)
    // Managed instances use an allocated port, not a fixed 20128 endpoint.
    if (next.running && next.endpoint) {
      setBaseUrl(previous => previous === 'http://127.0.0.1:20128/v1' ? next.endpoint! : previous)
    }
  }, [])

  useEffect(() => {
    void refresh().catch(e => onError(String(e)))
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
      .catch(e => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const openDashboard = (): void => {
    setBusy(true)
    void window.ndDshRouter.nineRouterDashboardOpen(state?.running && state.endpoint ? state.endpoint : baseUrl)
      .then(() => { setDashboard(true); setSuccess('9Router dashboard opened in protected ND Browser session') })
      .catch(e => onError(String(e)))
      .finally(() => setBusy(false))
  }

  return (
    <>
      <SettingsSection title="9Router integration">
        <SettingsRow className="items-start">
          <div className="flex w-full flex-col gap-3">
            <p className="text-[11px] text-soft">
              Connect an existing local 9Router or install an ND-signed runtime. External gateways are not
              ND-attested. ND Security never permits execution of unsigned managed software.
            </p>
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span>ND Security: <strong>{state?.signingKeyConfigured ? 'signature verifier available' : 'managed signing key not provisioned'}</strong></span>
              <span>Managed: <strong>{state?.running ? 'running' : state?.installed ? 'installed, stopped' : 'not installed'}</strong></span>
              {state?.version && <span>v{state.version}</span>}
            </div>
            {state?.lastError && <SettingsNote>{state.lastError}</SettingsNote>}
            <div className="flex flex-wrap items-center gap-2">
              <SettingsButton disabled={busy || !state?.signingKeyConfigured} onClick={() => run(() => window.ndDshRouter.nineRouterInstall(), 'Signed release verified and installed')}>Install signed folder</SettingsButton>
              <SettingsButton disabled={busy || !state?.installed} onClick={() => run(() => window.ndDshRouter.nineRouterStop(), 'Managed runtime stopped')}>Stop</SettingsButton>
              <SettingsButton disabled={busy || !state?.installed || !state.trusted} onClick={() => run(() => window.ndDshRouter.nineRouterStart(), 'Managed runtime started')}>Start</SettingsButton>
              <SettingsButton disabled={busy} onClick={() => run(refresh)}>Refresh status</SettingsButton>
            </div>
            {state?.installed && !state?.running && (
              <div className="flex flex-wrap gap-2">
                <Input type="password" autoComplete="new-password" aria-label="Initial 9Router dashboard password"
                  placeholder="Initial dashboard password (12+ characters)" value={password}
                  onChange={e => setPassword(e.target.value)} className="min-w-[240px] max-w-[360px]" />
                <SettingsButton disabled={busy || password.length < 12} onClick={() => run(async () => {
                  await window.ndDshRouter.nineRouterPrepare(password)
                  setPassword('')
                }, 'Encrypted initial dashboard password saved')}>Set initial password</SettingsButton>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Input aria-label="9Router API URL" value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
                placeholder="http://127.0.0.1:20128/v1" className="min-w-[260px] flex-1 font-mono text-[11px]" />
              <Input type="password" autoComplete="off" aria-label="9Router gateway API key"
                value={key} onChange={e => setKey(e.target.value)}
                placeholder="Gateway API key" className="min-w-[190px] flex-1 font-mono text-[11px]" />
            </div>
            <div className="flex flex-wrap gap-2">
              <SettingsButton disabled={busy || !key.trim()} onClick={() => run(async () => {
                setModels(await window.ndDshRouter.nineRouterDiscover({ baseUrl, apiKey: key }))
              }, 'Model discovery completed')}>Discover models</SettingsButton>
              <SettingsButton disabled={busy || !key.trim()} onClick={() => run(async () => {
                const connected = await window.ndDshRouter.nineRouterConnect({ baseUrl, apiKey: key })
                setSuccess('Connected ' + connected.connected + ' models; each is available as an ND Router combo')
                setKey('')
                onConnected?.()
              })}>Connect to ND Router</SettingsButton>
              <SettingsButton disabled={busy} onClick={openDashboard}>Open dashboard inside ND</SettingsButton>
              {dashboard && <SettingsButton disabled={busy} onClick={() => {
                void window.ndDshRouter.nineRouterDashboardClose()
                setDashboard(false)
              }}>Close dashboard</SettingsButton>}
            </div>
            {success && <p role="status" className="text-[11px] text-strong">{success}</p>}
            {models.length > 0 && (
              <div className="max-h-[120px] overflow-auto rounded-md border border-border p-2 text-[11px] text-soft">
                {models.map(m => <div className="font-mono" key={m.id}>{m.id}</div>)}
              </div>
            )}
            {dashboard && (
              <div ref={surface} aria-label="Protected embedded 9Router administration browser"
                className="relative h-[480px] w-full overflow-hidden rounded-lg border border-border bg-background">
                <span className="sr-only">9Router dashboard is displayed in a separate sandboxed Electron WebContentsView</span>
              </div>
            )}
          </div>
        </SettingsRow>
      </SettingsSection>
    </>
  )
}
