import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type {
  OrganizationBudget,
  OrganizationControlAction,
  OrganizationControlMutation,
  OrganizationControlSnapshot,
  OrganizationEvidenceReceipt,
  OrganizationHumanAction,
  OrganizationManagementProjection,
  OrganizationReviewFeedback,
  OrganizationSignal,
  OrganizationTaskLease,
  OrganizationTurnDecision,
  OrganizationTurnRecord,
  OrganizationTurnResultKind,
} from '../../shared/organization-control.js'
import { assessDiffRisk, type DiffRiskSelfReview } from '../../shared/diff-risk.js'
import type { OrganizationRun, OrganizationRunKind, OrganizationRunReceipt, OrganizationSnapshot } from '../../shared/organization.js'
import type { OrganizationStore } from './store.js'
import { unavailableEvidenceCapturer, type WorkspaceEvidenceCapture } from './worktree-evidence.js'
import type { ExecutionCoordinator, RuntimeAvailability, RuntimePoolClaim } from './execution-coordinator.js'
import type { ComputeLedger } from '../compute/compute-ledger.js'

const DAY_MS = 24 * 60 * 60 * 1_000
const DEFAULT_LEASE_MS = 30 * 60 * 1_000
/**
 * How many of one project's tasks may execute at the same time when the company
 * has not set its own budget.
 *
 * Each worker costs a Git worktree plus an engine session. Measured by the
 * agent-task benchmark's matched sequential/parallel arms, four identical tasks
 * dispatched together finish in about a quarter of the sequential wall time
 * (speedup 3.82 of a theoretical 4) while per-task wall cost rises ~5% and
 * per-task nd-core IPC crossings stay exactly flat — so the ceiling is disk and
 * provider concurrency rather than ND's own overhead.
 *
 * Those tasks all ran on the single seeded Builder agent, which is worth
 * knowing before assuming a wider ceiling needs a wider workforce.
 *
 * This bounds *simultaneous* runs, not how many tasks a user may start: an
 * explicit dispatch beyond the ceiling waits for a slot instead of failing.
 */
const DEFAULT_MAX_PARALLEL_WORKERS = 4
const DEFAULT_MAX_REVIEW_WORKERS = 2
const EMPTY: OrganizationControlSnapshot = {
  version: 1,
  turns: [],
  humanActions: [],
  signals: [],
  budgets: [],
  leases: [],
  evidence: [],
  feedback: [],
}

/**
 * ND-owned durable control state layered over organization.json. Agent runtimes
 * remain disposable executors; this sidecar owns the bounded-turn, attention,
 * quota, lease and evidence semantics that must survive sessions and engines.
 */
export class OrganizationControlPlane {
  private loaded = false
  private loadPromise: Promise<void> | undefined
  private value: OrganizationControlSnapshot = clone(EMPTY)
  private saveChain: Promise<void> = Promise.resolve()
  private pendingSave: Promise<void> | undefined
  private onChanged: ((state: OrganizationControlSnapshot) => void) | undefined

  constructor(
    private readonly filePath: string,
    private readonly store: Pick<OrganizationStore, 'state' | 'taskContext'>,
    private readonly computeLedger?: Pick<ComputeLedger, 'cashSummary' | 'management'>,
    /** Exact task-worktree capture; without nd-core every receipt is inexact and review fails closed. */
    private readonly captureTaskEvidence: (projectWorkspace: string | undefined, taskId: string) => Promise<WorkspaceEvidenceCapture> =
      (projectWorkspace) => unavailableEvidenceCapturer(projectWorkspace),
  ) {}

  setOnChanged(listener: ((state: OrganizationControlSnapshot) => void) | undefined): void {
    this.onChanged = listener
  }

  async state(): Promise<OrganizationControlSnapshot> {
    await this.sync()
    return clone(this.value)
  }

  async pruneToOrganization(organization: OrganizationSnapshot): Promise<void> {
    await this.load()
    const companyIds = new Set(organization.companies.map((item) => item.id))
    const projectIds = new Set(organization.projects.map((item) => item.id))
    const taskIds = new Set(organization.tasks.map((item) => item.id))
    const before = controlRowCount(this.value)
    const scopeExists = (item: { companyId: string; projectId?: string }): boolean =>
      companyIds.has(item.companyId) && (!item.projectId || projectIds.has(item.projectId))
    this.value.turns = this.value.turns.filter((item) => scopeExists(item) && (!item.taskId || taskIds.has(item.taskId)))
    this.value.humanActions = this.value.humanActions.filter(scopeExists)
    this.value.signals = this.value.signals.filter(scopeExists)
    this.value.budgets = this.value.budgets.filter(scopeExists)
    this.value.leases = this.value.leases.filter((item) => scopeExists(item) && taskIds.has(item.taskId))
    this.value.evidence = this.value.evidence.filter((item) => scopeExists(item) && taskIds.has(item.taskId))
    this.value.feedback = this.value.feedback.filter((item) => scopeExists(item) && (!item.taskId || taskIds.has(item.taskId)))
    if (controlRowCount(this.value) !== before) await this.save()
  }

