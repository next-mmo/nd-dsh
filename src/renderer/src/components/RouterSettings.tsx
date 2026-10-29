import { useEffect, useState } from 'react'
import { NineRouterSettings } from './NineRouterSettings'
import {
  ROUTER_WEB_LANE_MODELS,
  isRouterWebProviderKind,
  type RouterComboEntry,
  type RouterProviderView,
  type RouterState,
  type RouterTestResult,
  type RouterUsageSummary,
} from '../../../shared/router'
import { RouterExternalApi } from './RouterExternalApi'
import { RouterPlayground } from './RouterPlayground'
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

type ProviderKindChoice = 'openai-compatible' | 'antigravity' | 'qoder' | 'chatgpt-web' | 'gemini-web'

export function RouterSettings({ onError }: RouterSettingsProps) {
  const [state, setState] = useState<RouterState | null>(null)
  const [usage, setUsage] = useState<RouterUsageSummary | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, RouterTestResult>>({})

  const [providerKind, setProviderKind] = useState<ProviderKindChoice>('openai-compatible')
  const [providerName, setProviderName] = useState('')
  const [providerBaseUrl, setProviderBaseUrl] = useState('')
  const [providerModels, setProviderModels] = useState('')
  const [providerKey, setProviderKey] = useState('')

  const [comboName, setComboName] = useState('')
  const [comboStrategy, setComboStrategy] = useState<'priority' | 'round-robin'>('priority')
  const [comboEntries, setComboEntries] = useState<ComboDraftEntry[]>([{ providerId: '', model: '' }])
  const [comboShowInChat, setComboShowInChat] = useState(true)
  const [comboVisibilityTouched, setComboVisibilityTouched] = useState(false)

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

  const changeProviderKind = (kind: ProviderKindChoice): void => {
    setProviderKind(kind)
    if (isRouterWebProviderKind(kind) && !providerModels.trim()) {
      setProviderModels(ROUTER_WEB_LANE_MODELS[kind].join(', '))
    }
  }

  const addProvider = (): void => {
    const models = providerModels.split(/[\n,]/).map((model) => model.trim()).filter(Boolean)
    if (isRouterWebProviderKind(providerKind)) {
      apply('provider', () => window.ndDshRouter.saveProvider({
        kind: providerKind,
        ...(providerName.trim() ? { name: providerName.trim() } : {}),
        models: models.length > 0 ? models : ROUTER_WEB_LANE_MODELS[providerKind],
      }))
      setProviderName('')
      setProviderModels('')
      return
    }
    if (!providerName.trim()) {
      onError('Give the provider a name.')
      return
    }
    if (providerKind === 'antigravity' || providerKind === 'qoder') {
      apply('provider', () => window.ndDshRouter.saveProvider({
        kind: providerKind,
        name: providerName.trim(),
        models,
      }))
      setProviderName('')
      setProviderModels('')
      return
    }
    if (!providerBaseUrl.trim()) {
      onError('Give the provider a base URL.')
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
    apply('combo', () => window.ndDshRouter.saveCombo({
      name: comboName.trim(),
      strategy: comboStrategy,
      models,
      hiddenFromChat: !comboVisibleInChat,
    }))
    setComboName('')
    setComboEntries([{ providerId: '', model: '' }])
    setComboVisibilityTouched(false)
    setComboShowInChat(true)
  }

  const disabled = !state?.endpoint || busy !== null
  const providers = state?.providers ?? []
  const combos = state?.combos ?? []
  const counters = state?.counters ?? { requests: 0, ok: 0, failed: 0, lastError: null }
  const draftHasWebLane = comboEntries.some((entry) => {
    const provider = providers.find((candidate) => candidate.id === entry.providerId)
    return provider ? isRouterWebProviderKind(provider.kind) : false
  })
  const comboVisibleInChat = comboVisibilityTouched ? comboShowInChat : !draftHasWebLane

  return (
    <>
      <NineRouterSettings onError={onError} onConnected={() => {
        void window.ndDshRouter.state().then(setState).catch(cause => onError(message(cause)))
        void window.ndDshRouter.usage().then(setUsage).catch(cause => onError(message(cause)))
      }} />
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
                Routes model requests across providers and accounts, with ordered fallback. Visible combos become models in
                ND's picker; private web combos stay callable at the loopback endpoint and in the playground. Local apps use
                the external API section below.
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
            or add Antigravity, Qoder CLI, ChatGPT Web, or Gemini Web. Web lanes drive the embedded browser's signed-in session
            and stay private by default. Prompt Shield still runs before anything leaves ND.
          </SettingsNote>
        </div>
      </SettingsSection>

      <RouterPlayground state={state} onError={onError} />

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
              onAddAccount={(input) => apply(`account:${provider.id}`, () => window.ndDshRouter.saveAccount({
                providerId: provider.id,
                label: input.label,
                ...(provider.kind === 'antigravity'
                  ? { kind: 'cli' as const, selector: input.selector }
                  : provider.kind === 'qoder'
                    ? {
                        kind: 'cli' as const,
                        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
                        ...(input.configDir ? { envDir: input.configDir } : {}),
                      }
                    : { apiKey: input.apiKey }),
              }))}
              onRemoveAccount={(accountId) => apply(`account-remove:${provider.id}`, () => window.ndDshRouter.deleteAccount(provider.id, accountId))}
            />
          ))}
          {providers.length === 0 ? <SettingsNote>No providers yet. Add an OpenAI-compatible endpoint, Antigravity, Qoder CLI, ChatGPT Web, or Gemini Web below.</SettingsNote> : null}

          <SettingsRow className="items-start">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <select
                  aria-label="Provider kind"
                  className="h-8 w-[230px] shrink-0 rounded-md border border-border bg-surface-1 px-2 text-[11px] text-soft"
                  value={providerKind}
                  disabled={disabled}
                  onChange={(event) => changeProviderKind(event.target.value as ProviderKindChoice)}
                >
                  <option value="openai-compatible">OpenAI-compatible</option>
                  <option value="antigravity">Antigravity (agy CLI)</option>
                  <option value="qoder">Qoder CLI</option>
                  <option value="chatgpt-web">ChatGPT Web</option>
                  <option value="gemini-web">Gemini Web</option>
                </select>
                <span className={rowDesc}>Web lanes use the embedded browser; no key is stored.</span>
              </div>
              <div className="flex min-w-0 gap-2">
                <Input aria-label="Provider name" placeholder={isRouterWebProviderKind(providerKind) ? 'Name (optional)' : 'Name, e.g. Free plugin'} value={providerName} disabled={disabled} onChange={(event) => setProviderName(event.target.value)} className="max-w-[180px]" />
                {providerKind === 'openai-compatible' ? (
                  <Input aria-label="Provider base URL" placeholder="http://127.0.0.1:8326" value={providerBaseUrl} disabled={disabled} onChange={(event) => setProviderBaseUrl(event.target.value)} className="min-w-0 flex-1 font-mono text-[11px]" />
                ) : null}
              </div>
              <div className="flex min-w-0 gap-2">
                <Input
                  aria-label="Provider models"
                  placeholder={providerKind === 'antigravity' ? 'Models, e.g. gemini-3.8-flash-medium, claude-sonnet-5-5-medium (from `agy models`)' : providerKind === 'qoder' ? 'Models, e.g. auto, lite, performance (from `qoder --list-models`)' : providerKind === 'chatgpt-web' ? 'Model id (default: default)' : providerKind === 'gemini-web' ? 'Gemini modes, e.g. 3.5 Flash-Lite, 3.8 Flash, 3.1 Pro' : 'Models (comma separated, optional)'}
                  value={providerModels}
                  disabled={disabled}
                  onChange={(event) => setProviderModels(event.target.value)}
                  className="min-w-0 flex-1 font-mono text-[11px]"
                />
                {providerKind === 'openai-compatible' ? (
                  <Input aria-label="Provider API key" type="password" autoComplete="off" placeholder="API key (optional)" value={providerKey} disabled={disabled} onChange={(event) => setProviderKey(event.target.value)} className="max-w-[220px]" />
                ) : null}
              </div>
              {providerKind === 'antigravity' ? (
                <span className={rowDesc}>
                  Runs your installed agy CLI — it owns the Google sign-in, ND never sees tokens. agy 1.3.1 runs model
                  calls on its default signed-in account; account entries below carry the AGY_ACCOUNT name (and can carry
                  an ADC credentials path) so per-account routing activates as soon as the CLI honors them.
                </span>
              ) : providerKind === 'qoder' ? (
                <span className={rowDesc}>
                  Runs your installed qoder CLI — each account selects its own CLI profile folder (QODER_CONFIG_DIR)
                  and/or supplies a personal access token (QODER_PERSONAL_ACCESS_TOKEN). ND never reads the CLI's stored
                  tokens. Requests run one turn with tools disabled, so the CLI answers instead of touching your workspace.
                </span>
              ) : isRouterWebProviderKind(providerKind) ? (
                <span className={rowDesc}>
                  Drives the embedded browser's signed-in {providerKind === 'chatgpt-web' ? 'ChatGPT' : 'Gemini'} session. Every
                  router request starts a fresh conversation. New web combos stay private unless you opt them into personal chat.
                </span>
              ) : null}
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
                  {combo.hiddenFromChat ? <StatusChip neutral>Private</StatusChip> : null}
                </span>
                <span className={rowDesc}>
                  {combo.models.map((entry) => {
                    const provider = providers.find((candidate) => candidate.id === entry.providerId)
                    return `${provider?.name ?? entry.providerId} / ${entry.model}`
                  }).join('  →  ')}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={rowDesc}>Personal chat</span>
                <Switch
                  aria-label={`Show ${combo.name} in personal chat`}
                  checked={!combo.hiddenFromChat}
                  disabled={disabled}
                  onCheckedChange={(checked) => apply(`combo-visibility:${combo.id}`, () => window.ndDshRouter.saveCombo({
                    id: combo.id,
                    name: combo.name,
                    strategy: combo.strategy,
                    models: combo.models,
                    hiddenFromChat: !checked,
                  }))}
                />
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
              <div className="flex items-center gap-2">
                <Switch
                  aria-label="Show new combo in personal chat"
                  checked={comboVisibleInChat}
                  disabled={disabled}
                  onCheckedChange={(checked) => {
                    setComboVisibilityTouched(true)
                    setComboShowInChat(checked)
                  }}
                />
                <span className={rowDesc}>
                  {comboVisibleInChat ? 'Show in personal chat' : 'Private — callable at /v1, hidden from personal chat'}
                </span>
              </div>
              {comboEntries.map((entry, index) => (
                <div key={index} className="flex items-center gap-2">
                  <select
                    aria-label={`Combo entry ${index + 1} provider`}
                    className="h-8 shrink-0 rounded-md border border-border bg-surface-1 px-2 text-[11px] text-soft"
                    value={entry.providerId}
                    disabled={disabled}
                    onChange={(event) => {
                      const provider = providers.find((candidate) => candidate.id === event.target.value)
                      setComboEntries((current) => current.map((item, itemIndex) => itemIndex === index
                        ? { ...item, providerId: event.target.value, model: item.model || provider?.models[0] || '' }
                        : item))
                    }}
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

      <RouterExternalApi state={state} onError={onError} />

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
  onAddAccount(input: { label: string; apiKey: string; selector: string; configDir: string }): void
  onRemoveAccount(accountId: string): void
}) {
  const isAgy = provider.kind === 'antigravity'
  const isQoder = provider.kind === 'qoder'
  const isWeb = isRouterWebProviderKind(provider.kind)
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [selector, setSelector] = useState('')
  const [configDir, setConfigDir] = useState('')
  return (
    <div className="rounded-lg border border-border-soft bg-surface-1 px-[13px] py-[11px]">
      <div className="flex min-w-0 items-center justify-between gap-4">
        <div className={rowStack}>
          <span className="flex items-center gap-2">
            <strong className={rowTitle}>{provider.name}</strong>
            <StatusChip neutral>{kindLabel(provider.kind)}</StatusChip>
            {isWeb ? <StatusChip neutral>Web lane</StatusChip> : null}
            {provider.hasSecret ? <StatusChip good>Key saved</StatusChip> : null}
          </span>
          <span className={rowPathText}>
            {isAgy
              ? 'agy CLI (signed-in accounts from the Antigravity app)'
              : isQoder
                ? 'qoder CLI (per-account profiles or personal access tokens)'
                : isWeb
                  ? 'Embedded browser · signed-in session'
                  : provider.baseUrl || '—'}
          </span>
          {provider.models.length > 0 ? <span className={rowDesc}>{provider.models.join(', ')}</span> : null}
          {test ? (
            <span className={rowDesc}>
              {test.ok
                ? `OK · ${test.latencyMs} ms · ${test.model}${test.preview ? ` · ${test.preview}` : ''}`
                : `Failed · ${test.statusCode} · ${test.error ?? 'unknown error'}`}
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

      {!isWeb && provider.accounts.length > 0 ? (
        <div className="mt-2 space-y-1 border-t border-border-soft pt-2">
          {provider.accounts.map((account) => (
            <div key={account.id} className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-[10px] font-semibold text-soft">{account.label}</span>
                <StatusChip neutral>{account.kind}</StatusChip>
                {account.selector ? <span className={rowPathText}>{account.selector}</span> : null}
                {account.envDir ? <span className={rowPathText}>{account.envDir}</span> : null}
                {account.lastStatus ? <span className={rowPathText}>{account.lastStatus}</span> : null}
              </span>
              <SettingsButton disabled={disabled} onClick={() => onRemoveAccount(account.id)}>Remove</SettingsButton>
            </div>
          ))}
        </div>
      ) : null}

      {!isWeb ? (
        <div className="mt-2 flex items-center gap-2 border-t border-border-soft pt-2">
          <Input aria-label={`${provider.name} account label`} placeholder="Account label" value={label} disabled={disabled} onChange={(event) => setLabel(event.target.value)} className="max-w-[180px]" />
          {isAgy ? (
            <Input aria-label={`${provider.name} agy account name`} placeholder="agy account name, e.g. account-2" value={selector} disabled={disabled} onChange={(event) => setSelector(event.target.value)} className="max-w-[220px] font-mono text-[11px]" />
          ) : (
            <Input aria-label={`${provider.name} account API key`} type="password" autoComplete="off" placeholder={isQoder ? 'Personal access token (optional)' : 'Account API key'} value={key} disabled={disabled} onChange={(event) => setKey(event.target.value)} className="max-w-[220px]" />
          )}
          {isQoder ? (
            <Input aria-label={`${provider.name} CLI config dir`} placeholder="CLI profile dir (QODER_CONFIG_DIR)" value={configDir} disabled={disabled} onChange={(event) => setConfigDir(event.target.value)} className="max-w-[240px] font-mono text-[11px]" />
          ) : null}
          <SettingsButton
            disabled={disabled || !label.trim() || (isAgy ? !selector.trim() : isQoder ? !key.trim() && !configDir.trim() : !key.trim())}
            onClick={() => {
              onAddAccount({ label: label.trim(), apiKey: key.trim(), selector: selector.trim(), configDir: configDir.trim() })
              setLabel('')
              setKey('')
              setSelector('')
              setConfigDir('')
            }}
          >
            Add account
          </SettingsButton>
        </div>
      ) : null}
    </div>
  )
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'chatgpt-web': return 'ChatGPT Web'
    case 'gemini-web': return 'Gemini Web'
    case 'openai-compatible': return 'OpenAI-compatible'
    case 'antigravity': return 'Antigravity'
    case 'qoder': return 'Qoder CLI'
    case 'gemini-cli': return 'Gemini CLI'
    default: return kind
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
