import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { groupEntries } from '../../../shared/chat-grouping'
import type { ThreadEntry } from '../lib/types'
import {
  MAX_SPLIT_PANES,
  sortSplitCandidates,
  splitGridClass,
  splitPaneSpanClass,
  type SplitChatCandidate,
  type SplitPaneItem,
} from '../lib/chat-split'
import { MarkdownLite } from './MarkdownLite'
import { ChatAvatar } from './ChatAvatar'
import { ArrowUpIcon, CloseIcon, ExternalIcon, PlusIcon, SearchIcon, StopIcon } from './Icons'
import { Button } from './ui/button'
import { cn } from '../lib/utils'

export interface ChatSplitStageProps {
  panes: readonly SplitPaneItem[]
  candidates: readonly SplitChatCandidate[]
  threads: Readonly<Record<string, ThreadEntry[]>>
  busySessions: ReadonlySet<string>
  focusedSessionId: string | null
  onFocusPane(sessionId: string): void
  onAddPane(sessionId: string): void
  onRemovePane(index: number): void
  onSwapPanes(fromIndex: number, toIndex: number): void
  onOpenAlone(sessionId: string): void
  onExitSplit(): void
  onEnsureLoaded(sessionId: string): void
  onSendMessage(sessionId: string, text: string): Promise<boolean>
  onStopSession(sessionId: string): Promise<void>
  onOpenFile?(path: string): void
  onOpenLink?(url: string): void
}

const STATE_LABEL: Record<SplitChatCandidate['state'], string> = {
  working: 'Working',
  'needs-you': 'Needs you',
  ready: 'Ready',
  archived: 'Archived',
}

function stateDotClass(state: SplitChatCandidate['state']): string {
  if (state === 'working') return 'bg-primary animate-pulse-dot'
  if (state === 'needs-you') return 'bg-warning'
  if (state === 'archived') return 'bg-faint/50'
  return 'bg-emerald-500'
}