  async mutate(mutation: OrganizationControlMutation): Promise<OrganizationControlSnapshot> {
    await this.load()
    const organization = await this.store.state()
    switch (mutation.type) {
      case 'human-action.add': this.addHumanAction(organization, mutation); break
      case 'human-action.resolve': this.resolveHumanAction(mutation.id, mutation.resolution, Boolean(mutation.dismiss)); break
      case 'signal.add': this.addSignal(organization, mutation); break
      case 'signal.triage': this.triageSignal(mutation.id, mutation.disposition, Boolean(mutation.archive)); break
      case 'budget.set': this.setBudget(organization, mutation); break
      case 'feedback.add': this.addFeedback(organization, mutation); break
    }
    await this.save()
    return clone(this.value)
  }

  async shouldRun(projectId: string | undefined, action: OrganizationControlAction, taskId?: string): Promise<OrganizationTurnDecision> {
    await this.sync()
    const organization = await this.store.state()
    const project = projectId
      ? organization.projects.find((item) => item.id === projectId)
      : organization.projects.find((item) => item.id === organization.activeProjectId)
    if (!project) throw new Error('No active project')
    const company = organization.companies.find((item) => item.id === project.companyId)
    if (!company) throw new Error('Project company not found')

    const gates = this.value.humanActions.filter((item) => item.companyId === company.id
      && item.kind === 'gate'
      && item.status === 'open'
      && (!item.projectId || item.projectId === project.id)
      && gateBlocks(item, action, project.id, taskId))
    if (gates.length) {
      return {
        route: 'human_action_required', action, companyId: company.id, projectId: project.id,
        ...(taskId ? { taskId } : {}),
        reason: gates[0]?.question ?? 'Human judgment is required before this work can continue.',
        humanActionIds: gates.map((item) => item.id), checkedAt: Date.now(),
      }
    }

    const budget = this.effectiveBudget(company.id, project.id)
    if (budget && (budget.dailyCostUsd !== undefined || budget.monthlyCostUsd !== undefined) && !this.computeLedger) {
      return {
        route: 'wait', action, companyId: company.id, projectId: project.id,
        ...(taskId ? { taskId } : {}),
        reason: 'Cash budget enforcement requires compute accounting to be configured.',
        humanActionIds: [], budgetId: budget.id, checkedAt: Date.now(),
      }
    }
    if (budget && (budget.dailyCostUsd !== undefined || budget.monthlyCostUsd !== undefined) && budget.cashAccountingKnown === false) {
      return {
        route: 'wait', action, companyId: company.id, projectId: project.id,
        ...(taskId ? { taskId } : {}),
        reason: 'Cash accounting is unavailable or stale; paid work is blocked conservatively.',
        humanActionIds: [], budgetId: budget.id, checkedAt: Date.now(),
      }
    }
    if (budget?.dailyCostUsd !== undefined && budget.spentCostUsd >= budget.dailyCostUsd) {
      return {
        route: 'wait', action, companyId: company.id, projectId: project.id,
        ...(taskId ? { taskId } : {}),
        reason: `Daily cash budget exhausted (${budget.spentCostUsd.toFixed(2)}/${budget.dailyCostUsd.toFixed(2)}).`,
        humanActionIds: [], budgetId: budget.id, checkedAt: Date.now(),
      }
    }
    if (budget?.monthlyCostUsd !== undefined && budget.spentMonthlyCostUsd >= budget.monthlyCostUsd) {
      return {
        route: 'wait', action, companyId: company.id, projectId: project.id,
        ...(taskId ? { taskId } : {}),
        reason: `Monthly cash budget exhausted (${budget.spentMonthlyCostUsd.toFixed(2)}/${budget.monthlyCostUsd.toFixed(2)}).`,
        humanActionIds: [], budgetId: budget.id, checkedAt: Date.now(),
      }
    }
    if (budget?.dailyTurnLimit !== undefined && budget.spentTurns >= budget.dailyTurnLimit) {
      return {
        route: 'wait', action, companyId: company.id, projectId: project.id,
        ...(taskId ? { taskId } : {}),
        reason: `Daily agent-turn budget exhausted (${budget.spentTurns}/${budget.dailyTurnLimit}).`,
        humanActionIds: [], budgetId: budget.id, checkedAt: Date.now(),
      }
    }

    if (taskId && action === 'task.execute') {
      const task = organization.tasks.find((item) => item.id === taskId)
      if (task?.workScopes?.length) {
        const runningTaskIds = new Set(organization.runs
          .filter((item) => item.status === 'running' && item.projectId === project.id && item.taskId && item.taskId !== taskId && item.kind === 'task-execution')
          .map((item) => item.taskId as string))
        const conflict = organization.tasks.find((item) => runningTaskIds.has(item.id) && scopesOverlap(task.workScopes ?? [], item.workScopes ?? []))
        if (conflict) {
          return {
            route: 'wait', action, companyId: company.id, projectId: project.id, taskId,
            reason: `Declared work scope overlaps active task “${conflict.title}”; ND is serializing these advisory scopes to reduce merge conflicts.`,
            humanActionIds: [], ...(budget ? { budgetId: budget.id } : {}), checkedAt: Date.now(),
          }
        }
      }
    }

    if (taskId) {
      const lease = this.value.leases.find((item) => item.taskId === taskId && item.status === 'active' && item.expiresAt > Date.now())
      if (lease) {
        return {
          route: 'wait', action, companyId: company.id, projectId: project.id, taskId,
          reason: `Task is leased by ${lease.ownerId} until ${new Date(lease.expiresAt).toISOString()}.`,
          humanActionIds: [], ...(budget ? { budgetId: budget.id } : {}), checkedAt: Date.now(),
        }
      }
    }

    return {
      route: 'ready', action, companyId: company.id, projectId: project.id,
      ...(taskId ? { taskId } : {}),
      reason: 'Current gates, task ownership and compute budget allow one bounded turn.',
      humanActionIds: [], ...(budget ? { budgetId: budget.id } : {}), checkedAt: Date.now(),
    }
  }

