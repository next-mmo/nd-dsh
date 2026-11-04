import { useEffect, useMemo, useRef, useState } from 'react'
import type { BrowserPlatformState, BrowserProfileSummary } from '../../../shared/browser-platform'
import {
  isRouterWebProviderKind,
  type RouterAgyState,
  type RouterPlaygroundEvent,
  type RouterPlaygroundMessage,
  type RouterPlaygroundRoute,
  type RouterProviderView,
  type RouterState,
} from '../../../shared/router'
import { openSkillPicker, parseSkillCatalog, type SkillSuggestion } from '../../../shared/skill-catalog'
import { splitAssistantSegments } from '../../../shared/structured-output'
import { cn } from '../lib/utils'
import {
  ArrowUpIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  LogsIcon,
  SparkIcon,
  SpinnerIcon,
  StopIcon,
  TerminalIcon,
  TrashIcon,
} from './Icons'
import { MarkdownLite } from './MarkdownLite'
import { ProcessLogsDrawer, formatLogTimestamp, type ProcessLogEntry } from './ProcessLogsDrawer'
import { RouterCurlDialog } from './RouterCurlDialog'
import {
  SettingsNote,
  SettingsRow,
  SettingsSection,
  StatusChip,
  rowDesc,
  rowValueText,
} from './settings-primitives'

export function isRouterPlaygroundProviderActive(
  provider: RouterProviderView,
  agyState?: RouterAgyState | null
): boolean {
  if (!provider.isActive) return false
  if (
    provider.kind === 'antigravity' &&
    agyState &&
    (!agyState.policy?.enabled || agyState.locked)
  ) {
    return false
  }
  return true
}

interface RouterPlaygroundProps {
  state: RouterState | null
  onError(message: string): void
  embedded?: boolean
  agyState?: RouterAgyState | null
}

interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

function extractThinkingAndSegments(text: string): Array<{ kind: 'reasoning' | 'text'; text: string }> {
  const thinkMatch = /<think>([\s\S]*?)(?:<\/think>|$)/gi
  const parts: Array<{ kind: 'reasoning' | 'text'; text: string }> = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = thinkMatch.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index)
      if (before.trim()) {
        parts.push({ kind: 'text', text: before })
      }
    }
    const thinkContent = match[1]?.trim()
    if (thinkContent) {
      parts.push({ kind: 'reasoning', text: thinkContent })
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    const after = text.slice(lastIndex)
    if (after.trim()) {
      parts.push({ kind: 'text', text: after })
    }
  }

  const toSegment = (s: ReturnType<typeof splitAssistantSegments>[number]): { kind: 'reasoning' | 'text'; text: string } => {
    if (s.kind === 'reasoning') return { kind: 'reasoning', text: s.text }
    if (s.kind === 'review') return { kind: 'text', text: `**Review Verdict: ${s.review.verdict.toUpperCase()}**\n\n${s.review.summary}` }
    if (s.kind === 'plan') return { kind: 'text', text: `**Project Plan: ${s.plan.goal?.title ?? ''}**` }
    return { kind: 'text', text: s.text }
  }

  if (parts.length === 0) {
    return splitAssistantSegments(text).map(toSegment)
  }

  return parts.flatMap((part) => {
    if (part.kind === 'reasoning') return [part]
    return splitAssistantSegments(part.text).map(toSegment)
  })
}

function ReasoningCard({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(streaming)
  const userToggled = useRef(false)
  useEffect(() => {
    if (!userToggled.current) setOpen(streaming)
  }, [streaming])
  const lines = text.split('\n').filter((line) => line.trim())
  const preview = (streaming ? lines.at(-1) : lines[0]) ?? ''
  return (
    <div className="mb-2">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-1.5 text-left text-[11px] font-medium text-faint transition-colors hover:text-soft"
        onClick={() => {
          userToggled.current = true
          setOpen((v) => !v)
        }}
      >
        <BrainIcon className="size-3.5 shrink-0 text-primary/70" />
        <span className="shrink-0 font-medium">{streaming ? 'Thinking' : 'Reasoning'}</span>
        {streaming ? <span className="inline-block animate-pulse">…</span> : null}
        <span className="min-w-0 max-w-[280px] truncate text-[9.5px] text-fainter">{preview}</span>
        <ChevronDownIcon className={cn('ml-0.5 size-2.5 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div className="mt-1 max-h-[220px] overflow-y-auto rounded-lg border border-border-soft bg-surface-1/90 px-2.5 py-2">
          <MarkdownLite text={text.trim() || 'Thinking…'} className="text-[11px] text-soft" />
        </div>
      ) : null}
    </div>
  )
}

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_600)
    } catch {
      // Ignore clipboard write denial
    }
  }
  return (
    <button
      type="button"
      className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium text-faint transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-[10px]"
      title="Copy message"
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  )
}

function safeRaf(cb: () => void): void {
  if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(cb)
  }
}

