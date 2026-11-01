import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../lib/utils'
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  LogsIcon,
  SearchIcon,
  SpinnerIcon,
  TrashIcon,
} from './Icons'

export type ProcessLogLevel =
  | 'info'
  | 'phase'
  | 'tool'
  | 'stream'
  | 'status'
  | 'success'
  | 'warn'
  | 'error'

export interface ProcessLogEntry {
  id: string
  timestamp: string // e.g. "20:55:01.123"
  time: number
  level: ProcessLogLevel
  title: string
  subtitle?: string | undefined
  detail?: string | undefined
  payload?: unknown
  durationMs?: number | undefined
}

export interface ProcessLogsDrawerProps {
  open: boolean
  onClose(): void
  logs: ProcessLogEntry[]
  onClear(): void
  busy?: boolean | undefined
  title?: string | undefined
  subtitle?: string | undefined
  className?: string | undefined
  width?: string | undefined
}

function getLevelBadge(level: ProcessLogLevel) {
  switch (level) {
    case 'tool':
      return {
        label: 'TOOL',
        className: 'border-sky-500/30 bg-sky-500/15 text-sky-400',
      }
    case 'phase':
      return {
        label: 'PHASE',
        className: 'border-amber-500/30 bg-amber-500/15 text-amber-400',
      }
    case 'stream':
      return {
        label: 'STREAM',
        className: 'border-teal-500/30 bg-teal-500/15 text-teal-400',
      }
    case 'status':
      return {
        label: 'STATUS',
        className: 'border-indigo-500/30 bg-indigo-500/15 text-indigo-400',
      }
    case 'success':
      return {
        label: 'DONE',
        className: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400',
      }
    case 'warn':
      return {
        label: 'WARN',
        className: 'border-orange-500/30 bg-orange-500/15 text-orange-400',
      }
    case 'error':
      return {
        label: 'ERROR',
        className: 'border-rose-500/30 bg-rose-500/15 text-rose-400',
      }
    case 'info':
    default:
      return {
        label: 'INFO',
        className: 'border-zinc-500/30 bg-zinc-500/15 text-zinc-400',
      }
  }
}

export function formatLogTimestamp(date = new Date()): string {
  const pad = (n: number, s = 2) => String(n).padStart(s, '0')
  const h = pad(date.getHours())
  const m = pad(date.getMinutes())
  const s = pad(date.getSeconds())
  const ms = pad(date.getMilliseconds(), 3)
  return `${h}:${m}:${s}.${ms}`
}

