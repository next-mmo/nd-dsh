import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import {
  ORGANIZATION_CONTROL_IPC,
  type OrganizationControlAction,
  type OrganizationControlMutation,
  type OrganizationControlSnapshot,
} from '../../shared/organization-control.js'
import { ORGANIZATION_IPC, type OrganizationMutation, type OrganizationSnapshot } from '../../shared/organization.js'
import {
  ORGANIZATION_STRATEGY_IPC,
  type OrganizationStrategyMutation,
  type OrganizationStrategySnapshot,
} from '../../shared/organization-strategy.js'
import type { ProjectRuntimeService } from '../workspace/project-runtime.js'
import { ComputeLedger } from '../compute/compute-ledger.js'
import type { ProjectWorkspaceCoordinator } from '../workspace/project-workspace-coordinator.js'
import { OrganizationControlPlane, taskDispatchAvailability } from './control-plane.js'
import type { ExecutionCoordinator, RuntimePermit } from './execution-coordinator.js'
import type { OrganizationOrchestrator } from './orchestrator.js'
import { materializeOrganizationSignal } from './signal-materializer.js'
import { runDueSchedules } from './schedule-runner.js'
import { runDueHeartbeats } from './heartbeat-runner.js'
import { runEventTriggers } from './event-trigger-runner.js'
import { OrganizationStrategyPlane } from './strategy-plane.js'
import type { LocalRuntimeService } from '../local-runtime/local-runtime-service.js'
import type { OrganizationStore } from './store.js'

const MUTATIONS = new Set([
  'company.create', 'company.update', 'company.activate', 'company.remove', 'project.create', 'project.update', 'project.activate', 'project.remove',
  'team.create', 'member.create', 'member.update', 'role.create', 'role.update', 'agent.create', 'agent.update', 'skill.create', 'workflow.create', 'goal.create', 'task.create',
  'milestone.create', 'task.update', 'task.reorder', 'task.reassign', 'task.submitWork', 'collaboration.message.add', 'decision.create', 'decision.supersede', 'approval.request', 'approval.resolve', 'memory.add', 'policy.set',
])
const CONTROL_MUTATIONS = new Set([
  'human-action.add', 'human-action.resolve', 'signal.add', 'signal.triage', 'budget.set', 'feedback.add',
])
const STRATEGY_MUTATIONS = new Set([
  'anchor.add', 'anchor.update', 'knowledge.add', 'knowledge.update', 'schedule.add', 'schedule.update',
  'heartbeat.add', 'heartbeat.update', 'trigger.add', 'trigger.update',
  'skill-candidate.add', 'skill-candidate.update', 'skill-candidate.promote', 'action.record',
])
const CONTROL_ACTIONS = new Set<OrganizationControlAction>(['internal.plan', 'task.execute', 'task.review', 'workflow.continue'])

