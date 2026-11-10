import { useEffect, useRef, useState } from 'react'
import {
  ROUTER_AI_STUDIO_BASE_URL,
  ROUTER_AI_STUDIO_MODELS,
  ROUTER_FREE_API_BASE_URLS,
  ROUTER_FREE_API_MODELS,
  ROUTER_TTS_LANE_MODELS,
  ROUTER_WEB_LANE_MODELS,
  isRouterCliProviderKind,
  isRouterFreeApiKind,
  isRouterTtsProviderKind,
  isRouterWebProviderKind,
  ROUTER_CLI_LANE_MODELS,
  type RouterCliProviderKind,
  type RouterTtsProviderKind,
  providerAuthMode,
  providerCategory,
  type RouterAgyApproval,
  type RouterAgyCategory,
  type RouterAgyState,
  type RouterAgyUsageSummary,
  type RouterComboEntry,
  type RouterProviderInput,
  type RouterProviderView,
  type RouterState,
  type RouterTestResult,
  type RouterUsageSummary,
} from '../../../shared/router'
import { routerSubTabFromLocation, type RouterSubTab, type SettingsTab } from '../lib/settings-route'
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Input } from './ui/input'
import { Switch } from './ui/switch'

interface RouterSettingsProps {
  onError(message: string): void
  subTab?: RouterSubTab
  onSelectSubTab?: (subTab: RouterSubTab) => void
  onSelectTab?: (tab: SettingsTab) => void
}

interface ComboDraftEntry {
  providerId: string
  model: string
}

type ProviderKindChoice =
  | 'openai-compatible'
  | 'ai-studio'
  | 'pollinations'
  | 'ovh-kepler'
  | 'free-ai'
  | 'kilo-gateway'
  | RouterTtsProviderKind
  | RouterCliProviderKind
  | 'chatgpt-web'
  | 'gemini-web'
  | 'aistudio-web'
  | 'deepseek-web'
  | 'grok-web'
  | 'qwen-web'
  | 'zai-web'
  | 'mistral-web'
  | 'perplexity-web'
  | 'poe-web'
  | 'arena-web'
  | 'meta-web'
  | 'duck-web'

const ROUTER_SUB_TABS: { id: RouterSubTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'providers', label: 'Providers' },
  { id: 'routes', label: 'Routes' },
  { id: 'playground', label: 'Playground' },
  { id: 'nine-router', label: '9Router' },
  { id: 'usage', label: 'Usage' },
]

const NO_COUNTERS = { requests: 0, ok: 0, failed: 0, lastError: null as string | null }

