import { Fragment, useCallback, useEffect, useState } from 'react'
import type { CapabilityDescriptor, CapabilityKind, CapabilityProviderStatus, CapabilitySetupCheck } from '../../../shared/capabilities'
import { cn } from '../lib/utils'
import { capabilitySubTabFromLocation, type CapabilitySubTab } from '../lib/settings-route'
import { EngineInstallHelp } from './engine-install-help'
import {
  SettingsButton,
  SettingsRow,
  SettingsSection,
  StatusChip,
  rowDesc,
  rowPathText,
  rowStack,
  rowTitle,
  rowValueText,
} from './settings-primitives'

interface CapabilitySettingsProps {
  onError(message: string): void
  subTab?: CapabilitySubTab
  onSelectSubTab?: (subTab: CapabilitySubTab) => void
}

const CAPABILITY_SUB_TABS: { id: CapabilitySubTab; label: string }[] = [
  { id: 'engine', label: 'Engine' },
  { id: 'memory', label: 'Memory' },
  { id: 'context', label: 'Context' },
  { id: 'lifecycle', label: 'Lifecycle' },
]

const KIND_SECTIONS: Array<{ kind: CapabilityKind; title: string; note: string }> = [
  { kind: 'engine', title: 'Engine providers', note: 'Which coding runtime executes assigned work. ND Harness is the always-available built-in; Codex routes are adapters.' },
  { kind: 'memory', title: 'Memory providers', note: 'Durable organizational recall injected into PM, worker, and review prompts. Adapters extend recall in-loop once staged.' },
  { kind: 'context', title: 'Context providers', note: 'How workspace and repo understanding is gathered before a run. Harness-plugin slots mount through the sanctioned patch overlay.' },
]

type Lifecycle = 'active' | 'disabled' | 'unverified' | 'unavailable' | 'not-installed' | 'setup-failed'

