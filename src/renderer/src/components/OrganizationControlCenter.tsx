import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type {
  OrganizationControlSnapshot,
  OrganizationHumanAction,
  OrganizationManagementAttentionItem,
  OrganizationManagementProjection,
  SignalDisposition,
} from '../../../shared/organization-control'
import { formatContextTokens } from '../../../shared/chat-context'
import { billedInputTokens, cacheHitRate, type UsageSummary } from '../../../shared/usage'
import { cn } from '../lib/utils'
import { Card as UiCard } from './ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

interface Props {
  companyId: string
  projectId?: string
  agents: Array<{ id: string; name: string }>
  onError(message: string): void
}

const button = cn(
  'h-7 shrink-0 rounded-md border border-border-strong bg-secondary px-[9px] text-sm text-soft transition-colors',
  'hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-45',
)
const primaryButton = cn(
  'h-7 shrink-0 rounded-md border border-primary/30 bg-primary/10 px-[9px] text-sm font-medium text-primary transition-colors',
  'hover:bg-primary/[0.16] disabled:pointer-events-none disabled:opacity-45',
)
const input = cn(
  'min-w-0 rounded-md border border-border-strong bg-background px-[9px] py-[7px] text-sm text-foreground outline-none',
  'focus:border-primary/40',
)

export function OrganizationControlCenter({ companyId, projectId, agents, onError }: Props) {
  const [control, setControl] = useState<OrganizationControlSnapshot | null>(null)
  const [management, setManagement] = useState<OrganizationManagementProjection | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [humanDraft, setHumanDraft] = useState({ kind: 'action' as 'action' | 'gate', title: '', question: '', scope: '' })
  const [signalDraft, setSignalDraft] = useState({ source: 'user', title: '', summary: '' })
  const [budgetDraft, setBudgetDraft] = useState({ turns: '', dailyCost: '', monthlyCost: '', workers: '' })
  const [usage, setUsage] = useState<UsageSummary | null>(null)

  // Token accounting for this project (or the whole company when the view is
  // company-wide). Cache hit rate is the number that decides what a turn
  // costs, and only ND's ledger can answer it across sessions.
  const usageQuery = useMemo(
    () => (projectId ? { scope: 'project' as const, id: projectId } : { scope: 'company' as const, id: companyId }),
    [companyId, projectId],
  )

  const refresh = useCallback(async (): Promise<void> => {
    const [state, projection, tokens] = await Promise.all([
      window.ndDshControl.state(),
      window.ndDshControl.management(projectId),
      window.ndDshUsage.summary(usageQuery.scope, usageQuery.id),
    ])
    setControl(state)
    setManagement(projection)
    setUsage(tokens)
  }, [projectId, usageQuery])

  useEffect(() => {
    let mounted = true
    void Promise.all([
      window.ndDshControl.state(),
      window.ndDshControl.management(projectId),
      window.ndDshUsage.summary(usageQuery.scope, usageQuery.id),
    ])
      .then(([state, projection, tokens]) => {
        if (!mounted) return
        setControl(state)
        setManagement(projection)
        setUsage(tokens)
        const budget = projection.budgets.find((item) => item.projectId === projectId)
          ?? projection.budgets.find((item) => !item.projectId)
        if (budget) setBudgetDraft({
          turns: budget.dailyTurnLimit === undefined ? '' : String(budget.dailyTurnLimit),
          dailyCost: budget.dailyCostUsd === undefined ? '' : String(budget.dailyCostUsd),
          monthlyCost: budget.monthlyCostUsd === undefined ? '' : String(budget.monthlyCostUsd),
          workers: budget.maxParallelWorkers === undefined ? '' : String(budget.maxParallelWorkers),
        })
      })
      .catch((cause) => onError(errorMessage(cause)))
    const off = window.ndDshControl.onChanged(() => {
      if (!mounted) return
      void refresh().catch((cause) => onError(errorMessage(cause)))
    })
    return () => { mounted = false; off() }
  }, [onError, projectId, refresh, usageQuery])

  const actions = useMemo(() => control?.humanActions.filter((item) => item.companyId === companyId && (!projectId || !item.projectId || item.projectId === projectId)) ?? [], [control, companyId, projectId])
  const signals = useMemo(() => control?.signals.filter((item) => item.companyId === companyId && (!projectId || !item.projectId || item.projectId === projectId)) ?? [], [control, companyId, projectId])
  const evidence = useMemo(() => control?.evidence.filter((item) => item.companyId === companyId && (!projectId || item.projectId === projectId)) ?? [], [control, companyId, projectId])

  async function act(key: string, fn: () => Promise<unknown>): Promise<void> {
    if (busy) return
    setBusy(key)
    try { await fn(); await refresh() } catch (cause) { onError(errorMessage(cause)) } finally { setBusy(null) }
  }

  async function createHumanAction(event: FormEvent): Promise<void> {
    event.preventDefault()
    const scope = humanDraft.scope.trim()
    await act('human-add', async () => {
      await window.ndDshControl.mutate({
        type: 'human-action.add', companyId, ...(projectId ? { projectId } : {}), kind: humanDraft.kind,
        title: humanDraft.title, question: humanDraft.question, ...(scope ? { scopes: [scope] } : {}),
      })
      setHumanDraft({ kind: 'action', title: '', question: '', scope: '' })
    })
  }

  async function createSignal(event: FormEvent): Promise<void> {
    event.preventDefault()
    await act('signal-add', async () => {
      await window.ndDshControl.mutate({
        type: 'signal.add', companyId, ...(projectId ? { projectId } : {}),
        source: signalDraft.source, title: signalDraft.title, summary: signalDraft.summary,
      })
      setSignalDraft({ source: 'user', title: '', summary: '' })
    })
  }

  async function saveBudget(event: FormEvent): Promise<void> {
    event.preventDefault()
    await act('budget-save', () => window.ndDshControl.mutate({
      type: 'budget.set', companyId, ...(projectId ? { projectId } : {}),
      ...(budgetDraft.turns.trim() ? { dailyTurnLimit: Number(budgetDraft.turns) } : {}),
      ...(budgetDraft.dailyCost.trim() ? { dailyCostUsd: Number(budgetDraft.dailyCost) } : {}),
      ...(budgetDraft.monthlyCost.trim() ? { monthlyCostUsd: Number(budgetDraft.monthlyCost) } : {}),
      ...(budgetDraft.workers.trim() ? { maxParallelWorkers: Number(budgetDraft.workers) } : {}),
    }))
  }

  return (
    <div className="grid grid-cols-1 gap-2.5 pb-8 min-[1100px]:grid-cols-2">
      <ControlCard title="Needs You" badge={String(management?.metrics.openHumanActions ?? 0)}>
        {management?.needsYou.length ? management.needsYou.map((item) => (
          <div key={item.id} className="border-b border-border-soft py-2 last:border-b-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={cn('rounded-full border px-1.5 py-0.5 text-[10px] font-bold uppercase', item.kind === 'gate' ? 'border-warning/30 bg-warning/[0.08] text-warning' : item.kind === 'stale-evidence' ? 'border-destructive/30 bg-destructive/[0.06] text-destructive' : 'border-border-strong bg-secondary text-faint')}>{item.kind}</span>
                  <strong className="text-sm">{item.title}</strong>
                </div>
                <p className="m-0 mt-1 text-xs/[1.45] text-muted-foreground">{item.detail}</p>
              </div>
              {item.kind === 'gate' || item.kind === 'action' ? (
                <button className={button} disabled={busy !== null} onClick={() => void resolveAction(item.id)}>Resolve</button>
              ) : item.kind === 'stale-evidence' && item.taskId ? (
                <button className={button} disabled={busy !== null} onClick={() => void act(`verify-${item.taskId}`, () => window.ndDshControl.verifyEvidence(item.taskId!))}>Re-check</button>
              ) : item.kind === 'failed-run' && item.runKind ? (
                <button className={button} disabled={busy !== null} onClick={() => void act(`retry-${item.id}`, () => retryFailedRun(item))}>Retry</button>
              ) : null}
            </div>
          </div>
        )) : <Empty text="No human judgment is blocking or requesting attention." />}
      </ControlCard>

      <ControlCard title="Verification" badge={`${management?.metrics.verifiedTasks ?? 0} verified`}>
        <div className="grid grid-cols-3 gap-2 pb-2">
          <Metric label="Verified" value={management?.metrics.verifiedTasks ?? 0} />
          <Metric label="Ready review" value={management?.readyToReviewTaskIds.length ?? 0} />
          <Metric label="Stale" value={management?.staleEvidenceTaskIds.length ?? 0} />
        </div>
        {evidence.slice(0, 8).map((item) => (
          <div key={item.id} className="flex items-center justify-between gap-2 border-t border-border-soft py-2 text-xs">
            <div className="min-w-0">
              <strong className="block truncate font-mono text-[11px]">{item.taskId}</strong>
              <span className="text-faint">
                {item.changedFiles.length} files · {item.exact ? 'exact Git receipt' : 'weak evidence'}
                {item.risk?.changedLines !== null && item.risk?.changedLines !== undefined ? ` · ${item.risk.changedLines} lines` : ''}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {item.risk ? (
                <span
                  className={cn('rounded-full border px-1.5 py-0.5 text-[10px] font-bold uppercase', riskClass(item.risk.level))}
                  title={[item.risk.reason, ...item.risk.safeguards].filter(Boolean).join('\n')}
                >
                  {item.risk.level} {item.risk.score}/10
                </span>
              ) : null}
              <span className={cn('rounded-full border px-1.5 py-0.5 text-[10px] font-bold uppercase', evidenceClass(item.status))}>{item.status.replace('_', ' ')}</span>
            </div>
          </div>
        ))}
        {!evidence.length ? <Empty text="Evidence receipts appear when tasks enter independent review." /> : null}
      </ControlCard>

      <ControlCard title="Human Action / Gate">
        <form className="grid gap-2" onSubmit={(event) => void createHumanAction(event)}>
          <div className="grid grid-cols-[120px_1fr] gap-2">
            <Select value={humanDraft.kind} onValueChange={(value) => setHumanDraft((current) => ({ ...current, kind: value as 'action' | 'gate' }))}>
              <SelectTrigger className="h-auto min-h-9 rounded-md border-border-strong bg-background px-[9px] text-sm"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="action">Action</SelectItem><SelectItem value="gate">Blocking gate</SelectItem></SelectContent>
            </Select>
            <input className={input} placeholder="Short title" value={humanDraft.title} onChange={(event) => setHumanDraft((current) => ({ ...current, title: event.target.value }))} required />
          </div>
          <textarea className={cn(input, 'min-h-[66px] resize-y')} placeholder="What human judgment or action is needed?" value={humanDraft.question} onChange={(event) => setHumanDraft((current) => ({ ...current, question: event.target.value }))} required />
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input className={input} placeholder="Optional scope: task.execute, task.review, *" value={humanDraft.scope} onChange={(event) => setHumanDraft((current) => ({ ...current, scope: event.target.value }))} />
            <button className={primaryButton} disabled={busy !== null}>Add</button>
          </div>
        </form>
        {actions.filter((item) => item.status === 'open').slice(0, 5).map((item) => <ActionLine key={item.id} action={item} />)}
      </ControlCard>

      <ControlCard title="AI Budget">
        <form className="grid gap-2" onSubmit={(event) => void saveBudget(event)}>
          <label className="grid gap-1 text-xs text-muted-foreground">Daily bounded turns
            <input className={input} type="number" min="0" step="1" placeholder="Unlimited" value={budgetDraft.turns} onChange={(event) => setBudgetDraft((current) => ({ ...current, turns: event.target.value }))} />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">Daily actual cash cap (USD)
            <input className={input} type="number" min="0" step="0.01" placeholder="Unlimited" value={budgetDraft.dailyCost} onChange={(event) => setBudgetDraft((current) => ({ ...current, dailyCost: event.target.value }))} />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">Monthly actual cash cap (USD)
            <input className={input} type="number" min="0" step="0.01" placeholder="Unlimited" value={budgetDraft.monthlyCost} onChange={(event) => setBudgetDraft((current) => ({ ...current, monthlyCost: event.target.value }))} />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">Max parallel workers (capacity target)
            <input className={input} type="number" min="1" step="1" placeholder="Current engine limit" value={budgetDraft.workers} onChange={(event) => setBudgetDraft((current) => ({ ...current, workers: event.target.value }))} />
          </label>
          <button className={primaryButton} disabled={busy !== null}>Save budget</button>
        </form>
        {(management?.budgets ?? []).map((item) => (
          <p key={item.id} className="m-0 mt-2 rounded-md border border-border-soft bg-surface-0 px-2 py-1.5 text-xs text-muted-foreground">
            Used <strong className="text-foreground">{item.spentTurns}</strong>{item.dailyTurnLimit === undefined ? '' : ` / ${item.dailyTurnLimit}`} turns in the current window.
            {' '}Cash: <strong className="text-foreground">{item.cashAccountingKnown ? `${item.spentCostUsd.toFixed(2)} today · ${item.spentMonthlyCostUsd.toFixed(2)} month` : 'accounting unavailable'}</strong>.
          </p>
        ))}
        {usage ? <UsageLine usage={usage} projectScoped={Boolean(projectId)} /> : null}
      </ControlCard>

      <ControlCard title="Signal Inbox" badge={`${management?.metrics.newSignals ?? 0} new`} wide>
        <form className="mb-2 grid grid-cols-[140px_1fr_2fr_auto] gap-2" onSubmit={(event) => void createSignal(event)}>
          <input className={input} placeholder="Source" value={signalDraft.source} onChange={(event) => setSignalDraft((current) => ({ ...current, source: event.target.value }))} required />
          <input className={input} placeholder="Feedback / issue title" value={signalDraft.title} onChange={(event) => setSignalDraft((current) => ({ ...current, title: event.target.value }))} required />
          <input className={input} placeholder="What happened?" value={signalDraft.summary} onChange={(event) => setSignalDraft((current) => ({ ...current, summary: event.target.value }))} required />
          <button className={primaryButton} disabled={busy !== null}>Capture</button>
        </form>
        {signals.slice(0, 12).map((item) => (
          <div key={item.id} className="grid grid-cols-[1fr_auto] gap-2 border-t border-border-soft py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5"><small className="uppercase text-primary">{item.source}</small><strong className="truncate text-sm">{item.title}</strong></div>
              <p className="m-0 mt-0.5 text-xs/[1.45] text-muted-foreground">{item.summary}</p>
            </div>
            <Select value={item.disposition ?? 'new'} disabled={busy !== null} onValueChange={(value) => void triageSignal(item.id, value as SignalDisposition)}>
              <SelectTrigger className="h-7 w-[130px] rounded-md border-border-strong bg-secondary px-2 text-[11px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="new" disabled>New</SelectItem>
                <SelectItem value="evidence">Keep evidence</SelectItem>
                <SelectItem value="task">Create task path</SelectItem>
                <SelectItem value="objective">Promote objective</SelectItem>
                <SelectItem value="ask-human">Ask human</SelectItem>
                <SelectItem value="ignore">Ignore</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ))}
        {!signals.length ? <Empty text="Customer feedback, issues, QA failures and discoveries can be captured here before becoming tasks." /> : null}
      </ControlCard>

      <ControlCard title="AI Employee Performance" wide>
        <div className="grid grid-cols-1 gap-2 min-[900px]:grid-cols-2 min-[1300px]:grid-cols-4">
          {(management?.performance ?? []).map((item) => (
            <div key={item.agentId} className="rounded-md border border-border-soft bg-surface-0 p-2.5">
              <strong className="text-sm">{agents.find((agent) => agent.id === item.agentId)?.name ?? item.agentId}</strong>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <Metric label="Completed" value={item.completedTasks} />
                <Metric label="Blocked" value={item.failedOrBlockedTasks} />
                <Metric label="Pass rate" value={item.reviewPassRate === null ? '—' : `${item.reviewPassRate}%`} />
                <Metric label="Attention" value={item.humanAttentionEvents} />
              </div>
              <small className="mt-2 block text-faint">{item.turns} bounded turns</small>
            </div>
          ))}
        </div>
      </ControlCard>
    </div>
  )

  function retryFailedRun(item: OrganizationManagementAttentionItem): Promise<unknown> {
    if (item.runKind === 'pm-plan' && item.projectId) return window.ndDshOrganization.planProject(item.projectId)
    if (item.runKind === 'task-review' && item.taskId) return window.ndDshOrganization.reviewTask(item.taskId)
    if (item.taskId) return window.ndDshOrganization.runTask(item.taskId)
    return Promise.reject(new Error('This failed run has no task or project to retry.'))
  }

  async function resolveAction(id: string): Promise<void> {
    await act(`resolve-${id}`, () => window.ndDshControl.mutate({ type: 'human-action.resolve', id, resolution: 'Resolved by company operator in ND.' }))
  }

  async function triageSignal(id: string, disposition: SignalDisposition): Promise<void> {
    await act(`signal-${id}`, () => window.ndDshControl.mutate({ type: 'signal.triage', id, disposition, ...(disposition === 'ignore' ? { archive: true } : {}) }))
  }
}