  async assertRunnable(projectId: string | undefined, action: OrganizationControlAction, taskId?: string): Promise<OrganizationTurnDecision> {
    const decision = await this.shouldRun(projectId, action, taskId)
    if (decision.route !== 'ready') throw new Error(decision.reason)
    return decision
  }

  async runtimeClaims(projectId: string, action: 'task.execute' | 'task.review', taskId: string): Promise<RuntimePoolClaim[]> {
    await this.sync()
    const organization = await this.store.state()
    const project = organization.projects.find((item) => item.id === projectId)
    if (!project) throw new Error('Project not found')
    const task = organization.tasks.find((item) => item.id === taskId && item.projectId === projectId)
    if (!task) throw new Error('Task not found')
    const budget = this.effectiveBudget(project.companyId, project.id)

    if (action === 'task.review') {
      return [{
        key: `project:${project.id}:review`,
        limit: budget?.maxReviewWorkers ?? DEFAULT_MAX_REVIEW_WORKERS,
      }]
    }

    const claims: RuntimePoolClaim[] = [{
      key: `project:${project.id}:execution`,
      limit: budget?.maxParallelWorkers ?? DEFAULT_MAX_PARALLEL_WORKERS,
    }]
    const agent = task.assignedAgentId
      ? organization.agents.find((item) => item.id === task.assignedAgentId)
      : undefined
    if (agent) {
      const roleLimit = budget?.roleWorkerLimits?.[agent.roleId]
      if (roleLimit !== undefined) claims.push({ key: `project:${project.id}:role:${agent.roleId}`, limit: roleLimit })
      if (agent.teamId) {
        const teamLimit = budget?.teamWorkerLimits?.[agent.teamId]
        if (teamLimit !== undefined) claims.push({ key: `project:${project.id}:team:${agent.teamId}`, limit: teamLimit })
      }
    }
    return claims
  }

  async noteDispatch(receipt: OrganizationRunReceipt): Promise<void> {
    await this.load()
    const organization = await this.store.state()
    const run = organization.runs.find((item) => item.id === receipt.runId)
    if (!run) return
    let changed = false
    if (!this.value.turns.some((item) => item.runId === run.id)) {
      const action = actionForRun(run.kind)
      const record: OrganizationTurnRecord = {
        id: randomUUID(), runId: run.id, sessionId: run.sessionId, action,
        route: 'ready', companyId: run.companyId, projectId: run.projectId,
        ...(run.taskId ? { taskId: run.taskId } : {}),
        reason: 'Bounded organization run dispatched.', humanActionIds: [],
        startedAt: run.startedAt, checkedAt: Date.now(),
      }
      this.value.turns.unshift(record)
      this.consumeBudget(run.companyId, run.projectId, run.startedAt)
      changed = true
    }
    if (run.kind === 'task-execution' && run.taskId) changed = this.ensureLease(run, organization) || changed
    if (run.kind === 'task-review' && run.taskId) changed = await this.ensureEvidence(run.taskId) || changed
    if (changed) await this.save()
  }

  async verifyEvidence(taskId: string): Promise<OrganizationEvidenceReceipt | null> {
    await this.load()
    const latest = this.value.evidence.find((item) => item.taskId === taskId && item.status === 'pending_review')
    if (!latest) return null
    const context = await this.store.taskContext(taskId)
    const current = await this.captureTaskEvidence(context.project.workspacePath, taskId)
    latest.status = !latest.exact || !current.exact
      ? 'failed'
      : current.fingerprint === latest.fingerprint ? 'verified' : 'stale'
    if (latest.status !== 'verified') latest.invalidatedAt = Date.now()
    const preservedSelfReview: DiffRiskSelfReview | undefined = latest.status === 'verified' && latest.risk?.agentScore !== null && latest.risk?.agentScore !== undefined
      ? {
          score: latest.risk.agentScore,
          requiresHumanReview: latest.risk.requiresHumanReview,
          reason: latest.risk.reason,
          ...(latest.risk.factors.length ? { factors: latest.risk.factors } : {}),
        }
      : undefined
    latest.risk = assessDiffRisk(
      {
        files: current.changedFiles.length ? current.changedFiles : latest.changedFiles,
        changedLines: latest.risk?.changedLines ?? null,
        binary: latest.risk?.binary ?? false,
        fingerprint: current.fingerprint,
        exact: latest.exact && current.exact,
      },
      preservedSelfReview,
    )
    latest.reviewSummary = latest.status === 'verified'
      ? 'Exact task-worktree fingerprint still matches the review receipt.'
      : latest.status === 'stale'
        ? 'Task worktree changed after the review evidence was captured; re-review is required.'
        : 'Exact Git task-worktree evidence was unavailable; completion cannot be strongly verified.'
    await this.save()
    return clone(latest)
  }

