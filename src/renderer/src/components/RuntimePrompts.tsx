import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DshEventFrame } from '../../../shared/contracts'
import type { OrganizationSnapshot } from '../../../shared/organization'
import type { AskQuestion } from '../lib/types'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { cn } from '../lib/utils'
import { runtimePromptContext } from '../lib/runtime-prompt-context'
import { runtimePromptAction } from '../lib/runtime-prompt-action'
import {
  formatRelativeAge,
  groupNeedsYouItems,
  orgAttentionToNeedsYou,
  presentNeedsYouItem,
  selectNextNeedsYouId,
  type NeedsYouApprovalItem,
  type NeedsYouGroupBy,
  type NeedsYouItem,
  type NeedsYouOrganizationItem,
  type NeedsYouPresentation,
  type NeedsYouQuestionItem,
} from '../lib/needs-you-inbox'
import { CloseIcon, ExternalIcon } from './Icons'

interface Props {
  onError(message: string): void
  organization: OrganizationSnapshot | null
  inboxOpen?: boolean
  onInboxOpenChange?(open: boolean): void
  onNeedsYouCountChange?(count: number): void
  onOpenSession?(sessionId: string): void
  onOpenCompany?(): void
}

type LivePending = NeedsYouApprovalItem | NeedsYouQuestionItem

const chipClasses = cn(
  'h-[27px] rounded-md border px-2 text-xs transition-colors',
  'border-border-strong bg-secondary text-soft hover:bg-accent hover:text-foreground',
)
const primaryChipClasses = cn(
  'h-[27px] rounded-md border border-primary/30 bg-primary/10 px-2 text-xs text-primary transition-colors hover:bg-primary/15',
)
const amberChipClasses = cn(
  'h-[27px] rounded-md border border-warning/35 bg-warning/15 px-2 text-xs font-medium text-warning transition-colors hover:bg-warning/25',
)

const GROUP_OPTIONS: Array<{ id: NeedsYouGroupBy; label: string }> = [
  { id: 'newest', label: 'Newest' },
  { id: 'agent', label: 'Agent' },
  { id: 'project', label: 'Project' },
]

