import { useCallback, useEffect, useState } from 'react'
import type { CodingEngineDescriptor } from '../../../shared/contracts'
import { ND_HARNESS_ENGINE_ID } from '../../../shared/coding-engines'
import { EngineInstallHelp } from './engine-install-help'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import type { CapabilityDescriptor, CapabilityProviderStatus } from '../../../shared/capabilities'
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
import { GatewaySettings } from './GatewaySettings'
import { TokenSaverSettings } from './TokenSaverSettings'
import { TokenToolOptimizationSettings } from './TokenToolOptimizationSettings'
import { enginesSubTabFromLocation, type EnginesSubTab } from '../lib/settings-route'
import { cn } from '../lib/utils'

const PREFERRED_CHAT_ENGINE_STORAGE_KEY = 'nd-dsh-preferred-chat-engine'

const ENGINES_SUB_TABS: { id: EnginesSubTab; label: string }[] = [
  { id: 'engines', label: 'Engines' },
  { id: 'gateway', label: 'Gateway' },
  { id: 'tokens', label: 'Token efficiency' },
]

interface EngineSettingsProps {
  onError(message: string): void
  subTab?: EnginesSubTab
  onSelectSubTab?: (subTab: EnginesSubTab) => void
}

export function EngineSettings({ onError, subTab: propSubTab, onSelectSubTab }: EngineSettingsProps) {
  const [engines, setEngines] = useState<CodingEngineDescriptor[]>([])
  const [providers, setProviders] = useState<CapabilityDescriptor[]>([])
  const [statuses, setStatuses] = useState<Record<string, CapabilityProviderStatus>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [retrying, setRetrying] = useState(false)
  const [preferredEngine, setPreferredEngine] = useState<string>(() => {
    try {
      return localStorage.getItem(PREFERRED_CHAT_ENGINE_STORAGE_KEY) || ND_HARNESS_ENGINE_ID
    } catch {
      return ND_HARNESS_ENGINE_ID
    }
  })

  useEffect(() => {
    const sync = (): void => {
      try {
        const saved = localStorage.getItem(PREFERRED_CHAT_ENGINE_STORAGE_KEY)
        setPreferredEngine(saved || ND_HARNESS_ENGINE_ID)
      } catch {
        // ignore
      }
    }
    window.addEventListener('nd-dsh-preferred-engine-changed', sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener('nd-dsh-preferred-engine-changed', sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const updatePreferredEngine = (engineId: string): void => {
    setPreferredEngine(engineId)
    try {
      if (engineId === ND_HARNESS_ENGINE_ID) {
        localStorage.removeItem(PREFERRED_CHAT_ENGINE_STORAGE_KEY)
      } else {
        localStorage.setItem(PREFERRED_CHAT_ENGINE_STORAGE_KEY, engineId)
      }
      window.dispatchEvent(new Event('nd-dsh-preferred-engine-changed'))
    } catch {
      // ignore
    }
  }

  // Detection re-runs on every list() call, so this also serves the per-card Re-check.
  const refresh = useCallback(async (): Promise<void> => {
    setRetrying(true)
    try {
      const [nextEngines, nextProviders, nextStatuses] = await Promise.all([
        window.ndDsh.engines.list(),
        window.ndDsh.capabilities.providers().catch(() => []),
        window.ndDsh.capabilities.statuses().catch(() => ({})),
      ])
      setEngines(nextEngines)
      setProviders(nextProviders)
      setStatuses(nextStatuses)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
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

  const runSetup = async (engineId: string): Promise<void> => {
    if (busy) return
    setBusy(`setup-${engineId}`)
    const poll = window.setInterval(() => {
      void window.ndDsh.capabilities.statuses().then(setStatuses).catch(() => undefined)
    }, 350)
    try {
      await window.ndDsh.capabilities.setup(engineId, {})
      await window.ndDsh.capabilities.verify(engineId).catch(() => undefined)
      await window.ndDsh.capabilities.setEnabled(engineId, true).catch(() => undefined)
      await refresh()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
      setStatuses(await window.ndDsh.capabilities.statuses().catch(() => statuses))
    } finally {
      window.clearInterval(poll)
      setBusy(null)
    }
  }

  const [internalSubTab, setInternalSubTab] = useState<EnginesSubTab>(enginesSubTabFromLocation)
  const activeSubTab = propSubTab ?? internalSubTab
  const handleSelectSubTab = (selected: EnginesSubTab): void => {
    if (onSelectSubTab) {
      onSelectSubTab(selected)
    } else {
      setInternalSubTab(selected)
    }
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center border-b border-border-soft px-[26px] pb-2.5 pt-3">
        <nav role="tablist" aria-label="Coding engines sub-tabs" className="flex shrink-0 gap-0.5 rounded-lg border border-border bg-secondary p-[3px]">
          {ENGINES_SUB_TABS.map(({ id, label }) => (
            <button
              key={id}
              role="tab"
              aria-selected={activeSubTab === id}
              className={cn(
                'rounded-md px-3 py-1 text-[11px] font-semibold transition-colors',
                activeSubTab === id ? 'bg-primary/10 text-primary' : 'text-faint hover:bg-accent hover:text-soft',
              )}
              onClick={() => handleSelectSubTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-[26px] pb-[42px] pt-1.5">
        {activeSubTab === 'engines' && (
          <>
      <SettingsSection title="Coding engines" className="mt-3.5">
        <div className="space-y-1.5">
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>ND control plane</strong>
              <span className={rowDesc}>Companies, roles, tasks, skills, policies, memory, and provider routes stay owned by ND. Engines are replaceable execution adapters.</span>
            </div>
            <StatusChip good>Provider-neutral</StatusChip>
          </SettingsRow>
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Default chat engine</strong>
              <span className={rowDesc}>Engine used when starting a new chat in the workbench. Synchronized with the chat header engine selector.</span>
            </div>
            <div className="flex shrink-0 items-center">
              <Select value={preferredEngine} onValueChange={updatePreferredEngine}>
                <SelectTrigger className="h-7 w-[180px] font-mono text-[11px]">
                  <SelectValue placeholder="Default · ND Harness" />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value={ND_HARNESS_ENGINE_ID}>Default · ND Harness</SelectItem>
                  {engines.filter((engine) => engine.id !== ND_HARNESS_ENGINE_ID).map((engine) => (
                    <SelectItem
                      key={engine.id}
                      value={engine.id}
                      disabled={!engine.available}
                    >
                      {engine.name}{engine.available ? '' : ' · Unavailable'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </SettingsRow>
          {loading ? (
            <SettingsRow>
              <div className={rowStack}><strong className={rowTitle}>Detecting engines…</strong></div>
            </SettingsRow>
          ) : null}
          {engines.map((engine) => {
            const capabilityProvider = providers.find((p) => p.id === engine.id)
            const status = statuses[engine.id]
            const canSetup = Boolean(capabilityProvider?.setup)
            const isSettingUp = busy === `setup-${engine.id}`
              || status?.setupState === 'downloading'
              || status?.setupState === 'installing'
              || status?.setupState === 'configuring'
            return (
              <SettingsRow key={engine.id}>
                <div className={rowStack}>
                  <strong className={rowTitle}>{engine.name}</strong>
                  <span className={rowDesc}>{engine.description}</span>
                  <span className={rowPathText}>{capabilitySummary(engine)}</span>
                  {status?.installedVersion ? (
                    <span className={rowPathText}>Installed {status.installedVersion} in ND managed runtime</span>
                  ) : null}
                  {status?.setupError ? (
                    <span className={rowPathText}>{status.setupError}</span>
                  ) : null}
                  {isSettingUp && status?.setupMessage ? (
                    <span className={rowPathText}>
                      {status.setupMessage}{status.setupProgress !== undefined ? ` (${status.setupProgress}%)` : ''}
                    </span>
                  ) : null}
                  {!engine.available && engine.unavailableReason ? <span className={rowPathText}>{engine.unavailableReason}</span> : null}
                  {!engine.available ? (
                    <EngineInstallHelp
                      help={engine.installHelp}
                      retrying={retrying}
                      onRetry={() => void refresh()}
                      onError={onError}
                      canSetup={canSetup}
                      onSetup={() => void runSetup(engine.id)}
                      settingUp={isSettingUp}
                      setupProgress={status?.setupProgress}
                      setupMessage={status?.setupMessage}
                    />
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-[3px]">
                  <StatusChip good={engine.available} warn={!engine.available}>{engine.available ? 'Available' : 'Unavailable'}</StatusChip>
                  <span className={rowValueText}>{engine.integration === 'primary' ? 'Primary' : 'Delegated'}</span>
                  {canSetup ? (
                    <SettingsButton
                      disabled={busy !== null}
                      onClick={() => void runSetup(engine.id)}
                      className={cn(
                        engine.available
                          ? 'px-2 py-0.5 text-[9px] text-faint hover:text-foreground'
                          : 'border-primary/30 bg-primary/10 px-2.5 py-1 text-[10px] font-semibold text-primary hover:bg-primary/20',
                      )}
                    >
                      {isSettingUp
                        ? 'Setting up…'
                        : engine.available
                          ? 'Reinstall'
                          : 'Download & Setup'}
                    </SettingsButton>
                  ) : null}
                </div>
              </SettingsRow>
            )
          })}
        </div>
      </SettingsSection>

      <SettingsSection title="Engine boundaries">
        <div className="space-y-1.5">
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>ND Harness</strong>
              <span className={rowDesc}>Primary durable runtime for ND agents, browser, MCP, skills, approvals, and provider-routed models.</span>
            </div>
          </SettingsRow>
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Antigravity CLI (agy)</strong>
              <span className={rowDesc}>Google Antigravity CLI (agy) managed directly by ND: streamed multi-turn conversations over stream-json wires with native Google-account credentials. Edits are scoped to the active workspace directory, and permission mode maps to native agy flags (plan mode for read-only; accept-edits and auto-approval for workspace write/full access).</span>
            </div>
          </SettingsRow>
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Codex CLI (direct)</strong>
              <span className={rowDesc}>ND spawns and manages the official Codex app-server: streamed chat threads in the workbench, approval prompts, and workspace-scoped unattended runs. Codex account, model, project trust, and authentication remain native to Codex.</span>
            </div>
          </SettingsRow>
          <SettingsRow>
            <div className={rowStack}>
              <strong className={rowTitle}>Codex (delegated)</strong>
              <span className={rowDesc}>Fallback route where the ND runtime delegates one-shot implementation work through its pinned Codex adapter. Useful when the direct engine is unavailable.</span>
            </div>
          </SettingsRow>
        </div>
      </SettingsSection>
            </>
        )}
        {activeSubTab === 'gateway' && <GatewaySettings onError={onError} />}
        {activeSubTab === 'tokens' && (
          <>
            <TokenToolOptimizationSettings onError={onError} />
            <TokenSaverSettings onError={onError} />
          </>
        )}
      </div>
    </div>
  )
}

function capabilitySummary(engine: CodingEngineDescriptor): string {
  const labels: Array<[keyof CodingEngineDescriptor['capabilities'], string]> = [
    ['workspace', 'workspace'],
    ['filesystem', 'files'],
    ['shell', 'shell'],
    ['browser', 'browser'],
    ['skills', 'skills'],
    ['mcp', 'MCP'],
    ['modelProviderRouting', 'ND model routing'],
    ['humanApprovals', 'human approvals'],
    ['streaming', 'streaming'],
    ['persistentSessions', 'persistent sessions'],
  ]
  return labels.filter(([key]) => engine.capabilities[key]).map(([, label]) => label).join(' · ') || 'No advertised capabilities'
}