  /**
   * Bind a reviewer's self-assessment and optional diff stats to the newest
   * evidence receipt for a task, enforcing the deterministic risk floor.
   */
  async recordEvidenceRisk(
    taskId: string,
    selfReview: DiffRiskSelfReview | undefined,
    stats?: { files?: readonly string[]; changedLines?: number | null; binary?: boolean; fingerprint?: string; exact?: boolean },
  ): Promise<OrganizationEvidenceReceipt | null> {
    await this.load()
    const latest = this.value.evidence.find((item) => item.taskId === taskId)
    if (!latest) return null
    const fingerprint = stats?.fingerprint ?? latest.fingerprint
    const exact = (stats?.exact ?? latest.exact) && fingerprint === latest.fingerprint
    latest.risk = assessDiffRisk(
      {
        files: stats?.files?.length ? stats.files : latest.changedFiles,
        changedLines: stats?.changedLines ?? latest.risk?.changedLines ?? null,
        binary: stats?.binary ?? latest.risk?.binary ?? false,
        fingerprint,
        exact,
      },
      selfReview,
    )
    await this.save()
    return clone(latest)
  }

  async management(projectId?: string): Promise<OrganizationManagementProjection> {
    await this.sync()
    const organization = await this.store.state()
    const project = projectId
      ? organization.projects.find((item) => item.id === projectId)
      : organization.projects.find((item) => item.id === organization.activeProjectId)
    const companyId = project?.companyId ?? organization.activeCompanyId
    const projectFilter = (id: string | undefined): boolean => !project || id === undefined || id === project.id
    const companyFilter = (id: string): boolean => !companyId || id === companyId
    const scopedTasks = organization.tasks.filter((item) => companyFilter(item.companyId) && (!project || item.projectId === project.id))
    const scopedRuns = organization.runs.filter((item) => companyFilter(item.companyId) && (!project || item.projectId === project.id))
    const scopedActions = this.value.humanActions.filter((item) => companyFilter(item.companyId) && projectFilter(item.projectId))
    const scopedSignals = this.value.signals.filter((item) => companyFilter(item.companyId) && projectFilter(item.projectId))
    const scopedEvidence = this.value.evidence.filter((item) => companyFilter(item.companyId) && (!project || item.projectId === project.id))
    const verifiedTaskIds = Array.from(new Set(scopedEvidence.filter((item) => item.status === 'verified').map((item) => item.taskId)))
    const staleEvidenceTaskIds = Array.from(new Set(scopedEvidence.filter((item) => item.status === 'stale' || item.status === 'failed').map((item) => item.taskId)))

    const needsYou: OrganizationManagementProjection['needsYou'] = [
      ...scopedActions.filter((item) => item.status === 'open').map((item) => ({
        id: item.id, kind: item.kind as 'gate' | 'action', companyId: item.companyId,
        ...(item.projectId ? { projectId: item.projectId } : {}), title: item.title, detail: item.question, createdAt: item.createdAt,
      })),
      // Only a failure that is still the latest attempt needs the human; one that
      // was already retried (or whose task has since completed) is history.
      ...scopedRuns.filter((item) => item.status === 'failed' && isLatestAttempt(item, scopedRuns)
        && (!item.taskId || scopedTasks.find((task) => task.id === item.taskId)?.status !== 'completed')).slice(0, 8).map((item) => ({
        id: `run:${item.id}`, kind: 'failed-run' as const, companyId: item.companyId, projectId: item.projectId,
        ...(item.taskId ? { taskId: item.taskId } : {}), runKind: item.kind,
        title: `${runKindTitle(item.kind)} failed${item.taskId ? ` · ${scopedTasks.find((task) => task.id === item.taskId)?.title ?? 'task'}` : ''}`,
        detail: item.error ?? 'Run failed.', createdAt: item.completedAt ?? item.startedAt,
      })),
      ...scopedEvidence.filter((item) => item.status === 'stale' || item.status === 'failed').slice(0, 8).map((item) => ({
        id: `evidence:${item.id}`, kind: 'stale-evidence' as const, companyId: item.companyId, projectId: item.projectId,
        taskId: item.taskId, title: 'Verification evidence is stale', detail: item.reviewSummary ?? 'Re-review this task before shipping.', createdAt: item.invalidatedAt ?? item.capturedAt,
      })),
    ].sort((a, b) => b.createdAt - a.createdAt).slice(0, 24)

    const performance = organization.agents.filter((agent) => companyFilter(agent.companyId)).map((agent) => {
      const assigned = scopedTasks.filter((task) => task.assignedAgentId === agent.id)
      const reviewed = assigned.filter((task) => task.reviewSummary)
      const passed = reviewed.filter((task) => task.status === 'completed').length
      const turns = this.value.turns.filter((turn) => turn.taskId && assigned.some((task) => task.id === turn.taskId)).length
      const humanAttentionEvents = scopedActions.filter((item) => item.boundAgentId === agent.id).length
        + this.value.feedback.filter((item) => item.agentId === agent.id && attentionFeedback(item.label)).length
      return {
        agentId: agent.id,
        completedTasks: assigned.filter((task) => task.status === 'completed').length,
        failedOrBlockedTasks: assigned.filter((task) => task.status === 'blocked').length,
        reviewPassRate: reviewed.length ? Math.round((passed / reviewed.length) * 100) : null,
        turns,
        humanAttentionEvents,
      }
    })

    const humanAttentionEvents = scopedActions.length
      + this.value.feedback.filter((item) => companyFilter(item.companyId) && projectFilter(item.projectId) && attentionFeedback(item.label)).length
    const compute = this.computeLedger && companyId
      ? await this.computeLedger.management({
          companyId,
          ...(project ? { projectId: project.id } : {}),
        })
      : undefined

    return {
      generatedAt: Date.now(), ...(companyId ? { companyId } : {}), ...(project ? { projectId: project.id } : {}),
      needsYou,
      runningRunIds: scopedRuns.filter((item) => item.status === 'running').map((item) => item.id),
      readyToReviewTaskIds: scopedTasks.filter((item) => item.status === 'review').map((item) => item.id),
      newSignalIds: scopedSignals.filter((item) => item.status === 'new').map((item) => item.id),
      verifiedTaskIds,
      staleEvidenceTaskIds,
      budgets: clone(this.value.budgets.filter((item) => companyFilter(item.companyId) && projectFilter(item.projectId))),
      performance,
      ...(compute ? { compute } : {}),
      metrics: {
        completedTasks: scopedTasks.filter((item) => item.status === 'completed').length,
        verifiedTasks: verifiedTaskIds.length,
        blockedTasks: scopedTasks.filter((item) => item.status === 'blocked').length,
        runningRuns: scopedRuns.filter((item) => item.status === 'running').length,
        openHumanActions: scopedActions.filter((item) => item.status === 'open').length,
        newSignals: scopedSignals.filter((item) => item.status === 'new').length,
        humanAttentionEvents,
      },
    }
  }