export function ProcessLogsDrawer({
  open,
  onClose,
  logs,
  onClear,
  busy = false,
  title = 'Process Logs',
  subtitle,
  className,
  width = 'w-[360px] sm:w-[400px]',
}: ProcessLogsDrawerProps) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'tool' | 'phase' | 'error'>('all')
  const [autoScroll, setAutoScroll] = useState(true)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [copiedAll, setCopiedAll] = useState(false)
  const [copiedEntryId, setCopiedEntryId] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const isUserScrollingRef = useRef(false)

  // Filter logs based on search query and category tab
  const filteredLogs = useMemo(() => {
    return logs.filter((entry) => {
      if (filter === 'tool' && entry.level !== 'tool') return false
      if (filter === 'phase' && !['phase', 'status', 'stream'].includes(entry.level)) return false
      if (filter === 'error' && !['error', 'warn'].includes(entry.level)) return false

      if (!search.trim()) return true
      const q = search.toLowerCase()
      if (entry.title.toLowerCase().includes(q)) return true
      if (entry.subtitle?.toLowerCase().includes(q)) return true
      if (entry.detail?.toLowerCase().includes(q)) return true
      if (entry.payload && JSON.stringify(entry.payload).toLowerCase().includes(q)) return true
      return false
    })
  }, [logs, filter, search])

  const counts = useMemo(() => {
    return {
      all: logs.length,
      tool: logs.filter((e) => e.level === 'tool').length,
      phase: logs.filter((e) => ['phase', 'status', 'stream'].includes(e.level)).length,
      error: logs.filter((e) => ['error', 'warn'].includes(e.level)).length,
    }
  }, [logs])

  // Auto-scroll to bottom when new logs arrive if enabled
  useEffect(() => {
    if (!open || !autoScroll || isUserScrollingRef.current) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [filteredLogs.length, open, autoScroll])

  // Detect when user scrolls away from bottom
  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
    isUserScrollingRef.current = !isAtBottom
    if (isAtBottom && !autoScroll) {
      setAutoScroll(true)
    }
  }

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCopyAll = async () => {
    try {
      const text = filteredLogs
        .map((entry) => {
          let line = `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.title}`
          if (entry.durationMs !== undefined) line += ` (+${entry.durationMs}ms)`
          if (entry.subtitle) line += ` (${entry.subtitle})`
          if (entry.detail) line += `\n  ${entry.detail.replace(/\n/g, '\n  ')}`
          if (entry.payload) {
            try {
              line += `\n  Payload: ${JSON.stringify(entry.payload, null, 2).replace(/\n/g, '\n  ')}`
            } catch {
              // ignore JSON error
            }
          }
          return line
        })
        .join('\n\n')

      await navigator.clipboard.writeText(text || 'No process logs.')
      setCopiedAll(true)
      setTimeout(() => setCopiedAll(false), 1600)
    } catch {
      // ignore clipboard error
    }
  }

  const handleCopyEntry = async (entry: ProcessLogEntry, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const content = entry.detail || (entry.payload ? JSON.stringify(entry.payload, null, 2) : entry.title)
      await navigator.clipboard.writeText(content)
      setCopiedEntryId(entry.id)
      setTimeout(() => setCopiedEntryId(null), 1600)
    } catch {
      // ignore
    }
  }

  if (!open) return null

  return (
    <aside
      className={cn(
        'relative flex h-full shrink-0 flex-col overflow-hidden border-l border-border-soft bg-surface-1 shadow-xl transition-all duration-200 z-20',
        width,
        className
      )}
      aria-label="Process logs drawer"
    >
      {/* 1. Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border-soft bg-surface-2/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="relative flex shrink-0 items-center">
            <LogsIcon className="size-4 text-primary" />
            <span
              className={cn(
                'absolute -bottom-0.5 -right-0.5 size-2 rounded-full border border-surface-1',
                busy ? 'bg-emerald-500 animate-pulse' : 'bg-faint/50'
              )}
              title={busy ? 'Process active' : 'Process idle'}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs font-semibold text-foreground">{title}</span>
              {busy ? (
                <span className="flex items-center gap-0.5 text-[9.5px] font-mono text-primary">
                  <SpinnerIcon className="size-2.5 animate-spin" />
                  <span>live</span>
                </span>
              ) : null}
            </div>
            {subtitle ? (
              <p className="truncate text-[9.5px] text-faint" title={subtitle}>
                {subtitle}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="flex h-6 items-center gap-1 rounded border border-border-soft bg-background/80 px-1.5 text-[10px] font-medium text-soft transition-colors hover:bg-accent hover:text-foreground"
            onClick={handleCopyAll}
            title="Copy all logs to clipboard"
            aria-label="Copy logs"
          >
            {copiedAll ? <CheckIcon className="size-2.5 text-emerald-500" /> : <CopyIcon className="size-2.5" />}
            <span className="hidden sm:inline">{copiedAll ? 'Copied' : 'Copy'}</span>
          </button>

          <button
            type="button"
            className="flex h-6 items-center gap-1 rounded border border-border-soft bg-background/80 px-1.5 text-[10px] font-medium text-soft transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            onClick={onClear}
            disabled={logs.length === 0}
            title="Clear all logs"
            aria-label="Clear logs"
          >
            <TrashIcon className="size-2.5" />
            <span className="hidden sm:inline">Clear</span>
          </button>

          <button
            type="button"
            className="grid size-6 place-items-center rounded border border-border-soft bg-background/80 text-faint transition-colors hover:bg-accent hover:text-foreground"
            onClick={onClose}
            title="Close logs drawer"
            aria-label="Close logs drawer"
          >
            <CloseIcon className="size-3" />
          </button>
        </div>
      </div>

      {/* 2. Search & Filter Bar */}
      <div className="flex flex-col gap-1.5 border-b border-border-soft bg-surface-1/70 p-2 text-xs">
        <div className="relative flex items-center">
          <SearchIcon className="absolute left-2 size-3 text-faint" />
          <input
            type="text"
            className="h-6 w-full rounded border border-border-soft bg-background/90 pl-6.5 pr-2 text-[10.5px] text-foreground placeholder:text-fainter outline-none transition-colors focus:border-primary"
            placeholder="Search process logs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search ? (
            <button
              type="button"
              className="absolute right-1.5 text-[10px] text-faint hover:text-foreground"
              onClick={() => setSearch('')}
            >
              ✕
            </button>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-1 pt-0.5">
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              className={cn(
                'rounded px-1.5 py-0.5 text-[9.5px] font-medium transition-colors',
                filter === 'all'
                  ? 'bg-primary text-primary-foreground font-semibold'
                  : 'bg-surface-2 text-faint hover:text-foreground'
              )}
              onClick={() => setFilter('all')}
            >
              All {counts.all > 0 ? `(${counts.all})` : ''}
            </button>
            <button
              type="button"
              className={cn(
                'rounded px-1.5 py-0.5 text-[9.5px] font-medium transition-colors',
                filter === 'tool'
                  ? 'bg-sky-500 text-white font-semibold'
                  : 'bg-surface-2 text-faint hover:text-foreground'
              )}
              onClick={() => setFilter('tool')}
            >
              Tools {counts.tool > 0 ? `(${counts.tool})` : ''}
            </button>
            <button
              type="button"
              className={cn(
                'rounded px-1.5 py-0.5 text-[9.5px] font-medium transition-colors',
                filter === 'phase'
                  ? 'bg-amber-500 text-white font-semibold'
                  : 'bg-surface-2 text-faint hover:text-foreground'
              )}
              onClick={() => setFilter('phase')}
            >
              Phases {counts.phase > 0 ? `(${counts.phase})` : ''}
            </button>
            <button
              type="button"
              className={cn(
                'rounded px-1.5 py-0.5 text-[9.5px] font-medium transition-colors',
                filter === 'error'
                  ? 'bg-rose-500 text-white font-semibold'
                  : 'bg-surface-2 text-faint hover:text-foreground'
              )}
              onClick={() => setFilter('error')}
            >
              Errors {counts.error > 0 ? `(${counts.error})` : ''}
            </button>
          </div>

          <button
            type="button"
            className={cn(
              'shrink-0 text-[9px] font-mono transition-colors',
              autoScroll ? 'text-primary font-semibold' : 'text-fainter hover:text-faint'
            )}
            onClick={() => {
              setAutoScroll((v) => !v)
              if (!autoScroll && scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight
                isUserScrollingRef.current = false
              }
            }}
            title={autoScroll ? 'Auto-scroll enabled' : 'Auto-scroll paused'}
          >
            {autoScroll ? '↓ Auto' : '↓ Paused'}
          </button>
        </div>
      </div>

      {/* 3. Log Entries List */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto divide-y divide-border-soft/40 p-2 font-mono text-[10px]"
      >
        {filteredLogs.length === 0 ? (
          <div className="m-auto flex flex-col items-center justify-center gap-2 p-6 text-center text-faint">
            <div className="grid size-8 place-items-center rounded-lg bg-surface-2 text-faint">
              <LogsIcon className="size-4" />
            </div>
            <p className="text-xs font-medium text-foreground">No process logs</p>
            <p className="max-w-[240px] text-[10px] leading-relaxed text-muted-foreground">
              {search || filter !== 'all'
                ? 'No log entries match the current filter criteria.'
                : 'Process execution steps, lifecycle phases, tool runs, and streaming output will appear here in real time.'}
            </p>
          </div>
        ) : (
          filteredLogs.map((entry) => {
            const badge = getLevelBadge(entry.level)
            const isExpanded = expandedIds.has(entry.id)
            const hasExtra = Boolean(entry.detail || entry.payload)

            return (
              <div
                key={entry.id}
                className={cn(
                  'group flex flex-col py-1.5 transition-colors',
                  hasExtra ? 'cursor-pointer hover:bg-surface-2/60' : 'hover:bg-surface-2/30',
                  isExpanded ? 'bg-surface-2/40 rounded' : ''
                )}
                onClick={() => {
                  if (hasExtra) toggleExpand(entry.id)
                }}
              >
                {/* Log Line Header */}
                <div className="flex items-start justify-between gap-1.5">
                  <div className="flex min-w-0 flex-1 items-baseline gap-1.5 flex-wrap">
                    <span className="shrink-0 text-[9px] text-fainter font-mono">{entry.timestamp}</span>
                    <span
                      className={cn(
                        'shrink-0 rounded border px-1 py-[1px] text-[8.5px] font-bold leading-none font-mono tracking-tight',
                        badge.className
                      )}
                    >
                      {badge.label}
                    </span>
                    <span className="font-semibold text-foreground break-words">{entry.title}</span>
                    {entry.durationMs !== undefined ? (
                      <span className="text-[9px] text-faint">+{entry.durationMs}ms</span>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      className="grid size-4 place-items-center rounded text-faint hover:bg-accent hover:text-foreground"
                      onClick={(e) => void handleCopyEntry(entry, e)}
                      title="Copy this entry"
                      aria-label="Copy entry"
                    >
                      {copiedEntryId === entry.id ? (
                        <CheckIcon className="size-2.5 text-emerald-500" />
                      ) : (
                        <CopyIcon className="size-2.5" />
                      )}
                    </button>
                    {hasExtra ? (
                      <span className="text-[9px] text-faint">
                        {isExpanded ? '▲' : '▼'}
                      </span>
                    ) : null}
                  </div>
                </div>

                {/* Subtitle if available */}
                {entry.subtitle ? (
                  <div className="mt-0.5 pl-14 text-[9px] text-faint break-words">
                    {entry.subtitle}
                  </div>
                ) : null}

                {/* Collapsed short snippet if not expanded */}
                {!isExpanded && entry.detail && (
                  <div className="mt-0.5 line-clamp-1 pl-14 text-[9px] text-fainter break-all">
                    {entry.detail.slice(0, 120)}
                  </div>
                )}

                {/* Expanded Detailed View */}
                {isExpanded && hasExtra ? (
                  <div className="mt-1.5 flex flex-col gap-1 rounded border border-border-soft bg-surface-0/90 p-2 font-mono text-[9.5px]">
                    {entry.detail ? (
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[8.5px] font-bold text-faint uppercase">Detail</span>
                        <pre className="max-h-[160px] overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all text-soft">
                          {entry.detail}
                        </pre>
                      </div>
                    ) : null}

                    {entry.payload ? (
                      <div className="flex flex-col gap-0.5 border-t border-border-soft/60 pt-1">
                        <span className="text-[8.5px] font-bold text-faint uppercase">Payload</span>
                        <pre className="max-h-[200px] overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all text-soft">
                          {typeof entry.payload === 'string'
                            ? entry.payload
                            : JSON.stringify(entry.payload, null, 2)}
                        </pre>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>

      {/* 4. Footer Status Bar */}
      <div className="flex shrink-0 items-center justify-between border-t border-border-soft bg-surface-2/40 px-3 py-1 text-[9.5px] text-faint font-mono">
        <span>{filteredLogs.length} entries</span>
        {busy ? (
          <span className="flex items-center gap-1 text-emerald-400">
            <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>processing…</span>
          </span>
        ) : (
          <span>ready</span>
        )}
      </div>
    </aside>
  )
}