export function registerOrganizationIpc(
  window: BrowserWindow,
  store: OrganizationStore,
  orchestrator: OrganizationOrchestrator,
  projectWorkspace: ProjectWorkspaceCoordinator,
  projectRuntime?: ProjectRuntimeService,
  executionCoordinator?: ExecutionCoordinator,
  extraTrustedWindow?: () => BrowserWindow | null,
  localRuntime?: LocalRuntimeService,
): () => void {
  const channels: string[] = []
  const computeLedger = new ComputeLedger(join(app.getPath('userData'), 'compute-usage.jsonl'))
  const control = new OrganizationControlPlane(
    join(app.getPath('userData'), 'organization-control.json'),
    store,
    computeLedger,
    (projectWorkspace, taskId) => orchestrator.captureTaskEvidence(projectWorkspace, taskId),
  )
  const strategy = new OrganizationStrategyPlane(join(app.getPath('userData'), 'organization-strategy.json'), store)
  void store.state()
    .then((organization) => Promise.all([
      strategy.pruneToOrganization(organization),
      control.pruneToOrganization(organization),
    ]))
    .catch((error) => console.warn('Organization scoped-state startup reconciliation failed:', error instanceof Error ? error.message : String(error)))
  control.setOnChanged((state) => {
    if (!window.isDestroyed()) window.webContents.send(ORGANIZATION_CONTROL_IPC.changed, state)
  })
  strategy.setOnChanged((state) => {
    if (!window.isDestroyed()) window.webContents.send(ORGANIZATION_STRATEGY_IPC.changed, state)
  })

  orchestrator.setFastPathAuditRecorder(async (record) => {
    await strategy.mutate({ type: 'action.record', ...record })
  })

  // Guard the orchestrator itself instead of only guarding renderer IPC. The
  // orchestrator calls its public methods for autonomy-3/4 continuation, so
  // wrapping them here makes later automatic turns obey the same gates,
  // budgets, leases and evidence ledger as user-started work.
  const restoreOrchestrator = guardOrchestrator(orchestrator, store, control, executionCoordinator)

  // Organization runs finish on engine event streams, outside renderer IPC.
  // Reconcile independently so evidence, typed results, leases, quotas and
  // stalled-session recovery never depend on a screen being open.
  const reconcileTimer = setInterval(() => {
    void (async () => {
      await orchestrator.reconcileStalledRuns()
      await reconcileControlState(store, control)
    })().catch((error) => console.warn('Organization control reconciliation failed:', error instanceof Error ? error.message : String(error)))
  }, 1_500)
  reconcileTimer.unref()

  // Recurring company work: every due tick passes OrganizationControlPlane.shouldRun()
  // before it creates a task, and only the guarded orchestrator can start one, so
  // a timer never becomes an independent authority source.
  let scheduleBusy = false
  const scheduleTimer = setInterval(() => {
    if (scheduleBusy) return
    scheduleBusy = true
    void (async () => {
      await runDueSchedules({ strategy, control, store, orchestrator })
      localRuntime?.noteSchedulerTick()
      await runDueHeartbeats({ strategy, control, store })
      localRuntime?.noteHeartbeatTick()
      await runEventTriggers({ strategy, control, store, orchestrator })
      localRuntime?.noteEventTick()
    })()
      .catch((error) => console.warn('Organization automation tick failed:', error instanceof Error ? error.message : String(error)))
      .finally(() => { scheduleBusy = false })
  }, 15_000)
  scheduleTimer.unref()

  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) => {
      assertTrusted(event, window, extraTrustedWindow?.())
      return listener(event, ...args)
    })
    channels.push(channel)
  }

  handle(ORGANIZATION_IPC.state, () => store.state())
  handle(ORGANIZATION_IPC.mutate, async (_event, value) => {
    const mutation = asMutation(value)
    await projectWorkspace.assertCanMutate(mutation)
    // Removal stops live work first: agents, sessions and the ND-managed dev
    // server must not keep running for records ND forgets.
    if (mutation.type === 'project.remove') {
      await orchestrator.stopProjectWork(mutation.id)
      if (projectRuntime) await projectRuntime.stop(mutation.id)
    }
    if (mutation.type === 'company.remove') {
      const preState = await store.state()
      for (const run of preState.runs.filter((item) => item.companyId === mutation.id && item.status === 'running')) {
        await orchestrator.cancelRun(run.id)
      }
      if (projectRuntime) {
        for (const project of preState.projects.filter((item) => item.companyId === mutation.id)) {
          await projectRuntime.stop(project.id)
        }
      }
    }
    const state = await store.mutate(mutation)
    if (mutation.type === 'project.remove' || mutation.type === 'company.remove') {
      await Promise.all([
        strategy.pruneToOrganization(state),
        control.pruneToOrganization(state),
      ])
    }
    await projectWorkspace.afterOrganizationMutation(mutation, state)
    const projectId = autopilotProjectId(mutation, state)
    if (projectId) {
      try {
        await orchestrator.runNext(projectId, false)
        return store.state()
      } catch (error) {
        console.warn('Organization autopilot did not start:', error instanceof Error ? error.message : String(error))
      }
    }
    return state
  })
  handle(ORGANIZATION_IPC.planProject, (_event, value) => orchestrator.planProject(asId(value, 'Project id')))
  handle(ORGANIZATION_IPC.runTask, (_event, value) => orchestrator.runTask(asId(value, 'Task id')))
  handle(ORGANIZATION_IPC.reviewTask, (_event, value) => orchestrator.reviewTask(asId(value, 'Task id')))
  handle(ORGANIZATION_IPC.runNext, (_event, value) => orchestrator.runNext(value === undefined || value === null ? undefined : asId(value, 'Project id')))
  handle(ORGANIZATION_IPC.cancelRun, (_event, value) => orchestrator.cancelRun(asId(value, 'Run id')))

  handle(ORGANIZATION_CONTROL_IPC.state, () => control.state())
  handle(ORGANIZATION_CONTROL_IPC.mutate, async (_event, value) => {
    const mutation = asControlMutation(value)
    if (mutation.type === 'signal.triage') {
      const before = await control.state()
      const signal = before.signals.find((item) => item.id === mutation.id)
      if (!signal) throw new Error('Signal not found')
      await materializeOrganizationSignal(store, signal, mutation.disposition)
      let next = await control.mutate(mutation)
      if (mutation.disposition === 'ask-human') {
        next = await control.mutate({
          type: 'human-action.add',
          companyId: signal.companyId,
          ...(signal.projectId ? { projectId: signal.projectId } : {}),
          kind: 'action',
          title: signal.title,
          question: signal.summary,
        })
      } else if (mutation.disposition === 'objective') {
        const strategyState = await strategy.mutate({
          type: 'anchor.add', companyId: signal.companyId,
          ...(signal.projectId ? { projectId: signal.projectId } : {}),
          title: signal.title, outcome: signal.summary, priority: 'high', sourceSignalId: signal.id,
        })
        await projectLatestStrategyMemory(store, strategyState, 'anchor', strategyState.anchors[0]?.id)
      } else if (mutation.disposition === 'evidence') {
        const strategyState = await strategy.mutate({
          type: 'knowledge.add', companyId: signal.companyId,
          ...(signal.projectId ? { projectId: signal.projectId } : {}),
          kind: 'feedback', title: signal.title, content: signal.summary, source: 'evidence', sourceRef: `signal:${signal.id}`,
        })
        await projectLatestStrategyMemory(store, strategyState, 'knowledge', strategyState.knowledge[0]?.id)
      }
      return next
    }
    return control.mutate(mutation)
  })
  handle(ORGANIZATION_CONTROL_IPC.management, (_event, value) => control.management(value === undefined || value === null ? undefined : asId(value, 'Project id')))
  handle(ORGANIZATION_CONTROL_IPC.shouldRun, (_event, projectValue, actionValue, taskValue) => {
    const projectId = projectValue === undefined || projectValue === null ? undefined : asId(projectValue, 'Project id')
    const taskId = taskValue === undefined || taskValue === null ? undefined : asId(taskValue, 'Task id')
    return control.shouldRun(projectId, asControlAction(actionValue), taskId)
  })
  handle(ORGANIZATION_CONTROL_IPC.verifyEvidence, (_event, value) => control.verifyEvidence(asId(value, 'Task id')))

  handle(ORGANIZATION_STRATEGY_IPC.state, () => strategy.state())
  handle(ORGANIZATION_STRATEGY_IPC.mutate, async (_event, value) => {
    const mutation = asStrategyMutation(value)
    const next = await strategy.mutate(mutation)
    if (mutation.type === 'anchor.add') await projectLatestStrategyMemory(store, next, 'anchor', next.anchors[0]?.id)
    if (mutation.type === 'anchor.update') await projectLatestStrategyMemory(store, next, 'anchor', mutation.id)
    if (mutation.type === 'knowledge.add') await projectLatestStrategyMemory(store, next, 'knowledge', next.knowledge[0]?.id)
    if (mutation.type === 'knowledge.update') await projectLatestStrategyMemory(store, next, 'knowledge', mutation.id)
    return next
  })
  handle(ORGANIZATION_STRATEGY_IPC.projection, async (_event, value) => {
    const projectId = value === undefined || value === null ? undefined : asId(value, 'Project id')
    return strategy.projection(projectId, await control.state())
  })

  // Project dev-server lifecycle: validate → start → health → open browser.
  if (projectRuntime) {
    handle(ORGANIZATION_IPC.runtimeState, (_event, value) => projectRuntime.status(asId(value, 'Project id')))
    handle(ORGANIZATION_IPC.runtimeStart, (_event, value) => projectRuntime.start(asId(value, 'Project id')))
    handle(ORGANIZATION_IPC.runtimeStop, (_event, value) => projectRuntime.stop(asId(value, 'Project id')))
  }

  return () => {
    clearInterval(reconcileTimer)
    clearInterval(scheduleTimer)
    restoreOrchestrator()
    orchestrator.setFastPathAuditRecorder(undefined)
    control.setOnChanged(undefined)
    strategy.setOnChanged(undefined)
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}