  private async sync(): Promise<void> {
    await this.load()
    const organization = await this.store.state()
    let changed = this.resetBudgetWindows() || this.expireLeases()
    changed = await this.refreshCashBudgets() || changed

    for (const run of organization.runs) {
      let turn = this.value.turns.find((item) => item.runId === run.id)
      if (!turn) {
        turn = {
          id: randomUUID(), runId: run.id, sessionId: run.sessionId, action: actionForRun(run.kind),
          route: 'ready', companyId: run.companyId, projectId: run.projectId,
          ...(run.taskId ? { taskId: run.taskId } : {}),
          reason: 'Recovered organization run into the durable control ledger.', humanActionIds: [],
          startedAt: run.startedAt, checkedAt: run.startedAt,
        }
        this.value.turns.push(turn)
        this.consumeBudget(run.companyId, run.projectId, run.startedAt)
        changed = true
      }
      if (run.status !== 'running' && !turn.result) {
        turn.result = resultForRun(run, organization)
        turn.completedAt = run.completedAt ?? Date.now()
        changed = true
      }
      if (run.kind === 'task-execution' && run.taskId) {
        if (run.status === 'running') changed = this.ensureLease(run, organization) || changed
        else changed = this.releaseLease(run.taskId, run.sessionId) || changed
      }
      if (run.kind === 'task-review' && run.taskId) {
        if (run.status === 'running') changed = await this.ensureEvidence(run.taskId) || changed
        else {
          const task = organization.tasks.find((item) => item.id === run.taskId)
          const pending = this.value.evidence.find((item) => item.taskId === run.taskId && item.status === 'pending_review')
          if (pending && task?.status === 'completed') {
            pending.reviewerRunId = run.id
            await this.verifyEvidence(run.taskId)
            changed = true
          } else if (pending && task?.status === 'blocked') {
            pending.status = 'failed'
            pending.reviewerRunId = run.id
            pending.reviewSummary = task.reviewSummary ?? run.error ?? 'Independent review did not pass.'
            pending.invalidatedAt = Date.now()
            changed = true
          }
        }
      }
    }

    if (changed) await this.save()
  }

  private async ensureEvidence(taskId: string): Promise<boolean> {
    const context = await this.store.taskContext(taskId)
    const capture = await this.captureTaskEvidence(context.project.workspacePath, taskId)
    const existing = this.value.evidence.find((item) => item.taskId === taskId && item.status === 'pending_review' && item.fingerprint === capture.fingerprint)
    if (existing) return false
    this.value.evidence.unshift({
      id: randomUUID(), companyId: context.company.id, projectId: context.project.id, taskId,
      fingerprint: capture.fingerprint, exact: capture.exact, source: capture.source,
      changedFiles: capture.changedFiles, ...(capture.gitHead ? { gitHead: capture.gitHead } : {}),
      risk: assessDiffRisk({
        files: capture.changedFiles,
        fingerprint: capture.fingerprint,
        exact: capture.exact,
      }),
      status: 'pending_review', capturedAt: capture.capturedAt,
    })
    return true
  }

  private ensureLease(run: OrganizationRun, organization: OrganizationSnapshot): boolean {
    if (!run.taskId) return false
    const active = this.value.leases.find((item) => item.taskId === run.taskId && item.status === 'active' && item.expiresAt > Date.now())
    if (active) return false
    const task = organization.tasks.find((item) => item.id === run.taskId)
    this.value.leases.unshift({
      id: randomUUID(), companyId: run.companyId, projectId: run.projectId, taskId: run.taskId,
      ownerId: run.sessionId, writeScopes: [`task:${run.taskId}:workspace/**`], status: 'active', version: 1,
      acquiredAt: Date.now(), expiresAt: Date.now() + DEFAULT_LEASE_MS,
    })
    return Boolean(task)
  }

