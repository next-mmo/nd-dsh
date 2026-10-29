import { useEffect, useRef, useState } from 'react'
import {
  ROUTER_WEB_LANE_MODELS,
  isRouterWebProviderKind,
  type RouterComboEntry,
  type RouterProviderView,
  type RouterState,
  type RouterTestResult,
  type RouterUsageSummary,
} from '../../../shared/router'
import { routerSubTabFromLocation, type RouterSubTab } from '../lib/settings-route'
import { cn } from '../lib/utils'
import { NineRouterSettings } from './NineRouterSettings'
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
  subTab?: RouterSubTab
  onSelectSubTab?: (subTab: RouterSubTab) => void
}

interface ComboDraftEntry {
  providerId: string
  model: string
}

type ProviderKindChoice = 'openai-compatible' | 'antigravity' | 'qoder' | 'chatgpt-web' | 'gemini-web'

const ROUTER_SUB_TABS: { id: RouterSubTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'providers', label: 'Providers' },
  { id: 'routes', label: 'Routes' },
  { id: 'playground', label: 'Playground' },
  { id: 'access', label: 'External API' },
  { id: 'nine-router', label: '9Router' },
  { id: 'usage', label: 'Usage' },
]

const NO_COUNTERS = { requests: 0, ok: 0, failed: 0, lastError: null as string | null }

