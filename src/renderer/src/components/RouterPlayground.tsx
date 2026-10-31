import { useEffect, useMemo, useRef, useState } from 'react'
import type { BrowserPlatformState, BrowserProfileSummary } from '../../../shared/browser-platform'
import { applyMention, detectMentionTrigger } from '../../../shared/mentions'
import {
  isRouterWebProviderKind,
  type RouterPlaygroundEvent,
  type RouterPlaygroundMessage,
  type RouterPlaygroundRoute,
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
  SparkIcon,
  SpinnerIcon,
  StopIcon,
  TrashIcon,
} from './Icons'
import { MarkdownLite } from './MarkdownLite'
import {
  SettingsNote,
  SettingsRow,
  SettingsSection,
  StatusChip,
  rowDesc,
  rowValueText,
} from './settings-primitives'

interface RouterPlaygroundProps {
  state: RouterState | null
  onError(message: string): void
  embedded?: boolean
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

export function RouterPlayground({ state, onError, embedded = false }: RouterPlaygroundProps) {
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
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const activeRef = useRef<string | null>(null)
  const startedAtRef = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const loadSkills = async (): Promise<SkillSuggestion[]> => {
    if (skills.length > 0) return skills
    if (!window.ndDsh?.skills) return []
    try {
      const res = await window.ndDsh.skills.catalog(null)
      const parsed = parseSkillCatalog(res)
      setSkills(parsed)
      return parsed
    } catch {
      return []
    }
  }

  useEffect(() => {
    void loadSkills()
  }, [])

  const mentionTrigger = useMemo(() => {
    const trigger = detectMentionTrigger(input, caret)
    if (!trigger || trigger.kind !== 'skill') return null
    if (mentionDismissed && input.slice(trigger.start, trigger.end) === mentionDismissed) return null
    return trigger
  }, [input, caret, mentionDismissed])

  const filteredSkills = useMemo(() => {
    if (!mentionTrigger) return []
    const needle = mentionTrigger.query.toLowerCase()
    return skills
      .filter((s) => s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle))
      .slice(0, 8)
  }, [mentionTrigger, skills])

  const activeSkill = useMemo(() => {
    const trimmed = input.trimStart()
    if (!trimmed.startsWith('/')) return null
    const firstWord = trimmed.slice(1).split(/\s/)[0]
    if (!firstWord) return null
    return skills.find((s) => s.name === firstWord) ?? null
  }, [input, skills])