async function projectLatestStrategyMemory(
  store: OrganizationStore,
  strategy: OrganizationStrategySnapshot,
  kind: 'anchor' | 'knowledge',
  id: string | undefined,
): Promise<void> {
  if (!id) return
  if (kind === 'anchor') {
    const item = strategy.anchors.find((entry) => entry.id === id)
    if (!item) return
    await store.mutate({
      type: 'memory.add', companyId: item.companyId,
      ...(item.projectId ? { projectId: item.projectId } : {}),
      title: `Strategic Anchor · ${item.title}`,
      content: `[${item.status.toUpperCase()} | ${item.priority}] ${item.outcome}${item.successCriteria.length ? `\nSuccess criteria: ${item.successCriteria.join('; ')}` : ''}`,
      tags: ['strategy', 'strategic-anchor', item.status, item.priority],
    })
    return
  }
  const item = strategy.knowledge.find((entry) => entry.id === id)
  if (!item) return
  await store.mutate({
    type: 'memory.add', companyId: item.companyId,
    ...(item.projectId ? { projectId: item.projectId } : {}),
    title: `Company Brain · ${item.kind} · ${item.title}`,
    content: `[${item.status.toUpperCase()} | ${item.confidence} | ${item.source}] ${item.content}${item.supersedesId ? `\nSupersedes strategy knowledge ${item.supersedesId}.` : ''}`,
    tags: ['company-brain', item.kind, item.status, ...item.tags].slice(0, 50),
  })
}

