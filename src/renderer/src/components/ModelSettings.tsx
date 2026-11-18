import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type { ModelProvider, ProviderModel, ProviderPingResult } from '../../../shared/contracts'
import { parseModelTokenLimit } from '../../../shared/provider-models'
import { BoxIcon, CheckIcon, EyeIcon, EyeOffIcon, PencilIcon, PlugIcon, PlusIcon, RotateIcon, TrashIcon } from './Icons'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Switch } from './ui/switch'
import { cn } from '../lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'

const SHOW_ONLY_ENABLED_STORAGE_KEY = 'nd-dsh.models.show-only-enabled'

interface ModelSettingsProps {
  onError(message: string): void
}

const API_FORMATS = [
  'Provider native / catalog default',
  'Chat completions (/chat/completions)',
  'Responses (/responses)',
  'Anthropic Messages (/v1/messages)',
  'OpenAI compatible (/v1/chat/completions)',
]

const miniIconButton = cn(
  'grid size-[26px] shrink-0 place-items-center rounded-[5px] text-(--models-faint) transition-colors',
  'hover:bg-(--models-field) hover:text-(--models-text) [&_svg]:size-3.5',
)

const pillBadge = (enabled: boolean | undefined): string =>
  cn(
    'rounded-full border px-[9px] py-[3px] text-[11px] font-semibold',
    enabled
      ? 'border-[rgba(34,197,94,0.35)] bg-(--models-green-soft) text-(--models-green)'
      : 'border-(--models-border-2) bg-(--models-field) text-(--models-faint)',
  )

const scopeButton = cn(
  'rounded-md border border-(--models-border-2) bg-(--models-field) px-2.5 py-1 text-[11px] text-(--models-muted) transition-colors',
  'hover:text-(--models-text) disabled:pointer-events-none disabled:opacity-45',
)

const PING_RESULT_COLORS: Record<ProviderPingResult['state'], string> = {
  ok: 'text-green-400',
  auth: 'text-amber-500',
  unreachable: 'text-red-400',
}

interface ModelSettingsDraft {
  sourceId: string
  id: string
  context: string
  maxOutputTokens: string
  inputTypes?: ProviderModel['inputTypes']
}

