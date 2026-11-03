import { useEffect, useState } from 'react'
import type { SuperagentPrototypePhase, SuperagentPrototypeStatus } from '../../../shared/superagent-prototype'
import {
  SettingsButton,
  SettingsNote,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  StatusChip,
  rowDesc,
  rowPathText,
  rowStack,
  rowTitle,
} from './settings-primitives'

const PHASE_LABEL: Record<SuperagentPrototypePhase, string> = {
  'not-installed': 'Not installed',
  installing: 'Installing',
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  error: 'Error',
}

/**
 * Marks a research prototype ND installs and supervises on the operator's
 * behalf. The bundle is not production-ready and can be removed at any time.
 */
export function SuperagentPrototypeCard({ onError, onOpenBrowser }: {
  onError(message: string): void
  onOpenBrowser(): void
}) {
  const [status, setStatus] = useState<SuperagentPrototypeStatus | null>(null)
  const [busy, setBusy] = useState<'install' | 'start' | 'stop' | 'open' | null>(null)

  useEffect(() => {
    let mounted = true
    const refresh = async (): Promise<void> => {
      try {
        const next = await window.ndDshSuperagent.status()
        if (mounted) setStatus(next)
      } catch (cause) {
        if (mounted) onError(errorMessage(cause))
      }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 3_000)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [])

  const run = async (action: 'install' | 'start' | 'stop'): Promise<void> => {
    if (busy) return
    setBusy(action)
    try {
      const next = action === 'install'
        ? await window.ndDshSuperagent.install()
        : action === 'start'
          ? await window.ndDshSuperagent.start()
          : await window.ndDshSuperagent.stop()
      setStatus(next)
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const openPanel = async (): Promise<void> => {
    if (busy) return
    setBusy('open')
    try {
      const { url } = await window.ndDshSuperagent.open()
      if (!url) {
        onError('Start the Superagent prototype before opening its panel.')
        return
      }
      await window.ndDsh.browser.navigate(url)
      onOpenBrowser()
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const phase = status?.phase ?? 'stopped'
  const running = phase === 'running'
  const installBusy = busy === 'install' || phase === 'installing'
  const canStart = status !== null && phase !== 'not-installed' && phase !== 'installing'

  return (
    <SettingsSection title="Research prototypes" className="mt-0">
      <SettingsRow label="Superagent prototype">
        <div className={rowStack}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={rowTitle}>Superagent</span>
            <span className="rounded-full border border-warning/40 bg-warning/10 px-1.5 py-px text-[8px] font-bold uppercase tracking-wide text-warning">
              Prototype
            </span>
            <StatusChip
              good={running}
              warn={phase === 'installing' || phase === 'starting' || phase === 'error'}
              neutral={!running && phase !== 'installing' && phase !== 'starting' && phase !== 'error'}
            >
              {PHASE_LABEL[phase]}
            </StatusChip>
          </div>
          <span className={rowDesc}>
            Proactive agent for one GitHub repository, packaged as a separate DSH bundle and profile. Research code, not production-ready; ND installs, starts, and stops it here, and the repository, accounts, and policy are configured in its panel. May be removed at any time.
          </span>
          {status ? (
            <div className="mt-1 flex min-w-0 flex-col gap-[3px]">
              <span className={rowPathText}>Checkout: {status.checkoutPath}</span>
              <span className={rowPathText}>State: {status.stateDir}</span>
              {status.panelUrl ? <span className={rowPathText}>Panel: {status.panelUrl}</span> : null}
            </div>
          ) : null}
          {status?.message ? <SettingsNote>{status.message}</SettingsNote> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <SettingsButton
            disabled={busy !== null || installBusy}
            onClick={() => { void run('install') }}
          >
            {installBusy ? 'Installing…' : phase === 'not-installed' ? 'Install' : 'Repair'}
          </SettingsButton>
          <SettingsSwitch
            label="Start Superagent prototype"
            checked={running || phase === 'starting'}
            disabled={!canStart || busy !== null}
            onCheckedChange={(checked) => { void run(checked ? 'start' : 'stop') }}
          />
          <SettingsButton
            disabled={busy !== null || !running || !status?.panelUrl}
            onClick={() => { void openPanel() }}
          >
            Open panel
          </SettingsButton>
        </div>
      </SettingsRow>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-[13px] pt-2 text-[10px]">
        <span className="text-faint">Prerequisites:</span>
        <StatusChip good={status?.prerequisites.git} warn={status !== null && !status.prerequisites.git}>git</StatusChip>
        <StatusChip good={status?.prerequisites.pnpm} warn={status !== null && !status.prerequisites.pnpm}>pnpm</StatusChip>
        <StatusChip good={status?.prerequisites.gh} warn={status !== null && !status.prerequisites.gh}>gh</StatusChip>
        {status && !status.prerequisites.pnpm ? <SettingsNote>Enable pnpm with <code>corepack enable pnpm</code>, then Repair.</SettingsNote> : null}
        {status && !status.prerequisites.gh ? <SettingsNote>The panel reports the missing GitHub CLI until <code>gh auth login</code> succeeds.</SettingsNote> : null}
      </div>
      {phase === 'error' && status?.logTail.length ? (
        <pre className="mt-2 max-h-[180px] overflow-auto rounded-lg border border-border-soft bg-surface-1 px-[13px] py-2 font-mono text-[9px]/[1.5] text-faint">
          {status.logTail.slice(-12).join('\n')}
        </pre>
      ) : null}
    </SettingsSection>
  )
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