function guardOrchestrator(
  orchestrator: OrganizationOrchestrator,
  store: OrganizationStore,
  control: OrganizationControlPlane,
  executionCoordinator?: ExecutionCoordinator,
): () => void {
  const planProject = orchestrator.planProject.bind(orchestrator)
  const runTask = orchestrator.runTask.bind(orchestrator)
  const reviewTask = orchestrator.reviewTask.bind(orchestrator)
  const runNext = orchestrator.runNext.bind(orchestrator)

  // Dispatch decisions consult the same two authorities the guarded runs obey:
  // the control plane's gates and the coordinator's pools. Without this the
  // automatic fill could only attempt a run and read its failure text as "no
  // capacity", which bypassed the gates and hid genuine errors at once.
  orchestrator.setDispatchAvailability((projectId, taskId, action) => taskDispatchAvailability(control, executionCoordinator, projectId, taskId, action))
  // A fill round that ended on a full pool restarts when that pool frees up,
  // instead of waiting for an unrelated lifecycle event to try again.
  const stopCapacityReleases = executionCoordinator?.onCapacityReleased((event) => {
    if (!event.projectId) return
    void orchestrator.resumeAutopilotDispatch(event.projectId).catch((error) => {
      console.warn('Autopilot capacity resume failed:', error instanceof Error ? error.message : String(error))
    })
  })

  orchestrator.planProject = async (projectId: string, explicit = true) => {
    await control.assertRunnable(projectId, 'internal.plan')
    const result = await planProject(projectId, explicit)
    await control.noteDispatch(result)
    return result
  }
  orchestrator.runTask = async (taskId: string, explicit = true) => {
    const context = await store.taskContext(taskId)
    await control.assertRunnable(context.project.id, 'task.execute', taskId)
    // An explicit dispatch waits out a full pool instead of refusing the task.
    // The pool bounds how many tasks run *simultaneously*; it is not a decision
    // about which of the tasks the user asked for should be dropped.
    //
    // Autopilot keeps the immediate refusal: `fillParallelReadyTasks` catches
    // RuntimeCapacityError to park the project and resume on the next release,
    // and blocking here would hold its fill guard for the whole wait instead.
    const claims = await control.runtimeClaims(context.project.id, 'task.execute', taskId)
    const permitInput = {
      companyId: context.company.id,
      projectId: context.project.id,
      taskId,
      ...(context.agent?.id ? { agentId: context.agent.id } : {}),
      kind: 'execution' as const,
      pools: claims,
    }
    const permit = executionCoordinator
      ? explicit
        ? await executionCoordinator.acquireWhenAvailable(permitInput)
        : await executionCoordinator.acquire(permitInput)
      : undefined
    try {
      const result = executionCoordinator && permit
        ? await executionCoordinator.runWithPermit(permit, () => runTask(taskId, explicit))
        : await runTask(taskId, explicit)
      await bindRuntimePermit(executionCoordinator, permit, result.sessionId, result.runId, store)
      await control.noteDispatch(result)
      return result
    } catch (error) {
      if (executionCoordinator && permit) await executionCoordinator.release(permit)
      throw error
    }
  }
  orchestrator.reviewTask = async (taskId: string, explicit = true) => {
    const context = await store.taskContext(taskId)
    await control.assertRunnable(context.project.id, 'task.review', taskId)
    const reviewer = await store.reviewerForTask(taskId)
    const reviewPermitInput = {
      companyId: context.company.id,
      projectId: context.project.id,
      taskId,
      ...(reviewer.agent?.id ? { agentId: reviewer.agent.id } : {}),
      kind: 'review' as const,
      pools: await control.runtimeClaims(context.project.id, 'task.review', taskId),
    }
    // Same split as task execution: a user asking for a review waits for a
    // reviewer slot, an automatic one reports the pool as full and resumes later.
    const permit = executionCoordinator
      ? explicit
        ? await executionCoordinator.acquireWhenAvailable(reviewPermitInput)
        : await executionCoordinator.acquire(reviewPermitInput)
      : undefined
    try {
      const result = executionCoordinator && permit
        ? await executionCoordinator.runWithPermit(permit, () => reviewTask(taskId, explicit))
        : await reviewTask(taskId, explicit)
      await bindRuntimePermit(executionCoordinator, permit, result.sessionId, result.runId, store)
      await control.noteDispatch(result)
      return result
    } catch (error) {
      if (executionCoordinator && permit) await executionCoordinator.release(permit)
      throw error
    }
  }
  orchestrator.runNext = async (projectId?: string, explicit = true) => {
    const state = await store.state()
    const resolvedProjectId = projectId ?? state.activeProjectId
    if (!resolvedProjectId) throw new Error('No active project')
    await assertProjectCompletionEvidence(store, control, resolvedProjectId)
    await control.assertRunnable(resolvedProjectId, 'workflow.continue')
    const result = await runNext(projectId, explicit)
    if (result) await control.noteDispatch(result)
    return result
  }

  return () => {
    stopCapacityReleases?.()
    orchestrator.setDispatchAvailability(undefined)
    orchestrator.planProject = planProject
    orchestrator.runTask = runTask
    orchestrator.reviewTask = reviewTask
    orchestrator.runNext = runNext
  }
}