export function detectPlaygroundMention(
  value: string,
  caret: number
): { query: string; start: number; end: number; prefix: '/' | '@' } | null {
  if (caret <= 0 || caret > value.length) return null
  const end = caret
  let start = caret - 1
  while (start >= 0 && !/\s/.test(value[start] ?? '')) start -= 1
  start += 1
  if (start >= end) return null
  const marker = value[start]
  if (marker !== '/' && marker !== '@') return null
  if (start !== 0 && !/\s/.test(value[start - 1] ?? '')) return null
  const query = value.slice(start + 1, end)
  if (query.includes('/') || query.includes('@')) return null
  return { query, start, end, prefix: marker as '/' | '@' }
}

export function RouterPlayground({ state, onError, embedded = false, agyState }: RouterPlaygroundProps) {
  const [internalAgyState, setInternalAgyState] = useState<RouterAgyState | null>(agyState ?? null)

  useEffect(() => {
    if (agyState !== undefined) {
      setInternalAgyState(agyState)
      return
    }
    let alive = true
    window.ndDshRouter?.agyPolicy?.()
      .then((policy) => {
        if (alive && policy) setInternalAgyState(policy)
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [agyState])

  const activeProviders = useMemo(() => {
    return (state?.providers ?? []).filter((provider) => isRouterPlaygroundProviderActive(provider, internalAgyState))
  }, [state, internalAgyState])

  const [selectedProvider, setSelectedProvider] = useState('all')
  const [routeValue, setRouteValue] = useState('')
  const [input, setInput] = useState('')
  const [caret, setCaret] = useState(0)
  const [messages, setMessages] = useState<ChatTurn[]>([])
  const [pending, setPending] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [status, setStatus] = useState('Idle')
  const [error, setError] = useState<string | null>(null)
  const [resolved, setResolved] = useState<Pick<RouterPlaygroundEvent, 'combo' | 'provider' | 'model' | 'latencyMs'> | null>(null)
  const [browserPlatform, setBrowserPlatform] = useState<BrowserPlatformState | null>(null)
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview')
  const [skills, setSkills] = useState<SkillSuggestion[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const activeRef = useRef<string | null>(null)
  const startedAtRef = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const inFlightSkillsRef = useRef<Promise<SkillSuggestion[]> | null>(null)
  const [logsOpen, setLogsOpen] = useState(false)
  const [curlOpen, setCurlOpen] = useState(false)
  const [logs, setLogs] = useState<ProcessLogEntry[]>([])
  const firstTokenRef = useRef(false)

  const addLog = (entry: Omit<ProcessLogEntry, 'id' | 'timestamp' | 'time'>) => {
    const item: ProcessLogEntry = {
      id: crypto.randomUUID(),
      timestamp: formatLogTimestamp(),
      time: Date.now(),
      ...entry,
    }
    setLogs((prev) => [...prev, item].slice(-1000))
  }

  const loadSkills = async (force = false): Promise<SkillSuggestion[]> => {
    if (!force && skills.length > 0) return skills
    if (inFlightSkillsRef.current) return inFlightSkillsRef.current
    if (!window.ndDsh?.skills) return []
    setSkillsLoading(true)
    const promise = window.ndDsh.skills.catalog(null)
      .then((res) => {
        const parsed = parseSkillCatalog(res)
        setSkills(parsed)
        return parsed
      })
      .catch((cause) => {
        console.error('Failed to load skills catalog in RouterPlayground:', cause)
        return []
      })
      .finally(() => {
        inFlightSkillsRef.current = null
        setSkillsLoading(false)
      })
    inFlightSkillsRef.current = promise
    return promise
  }

  useEffect(() => {
    void loadSkills()
  }, [])

  const mentionTrigger = useMemo(() => {
    const trigger = detectPlaygroundMention(input, caret)
    if (!trigger) return null
    if (mentionDismissed && input.slice(trigger.start, trigger.end) === mentionDismissed) return null
    return trigger
  }, [input, caret, mentionDismissed])

  const filteredSkills = useMemo(() => {
    if (!mentionTrigger) return []
    const needle = mentionTrigger.query.toLowerCase()
    if (!needle) return skills
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(needle) ||
        (s.displayName && s.displayName.toLowerCase().includes(needle)) ||
        s.description.toLowerCase().includes(needle)
    )
  }, [mentionTrigger, skills])

  const activeSkill = useMemo(() => {
    const leadingMatch = /^\s*[/@]([a-zA-Z0-9][a-zA-Z0-9:_-]{0,127})(?:\s|$)/.exec(input)
    if (leadingMatch) {
      const found = skills.find((s) => s.name === leadingMatch[1])
      if (found) return found
    }
    const anyMatch = /(?:^|\s)[/@]([a-zA-Z0-9][a-zA-Z0-9:_-]{0,127})(?=\s|$)/.exec(input)
    if (anyMatch) {
      const found = skills.find((s) => s.name === anyMatch[1])
      if (found) return found
    }
    return null
  }, [input, skills])

  const selectSkill = (skill: SkillSuggestion) => {
    if (mentionTrigger) {
      const prefix = mentionTrigger.prefix ?? '/'
      const insertToken = `${prefix}${skill.name}`
      const rest = input.slice(mentionTrigger.end)
      const trailingRest = rest.startsWith(' ') ? rest.slice(1) : rest
      const insert = `${insertToken} `
      const applied = input.slice(0, mentionTrigger.start) + insert + trailingRest
      setInput(applied)
      setCaret(mentionTrigger.start + insert.length)
    } else {
      const next = openSkillPicker(input)
      const applied = `${next.value.slice(0, 1)}${skill.name} ${next.value.slice(next.caret)}`
      setInput(applied)
      setCaret(skill.name.length + 2)
    }
    setMentionDismissed(null)
    setMentionIndex(0)
    safeRaf(() => {
      textareaRef.current?.focus()
    })
  }

  const handleOpenSkills = () => {
    void loadSkills(skills.length === 0)
    const next = openSkillPicker(input)
    setInput(next.value)
    setCaret(next.caret)
    setMentionDismissed(null)
    setMentionIndex(0)
    safeRaf(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(next.caret, next.caret)
    })
  }

  const autosizeComposer = (): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  useEffect(() => {
    autosizeComposer()
  }, [input])

  useEffect(() => {
    const el = textareaRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let width = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      autosizeComposer()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!window.ndDsh?.browserPlatform) return
    let mounted = true
    void window.ndDsh.browserPlatform.state().then((platformState) => {
      if (mounted) setBrowserPlatform(platformState)
    }).catch(() => undefined)
    const dispose = window.ndDsh.browserPlatform.onChanged((platformState) => {
      if (mounted) setBrowserPlatform(platformState)
    })
    return () => {
      mounted = false
      dispose?.()
    }
  }, [])

  const profiles: BrowserProfileSummary[] = useMemo(() => {
    return browserPlatform?.profiles ?? []
  }, [browserPlatform])

  const activeProfileId = useMemo(() => {
    return profiles.find((p) => p.active)?.id ?? profiles.find((p) => p.isDefault)?.id ?? profiles[0]?.id ?? ''
  }, [profiles])

  const switchProfile = async (profileId: string) => {
    if (!profileId || profileId === activeProfileId || !window.ndDsh?.browserPlatform) return
    try {
      const updated = await window.ndDsh.browserPlatform.selectProfile(profileId)
      setBrowserPlatform(updated)
      addLog({
        level: 'info',
        title: `Browser profile switched: ${profileId}`,
      })
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const handleOpenLink = (url: string) => {
    if (window.ndDsh?.browserPlatform) {
      void window.ndDsh.browserPlatform.createTab('builtin', url).catch(() => {
        window.open(url, '_blank')
      })
    } else {
      window.open(url, '_blank')
    }
  }

  const options = useMemo(() => {
    const combos = (state?.combos ?? []).map((combo) => ({
      value: `combo:${combo.name}`,
      label: combo.hiddenFromChat ? `${combo.name} · Private` : combo.name,
      shortLabel: combo.hiddenFromChat ? `${combo.name} · Private` : combo.name,
      group: 'combos' as const,
    }))
    const models = activeProviders.flatMap((provider) =>
      provider.models.map((model) => ({
        value: `model:${provider.id}/${model}`,
        label: `${provider.name} / ${model}${isRouterWebProviderKind(provider.kind) ? ' · Web' : ''}`,
        shortLabel: model,
        providerId: provider.id,
        group: 'model' as const,
      }))
    )
    return { combos, models }
  }, [state, activeProviders])

  const filteredOptions = useMemo(() => {
    if (selectedProvider === 'combos') {
      return options.combos.map((c) => ({ value: c.value, label: c.shortLabel }))
    }
    if (selectedProvider.startsWith('provider:')) {
      const providerId = selectedProvider.slice('provider:'.length)
      return options.models
        .filter((m) => m.providerId === providerId)
        .map((m) => ({ value: m.value, label: m.shortLabel }))
    }
    return [
      ...options.combos.map((c) => ({ value: c.value, label: c.label })),
      ...options.models.map((m) => ({ value: m.value, label: m.label })),
    ]
  }, [options, selectedProvider])

  useEffect(() => {
    if (selectedProvider === 'all' || selectedProvider === 'combos') return
    const providerId = selectedProvider.startsWith('provider:') ? selectedProvider.slice('provider:'.length) : selectedProvider
    const exists = activeProviders.some((p) => p.id === providerId)
    if (!exists) setSelectedProvider('all')
  }, [activeProviders, selectedProvider])

  const activeRoute = useMemo(() => {
    if (routeValue && filteredOptions.some((option) => option.value === routeValue)) {
      return routeValue
    }
    return filteredOptions[0]?.value ?? ''
  }, [filteredOptions, routeValue])

  const isWebRelated = useMemo(() => {
    if (selectedProvider.startsWith('provider:')) {
      const providerId = selectedProvider.slice('provider:'.length)
      const provider = activeProviders.find((p) => p.id === providerId)
      if (provider && isRouterWebProviderKind(provider.kind)) return true
    }
    if (activeRoute.startsWith('model:')) {
      const target = activeRoute.slice('model:'.length)
      const slash = target.indexOf('/')
      const providerId = slash > 0 ? target.slice(0, slash) : ''
      const provider = activeProviders.find((p) => p.id === providerId)
      if (provider && isRouterWebProviderKind(provider.kind)) return true
      if (isRouterWebProviderKind(providerId)) return true
    }
    if (activeRoute.startsWith('combo:')) {
      const comboName = activeRoute.slice('combo:'.length).trim()
      const combo = state?.combos.find((c) => c.name === comboName)
      if (combo) {
        const usesWeb = combo.models.some((entry) => {
          const provider = activeProviders.find((p) => p.id === entry.providerId)
          return (provider && isRouterWebProviderKind(provider.kind)) || isRouterWebProviderKind(entry.providerId)
        })
        if (usesWeb) return true
      }
      if (comboName.toLowerCase().includes('web')) return true
    }
    return false
  }, [state, selectedProvider, activeRoute, activeProviders])

  useEffect(() => {
    const dispose = window.ndDshRouter.onPlaygroundEvent((event) => {
      if (!activeRef.current || event.requestId !== activeRef.current) return
      if (event.type === 'phase') {
        setStatus(event.phase === 'streaming' ? 'Streaming…' : event.phase === 'waiting' ? 'Waiting for reply…' : 'Connecting…')
        setElapsed(Date.now() - startedAtRef.current)
        addLog({
          level: 'phase',
          title: `Phase: ${event.phase}`,
          durationMs: Date.now() - startedAtRef.current,
          detail: `Router transitioned to ${event.phase} phase`,
        })
        return
      }
      if (event.type === 'delta') {
        setPending((current) => `${current ?? ''}${event.delta ?? ''}`)
        setElapsed(Date.now() - startedAtRef.current)
        if (!firstTokenRef.current) {
          firstTokenRef.current = true
          addLog({
            level: 'stream',
            title: `Streaming delta started (TTFT: ${Date.now() - startedAtRef.current}ms)`,
            durationMs: Date.now() - startedAtRef.current,
          })
        }
        return
      }
      if (event.type === 'done') {
        const text = event.text ?? ''
        setMessages((current) => [...current, { role: 'assistant', content: text }])
        setPending(null)
        setRunning(false)
        setStatus('Done')
        const latency = event.latencyMs ?? Date.now() - startedAtRef.current
        setElapsed(latency)
        setResolved({
          ...(event.combo ? { combo: event.combo } : {}),
          ...(event.provider ? { provider: event.provider } : {}),
          ...(event.model ? { model: event.model } : {}),
          latencyMs: latency,
        })
        addLog({
          level: 'success',
          title: `Response completed in ${latency}ms`,
          subtitle: `${event.provider ?? 'unknown'} · ${event.model ?? 'unknown'}${event.combo ? ` · route ${event.combo}` : ''}`,
          durationMs: latency,
          detail: text ? `${text.length} chars generated` : undefined,
          payload: {
            combo: event.combo,
            provider: event.provider,
            model: event.model,
            latencyMs: latency,
            status: event.status,
            textLength: text.length,
          },
        })
        activeRef.current = null
        return
      }
      setError(event.error ?? 'Playground request failed')
      setStatus('Failed')
      setRunning(false)
      setPending(null)
      addLog({
        level: 'error',
        title: `Playground request failed: ${event.error ?? 'Unknown error'}`,
        subtitle: event.code,
        durationMs: startedAtRef.current ? Date.now() - startedAtRef.current : undefined,
        detail: event.error,
        payload: event,
      })
      activeRef.current = null
    })
    return () => {
      dispose()
      const active = activeRef.current
      if (active) void window.ndDshRouter.playgroundStop(active).catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAtRef.current), 100)
    return () => window.clearInterval(timer)
  }, [running])

  const parseRoute = (value: string): RouterPlaygroundRoute | null => {
    if (value.startsWith('combo:')) {
      const combo = value.slice('combo:'.length).trim()
      return combo ? { kind: 'combo', combo } : null
    }
    if (value.startsWith('model:')) {
      const target = value.slice('model:'.length)
      const slash = target.indexOf('/')
      if (slash <= 0 || slash === target.length - 1) return null
      return { kind: 'model', providerId: target.slice(0, slash), model: target.slice(slash + 1) }
    }
    return null
  }

  const send = async (): Promise<void> => {
    if (running) return
    const text = input.trim()
    if (!text) return
    const route = parseRoute(activeRoute)
    if (!route) {
      onError('Choose a route before sending.')
      return
    }

    let promptToSend = text
    let targetSkillName: string | null = null
    let userTask = text

    const leadingSkillMatch = /^\s*[/@]([a-zA-Z0-9][a-zA-Z0-9:_-]{0,127})(?:\s+([\s\S]*)|$)/.exec(text)
    if (leadingSkillMatch && leadingSkillMatch[1]) {
      targetSkillName = leadingSkillMatch[1]
      userTask = leadingSkillMatch[2]?.trim() ?? ''
    } else {
      const anySkillMatch = /(?:^|\s)[/@]([a-zA-Z0-9][a-zA-Z0-9:_-]{0,127})(?=\s|$)/.exec(text)
      if (anySkillMatch && anySkillMatch[1]) {
        targetSkillName = anySkillMatch[1]
        userTask = text.replace(new RegExp(`(^|\\s)[/@]${targetSkillName}(?=\\s|$)`, 'g'), ' ').replace(/\s+/g, ' ').trim()
      }
    }

    if (targetSkillName && window.ndDsh?.skills) {
      try {
        const catalog = skills.length > 0 ? skills : await loadSkills()
        const skill = catalog.find((s) => s.name === targetSkillName)
        if (skill?.selectionId) {
          const detail = await window.ndDsh.skills.detail(skill.selectionId)
          if (detail?.markdown) {
            promptToSend = `${detail.markdown.trim()}\n\nApply the instructions above to the request below. Do not create, save, edit, or describe a skill; complete the task and return only the requested output.\nRequest:\n${userTask || text}`
          }
        }
      } catch {
        // Fallback to verbatim prompt if skill details fail
      }
    }

    const requestId = crypto.randomUUID()
    const userTurn: ChatTurn = { role: 'user', content: text }
    const outbound: RouterPlaygroundMessage[] = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: promptToSend },
    ]
    activeRef.current = requestId
    startedAtRef.current = Date.now()
    firstTokenRef.current = false
    addLog({
      level: 'info',
      title: `Request initiated: ${activeRoute}`,
      subtitle: `ID: ${requestId.slice(0, 8)}`,
      detail: promptToSend,
      payload: { route, messagesCount: outbound.length, stream: true },
    })
    if (targetSkillName) {
      addLog({
        level: 'info',
        title: `Skill injected: ${targetSkillName}`,
        detail: `Applied instructions for skill: ${targetSkillName}`,
      })
    }
    setMessages((current) => [...current, userTurn])
    setInput('')
    setCaret(0)
    setPending('')
    setRunning(true)
    setElapsed(0)
    setError(null)
    setResolved(null)
    setStatus('Connecting…')
    safeRaf(() => {
      textareaRef.current?.focus()
    })
    void window.ndDshRouter.playgroundStart({ requestId, route, messages: outbound, stream: true })
      .catch((cause) => {
        activeRef.current = null
        setRunning(false)
        setPending(null)
        setStatus('Failed')
        const failure = message(cause)
        setError(failure)
        onError(failure)
        addLog({
          level: 'error',
          title: `Playground connection failed: ${failure}`,
          detail: failure,
        })
      })
  }

  const stop = (): void => {
    const active = activeRef.current
    if (!active) return
    void window.ndDshRouter.playgroundStop(active).catch((cause) => onError(message(cause)))
    addLog({
      level: 'warn',
      title: 'Request stopped by user',
      durationMs: startedAtRef.current ? Date.now() - startedAtRef.current : undefined,
    })
    const partial = pending
    if (partial) setMessages((current) => [...current, { role: 'assistant', content: partial }])
    setPending(null)
    setRunning(false)
    setStatus('Stopped')
    activeRef.current = null
  }

  const clear = (): void => {
    if (running) stop()
    setMessages([])
    setPending(null)
    setError(null)
    setResolved(null)
    setStatus('Idle')
    setElapsed(0)
    setMentionDismissed(null)
  }

  const busy = running || status === 'Connecting…' || status === 'Waiting for reply…' || status === 'Streaming…'

  const content = (
    <div className={cn('relative flex min-h-0 flex-1 flex-row overflow-hidden gap-2', embedded ? 'h-full' : 'mt-2')}>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      {/* 1. Compact Sleek Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 rounded-lg border border-border-soft bg-surface-1 px-3 py-1.5 text-xs shadow-xs">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {/* Filter Provider */}
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] font-medium text-faint">Provider:</span>
            <select
              aria-label="Filter provider"
              className="h-7 max-w-[150px] rounded border border-border-soft bg-background px-2 text-[11px] text-foreground outline-none transition-colors focus:border-primary"
              value={selectedProvider}
              disabled={busy}
              onChange={(event) => setSelectedProvider(event.target.value)}
            >
              <option value="all">All providers</option>
              {(state?.combos?.length ?? 0) > 0 ? <option value="combos">Route combos</option> : null}
              {activeProviders.map((provider) => (
                <option key={provider.id} value={`provider:${provider.id}`}>
                  {`${provider.name}${isRouterWebProviderKind(provider.kind) ? ' · Web' : ''}`}
                </option>
              ))}
            </select>
          </div>

          {/* Route selector */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:max-w-[340px]">
            <span className="text-[10px] font-medium text-faint shrink-0">Route:</span>
            <select
              aria-label="Playground route"
              className="h-7 w-full min-w-[140px] rounded border border-border-soft bg-background px-2 text-[11px] font-medium text-foreground outline-none transition-colors focus:border-primary"
              value={activeRoute}
              disabled={busy}
              onChange={(event) => setRouteValue(event.target.value)}
            >
              {filteredOptions.length === 0 ? <option value="">No routes yet</option> : null}
              {filteredOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {/* Browser profile (when web route) */}
          {isWebRelated && (
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[10px] font-medium text-faint">Profile:</span>
              <select
                aria-label="Browser profile"
                className="h-7 max-w-[150px] rounded border border-border-soft bg-background px-2 text-[11px] text-foreground outline-none transition-colors focus:border-primary"
                value={activeProfileId}
                disabled={busy || profiles.length === 0}
                onChange={(event) => void switchProfile(event.target.value)}
                title="Browser profile used for ChatGPT Web, Gemini Web, and DeepSeek Web"
              >
                {profiles.length === 0 ? <option value="">Default profile</option> : null}
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {`${profile.name}${profile.isDefault ? ' (Default)' : ''}`}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Right side actions */}
        <div className="flex shrink-0 items-center gap-2">
          {busy ? (
            <span className="flex items-center gap-1 text-[10px] font-mono text-faint">
              <SpinnerIcon className="size-2.5 animate-spin text-primary" />
              {elapsed} ms
            </span>
          ) : resolved ? (
            <span className="hidden text-[9.5px] text-faint lg:inline" title={`${resolved.provider ?? ''} · ${resolved.model ?? ''}`}>
              {resolved.latencyMs ?? elapsed} ms
            </span>
          ) : null}

          <div className="flex items-center rounded border border-border-soft bg-background p-0.5">
            <button
              type="button"
              aria-label="Preview mode"
              className={cn(
                'cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                viewMode === 'preview'
                  ? 'bg-accent font-semibold text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setViewMode('preview')}
            >
              Preview
            </button>
            <button
              type="button"
              aria-label="Raw mode"
              className={cn(
                'cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                viewMode === 'raw'
                  ? 'bg-accent font-semibold text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setViewMode('raw')}
            >
              Raw
            </button>
          </div>

          <button
            type="button"
            className="flex h-6 items-center gap-1 rounded border border-border-soft bg-background px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-95"
            onClick={() => setCurlOpen(true)}
            title="View and copy cURL command for this model"
            aria-label="View and copy cURL command"
          >
            <TerminalIcon className="size-2.5" />
            <span>cURL</span>
          </button>

          <button
            type="button"
            aria-pressed={logsOpen}
            className={cn(
              'flex h-6 items-center gap-1 rounded border px-2 text-[10px] font-medium transition-colors',
              logsOpen
                ? 'border-primary/40 bg-primary/10 text-primary font-semibold'
                : 'border-border-soft bg-background text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
            onClick={() => setLogsOpen((v) => !v)}
            title="Toggle process logs drawer"
            aria-label="Toggle process logs drawer"
          >
            <LogsIcon className="size-2.5" />
            <span>Logs</span>
            {logs.length > 0 ? (
              <span className="rounded-full bg-surface-2 px-1 text-[8.5px] font-mono text-faint">
                {logs.length}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            className="flex h-6 items-center gap-1 rounded border border-border-soft bg-background px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            disabled={messages.length === 0 && pending === null}
            onClick={clear}
            title="Clear conversation"
            aria-label="Clear conversation"
          >
            <TrashIcon className="size-2.5" />
            <span>Clear</span>
          </button>
        </div>
      </div>

      {/* 2. Messages / Content Area: flex-1 takes ALL available vertical height */}
      <div
        className={cn(
          'relative flex flex-1 min-h-0 flex-col overflow-y-auto rounded-lg border border-border-soft bg-surface-0/60 p-3',
          embedded ? 'min-h-[260px]' : 'min-h-[140px]'
        )}
      >
        {messages.length === 0 && pending === null ? (
          <div className="m-auto flex flex-col items-center justify-center gap-1.5 py-8 text-center text-faint">
            <div className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
              <SparkIcon className="size-4" />
            </div>
            <p className="text-xs font-semibold text-foreground">Playground Console</p>
            <p className="max-w-[400px] text-[11px] leading-relaxed text-muted-foreground">
              Send a prompt to test this route. Markdown formatting, code blocks, and reasoning preview are supported like ND chat.
            </p>
            <div className="mt-0.5 flex flex-wrap justify-center gap-1 text-[10px] text-fainter">
              <span>Type <code className="rounded bg-surface-2 px-1 text-[9.5px] text-soft">/</code> or <code className="rounded bg-surface-2 px-1 text-[9.5px] text-soft">@</code> to inject skills</span>
            </div>
          </div>
        ) : null}

        {viewMode === 'preview' ? (
          <div className="flex flex-col gap-2.5">
            {messages.map((turn, index) => {
              if (turn.role === 'user') {
                const skillMatch = /(?:^|\s)[/@]([a-zA-Z0-9][a-zA-Z0-9:_-]{0,127})/.exec(turn.content)
                return (
                  <div key={`${turn.role}-${index}`} className="flex justify-end">
                    <div className="group flex max-w-[85%] items-end gap-1.5">
                      <div className="opacity-0 transition-opacity group-hover:opacity-100">
                        <CopyMessageButton text={turn.content} />
                      </div>
                      <article className="rounded-2xl rounded-br-sm bg-info/[0.12] border border-info/25 px-3 py-1.5 shadow-xs">
                        <div className="whitespace-pre-wrap break-words text-[12px]/[1.55] text-foreground">
                          {skillMatch ? (
                            <>
                              <span className="mr-1.5 inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
                                <SparkIcon className="size-2.5" />
                                /{skillMatch[1]}
                              </span>
                              {turn.content.replace(new RegExp(`(^|\\s)[/@]${skillMatch[1]}(?=\\s|$)`), ' ').replace(/\s+/g, ' ').trim()}
                            </>
                          ) : (
                            turn.content
                          )}
                        </div>
                      </article>
                    </div>
                  </div>
                )
              }
              const segments = extractThinkingAndSegments(turn.content)
              return (
                <article key={`${turn.role}-${index}`} className="group flex items-start gap-2.5 rounded-lg border border-border-soft/80 bg-surface-1 p-2.5 shadow-xs">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary/15 text-primary [&_svg]:size-3">
                    <SparkIcon />
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-semibold text-foreground">Assistant</span>
                      <div className="opacity-0 transition-opacity group-hover:opacity-100">
                        <CopyMessageButton text={turn.content} />
                      </div>
                    </div>
                    <div className="text-[12px]/[1.6] text-soft">
                      {segments.map((segment, sIndex) => {
                        if (segment.kind === 'reasoning') {
                          return <ReasoningCard key={sIndex} text={segment.text} />
                        }
                        return <MarkdownLite key={sIndex} text={segment.text} onOpenLink={handleOpenLink} />
                      })}
                    </div>
                  </div>
                </article>
              )
            })}
            {pending !== null ? (
              <article className="group flex items-start gap-2.5 rounded-lg border border-border-soft/80 bg-surface-1 p-2.5 shadow-xs">
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary/15 text-primary [&_svg]:size-3">
                  <SparkIcon />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-foreground">Assistant</span>
                  </div>
                  <div className="text-[12px]/[1.6] text-soft">
                    {pending ? (
                      extractThinkingAndSegments(pending).map((segment, sIndex) => {
                        if (segment.kind === 'reasoning') {
                          return <ReasoningCard key={sIndex} text={segment.text} streaming={true} />
                        }
                        return <MarkdownLite key={sIndex} text={segment.text} onOpenLink={handleOpenLink} />
                      })
                    ) : (
                      <span className="text-faint">{status}</span>
                    )}
                    <span className="ml-0.5 inline-block h-[13px] w-1.5 animate-caret-blink bg-primary align-bottom" />
                  </div>
                </div>
              </article>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((turn, index) => (
              <div key={`${turn.role}-${index}`} className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{turn.role === 'user' ? 'You' : 'Assistant'}</span>
                  <CopyMessageButton text={turn.content} />
                </div>
                <span className="whitespace-pre-wrap font-mono text-[11px] leading-[1.5] text-soft">{turn.content}</span>
              </div>
            ))}
            {pending !== null ? (
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Assistant</span>
                <span className="whitespace-pre-wrap font-mono text-[11px] leading-[1.5] text-soft">{pending || (busy ? '…' : '')}</span>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* 3. Docked Compact Composer */}
      <div className="relative shrink-0 rounded-lg border border-border-soft bg-surface-1 p-2 shadow-xs transition-colors focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/20">
        {/* Mentions popup for skills */}
        {mentionTrigger ? (
          <div className="absolute inset-x-0 bottom-full z-30 mb-1.5 max-h-[220px] overflow-y-auto rounded-lg border border-border-strong bg-surface-1 p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.4)]">
            <div className="flex items-center justify-between px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-faint">
              <span>Inject Skill</span>
              {skillsLoading ? (
                <span className="flex items-center gap-1 font-normal lowercase tracking-normal text-fainter">
                  <SpinnerIcon className="size-2.5 animate-spin text-primary" /> Loading…
                </span>
              ) : (
                <span className="font-normal lowercase tracking-normal text-fainter">{filteredSkills.length} available</span>
              )}
            </div>
            {filteredSkills.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1 px-2 py-2 text-center text-xs text-faint">
                {skillsLoading ? (
                  <div className="flex items-center justify-center gap-1.5">
                    <SpinnerIcon className="size-3 animate-spin text-primary" />
                    <span>Loading skills…</span>
                  </div>
                ) : (
                  <>
                    <span>
                      {mentionTrigger.query
                        ? `No skills found matching "${mentionTrigger.query}"`
                        : 'No skills found'}
                    </span>
                    {skills.length === 0 ? (
                      <button
                        type="button"
                        className="cursor-pointer text-[10px] font-medium text-primary hover:underline"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          void loadSkills(true)
                        }}
                      >
                        Retry loading skills
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            ) : (
              filteredSkills.map((skill, index) => (
                <button
                  key={skill.name}
                  type="button"
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors',
                    index === mentionIndex ? 'bg-primary/15 text-foreground' : 'text-soft hover:bg-accent hover:text-foreground'
                  )}
                  onMouseEnter={() => setMentionIndex(index)}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    selectSkill(skill)
                  }}
                >
                  <span className="mt-0.5 grid size-3.5 shrink-0 place-items-center rounded bg-primary/20 text-primary [&_svg]:size-2">
                    <SparkIcon />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-foreground text-[11px]">
                        {mentionTrigger.prefix}{skill.displayName ?? skill.name}
                      </span>
                      {skill.source ? <span className="rounded bg-surface-2 px-1 py-px text-[8.5px] text-faint">{skill.source}</span> : null}
                    </div>
                    {skill.description ? (
                      <div className="truncate text-[9.5px] text-faint">{skill.description}</div>
                    ) : null}
                  </div>
                </button>
              ))
            )}
            <div className="mt-1 flex gap-3 border-t border-border-soft px-2 pt-1 text-[8.5px] text-fainter">
              <span>↑↓ navigate</span>
              <span>↵ insert</span>
              <span>esc dismiss</span>
            </div>
          </div>
        ) : null}

        {/* Active skill banner */}
        {activeSkill ? (
          <div className="mb-1.5 flex items-center justify-between gap-1.5 rounded border border-info/30 bg-info/10 px-2 py-0.5 text-xs text-foreground">
            <div className="flex min-w-0 items-center gap-1.5">
              <SparkIcon className="size-2.5 shrink-0 text-info" />
              <span className="font-semibold text-info text-[11px]">/{activeSkill.displayName ?? activeSkill.name}</span>
              <span className="truncate text-[10px] text-faint">{activeSkill.description}</span>
            </div>
            <button
              type="button"
              className="grid size-3.5 shrink-0 place-items-center rounded text-faint hover:bg-info/20 hover:text-foreground text-xs leading-none"
              title="Remove skill"
              onClick={() => {
                const tokenRegex = new RegExp(`(^|\\s)[/@]${activeSkill.name}(?=\\s|$)`, 'g')
                const cleaned = input.replace(tokenRegex, ' ').replace(/\s+/g, ' ').trim()
                setInput(cleaned)
                setCaret(cleaned.length)
              }}
            >
              ×
            </button>
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          aria-label="Playground prompt"
          value={input}
          disabled={busy}
          rows={1}
          placeholder="Ask or prompt this route — type / or @ to mention skills (Enter to send)"
          onChange={(event) => {
            setInput(event.target.value)
            setCaret(event.target.selectionStart ?? event.target.value.length)
          }}
          onClick={(event) => {
            const target = event.target as HTMLTextAreaElement
            setCaret(target.selectionStart ?? 0)
          }}
          onKeyUp={(event) => {
            const target = event.target as HTMLTextAreaElement
            setCaret(target.selectionStart ?? 0)
          }}
          onSelect={(event) => {
            const target = event.target as HTMLTextAreaElement
            setCaret(target.selectionStart ?? 0)
          }}
          onKeyDown={(event) => {
            if (mentionTrigger) {
              if (filteredSkills.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setMentionIndex((i) => (i + 1) % filteredSkills.length)
                  return
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setMentionIndex((i) => (i - 1 + filteredSkills.length) % filteredSkills.length)
                  return
                }
                if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
                  event.preventDefault()
                  const chosen = filteredSkills[mentionIndex] ?? filteredSkills[0]
                  if (chosen) selectSkill(chosen)
                  return
                }
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setMentionDismissed(input.slice(mentionTrigger.start, mentionTrigger.end))
                return
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void send()
            } else if (event.key === 'Escape' && busy) {
              event.preventDefault()
              stop()
            }
          }}
          className="max-h-[120px] w-full resize-none overflow-y-auto bg-transparent text-xs/[1.5] text-foreground outline-none placeholder:text-faint"
        />

        <div className="mt-1 flex items-center justify-between border-t border-border-soft/60 pt-1">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <button
              type="button"
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-soft hover:bg-accent hover:text-foreground transition-colors disabled:opacity-40 [&_svg]:size-2.5"
              title="Browse and inject available ND skills into this prompt"
              aria-label="Inject skill"
              onClick={handleOpenSkills}
              disabled={busy}
            >
              <SparkIcon className="text-primary" />
              <span>Skills</span>
            </button>

            <StatusChip good={status === 'Done'} warn={status === 'Failed'}>
              {status}
            </StatusChip>

            <span className="hidden text-[9.5px] text-fainter sm:inline">
              {busy ? `${elapsed} ms` : '↵ send · ⇧↵ newline · / or @ skills'}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {busy ? (
              <button
                type="button"
                className="grid size-6 shrink-0 place-items-center rounded bg-warning text-warning-foreground transition-[filter] hover:brightness-110 [&_svg]:size-3"
                onClick={stop}
                aria-label="Stop response"
                title="Stop response (Esc)"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                type="button"
                className="grid size-6 shrink-0 place-items-center rounded bg-primary text-primary-foreground transition-[filter] enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35 [&_svg]:size-3"
                disabled={busy || !input.trim() || !activeRoute}
                onClick={send}
                aria-label="Send prompt"
                title="Send (Enter)"
              >
                <ArrowUpIcon />
              </button>
            )}
          </div>
        </div>
      </div>

      {error ? <span className="text-[10px] text-warning">{error}</span> : null}
      {resolved ? (
        <span className="text-[9.5px] text-fainter">
          Answered by {resolved.provider ?? 'unknown'} · {resolved.model ?? 'unknown'} · {resolved.latencyMs ?? elapsed} ms
          {resolved.combo ? ` · route ${resolved.combo}` : ''}
        </span>
      ) : null}
      </div>

      <ProcessLogsDrawer
        open={logsOpen}
        onClose={() => setLogsOpen(false)}
        logs={logs}
        onClear={() => setLogs([])}
        busy={busy}
        title="Playground Logs"
        subtitle={activeRoute || undefined}
        onOpenCurl={() => setCurlOpen(true)}
      />

      <RouterCurlDialog
        open={curlOpen}
        onClose={() => setCurlOpen(false)}
        route={activeRoute}
        resolvedModel={resolved?.model}
        resolvedProvider={resolved?.provider}
        resolvedCombo={resolved?.combo}
        messages={messages}
        currentPrompt={input}
        endpoint={state?.endpoint}
        onError={onError}
      />
    </div>
  )
  return embedded ? content : <SettingsSection title="Playground">{content}</SettingsSection>
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