export function ChatSplitStage({
  panes,
  candidates,
  threads,
  busySessions,
  focusedSessionId,
  onFocusPane,
  onAddPane,
  onRemovePane,
  onSwapPanes,
  onOpenAlone,
  onExitSplit,
  onEnsureLoaded,
  onSendMessage,
  onStopSession,
  onOpenFile,
  onOpenLink,
}: ChatSplitStageProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const candidateById = useMemo(
    () => new Map(candidates.map((item) => [item.sessionId, item])),
    [candidates],
  )

  const openIds = useMemo(() => new Set(panes.map((pane) => pane.sessionId)), [panes])

  const availableCandidates = useMemo(() => {
    const query = pickerQuery.trim().toLowerCase()
    const free = candidates.filter((item) => !openIds.has(item.sessionId))
    const filtered = query
      ? free.filter((item) => `${item.title} ${item.engineLabel} ${item.projectLabel ?? ''}`.toLowerCase().includes(query))
      : free
    return sortSplitCandidates(filtered)
  }, [candidates, openIds, pickerQuery])

  useEffect(() => {
    for (const pane of panes) {
      onEnsureLoaded(pane.sessionId)
    }
  }, [panes, onEnsureLoaded])

  const handleDragStart = (index: number, event: DragEvent<HTMLElement>): void => {
    setDragIndex(index)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(index))
  }

  const handleDragOver = (index: number, event: DragEvent<HTMLElement>): void => {
    if (dragIndex === null || dragIndex === index) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dropIndex !== index) setDropIndex(index)
  }

  const handleDrop = (index: number, event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    const raw = dragIndex ?? Number(event.dataTransfer.getData('text/plain'))
    if (Number.isInteger(raw) && raw !== index) {
      onSwapPanes(raw, index)
    }
    setDragIndex(null)
    setDropIndex(null)
  }

  const handleDragEnd = (): void => {
    setDragIndex(null)
    setDropIndex(null)
  }

  const renderPickerList = (compact: boolean) => (
    <div className={cn('flex flex-col gap-2', compact ? 'w-[280px] p-2.5' : 'mx-auto w-full max-w-[360px] p-4')}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <strong className="block text-xs font-semibold text-foreground">Add a chat</strong>
          <span className="text-[11px] text-faint">Watch up to {MAX_SPLIT_PANES} live sessions side by side.</span>
        </div>
        {compact ? (
          <Button variant="ghost" size="icon-xs" aria-label="Close picker" onClick={() => setPickerOpen(false)}>
            <CloseIcon className="size-3" />
          </Button>
        ) : null}
      </div>
      <label className="relative flex items-center">
        <SearchIcon className="pointer-events-none absolute left-2 size-3 text-faint" />
        <input
          type="search"
          value={pickerQuery}
          onChange={(event) => setPickerQuery(event.target.value)}
          placeholder="Find a chat or engine…"
          aria-label="Find a chat"
          className="h-7 w-full rounded-md border border-border-strong bg-inset pr-2 pl-7 text-xs text-foreground outline-none focus:border-primary/45"
        />
      </label>
      <ul className="m-0 flex max-h-[260px] list-none flex-col gap-1 overflow-y-auto p-0">
        {availableCandidates.length > 0 ? availableCandidates.map((item) => (
          <li key={item.sessionId}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border-soft hover:bg-accent/70"
              onClick={() => {
                onAddPane(item.sessionId)
                setPickerOpen(false)
                setPickerQuery('')
              }}
            >
              <span className={cn('size-2 shrink-0 rounded-full', stateDotClass(item.state))} />
              <span className="flex min-w-0 flex-1 flex-col">
                <strong className="truncate text-xs font-medium text-foreground">{item.title}</strong>
                <span className="truncate text-[10px] text-faint">
                  {STATE_LABEL[item.state]} · {item.engineLabel}{item.projectLabel ? ` · ${item.projectLabel}` : ''}
                </span>
              </span>
            </button>
          </li>
        )) : (
          <li className="py-4 text-center text-xs text-faint">
            {candidates.length === 0 ? 'No chats yet.' : 'Every available chat is already open.'}
          </li>
        )}
      </ul>
    </div>
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-surface-0">
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border-soft bg-sidebar px-2.5">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <strong className="font-semibold text-foreground">Split view</strong>
          <span className="font-mono text-[10px] text-faint tabular-nums">
            {panes.length} / {MAX_SPLIT_PANES}
          </span>
          <span className="hidden text-[10px] text-faint sm:inline">· Drag pane headers to swap</span>
        </div>
        <div className="relative flex items-center gap-1.5">
          {panes.length < MAX_SPLIT_PANES ? (
            <Button
              variant="ghost"
              size="xs"
              className="h-6 gap-1 rounded-md border border-border-strong bg-secondary px-2 text-[11px] text-soft hover:bg-accent hover:text-foreground"
              onClick={() => setPickerOpen((open) => !open)}
            >
              <PlusIcon className="size-3" />
              Add chat
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="xs"
            className="h-6 rounded-md border border-border-soft px-2 text-[11px] text-faint hover:bg-accent hover:text-foreground"
            onClick={onExitSplit}
          >
            Single view
          </Button>
          {pickerOpen ? (
            <div className="absolute top-7 right-0 z-30 rounded-lg border border-border-strong bg-sidebar shadow-[0_16px_44px_rgba(0,0,0,0.38)]">
              {renderPickerList(true)}
            </div>
          ) : null}
        </div>
      </div>

      {panes.length === 0 ? (
        <div className="flex flex-1 items-center justify-center bg-surface-0">
          {renderPickerList(false)}
        </div>
      ) : (
        <div className={cn('grid min-h-0 flex-1 gap-px bg-border-soft', splitGridClass(panes.length))}>
          {panes.map((pane, index) => {
            const meta = candidateById.get(pane.sessionId)
            const entries = threads[pane.sessionId] ?? []
            const isBusy = busySessions.has(pane.sessionId) || meta?.state === 'working'
            const isNeedsYou = meta?.state === 'needs-you'
            const isFocused = focusedSessionId === pane.sessionId
            const paneState: SplitChatCandidate['state'] = isNeedsYou ? 'needs-you' : isBusy ? 'working' : (meta?.state ?? 'ready')

            return (
              <SplitChatPane
                key={pane.sessionId}
                sessionId={pane.sessionId}
                title={meta?.title ?? pane.sessionId}
                engineLabel={meta?.engineLabel ?? 'ND Harness'}
                state={paneState}
                entries={entries}
                busy={isBusy}
                focused={isFocused}
                dragging={dragIndex === index}
                dropTarget={dropIndex === index}
                spanClass={splitPaneSpanClass(panes.length, index)}
                onFocus={() => onFocusPane(pane.sessionId)}
                onOpenAlone={() => onOpenAlone(pane.sessionId)}
                onClose={() => onRemovePane(index)}
                onSend={(text) => onSendMessage(pane.sessionId, text)}
                onStop={() => onStopSession(pane.sessionId)}
                onDragStart={(event) => handleDragStart(index, event)}
                onDragOver={(event) => handleDragOver(index, event)}
                onDrop={(event) => handleDrop(index, event)}
                onDragEnd={handleDragEnd}
                {...(onOpenFile ? { onOpenFile } : {})}
                {...(onOpenLink ? { onOpenLink } : {})}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function SplitChatPane({
  sessionId,
  title,
  engineLabel,
  state,
  entries,
  busy,
  focused,
  dragging,
  dropTarget,
  spanClass,
  onFocus,
  onOpenAlone,
  onClose,
  onSend,
  onStop,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onOpenFile,
  onOpenLink,
}: {
  sessionId: string
  title: string
  engineLabel: string
  state: SplitChatCandidate['state']
  entries: readonly ThreadEntry[]
  busy: boolean
  focused: boolean
  dragging: boolean
  dropTarget: boolean
  spanClass: string
  onFocus(): void
  onOpenAlone(): void
  onClose(): void
  onSend(text: string): Promise<boolean>
  onStop(): Promise<void>
  onDragStart(event: DragEvent<HTMLElement>): void
  onDragOver(event: DragEvent<HTMLElement>): void
  onDrop(event: DragEvent<HTMLElement>): void
  onDragEnd(): void
  onOpenFile?(path: string): void
  onOpenLink?(url: string): void
}) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const groups = useMemo(() => groupEntries([...entries]), [entries])

  useEffect(() => {
    const node = scrollerRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [entries.length])

  async function submit(): Promise<void> {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      const ok = await onSend(text)
      if (ok) setDraft('')
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  const topAccent = state === 'needs-you'
    ? 'shadow-[inset_0_2px_0_0_var(--warning)]'
    : focused
      ? 'shadow-[inset_0_2px_0_0_var(--primary)]'
      : ''

  return (
    <section
      className={cn(
        'flex min-h-0 min-w-0 flex-col overflow-hidden bg-surface-0',
        spanClass,
        topAccent,
        dragging && 'opacity-60',
        dropTarget && 'ring-1 ring-inset ring-primary',
      )}
      onClick={onFocus}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <header
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        title="Drag onto another pane header to swap"
        className="flex h-8 shrink-0 cursor-grab items-center justify-between gap-2 border-b border-border-soft bg-sidebar px-2 active:cursor-grabbing"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="select-none text-[10px] text-faint" aria-hidden="true">⋮⋮</span>
          <ChatAvatar
            name={title}
            fallbackName={engineLabel}
            seed={sessionId}
            size={18}
            status={busy ? 'busy' : state === 'archived' ? 'archived' : 'idle'}
            ringClassName="ring-sidebar"
          />
          <strong className={cn('truncate text-[11px] font-medium', focused || state === 'needs-you' ? 'text-foreground' : 'text-muted-foreground')}>
            {title}
          </strong>
          <span className="hidden shrink-0 rounded border border-border-soft bg-surface-1 px-1 py-px text-[9px] text-faint md:inline">
            {engineLabel}
          </span>
          {state === 'needs-you' ? (
            <span className="shrink-0 rounded-full border border-warning/35 bg-warning/15 px-1.5 py-px text-[9px] font-bold text-warning">
              Needs you
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Open ${title} alone`}
            title="Open alone"
            onClick={(event) => {
              event.stopPropagation()
              onOpenAlone()
            }}
          >
            <ExternalIcon className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Close ${title} pane`}
            title="Close pane"
            onClick={(event) => {
              event.stopPropagation()
              onClose()
            }}
          >
            <CloseIcon className="size-3" />
          </Button>
        </div>
      </header>

      <div ref={scrollerRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2.5 py-2 text-xs">
        {groups.length === 0 ? (
          <p className="py-8 text-center text-[11px] text-faint">No messages in this thread yet.</p>
        ) : groups.map((group) => {
          if (group.kind === 'entry') {
            const entry = group.entry
            if (entry.kind === 'user' || entry.kind === 'assistant') {
              const text = entry.text.trim()
              if (!text) return null
              const isUser = entry.kind === 'user'
              return (
                <div
                  key={entry.id}
                  className={cn(
                    'rounded-md border px-2.5 py-1.5',
                    isUser
                      ? 'ml-6 border-primary/20 bg-primary/[0.06] text-foreground'
                      : 'border-border-soft bg-sidebar text-foreground',
                  )}
                >
                  <div className="mb-0.5 text-[9px] font-semibold tracking-[0.06em] text-faint uppercase">
                    {isUser ? 'You' : engineLabel}
                  </div>
                  <div className="prose-xs break-words text-xs leading-relaxed">
                    <MarkdownLite
                      text={text}
                      {...(onOpenFile ? { onOpenFile } : {})}
                      {...(onOpenLink ? { onOpenLink } : {})}
                    />
                  </div>
                </div>
              )
            }
            if (entry.kind === 'notice') {
              return (
                <div
                  key={entry.id}
                  className={cn(
                    'rounded-md border px-2 py-1 text-[11px]',
                    entry.tone === 'error'
                      ? 'border-destructive/30 bg-destructive/[0.07] text-destructive'
                      : 'border-border-soft bg-inset text-muted-foreground',
                  )}
                >
                  {entry.text}
                </div>
              )
            }
            if (entry.kind === 'approval' || entry.kind === 'question') {
              return (
                <div
                  key={entry.id}
                  className="rounded-md border border-warning/35 bg-warning/10 px-2 py-1.5 text-[11px] text-warning"
                >
                  {entry.kind === 'approval'
                    ? `Approval requested: ${entry.toolName}`
                    : 'Agent asked a question (answer in Needs you inbox)'}
                </div>
              )
            }
            return null
          }
          if (group.kind === 'tool-group') {
            const running = group.tools.some((tool) => tool.status === 'running')
            return (
              <div
                key={group.key}
                className="flex items-center justify-between gap-2 rounded border border-border-soft bg-inset px-2 py-1 font-mono text-[10px] text-muted-foreground"
              >
                <span className="truncate">{group.label}</span>
                <span className="shrink-0 text-faint">{running ? 'running…' : 'done'}</span>
              </div>
            )
          }
          if (group.kind === 'reasoning-group') {
            return (
              <details
                key={group.key}
                className="rounded border border-border-soft bg-inset px-2 py-1 text-[10px] text-faint"
              >
                <summary className="cursor-pointer select-none">Thinking</summary>
                <p className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground">{group.text}</p>
              </details>
            )
          }
          return null
        })}
      </div>

      <footer className="flex shrink-0 items-end gap-1.5 border-t border-border-soft bg-sidebar p-1.5">
        <textarea
          rows={1}
          value={draft}
          disabled={sending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={busy ? 'Steer running agent…' : `Message ${title}…`}
          aria-label={`Message ${title}`}
          className="max-h-20 min-h-[28px] flex-1 resize-none rounded-md border border-border-strong bg-inset px-2 py-1 text-xs text-foreground outline-none focus:border-primary/45"
        />
        {busy ? (
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-7 w-7 shrink-0 border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20"
            title="Stop run"
            aria-label={`Stop ${title}`}
            onClick={() => void onStop()}
          >
            <StopIcon className="size-3" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={!draft.trim() || sending}
          className="h-7 w-7 shrink-0 border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40"
          title={busy ? 'Steer' : 'Send'}
          aria-label={`Send to ${title}`}
          onClick={() => void submit()}
        >
          <ArrowUpIcon className="size-3.5" />
        </Button>
      </footer>
    </section>
  )
}