  const selectSkill = (skill: SkillSuggestion) => {
    if (mentionTrigger) {
      const next = applyMention(input, mentionTrigger, `/${skill.name}`)
      setInput(next.value)
      setCaret(next.caret)
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
    const next = openSkillPicker(input)
    setInput(next.value)
    setCaret(next.caret)
    setMentionDismissed(null)
    setMentionIndex(0)
    void loadSkills()
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
    const models = (state?.providers ?? []).flatMap((provider) =>
      provider.models.map((model) => ({
        value: `model:${provider.id}/${model}`,
        label: `${provider.name} / ${model}${isRouterWebProviderKind(provider.kind) ? ' · Web' : ''}`,
        shortLabel: model,
        providerId: provider.id,
        group: 'model' as const,
      }))
    )
    return { combos, models }
  }, [state])

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
    const exists = (state?.providers ?? []).some((p) => p.id === providerId)
    if (!exists) setSelectedProvider('all')
  }, [state, selectedProvider])

  const activeRoute = useMemo(() => {
    if (routeValue && filteredOptions.some((option) => option.value === routeValue)) {
      return routeValue
    }
    return filteredOptions[0]?.value ?? ''
  }, [filteredOptions, routeValue])

  const isWebRelated = useMemo(() => {
    if (selectedProvider.startsWith('provider:')) {
      const providerId = selectedProvider.slice('provider:'.length)
      const provider = state?.providers.find((p) => p.id === providerId)
      if (provider && isRouterWebProviderKind(provider.kind)) return true
    }
    if (activeRoute.startsWith('model:')) {
      const target = activeRoute.slice('model:'.length)
      const slash = target.indexOf('/')
      const providerId = slash > 0 ? target.slice(0, slash) : ''
      const provider = state?.providers.find((p) => p.id === providerId)
      if (provider && isRouterWebProviderKind(provider.kind)) return true
      if (isRouterWebProviderKind(providerId)) return true
    }
    if (activeRoute.startsWith('combo:')) {
      const comboName = activeRoute.slice('combo:'.length).trim()
      const combo = state?.combos.find((c) => c.name === comboName)
      if (combo) {
        const usesWeb = combo.models.some((entry) => {
          const provider = state?.providers.find((p) => p.id === entry.providerId)
          return (provider && isRouterWebProviderKind(provider.kind)) || isRouterWebProviderKind(entry.providerId)
        })
        if (usesWeb) return true
      }
      if (comboName.toLowerCase().includes('web')) return true
    }
    return false
  }, [state, selectedProvider, activeRoute])

  useEffect(() => {
    const dispose = window.ndDshRouter.onPlaygroundEvent((event) => {
      if (!activeRef.current || event.requestId !== activeRef.current) return
      if (event.type === 'phase') {
        setStatus(event.phase === 'streaming' ? 'Streaming…' : event.phase === 'waiting' ? 'Waiting for reply…' : 'Connecting…')
        setElapsed(Date.now() - startedAtRef.current)
        return
      }
      if (event.type === 'delta') {
        setPending((current) => `${current ?? ''}${event.delta ?? ''}`)
        setElapsed(Date.now() - startedAtRef.current)
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
        activeRef.current = null
        return
      }
      setError(event.error ?? 'Playground request failed')
      setStatus('Failed')
      setRunning(false)
      setPending(null)
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
    const skillMatch = /^\s*\/([a-zA-Z0-9][a-zA-Z0-9:_-]{0,127})(?:\s+([\s\S]*)|$)/.exec(text)
    if (skillMatch && window.ndDsh?.skills) {
      const skillName = skillMatch[1]
      const userRequest = skillMatch[2]?.trim() ?? ''
      try {
        const catalog = skills.length > 0 ? skills : await loadSkills()
        const skill = catalog.find((s) => s.name === skillName)
        if (skill?.selectionId) {
          const detail = await window.ndDsh.skills.detail(skill.selectionId)
          if (detail?.markdown) {
            promptToSend = `${detail.markdown.trim()}\n\nApply the instructions above to the request below. Do not create, save, edit, or describe a skill; complete the task and return only the requested output.\nRequest:\n${userRequest}`
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
      })
  }

  const stop = (): void => {
    const active = activeRef.current
    if (!active) return
    void window.ndDshRouter.playgroundStop(active).catch((cause) => onError(message(cause)))
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
    <div className="space-y-1.5">
        <SettingsRow className="items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <select
                aria-label="Filter provider"
                className="h-8 min-w-[130px] flex-1 rounded-md border border-border bg-surface-1 px-2 font-mono text-[11px] text-soft"
                value={selectedProvider}
                disabled={busy}
                onChange={(event) => setSelectedProvider(event.target.value)}
              >
                <option value="all">All providers</option>
                {(state?.combos?.length ?? 0) > 0 ? <option value="combos">Route combos</option> : null}
                {(state?.providers ?? []).map((provider) => (
                  <option key={provider.id} value={`provider:${provider.id}`}>
                    {`${provider.name}${isRouterWebProviderKind(provider.kind) ? ' · Web' : ''}`}
                  </option>
                ))}
              </select>

              <select
                aria-label="Playground route"
                className="h-8 min-w-[130px] flex-1 rounded-md border border-border bg-surface-1 px-2 font-mono text-[11px] text-soft"
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

              {isWebRelated && (
                <select
                  aria-label="Browser profile"
                  className="h-8 min-w-[130px] flex-1 rounded-md border border-border bg-surface-1 px-2 font-mono text-[11px] text-soft"
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
              )}

              <span className={rowValueText}>{busy ? `${elapsed} ms` : null}</span>
            </div>

            <div className="flex items-center justify-between pb-0.5 pt-1">
              <span className="text-[10px] font-medium text-muted-foreground">
                {messages.length === 0 && pending === null
                  ? 'Send a prompt to test this route.'
                  : `${messages.length + (pending !== null ? 1 : 0)} turn${(messages.length + (pending !== null ? 1 : 0)) === 1 ? '' : 's'}`}
              </span>
              <div className="flex items-center rounded-md border border-border-soft bg-surface-1 p-0.5">
                <button
                  type="button"
                  aria-label="Preview mode"
                  className={cn(
                    'cursor-pointer rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                    viewMode === 'preview'
                      ? 'bg-surface-0 font-semibold text-foreground shadow-xs'
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
                    'cursor-pointer rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                    viewMode === 'raw'
                      ? 'bg-surface-0 font-semibold text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => setViewMode('raw')}
                >
                  Raw
                </button>
              </div>
            </div>

            <div className={cn(
              'overflow-auto rounded-md border border-border-soft bg-surface-1 px-3 py-2.5',
              embedded ? 'min-h-[200px] max-h-[46vh]' : 'min-h-[110px] max-h-[260px]',
            )}>
              {messages.length === 0 && pending === null ? (
                <span className={rowDesc}>Send a prompt to test this route. Markdown formatting, code blocks, and reasoning preview are supported like ND chat.</span>
              ) : null}
              {viewMode === 'preview' ? (
                <div className="flex flex-col gap-3">
                  {messages.map((turn, index) => {
                    if (turn.role === 'user') {
                      const skillMatch = /^\s*\/([a-zA-Z0-9][a-zA-Z0-9:_-]{0,127})(?:\s+([\s\S]*)|$)/.exec(turn.content)
                      return (
                        <div key={`${turn.role}-${index}`} className="flex justify-end">
                          <div className="group flex max-w-[85%] items-end gap-1.5">
                            <div className="opacity-0 transition-opacity group-hover:opacity-100">
                              <CopyMessageButton text={turn.content} />
                            </div>
                            <article className="rounded-2xl rounded-br-sm bg-info/[0.13] px-3.5 py-2">
                              <div className="whitespace-pre-wrap break-words text-[12px]/[1.6] text-foreground">
                                {skillMatch ? (
                                  <>
                                    <span className="mr-1.5 inline-flex items-center gap-1 rounded bg-info/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-info">
                                      <SparkIcon className="size-2.5" />
                                      /{skillMatch[1]}
                                    </span>
                                    {skillMatch[2] ?? ''}
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
                      <article key={`${turn.role}-${index}`} className="group flex items-start gap-2.5 rounded-lg border border-border-soft bg-surface-0/60 p-3">
                        <span className="mt-[2px] grid size-5 shrink-0 place-items-center rounded-full bg-primary/15 text-primary [&_svg]:size-3">
                          <SparkIcon />
                        </span>
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-semibold text-foreground">Assistant</span>
                            <div className="opacity-0 transition-opacity group-hover:opacity-100">
                              <CopyMessageButton text={turn.content} />
                            </div>
                          </div>
                          <div className="text-[12px]/[1.65] text-soft">
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
                    <article className="group flex items-start gap-2.5 rounded-lg border border-border-soft bg-surface-0/60 p-3">
                      <span className="mt-[2px] grid size-5 shrink-0 place-items-center rounded-full bg-primary/15 text-primary [&_svg]:size-3">
                        <SparkIcon />
                      </span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-semibold text-foreground">Assistant</span>
                        </div>
                        <div className="text-[12px]/[1.65] text-soft">
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

            <div className="relative flex flex-col rounded-xl border border-border bg-surface-1 px-3 py-2.5 shadow-[0_4px_16px_rgba(0,0,0,0.18)] transition-colors focus-within:border-primary/50">
              {/* Mentions popup for skills */}
              {mentionTrigger && filteredSkills.length > 0 ? (
                <div className="absolute inset-x-0 bottom-full z-30 mb-2 max-h-[220px] overflow-y-auto rounded-xl border border-border-strong bg-surface-1 p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.4)]">
                  <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-faint">
                    Inject Skill
                  </div>
                  {filteredSkills.map((skill, index) => (
                    <button
                      key={skill.name}
                      type="button"
                      className={cn(
                        'flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
                        index === mentionIndex ? 'bg-primary/15 text-foreground' : 'text-soft hover:bg-accent hover:text-foreground'
                      )}
                      onMouseEnter={() => setMentionIndex(index)}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        selectSkill(skill)
                      }}
                    >
                      <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded bg-primary/20 text-primary [&_svg]:size-2.5">
                        <SparkIcon />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-foreground">/{skill.displayName ?? skill.name}</span>
                          {skill.source ? <span className="rounded bg-surface-2 px-1 py-px text-[9px] text-faint">{skill.source}</span> : null}
                        </div>
                        {skill.description ? (
                          <div className="truncate text-[10px] text-faint">{skill.description}</div>
                        ) : null}
                      </div>
                    </button>
                  ))}
                  <div className="mt-1 flex gap-3 border-t border-border-soft px-2 pt-1 text-[9px] text-fainter">
                    <span>↑↓ navigate</span>
                    <span>↵ insert</span>
                    <span>esc dismiss</span>
                  </div>
                </div>
              ) : null}

              {/* Active skill banner */}
              {activeSkill ? (
                <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-info/30 bg-info/10 px-2.5 py-1 text-xs text-foreground">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <SparkIcon className="size-3 shrink-0 text-info" />
                    <span className="font-semibold text-info">/{activeSkill.displayName ?? activeSkill.name}</span>
                    <span className="truncate text-[11px] text-faint">{activeSkill.description}</span>
                  </div>
                  <button
                    type="button"
                    className="grid size-4 shrink-0 place-items-center rounded-full text-faint hover:bg-info/20 hover:text-foreground"
                    title="Remove skill"
                    onClick={() => {
                      const trimmed = input.trimStart()
                      const spaceIndex = trimmed.search(/\s/)
                      setInput(spaceIndex > 0 ? trimmed.slice(spaceIndex + 1).trimStart() : '')
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
                placeholder="Ask or prompt this route — type / to inject skills  (Enter to send)"
                onChange={(event) => {
                  setInput(event.target.value)
                  setCaret(event.target.selectionStart ?? event.target.value.length)
                }}
                onSelect={(event) => {
                  const target = event.target as HTMLTextAreaElement
                  setCaret(target.selectionStart ?? 0)
                }}
                onKeyDown={(event) => {
                  if (mentionTrigger && filteredSkills.length > 0) {
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
                className="max-h-[180px] w-full resize-none overflow-y-auto bg-transparent text-xs/[1.5] text-foreground outline-none placeholder:text-faint"
              />

              <div className="mt-2 flex items-center justify-between gap-1 border-t border-border/70 pt-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-soft transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3"
                    title="Browse and inject available ND skills into this prompt"
                    aria-label="Inject skill"
                    onClick={handleOpenSkills}
                    disabled={busy}
                  >
                    <SparkIcon className="text-primary" />
                    <span>Skills</span>
                  </button>

                  <button
                    type="button"
                    className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-soft transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-3"
                    disabled={messages.length === 0 && pending === null}
                    onClick={clear}
                    title="Clear conversation"
                    aria-label="Clear conversation"
                  >
                    <TrashIcon />
                    <span>Clear</span>
                  </button>

                  <StatusChip good={status === 'Done'} warn={status === 'Failed'}>
                    {status}
                  </StatusChip>

                  {busy ? (
                    <span className="flex items-center gap-1 text-[10px] text-faint">
                      <SpinnerIcon className="size-3 animate-spin text-primary" />
                      <span>{elapsed} ms</span>
                    </span>
                  ) : (
                    <span className="hidden text-[10px] text-fainter sm:inline">
                      ↵ send · ⇧↵ newline · / skills
                    </span>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {busy ? (
                    <button
                      type="button"
                      className="grid size-[26px] shrink-0 place-items-center rounded-[7px] bg-primary text-primary-foreground transition-[filter] enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35 [&_svg]:size-3.5"
                      onClick={stop}
                      aria-label="Stop response"
                      title="Stop response (Esc)"
                    >
                      <StopIcon />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="grid size-[26px] shrink-0 place-items-center rounded-[7px] bg-primary text-primary-foreground transition-[filter] enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35 [&_svg]:size-3.5"
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
              <span className={rowDesc}>
                Answered by {resolved.provider ?? 'unknown provider'} · {resolved.model ?? 'unknown model'} · {resolved.latencyMs ?? elapsed} ms
                {resolved.combo ? ` · route ${resolved.combo}` : ''}
              </span>
            ) : null}
          </div>
        </SettingsRow>
        <SettingsNote>
          API lanes stream tokens. ChatGPT Web, Gemini Web, and DeepSeek Web run one turn at a time in the background,
          so their reply appears when the turn completes. Stop cancels the browser turn. ND only opens the provider page
          when you need to sign in or clear a challenge.
        </SettingsNote>
    </div>
  )
  return embedded ? content : <SettingsSection title="Playground">{content}</SettingsSection>
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