export function RouterSettings({ onError, subTab: propSubTab, onSelectSubTab, onSelectTab }: RouterSettingsProps) {
  const [state, setState] = useState<RouterState | null>(null)
  const [usage, setUsage] = useState<RouterUsageSummary | null>(null)
  const [agyState, setAgyState] = useState<RouterAgyState | null>(null)
  const [agyUsage, setAgyUsage] = useState<RouterAgyUsageSummary | null>(null)
  const [agyBusy, setAgyBusy] = useState(false)
  const [agyCategory, setAgyCategory] = useState<RouterAgyCategory>('coding')
  const [agyApproval, setAgyApproval] = useState<RouterAgyApproval | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, RouterTestResult>>({})
  const [internalSubTab, setInternalSubTab] = useState<RouterSubTab>(routerSubTabFromLocation)
  const [showProviderForm, setShowProviderForm] = useState(false)
  const [showRouteForm, setShowRouteForm] = useState(false)
  const [safeModeBusy, setSafeModeBusy] = useState(false)

  const [providerKind, setProviderKind] = useState<ProviderKindChoice>('openai-compatible')
  const [providerName, setProviderName] = useState('')
  const [providerBaseUrl, setProviderBaseUrl] = useState('')
  const [providerModels, setProviderModels] = useState('')
  const [providerKey, setProviderKey] = useState('')
  const [draftPing, setDraftPing] = useState<{
    testing: boolean
    result: RouterTestResult | null
    error: string | null
  }>({ testing: false, result: null, error: null })

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

  const openAddProviderDialog = (): void => {
    setDraftPing({ testing: false, result: null, error: null })
    setShowProviderForm(true)
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
        const agy = await window.ndDshRouter.agyPolicy()
        const agySummary = await window.ndDshRouter.agyUsage()
        if (!mounted) return
        setState(next)
        setUsage(summary)
        setAgyState(agy)
        setAgyUsage(agySummary)
      } catch (cause) {
        onError(message(cause))
      }
    })()
    return () => { mounted = false }
  }, [onError])

  const refreshAgy = (): void => {
    void window.ndDshRouter.agyPolicy().then(setAgyState).catch((cause) => onError(message(cause)))
    void window.ndDshRouter.agyUsage().then(setAgyUsage).catch((cause) => onError(message(cause)))
  }

  const updateAgy = (action: () => Promise<RouterAgyState>): void => {
    setAgyBusy(true)
    void action()
      .then(async (next) => {
        setAgyState(next)
        refreshAgy()
        setState(await window.ndDshRouter.state())
      })
      .catch((cause) => onError(message(cause)))
      .finally(() => setAgyBusy(false))
  }

  const approveAgy = (): void => {
    setAgyBusy(true)
    void window.ndDshRouter.createAgyApproval(agyCategory)
      .then((approval) => {
        setAgyApproval(approval)
        refreshAgy()
      })
      .catch((cause) => onError(message(cause)))
      .finally(() => setAgyBusy(false))
  }

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
    setDraftPing({ testing: false, result: null, error: null })
    setProviderKind(kind)
    if (kind === 'ai-studio') {
      setProviderName('Google AI Studio')
      setProviderBaseUrl(ROUTER_AI_STUDIO_BASE_URL)
      setProviderModels(ROUTER_AI_STUDIO_MODELS.join(', '))
    } else if (isRouterTtsProviderKind(kind)) {
      setProviderName(kindLabel(kind))
      setProviderBaseUrl('')
      setProviderModels((ROUTER_TTS_LANE_MODELS[kind] ?? []).join(', '))
    } else if (isRouterFreeApiKind(kind)) {
      setProviderName(kindLabel(kind))
      setProviderBaseUrl(ROUTER_FREE_API_BASE_URLS[kind] ?? '')
      setProviderModels(ROUTER_FREE_API_MODELS[kind]?.join(', ') ?? '')
    } else if (isRouterWebProviderKind(kind)) {
      setProviderName(kindLabel(kind))
      setProviderModels(ROUTER_WEB_LANE_MODELS[kind].join(', '))
    } else if (isRouterCliProviderKind(kind)) {
      setProviderName(kindLabel(kind))
      setProviderModels((ROUTER_CLI_LANE_MODELS[kind as RouterCliProviderKind] ?? []).join(', '))
    }
  }

  const buildCandidateInput = (): RouterProviderInput | null => {
    const models = providerModels.split(/[\n,]/).map((model) => model.trim()).filter(Boolean)
    if (providerKind === 'ai-studio') {
      const baseUrl = providerBaseUrl.trim() || ROUTER_AI_STUDIO_BASE_URL
      return {
        kind: 'ai-studio',
        name: providerName.trim() || 'Google AI Studio',
        baseUrl,
        models: models.length > 0 ? models : ROUTER_AI_STUDIO_MODELS,
        ...(providerKey.trim() ? { apiKey: providerKey.trim() } : {}),
      }
    }
    if (isRouterTtsProviderKind(providerKind)) {
      return {
        kind: providerKind,
        name: providerName.trim() || kindLabel(providerKind),
        ...(providerBaseUrl.trim() ? { baseUrl: providerBaseUrl.trim() } : {}),
        models: models.length > 0 ? models : (ROUTER_TTS_LANE_MODELS[providerKind] ?? []),
      }
    }
    if (isRouterFreeApiKind(providerKind)) {
      const baseUrl = providerBaseUrl.trim() || ROUTER_FREE_API_BASE_URLS[providerKind] || ''
      const freeModels = models.length > 0 ? models : (ROUTER_FREE_API_MODELS[providerKind] ?? [])
      return {
        kind: providerKind,
        name: providerName.trim() || kindLabel(providerKind),
        baseUrl,
        models: freeModels,
      }
    }
    if (isRouterWebProviderKind(providerKind)) {
      return {
        kind: providerKind,
        ...(providerName.trim() ? { name: providerName.trim() } : {}),
        models: models.length > 0 ? models : ROUTER_WEB_LANE_MODELS[providerKind],
      }
    }
    if (!providerName.trim()) {
      onError('Give the provider a name.')
      return null
    }
    if (isRouterCliProviderKind(providerKind)) {
      return {
        kind: providerKind,
        name: providerName.trim() || kindLabel(providerKind),
        models: models.length > 0 ? models : (ROUTER_CLI_LANE_MODELS[providerKind as RouterCliProviderKind] ?? ['default']),
      }
    }
    if (!providerBaseUrl.trim()) {
      onError('Give the provider a base URL.')
      return null
    }
    return {
      kind: 'openai-compatible',
      name: providerName.trim(),
      baseUrl: providerBaseUrl.trim(),
      models,
      ...(providerKey.trim() ? { apiKey: providerKey.trim() } : {}),
    }
  }

  const runDraftPing = async (candidateInput?: RouterProviderInput): Promise<RouterTestResult | null> => {
    const candidate = candidateInput ?? buildCandidateInput()
    if (!candidate) return null
    setDraftPing({ testing: true, result: null, error: null })
    try {
      const result = await window.ndDshRouter.testCandidate(candidate)
      if (result.ok) {
        setDraftPing({ testing: false, result, error: null })
      } else {
        const errorMsg = result.error ? `${result.error} (status: ${result.statusCode})` : `HTTP ${result.statusCode}`
        setDraftPing({ testing: false, result, error: errorMsg })
      }
      return result
    } catch (cause) {
      const err = message(cause)
      setDraftPing({ testing: false, result: null, error: err })
      return null
    }
  }

  const addProvider = async (): Promise<void> => {
    const candidate = buildCandidateInput()
    if (!candidate) return

    let testResult = draftPing.result
    if (!testResult || !testResult.ok) {
      testResult = await runDraftPing(candidate)
    }

    if (!testResult || !testResult.ok) {
      const errorMsg = testResult?.error || draftPing.error || 'Connection failed'
      onError(`Ping test failed: ${errorMsg}. Provider cannot be saved until ping test succeeds.`)
      return
    }

    apply('provider', () => window.ndDshRouter.saveProvider(candidate))
    setProviderName('')
    setProviderBaseUrl('')
    setProviderModels('')
    setProviderKey('')
    setDraftPing({ testing: false, result: null, error: null })
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
  const routeFormOpen = showRouteForm || combos.length === 0
  const draftHasWebLane = comboEntries.some((entry) => {
    const provider = providers.find((candidate) => candidate.id === entry.providerId)
    return provider ? isRouterWebProviderKind(provider.kind) : false
  })
  const comboVisibleInChat = comboVisibilityTouched ? comboShowInChat : !draftHasWebLane

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border-soft px-4 py-1.5">
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

      {activeSubTab === 'playground' ? (
        <div className="flex min-h-0 flex-1 flex-col p-2.5">
          <RouterPlayground state={state} onError={onError} embedded agyState={agyState} />
        </div>
      ) : (
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
                    <span className="flex items-center gap-2">
                      <strong className={rowTitle}>Safe Mode</strong>
                      <StatusChip warn={state?.safeMode === true} neutral>
                        {state?.safeMode ? 'On' : 'Off'}
                      </StatusChip>
                      <StatusChip neutral>Experimental</StatusChip>
                    </span>
                    <span className={rowDesc}>
                      Closes the external API credential, disables ChatGPT/Gemini/DeepSeek web lanes, and blocks unverified
                      9Router imports. ND's internal loopback routes and signed/API providers keep working. Off by default.
                    </span>
                  </div>
                  <Switch
                    aria-label="ND Router Safe Mode"
                    checked={state?.safeMode ?? false}
                    disabled={safeModeBusy}
                    onCheckedChange={(enabled) => {
                      setSafeModeBusy(true)
                      void window.ndDshRouter.setSafeMode(enabled)
                        .then(async (next) => {
                          setState(next)
                          setUsage(await window.ndDshRouter.usage())
                        })
                        .catch((cause) => onError(message(cause)))
                        .finally(() => setSafeModeBusy(false))
                    }}
                  />
                </SettingsRow>
                <SettingsRow>
                  <div className={rowStack}>
                    <strong className={rowTitle}>Quick actions</strong>
                    <span className={rowDesc}>Test a route, add a lane, or hand the endpoint to a local app.</span>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1">
                    <SettingsButton onClick={() => selectSubTab('playground')}>Open playground</SettingsButton>
                    <SettingsButton onClick={() => { openAddProviderDialog(); selectSubTab('providers') }}>Add provider</SettingsButton>
                    <SettingsButton onClick={() => { setShowRouteForm(true); selectSubTab('routes') }}>New route</SettingsButton>
                    <SettingsButton onClick={() => selectSubTab('access')}>External API</SettingsButton>
                  </div>
                </SettingsRow>
              </div>
            </SettingsSection>

            <SettingsSection title="Antigravity safety">
              <div className="space-y-1.5">
                <SettingsRow>
                  <div className={rowStack}>
                    <span className="flex items-center gap-2">
                      <strong className={rowTitle}>Consumer CLI lane</strong>
                      <StatusChip warn={agyState?.locked === true} neutral>
                        {agyState?.locked ? 'Locked' : agyState?.policy.enabled ? 'Enabled' : 'Off'}
                      </StatusChip>
                      <StatusChip neutral>Manual only</StatusChip>
                    </span>
                    <span className={rowDesc}>
                      Runs your installed agy CLI with CLI-owned credentials. Off by default; every routed job needs a
                      one-shot approval and hard hourly/daily/token budgets apply. Local access and low volume do not
                      guarantee Google account safety.
                    </span>
                    {agyState?.lockReason ? <span className={rowPathText}>{agyState.lockReason}</span> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {agyState?.locked ? (
                      <SettingsButton disabled={agyBusy} onClick={() => updateAgy(() => window.ndDshRouter.setAgyEnabled(true))}>
                        Re-arm lane
                      </SettingsButton>
                    ) : agyState?.policy.enabled ? (
                      <SettingsButton disabled={agyBusy} onClick={() => updateAgy(() => window.ndDshRouter.setAgyEnabled(false))}>
                        Lock now
                      </SettingsButton>
                    ) : null}
                    <Switch
                      aria-label="Antigravity lane enabled"
                      checked={agyState?.policy.enabled ?? false}
                      disabled={agyBusy || !agyState}
                      onCheckedChange={(enabled) => updateAgy(() => window.ndDshRouter.setAgyPolicy({ enabled }))}
                    />
                  </div>
                </SettingsRow>
                <SettingsRow>
                  <div className={rowStack}>
                    <strong className={rowTitle}>Approve the next AGY request</strong>
                    <span className={rowDesc}>
                      Creates a single-use token for one request. The playground attaches it automatically; other local
                      callers send the x-nd-agy-approval header. Expires after {agyState?.policy.approvalTtlSecs ?? 600}
                      {' '}seconds.
                    </span>
                    {agyApproval ? (
                      <span className={rowPathText}>
                        {agyApproval.category} · {agyApproval.token} · expires{' '}
                        {new Date(agyApproval.expiresAtMs).toLocaleTimeString()}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <select
                      className="h-7 rounded-md border border-border bg-background px-2 text-[11px]"
                      value={agyCategory}
                      disabled={agyBusy}
                      onChange={(event) => setAgyCategory(event.target.value as RouterAgyCategory)}
                    >
                      <option value="coding">Coding</option>
                      <option value="review">Review</option>
                      <option value="translation">Translation</option>
                    </select>
                    <SettingsButton
                      disabled={agyBusy || !agyState?.policy.enabled || agyState?.locked === true}
                      onClick={approveAgy}
                    >
                      Approve one job
                    </SettingsButton>
                  </div>
                </SettingsRow>
                <SettingsRow>
                  <div className={rowStack}>
                    <strong className={rowTitle}>Budgets</strong>
                    <span className={rowDesc}>
                      {agyState
                        ? `${agyState.window.jobs}/${agyState.window.limit} this hour · ${agyState.day.jobs}/${agyState.day.jobsLimit} today · ${agyState.day.tokens.toLocaleString()}${agyState.day.tokensLimit > 0 ? `/${agyState.day.tokensLimit.toLocaleString()}` : ''} tokens`
                        : 'Loading…'}
                      {agyState && agyState.pendingApprovals > 0 ? ` · ${plural(agyState.pendingApprovals, 'pending approval')}` : ''}
                    </span>
                  </div>
                  <span className={rowValueText}>1 concurrent max</span>
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
                    <span className={rowDesc}>Connect an existing local 9Router or run an ND-managed 9Router build (signed or explicitly unverified).</span>
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
                      ChatGPT Web, Gemini Web, and DeepSeek Web drive the embedded browser's signed-in session. Each request
                      starts a fresh conversation; routes stay private unless you opt them into personal chat.
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
              or add Antigravity, Qoder CLI, ChatGPT Web, Gemini Web, or DeepSeek Web. Prompt Shield still runs before anything leaves ND.
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
                  <SettingsButton disabled={disabled} onClick={openAddProviderDialog}>
                    Add provider
                  </SettingsButton>
                </SettingsRow>

                {providers.map((provider) => (
                  <ProviderRow
                    key={provider.id}
                    provider={provider}
                    disabled={disabled}
                    busy={busy}
                    test={tests[provider.id]}
                    onToggle={(enabled) => apply(`toggle:${provider.id}`, async () => {
                      const next = await window.ndDshRouter.saveProvider({ id: provider.id, isActive: enabled })
                      if (provider.kind === 'antigravity') {
                        await window.ndDshRouter.setAgyPolicy({ enabled })
                        refreshAgy()
                      }
                      return next
                    })}
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
                    onGoogleConnect={(mode) => new Promise<string>((resolve, reject) => {
                      setBusy(`google:${provider.id}`)
                      void window.ndDshRouter.googleConnect(provider.id, mode)
                        .then(async (result) => {
                          setState(result.state)
                          setUsage(await window.ndDshRouter.usage())
                          resolve(result.email)
                        })
                        .catch((cause) => {
                          onError(message(cause))
                          reject(cause)
                        })
                        .finally(() => setBusy(null))
                    })}
                  />
                ))}

                {providers.length === 0 ? (
                  <SettingsNote>No providers yet. Click &ldquo;Add provider&rdquo; to connect an OpenAI-compatible endpoint, CLI lane (Trae, Claude Code, Antigravity, Qoder), or web chat lane.</SettingsNote>
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


        {activeSubTab === 'access' && (
          <div className="mt-3.5">
            <RouterExternalApi state={state} onError={onError} embedded />
          </div>
        )}

        {activeSubTab === 'nine-router' && (
          <NineRouterSettings
            onError={onError}
            onConnected={refreshRouterState}
            onNavigateToExtensions={() => {
              if (onSelectTab) onSelectTab('extensions')
              else window.location.hash = '#/settings?tab=extensions'
            }}
          />
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
            <SettingsSection title="Antigravity CLI activity">
              <div className="space-y-1.5">
                <SettingsRow>
                  <div className={rowStack}>
                    <strong className={rowTitle}>Jobs, blocks and spend</strong>
                    <span className={rowDesc}>
                      {agyUsage
                        ? `${agyUsage.summary.total} events · ${agyUsage.summary.ok} ran · ${agyUsage.summary.failed} failed or blocked${
                            Object.keys(agyUsage.summary.byCategory).length
                              ? ` · ${Object.entries(agyUsage.summary.byCategory).map(([category, count]) => `${category} ${count}`).join(' · ')}`
                              : ''
                          }`
                        : 'Loading…'}
                    </span>
                  </div>
                  <SettingsButton onClick={refreshAgy}>Refresh</SettingsButton>
                </SettingsRow>
                {agyUsage?.recent.length
                  ? agyUsage.recent.slice().reverse().map((entry) => (
                      <SettingsRow key={`${entry.tsMs}-${entry.status}-${entry.provider}`}>
                        <div className={rowStack}>
                          <strong className={rowTitle}>{entry.category ?? entry.blockCode ?? 'blocked'}</strong>
                          <span className={rowDesc}>
                            {new Date(entry.tsMs).toLocaleTimeString()} · {entry.ok ? 'ok' : entry.error ?? 'failed'}
                            {entry.class && entry.class !== 'blocked' ? ` · ${entry.class}` : ''}
                          </span>
                        </div>
                        <span className={rowValueText}>
                          {(entry.promptTokens + entry.completionTokens).toLocaleString()} tok
                        </span>
                      </SettingsRow>
                    ))
                  : null}
                {agyUsage && agyUsage.recent.length === 0 ? (
                  <SettingsNote>No Antigravity activity yet. Blocked and failed requests appear here without prompt content.</SettingsNote>
                ) : null}
              </div>
            </SettingsSection>
            <SettingsNote>Resetting clears this local usage journal; routes, keys, and accounts are untouched.</SettingsNote>
          </>
        )}
      </div>
      )}

      <Dialog
        open={showProviderForm}
        onOpenChange={(open) => {
          setShowProviderForm(open)
          if (!open) {
            setDraftPing({ testing: false, result: null, error: null })
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[540px]">
          <DialogHeader>
            <DialogTitle>Add provider</DialogTitle>
            <DialogDescription>
              Connect an OpenAI-compatible endpoint, CLI lane, or browser web lane to ND Router.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 py-1">
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-semibold text-foreground">Provider type</label>
              <select
                aria-label="Provider kind"
                className="h-8.5 w-full rounded-md border border-border bg-surface-1 px-2.5 text-xs text-foreground outline-none transition-colors focus:border-primary"
                value={providerKind}
                disabled={disabled || draftPing.testing}
                onChange={(event) => changeProviderKind(event.target.value as ProviderKindChoice)}
              >
                <optgroup label="Text-to-Speech (TTS — Free Default)">
                  <option value="edge-tts">Edge TTS (Microsoft Edge Read Aloud · Free · No Key)</option>
                </optgroup>
                <optgroup label="Free API (Zero Auth Required)">
                  <option value="pollinations">Pollinations AI (Fast · No Key)</option>
                  <option value="ovh-kepler">OVH Kepler Cloud (120B / Qwen 3.6 · No Key)</option>
                  <option value="free-ai">Free.ai (Coding & Vision · No Key)</option>
                  <option value="kilo-gateway">Kilo Gateway (Aggregator · No Key)</option>
                </optgroup>
                <optgroup label="Custom API (API Key Required)">
                  <option value="ai-studio">Google AI Studio (Gemini 3.8 Live / 2.5 / 2.0)</option>
                  <option value="openai-compatible">OpenAI-compatible</option>
                </optgroup>
                <optgroup label="CLI (Command Line Tools)">
                  <option value="antigravity">Antigravity (agy CLI)</option>
                  <option value="qoder">Qoder CLI</option>
                  <option value="claude-code-cli">Claude Code CLI</option>
                  <option value="codex-cli">Codex CLI</option>
                  <option value="cursor-cli">Cursor CLI</option>
                  <option value="opencode-cli">OpenCode CLI</option>
                  <option value="goose-cli">Goose CLI</option>
                  <option value="hermes-cli">Hermes CLI</option>
                  <option value="pi-coding">Pi CLI</option>
                  <option value="zcode-cli">ZCode CLI</option>
                  <option value="jcode-cli">JCode CLI</option>
                  <option value="minimax-cli">MiniMax CLI</option>
                  <option value="trae-cli">Trae CLI</option>
                  <option value="gemini-cli">Gemini CLI</option>
                </optgroup>
                <optgroup label="Web Chat (Browser Session)">
                  <option value="chatgpt-web">ChatGPT Web</option>
                  <option value="gemini-web">Gemini Web</option>
                  <option value="aistudio-web">Google AI Studio Web (Apps Builder)</option>
                  <option value="deepseek-web">DeepSeek Web</option>
                  <option value="grok-web">Grok Web</option>
                  <option value="qwen-web">Qwen Web</option>
                  <option value="zai-web">Z.ai Web</option>
                  <option value="mistral-web">Mistral Web</option>
                  <option value="perplexity-web">Perplexity Web</option>
                  <option value="poe-web">Poe Web</option>
                  <option value="arena-web">Arena AI Web</option>
                  <option value="meta-web">Meta AI Web</option>
                  <option value="duck-web">Duck.ai Web</option>
                </optgroup>
              </select>
              <span className="text-[11px] leading-relaxed text-muted-foreground">
                {isRouterTtsProviderKind(providerKind)
                  ? 'Free neural Text-to-Speech via Microsoft Edge Read Aloud: zero authentication required (/v1/audio/speech).'
                  : isRouterFreeApiKind(providerKind)
                    ? 'Free public API: zero authentication required.'
                    : isRouterWebProviderKind(providerKind)
                    ? 'Web chat lane: uses the embedded browser session; no key is stored.'
                    : providerKind === 'ai-studio'
                      ? 'API & Live lane: Google AI Studio Gemini models including realtime Live voice (gemini-3.8-live).'
                      : providerKind === 'antigravity' || providerKind === 'qoder'
                        ? 'CLI lane: uses local command-line tools and OS credentials.'
                        : 'API lane: OpenAI-compatible endpoint with optional API key.'}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold text-foreground">Name</label>
                <Input
                  aria-label="Provider name"
                  placeholder={isRouterWebProviderKind(providerKind) ? 'Name (optional)' : 'Name, e.g. Free plugin'}
                  value={providerName}
                  disabled={disabled || draftPing.testing}
                  onChange={(event) => {
                    setDraftPing({ testing: false, result: null, error: null })
                    setProviderName(event.target.value)
                  }}
                />
              </div>

              {(providerKind === 'openai-compatible' || providerKind === 'ai-studio' || isRouterFreeApiKind(providerKind)) ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-semibold text-foreground">Base URL</label>
                  <Input
                    aria-label="Provider base URL"
                    placeholder={providerKind === 'ai-studio' ? ROUTER_AI_STUDIO_BASE_URL : isRouterFreeApiKind(providerKind) ? (ROUTER_FREE_API_BASE_URLS[providerKind] || 'https://...') : 'http://127.0.0.1:8326'}
                    value={providerBaseUrl}
                    disabled={disabled || draftPing.testing}
                    onChange={(event) => {
                      setDraftPing({ testing: false, result: null, error: null })
                      setProviderBaseUrl(event.target.value)
                    }}
                    className="font-mono text-[11px]"
                  />
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-semibold text-foreground">Models</label>
              <Input
                aria-label="Provider models"
                placeholder={providerKind === 'ai-studio' ? 'Models, e.g. gemini-2.5-flash, gemini-3.8-live, gemini-2.5-pro' : providerKind === 'antigravity' ? 'Models, e.g. gemini-3.8-flash-medium, claude-sonnet-5-5-medium (from `agy models`)' : providerKind === 'qoder' ? 'Models, e.g. auto, lite, performance (from `qoder --list-models`)' : isRouterWebProviderKind(providerKind) ? `Modes, e.g. ${ROUTER_WEB_LANE_MODELS[providerKind].join(', ')}` : 'Models (comma separated, optional)'}
                value={providerModels}
                disabled={disabled || draftPing.testing}
                onChange={(event) => {
                  setDraftPing({ testing: false, result: null, error: null })
                  setProviderModels(event.target.value)
                }}
                className="font-mono text-[11px]"
              />
            </div>

            {(providerKind === 'openai-compatible' || providerKind === 'ai-studio') ? (
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold text-foreground">API key</label>
                <Input
                  aria-label="Provider API key"
                  type="password"
                  autoComplete="off"
                  placeholder={providerKind === 'ai-studio' ? 'AI Studio API key (aistudio.google.com)' : 'API key (optional)'}
                  value={providerKey}
                  disabled={disabled || draftPing.testing}
                  onChange={(event) => {
                    setDraftPing({ testing: false, result: null, error: null })
                    setProviderKey(event.target.value)
                  }}
                />
              </div>
            ) : null}

            {providerKind === 'ai-studio' ? (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span>Get your Gemini API key from</span>
                <button
                  type="button"
                  className="text-primary underline hover:text-primary/80"
                  onClick={() => void window.ndDsh.browser.navigate('https://aistudio.google.com/app/apikey')}
                >
                  Google AI Studio (aistudio.google.com/app/apikey)
                </button>
                <span>· Supports Gemini 3.8 Live (voice) + OpenAI-compatible chat</span>
              </div>
            ) : null}

            {providerKind === 'antigravity' ? (
              <span className="text-[11px] leading-relaxed text-muted-foreground">
                Runs your installed agy CLI — it owns the Google sign-in, ND never sees tokens. Account entries below
                carry the AGY_ACCOUNT name so per-account routing activates as soon as the CLI honors them.
              </span>
            ) : providerKind === 'qoder' ? (
              <span className="text-[11px] leading-relaxed text-muted-foreground">
                Runs your installed qoder CLI — each account selects its own profile folder (QODER_CONFIG_DIR) and/or
                a personal access token. ND never reads the CLI's stored tokens.
              </span>
            ) : isRouterWebProviderKind(providerKind) ? (
              <span className="text-[11px] leading-relaxed text-muted-foreground">
                Drives the embedded browser's signed-in {kindLabel(providerKind)} session.
                Every router request starts a fresh conversation.
              </span>
            ) : null}

            {draftPing.testing ? (
              <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-[11px] text-soft">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border border-soft border-t-transparent" />
                <span>Pinging endpoint with test probe...</span>
              </div>
            ) : null}
            {draftPing.result?.ok ? (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-400">
                <span className="font-medium">✓ Ping OK ({draftPing.result.latencyMs}ms)</span>
                <span className="text-soft">· Model: {draftPing.result.model}</span>
                {draftPing.result.preview ? (
                  <span className="truncate max-w-[280px] text-soft/80" title={draftPing.result.preview}>
                    ({draftPing.result.preview})
                  </span>
                ) : null}
              </div>
            ) : null}
            {draftPing.error ? (
              <div className="flex items-center gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[11px] text-rose-400">
                <span className="font-medium">✕ Ping Failed:</span>
                <span className="truncate max-w-[360px]" title={draftPing.error}>{draftPing.error}</span>
              </div>
            ) : null}
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <DialogClose asChild>
              <button
                type="button"
                disabled={disabled || draftPing.testing}
                className="shrink-0 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-[10px] text-soft transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                Cancel
              </button>
            </DialogClose>
            <SettingsButton
              disabled={disabled || draftPing.testing}
              onClick={() => void runDraftPing()}
            >
              {draftPing.testing ? 'Pinging...' : 'Test connection'}
            </SettingsButton>
            <SettingsButton
              active
              disabled={disabled || draftPing.testing}
              onClick={() => void addProvider()}
            >
              {draftPing.testing ? 'Testing...' : 'Add provider'}
            </SettingsButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  onGoogleConnect,
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
  onGoogleConnect(mode: 'browser' | 'existing'): Promise<string>
}) {
  const isAgy = provider.kind === 'antigravity'
  const isQoder = provider.kind === 'qoder'
  const isWeb = isRouterWebProviderKind(provider.kind)
  const isTts = isRouterTtsProviderKind(provider.kind)
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [selector, setSelector] = useState('')
  const [configDir, setConfigDir] = useState('')
  const [googleNotice, setGoogleNotice] = useState('')
  const [existingGoogle, setExistingGoogle] = useState('')

  useEffect(() => {
    if (!isAgy) return
    let alive = true
    void window.ndDshRouter.googleExistingAccount()
      .then((value) => { if (alive) setExistingGoogle(value.email ?? '') })
      .catch(() => undefined)
    return () => { alive = false }
  }, [isAgy, busy])

  const connectGoogle = (mode: 'browser' | 'existing'): void => {
    setGoogleNotice('')
    void onGoogleConnect(mode)
      .then((email) => setGoogleNotice(`Connected ${email}`))
      .catch(() => undefined)
  }
  return (
    <div className="rounded-lg border border-border-soft bg-surface-1 px-[13px] py-[11px]">
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-border bg-secondary font-mono text-[8px] font-bold tracking-[0.06em] text-faint">
            {providerBadge(provider.kind)}
          </span>
          <div className={rowStack}>
            <span className="flex flex-wrap items-center gap-1.5">
              <strong className={rowTitle}>{provider.name}</strong>
              {kindLabel(provider.kind) !== provider.name ? <StatusChip neutral>{kindLabel(provider.kind)}</StatusChip> : null}
              <StatusChip neutral>{categoryBadge(provider.kind).category}</StatusChip>
              <StatusChip good={categoryBadge(provider.kind).auth === 'none'}>{categoryBadge(provider.kind).authLabel}</StatusChip>
              {(provider.liveCapable || provider.kind === 'ai-studio') ? <StatusChip good>Live</StatusChip> : null}
              {provider.hasSecret ? <StatusChip good>Key saved</StatusChip> : null}
            </span>
            <span className={rowPathText}>
              {isAgy
                ? 'agy CLI · Google OAuth accounts or Antigravity app sign-in'
                : isQoder
                  ? 'qoder CLI (per-account profiles or personal access tokens)'
                  : isTts
                    ? provider.baseUrl || 'Edge Read Aloud WebSocket · /v1/audio/speech'
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

      {!isWeb && !isTts && provider.accounts.length > 0 ? (
        <div className="mt-2 space-y-1 border-t border-border-soft pt-2">
          {provider.accounts.map((account) => (
            <div key={account.id} className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-[10px] font-semibold text-soft">{account.label}</span>
                <StatusChip neutral>{account.kind}</StatusChip>
                {account.envDir?.includes('google-oauth') ? <StatusChip neutral>Google OAuth</StatusChip> : null}
                {account.selector ? <span className={rowPathText}>{account.selector}</span> : null}
                {account.envDir ? <span className={rowPathText}>{account.envDir}</span> : null}
                {account.lastStatus ? <span className={rowPathText}>{account.lastStatus}</span> : null}
              </span>
              <SettingsButton disabled={disabled} onClick={() => onRemoveAccount(account.id)}>Remove</SettingsButton>
            </div>
          ))}
        </div>
      ) : null}

      {isAgy ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border-soft pt-2">
          <SettingsButton
            disabled={disabled || busy === `google:${provider.id}`}
            onClick={() => connectGoogle('browser')}
          >
            {busy === `google:${provider.id}` ? 'Waiting for Google…' : 'Connect Google account'}
          </SettingsButton>
          {existingGoogle ? (
            <SettingsButton
              disabled={disabled || busy === `google:${provider.id}`}
              onClick={() => connectGoogle('existing')}
            >
              Use signed-in Google account ({existingGoogle})
            </SettingsButton>
          ) : null}
          <span className={rowDesc}>
            Browser sign-in. Repeat to add another Google account; ND writes the credentials file the agy CLI uses.
          </span>
          {googleNotice ? <span className={rowDesc}>{googleNotice}</span> : null}
        </div>
      ) : null}

      {!isWeb && !isTts ? (
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
  if (isRouterTtsProviderKind(kind)) return 'TTS'
  if (isRouterWebProviderKind(kind)) return 'WEB'
  if (kind === 'antigravity' || kind === 'qoder') return 'CLI'
  return 'API'
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

function categoryBadge(kind: string): { category: string; auth: string; authLabel: string } {
  const cat = providerCategory(kind)
  const auth = providerAuthMode(kind)
  const category = cat === 'tts' ? 'TTS' : cat === 'cli' ? 'CLI' : cat === 'web' ? 'Web Chat' : 'API'
  const authLabel = auth === 'none' ? 'No Auth (Free)' : auth === 'browser' ? 'Browser Session' : auth === 'cli' ? 'CLI / OS Sign-in' : 'API Key'
  return { category, auth, authLabel }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'edge-tts': return 'Edge TTS (Free)'
    case 'ai-studio': return 'Google AI Studio'
    case 'aistudio-web': return 'Google AI Studio Web'
    case 'pollinations': return 'Pollinations AI (Free)'
    case 'ovh-kepler': return 'OVH Kepler Cloud (Free)'
    case 'free-ai': return 'Free.ai (Free)'
    case 'kilo-gateway': return 'Kilo Gateway (Free)'
    case 'chatgpt-web': return 'ChatGPT Web'
    case 'gemini-web': return 'Gemini Web'
    case 'deepseek-web': return 'DeepSeek Web'
    case 'grok-web': return 'Grok Web'
    case 'qwen-web': return 'Qwen Web'
    case 'zai-web': return 'Z.ai Web'
    case 'mistral-web': return 'Mistral Web'
    case 'perplexity-web': return 'Perplexity Web'
    case 'poe-web': return 'Poe Web'
    case 'arena-web': return 'Arena AI Web'
    case 'meta-web': return 'Meta AI Web'
    case 'duck-web': return 'Duck.ai Web'
    case 'openai-compatible': return 'OpenAI-compatible'
    case 'antigravity': return 'Antigravity (agy CLI)'
    case 'qoder': return 'Qoder CLI'
    case 'claude-code-cli': return 'Claude Code CLI'
    case 'codex-cli': return 'Codex CLI'
    case 'cursor-cli': return 'Cursor CLI'
    case 'opencode-cli': return 'OpenCode CLI'
    case 'goose-cli': return 'Goose CLI'
    case 'hermes-cli': return 'Hermes CLI'
    case 'pi-coding': return 'Pi CLI'
    case 'zcode-cli': return 'ZCode CLI'
    case 'jcode-cli': return 'JCode CLI'
    case 'minimax-cli': return 'MiniMax CLI'
    case 'trae-cli': return 'Trae CLI'
    case 'gemini-cli': return 'Gemini CLI'
    default: return kind
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}