async function bindRuntimePermit(
  coordinator: ExecutionCoordinator | undefined,
  permit: RuntimePermit | undefined,
  sessionId: string,
  runId: string,
  store: OrganizationStore,
): Promise<void> {
  if (!coordinator || !permit) return
  await coordinator.bindSession(permit, sessionId, runId)
  await store.updateRunProvenance(runId, { runtimePermitId: permit.id })
  const active = await store.runBySession(sessionId)
  if (!active) await coordinator.release(permit)
}

async function reconcileControlState(store: OrganizationStore, control: OrganizationControlPlane): Promise<void> {
  const controlState = await control.state()
  const organization = await store.state()
  const newestReceipt = new Map<string, OrganizationControlSnapshot['evidence'][number]>()
  for (const receipt of controlState.evidence) {
    if (!newestReceipt.has(receipt.taskId)) newestReceipt.set(receipt.taskId, receipt)
  }
  // Runs every tick, so only projects with a completed task whose newest receipt is
  // still unverified pay for the per-project evidence pass.
  const projectIds = new Set<string>()
  for (const task of organization.tasks) {
    if (task.status !== 'completed') continue
    const receipt = newestReceipt.get(task.id)
    if (receipt && receipt.status !== 'verified') projectIds.add(task.projectId)
  }
  for (const projectId of projectIds) {
    await assertProjectCompletionEvidence(store, control, projectId, false)
  }
}