export function ModelSettings({ onError }: ModelSettingsProps) {
  const [showOnlyEnabled, setShowOnlyEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SHOW_ONLY_ENABLED_STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [savingCredential, setSavingCredential] = useState(false)
  const [renamingProvider, setRenamingProvider] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [modelSettingsDraft, setModelSettingsDraft] = useState<ModelSettingsDraft | null>(null)
  const [editingContextModelId, setEditingContextModelId] = useState<string | null>(null)
  const [contextDraft, setContextDraft] = useState('')
  const [testing, setTesting] = useState(false)
  const [pingResult, setPingResult] = useState<ProviderPingResult | null>(null)
  const [testingCompletion, setTestingCompletion] = useState(false)
  const [completionResult, setCompletionResult] = useState<ProviderPingResult | null>(null)
  // Per-model ping state: modelId → 'testing' | ProviderPingResult
  const [modelPings, setModelPings] = useState<Record<string, 'testing' | ProviderPingResult>>({})
  const [newHeaderKey, setNewHeaderKey] = useState('')
  const [newHeaderValue, setNewHeaderValue] = useState('')
  const [saveStatus, setSaveStatus] = useState<string | null>(null)

  const toggleShowOnlyEnabled = (checked: boolean): void => {
    setShowOnlyEnabled(checked)
    try {
      localStorage.setItem(SHOW_ONLY_ENABLED_STORAGE_KEY, String(checked))
    } catch {
      // Ignore storage errors
    }
  }

  // Clear per-model pings when the selected provider changes.
  useEffect(() => {
    setModelPings({})
    setCompletionResult(null)
  }, [selectedId])

  useEffect(() => {
    let mounted = true
    const load = (): void => {
      void window.ndDsh.providers
        .list()
        .then((loaded) => {
          if (!mounted) return
          setProviders(loaded)
          setSelectedId((current) => {
            const list = showOnlyEnabled ? loaded.filter((provider) => provider.enabled) : loaded
            return list.some((provider) => provider.id === current) ? current : (list[0]?.id ?? '')
          })
        })
        .catch((cause) => onError(errorMessage(cause)))
    }
    load()
    const unsubscribe = window.ndDsh.providers.onChanged(() => {
      if (mounted) load()
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [onError, showOnlyEnabled])

  useEffect(() => {
    setApiKeyDraft('')
    setShowApiKey(false)
    setPingResult(null)
    setNewHeaderKey('')
    setNewHeaderValue('')
  }, [selectedId])

  const visibleProviders = useMemo(
    () => (showOnlyEnabled ? providers.filter((provider) => provider.enabled) : providers),
    [showOnlyEnabled, providers],
  )

  const selected = visibleProviders.find((provider) => provider.id === selectedId) ?? visibleProviders[0] ?? null

  useEffect(() => {
    if (visibleProviders.length > 0 && !visibleProviders.some((provider) => provider.id === selectedId)) {
      setSelectedId(visibleProviders[0]?.id ?? '')
    }
  }, [visibleProviders, selectedId])

  const commit = (next: ModelProvider[]): void => {
    const safe = next.map((provider) => ({ ...provider, apiKey: '' }))
    setProviders(safe)
    void window.ndDsh.providers
      .save(safe)
      .then((saved) => {
        setProviders(saved)
        setSaveStatus('Saved')
        setTimeout(() => setSaveStatus(null), 2000)
      })
      .catch((cause) => onError(errorMessage(cause)))
  }

  const updateSelected = (patch: Partial<ModelProvider>): void => {
    // Editing anything a probe depends on voids a previous pass, so a stale
    // green result can never unlock enabling against a changed config.
    if ('baseUrl' in patch || 'apiFormat' in patch || 'headers' in patch || 'models' in patch) {
      setPingResult(null)
      setCompletionResult(null)
    }
    commit(providers.map((provider) => (provider.id === selectedId ? { ...provider, ...patch, apiKey: '' } : provider)))
  }

  const renameProvider = (): void => {
    const name = nameDraft.trim()
    if (name) updateSelected({ name })
    setRenamingProvider(false)
  }

  const removeProvider = (id: string): void => {
    const next = providers.filter((provider) => provider.id !== id)
    if (selectedId === id) {
      const nextVisible = showOnlyEnabled ? next.filter((provider) => provider.enabled) : next
      setSelectedId(nextVisible[0]?.id ?? '')
    }
    commit(next)
  }

  const addProvider = (): void => {
    if (showOnlyEnabled) {
      toggleShowOnlyEnabled(false)
    }
    const provider: ModelProvider = {
      id: `custom-${crypto.randomUUID().slice(0, 8)}`,
      name: 'Custom provider',
      enabled: false,
      baseUrl: '',
      apiFormat: 'OpenAI compatible (/v1/chat/completions)',
      apiKey: '',
      hasApiKey: false,
      models: [],
    }
    setSelectedId(provider.id)
    commit([...providers, provider])
  }

  const saveCredential = async (): Promise<void> => {
    if (!selected || !apiKeyDraft.trim() || savingCredential) return
    setSavingCredential(true)
    try {
      setProviders(await window.ndDsh.providers.setApiKey(selected.id, apiKeyDraft))
      setApiKeyDraft('')
      setShowApiKey(false)
      setPingResult(null)
      setCompletionResult(null)
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setSavingCredential(false)
    }
  }

  const clearCredential = async (): Promise<void> => {
    if (!selected || !selected.hasApiKey || savingCredential) return
    setSavingCredential(true)
    try {
      setProviders(await window.ndDsh.providers.clearApiKey(selected.id))
      setApiKeyDraft('')
      setShowApiKey(false)
      setPingResult(null)
      setCompletionResult(null)
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setSavingCredential(false)
    }
  }

  const addModel = (): void => {
    const index = (selected?.models.length ?? 0) + 1
    updateSelected({ models: [...(selected?.models ?? []), { id: `model-${index}`, context: '128K' }] })
  }

  const openModelSettings = (model: ProviderModel): void => {
    setModelSettingsDraft({
      sourceId: model.id,
      id: model.id,
      context: model.context,
      maxOutputTokens: model.maxOutputTokens === undefined ? '' : String(model.maxOutputTokens),
      ...(model.inputTypes === undefined ? {} : { inputTypes: [...model.inputTypes] }),
    })
  }

  const setModelInputImage = (enabled: boolean): void => {
    setModelSettingsDraft((current) => current === null ? current : {
      ...current,
      inputTypes: enabled ? ['text', 'image'] : ['text'],
    })
  }

  const saveModelSettings = (): void => {
    if (!selected || !modelSettingsDraft) return
    const id = modelSettingsDraft.id.trim()
    const context = modelSettingsDraft.context.trim()
    const output = modelSettingsDraft.maxOutputTokens.trim()
    if (!id) return onError('Model ID is required')
    if (!context || parseModelTokenLimit(context) === undefined) return onError('Context window must be a positive token count, such as 128K or 1M')
    if (selected.models.some((model) => model.id !== modelSettingsDraft.sourceId && model.id === id)) return onError(`A model named ${id} already exists`)
    const maxOutputTokens = output ? parseModelTokenLimit(output) : undefined
    if (output && maxOutputTokens === undefined) return onError('Max output tokens must be a positive token count')
    const nextModel: ProviderModel = {
      id,
      context,
      ...(modelSettingsDraft.inputTypes === undefined ? {} : { inputTypes: [...modelSettingsDraft.inputTypes] }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    }
    updateSelected({ models: selected.models.map((model) => model.id === modelSettingsDraft.sourceId ? nextModel : model) })
    setModelSettingsDraft(null)
  }

  const removeModel = (id: string): void => {
    updateSelected({ models: (selected?.models ?? []).filter((model) => model.id !== id) })
  }

  const commitContextEdit = (): void => {
    if (editingContextModelId && contextDraft.trim()) {
      updateSelected({
        models: (selected?.models ?? []).map((model) => (model.id === editingContextModelId ? { ...model, context: contextDraft.trim() } : model)),
      })
    }
    setEditingContextModelId(null)
  }

  const addHeader = (): void => {
    const key = newHeaderKey.trim()
    let value = newHeaderValue.trim()
    if (!key) return onError('Header name is required')
    if (!selected) return
    if (!value && key.toLowerCase() === 'x-opencode-session') {
      value = 'chatId'
    }
    const current = selected.headers ?? {}
    if (Object.keys(current).some((k) => k.toLowerCase() === key.toLowerCase())) {
      return onError(`Header "${key}" is already set`)
    }
    updateSelected({ headers: { ...current, [key]: value } })
    setNewHeaderKey('')
    setNewHeaderValue('')
  }

  const removeHeader = (keyToRemove: string): void => {
    if (!selected || !selected.headers) return
    const next = { ...selected.headers }
    delete next[keyToRemove]
    updateSelected({ headers: Object.keys(next).length > 0 ? next : undefined })
  }

  const updateHeaderValue = (key: string, value: string): void => {
    if (!selected || !selected.headers) return
    updateSelected({ headers: { ...selected.headers, [key]: value } })
  }

  const refresh = async (): Promise<void> => {
    try {
      const loaded = await window.ndDsh.providers.list()
      setProviders(loaded)
      const list = showOnlyEnabled ? loaded.filter((provider) => provider.enabled) : loaded
      setSelectedId((current) => list.some((provider) => provider.id === current) ? current : (list[0]?.id ?? ''))
    } catch (cause) {
      onError(errorMessage(cause))
    }
  }

  // Real probe: the trusted main process sends an authenticated request to
  // this provider's server and reports state, HTTP status, and latency.
  const testConnection = async (): Promise<void> => {
    if (!selected || testing) return
    setTesting(true)
    setPingResult(null)
    try {
      setPingResult(await window.ndDsh.providers.ping(selected.id, true))
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setTesting(false)
    }
  }

  // Generation probe: a tiny real chat completion with the stored credential.
  // Reachability alone cannot see upstream failures that only hit the
  // completion path (the exact failure mode behind opaque session errors).
  const testCompletion = async (): Promise<void> => {
    if (!selected || testingCompletion) return
    setTestingCompletion(true)
    setCompletionResult(null)
    try {
      setCompletionResult(await window.ndDsh.providers.testCompletion(selected.id))
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setTestingCompletion(false)
    }
  }

  /** Probe the provider endpoint on behalf of a specific model row. */
  const testModel = async (modelId: string): Promise<void> => {
    if (!selected || modelPings[modelId] === 'testing') return
    setModelPings((current) => ({ ...current, [modelId]: 'testing' }))
    try {
      const result = await window.ndDsh.providers.ping(selected.id, true)
      setModelPings((current) => ({ ...current, [modelId]: result }))
    } catch (cause) {
      onError(errorMessage(cause))
      setModelPings((current) => {
        const next = { ...current }
        delete next[modelId]
        return next
      })
    }
  }

  const pingLabel = (ping: ProviderPingResult): string => {
    if (ping.state === 'ok') {
      // Public /models endpoints answer 200 without any credential, so "ok"
      // alone says nothing about whether sessions can authenticate.
      if (!ping.hasApiKey) return `Reachable · HTTP ${ping.status ?? '?'} · no stored credential`
      return `Online · ${ping.latencyMs ?? '?'}ms${ping.status !== undefined ? ` · HTTP ${ping.status}` : ''}`
    }
    if (ping.state === 'auth') return `Reachable · credential rejected${ping.status !== undefined ? ` · HTTP ${ping.status}` : ''}`
    return 'No answer · timeout or network error'
  }

  const completionLabel = (ping: ProviderPingResult): string => {
    if (ping.state === 'ok') return `Generation OK · ${ping.latencyMs ?? '?'}ms`
    if (ping.state === 'auth') return `Generation failed · credential rejected${ping.status !== undefined ? ` · HTTP ${ping.status}` : ''}`
    const detail = ping.detail ? ` · ${ping.detail}` : ''
    return `Generation failed${ping.status !== undefined ? ` · HTTP ${ping.status}` : ''}${detail || ' · no answer'}`
  }

  const pingColor = (ping: ProviderPingResult): string => {
    if (ping.state === 'ok') return ping.hasApiKey ? 'text-green-400' : 'text-amber-500'
    return PING_RESULT_COLORS[ping.state]
  }

  // Enable gate: the most recent provider-level probe must have reached the
  // server AND been accepted with a stored credential. "Reachable · no stored
  // credential" does not unlock enabling. Disabling is never gated.
  const connectionVerified = pingResult?.state === 'ok' && pingResult.hasApiKey
  const enableBlocked = !selected?.enabled && !connectionVerified

  return (
    <section className="models-scope grid h-full w-full grid-rows-[auto_minmax(0,1fr)] min-h-0 bg-(--models-bg) text-(--models-text)" aria-label="Model settings">
      <header className="flex items-start justify-between gap-3.5 px-6 pb-3 pt-[18px]">
        <div>
          <h2 className="m-0 text-xl font-semibold tracking-tight">Model settings</h2>
          <p className="mb-0 mt-1 text-xs/[1.5] text-(--models-muted)">Configure model-provider routes independently from coding engines. Enabled routes become available to ND Harness sessions on the next prompt.</p>
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-0.5">
          <label
            htmlFor="toggle-show-only-enabled"
            className="flex cursor-pointer select-none items-center gap-2 text-xs text-(--models-muted) transition-colors hover:text-(--models-text)"
            title="Show only enabled providers"
          >
            <Switch
              id="toggle-show-only-enabled"
              size="sm"
              checked={showOnlyEnabled}
              onCheckedChange={toggleShowOnlyEnabled}
              aria-label="Show only enabled providers"
            />
            <span>Show only enabled</span>
          </label>
          <button
            className="grid size-[30px] shrink-0 place-items-center rounded-[7px] text-(--models-muted) transition-colors hover:bg-(--models-field) hover:text-(--models-text) [&_svg]:size-[15px]"
            title="Reload providers from storage"
            aria-label="Refresh model settings"
            onClick={() => void refresh()}
          >
            <RotateIcon />
          </button>
        </div>
      </header>

      <div className="grid min-h-0 overflow-hidden grid-cols-[240px_minmax(0,1fr)] gap-4 px-6 pb-6">
        <aside className="flex min-h-0 flex-col overflow-auto" aria-label="Providers">
          <div className="px-1.5 pb-1.5 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-(--models-faint)">Providers</div>
          {visibleProviders.length === 0 ? (
            <div className="px-2 py-3 text-left text-xs text-(--models-faint)">
              {providers.length === 0 ? 'No providers' : 'No enabled providers'}
            </div>
          ) : (
            visibleProviders.map((provider) => (
              <ProviderItem key={provider.id} provider={provider} selected={provider.id === selectedId} onSelect={() => setSelectedId(provider.id)} />
            ))
          )}
          <button className="mt-2.5 flex items-center gap-[7px] rounded-md px-[9px] py-1.5 text-left text-[12px] text-(--models-muted) transition-colors hover:text-(--models-text) [&_svg]:size-3.5" onClick={addProvider}>
            <PlusIcon />Add provider
          </button>
        </aside>

        {selected ? (
          <div className="flex min-h-0 flex-col overflow-auto rounded-[14px] border border-(--models-border) bg-(--models-surface) p-[22px]">
            <header className="mb-[18px] flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                {renamingProvider ? (
                  <input
                    className="h-7 w-40 rounded-md border border-(--models-border-2) bg-(--models-field) px-2 text-sm text-(--models-text) outline-none"
                    value={nameDraft}
                    autoFocus
                    onChange={(event) => setNameDraft(event.target.value)}
                    onBlur={renameProvider}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') renameProvider()
                      if (event.key === 'Escape') setRenamingProvider(false)
                    }}
                  />
                ) : (
                  <>
                    <h3 className="m-0 truncate text-[17px] font-semibold">{selected.name}</h3>
                    <button className={miniIconButton} title="Rename provider" aria-label="Rename provider" onClick={() => { setNameDraft(selected.name); setRenamingProvider(true) }}>
                      <PencilIcon />
                    </button>
                  </>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={pillBadge(selected.enabled)}>{selected.enabled ? 'Enabled' : 'Disabled'}</span>
                <button type="button" className={scopeButton} disabled={enableBlocked} onClick={() => { if (!enableBlocked) updateSelected({ enabled: !selected.enabled }) }}>{selected.enabled ? 'Disable' : 'Enable'}</button>
                {enableBlocked ? (
                  <span className="shrink-0 text-[10px] text-(--models-muted)" title="“Test connection” must pass with a stored credential before this provider can be enabled.">
                    Pass “Test connection” to enable
                  </span>
                ) : null}
                <button type="button" className={scopeButton} disabled={testing} onClick={() => void testConnection()}>{testing ? 'Testing…' : 'Test connection'}</button>
                {pingResult ? <span className={cn('shrink-0 text-[10px] font-semibold', pingColor(pingResult))}>{pingLabel(pingResult)}</span> : null}
                <button type="button" className={scopeButton} disabled={testingCompletion || !selected.models.some((model) => model.id.trim())} title="Send a tiny real completion with the stored credential" onClick={() => void testCompletion()}>{testingCompletion ? 'Generating…' : 'Test completion'}</button>
                {completionResult ? <span className={cn('shrink-0 text-[10px] font-semibold', PING_RESULT_COLORS[completionResult.state])} title={completionResult.detail}>{completionLabel(completionResult)}</span> : null}
                <button className={cn(miniIconButton, 'hover:text-destructive')} title="Delete provider" aria-label="Delete provider" onClick={() => removeProvider(selected.id)}><TrashIcon /></button>
              </div>
            </header>

            <form className="flex flex-col gap-[13px]" onSubmit={(event: FormEvent) => event.preventDefault()}>
              <div className="flex flex-col gap-[5px]">
                <label htmlFor="provider-base-url" className="text-[11px] font-medium text-(--models-muted)">Base URL</label>
                <input
                  id="provider-base-url"
                  value={selected.baseUrl}
                  placeholder="Leave blank for a provider-native catalog endpoint"
                  spellCheck={false}
                  onChange={(event) => updateSelected({ baseUrl: event.target.value })}
                  className="h-8 rounded-[7px] border border-(--models-border) bg-(--models-field) px-2.5 text-[12px] text-(--models-text) outline-none"
                />
              </div>
              <div className="flex flex-col gap-[5px]">
                <label htmlFor="provider-api-format" className="text-[11px] font-medium text-(--models-muted)">API format</label>
                <Select value={selected.apiFormat} onValueChange={(value) => updateSelected({ apiFormat: value })}>
                  <SelectTrigger id="provider-api-format" className="h-8 w-full rounded-[7px] border-(--models-border) bg-(--models-field) px-2.5 text-[12px] text-(--models-text)">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {API_FORMATS.includes(selected.apiFormat) ? null : <SelectItem value={selected.apiFormat}>{selected.apiFormat}</SelectItem>}
                    {API_FORMATS.map((format) => <SelectItem key={format} value={format}>{format}</SelectItem>)}
                  </SelectContent>
                </Select>
                <span className="text-[10.5px]/[1.5] text-(--models-muted)">Native/catalog mode lets the runtime use a known provider's own protocol and ambient authentication. Custom gateways can use OpenAI Completions, OpenAI Responses, or Anthropic Messages.</span>
              </div>
              <div className="flex flex-col gap-[5px]">
                <label htmlFor="provider-api-key" className="text-[11px] font-medium text-(--models-muted)">Credential</label>
                <div className="relative flex items-center">
                  <input
                    id="provider-api-key"
                    type={showApiKey ? 'text' : 'password'}
                    value={apiKeyDraft}
                    placeholder={selected.hasApiKey ? 'Credential stored — enter a new key to replace it' : 'Enter API key'}
                    spellCheck={false}
                    autoComplete="new-password"
                    onChange={(event) => setApiKeyDraft(event.target.value)}
                    className="h-8 w-full rounded-[7px] border border-(--models-border) bg-(--models-field) px-2.5 pr-[34px] text-[12px] text-(--models-text) outline-none"
                  />
                  <button
                    type="button"
                    title={showApiKey ? 'Hide new credential' : 'Show new credential'}
                    aria-label={showApiKey ? 'Hide new credential' : 'Show new credential'}
                    onClick={() => setShowApiKey((current) => !current)}
                    className="absolute right-1 grid size-[26px] place-items-center rounded-[5px] text-(--models-faint) transition-colors hover:text-(--models-text) [&_svg]:size-3.5"
                  >
                    {showApiKey ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={pillBadge(selected.hasApiKey)}>{selected.hasApiKey ? 'Credential stored' : 'No stored credential'}</span>
                  <button type="button" className={scopeButton} disabled={!apiKeyDraft.trim() || savingCredential} onClick={() => void saveCredential()}>{selected.hasApiKey ? 'Replace key' : 'Save key'}</button>
                  {selected.hasApiKey ? <button type="button" className={scopeButton} disabled={savingCredential} onClick={() => void clearCredential()}>Clear key</button> : null}
                </div>
                <span className="max-w-[360px] text-[10px]/[1.45] text-(--models-muted)">Stored credentials are write-only from this screen. React receives only whether a credential exists; the key remains in the trusted main process and OS-backed secure storage. Beta scope: provider credentials belong to this ND desktop profile and are shared by projects that select the same provider; ND does not claim per-company or per-project credential isolation yet.</span>
              </div>
              <div className="flex flex-col gap-[5px]">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] font-medium text-(--models-muted)">Custom HTTP headers</label>
                    {saveStatus ? (
                      <span className="text-[10px] text-green-400 font-medium animate-pulse">
                        ✓ {saveStatus}
                      </span>
                    ) : null}
                  </div>
                  {!selected.headers?.['x-opencode-session'] ? (
                    <button
                      type="button"
                      className="text-[10px] text-(--models-muted) transition-colors hover:text-(--models-text)"
                      onClick={() => {
                        setNewHeaderKey('x-opencode-session')
                        setNewHeaderValue('chatId')
                      }}
                    >
                      + Add x-opencode-session
                    </button>
                  ) : null}
                </div>
                {selected.headers && Object.keys(selected.headers).length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {Object.entries(selected.headers).map(([key, value]) => (
                      <div key={key} className="flex items-center gap-2">
                        <span className="h-8 w-44 shrink-0 truncate rounded-[7px] border border-(--models-border) bg-(--models-field) px-2.5 py-1.5 font-mono text-[11px] text-(--models-text)">
                          {key}
                        </span>
                        <input
                          value={value}
                          placeholder="Header value"
                          spellCheck={false}
                          onChange={(e) => updateHeaderValue(key, e.target.value)}
                          className="h-8 min-w-0 flex-1 rounded-[7px] border border-(--models-border) bg-(--models-field) px-2.5 font-mono text-[11px] text-(--models-text) outline-none"
                        />
                        <select
                          aria-label={`Preset value for ${key}`}
                          title="Choose dynamic value or generate UUID"
                          className="h-8 shrink-0 rounded-[7px] border border-(--models-border) bg-(--models-field) px-2 font-mono text-[11px] text-(--models-muted) outline-none transition-colors hover:text-(--models-text) cursor-pointer"
                          value=""
                          onChange={(e) => {
                            const val = e.target.value
                            if (!val) return
                            if (val === '__uuid__') {
                              updateHeaderValue(key, crypto.randomUUID())
                            } else {
                              updateHeaderValue(key, val)
                            }
                          }}
                        >
                          <option value="" disabled hidden>Preset ▾</option>
                          <option value="chatId">chatId (dynamic)</option>
                          <option value="sessionId">sessionId (dynamic)</option>
                          <option value="uuid">uuid (dynamic)</option>
                          <option value="__uuid__">Generate UUID</option>
                        </select>
                        <button
                          type="button"
                          className={cn(miniIconButton, 'hover:text-destructive')}
                          title={`Remove ${key}`}
                          aria-label={`Remove ${key}`}
                          onClick={() => removeHeader(key)}
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="flex items-center gap-1.5 text-[10px] text-(--models-muted)">
                  <span>Dynamic value presets:</span>
                  <button
                    type="button"
                    className="rounded border border-(--models-border) bg-(--models-field) px-1.5 py-0.5 font-mono text-[10px] text-(--models-text) hover:border-(--models-text)/30 transition-colors"
                    onClick={() => {
                      if (!newHeaderKey.trim()) setNewHeaderKey('x-opencode-session')
                      setNewHeaderValue('chatId')
                    }}
                  >
                    chatId
                  </button>
                  <button
                    type="button"
                    className="rounded border border-(--models-border) bg-(--models-field) px-1.5 py-0.5 font-mono text-[10px] text-(--models-text) hover:border-(--models-text)/30 transition-colors"
                    onClick={() => {
                      if (!newHeaderKey.trim()) setNewHeaderKey('x-opencode-session')
                      setNewHeaderValue('sessionId')
                    }}
                  >
                    sessionId
                  </button>
                  <button
                    type="button"
                    className="rounded border border-(--models-border) bg-(--models-field) px-1.5 py-0.5 font-mono text-[10px] text-(--models-text) hover:border-(--models-text)/30 transition-colors"
                    onClick={() => {
                      if (!newHeaderKey.trim()) setNewHeaderKey('x-opencode-session')
                      setNewHeaderValue('uuid')
                    }}
                  >
                    uuid
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={newHeaderKey}
                    placeholder="Header name (e.g. x-opencode-session)"
                    spellCheck={false}
                    onChange={(e) => setNewHeaderKey(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addHeader() }}
                    className="h-8 w-44 shrink-0 rounded-[7px] border border-(--models-border) bg-(--models-field) px-2.5 font-mono text-[11px] text-(--models-text) outline-none"
                  />
                  <input
                    value={newHeaderValue}
                    placeholder="Header value (e.g. chatId, uuid)"
                    spellCheck={false}
                    onChange={(e) => setNewHeaderValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addHeader() }}
                    className="h-8 min-w-0 flex-1 rounded-[7px] border border-(--models-border) bg-(--models-field) px-2.5 font-mono text-[11px] text-(--models-text) outline-none"
                  />
                  <select
                    aria-label="Select header value preset"
                    title="Choose dynamic value or generate UUID"
                    className="h-8 shrink-0 rounded-[7px] border border-(--models-border) bg-(--models-field) px-2 font-mono text-[11px] text-(--models-muted) outline-none transition-colors hover:text-(--models-text) cursor-pointer"
                    value=""
                    onChange={(e) => {
                      const val = e.target.value
                      if (!val) return
                      if (val === '__uuid__') {
                        setNewHeaderValue(crypto.randomUUID())
                      } else {
                        setNewHeaderValue(val)
                      }
                      if (!newHeaderKey.trim()) {
                        setNewHeaderKey('x-opencode-session')
                      }
                    }}
                  >
                    <option value="" disabled hidden>Value preset ▾</option>
                    <option value="chatId">chatId (dynamic)</option>
                    <option value="sessionId">sessionId (dynamic)</option>
                    <option value="uuid">uuid (dynamic)</option>
                    <option value="__uuid__">Generate UUID</option>
                  </select>
                  <button
                    type="button"
                    className={scopeButton}
                    disabled={!newHeaderKey.trim()}
                    onClick={addHeader}
                  >
                    Add header
                  </button>
                </div>
                <span className="text-[10px]/[1.45] text-(--models-muted)">
                  Custom HTTP headers sent with every request. Dynamic values like <code>chatId</code>, <code>sessionId</code>, or <code>uuid</code> automatically resolve to unique conversation IDs at runtime. Required by gateways like OpenCode (Console Go: <code>x-opencode-session</code>) and custom proxies.
                </span>
              </div>
            </form>

            <div className="mt-5">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-(--models-muted)">Model list</div>
              <div className="space-y-1.5">
                {selected.models.map((model) => {
                  const modelPing = modelPings[model.id]
                  const isTesting = modelPing === 'testing'
                  const pingRes = modelPing !== undefined && modelPing !== 'testing' ? modelPing : null
                  return (
                  <div className="flex items-center justify-between gap-2.5 rounded-[9px] border border-(--models-border) bg-(--models-bg) px-3 py-[9px]" key={model.id}>
                    <span className="min-w-0 truncate font-mono text-[12px]">{model.id}</span>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {/* Per-model ping result badge */}
                      {pingRes ? (
                        <span
                          className={cn(
                            'mr-1 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold',
                            pingRes.state === 'ok' && pingRes.hasApiKey && 'bg-green-500/15 text-green-400',
                            pingRes.state === 'ok' && !pingRes.hasApiKey && 'bg-amber-500/15 text-amber-400',
                            pingRes.state === 'auth' && 'bg-amber-500/15 text-amber-400',
                            pingRes.state === 'unreachable' && 'bg-red-500/15 text-red-400',
                          )}
                          title={pingLabel(pingRes)}
                        >
                          {pingRes.state === 'ok' && pingRes.hasApiKey
                            ? `✓ ${pingRes.latencyMs ?? '?'}ms`
                            : pingRes.state === 'ok'
                              ? '⚠ No key'
                              : pingRes.state === 'auth'
                                ? '✗ Auth'
                                : '✗ Offline'}
                        </span>
                      ) : null}
                      {editingContextModelId === model.id ? (
                        <input
                          className="h-[26px] w-[200px] rounded-md border border-(--models-border-2) bg-(--models-field) px-2 font-mono text-[12px] text-(--models-text) outline-none"
                          aria-label={`Context window for ${model.id}`}
                          value={contextDraft}
                          autoFocus
                          onChange={(event) => setContextDraft(event.target.value)}
                          onBlur={commitContextEdit}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') commitContextEdit()
                            if (event.key === 'Escape') setEditingContextModelId(null)
                          }}
                        />
                      ) : <span className="rounded-full bg-(--models-field) px-2 py-0.5 text-[11px] text-(--models-muted)">{model.context}</span>}
                      {model.inputTypes?.includes('image') ? <span className="rounded-full border border-(--models-green)/35 bg-(--models-green-soft) px-2 py-0.5 text-[11px] font-semibold text-(--models-green)" title="This model accepts image input">Vision</span> : null}
                      {/* Test this model's provider connection */}
                      <button
                        className={cn(miniIconButton, isTesting && 'text-(--models-green) opacity-70')}
                        title={`Test connection for ${model.id}`}
                        aria-label={`Test connection for model ${model.id}`}
                        disabled={isTesting}
                        onClick={() => void testModel(model.id)}
                      >
                        {isTesting
                          ? <RotateIcon className="animate-spin" />
                          : pingRes?.state === 'ok'
                            ? <CheckIcon />
                            : <RotateIcon />}
                      </button>
                      <button className={miniIconButton} title="Edit model context" aria-label={`Edit context of ${model.id}`} onClick={() => { setContextDraft(model.context); setEditingContextModelId(model.id) }}><PlugIcon /></button>
                      <button className={miniIconButton} title="Edit model settings" aria-label={`Edit settings for model ${model.id}`} onClick={() => openModelSettings(model)}><PencilIcon /></button>
                      <button className={cn(miniIconButton, 'hover:text-destructive')} title="Delete model" aria-label={`Delete model ${model.id}`} onClick={() => removeModel(model.id)}><TrashIcon /></button>
                    </div>
                  </div>
                  )
                })}
              </div>
              <button className="mt-2.5 flex items-center gap-[7px] rounded-[9px] border border-(--models-border-2) bg-(--models-field) px-3 py-[7px] text-[12px] text-(--models-muted) transition-colors hover:text-(--models-text) [&_svg]:size-3.5" onClick={addModel}>
                <PlusIcon />Add model
              </button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col items-center justify-center rounded-[14px] border border-(--models-border) bg-(--models-surface) p-[22px] text-center text-[12px] text-(--models-faint)">
            <p>
              {showOnlyEnabled && providers.length > 0
                ? 'No enabled providers. Toggle off “Show only enabled” to see all providers.'
                : 'No providers yet. Use “Add provider” to create one.'}
            </p>
          </div>
        )}
      </div>
      <Dialog open={modelSettingsDraft !== null} onOpenChange={(open) => { if (!open) setModelSettingsDraft(null) }}>
        <DialogContent className="models-scope max-h-[min(720px,calc(100vh-32px))] max-w-[560px] overflow-y-auto border-(--models-border-2) bg-(--models-surface) p-5 text-(--models-text)">
          <DialogHeader>
            <DialogTitle className="text-[17px]">Edit model settings</DialogTitle>
            <DialogDescription className="text-[11px] text-(--models-muted)">Tell ND which content this model accepts. These capabilities are sent to the provider runtime for new sessions.</DialogDescription>
          </DialogHeader>
          {modelSettingsDraft ? (
            <div className="grid gap-4">
              <ModelSettingField label="Model ID">
                <input autoFocus value={modelSettingsDraft.id} onChange={(event) => setModelSettingsDraft({ ...modelSettingsDraft, id: event.target.value })} className="h-9 w-full rounded-[8px] border border-(--models-border-2) bg-(--models-field) px-3 font-mono text-[13px] text-(--models-text) outline-none focus:border-(--models-green)" />
              </ModelSettingField>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <ModelSettingField label="Context window" hint="Tokens, for example 128K or 1M">
                  <input value={modelSettingsDraft.context} onChange={(event) => setModelSettingsDraft({ ...modelSettingsDraft, context: event.target.value })} className="h-9 w-full rounded-[8px] border border-(--models-border-2) bg-(--models-field) px-3 font-mono text-[13px] text-(--models-text) outline-none focus:border-(--models-green)" />
                </ModelSettingField>
                <ModelSettingField label="Max output tokens" hint="Optional capability limit">
                  <input value={modelSettingsDraft.maxOutputTokens} placeholder="Provider default" onChange={(event) => setModelSettingsDraft({ ...modelSettingsDraft, maxOutputTokens: event.target.value })} className="h-9 w-full rounded-[8px] border border-(--models-border-2) bg-(--models-field) px-3 font-mono text-[13px] text-(--models-text) outline-none focus:border-(--models-green)" />
                </ModelSettingField>
              </div>
              <ModelSettingField label="Input types" hint="Image input enables Vision and lets ND send screenshots or image attachments.">
                <div className="flex flex-wrap gap-2">
                  <CapabilityToggle label="Text" checked disabled detail="Required" />
                  <CapabilityToggle label="Image" checked={modelSettingsDraft.inputTypes?.includes('image') ?? false} onChange={setModelInputImage} detail="Vision" />
                  <CapabilityToggle label="Video" checked={false} disabled detail="Coming soon" />
                  <CapabilityToggle label="PDF" checked={false} disabled detail="Coming soon" />
                </div>
              </ModelSettingField>
              <ModelSettingField label="Output types">
                <CapabilityToggle label="Text" checked disabled detail="Required" />
              </ModelSettingField>
              <p className="m-0 rounded-[8px] border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px]/[1.5] text-amber-400">Vision support depends on the configured endpoint accepting OpenAI image content. ND will fall back to text only when the endpoint explicitly rejects an image.</p>
            </div>
          ) : null}
          <DialogFooter className="mt-1 flex-row justify-end gap-2">
            <button type="button" className={scopeButton} onClick={() => setModelSettingsDraft(null)}>Cancel</button>
            <button type="button" className="rounded-md bg-(--models-text) px-3 py-1.5 text-[12px] font-semibold text-(--models-bg) transition-opacity hover:opacity-85" onClick={saveModelSettings}>Save</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function ProviderItem({ provider, selected, onSelect }: { provider: ModelProvider; selected: boolean; onSelect(): void }) {
  return (
    <button
      className={cn(
        'flex w-full items-center gap-[9px] rounded-[7px] px-[9px] py-[7px] text-left text-[13px] text-(--models-text) transition-colors hover:bg-(--models-surface-3) [&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:text-(--models-muted)',
        selected && 'bg-(--models-surface-3) shadow-[inset_0_0_0_1px_var(--models-border-2)]',
      )}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <BoxIcon />
      <span className="min-w-0 flex-1 truncate">{provider.name}</span>
      <span className={cn('size-[7px] shrink-0 rounded-full bg-(--models-faint)', provider.enabled && 'bg-(--models-green)')} title={provider.enabled ? 'Active' : 'Disabled'} />
    </button>
  )
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function ModelSettingField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="grid gap-1.5"><div><div className="text-[12px] font-medium text-(--models-muted)">{label}</div>{hint ? <div className="mt-0.5 text-[10px] text-(--models-faint)">{hint}</div> : null}</div>{children}</div>
}

function CapabilityToggle({ label, checked, disabled, detail, onChange }: { label: string; checked: boolean; disabled?: boolean; detail?: string; onChange?: (checked: boolean) => void }) {
  return <label className={cn('flex min-w-[102px] items-center gap-2 rounded-[8px] border border-(--models-border-2) bg-(--models-field) px-3 py-2 text-[12px]', disabled ? 'cursor-default opacity-60' : 'cursor-pointer hover:border-(--models-green)')} title={disabled ? (detail === 'Coming soon' ? `${label} input is not supported yet` : `${label} is required`) : undefined}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange?.(event.target.checked)} className="size-4 accent-(--models-green)" />
    <span>{label}</span>
    {detail ? <span className="ml-auto text-[10px] text-(--models-faint)">{detail}</span> : null}
  </label>
}
