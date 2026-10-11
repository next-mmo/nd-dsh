import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Bot, Brain, GitBranch, Plus, Puzzle, RefreshCw, Search, Server, Sparkles, Terminal, type LucideIcon } from 'lucide-react'
import type { CodingEngineDescriptor, ModelProvider } from '../../../shared/contracts'
import {
  EXTENSION_ADAPTERS,
  resolveExtensionRoute,
  type AgentExtensionManifest,
  type AgentExtensionSurface,
  type ExtensionAdapter,
  type ExtensionDemoResult,
} from '../../../shared/extensions'
import { cn } from '../lib/utils'
import { SettingsButton, SettingsRow, SettingsSection, StatusChip, rowDesc, rowPathText, rowStack, rowTitle } from './settings-primitives'
import { WorkflowPluginsCard } from './WorkflowPluginsCard'

const SURFACE_ORDER: readonly AgentExtensionSurface[] = ['plugin', 'mcp', 'skill', 'command', 'hook', 'subagent', 'memory']

const SURFACE_LABEL: Record<AgentExtensionSurface, string> = {
  memory: 'Memory',
  subagent: 'Subagents',
  plugin: 'Plugins',
  mcp: 'MCP Servers',
  skill: 'Skills',
  command: 'Commands',
  hook: 'Hooks',
}

const SURFACE_TAB_LABEL: Record<AgentExtensionSurface, string> = {
  memory: 'Memory',
  subagent: 'Subagents',
  plugin: 'Plugins',
  mcp: 'MCP',
  skill: 'Skills',
  command: 'Commands',
  hook: 'Hooks',
}

const SURFACE_ICON: Record<AgentExtensionSurface, LucideIcon> = {
  plugin: Puzzle,
  mcp: Server,
  skill: Sparkles,
  command: Terminal,
  hook: GitBranch,
  subagent: Bot,
  memory: Brain,
}

interface DetailDraft {
  name: string
  description: string
  version: string
  instructions: string
  runtimeCommand: string
  runtimeArgs: string
  runtimeEnvRefs: string
}

