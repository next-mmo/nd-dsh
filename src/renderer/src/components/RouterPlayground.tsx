import { useEffect, useMemo, useRef, useState } from 'react'
import {
  isRouterWebProviderKind,
  type RouterPlaygroundEvent,
  type RouterPlaygroundMessage,
  type RouterPlaygroundRoute,
  type RouterState,
} from '../../../shared/router'
import { cn } from '../lib/utils'
import {
  SettingsButton,
  SettingsNote,
  SettingsRow,
  SettingsSection,
  StatusChip,
  rowDesc,
  rowValueText,
} from './settings-primitives'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'

interface RouterPlaygroundProps {
  state: RouterState | null
  onError(message: string): void
  embedded?: boolean
}

interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export function RouterPlayground({ state, onError, embedded = false }: RouterPlaygroundProps) {
  const [routeValue, setRouteValue] = useState('')
  const [system, setSystem] = useState('')
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatTurn[]>([])
  const [pending, setPending] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [status, setStatus] = useState('Idle')
  const [error, setError] = useState<string | null>(null)
  const [resolved, setResolved] = useState<Pick<RouterPlaygroundEvent, 'combo' | 'provider' | 'model' | 'latencyMs'> | null>(null)
  const activeRef = useRef<string | null>(null)
  const startedAtRef = useRef(0)

  const options = useMemo(() => {
    const combos = (state?.combos ?? []).map((combo) => ({
      value: `combo:${combo.name}`,
      label: combo.hiddenFromChat ? `${combo.name} · Private` : combo.name,
    }))
    const models = (state?.providers ?? []).flatMap((provider) => provider.models.map((model) => ({
      value: `model:${provider.id}/${model}`,
      label: `${provider.name} / ${model}${isRouterWebProviderKind(provider.kind) ? ' · Web' : ''}`,
    })))
    return [...combos, ...models]
  }, [state])

  useEffect(() => {
    if (routeValue && options.some((option) => option.value === routeValue)) return
    setRouteValue(options[0]?.value ?? '')
  }, [options, routeValue])

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

  const send = (): void => {
    if (running) return
    const text = input.trim()
    if (!text) return
    const route = parseRoute(routeValue)
    if (!route) {
      onError('Choose a route before sending.')
      return
    }
    const requestId = crypto.randomUUID()
    const userTurn: ChatTurn = { role: 'user', content: text }
    const outbound: RouterPlaygroundMessage[] = [
      ...(system.trim() ? [{ role: 'system' as const, content: system.trim() }] : []),
      ...messages,
      userTurn,
    ]
    activeRef.current = requestId
    startedAtRef.current = Date.now()
    setMessages((current) => [...current, userTurn])
    setInput('')
    setPending('')
    setRunning(true)
    setElapsed(0)
    setError(null)
    setResolved(null)
    setStatus('Connecting…')
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
  }

  const busy = running || status === 'Connecting…' || status === 'Waiting for reply…' || status === 'Streaming…'

  const content = (
    <div className="space-y-1.5">
        <SettingsRow className="items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <select
                aria-label="Playground route"
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-2 font-mono text-[11px] text-soft"
                value={routeValue}
                disabled={busy}
                onChange={(event) => setRouteValue(event.target.value)}
              >
                {options.length === 0 ? <option value="">No routes yet</option> : null}
                {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <span className={rowValueText}>{busy ? `${elapsed} ms` : null}</span>
            </div>

            <Input
              aria-label="Playground system instruction"
              placeholder="System instruction (optional)"
              value={system}
              disabled={busy}
              onChange={(event) => setSystem(event.target.value)}
            />

            <div className={cn(
              'overflow-auto rounded-md border border-border-soft bg-surface-1 px-2.5 py-2',
              embedded ? 'min-h-[180px] max-h-[42vh]' : 'min-h-[92px] max-h-[220px]',
            )}>
              {messages.length === 0 && pending === null ? (
                <span className={rowDesc}>Send a prompt to test this route. Hidden web combos are testable here.</span>
              ) : null}
              <div className="flex flex-col gap-2">
                {messages.map((turn, index) => (
                  <div key={`${turn.role}-${index}`} className="flex flex-col gap-0.5">
                    <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{turn.role === 'user' ? 'You' : 'Assistant'}</span>
                    <span className="whitespace-pre-wrap text-[11px] leading-[1.5] text-soft">{turn.content}</span>
                  </div>
                ))}
                {pending !== null ? (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Assistant</span>
                    <span className="whitespace-pre-wrap text-[11px] leading-[1.5] text-soft">{pending || (busy ? '…' : '')}</span>
                  </div>
                ) : null}
              </div>
            </div>

            <Textarea
              aria-label="Playground prompt"
              placeholder="Prompt…  ⌘/Ctrl+Enter to send"
              value={input}
              disabled={busy}
              rows={3}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  send()
                }
              }}
              className="min-h-[64px] resize-y font-mono text-[11px]"
            />

            <div className="flex flex-wrap items-center gap-1">
              <SettingsButton disabled={busy || !input.trim() || !routeValue} onClick={send}>Send</SettingsButton>
              {busy ? <SettingsButton onClick={stop}>Stop</SettingsButton> : null}
              <SettingsButton disabled={messages.length === 0 && pending === null} onClick={clear}>Clear</SettingsButton>
              <StatusChip good={status === 'Done'} warn={status === 'Failed'}>{status}</StatusChip>
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
          API lanes stream tokens. ChatGPT Web and Gemini Web run one turn at a time in the background, so their reply
          appears when the turn completes. Stop cancels the browser turn. ND only opens the provider page when you need
          to sign in or clear a challenge.
        </SettingsNote>
    </div>
  )
  return embedded ? content : <SettingsSection title="Playground">{content}</SettingsSection>
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}