  private releaseLease(taskId: string, ownerId: string): boolean {
    const lease = this.value.leases.find((item) => item.taskId === taskId && item.ownerId === ownerId && item.status === 'active')
    if (!lease) return false
    lease.status = 'released'
    lease.releasedAt = Date.now()
    return true
  }

  private expireLeases(): boolean {
    let changed = false
    const now = Date.now()
    for (const lease of this.value.leases) {
      if (lease.status === 'active' && lease.expiresAt <= now) {
        lease.status = 'expired'
        lease.releasedAt = now
        changed = true
      }
    }
    return changed
  }

  private effectiveBudget(companyId: string, projectId: string): OrganizationBudget | undefined {
    return this.value.budgets.find((item) => item.companyId === companyId && item.projectId === projectId)
      ?? this.value.budgets.find((item) => item.companyId === companyId && !item.projectId)
  }

  private consumeBudget(companyId: string, projectId: string, startedAt = Date.now()): void {
    const budget = this.effectiveBudget(companyId, projectId)
    if (!budget) return
    if (Date.now() - budget.windowStartedAt >= DAY_MS) {
      budget.windowStartedAt = Date.now(); budget.spentTurns = 0; budget.spentCostUsd = 0
    }
    if (startedAt < budget.windowStartedAt) return
    budget.spentTurns += 1
    budget.updatedAt = Date.now()
  }

  private resetBudgetWindows(): boolean {
    let changed = false
    const now = Date.now()
    const monthStart = startOfUtcMonth(now)
    for (const budget of this.value.budgets) {
      if (now - budget.windowStartedAt >= DAY_MS) {
        budget.windowStartedAt = now; budget.spentTurns = 0; budget.spentCostUsd = 0; budget.updatedAt = now; changed = true
      }
      if (budget.monthlyWindowStartedAt !== monthStart) {
        budget.monthlyWindowStartedAt = monthStart; budget.spentMonthlyCostUsd = 0; budget.updatedAt = now; changed = true
      }
    }
    return changed
  }

  private async refreshCashBudgets(): Promise<boolean> {
    if (!this.computeLedger) return false
    let changed = false
    for (const budget of this.value.budgets) {
      const scope = {
        companyId: budget.companyId,
        ...(budget.projectId ? { projectId: budget.projectId } : {}),
      }
      const [daily, monthly] = await Promise.all([
        this.computeLedger.cashSummary({ ...scope, since: budget.windowStartedAt }),
        this.computeLedger.cashSummary({ ...scope, since: budget.monthlyWindowStartedAt }),
      ])
      const accountingKnown = daily.accountingKnown && monthly.accountingKnown
      if (budget.cashAccountingKnown !== accountingKnown) {
        budget.cashAccountingKnown = accountingKnown
        budget.updatedAt = Date.now()
        changed = true
      }
      if (!accountingKnown) continue
      if (budget.spentCostUsd !== daily.actualCashUsd) {
        budget.spentCostUsd = daily.actualCashUsd
        budget.updatedAt = Date.now()
        changed = true
      }
      if (budget.spentMonthlyCostUsd !== monthly.actualCashUsd) {
        budget.spentMonthlyCostUsd = monthly.actualCashUsd
        budget.updatedAt = Date.now()
        changed = true
      }
    }
    return changed
  }

  private addHumanAction(organization: OrganizationSnapshot, input: Extract<OrganizationControlMutation, { type: 'human-action.add' }>): void {
    assertCompanyProject(organization, input.companyId, input.projectId)
    this.value.humanActions.unshift({
      id: randomUUID(), companyId: input.companyId, ...(input.projectId ? { projectId: input.projectId } : {}),
      kind: input.kind, title: clean(input.title), question: clean(input.question), scopes: cleanList(input.scopes ?? []),
      ...(input.boundAgentId ? { boundAgentId: input.boundAgentId } : {}), status: 'open', createdAt: Date.now(),
    })
  }

  private resolveHumanAction(id: string, resolution: string, dismiss: boolean): void {
    const item = must(this.value.humanActions.find((row) => row.id === id), 'Human action')
    item.status = dismiss ? 'dismissed' : 'resolved'; item.resolution = clean(resolution); item.resolvedAt = Date.now()
  }

  private addSignal(organization: OrganizationSnapshot, input: Extract<OrganizationControlMutation, { type: 'signal.add' }>): void {
    assertCompanyProject(organization, input.companyId, input.projectId)
    const now = Date.now()
    this.value.signals.unshift({
      id: randomUUID(), companyId: input.companyId, ...(input.projectId ? { projectId: input.projectId } : {}),
      source: clean(input.source), title: clean(input.title), summary: clean(input.summary), status: 'new',
      ...(input.confidence === undefined ? {} : { confidence: clamp01(input.confidence) }), createdAt: now, updatedAt: now,
    })
  }

  private triageSignal(id: string, disposition: OrganizationSignal['disposition'], archive: boolean): void {
    const item = must(this.value.signals.find((row) => row.id === id), 'Signal')
    item.disposition = disposition; item.status = archive ? 'archived' : 'triaged'; item.updatedAt = Date.now()
  }