export function ExtensionSettings({ onError }: { onError(message: string): void }) {
  const [extensions, setExtensions] = useState<AgentExtensionManifest[]>([])
  const [engines, setEngines] = useState<CodingEngineDescriptor[]>([])
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [surface, setSurface] = useState<AgentExtensionSurface>('plugin')
  const [selectedId, setSelectedId] = useState<string>('demo-counter-plugin')
  const [busy, setBusy] = useState<string | null>('load')
  const [query, setQuery] = useState('')
  const [demoEngineId, setDemoEngineId] = useState('')
  const [demoProviderId, setDemoProviderId] = useState('')
  const [demoResult, setDemoResult] = useState<ExtensionDemoResult | null>(null)
  const [detailDraft, setDetailDraft] = useState<DetailDraft | null>(null)
  const [view, setView] = useState<'overview' | 'routing'>('overview')
  const isRouting = view === 'routing'

  useEffect(() => {
    let mounted = true
    void Promise.all([window.ndDshExtensions.list(), window.ndDsh.engines.list(), window.ndDsh.providers.list()])
      .then(([extensionItems, engineItems, providerItems]) => {
        if (!mounted) return
        setExtensions(extensionItems)
        setEngines(engineItems)
        setProviders(providerItems)
        setDemoEngineId(engineItems.find((item) => item.available)?.id ?? engineItems[0]?.id ?? '')
        setDemoProviderId(providerItems.find((item) => item.enabled)?.id ?? '')
      })
      .catch((cause) => onError(errorMessage(cause)))
      .finally(() => { if (mounted) setBusy(null) })
    const offExtensions = window.ndDshExtensions.onChanged((items) => { if (mounted) setExtensions(items) })
    const offProviders = window.ndDsh.providers.onChanged((items) => { if (mounted) setProviders(items) })
    return () => {
      mounted = false
      offExtensions()
      offProviders()
    }
  }, [onError])

  const surfaceItems = useMemo(() => extensions.filter((item) => item.surface === surface), [extensions, surface])
  const normalizedQuery = query.trim().toLowerCase()
  const visible = useMemo(() => surfaceItems.filter((item) => {
    if (!normalizedQuery) return true
    return `${item.name}\n${item.description}\n${item.id}`.toLowerCase().includes(normalizedQuery)
  }), [normalizedQuery, surfaceItems])
  const installed = visible.filter((item) => !item.builtInDemo)
  const builtIn = visible.filter((item) => item.builtInDemo)
  const selected = extensions.find((item) => item.id === selectedId) ?? surfaceItems[0]

  useEffect(() => {
    if (!selected) {
      setDetailDraft(null)
      return
    }
    setDetailDraft({
      name: selected.name,
      description: selected.description,
      version: selected.version,
      instructions: selected.instructions ?? '',
      runtimeCommand: selected.runtime?.kind === 'mcp-stdio' ? selected.runtime.command : '',
      runtimeArgs: selected.runtime?.kind === 'mcp-stdio' ? selected.runtime.args.join('\n') : '',
      runtimeEnvRefs: selected.runtime?.kind === 'mcp-stdio'
        ? Object.entries(selected.runtime.env).map(([target, source]) => `${target}=${source}`).join('\n')
        : '',
    })
    setDemoResult(null)
  }, [selected?.id])

  const persist = async (next: AgentExtensionManifest, label = 'save'): Promise<void> => {
    if (busy) return
    setBusy(`${label}-${next.id}`)
    try {
      const items = await window.ndDshExtensions.save(next)
      setExtensions(items)
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const refresh = async (): Promise<void> => {
    if (busy) return
    setBusy('refresh')
    try {
      const [extensionItems, engineItems, providerItems] = await Promise.all([
        window.ndDshExtensions.list(),
        window.ndDsh.engines.list(),
        window.ndDsh.providers.list(),
      ])
      setExtensions(extensionItems)
      setEngines(engineItems)
      setProviders(providerItems)
      if (!engineItems.some((item) => item.id === demoEngineId)) {
        setDemoEngineId(engineItems.find((item) => item.available)?.id ?? engineItems[0]?.id ?? '')
      }
      if (demoProviderId && !providerItems.some((item) => item.id === demoProviderId && item.enabled)) {
        setDemoProviderId(providerItems.find((item) => item.enabled)?.id ?? '')
      }
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const setEngineRoute = (extension: AgentExtensionManifest, engineId: string, adapter: ExtensionAdapter): void => {
    void persist({
      ...extension,
      engineRoutes: [
        ...extension.engineRoutes.filter((route) => route.engineId !== engineId),
        ...(adapter === 'auto' ? [] : [{ engineId, adapter }]),
      ],
    }, 'route')
  }

  const toggleProvider = (extension: AgentExtensionManifest, providerId: string, enabled: boolean): void => {
    const current = new Map<string, boolean>()
    if (extension.providerRoutes.length === 0) {
      for (const provider of providers) current.set(provider.id, provider.enabled)
    } else {
      for (const route of extension.providerRoutes) current.set(route.providerId, route.enabled)
    }
    current.set(providerId, enabled)
    void persist({
      ...extension,
      providerRoutes: [...current.entries()].map(([id, value]) => ({ providerId: id, enabled: value })),
    }, 'provider')
  }

  const allowAllProviders = (extension: AgentExtensionManifest): void => {
    void persist({ ...extension, providerRoutes: [] }, 'provider')
  }

  const reset = async (): Promise<void> => {
    if (busy) return
    setBusy('reset')
    try {
      const items = await window.ndDshExtensions.resetDemos()
      setExtensions(items)
      setSurface('plugin')
      setSelectedId('demo-counter-plugin')
      setQuery('')
      setDemoResult(null)
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const addExtension = async (): Promise<void> => {
    if (busy) return
    const id = `custom-${surface}-${Date.now().toString(36)}`
    const manifest: AgentExtensionManifest = {
      id,
      name: `New ${singularSurface(surface)}`,
      description: `Custom ${SURFACE_LABEL[surface].toLowerCase()} extension managed by ND.`,
      surface,
      version: '1.0.0',
      enabled: false,
      instructions: '',
      engineRoutes: [],
      providerRoutes: [],
    }
    setBusy('add')
    try {
      setExtensions(await window.ndDshExtensions.save(manifest))
      setQuery('')
      setSelectedId(id)
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const deleteSelected = async (): Promise<void> => {
    if (!selected || selected.builtInDemo || busy) return
    setBusy(`delete-${selected.id}`)
    try {
      const items = await window.ndDshExtensions.remove(selected.id)
      setExtensions(items)
      const next = items.find((item) => item.surface === surface)
      setSelectedId(next?.id ?? '')
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const saveDetails = (): void => {
    if (!selected || !detailDraft) return
    try {
      const runtime = selected.surface === 'mcp' || selected.surface === 'plugin'
        ? parseRuntime(detailDraft)
        : undefined
      const next: AgentExtensionManifest = {
        ...selected,
        name: detailDraft.name,
        description: detailDraft.description,
        version: detailDraft.version,
        instructions: detailDraft.instructions,
      }
      if (runtime) next.runtime = runtime
      else delete next.runtime
      void persist(next, 'details')
    } catch (cause) {
      onError(errorMessage(cause))
    }
  }

  const runDemo = async (): Promise<void> => {
    if (!selected?.builtInDemo || busy) return
    setBusy(`demo-${selected.id}`)
    try {
      setDemoResult(await window.ndDshExtensions.runDemo(
        selected.id,
        demoEngineId || undefined,
        demoProviderId || undefined,
      ))
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const selectSurface = (nextSurface: AgentExtensionSurface): void => {
    setSurface(nextSurface)
    setQuery('')
    const first = extensions.find((extension) => extension.surface === nextSurface)
    setSelectedId(first?.id ?? '')
  }

  const SurfaceIcon = SURFACE_ICON[surface]

  return (
    <main className="min-h-0 overflow-auto px-[26px] pb-[56px] pt-5">
      <div className="mx-auto w-full max-w-[1040px]">
        <header className="mb-6">
          <h2 className="m-0 text-[26px] font-semibold tracking-[-0.02em] text-strong">Plugins</h2>
          <p className="mt-1.5 max-w-[720px] text-[11px] leading-5 text-faint">
            Install capabilities once in ND, then route them across ND Harness, Codex, and future coding engines without rebuilding your company setup.
          </p>
        </header>

        <div className="mb-6 flex items-center border-b border-border-soft pb-2.5">
          <nav role="tablist" aria-label="Plugin sub-tabs" className="flex shrink-0 gap-0.5 rounded-lg border border-border bg-secondary p-[3px]">
            {([{ id: 'overview', label: 'Overview' }, { id: 'routing', label: 'Routing' }] as const).map(({ id, label }) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={view === id}
                className={cn(
                  'rounded-md px-3 py-1 text-[11px] font-semibold transition-colors',
                  view === id ? 'bg-primary/10 text-primary' : 'text-faint hover:bg-accent hover:text-soft',
                )}
                onClick={() => setView(id)}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>

        <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
          <nav aria-label="Plugin capability types" className="flex min-w-0 flex-wrap items-center gap-1">
            {SURFACE_ORDER.map((item) => {
              const count = extensions.filter((extension) => extension.surface === item).length
              return (
                <button
                  key={item}
                  type="button"
                  aria-label={SURFACE_LABEL[item]}
                  aria-pressed={surface === item}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium transition-colors',
                    surface === item
                      ? 'bg-secondary text-strong'
                      : 'text-faint hover:bg-secondary/60 hover:text-soft',
                  )}
                  onClick={() => selectSurface(item)}
                >
                  <span>{SURFACE_TAB_LABEL[item]}</span>
                  <span className="text-[9px] text-faint">{count}</span>
                </button>
              )
            })}
          </nav>

          <div className="flex items-center gap-2">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
              <input
                aria-label={isRouting ? 'Search extensions' : 'Search plugins'}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${SURFACE_TAB_LABEL[surface].toLowerCase()}...`}
                className="h-9 w-[256px] rounded-xl border border-border bg-background pl-9 pr-3 text-[11px] text-soft outline-none transition-colors placeholder:text-faint focus:border-border-strong"
              />
            </label>
            <button
              type="button"
              aria-label="Refresh plugin catalog"
              title="Refresh"
              disabled={Boolean(busy)}
              className="grid size-9 place-items-center rounded-xl border border-border bg-background text-soft transition-colors hover:bg-accent disabled:opacity-50"
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn('size-3.5', busy === 'refresh' && 'animate-spin')} aria-hidden="true" />
            </button>
            {!isRouting ? (
              <button
                type="button"
                aria-label={`Add ${singularSurface(surface)}`}
                disabled={Boolean(busy)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-strong px-3 text-[11px] font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                onClick={() => void addExtension()}
              >
                <Plus className="size-3.5" aria-hidden="true" />
                New
              </button>
            ) : null}
          </div>
        </div>

        {!isRouting && surface === 'plugin' ? <WorkflowPluginsCard onError={onError} /> : null}

        <CatalogSection title="Installed" count={installed.length}>
          {busy === 'load' ? (
            <div className="rounded-xl border border-border-soft px-5 py-8 text-center text-[11px] text-faint">Loading plugin catalog…</div>
          ) : installed.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-border-soft bg-background">
              {installed.map((extension, index) => (
                <ExtensionCatalogRow
                  key={extension.id}
                  extension={extension}
                  selected={selected?.id === extension.id}
                  busy={Boolean(busy)}
                  icon={SurfaceIcon}
                  last={index === installed.length - 1}
                  onSelect={() => setSelectedId(extension.id)}
                  onToggle={(enabled) => void persist({ ...extension, enabled }, 'enabled')}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border px-6 py-11 text-center">
              <SurfaceIcon className="mx-auto size-6 text-faint" aria-hidden="true" />
              <strong className="mt-3 block text-[12px] font-semibold text-strong">No {SURFACE_TAB_LABEL[surface].toLowerCase()} installed</strong>
              <p className="mx-auto mt-1 max-w-[460px] text-[10px] leading-5 text-faint">
                {normalizedQuery
                  ? 'No installed capability matches this search.'
                  : 'Create a custom capability or use an ND built-in below. Plugins can bundle MCP tools, skills, commands, hooks, and portable instructions.'}
              </p>
              {!normalizedQuery ? (
                <button
                  type="button"
                  className="mt-3 inline-flex h-8 items-center rounded-lg bg-strong px-3 text-[10px] font-semibold text-background"
                  onClick={() => {
                    const firstBuiltIn = surfaceItems.find((item) => item.builtInDemo)
                    if (firstBuiltIn) setSelectedId(firstBuiltIn.id)
                    document.getElementById('nd-built-in-extensions')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }}
                >
                  Browse built-ins
                </button>
              ) : null}
            </div>
          )}
        </CatalogSection>

        <div id="nd-built-in-extensions">
          <CatalogSection title="Built-in" count={builtIn.length} className="mt-8">
            {builtIn.length > 0 ? (
              <div className="overflow-hidden rounded-xl border border-border-soft bg-background">
                {builtIn.map((extension, index) => (
                  <ExtensionCatalogRow
                    key={extension.id}
                    extension={extension}
                    selected={selected?.id === extension.id}
                    busy={Boolean(busy)}
                    icon={SurfaceIcon}
                    last={index === builtIn.length - 1}
                    onSelect={() => setSelectedId(extension.id)}
                    onToggle={(enabled) => void persist({ ...extension, enabled }, 'enabled')}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-border-soft px-5 py-8 text-center text-[10px] text-faint">
                {normalizedQuery ? 'No built-in capability matches this search.' : 'No built-in capability is registered for this surface.'}
              </div>
            )}
          </CatalogSection>
        </div>

        {selected ? (
          <div className="mt-9 border-t border-border-soft pt-2">
            {!isRouting ? (
            <>
            <SettingsSection title="Configuration">
              <SettingsRow>
                <div className={rowStack}>
                  <div className="flex items-center gap-2">
                    <strong className={rowTitle}>{selected.name}</strong>
                    {selected.builtInDemo ? <StatusChip good>Built-in</StatusChip> : <StatusChip>Custom</StatusChip>}
                  </div>
                  <span className={rowDesc}>{selected.description}</span>
                  <code className={rowPathText}>{selected.id}</code>
                </div>
                <div className="flex items-center gap-3">
                  {!selected.builtInDemo ? <SettingsButton disabled={Boolean(busy)} onClick={() => void deleteSelected()}>Delete</SettingsButton> : null}
                  <div className="flex items-center gap-2 text-[10px] text-soft">
                    <ToggleSwitch
                      label="Enabled for real runs"
                      checked={selected.enabled}
                      disabled={Boolean(busy)}
                      onChange={(enabled) => void persist({ ...selected, enabled }, 'enabled')}
                    />
                    <span>Enabled for real runs</span>
                  </div>
                </div>
              </SettingsRow>

              {!selected.builtInDemo && detailDraft ? (
                <>
                  <SettingsRow>
                    <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
                      <input className="h-8 rounded-md border border-border bg-background px-2 text-[10px] text-soft" value={detailDraft.name} onChange={(event) => setDetailDraft({ ...detailDraft, name: event.target.value })} placeholder="Name" />
                      <input className="h-8 rounded-md border border-border bg-background px-2 text-[10px] text-soft" value={detailDraft.version} onChange={(event) => setDetailDraft({ ...detailDraft, version: event.target.value })} placeholder="1.0.0" />
                      <input className="col-span-2 h-8 rounded-md border border-border bg-background px-2 text-[10px] text-soft" value={detailDraft.description} onChange={(event) => setDetailDraft({ ...detailDraft, description: event.target.value })} placeholder="Description" />
                      <textarea className="col-span-2 min-h-20 rounded-md border border-border bg-background px-2 py-2 text-[10px] leading-4 text-soft" value={detailDraft.instructions} onChange={(event) => setDetailDraft({ ...detailDraft, instructions: event.target.value })} placeholder="Portable instructions delivered when this extension route is active." />
                    </div>
                    <SettingsButton disabled={Boolean(busy)} onClick={saveDetails}>Save details</SettingsButton>
                  </SettingsRow>
                  {selected.surface === 'mcp' || selected.surface === 'plugin' ? (
                    <SettingsRow>
                      <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
                        <div className="col-span-2">
                          <strong className={rowTitle}>MCP stdio transport</strong>
                          <p className={rowDesc}>Optional executable transport. ND stores command/arguments and environment-variable names only; secret values remain in the parent environment.</p>
                        </div>
                        <input className="col-span-2 h-8 rounded-md border border-border bg-background px-2 font-mono text-[10px] text-soft" value={detailDraft.runtimeCommand} onChange={(event) => setDetailDraft({ ...detailDraft, runtimeCommand: event.target.value })} placeholder="MCP command, e.g. npx" />
                        <textarea className="min-h-24 rounded-md border border-border bg-background px-2 py-2 font-mono text-[10px] leading-4 text-soft" value={detailDraft.runtimeArgs} onChange={(event) => setDetailDraft({ ...detailDraft, runtimeArgs: event.target.value })} placeholder={'One argument per line\n-y\n@modelcontextprotocol/server-filesystem\n/workspace'} />
                        <textarea className="min-h-24 rounded-md border border-border bg-background px-2 py-2 font-mono text-[10px] leading-4 text-soft" value={detailDraft.runtimeEnvRefs} onChange={(event) => setDetailDraft({ ...detailDraft, runtimeEnvRefs: event.target.value })} placeholder={'Environment references\nGITHUB_TOKEN=GITHUB_TOKEN'} />
                      </div>
                    </SettingsRow>
                  ) : null}
                </>
              ) : selected.instructions ? (
                <SettingsRow>
                  <div className={rowStack}>
                    <strong className={rowTitle}>Portable runtime instructions</strong>
                    <span className={rowDesc}>{selected.instructions}</span>
                  </div>
                </SettingsRow>
              ) : null}

              {selected.demoPrompt ? (
                <SettingsRow>
                  <div className={rowStack}>
                    <strong className={rowTitle}>Pre-built demo prompt</strong>
                    <span className={rowDesc}>The demo runner is deterministic and account-free; enable this extension only when you want its instructions in real agent runs.</span>
                    <code className={rowPathText}>{selected.demoPrompt}</code>
                  </div>
                </SettingsRow>
              ) : null}
            </SettingsSection>

            {selected.builtInDemo ? (
              <SettingsSection title="Run demo">
                <SettingsRow>
                  <div className={rowStack}>
                    <strong className={rowTitle}>Counter route smoke test</strong>
                    <span className={rowDesc}>Exercises this surface through the same compatibility resolver used by real runs. It does not require provider credentials.</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <select className="h-7 rounded-md border border-border bg-background px-2 text-[10px] text-soft" value={demoEngineId} onChange={(event) => setDemoEngineId(event.target.value)}>
                      {engines.map((engine) => <option key={engine.id} value={engine.id}>{engine.name}{engine.available ? '' : ' (unavailable)'}</option>)}
                    </select>
                    <select className="h-7 rounded-md border border-border bg-background px-2 text-[10px] text-soft" value={demoProviderId} onChange={(event) => setDemoProviderId(event.target.value)}>
                      <option value="">Engine-native provider</option>
                      {providers.filter((provider) => provider.enabled).map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                    </select>
                    <SettingsButton disabled={Boolean(busy) || !demoEngineId} onClick={() => void runDemo()}>Run demo</SettingsButton>
                  </div>
                </SettingsRow>
                {demoResult ? (
                  <SettingsRow>
                    <div className={rowStack}>
                      <div className="flex items-center gap-2">
                        <strong className={rowTitle}>{demoResult.summary}</strong>
                        <StatusChip good={demoResult.supported} warn={!demoResult.supported}>{demoResult.adapter}</StatusChip>
                      </div>
                      {demoResult.steps.map((step, index) => <code key={`${index}-${step}`} className={rowPathText}>{index + 1}. {step}</code>)}
                    </div>
                  </SettingsRow>
                ) : null}
              </SettingsSection>
            ) : null}
            </>
            ) : null}

            {isRouting ? (
            <>
            <SettingsSection title="Extension">
              <SettingsRow>
                <div className={rowStack}>
                  <div className="flex items-center gap-2">
                    <strong className={rowTitle}>{selected.name}</strong>
                    {selected.builtInDemo ? <StatusChip good>Built-in</StatusChip> : <StatusChip>Custom</StatusChip>}
                  </div>
                  <span className={rowDesc}>{selected.description}</span>
                  <code className={rowPathText}>{selected.id}</code>
                </div>
              </SettingsRow>
            </SettingsSection>

            <SettingsSection title="Coding engine routes">
              <div className="space-y-1.5">
                {engines.map((engine) => {
                  const route = resolveExtensionRoute({ ...selected, enabled: true }, engine)
                  const configured = selected.engineRoutes.find((item) => item.engineId === engine.id)?.adapter ?? 'auto'
                  return (
                    <SettingsRow key={engine.id}>
                      <div className={rowStack}>
                        <strong className={rowTitle}>{engine.name}</strong>
                        <span className={rowDesc}>{route.reason}</span>
                        <span className={rowPathText}>{engine.id} → {route.adapter}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusChip good={route.supported} warn={!route.supported}>{route.supported ? 'Routed' : 'Off'}</StatusChip>
                        <select
                          className="h-7 rounded-md border border-border bg-background px-2 text-[10px] text-soft"
                          value={configured}
                          disabled={Boolean(busy)}
                          onChange={(event) => setEngineRoute(selected, engine.id, event.target.value as ExtensionAdapter)}
                        >
                          {EXTENSION_ADAPTERS.map((adapter) => <option key={adapter} value={adapter}>{adapter}</option>)}
                        </select>
                      </div>
                    </SettingsRow>
                  )
                })}
                {engines.length === 0 ? <SettingsRow><span className={rowDesc}>No coding engines detected.</span></SettingsRow> : null}
              </div>
            </SettingsSection>

            <SettingsSection title="Model provider scope">
              <SettingsRow>
                <div className={rowStack}>
                  <strong className={rowTitle}>Provider routing</strong>
                  <span className={rowDesc}>Engine routing controls execution. Provider scope independently controls whether portable prompt/context delivery may reach DeepSeek, OpenAI, Anthropic, Gemini, local, or future model routes.</span>
                </div>
                <SettingsButton disabled={Boolean(busy)} onClick={() => allowAllProviders(selected)}>Allow all</SettingsButton>
              </SettingsRow>
              <div className="space-y-1.5">
                {providers.map((provider) => {
                  const explicit = selected.providerRoutes.find((route) => route.providerId === provider.id)
                  const checked = selected.providerRoutes.length === 0 ? provider.enabled : explicit?.enabled === true
                  return (
                    <SettingsRow key={provider.id}>
                      <div className={rowStack}>
                        <strong className={rowTitle}>{provider.name}</strong>
                        <span className={rowPathText}>{provider.id}</span>
                      </div>
                      <label className="flex items-center gap-2 text-[10px] text-soft">
                        <input type="checkbox" checked={checked} disabled={!provider.enabled || Boolean(busy)} onChange={(event) => toggleProvider(selected, provider.id, event.target.checked)} />
                        {provider.enabled ? 'Allowed' : 'Provider disabled'}
                      </label>
                    </SettingsRow>
                  )
                })}
              </div>
            </SettingsSection>
            </>
            ) : null}

            {!isRouting ? (
            <div className="mt-5 flex justify-end">
              <SettingsButton disabled={Boolean(busy)} onClick={() => void reset()}>Reset demo pack</SettingsButton>
            </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  )
}

function CatalogSection({ title, count, className, children }: { title: string; count: number; className?: string; children: ReactNode }) {
  return (
    <section className={className}>
      <div className="mb-3 flex items-center gap-1.5">
        <h3 className="m-0 text-[12px] font-semibold text-strong">{title}</h3>
        <span className="text-[9px] text-faint">{count}</span>
      </div>
      {children}
    </section>
  )
}

function ExtensionCatalogRow({
  extension,
  selected,
  busy,
  icon: Icon,
  last,
  onSelect,
  onToggle,
}: {
  extension: AgentExtensionManifest
  selected: boolean
  busy: boolean
  icon: LucideIcon
  last: boolean
  onSelect(): void
  onToggle(enabled: boolean): void
}) {
  return (
    <div className={cn('flex min-h-[64px] items-center gap-3 px-4 transition-colors', !last && 'border-b border-border-soft', selected && 'bg-secondary/45')}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left" onClick={onSelect}>
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-secondary text-soft">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <strong className="truncate text-[12px] font-medium text-strong">{extension.name}</strong>
            <span className="text-[9px] text-faint">v{extension.version}</span>
          </span>
          <span className="mt-0.5 block truncate text-[10px] text-faint">{extension.description}</span>
        </span>
      </button>
      <ToggleSwitch
        label={`Toggle ${extension.name}`}
        checked={extension.enabled}
        disabled={busy}
        onChange={onToggle}
      />
    </div>
  )
}

function ToggleSwitch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange(checked: boolean): void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      className={cn(
        'relative h-[20px] w-[34px] shrink-0 rounded-full border transition-colors disabled:opacity-50',
        checked ? 'border-primary bg-primary' : 'border-border-strong bg-secondary',
      )}
      onClick={() => onChange(!checked)}
    >
      <span className={cn('absolute top-[2px] size-[14px] rounded-full bg-background shadow-sm transition-[left]', checked ? 'left-[16px]' : 'left-[2px]')} />
    </button>
  )
}

function singularSurface(surface: AgentExtensionSurface): string {
  if (surface === 'mcp') return 'MCP Server'
  if (surface === 'memory') return 'Memory'
  return SURFACE_LABEL[surface].replace(/s$/, '')
}

function parseRuntime(draft: DetailDraft): AgentExtensionManifest['runtime'] {
  const command = draft.runtimeCommand.trim()
  if (!command) return undefined
  const args = draft.runtimeArgs.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
  const env: Record<string, string> = {}
  for (const raw of draft.runtimeEnvRefs.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const separator = raw.indexOf('=')
    if (separator <= 0 || separator === raw.length - 1) throw new Error(`Invalid environment reference: ${raw}`)
    const target = raw.slice(0, separator).trim()
    const source = raw.slice(separator + 1).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(source)) {
      throw new Error(`Environment references must use VARIABLE=SOURCE_VARIABLE: ${raw}`)
    }
    env[target] = source
  }
  return { kind: 'mcp-stdio', command, args, env }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