export function CapabilitySettings({ onError, subTab: propSubTab, onSelectSubTab }: CapabilitySettingsProps) {
  const [providers, setProviders] = useState<CapabilityDescriptor[]>([])
  const [statuses, setStatuses] = useState<Record<string, CapabilityProviderStatus>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [retrying, setRetrying] = useState(false)
  const [setupProvider, setSetupProvider] = useState<string | null>(null)
  const [setupChecks, setSetupChecks] = useState<Record<string, CapabilitySetupCheck>>({})
  const [setupValues, setSetupValues] = useState<Record<string, Record<string, string>>>({})
  const [internalSubTab, setInternalSubTab] = useState<CapabilitySubTab>(capabilitySubTabFromLocation)

  const activeSubTab = propSubTab ?? internalSubTab
  const handleSelectSubTab = (selected: CapabilitySubTab): void => {
    if (onSelectSubTab) {
      onSelectSubTab(selected)
    } else {
      setInternalSubTab(selected)
    }
  }

  // Providers and statuses re-probe on every call, so this also serves the per-row Re-check.
  const refresh = useCallback(async (): Promise<void> => {
    setRetrying(true)
    try {
      await window.ndDsh.capabilities.providers()
        .then(setProviders)
        .catch((cause) => onError(errorMessage(cause)))
      await window.ndDsh.capabilities.statuses()
        .then(setStatuses)
        .catch((cause) => onError(errorMessage(cause)))
    } finally {
      setRetrying(false)
      setLoading(false)
    }
  }, [onError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const offStatus = window.ndDsh.capabilities.onStatusChanged((value) => setStatuses(value))
    return () => offStatus()
  }, [])

  const verify = async (providerId: string): Promise<void> => {
    if (busy) return
    setBusy(`verify-${providerId}`)
    try {
      await window.ndDsh.capabilities.verify(providerId)
      setStatuses(await window.ndDsh.capabilities.statuses())
    } catch (cause) {
      onError(errorMessage(cause))
      setStatuses(await window.ndDsh.capabilities.statuses().catch(() => statuses))
    } finally {
      setBusy(null)
    }
  }

  const openSetup = async (provider: CapabilityDescriptor): Promise<void> => {
    if (!provider.setup || busy) return
    if (setupProvider === provider.id) {
      setSetupProvider(null)
      return
    }
    setSetupProvider(provider.id)
    setBusy(`check-${provider.id}`)
    try {
      const check = await window.ndDsh.capabilities.checkSetup(provider.id)
      setSetupChecks((current) => ({ ...current, [provider.id]: check }))
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const runSetup = async (provider: CapabilityDescriptor): Promise<void> => {
    if (!provider.setup || busy) return
    setBusy(`setup-${provider.id}`)
    const poll = window.setInterval(() => {
      void window.ndDsh.capabilities.statuses().then(setStatuses).catch(() => undefined)
    }, 350)
    try {
      await window.ndDsh.capabilities.setup(provider.id, setupValues[provider.id] ?? {})
      setProviders(await window.ndDsh.capabilities.providers())
      setStatuses(await window.ndDsh.capabilities.statuses())
      setSetupValues((current) => ({ ...current, [provider.id]: {} }))
      setSetupProvider(null)
    } catch (cause) {
      onError(errorMessage(cause))
      setStatuses(await window.ndDsh.capabilities.statuses().catch(() => statuses))
    } finally {
      window.clearInterval(poll)
      setBusy(null)
    }
  }

  const toggle = async (providerId: string, enabled: boolean): Promise<void> => {
    if (busy) return
    setBusy(`toggle-${providerId}`)
    try {
      await window.ndDsh.capabilities.setEnabled(providerId, enabled)
      setStatuses(await window.ndDsh.capabilities.statuses())
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="min-h-0 overflow-auto px-[26px] pb-[42px] pt-1.5">
      <div className="mt-3 flex items-center gap-1 border-b border-border-soft pb-2.5">
        <nav role="tablist" aria-label="Capabilities sub-tabs" className="flex shrink-0 gap-0.5 rounded-lg border border-border bg-secondary p-[3px]">
          {CAPABILITY_SUB_TABS.map(({ id, label }) => (
            <button
              key={id}
              role="tab"
              aria-selected={activeSubTab === id}
              className={cn(
                'rounded-md px-3 py-1 text-[11px] font-semibold transition-colors',
                activeSubTab === id
                  ? 'bg-primary/10 text-primary'
                  : 'text-faint hover:bg-accent hover:text-soft',
              )}
              onClick={() => handleSelectSubTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      {KIND_SECTIONS.filter(({ kind }) => kind === activeSubTab).map(({ kind, title, note }) => (
        <SettingsSection key={kind} title={title} className="mt-3.5">
          <div className="space-y-1.5">
            <SettingsRow>
              <div className={rowStack}>
                <span className={rowDesc}>{note}</span>
              </div>
            </SettingsRow>
            {loading ? (
              <SettingsRow>
                <div className={rowStack}><strong className={rowTitle}>Detecting providers…</strong></div>
              </SettingsRow>
            ) : null}
            {providers.filter((provider) => provider.kind === kind).map((provider) => {
              const status = statuses[provider.id]
              const enabled = status?.enabled ?? provider.integration === 'builtin'
              const verified = status?.lastVerifiedAt !== undefined && status.lastError === undefined
              const setupInstalled = !provider.setup || status?.setupState === 'installed'
              const lifecycle: Lifecycle = !provider.available
                ? 'unavailable'
                : status?.setupState === 'failed'
                  ? 'setup-failed'
                  : !setupInstalled
                    ? 'not-installed'
                    : enabled
                      ? 'active'
                      : verified
                        ? 'disabled'
                        : 'unverified'
              const setupCheck = setupChecks[provider.id]
              // Engine CLIs become available once installed; other unavailable kinds need build-time adapters.
              const showInstallHelp = !provider.available && (provider.kind === 'engine' || provider.installHelp !== undefined)
              return (
                <Fragment key={provider.id}>
                <SettingsRow>
                  <div className={rowStack}>
                    <strong className={rowTitle}>{provider.name}</strong>
                    <span className={rowDesc}>{provider.description}</span>
                    {!provider.available && provider.unavailableReason ? <span className={rowPathText}>{provider.unavailableReason}</span> : null}
                    {showInstallHelp ? (
                      <EngineInstallHelp
                        help={provider.installHelp}
                        retrying={retrying}
                        onRetry={() => void refresh()}
                        onError={onError}
                        canSetup={Boolean(provider.setup)}
                        onSetup={() => void openSetup(provider)}
                        settingUp={busy === `setup-${provider.id}`}
                        setupProgress={status?.setupProgress}
                        setupMessage={status?.setupMessage}
                      />
                    ) : null}
                    {status?.lastError && (!provider.setup || setupInstalled) ? <span className={rowPathText}>{status.lastError}</span> : null}
                    {status?.setupError ? <span className={rowPathText}>{status.setupError}</span> : null}
                    {status?.setupMessage ? <span className={rowPathText}>{status.setupMessage}{status.setupProgress !== undefined ? ` (${status.setupProgress}%)` : ''}</span> : null}
                    {provider.setup && status?.installedVersion ? <span className={rowPathText}>{`Installed ${status.installedVersion}`}</span> : null}
                    {status?.lastVerifiedAt ? (
                      <span className={rowPathText}>{`Verified ${new Date(status.lastVerifiedAt).toLocaleString()}`}</span>
                    ) : null}
                    {setupProvider === provider.id && provider.setup ? (
                      <div className="mt-2 space-y-2 rounded-lg border border-border-soft bg-secondary/35 p-3">
                        <div>
                          <strong className={rowTitle}>{provider.setup.mode === 'source-runtime' ? 'Bundled runtime' : 'Approved package'}</strong>
                          <p className={rowDesc}>
                            {provider.setup.mode === 'source-runtime'
                              ? `${provider.setup.runtimeId} ${provider.setup.version} from ${provider.setup.sourceLabel}. ND runs a fixed setup routine in the main process; the renderer cannot supply commands or change the source.`
                              : `${provider.setup.packageId} ${provider.setup.version} from ${provider.setup.sourceLabel}. ND accepts only the reviewed HTTPS source and SHA-256 integrity recorded in this desktop build.`}
                          </p>
                          <button className="mt-1 text-[11px] font-medium text-primary hover:underline" onClick={() => void window.ndDsh.browser.openExternal(provider.setup!.sourceUrl)}>View official source</button>
                        </div>
                        <div className="space-y-1">
                          <strong className={rowTitle}>Prerequisites</strong>
                          {busy === `check-${provider.id}` ? <p className={rowDesc}>Checking prerequisites…</p> : null}
                          {setupCheck?.prerequisites.map((item) => (
                            <p key={item.id} className={item.met ? rowDesc : rowPathText}>{item.met ? '✓' : '•'} {item.label}{item.detail ? ` — ${item.detail}` : ''}</p>
                          ))}
                        </div>
                        {provider.setup.fields.map((field) => (
                          <label key={field.id} className="block space-y-1">
                            <span className={rowTitle}>{field.label}{field.required ? ' *' : ''}</span>
                            {field.description ? <span className={`block ${rowDesc}`}>{field.description}</span> : null}
                            <input
                              type={field.sensitive ? 'password' : 'text'}
                              autoComplete="off"
                              placeholder={field.placeholder}
                              value={setupValues[provider.id]?.[field.id] ?? ''}
                              onChange={(event) => setSetupValues((current) => ({
                                ...current,
                                [provider.id]: { ...current[provider.id], [field.id]: event.target.value },
                              }))}
                              className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:border-primary"
                            />
                          </label>
                        ))}
                        <SettingsButton
                          disabled={busy !== null || !setupCheck?.ready || provider.setup.fields.some((field) => field.required && !setupValues[provider.id]?.[field.id]?.trim())}
                          onClick={() => void runSetup(provider)}
                        >
                          {busy === `setup-${provider.id}`
                            ? 'Setting up…'
                            : status?.setupState === 'installed'
                              ? 'Set up again'
                              : provider.setup.mode === 'source-runtime' ? 'Set up' : 'Download & Setup'}
                        </SettingsButton>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-[3px]">
                    <StatusChip good={lifecycle === 'active'} warn={lifecycle === 'unverified' || lifecycle === 'unavailable' || lifecycle === 'not-installed' || lifecycle === 'setup-failed'}>
                      {lifecycleLabel(lifecycle)}
                    </StatusChip>
                    <span className={rowValueText}>{provider.integration === 'builtin' ? 'Built-in' : 'Adapter'}</span>
                    {provider.available ? (
                      <div className="flex items-center gap-1.5">
                        {provider.setup ? (
                          <SettingsButton disabled={busy !== null} onClick={() => void openSetup(provider)}>
                            {busy === `check-${provider.id}`
                              ? 'Checking…'
                              : setupProvider === provider.id
                                ? 'Close setup'
                                : status?.setupState === 'installed'
                                  ? 'Setup'
                                  : provider.setup.mode === 'source-runtime' ? 'Set up' : 'Download & Setup'}
                          </SettingsButton>
                        ) : null}
                        <SettingsButton disabled={busy !== null || !setupInstalled} onClick={() => void verify(provider.id)}>
                          {busy === `verify-${provider.id}` ? 'Verifying…' : 'Verify'}
                        </SettingsButton>
                        <SettingsButton disabled={busy !== null || lifecycle === 'not-installed' || lifecycle === 'setup-failed' || (!enabled && !verified)} onClick={() => void toggle(provider.id, !enabled)}>
                          {enabled ? 'Disable' : 'Enable'}
                        </SettingsButton>
                      </div>
                    ) : null}
                  </div>
                </SettingsRow>
                </Fragment>
              )
            })}
          </div>
        </SettingsSection>
      ))}

      {activeSubTab === 'lifecycle' && (
        <SettingsSection title="Lifecycle" className="mt-3.5">
          <div className="space-y-1.5">
            <SettingsRow>
              <div className={rowStack}>
                <strong className={rowTitle}>Verify before enable</strong>
                <span className={rowDesc}>A provider can only be turned on after Download &amp; Setup completes and its latest verification probe passes. Built-ins start active; adapters stay off until verified. A failed re-verification turns the provider off and removes eligibility until it passes again.</span>
              </div>
            </SettingsRow>
            <SettingsRow>
              <div className={rowStack}>
                <strong className={rowTitle}>Approved setup only</strong>
                <span className={rowDesc}>Download &amp; Setup appears only for adapters whose installer, exact package version, HTTPS source, integrity, prerequisites, and configuration fields ship in ND. Setup values go directly to the trusted adapter and are not stored in capability status.</span>
              </div>
            </SettingsRow>
            <SettingsRow>
              <div className={rowStack}>
                <strong className={rowTitle}>Assignment</strong>
                <span className={rowDesc}>Per-agent engine, memory, and context routing lives in Company → Teams &amp; Skills → AI workers. Role and team routing arrive with role/team editing.</span>
              </div>
            </SettingsRow>
          </div>
        </SettingsSection>
      )}
    </div>
  )
}

function lifecycleLabel(lifecycle: Lifecycle): string {
  if (lifecycle === 'active') return 'Active'
  if (lifecycle === 'disabled') return 'Disabled'
  if (lifecycle === 'unverified') return 'Unverified'
  if (lifecycle === 'unavailable') return 'Unavailable'
  if (lifecycle === 'setup-failed') return 'Setup failed'
  return 'Not installed'
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