  private setBudget(organization: OrganizationSnapshot, input: Extract<OrganizationControlMutation, { type: 'budget.set' }>): void {
    assertCompanyProject(organization, input.companyId, input.projectId)
    const existing = this.value.budgets.find((item) => item.companyId === input.companyId && item.projectId === input.projectId)
    const now = Date.now()
    const target = existing ?? {
      id: randomUUID(),
      companyId: input.companyId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      spentTurns: 0,
      spentCostUsd: 0,
      spentMonthlyCostUsd: 0,
      cashAccountingKnown: Boolean(this.computeLedger),
      windowStartedAt: now,
      monthlyWindowStartedAt: startOfUtcMonth(now),
      updatedAt: now,
    }
    if (input.dailyTurnLimit === undefined) delete target.dailyTurnLimit
    else target.dailyTurnLimit = nonNegativeInteger(input.dailyTurnLimit, 'dailyTurnLimit')
    if (input.dailyCostUsd === undefined) delete target.dailyCostUsd
    else target.dailyCostUsd = nonNegative(input.dailyCostUsd, 'dailyCostUsd')
    if (input.monthlyCostUsd === undefined) delete target.monthlyCostUsd
    else target.monthlyCostUsd = nonNegative(input.monthlyCostUsd, 'monthlyCostUsd')
    if (input.maxParallelWorkers === undefined) delete target.maxParallelWorkers
    else target.maxParallelWorkers = positiveInteger(input.maxParallelWorkers, 'maxParallelWorkers')
    if (input.maxReviewWorkers === undefined) delete target.maxReviewWorkers
    else target.maxReviewWorkers = positiveInteger(input.maxReviewWorkers, 'maxReviewWorkers')
    if (input.roleWorkerLimits === undefined) delete target.roleWorkerLimits
    else target.roleWorkerLimits = positiveIntegerMap(input.roleWorkerLimits, 'roleWorkerLimits')
    if (input.teamWorkerLimits === undefined) delete target.teamWorkerLimits
    else target.teamWorkerLimits = positiveIntegerMap(input.teamWorkerLimits, 'teamWorkerLimits')
    target.updatedAt = now
    if (!existing) this.value.budgets.push(target)
  }

  private addFeedback(organization: OrganizationSnapshot, input: Extract<OrganizationControlMutation, { type: 'feedback.add' }>): void {
    assertCompanyProject(organization, input.companyId, input.projectId)
    const row: OrganizationReviewFeedback = {
      id: randomUUID(), companyId: input.companyId, ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.runId ? { runId: input.runId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}), label: input.label,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}), createdAt: Date.now(),
    }
    this.value.feedback.unshift(row)
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise
    const pending = this.loadFromDisk()
    this.loadPromise = pending
    try {
      await pending
    } finally {
      this.loadPromise = undefined
    }
  }

  private async loadFromDisk(): Promise<void> {
    let primaryError: unknown
    try {
      this.value = await this.readSnapshot(this.filePath)
      this.loaded = true
      return
    } catch (error) {
      primaryError = error
    }

    try {
      this.value = await this.readSnapshot(this.backupPath())
      this.loaded = true
      console.warn(`Recovered organization control state from backup after primary load failed: ${errorMessage(primaryError)}`)
      await this.save()
      return
    } catch (backupError) {
      if (isMissing(primaryError) && isMissing(backupError)) {
        this.loaded = true
        return
      }
      throw new Error(`Organization control state could not be loaded. Primary: ${errorMessage(primaryError)}. Backup: ${errorMessage(backupError)}.`)
    }
  }

  private async readSnapshot(path: string): Promise<OrganizationControlSnapshot> {
    return normalize(JSON.parse(await fs.readFile(path, 'utf8')) as unknown)
  }

  /** Durable once settled; saves requested during an in-flight write share the next one. */
  private save(): Promise<void> {
    if (this.pendingSave) return this.pendingSave
    const write = this.saveChain.catch(() => undefined).then(async () => {
      this.pendingSave = undefined
      const snapshot = clone(this.value)
      const serialized = `${JSON.stringify(snapshot)}\n`
      await fs.mkdir(dirname(this.filePath), { recursive: true })
      await writeAtomic(this.filePath, serialized)
      try {
        await writeAtomic(this.backupPath(), serialized)
      } catch (error) {
        console.warn('Failed to persist organization control backup:', error)
      }
      this.onChanged?.(snapshot)
    })
    this.pendingSave = write
    this.saveChain = write
    return write
  }

  private backupPath(): string {
    return `${this.filePath}.bak`
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temp, path)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalize(value: unknown): OrganizationControlSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Organization control state must be a JSON object')
  const record = value as Partial<OrganizationControlSnapshot>
  if (record.version !== 1) throw new Error(`Unsupported organization control state version: ${String(record.version)}`)
  for (const key of ['turns', 'humanActions', 'signals', 'budgets', 'leases', 'evidence', 'feedback'] as const) {
    if (!Array.isArray(record[key])) throw new Error(`Organization control field ${key} must be an array`)
  }
  const normalized = clone(record as OrganizationControlSnapshot)
  const now = Date.now()
  for (const budget of normalized.budgets) {
    if (!Number.isFinite(budget.spentMonthlyCostUsd)) budget.spentMonthlyCostUsd = 0
    if (typeof budget.cashAccountingKnown !== 'boolean') budget.cashAccountingKnown = false
    if (!Number.isFinite(budget.monthlyWindowStartedAt)) budget.monthlyWindowStartedAt = startOfUtcMonth(now)
  }
  return normalized
}

