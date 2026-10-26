import { useEffect, useState } from 'react'
import type {
  RouterComboEntry,
  RouterProviderView,
  RouterState,
  RouterTestResult,
  RouterUsageSummary,
} from '../../../shared/router'
import {
  SettingsButton,
  SettingsNote,
  SettingsRow,
  SettingsSection,
  StatusChip,
  rowDesc,
  rowPathText,
  rowStack,
  rowTitle,
  rowValueText,
} from './settings-primitives'
import { Input } from './ui/input'
import { Switch } from './ui/switch'

interface RouterSettingsProps {
  onError(message: string): void
}

interface ComboDraftEntry {
  providerId: string
  model: string
}

export function RouterSettings({ onError }: RouterSettingsProps) {
  const [state, setState] = useState<RouterState | null>(null)
  const [usage, setUsage] = useState<RouterUsageSummary | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, RouterTestResult>>({})

  const [providerName, setProviderName] = useState('')
  const [providerBaseUrl, setProviderBaseUrl] = useState('')
  const [providerModels, setProviderModels] = useState('')
  const [providerKey, setProviderKey] = useState('')

  const [comboName, setComboName] = useState('')
  const [comboStrategy, setComboStrategy] = useState<'priority' | 'round-robin'>('priority')
  const [comboEntries, setComboEntries] = useState<ComboDraftEntry[]>([{ providerId: '', model: '' }])

  useEffect(() => {
    let mounted = true
    void (async () => {
      try {
        const next = await window.ndDshRouter.state()
        const summary = await window.ndDshRouter.usage()
        if (!mounted) return
        setState(next)
        setUsage(summary)
      } catch (cause) {
        onError(message(cause))
      }
    })()
    return () => { mounted = false }
  }, [onError])

  const apply = (key: string, action: () => Promise<RouterState>): void => {
    setBusy(key)
    void action()
      .then(async (next) => {
        setState(next)
        setUsage(await window.ndDshRouter.usage())
      })
      .catch((cause) => onError(message(cause)))
      .finally(() => setBusy(null))
  }

  const runTest = (providerId: string): void => {
    setBusy(`test:${providerId}`)
    void window.ndDshRouter.testProvider(providerId)
      .then((result) => setTests((current) => ({ ...current, [providerId]: result })))
      .catch((cause) => onError(message(cause)))
      .finally(() => setBusy(null))
  }

  const addProvider = (): void => {
    const models = providerModels.split(/[\n,]/).map((model) => model.trim()).filter(Boolean)
    if (!providerName.trim() || !providerBaseUrl.trim()) {
      onError('Give the provider a name and a base URL.')
      return
    }
    apply('provider', () => window.ndDshRouter.saveProvider({
      kind: 'openai-compatible',
      name: providerName.trim(),
      baseUrl: providerBaseUrl.trim(),
      models,
      ...(providerKey.trim() ? { apiKey: providerKey.trim() } : {}),
    }))
    setProviderName('')
    setProviderBaseUrl('')
    setProviderModels('')
    setProviderKey('')
  }

  const addCombo = (): void => {
    const models: RouterComboEntry[] = comboEntries
      .map((entry) => ({ providerId: entry.providerId, model: entry.model.trim() }))
      .filter((entry) => entry.providerId && entry.model)
    if (!comboName.trim() || models.length === 0) {
      onError('Give the combo a name and at least one provider/model entry.')
      return
    }
    apply('combo', () => window.ndDshRouter.saveCombo({ name: comboName.trim(), strategy: comboStrategy, models }))
    setComboName('')
    setComboEntries([{ providerId: '', model: '' }])
  }

  const disabled = !state?.endpoint || busy !== null
  const providers = state?.providers ?? []
  const combos = state?.combos ?? []
  const counters = state?.counters ?? { requests: 0, ok: 0, failed: 0, lastError: null }

  return (
    <>
      <SettingsSection title="ND Router" className="mt-3.5">
        <div className="space-y-1.5">
          <SettingsRow>
            <div className={rowStack}>
              <span className="flex items-center gap-2">
                <strong className={rowTitle}>Rust routing gateway</strong>
                <StatusChip good={Boolean(state?.endpoint)} warn={Boolean(state) && !state?.endpoint}>
                  {state?.endpoint ? 'Online' : state ? 'Unavailable' : 'Loading'}
                </StatusChip>
              </span>
              <span className={rowDesc}>
                Routes model requests across providers and accounts, with ordered fallback. Every combo becomes a model
                in ND's picker under “ND Router”. External apps use ND Gateway, which forwards here.
              </span>
              {state?.endpoint ? <span className={rowPathText}>{state.endpoint}</span> : null}
              {state && !state.endpoint ? (
                <span className={rowDesc}>The sidecar build does not expose ND Router yet. Rebuild the core runtime.</span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className={rowValueText}>{providers.length} providers · {combos.length} combos · {counters.requests} requests</span>
            </div>
          </SettingsRow>
          <SettingsNote>
            Free lanes first: point an OpenAI-compatible provider at a local plugin gateway (for example dsh-our-free-model),
            then order providers inside a combo. Prompt Shield still runs before anything leaves ND.
          </SettingsNote>
        </div>
      </SettingsSection>

      <SettingsSection title="Providers">
        <div className="space-y-1.5">
          {providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              disabled={disabled}
              busy={busy}
              test={tests[provider.id]}
              onToggle={(enabled) => apply(`toggle:${provider.id}`, () => window.ndDshRouter.saveProvider({ id: provider.id, isActive: enabled }))}
              onTest={() => runTest(provider.id)}
              onRemove={() => apply(`remove:${provider.id}`, () => window.ndDshRouter.deleteProvider(provider.id))}
              onAddAccount={(label, apiKey) => apply(`account:${provider.id}`, () => window.ndDshRouter.saveAccount({ providerId: provider.id, label, apiKey }))}
              onRemoveAccount={(accountId) => apply(`account-remove:${provider.id}`, () => window.ndDshRouter.deleteAccount(provider.id, accountId))}
            />
          ))}
          {providers.length === 0 ? <SettingsNote>No providers yet. Add an OpenAI-compatible endpoint below.</SettingsNote> : null}

          <SettingsRow className="items-start">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex min-w-0 gap-2">
                <Input aria-label="Provider name" placeholder="Name, e.g. Free plugin" value={providerName} disabled={disabled} onChange={(event) => setProviderName(event.target.value)} className="max-w-[180px]" />
                <Input aria-label="Provider base URL" placeholder="http://127.0.0.1:8326" value={providerBaseUrl} disabled={disabled} onChange={(event) => setProviderBaseUrl(event.target.value)} className="min-w-0 flex-1 font-mono text-[11px]" />
              </div>
              <div className="flex min-w-0 gap-2">
                <Input aria-label="Provider models" placeholder="Models (comma separated, optional)" value={providerModels} disabled={disabled} onChange={(event) => setProviderModels(event.target.value)} className="min-w-0 flex-1 font-mono text-[11px]" />
                <Input aria-label="Provider API key" type="password" autoComplete="off" placeholder="API key (optional)" value={providerKey} disabled={disabled} onChange={(event) => setProviderKey(event.target.value)} className="max-w-[220px]" />
              </div>
              <div className="flex items-center gap-1">
                <SettingsButton disabled={disabled} onClick={addProvider}>Add provider</SettingsButton>
              </div>
            </div>
          </SettingsRow>
        </div>
      </SettingsSection>

      <SettingsSection title="Combos">
        <div className="space-y-1.5">
          {combos.map((combo) => (
            <SettingsRow key={combo.id}>
              <div className={rowStack}>
                <span className="flex items-center gap-2">
                  <strong className={rowTitle}>{combo.name}</strong>
                  <StatusChip neutral>{combo.strategy === 'round-robin' ? 'Round-robin' : 'Priority'}</StatusChip>
                </span>
                <span className={rowDesc}>
                  {combo.models.map((entry) => {
                    const provider = providers.find((candidate) => candidate.id === entry.providerId)
                    return `${provider?.name ?? entry.providerId} / ${entry.model}`
                  }).join('  →  ')}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <SettingsButton disabled={disabled} onClick={() => apply(`combo-remove:${combo.id}`, () => window.ndDshRouter.deleteCombo(combo.id))}>
                  Remove
                </SettingsButton>
              </div>
            </SettingsRow>
          ))}

          <SettingsRow className="items-start">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex items-center gap-2">
                <Input aria-label="Combo name" placeholder="Combo name, e.g. free" value={comboName} disabled={disabled} onChange={(event) => setComboName(event.target.value)} className="max-w-[240px]" />
                <div className="flex gap-1">
                  {(['priority', 'round-robin'] as const).map((strategy) => (
                    <SettingsButton key={strategy} active={comboStrategy === strategy} disabled={disabled} onClick={() => setComboStrategy(strategy)}>
                      {strategy === 'priority' ? 'Priority' : 'Round-robin'}
                    </SettingsButton>
                  ))}
                </div>
              </div>
              {comboEntries.map((entry, index) => (
                <div key={index} className="flex items-center gap-2">
                  <select
                    aria-label={`Combo entry ${index + 1} provider`}
                    className="h-8 shrink-0 rounded-md border border-border bg-surface-1 px-2 text-[11px] text-soft"
                    value={entry.providerId}
                    disabled={disabled}
                    onChange={(event) => setComboEntries((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, providerId: event.target.value } : item))}
                  >
                    <option value="">Provider…</option>
                    {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                  </select>
                  <Input
                    aria-label={`Combo entry ${index + 1} model`}
                    placeholder="Model id, e.g. combo/free or gpt-4.1"
                    value={entry.model}
                    disabled={disabled}
                    onChange={(event) => setComboEntries((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, model: event.target.value } : item))}
                    className="min-w-0 flex-1 font-mono text-[11px]"
                  />
                  <SettingsButton disabled={disabled || comboEntries.length === 1} onClick={() => setComboEntries((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                    Remove
                  </SettingsButton>
                </div>
              ))}
              <div className="flex items-center gap-1">
                <SettingsButton disabled={disabled} onClick={() => setComboEntries((current) => [...current, { providerId: '', model: '' }])}>
                  Add lane
                </SettingsButton>
                <SettingsButton disabled={disabled} onClick={addCombo}>Save combo</SettingsButton>
              </div>
            </div>
          </SettingsRow>
        </div>
      </SettingsSection>

      <SettingsSection title="Usage">
        <SettingsRow>
          <div className={rowStack}>
            <strong className={rowTitle}>Router activity</strong>
            <span className={rowDesc}>Counts and latency stay on this machine. Prompt content is never recorded here.</span>
            {counters.lastError ? <span className={rowPathText}>{counters.lastError}</span> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className={rowValueText}>
              {usage?.requests ?? 0} requests · {usage?.ok ?? 0} ok · {usage?.failed ?? 0} failed · {usage?.avgLatencyMs ?? 0} ms avg
            </span>
            <SettingsButton
              disabled={disabled || (usage?.requests ?? 0) === 0}
              onClick={() => {
                setBusy('usage-reset')
                void window.ndDshRouter.resetUsage()
                  .then(setUsage)
                  .catch((cause) => onError(message(cause)))
                  .finally(() => setBusy(null))
              }}
            >
              Reset
            </SettingsButton>
          </div>
        </SettingsRow>
      </SettingsSection>
    </>
  )
}

function ProviderRow({
  provider,
  disabled,
  busy,
  test,
  onToggle,
  onTest,
  onRemove,
  onAddAccount,
  onRemoveAccount,
}: {
  provider: RouterProviderView
  disabled: boolean
  busy: string | null
  test?: RouterTestResult | undefined
  onToggle(enabled: boolean): void
  onTest(): void
  onRemove(): void
  onAddAccount(label: string, apiKey: string): void
  onRemoveAccount(accountId: string): void
}) {
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  return (
    <div className="rounded-lg border border-border-soft bg-surface-1 px-[13px] py-[11px]">
      <div className="flex min-w-0 items-center justify-between gap-4">
        <div className={rowStack}>
          <span className="flex items-center gap-2">
            <strong className={rowTitle}>{provider.name}</strong>
            <StatusChip neutral>{provider.kind}</StatusChip>
            {provider.hasSecret ? <StatusChip good>Key saved</StatusChip> : null}
          </span>
          <span className={rowPathText}>{provider.baseUrl || '—'}</span>
          {provider.models.length > 0 ? <span className={rowDesc}>{provider.models.join(', ')}</span> : null}
          {test ? (
            <span className={rowDesc}>
              {test.ok ? `OK · ${test.latencyMs} ms · ${test.model}` : `Failed · ${test.statusCode} · ${test.error ?? 'unknown error'}`}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Switch aria-label={`Enable ${provider.name}`} checked={provider.isActive} disabled={disabled} onCheckedChange={onToggle} />
          <SettingsButton disabled={disabled || busy === `test:${provider.id}`} onClick={onTest}>
            {busy === `test:${provider.id}` ? 'Testing…' : 'Test'}
          </SettingsButton>
          <SettingsButton disabled={disabled} onClick={onRemove}>Remove</SettingsButton>
        </div>
      </div>

      {provider.accounts.length > 0 ? (
        <div className="mt-2 space-y-1 border-t border-border-soft pt-2">
          {provider.accounts.map((account) => (
            <div key={account.id} className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-[10px] font-semibold text-soft">{account.label}</span>
                <StatusChip neutral>{account.kind}</StatusChip>
                {account.lastStatus ? <span className={rowPathText}>{account.lastStatus}</span> : null}
              </span>
              <SettingsButton disabled={disabled} onClick={() => onRemoveAccount(account.id)}>Remove</SettingsButton>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-2 flex items-center gap-2 border-t border-border-soft pt-2">
        <Input aria-label={`${provider.name} account label`} placeholder="Account label" value={label} disabled={disabled} onChange={(event) => setLabel(event.target.value)} className="max-w-[180px]" />
        <Input aria-label={`${provider.name} account API key`} type="password" autoComplete="off" placeholder="Account API key" value={key} disabled={disabled} onChange={(event) => setKey(event.target.value)} className="max-w-[220px]" />
        <SettingsButton
          disabled={disabled || !label.trim() || !key.trim()}
          onClick={() => {
            onAddAccount(label.trim(), key.trim())
            setLabel('')
            setKey('')
          }}
        >
          Add account
        </SettingsButton>
      </div>
    </div>
  )
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