function ControlCard({ title, badge, wide = false, children }: { title: string; badge?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <UiCard className={cn('gap-0 overflow-hidden rounded-[9px] border-border-soft bg-sidebar py-0 shadow-none', wide && 'col-span-full')}>
      <header className="flex min-h-10 items-center justify-between border-b border-border-soft px-[11px]">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        {badge ? <span className="rounded-full border border-border-strong bg-secondary px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">{badge}</span> : null}
      </header>
      <div className="px-[11px] py-[9px]">{children}</div>
    </UiCard>
  )
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded-md border border-border-soft bg-secondary px-2 py-1.5"><small className="block text-[10px] uppercase text-faint">{label}</small><strong className="text-sm">{value}</strong></div>
}

function ActionLine({ action }: { action: OrganizationHumanAction }) {
  return <div className="mt-2 border-t border-border-soft pt-2 text-xs"><strong>{action.title}</strong><p className="m-0 mt-0.5 text-muted-foreground">{action.question}</p></div>
}

function Empty({ text }: { text: string }) { return <p className="px-1 py-5 text-center text-sm text-faint">{text}</p> }

/**
 * What the turns in the budget window actually cost.
 *
 * Cache hit rate is the share of billed input the provider served from its
 * prefix cache, so raising it is the cheapest way to cut spend on repeated
 * instructions, tool catalogs, and project memory.
 */