function controlRowCount(value: OrganizationControlSnapshot): number {
  return value.turns.length
    + value.humanActions.length
    + value.signals.length
    + value.budgets.length
    + value.leases.length
    + value.evidence.length
    + value.feedback.length
}

/** A run is the latest attempt when no newer run of the same kind targets the same task (or project plan). */
function isLatestAttempt(run: OrganizationRun, runs: OrganizationRun[]): boolean {
  return !runs.some((other) => other.id !== run.id
    && other.kind === run.kind
    && other.projectId === run.projectId
    && other.taskId === run.taskId
    && other.startedAt > run.startedAt)
}

function runKindTitle(kind: OrganizationRunKind): string {
  if (kind === 'pm-plan') return 'AI PM plan'
  if (kind === 'task-review') return 'AI review'
  return 'Task run'
}

function actionForRun(kind: OrganizationRunKind): OrganizationControlAction {
  if (kind === 'pm-plan') return 'internal.plan'
  if (kind === 'task-review') return 'task.review'
  return 'task.execute'
}

function resultForRun(run: OrganizationRun, organization: OrganizationSnapshot): OrganizationTurnResultKind {
  if (run.status === 'failed') return 'engine_failure'
  if (run.kind === 'task-review' && run.taskId) {
    const task = organization.tasks.find((item) => item.id === run.taskId)
    if (task?.status === 'completed') return 'validated_completion'
    if (task?.status === 'blocked') return 'validation_failed'
  }
  return 'validated_progress'
}

function gateBlocks(item: OrganizationHumanAction, action: OrganizationControlAction, projectId: string, taskId?: string): boolean {
  if (item.scopes.length === 0) return true
  return item.scopes.includes('*') || item.scopes.includes(action) || item.scopes.includes(`project:${projectId}`) || Boolean(taskId && item.scopes.includes(`task:${taskId}`))
}

function assertCompanyProject(state: OrganizationSnapshot, companyId: string, projectId?: string): void {
  if (!state.companies.some((item) => item.id === companyId)) throw new Error('Company not found')
  if (projectId && !state.projects.some((item) => item.id === projectId && item.companyId === companyId)) throw new Error('Project does not belong to company')
}

/**
 * The single authority for "may Autopilot dispatch this task right now?".
 *
 * The fill used to attempt a run and read the failure text as "no capacity".
 * That bypassed the control plane's gates and turned any real error containing
 * a word like "active" into a silent stop. Both authorities answer in structured
 * form here, so a refusal is a decision rather than a message to match.
 */
export async function taskDispatchAvailability(
  control: Pick<OrganizationControlPlane, 'shouldRun' | 'runtimeClaims'>,
  coordinator: Pick<ExecutionCoordinator, 'availability'> | undefined,
  projectId: string,
  taskId: string,
  action: 'task.execute' | 'task.review',
): Promise<RuntimeAvailability> {
  const decision = await control.shouldRun(projectId, action, taskId)
  if (decision.route !== 'ready') return { granted: false, reason: decision.reason }
  if (!coordinator) return { granted: true }
  return coordinator.availability(await control.runtimeClaims(projectId, action, taskId))
}

function attentionFeedback(label: OrganizationReviewFeedback['label']): boolean {
  return label === 'needs_evidence' || label === 'off_scope' || label === 'too_expensive' || label === 'unsafe'
}

function clean(value: string): string { const result = value.trim(); if (!result) throw new Error('Control-plane text cannot be empty'); return result }
function cleanList(values: string[]): string[] { return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean))).slice(0, 64) }
function must<T>(value: T | undefined, label: string): T { if (!value) throw new Error(`${label} not found`); return value }
function clone<T>(value: T): T { return structuredClone(value) }
function clamp01(value: number): number { if (!Number.isFinite(value)) throw new Error('confidence must be finite'); return Math.max(0, Math.min(1, value)) }
function nonNegative(value: number, label: string): number { if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`); return value }
function nonNegativeInteger(value: number, label: string): number { if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`); return value }
function scopesOverlap(left: string[], right: string[]): boolean {
  if (!left.length || !right.length) return false
  return left.some((a) => right.some((b) => scopeBaseOverlaps(a, b)))
}
function scopeBaseOverlaps(left: string, right: string): boolean {
  const base = (value: string): string => {
    const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '')
    const wildcard = normalized.search(/[*?\[]/)
    return (wildcard >= 0 ? normalized.slice(0, wildcard) : normalized).replace(/\/+$/, '')
  }
  const a = base(left)
  const b = base(right)
  if (!a || !b) return true
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/')
}

function startOfUtcMonth(value: number): number {
  const date = new Date(value)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

function positiveInteger(value: number, label: string): number { if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`); return value }
function positiveIntegerMap(value: Record<string, number>, label: string): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const result: Record<string, number> = {}
  for (const [key, limit] of Object.entries(value)) {
    const id = key.trim()
    if (!id || id.length > 256) throw new Error(`${label} contains an invalid id`)
    result[id] = positiveInteger(limit, `${label}.${id}`)
  }
  return result
}