export function RouterSettings({ onError, subTab: propSubTab, onSelectSubTab }: RouterSettingsProps) {
  const [state, setState] = useState<RouterState | null>(null)
  const [usage, setUsage] = useState<RouterUsageSummary | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, RouterTestResult>>({})
  const [internalSubTab, setInternalSubTab] = useState<RouterSubTab>(routerSubTabFromLocation)
  const [showProviderForm, setShowProviderForm] = useState(false)
  const [showRouteForm, setShowRouteForm] = useState(false)

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

  const activeSubTab = propSubTab ?? internalSubTab
  const tabListRef = useRef<HTMLElement | null>(null)

  const selectSubTab = (next: RouterSubTab): void => {
    if (onSelectSubTab) {
      onSelectSubTab(next)
    } else {
      setInternalSubTab(next)
    }
  }

  useEffect(() => {
    const active = tabListRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeSubTab])

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

  const refreshRouterState = (): void => {
    void window.ndDshRouter.state().then(setState).catch((cause) => onError(message(cause)))
    void window.ndDshRouter.usage().then(setUsage).catch((cause) => onError(message(cause)))
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
      setShowProviderForm(false)
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
      setShowProviderForm(false)
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
    setShowProviderForm(false)
  }

  const addCombo = (): void => {
    const models: RouterComboEntry[] = comboEntries
      .map((entry) => ({ providerId: entry.providerId, model: entry.model.trim() }))
      .filter((entry) => entry.providerId && entry.model)
    if (!comboName.trim() || models.length === 0) {
      onError('Give the route a name and at least one provider/model entry.')
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
    setShowRouteForm(false)
  }

  const disabled = !state?.endpoint || busy !== null
  const providers = state?.providers ?? []
  const combos = state?.combos ?? []
  const counters = state?.counters ?? NO_COUNTERS
  const activeProviders = providers.filter((provider) => provider.isActive).length
  const privateRoutes = combos.filter((combo) => combo.hiddenFromChat).length
  const webProviders = providers.filter((provider) => isRouterWebProviderKind(provider.kind)).length
  const nineRouterConnected = providers.some((provider) => provider.id === 'nine-router-external')
  const totalRequests = usage?.requests ?? counters.requests
  const averageLatency = usage?.avgLatencyMs ?? 0
  const requestsOk = usage?.ok ?? counters.ok
  const requestsFailed = usage?.failed ?? counters.failed
  const providerBreakdown = Object.entries(usage?.byProvider ?? {}).sort((left, right) => right[1] - left[1]).slice(0, 8)
  const providerFormOpen = showProviderForm || providers.length === 0
  const routeFormOpen = showRouteForm || combos.length === 0
  const draftHasWebLane = comboEntries.some((entry) => {
    const provider = providers.find((candidate) => candidate.id === entry.providerId)
    return provider ? isRouterWebProviderKind(provider.kind) : false
  })
  const comboVisibleInChat = comboVisibilityTouched ? comboShowInChat : !draftHasWebLane

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border-soft px-[26px] pb-2.5 pt-3">
        <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <nav
            ref={tabListRef}
            role="tablist"
            aria-label="ND Router sub-tabs"
            className="flex w-max shrink-0 gap-0.5 rounded-lg border border-border bg-secondary p-[3px]"
          >
            {ROUTER_SUB_TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={activeSubTab === id}
                className={cn(
                  'shrink-0 rounded-md px-3 py-1 text-[11px] font-semibold transition-colors',
                  activeSubTab === id ? 'bg-primary/10 text-primary' : 'text-faint hover:bg-accent hover:text-soft',
                )}
                onClick={() => selectSubTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusChip good={Boolean(state?.endpoint)} warn={Boolean(state) && !state?.endpoint}>
            {state?.endpoint ? 'Online' : state ? 'Unavailable' : 'Loading'}
          </StatusChip>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-[26px] pb-[42px] pt-1.5">
        {activeSubTab === 'overview' && (
          <>
            <SettingsSection title="Gateway" className="mt-3.5">
              <div className="space-y-1.5">
                <SettingsRow>
                  <div className={rowStack}>
                    <strong className={rowTitle}>Rust routing gateway</strong>
                    <span className={rowDesc}>
                      Ordered fallback across API, CLI, and web lanes. Visible routes become models in ND's picker; private
                      routes stay callable at the loopback endpoint and in the playground.
                    </span>
                    {state?.endpoint ? <span className={rowPathText}>{state.endpoint}</span> : null}
                    {state && !state.endpoint ? (
                      <span className={rowDesc}>The sidecar build does not expose ND Router yet. Rebuild the core runtime.</span>
                    ) : null}
                  </div>
                  <span className={rowValueText}>
                    {plural(providers.length, 'provider')} · {plural(combos.length, 'route')} · {plural(totalRequests, 'request')}
                  </span>
                </SettingsRow>
                <SettingsRow>
                  <div className={rowStack}>
                    <strong className={rowTitle}>Quick actions</strong>
                    <span className={rowDesc}>Test a route, add a lane, or hand the endpoint to a local app.</span>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1">
                    <SettingsButton onClick={() => selectSubTab('playground')}>Open playground</SettingsButton>
                    <SettingsButton onClick={() => { setShowProviderForm(true); selectSubTab('providers') }}>Add provider</SettingsButton>
                    <SettingsButton onClick={() => { setShowRouteForm(true); selectSubTab('routes') }}>New route</SettingsButton>
                    <SettingsButton onClick={() => selectSubTab('access')}>External API</SettingsButton>
                  </div>
                </SettingsRow>
              </div>
            </SettingsSection>

            <div className="mt-1.5 grid grid-cols-3 gap-1.5">
              <StatTile
                label="Providers"
                value={providers.length}
                detail={`${activeProviders} active`}
                onClick={() => selectSubTab('providers')}
              />
              <StatTile
                label="Routes"
                value={combos.length}
                detail={privateRoutes > 0 ? `${privateRoutes} private` : 'all in chat'}
                onClick={() => selectSubTab('routes')}
              />
              <StatTile
                label="Requests"
                value={totalRequests}
                detail={`${requestsOk} ok · ${requestsFailed} failed`}
                onClick={() => selectSubTab('usage')}
              />
            </div>

            <SettingsSection title="Integrations">
              <div className="space-y-1.5">
                <SettingsRow>
                  <div className={rowStack}>
                    <span className="flex items-center gap-2">
                      <strong className={rowTitle}>9Router</strong>
                      <StatusChip neutral>{nineRouterConnected ? 'Connected' : 'Not connected'}</StatusChip>
                    </span>
                    <span className={rowDesc}>Connect an existing local 9Router or install an ND-signed managed runtime.</span>
                  </div>
                  <SettingsButton onClick={() => selectSubTab('nine-router')}>Open</SettingsButton>
                </SettingsRow>
                <SettingsRow>
                  <div className={rowStack}>
                    <span className="flex items-center gap-2">
                      <strong className={rowTitle}>Web lanes</strong>
                      <StatusChip neutral>{webProviders > 0 ? `${webProviders} configured` : 'None'}</StatusChip>
                    </span>
                    <span className={rowDesc}>
                      ChatGPT Web and Gemini Web drive the embedded browser's signed-in session. Each request starts a fresh
                      conversation; routes stay private unless you opt them into personal chat.
                    </span>
                  </div>
                  <SettingsButton onClick={() => { if (webProviders === 0) setShowProviderForm(true); selectSubTab('providers') }}>
                    {webProviders > 0 ? 'Manage' : 'Add web lane'}
                  </SettingsButton>
                </SettingsRow>
              </div>
            </SettingsSection>

            <SettingsNote>
              Free lanes first: point an OpenAI-compatible provider at a local plugin gateway (for example dsh-our-free-model),
              or add Antigravity, Qoder CLI, ChatGPT Web, or Gemini Web. Prompt Shield still runs before anything leaves ND.
            </SettingsNote>
          </>
        )}

        {activeSubTab === 'providers' && (
          <>
            <SettingsSection title="Providers" className="mt-3.5">
              <div className="space-y-1.5">
                <SettingsRow>
                  <div className={rowStack}>
                    <strong className={rowTitle}>{providers.length} provider{providers.length === 1 ? '' : 's'}</strong>
                    <span className={rowDesc}>
                      {activeProviders} active · {webProviders} web lane{webProviders === 1 ? '' : 's'} · accounts and keys stay in
                      ND's secure stores
                    </span>
                  </div>
                  {providers.length > 0 && !showProviderForm ? (
                    <SettingsButton disabled={disabled} onClick={() => setShowProviderForm(true)}>
                      Add provider
                    </SettingsButton>
                  ) : null}
                </SettingsRow>

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

                {providers.length === 0 ? (
                  <SettingsNote>No providers yet. Add an OpenAI-compatible endpoint, Antigravity, Qoder CLI, ChatGPT Web, or Gemini Web below.</SettingsNote>
                ) : null}

                {providerFormOpen ? (
                  <SettingsRow className="items-start">
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <span className={rowTitle}>New provider</span>
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
                          Runs your installed agy CLI — it owns the Google sign-in, ND never sees tokens. Account entries below
                          carry the AGY_ACCOUNT name so per-account routing activates as soon as the CLI honors them.
                        </span>
                      ) : providerKind === 'qoder' ? (
                        <span className={rowDesc}>
                          Runs your installed qoder CLI — each account selects its own profile folder (QODER_CONFIG_DIR) and/or
                          a personal access token. ND never reads the CLI's stored tokens.
                        </span>
                      ) : isRouterWebProviderKind(providerKind) ? (
                        <span className={rowDesc}>
                          Drives the embedded browser's signed-in {providerKind === 'chatgpt-web' ? 'ChatGPT' : 'Gemini'} session.
                          Every router request starts a fresh conversation.
                        </span>
                      ) : null}
                      <div className="flex items-center gap-1">
                        <SettingsButton disabled={disabled} onClick={addProvider}>Add provider</SettingsButton>
                        {providers.length > 0 ? <SettingsButton disabled={disabled} onClick={() => setShowProviderForm(false)}>Cancel</SettingsButton> : null}
                      </div>
                    </div>
                  </SettingsRow>
                ) : null}
              </div>
            </SettingsSection>
            <SettingsNote>
              Providers keep their own credentials: API keys in the vault, CLI lanes on the installed CLI's sign-in, web lanes on
              the embedded browser session. Test a provider before adding it to a route.
            </SettingsNote>
          </>
        )}

        {activeSubTab === 'routes' && (
          <>
            <SettingsSection title="Routes" className="mt-3.5">
              <div className="space-y-1.5">
                <SettingsRow>
                  <div className={rowStack}>
                    <strong className={rowTitle}>{combos.length} route{combos.length === 1 ? '' : 's'}</strong>
                    <span className={rowDesc}>
                      {privateRoutes} private · {combos.length - privateRoutes} in personal chat · route names are public model ids
                    </span>
                  </div>
                  {combos.length > 0 && !showRouteForm ? (
                    <SettingsButton disabled={disabled} onClick={() => setShowRouteForm(true)}>
                      New route
                    </SettingsButton>
                  ) : null}
                </SettingsRow>

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

                {combos.length === 0 ? <SettingsNote>No routes yet. Create one below from any active provider and model.</SettingsNote> : null}

                {routeFormOpen ? (
                  <SettingsRow className="items-start">
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <span className={rowTitle}>New route</span>
                      <div className="flex items-center gap-2">
                        <Input aria-label="Route name" placeholder="Route name, e.g. free" value={comboName} disabled={disabled} onChange={(event) => setComboName(event.target.value)} className="max-w-[240px]" />
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
                          aria-label="Show new route in personal chat"
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
                            aria-label={`Route entry ${index + 1} provider`}
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
                            aria-label={`Route entry ${index + 1} model`}
                            placeholder="Model id, e.g. gpt-4.1"
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
                        <SettingsButton disabled={disabled} onClick={addCombo}>Save route</SettingsButton>
                        {combos.length > 0 ? <SettingsButton disabled={disabled} onClick={() => setShowRouteForm(false)}>Cancel</SettingsButton> : null}
                      </div>
                    </div>
                  </SettingsRow>
                ) : null}
              </div>
            </SettingsSection>
            <SettingsNote>
              Priority tries lanes top to bottom; round-robin rotates them. Private routes remain callable by name at /v1 but do
              not appear in personal chat.
            </SettingsNote>
          </>
        )}

        {activeSubTab === 'playground' && (
          <div className="mt-3.5">
            <RouterPlayground state={state} onError={onError} embedded />
          </div>
        )}

        {activeSubTab === 'access' && (
          <div className="mt-3.5">
            <RouterExternalApi state={state} onError={onError} embedded />
          </div>
        )}

        {activeSubTab === 'nine-router' && (
          <NineRouterSettings onError={onError} onConnected={refreshRouterState} />
        )}

        {activeSubTab === 'usage' && (
          <>
            <SettingsSection title="Usage" className="mt-3.5">
              <div className="space-y-1.5">
                <SettingsRow>
                  <div className={rowStack}>
                    <strong className={rowTitle}>Router activity</strong>
                    <span className={rowDesc}>Counts and latency stay on this machine. Prompt content is never recorded here.</span>
                    {counters.lastError ? <span className={rowPathText}>{counters.lastError}</span> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={rowValueText}>
                      {totalRequests} requests · {requestsOk} ok · {requestsFailed} failed · {averageLatency} ms avg
                    </span>
                    <SettingsButton
                      disabled={disabled || totalRequests === 0}
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

                {providerBreakdown.map(([provider, count]) => (
                  <SettingsRow key={provider}>
                    <div className={rowStack}>
                      <strong className={rowTitle}>{provider}</strong>
                      <span className={rowDesc}>requests routed to this provider</span>
                    </div>
                    <span className={rowValueText}>{count}</span>
                  </SettingsRow>
                ))}

                {totalRequests === 0 ? <SettingsNote>No requests yet. Send a prompt from the playground to populate latency and provider counts.</SettingsNote> : null}
              </div>
            </SettingsSection>
            <SettingsNote>Resetting clears this local usage journal; routes, keys, and accounts are untouched.</SettingsNote>
          </>
        )}
      </div>
    </div>
  )
}

function StatTile({ label, value, detail, onClick }: { label: string; value: number; detail: string; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-border-soft bg-surface-1 px-[13px] py-[11px] text-left transition-colors hover:border-(--border-focus)"
    >
      <span className="block text-[9px] font-bold uppercase tracking-[0.1em] text-muted-foreground">{label}</span>
      <span className="mt-1 flex items-baseline justify-between gap-2">
        <strong className="text-lg font-semibold leading-none text-strong">{value}</strong>
        <span className="truncate text-[10px] text-faint">{detail}</span>
      </span>
    </button>
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
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-border bg-secondary font-mono text-[8px] font-bold tracking-[0.06em] text-faint">
            {providerBadge(provider.kind)}
          </span>
          <div className={rowStack}>
            <span className="flex items-center gap-2">
              <strong className={rowTitle}>{provider.name}</strong>
              {kindLabel(provider.kind) !== provider.name ? <StatusChip neutral>{kindLabel(provider.kind)}</StatusChip> : null}
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

function providerBadge(kind: string): string {
  if (isRouterWebProviderKind(kind)) return 'WEB'
  if (kind === 'antigravity' || kind === 'qoder') return 'CLI'
  return 'API'
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
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