function UsageLine({ usage, projectScoped }: { usage: UsageSummary; projectScoped: boolean }) {
  const hitRate = cacheHitRate(usage.totals)
  const scopeLabel = projectScoped ? 'this project' : 'this company'
  if (usage.totals.steps === 0) {
    return <p className="m-0 mt-2 rounded-md border border-border-soft bg-surface-0 px-2 py-1.5 text-xs text-muted-foreground">No model calls recorded for {scopeLabel} yet.</p>
  }
  return (
    <div className="mt-2 grid gap-1 rounded-md border border-border-soft bg-surface-0 px-2 py-1.5 text-xs text-muted-foreground">
      <p className="m-0">
        Cache hit rate <strong className="text-foreground">{hitRate === undefined ? '—' : `${hitRate.toFixed(0)}%`}</strong>
        {' '}over <strong className="text-foreground">{usage.totals.steps}</strong> model calls in <strong className="text-foreground">{usage.attributedSessions}</strong> {usage.attributedSessions === 1 ? 'session' : 'sessions'}.
      </p>
      <p className="m-0">
        Billed input {formatContextTokens(billedInputTokens(usage.totals))}, of which {formatContextTokens(usage.totals.cacheReadTokens)} was cached; output {formatContextTokens(usage.totals.outputTokens)}. The rest of the billed input ({formatContextTokens(usage.totals.uncachedInputTokens + usage.totals.cacheWriteTokens)}) was paid at full price.
      </p>
      {usage.unattributedSessions > 0
        ? <p className="m-0">Chat sessions with no organization run are not part of {scopeLabel}'s totals.</p>
        : null}
    </div>
  )
}
function evidenceClass(status: string): string {
  if (status === 'verified') return 'border-primary/30 bg-primary/10 text-primary'
  if (status === 'pending_review') return 'border-info/30 bg-info/10 text-info'
  return 'border-destructive/30 bg-destructive/[0.06] text-destructive'
}
function riskClass(level: 'low' | 'medium' | 'high'): string {
  if (level === 'low') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (level === 'medium') return 'border-warning/35 bg-warning/10 text-warning'
  return 'border-destructive/35 bg-destructive/10 text-destructive'
}
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