export function RuntimePrompts({
  onError,
  organization,
  inboxOpen = false,
  onInboxOpenChange,
  onNeedsYouCountChange,
  onOpenSession,
  onOpenCompany,
}: Props) {
  const [livePending, setLivePending] = useState<LivePending[]>([])
  const [orgItems, setOrgItems] = useState<NeedsYouOrganizationItem[]>([])
  const [groupBy, setGroupBy] = useState<NeedsYouGroupBy>('newest')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [resolutionDraft, setResolutionDraft] = useState<Record<string, string>>({})
  const inFlight = useRef(new Set<string>())
  const [responding, setResponding] = useState(new Set<string>())
  const toolActions = useRef(new Map<string, string>())

  useEffect(() => window.ndDsh.dsh.onEvent((frame) => handleFrame(frame)), [])

  const activeProjectId = organization?.activeProjectId
  const refreshOrgNeedsYou = useCallback(async (): Promise<void> => {
    const api = window.ndDshControl
    if (!api?.management) return
    try {
      const projection = await api.management(activeProjectId)
      setOrgItems(orgAttentionToNeedsYou(projection.needsYou ?? []))
    } catch {
      // Control plane may be unavailable in UI preview or before boot completes.
    }
  }, [activeProjectId])

  useEffect(() => {
    let mounted = true
    const run = async (): Promise<void> => {
      if (!mounted) return
      await refreshOrgNeedsYou()
    }
    void run()
    const off = window.ndDshControl?.onChanged?.(() => {
      if (mounted) void refreshOrgNeedsYou()
    })
    return () => {
      mounted = false
      off?.()
    }
  }, [refreshOrgNeedsYou])

  function handleFrame(frame: DshEventFrame): void {
    if (frame.kind === 'session-event' && frame.sessionId && frame.event?.type === 'tool/call') {
      const data = frame.event.data
      if (!data || typeof data !== 'object') return
      const call = data as Record<string, unknown>
      const callId = typeof call.callId === 'string' ? call.callId : undefined
      const action = runtimePromptAction(call.arguments)
      if (!callId || !action) return
      toolActions.current.set(`${frame.sessionId}:${callId}`, action)
      while (toolActions.current.size > 128) toolActions.current.delete(toolActions.current.keys().next().value!)
      setLivePending((current) => current.map((entry) => entry.kind === 'approval' && entry.sessionId === frame.sessionId && entry.callId === callId ? { ...entry, action } : entry))
      return
    }
    if (frame.kind === 'approval-requested' && frame.sessionId && frame.rpcId) {
      const action = frame.callId ? toolActions.current.get(`${frame.sessionId}:${frame.callId}`) : undefined
      const item: NeedsYouApprovalItem = {
        kind: 'approval',
        id: `approval:${frame.rpcId}`,
        sessionId: frame.sessionId,
        rpcId: frame.rpcId,
        approvalId: frame.approvalId ?? frame.rpcId,
        toolName: frame.toolName ?? 'tool',
        createdAt: Date.now(),
        ...(frame.reason ? { reason: frame.reason } : {}),
        ...(frame.callId ? { callId: frame.callId } : {}),
        ...(action ? { action } : {}),
      }
      setLivePending((current) => current.some((entry) => entry.id === item.id) ? current : [...current, item])
      return
    }
    if (frame.kind === 'question-requested' && frame.sessionId && frame.rpcId) {
      const item: NeedsYouQuestionItem = {
        kind: 'question',
        id: `question:${frame.rpcId}`,
        sessionId: frame.sessionId,
        rpcId: frame.rpcId,
        questions: normalizeQuestions(frame.questions),
        createdAt: Date.now(),
      }
      setLivePending((current) => current.some((entry) => entry.id === item.id) ? current : [...current, item])
      return
    }
    if (frame.kind === 'approval-resolved') {
      const resolvedId = frame.approvalId ?? frame.rpcId
      if (resolvedId) setLivePending((current) => current.filter((entry) => entry.kind !== 'approval' || entry.approvalId !== resolvedId))
      return
    }
    if (frame.kind === 'question-resolved' && frame.rpcId) {
      setLivePending((current) => current.filter((entry) => entry.kind !== 'question' || entry.rpcId !== frame.rpcId))
    }
  }

  const allItems = useMemo<NeedsYouItem[]>(() => [...livePending, ...orgItems], [livePending, orgItems])
  const groups = useMemo(() => groupNeedsYouItems(allItems, organization, groupBy), [allItems, organization, groupBy])
  const orderedPresentations = useMemo(() => groups.flatMap((group) => group.items), [groups])

  useEffect(() => {
    onNeedsYouCountChange?.(allItems.length)
  }, [allItems.length, onNeedsYouCountChange])

  useEffect(() => {
    const orderedItems = orderedPresentations.map((entry) => entry.item)
    const next = selectNextNeedsYouId(orderedItems, selectedId)
    if (next !== selectedId) setSelectedId(next)
  }, [orderedPresentations, selectedId])

  const selectedPresentation = useMemo<NeedsYouPresentation | null>(
    () => orderedPresentations.find((entry) => entry.item.id === selectedId) ?? orderedPresentations[0] ?? null,
    [orderedPresentations, selectedId],
  )

  async function runBusy(id: string, work: () => Promise<void>): Promise<void> {
    if (inFlight.current.has(id)) return
    inFlight.current.add(id)
    setResponding(new Set(inFlight.current))
    try {
      await work()
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      inFlight.current.delete(id)
      setResponding(new Set(inFlight.current))
    }
  }

  async function answerApproval(item: NeedsYouApprovalItem, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    await runBusy(item.id, async () => {
      await window.ndDsh.dsh.respond(item.rpcId, { sessionId: item.sessionId, approvalId: item.approvalId, outcome })
      setLivePending((current) => current.filter((entry) => entry.id !== item.id))
    })
  }

  async function resolveOrgAction(item: NeedsYouOrganizationItem, dismiss = false): Promise<void> {
    await runBusy(item.id, async () => {
      const note = resolutionDraft[item.id]?.trim() || (dismiss ? 'Dismissed from Needs You inbox.' : 'Resolved from Needs You inbox.')
      await window.ndDshControl.mutate({
        type: 'human-action.resolve',
        id: item.sourceId,
        resolution: note,
        ...(dismiss ? { dismiss: true } : {}),
      })
      setResolutionDraft((current) => {
        const next = { ...current }
        delete next[item.id]
        return next
      })
      await refreshOrgNeedsYou()
    })
  }

  async function recheckEvidence(item: NeedsYouOrganizationItem): Promise<void> {
    if (!item.taskId) return
    await runBusy(item.id, async () => {
      await window.ndDshControl.verifyEvidence(item.taskId!)
      await refreshOrgNeedsYou()
    })
  }

  // Expanded Mail-style Split Inbox (Radix Dialog for Escape, focus trap, and WebContentsView occlusion)
  if (inboxOpen) {
    return (
      <Dialog open={inboxOpen} onOpenChange={(open) => onInboxOpenChange?.(open)}>
        <DialogContent
          showCloseButton={false}
          className="flex h-[min(640px,calc(100vh-48px))] w-[min(860px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden rounded-[10px] border border-warning/35 bg-sidebar p-0 shadow-[0_20px_60px_rgba(0,0,0,0.45)] sm:max-w-none"
        >
          <DialogTitle className="sr-only">Needs you decision inbox</DialogTitle>
          <DialogDescription className="sr-only">
            Review and resolve pending agent approvals, questions, blocking organization gates, and stale verification receipts.
          </DialogDescription>
          {/* 2px amber top bar: amber is reserved strictly for items waiting on the human */}
          <div className="h-[2px] w-full shrink-0 bg-warning" />
          <header className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border-soft bg-warning/[0.08] px-3">
            <div className="flex items-center gap-2">
              <strong className="text-[13px] font-semibold text-foreground">Needs you</strong>
              <span className="grid min-w-[20px] place-items-center rounded-full bg-warning px-1.5 py-0.5 text-[11px] font-bold text-surface-0 tabular-nums">
                {allItems.length}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div
                role="tablist"
                aria-label="Group waiting items"
                className="flex items-center rounded-md border border-border-soft bg-inset p-0.5"
              >
                {GROUP_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="tab"
                    aria-selected={groupBy === option.id}
                    className={cn(
                      'h-5 rounded-[4px] px-2 text-[11px] font-medium transition-colors',
                      groupBy === option.id
                        ? 'bg-secondary text-foreground shadow-[0_0_0_1px_var(--border-soft)]'
                        : 'text-faint hover:text-foreground',
                    )}
                    onClick={() => setGroupBy(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close Needs you inbox"
                onClick={() => onInboxOpenChange?.(false)}
              >
                <CloseIcon className="size-3.5" />
              </Button>
            </div>
          </header>

          {allItems.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-8 text-center">
              <strong className="text-sm text-foreground">All caught up</strong>
              <p className="max-w-xs text-xs text-muted-foreground">
                No agent approvals, questions, blocking gates, or stale verification receipts are waiting on you.
              </p>
            </div>
          ) : (
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(240px,300px)_minmax(0,1fr)] divide-x divide-border-soft max-[680px]:grid-cols-1">
              <div className="min-h-0 overflow-y-auto bg-sidebar">
                {groups.map((group) => (
                  <div key={group.key} className="border-b border-border-soft last:border-b-0">
                    {groupBy !== 'newest' ? (
                      <div className="sticky top-0 z-10 border-b border-border-soft bg-surface-1/90 px-3 py-1 text-[10px] font-semibold tracking-[0.06em] text-faint uppercase">
                        {group.label} · {group.items.length}
                      </div>
                    ) : null}
                    {group.items.map((entry) => {
                      const active = selectedPresentation?.item.id === entry.item.id
                      return (
                        <button
                          key={entry.item.id}
                          type="button"
                          aria-current={active ? 'true' : undefined}
                          className={cn(
                            'flex w-full flex-col gap-0.5 border-b border-border-soft px-3 py-2 text-left transition-colors last:border-b-0',
                            active
                              ? 'border-l-2 border-l-warning bg-warning/[0.09] pl-2.5'
                              : 'border-l-2 border-l-transparent hover:bg-accent/50',
                          )}
                          onClick={() => setSelectedId(entry.item.id)}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="shrink-0 rounded-full border border-warning/35 bg-warning/15 px-1.5 py-px text-[9px] font-bold tracking-[0.06em] text-warning">
                                {entry.badge}
                              </span>
                              <strong className="truncate text-xs font-medium text-foreground">
                                {entry.agentName}
                              </strong>
                            </span>
                            <span className="shrink-0 font-mono text-[10px] text-faint tabular-nums">
                              {formatRelativeAge(entry.createdAt)}
                            </span>
                          </div>
                          <span className="truncate text-[11px] font-medium text-soft">{entry.title}</span>
                          <span className="truncate text-[11px] text-muted-foreground">{entry.summary}</span>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>

              <div className="min-h-0 overflow-y-auto bg-surface-0 p-4">
                {selectedPresentation ? (
                  <InboxDetail
                    presentation={selectedPresentation}
                    organization={organization}
                    responding={responding}
                    resolutionDraft={resolutionDraft[selectedPresentation.item.id] ?? ''}
                    onResolutionDraftChange={(value) => setResolutionDraft((current) => ({ ...current, [selectedPresentation.item.id]: value }))}
                    onAnswerApproval={answerApproval}
                    onQuestionDone={(id) => setLivePending((current) => current.filter((entry) => entry.id !== id))}
                    onResolveOrgAction={resolveOrgAction}
                    onRecheckEvidence={recheckEvidence}
                    onOpenSession={(sessionId) => {
                      onInboxOpenChange?.(false)
                      onOpenSession?.(sessionId)
                    }}
                    onOpenCompany={() => {
                      onInboxOpenChange?.(false)
                      onOpenCompany?.()
                    }}
                    onError={onError}
                  />
                ) : null}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    )
  }

  // Compact docked overlay: only pops automatically for live runtime approvals/questions
  if (livePending.length === 0) return null
  return (
    <aside
      className="fixed top-3.5 right-3.5 z-20 flex max-h-[calc(100%-28px)] w-[min(390px,calc(100%-28px))] flex-col overflow-hidden rounded-[9px] border border-warning/35 bg-sidebar shadow-[0_12px_30px_rgba(0,0,0,0.28)]"
      aria-label="Runtime requests"
    >
      <div className="h-[2px] w-full shrink-0 bg-warning" />
      <header className="flex items-center justify-between gap-2 border-b border-border-soft bg-warning/10 px-2.5 py-[8px]">
        <div className="flex items-center gap-2">
          <strong className="text-xs font-semibold">Agent needs you</strong>
          <span className="grid min-w-[19px] place-items-center rounded-full bg-warning px-1 text-[11px] font-extrabold text-surface-0 tabular-nums">
            {allItems.length}
          </span>
        </div>
        {onInboxOpenChange ? (
          <button
            type="button"
            className="rounded border border-warning/35 bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning transition-colors hover:bg-warning/25"
            onClick={() => onInboxOpenChange(true)}
          >
            Open inbox{orgItems.length > 0 ? ` (+${orgItems.length})` : ''}
          </button>
        ) : null}
      </header>
      <div className="max-h-[520px] overflow-auto p-2">
        {livePending.map((item) => item.kind === 'approval'
          ? (
            <article className="mb-[7px] rounded-[7px] border border-warning/25 bg-surface-0 p-[9px] last:mb-0" key={item.id}>
              <small className="mb-[5px] block text-[11px] font-semibold tracking-[0.1em] text-warning">APPROVAL</small>
              <RequestContext sessionId={item.sessionId} organization={organization} {...(onOpenSession ? { onOpenSession } : {})} />
              <strong className="text-sm">{item.toolName}</strong>
              {item.reason ? <p className="my-[5px] text-xs leading-relaxed text-muted-foreground">{item.reason}</p> : null}
              {item.action ? <details className="my-2 text-xs"><summary className="cursor-pointer">Requested tool arguments</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-secondary p-2">{item.action}</pre></details> : null}
              <footer className="mt-2 flex justify-end gap-1.5">
                <Button variant="ghost" className={chipClasses} disabled={responding.has(item.id)} onClick={() => void answerApproval(item, 'rejected')}>Reject</Button>
                <Button variant="ghost" className={primaryChipClasses} disabled={responding.has(item.id)} onClick={() => void answerApproval(item, 'allowed-once')}>Allow once</Button>
              </footer>
            </article>
          )
          : (
            <QuestionPrompt
              key={item.id}
              item={item}
              organization={organization}
              {...(onOpenSession ? { onOpenSession } : {})}
              onDone={() => setLivePending((current) => current.filter((entry) => entry.id !== item.id))}
              onError={onError}
            />
          ))}
      </div>
    </aside>
  )
}

function InboxDetail({
  presentation,
  organization,
  responding,
  resolutionDraft,
  onResolutionDraftChange,
  onAnswerApproval,
  onQuestionDone,
  onResolveOrgAction,
  onRecheckEvidence,
  onOpenSession,
  onOpenCompany,
  onError,
}: {
  presentation: NeedsYouPresentation
  organization: OrganizationSnapshot | null
  responding: ReadonlySet<string>
  resolutionDraft: string
  onResolutionDraftChange(value: string): void
  onAnswerApproval(item: NeedsYouApprovalItem, outcome: 'allowed-once' | 'rejected'): Promise<void>
  onQuestionDone(id: string): void
  onResolveOrgAction(item: NeedsYouOrganizationItem, dismiss?: boolean): Promise<void>
  onRecheckEvidence(item: NeedsYouOrganizationItem): Promise<void>
  onOpenSession?(sessionId: string): void
  onOpenCompany?(): void
  onError(message: string): void
}) {
  const { item } = presentation
  const busy = responding.has(item.id)

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-start justify-between gap-3 border-b border-border-soft pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-warning/35 bg-warning/15 px-2 py-0.5 text-[10px] font-bold tracking-[0.08em] text-warning">
              {presentation.badge}
            </span>
            <span className="text-xs font-medium text-foreground">{presentation.agentName}</span>
            <span className="text-xs text-faint">· {presentation.projectName}</span>
            <span className="font-mono text-[11px] text-faint">· {formatRelativeAge(presentation.createdAt)}</span>
          </div>
          <h3 className="mt-1.5 text-sm font-semibold text-foreground">{presentation.title}</h3>
          {presentation.taskTitle ? (
            <p className="mt-0.5 text-xs text-muted-foreground">Task: {presentation.taskTitle}</p>
          ) : null}
          {presentation.workspace ? (
            <p className="mt-0.5 break-all font-mono text-[11px] text-faint">{presentation.workspace}</p>
          ) : null}
        </div>
        {presentation.sessionId && onOpenSession ? (
          <Button
            variant="ghost"
            className={cn(chipClasses, 'shrink-0 gap-1')}
            onClick={() => onOpenSession(presentation.sessionId!)}
          >
            <ExternalIcon className="size-3" />
            Jump to chat
          </Button>
        ) : null}
      </header>

      {item.kind === 'approval' ? (
        <div className="flex flex-col gap-2.5 rounded-lg border border-warning/30 bg-warning/[0.06] p-3">
          {item.reason ? <p className="m-0 text-xs leading-relaxed text-foreground">{item.reason}</p> : null}
          {item.action ? (
            <pre className="m-0 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border-soft bg-inset p-2.5 font-mono text-[11px] text-soft">
              {item.action}
            </pre>
          ) : null}
          <footer className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" className={chipClasses} disabled={busy} onClick={() => void onAnswerApproval(item, 'rejected')}>
              Reject
            </Button>
            <Button variant="ghost" className={amberChipClasses} disabled={busy} onClick={() => void onAnswerApproval(item, 'allowed-once')}>
              Allow once
            </Button>
          </footer>
        </div>
      ) : item.kind === 'question' ? (
        <QuestionPrompt
          item={item}
          organization={organization}
          compactContext
          onDone={() => onQuestionDone(item.id)}
          onError={onError}
        />
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border border-border-soft bg-sidebar p-3">
          <p className="m-0 whitespace-pre-wrap text-xs leading-relaxed text-foreground">{item.detail}</p>
          {item.kind === 'gate' || item.kind === 'action' ? (
            <>
              <Input
                disabled={busy}
                value={resolutionDraft}
                onChange={(event) => onResolutionDraftChange(event.target.value)}
                placeholder="Resolution note (optional)…"
                className="h-auto py-1.5 text-xs"
              />
              <footer className="flex justify-end gap-2">
                <Button variant="ghost" className={chipClasses} disabled={busy} onClick={() => void onResolveOrgAction(item, true)}>
                  Dismiss
                </Button>
                <Button variant="ghost" className={amberChipClasses} disabled={busy} onClick={() => void onResolveOrgAction(item, false)}>
                  Resolve
                </Button>
              </footer>
            </>
          ) : item.kind === 'stale-evidence' && item.taskId ? (
            <footer className="flex justify-end gap-2">
              {onOpenCompany ? (
                <Button variant="ghost" className={chipClasses} onClick={onOpenCompany}>
                  Open Control Center
                </Button>
              ) : null}
              <Button variant="ghost" className={primaryChipClasses} disabled={busy} onClick={() => void onRecheckEvidence(item)}>
                Re-check fingerprint
              </Button>
            </footer>
          ) : (
            <footer className="flex justify-end gap-2">
              {onOpenCompany ? (
                <Button variant="ghost" className={primaryChipClasses} onClick={onOpenCompany}>
                  Open Company Operations
                </Button>
              ) : null}
            </footer>
          )}
        </div>
      )}
    </div>
  )
}

function RequestContext({
  sessionId,
  organization,
  onOpenSession,
}: {
  sessionId: string
  organization: OrganizationSnapshot | null
  onOpenSession?(sessionId: string): void
}) {
  const context = runtimePromptContext(sessionId, organization)
  return (
    <div className="mb-2 text-xs text-muted-foreground">
      {context.company || context.project ? <p>{[context.company, context.project].filter(Boolean).join(' / ')}</p> : null}
      {context.worker || context.task ? <p>{[context.worker, context.task].filter(Boolean).join(' · ')}</p> : null}
      {context.workspace ? <p className="break-all">Workspace: {context.workspace}</p> : null}
      <div className="flex items-center justify-between gap-2">
        <p className="truncate font-mono text-[11px]">Session: {context.sessionId}</p>
        {onOpenSession ? (
          <button
            type="button"
            className="shrink-0 text-[11px] text-primary hover:underline"
            onClick={() => onOpenSession(sessionId)}
          >
            Jump
          </button>
        ) : null}
      </div>
    </div>
  )
}

function QuestionPrompt({
  item,
  organization,
  compactContext = false,
  onOpenSession,
  onDone,
  onError,
}: {
  item: NeedsYouQuestionItem
  organization: OrganizationSnapshot | null
  compactContext?: boolean
  onOpenSession?(sessionId: string): void
  onDone(): void
  onError(message: string): void
}) {
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const inFlight = useRef(false)
  const [responding, setResponding] = useState(false)
  async function submit(): Promise<void> {
    if (inFlight.current) return
    inFlight.current = true
    setResponding(true)
    try {
      const answers = item.questions.map((question) => ({
        id: question.id,
        selected: selections[question.id] ?? [],
        ...(custom[question.id]?.trim() ? { custom: custom[question.id]!.trim() } : {}),
      }))
      await window.ndDsh.dsh.respond(item.rpcId, { sessionId: item.sessionId, answer: { answers } })
      onDone()
    } catch (cause) { onError(errorMessage(cause)) }
    finally { inFlight.current = false; setResponding(false) }
  }
  return (
    <article className="mb-0 rounded-[7px] border border-warning/25 bg-surface-0 p-[9px]">
      {!compactContext ? (
        <>
          <small className="mb-[5px] block text-[11px] font-semibold tracking-[0.1em] text-warning">QUESTION</small>
          <RequestContext sessionId={item.sessionId} organization={organization} {...(onOpenSession ? { onOpenSession } : {})} />
        </>
      ) : null}
      {item.questions.length === 0 ? (
        <p className="my-[5px] text-xs leading-relaxed text-muted-foreground">The agent requested input. Add a response below.</p>
      ) : item.questions.map((question) => (
        <section key={question.id} className="border-b border-border-soft py-2 last:border-b-0">
          <strong className="text-sm">{question.question}</strong>
          {question.detail ? <p className="my-[5px] text-xs leading-relaxed text-muted-foreground">{question.detail}</p> : null}
          <div className="my-1.5 flex flex-wrap gap-[5px]">
            {(question.options ?? []).map((option) => {
              const selected = (selections[question.id] ?? []).includes(option.label)
              return (
                <Button
                  key={option.label}
                  variant="ghost"
                  disabled={responding}
                  className={selected ? primaryChipClasses : chipClasses}
                  onClick={() => setSelections((current) => {
                    const existing = current[question.id] ?? []
                    const next = question.multiSelect
                      ? selected ? existing.filter((value) => value !== option.label) : [...existing, option.label]
                      : [option.label]
                    return { ...current, [question.id]: next }
                  })}
                >
                  {option.label}
                </Button>
              )
            })}
          </div>
          <Input
            disabled={responding}
            value={custom[question.id] ?? ''}
            onChange={(event) => setCustom((current) => ({ ...current, [question.id]: event.target.value }))}
            placeholder="Other answer…"
            className="h-auto py-[7px] text-xs"
          />
        </section>
      ))}
      <footer className="mt-2 flex justify-end gap-1.5">
        <Button variant="ghost" className={primaryChipClasses} disabled={responding} onClick={() => void submit()}>Submit answer</Button>
      </footer>
    </article>
  )
}

function normalizeQuestions(value: unknown): AskQuestion[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const question = typeof record.question === 'string' ? record.question : typeof record.prompt === 'string' ? record.prompt : undefined
    if (!question) return []
    const options = Array.isArray(record.options) ? record.options.flatMap((option) => {
      if (typeof option === 'string') return [{ label: option }]
      if (!option || typeof option !== 'object' || typeof (option as Record<string, unknown>).label !== 'string') return []
      const optionRecord = option as Record<string, unknown>
      return [{ label: String(optionRecord.label), ...(typeof optionRecord.description === 'string' ? { description: optionRecord.description } : {}) }]
    }) : undefined
    return [{ id: typeof record.id === 'string' ? record.id : `q${index + 1}`, question, ...(typeof record.detail === 'string' ? { detail: record.detail } : {}), ...(options?.length ? { options } : {}), ...(typeof record.multiSelect === 'boolean' ? { multiSelect: record.multiSelect } : {}) }]
  })
}

function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