/**
 * A task that reached `completed` through a reviewer is not allowed to unlock
 * successor work when its exact worktree receipt is stale or unavailable.
 * Pre-existing completed tasks without a control receipt are left untouched so
 * upgrading ND does not retroactively invalidate old project history.
 */
async function assertProjectCompletionEvidence(
  store: OrganizationStore,
  control: OrganizationControlPlane,
  projectId: string,
  throwOnFailure = true,
): Promise<void> {
  const [organization, controlState] = await Promise.all([store.state(), control.state()])
  for (const task of organization.tasks.filter((item) => item.projectId === projectId && item.status === 'completed')) {
    const receipt = controlState.evidence.find((item) => item.taskId === task.id)
    if (!receipt || receipt.status === 'verified') continue
    if (receipt.status === 'pending_review') {
      const verified = await control.verifyEvidence(task.id)
      if (verified?.status === 'verified') continue
    }
    const current = (await control.state()).evidence.find((item) => item.taskId === task.id)
    if (!current || current.status === 'verified') continue
    await store.mutate({ type: 'task.update', id: task.id, patch: { status: 'blocked' } })
    if (throwOnFailure) {
      throw new Error(`Task ${task.title} cannot advance: independent-review evidence is ${current.status}. Re-review the exact current workspace.`)
    }
  }
}

function autopilotProjectId(mutation: OrganizationMutation, state: OrganizationSnapshot): string | undefined {
  let companyId: string | undefined
  let projectId: string | undefined

  if (mutation.type === 'project.create') {
    companyId = mutation.companyId
    projectId = state.activeProjectId
  } else if (mutation.type === 'project.update' && mutation.patch.deliveryMilestoneId !== undefined) {
    projectId = mutation.id
    companyId = state.projects.find((item) => item.id === projectId)?.companyId
  } else if (mutation.type === 'company.update' && mutation.patch.autonomyLevel === 4) {
    companyId = mutation.id
    projectId = state.activeProjectId && state.projects.some((item) => item.id === state.activeProjectId && item.companyId === companyId)
      ? state.activeProjectId
      : state.projects.find((item) => item.companyId === companyId && item.status !== 'completed' && item.status !== 'archived')?.id
  }

  if (!companyId || !projectId) return undefined
  const company = state.companies.find((item) => item.id === companyId)
  if (company?.autonomyLevel !== 4) return undefined
  const project = state.projects.find((item) => item.id === projectId)
  if (!project || project.status === 'completed' || project.status === 'archived') return undefined
  return project.id
}

function assertTrusted(event: IpcMainInvokeEvent, window: BrowserWindow, extra?: BrowserWindow | null): void {
  for (const candidate of [window, extra]) {
    if (candidate && !candidate.isDestroyed() && event.sender === candidate.webContents && event.senderFrame === candidate.webContents.mainFrame) return
  }
  throw new Error('Rejected organization IPC from an untrusted renderer frame')
}

function asMutation(value: unknown): OrganizationMutation {
  if (!value || typeof value !== 'object') throw new Error('Organization mutation must be an object')
  const type = (value as Record<string, unknown>).type
  if (typeof type !== 'string' || !MUTATIONS.has(type)) throw new Error('Unsupported organization mutation')
  return value as OrganizationMutation
}

function asControlMutation(value: unknown): OrganizationControlMutation {
  if (!value || typeof value !== 'object') throw new Error('Organization control mutation must be an object')
  const type = (value as Record<string, unknown>).type
  if (typeof type !== 'string' || !CONTROL_MUTATIONS.has(type)) throw new Error('Unsupported organization control mutation')
  return value as OrganizationControlMutation
}

function asStrategyMutation(value: unknown): OrganizationStrategyMutation {
  if (!value || typeof value !== 'object') throw new Error('Organization strategy mutation must be an object')
  const type = (value as Record<string, unknown>).type
  if (typeof type !== 'string' || !STRATEGY_MUTATIONS.has(type)) throw new Error('Unsupported organization strategy mutation')
  return value as OrganizationStrategyMutation
}

function asControlAction(value: unknown): OrganizationControlAction {
  if (typeof value !== 'string' || !CONTROL_ACTIONS.has(value as OrganizationControlAction)) throw new Error('Unsupported organization control action')
  return value as OrganizationControlAction
}

function asId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error(`${label} must be a short non-empty string`)
  return value.trim()
}
