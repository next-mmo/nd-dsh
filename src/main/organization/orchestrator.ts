import { randomUUID } from 'node:crypto'
import type { CodingEngineDescriptor, DshEventFrame } from '../../shared/contracts.js'
import { CODEX_ENGINE_ID, ND_HARNESS_ENGINE_ID } from '../../shared/coding-engines.js'
import type { OrganizationAgent, OrganizationRole, OrganizationRun, OrganizationRunReceipt, OrganizationSubagentMode, OrganizationTask, ProjectPlanInput } from '../../shared/organization.js'
import { parseFastActionPlan } from '../../shared/fast-action.js'
import type { CodingEngineRegistry } from '../engines/coding-engine-registry.js'
import type { EngineSessionRouter } from '../engines/engine-session-router.js'
import type { HarnessService } from '../harness/harness-service.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import type { CoreClient } from '../core/core-client.js'
import { createCoreArtifactFingerprint } from '../core/core-workspace.js'
import { taskMetricsRecorder } from '../metrics/task-metrics.js'
import { isRetryableExecutionFailure, MAX_EXECUTION_ATTEMPTS, retryBackoffMs, stallTimeoutMs } from './execution-reliability.js'
import type { OrganizationStore } from './store.js'
import { TaskIntegrationConflictError, TaskWorktreeManager, type TaskWorktree } from './task-worktree.js'
import { formatVerificationEvidence, runArtifactVerification, runVerification, type ArtifactFingerprintRunner, type VerificationProcessRuntime } from './verification-evidence.js'
import { createCoreEvidenceCapturer, unavailableEvidenceCapturer, type WorkspaceEvidenceCapture, type WorkspaceEvidenceCapturer } from './worktree-evidence.js'
import { RuntimeCapacityError, type ExecutionCoordinator, type RuntimeAvailability } from './execution-coordinator.js'
import { normalizeProjectPlan } from './plan-normalizer.js'
import { mergeRepeatedArrayKeys } from '../../shared/structured-output.js'
import { executePreparedFastPath, ND_FAST_PATH_ENGINE_ID, prepareFastPath, type FastPathAuditRecorder, type PreparedFastPath } from './fast-path.js'
import { formatDecisionSupportForReviewer, formatDecisionSupportReceipt, type DecisionSupportReceipt } from './decision-support-contract.js'
import type { DecisionSupportService } from './decision-support.js'

interface ReviewVerdict {
  verdict: 'pass' | 'fail'
  summary: string
  issues?: string[]
  memory?: Array<{ title: string; content: string; tags?: string[] }>
}

interface ReviewWorktreeCheckpoint {
  worktree: TaskWorktree
  head: string
}

interface ExecutionAttemptBoundary {
  worktree: TaskWorktree
  head: string
}

interface ExecutionRoute {
  engineId: string
  attempt: number
  provider?: string
  model?: string
}

interface ProviderRoute {
  provider: string
  model: string
}

const MAX_AUTOPILOT_PARALLEL_FILL = 16

/**
 * Gateway session events and host lifecycle events arrive on two separate
 * WebSocket connections, so the final assistant/message of a session can be
 * delivered shortly AFTER the matching session-status(complete). Structured
 * results (pm plans, review verdicts) must wait out this grace period before
 * the run is declared "structured result missing", or valid plans get
 * discarded on every race the host socket wins.
 */
const STRUCTURED_RESULT_GRACE_MS = 2_500

type WorkflowKind = 'plan' | 'execute' | 'review'
type TaskEngine = Pick<CodingEngineDescriptor, 'id' | 'name' | 'workerInstructions'>

/**
 * Asked before every automatic dispatch. Only the control plane can compute a
 * task's pool claims, so the guarded IPC layer installs this; an orchestrator
 * without it dispatches as before and lets the acquire refuse.
 */
export type DispatchAvailabilityProvider = (
  projectId: string,
  taskId: string,
  action: 'task.execute' | 'task.review',
) => Promise<RuntimeAvailability>

const DEFAULT_WORKER_INSTRUCTIONS = '\nExecution engine: ND Harness. Work directly in the project workspace using the available ND tools.\n'

export class OrganizationOrchestrator {
  private finalText = new Map<string, string>()
  private structuredHandled = new Set<string>()
  private structuredInFlight = new Set<string>()
  private autoAdvance = new Map<string, string>()
  private reviewWorktrees = new Map<string, ReviewWorktreeCheckpoint>()
  private executionBaselines = new Map<string, ExecutionAttemptBoundary>()
  private executionRoutes = new Map<string, ExecutionRoute>()
  private attemptedProviderRoutes = new Map<string, Set<string>>()
  private pendingFallbackRoutes = new Map<string, ProviderRoute>()
  private canceledSessions = new Set<string>()
  private cancellationFinalizations = new Map<string, Promise<void>>()
  private interruptionFinalizations = new Map<string, Promise<void>>()
  private lastProgressAt = new Map<string, number>()
  private parallelFillProjects = new Set<string>()
  private stallReconcileBusy = false
  private dispatchAvailability: DispatchAvailabilityProvider | undefined
  private fastPathAuditRecorder: FastPathAuditRecorder | undefined
  private readonly capacityWaiting = new Set<string>()
  private readonly structuredErrors = new Map<string, string>()
  private readonly decisionSupportReceipts = new Map<string, DecisionSupportReceipt>()
  private readonly taskWorktrees: TaskWorktreeManager
  private readonly captureEvidence: WorkspaceEvidenceCapturer
  private readonly fingerprintArtifacts: ArtifactFingerprintRunner | undefined

  constructor(
    private readonly store: OrganizationStore,
    private readonly harness: HarnessService,
    private readonly workspace: WorkspaceService,
    private readonly engines?: Pick<CodingEngineRegistry, 'assignedEngine' | 'assertAvailable'>,
    private readonly engineRuns?: Pick<EngineSessionRouter, 'createSession' | 'run' | 'stopSession'>,
    private readonly projectRuntime?: { check(projectId: string): Promise<unknown> },
    private readonly capabilities?: { assertUsableForAgent(agent?: { id?: string; roleId?: string; teamId?: string }): Promise<void> },
    private readonly executionCoordinator?: Pick<ExecutionCoordinator, 'releaseSession' | 'currentPermit'>,
    taskWorktrees?: TaskWorktreeManager,
    private readonly core?: Pick<CoreClient, 'request'>,
    private readonly verificationRuntime?: VerificationProcessRuntime,
    private readonly browserAccess?: {
      issueSessionAccess(sessionId: string): string
      revokeSessionAccess(sessionId: string): void
    },
    private readonly decisionSupport?: DecisionSupportService,
  ) {
    this.taskWorktrees = taskWorktrees ?? new TaskWorktreeManager()
    this.captureEvidence = core ? createCoreEvidenceCapturer(core) : unavailableEvidenceCapturer
    this.fingerprintArtifacts = core ? createCoreArtifactFingerprint(core) : undefined
  }

  /**
   * Capture review evidence for the checkout the task's work lives in: the
   * attached ND task worktree, else the project workspace.
   */
  async captureTaskEvidence(projectWorkspace: string | undefined, taskId: string): Promise<WorkspaceEvidenceCapture> {
    const workspace = projectWorkspace
      ? (await this.taskWorktrees.existing(projectWorkspace, taskId))?.root ?? projectWorkspace
      : undefined
    return await this.captureEvidence(workspace)
  }

  /**
   * Installed by the guarded IPC layer, which owns the control plane the claims
   * come from. Without a provider the orchestrator cannot know whether a pool
   * has room, so it dispatches and lets the permit acquire refuse.
   */
  setDispatchAvailability(provider: DispatchAvailabilityProvider | undefined): void {
    this.dispatchAvailability = provider
  }

  setFastPathAuditRecorder(recorder: FastPathAuditRecorder | undefined): void {
    this.fastPathAuditRecorder = recorder
  }

  /**
   * Re-enters the parallel fill for one project after a runtime permit was
   * released. A round that ended on a full pool is the only thing resume means:
   * every other stop needs a different trigger (a gate, a fix, a new plan), and
   * re-dispatching into a failing task would spin.
   */
  async resumeAutopilotDispatch(projectId: string): Promise<void> {
    if (!this.capacityWaiting.has(projectId)) return
    await this.fillParallelReadyTasks(projectId)
  }

  async planProject(projectId: string, explicit = true): Promise<OrganizationRunReceipt> {
    const context = await this.store.projectContext(projectId)
    if (!explicit && context.company.autonomyLevel < 3) throw new Error('Autonomy level 3+ is required for automatic planning')
    this.assertPolicy(await this.store.policy(context.company.id, 'internal.plan'), explicit, 'internal planning')
    await this.assertNoActiveRun(projectId)
    await this.prepareWorkspace(context.project.workspacePath)
    const pmAgent = context.agents.find((item) => {
      const role = context.roles.find((r) => r.id === item.roleId)
      return role?.name.toLowerCase().includes('product manager')
    })
    const pmRole = pmAgent ? context.roles.find((r) => r.id === pmAgent.roleId) : context.roles.find((r) => r.name.toLowerCase().includes('product manager'))
    const modelOpts = this.resolveAgentModel(pmAgent, pmRole)
    const sessionId = await this.harness.createSession()
    await this.nameSession(sessionId, `Plan · ${context.project.name}`)
    const run = await this.store.beginRun('pm-plan', context.company.id, projectId, sessionId)
    this.lastProgressAt.set(sessionId, run.startedAt)
    try {
      const prompt = appendBrowserAccess(pmPrompt(context), sessionId, this.browserAccess)
      await this.harness.run(prompt, {
        sessionId,
        ...modelOpts,
        ...(context.project.workspacePath ? { workspaceCwd: context.project.workspacePath } : {}),
      })
    } catch (cause) {
      const active = await this.store.runBySession(sessionId)
      if (active) await this.store.completeRun(run.id, undefined, errorMessage(cause)).catch(() => undefined)
      throw cause
    }
    return receipt(run)
  }

  async runTask(taskId: string, explicit = true): Promise<OrganizationRunReceipt> {
    const context = await this.store.taskContext(taskId)
    if (!explicit && context.project.deliveryMilestoneId && context.task.milestoneId !== context.project.deliveryMilestoneId) {
      throw new Error('Task is outside the selected delivery milestone')
    }
    this.assertPolicy(await this.store.policy(context.company.id, 'task.execute'), explicit, 'task execution')
    if (context.task.assigneeKind === 'human' || (!context.task.assignedAgentId && context.task.assignedMemberId)) {
      throw new Error('Task is assigned to a human member; submit human work or reassign to an agent before automated execution')
    }
    if (context.task.status !== 'ready' && context.task.status !== 'blocked') throw new Error(`Task is ${context.task.status}; only ready or blocked tasks can run`)

    const state = await this.store.state()
    const previousExecution = state.runs.find((item) => item.taskId === taskId && item.kind === 'task-execution')
    const attempt = await this.store.executionAttemptCount(taskId) + 1
    const retryablePreviousFailure = Boolean(previousExecution?.status === 'failed' && isRetryableExecutionFailure(previousExecution.error ?? ''))
    const fallbackRoute = retryablePreviousFailure
      ? this.pendingFallbackRoutes.get(taskId) ?? await this.selectFallbackProviderRoute(context)
      : undefined
    const useFallbackRoute = Boolean(fallbackRoute)

    const taskWorktree = await this.taskWorktrees.ensure(context.project.workspacePath, context.task.id)
    if (taskWorktree) {
      await this.journalEffect({
        kind: 'workspace.allocate',
        state: 'complete',
        companyId: context.company.id,
        projectId: context.project.id,
        taskId: context.task.id,
        resourceId: context.task.id,
        idempotencyKey: `workspace.allocate:${context.task.id}`,
        data: { branch: taskWorktree.branch },
      })
    }
    await this.assertTaskRunSlot(context.task.id, context.project.id, Boolean(taskWorktree))
    const attemptHead = taskWorktree ? await this.taskWorktrees.baseline(taskWorktree) : undefined
    const workspaceRoot = taskWorktree?.root ?? context.project.workspacePath
    let fastEscalationReason: string | undefined

    const fastPlan = parseFastActionPlan(context.task.description)
    if (fastPlan && workspaceRoot && this.core && this.fastPathAuditRecorder) {
      const prepared = await prepareFastPath({
        plan: fastPlan,
        context: {
          company: { id: context.company.id },
          project: { id: context.project.id },
          task: { id: context.task.id },
          ...(context.agent ? { agent: { id: context.agent.id } } : {}),
        },
        root: workspaceRoot,
        explicit,
        policy: (action) => this.store.policy(context.company.id, action),
        audit: this.fastPathAuditRecorder,
      })
      if (prepared.kind === 'ready') return this.runPreparedFastTask(context, prepared.prepared, taskWorktree, attemptHead, attempt)
      fastEscalationReason = prepared.reason
    } else if (fastPlan) {
      fastEscalationReason = 'Fast path is unavailable without ND Core and the durable action-audit sink.'
    }

    const subagentMode = context.company.subagentMode ?? 'auto'
    const engine = await this.resolveTaskEngine(context.agent?.id, useFallbackRoute, subagentMode)
    const prompt = workerPrompt(context, engine, attempt, taskWorktree, subagentMode)
    let modelOpts = this.resolveAgentModel(context.agent, context.role)
    if (useFallbackRoute) {
      modelOpts = fallbackRoute!
      this.pendingFallbackRoutes.delete(taskId)
    }

    if (!taskWorktree) await this.prepareWorkspace(context.project.workspacePath)
    await this.warmProjectTarget(context.project.id)
    await this.capabilities?.assertUsableForAgent(context.agent)
    const sessionEffectKey = `engine.session:${context.task.id}:${attempt}`
    await this.journalEffect({
      kind: 'engine.session',
      state: 'intent',
      companyId: context.company.id,
      projectId: context.project.id,
      taskId: context.task.id,
      idempotencyKey: sessionEffectKey,
      data: { engineId: engine.id, attempt },
    })
    let target: { engineId: string; sessionId: string }
    try {
      target = this.engineRuns
        ? await this.engineRuns.createSession(engine.id, taskWorktree?.root, context.task.title)
        : { engineId: ND_HARNESS_ENGINE_ID, sessionId: await this.createHarnessSession(taskWorktree?.root, context.task.title) }
      await this.journalEffect({
        kind: 'engine.session',
        state: 'complete',
        companyId: context.company.id,
        projectId: context.project.id,
        taskId: context.task.id,
        resourceId: target.sessionId,
        idempotencyKey: sessionEffectKey,
        data: { engineId: target.engineId, attempt },
      })
    } catch (cause) {
      await this.journalEffect({
        kind: 'engine.session',
        state: 'failed',
        companyId: context.company.id,
        projectId: context.project.id,
        taskId: context.task.id,
        idempotencyKey: sessionEffectKey,
        data: { engineId: engine.id, attempt, error: errorMessage(cause) },
      }).catch(() => undefined)
      throw cause
    }
    const run = await this.store.beginRun(
      'task-execution',
      context.company.id,
      context.project.id,
      target.sessionId,
      context.task.id,
      context.task.goalId,
      {
        ...(taskWorktree ? { parallelTask: true } : {}),
        engineId: engine.id,
        workspaceKind: taskWorktree ? 'git-worktree' : 'project-workspace',
        ...(workspaceRoot ? { workspaceRoot } : {}),
        ...(taskWorktree ? { workspaceBranch: taskWorktree.branch } : {}),
        ...(attemptHead ? { baselineCommit: attemptHead } : {}),
        ...(this.executionCoordinator?.currentPermit()?.id ? { runtimePermitId: this.executionCoordinator.currentPermit()!.id } : {}),
      },
    )
    if (taskWorktree && attemptHead) this.executionBaselines.set(target.sessionId, { worktree: taskWorktree, head: attemptHead })
    const effectiveRoute = this.effectiveExecutionRoute(engine.id, attempt, modelOpts)
    this.executionRoutes.set(target.sessionId, effectiveRoute)
    this.noteProviderAttempt(taskId, effectiveRoute)
    this.lastProgressAt.set(target.sessionId, run.startedAt)
    if (fastEscalationReason) taskMetricsRecorder()?.noteEscalation(target.sessionId)

    try {
      await this.store.markExecution(context.task.id, target.sessionId)
      // The shared engine router owns browser-token injection in production.
      // The direct-Harness fallback has no router, so only that path injects here.
      const browserPrompt = this.engineRuns ? prompt : appendBrowserAccess(prompt, target.sessionId, this.browserAccess)
      const runOptions = {
        sessionId: target.sessionId,
        ...modelOpts,
        ...(workspaceRoot ? { workspaceCwd: workspaceRoot } : {}),
      }
      if (this.engineRuns) await this.engineRuns.run(browserPrompt, runOptions)
      else await this.harness.run(browserPrompt, runOptions)
    } catch (cause) {
      const message = errorMessage(cause)
      const queued = await this.handleExecutionFailure(run, message)
      this.cleanupSession(target.sessionId)
      if (queued) {
        await delay(retryBackoffMs(attempt))
        await this.continueProject(run.projectId)
      }
      throw cause
    }
    return receipt(run)
  }

  private async runPreparedFastTask(
    context: Awaited<ReturnType<OrganizationStore['taskContext']>>,
    prepared: PreparedFastPath,
    taskWorktree: TaskWorktree | undefined,
    attemptHead: string | undefined,
    attempt: number,
  ): Promise<OrganizationRunReceipt> {
    if (!this.core) throw new Error('ND Core is required for the fast path.')
    const workspaceRoot = taskWorktree?.root ?? context.project.workspacePath
    if (!workspaceRoot) throw new Error('Fast path requires a project workspace.')
    const sessionId = 'fast-' + randomUUID()
    const run = await this.store.beginRun(
      'task-execution',
      context.company.id,
      context.project.id,
      sessionId,
      context.task.id,
      context.task.goalId,
      {
        ...(taskWorktree ? { parallelTask: true } : {}),
        engineId: ND_FAST_PATH_ENGINE_ID,
        workspaceKind: taskWorktree ? 'git-worktree' : 'project-workspace',
        workspaceRoot,
        ...(taskWorktree ? { workspaceBranch: taskWorktree.branch } : {}),
        ...(attemptHead ? { baselineCommit: attemptHead } : {}),
        ...(this.executionCoordinator?.currentPermit()?.id ? { runtimePermitId: this.executionCoordinator.currentPermit()!.id } : {}),
      },
    )
    if (taskWorktree && attemptHead) this.executionBaselines.set(sessionId, { worktree: taskWorktree, head: attemptHead })
    this.executionRoutes.set(sessionId, { engineId: ND_FAST_PATH_ENGINE_ID, attempt })
    this.lastProgressAt.set(sessionId, run.startedAt)
    taskMetricsRecorder()?.noteRoute(sessionId, { engineId: ND_FAST_PATH_ENGINE_ID })

    try {
      await this.store.markExecution(context.task.id, sessionId)
      const fast = await executePreparedFastPath(prepared, this.core)
      const checkpointHead = taskWorktree ? await this.taskWorktrees.checkpoint(taskWorktree, context.task.title) : undefined
      if (checkpointHead) {
        await this.store.updateRunProvenance(run.id, { checkpointCommit: checkpointHead })
        await this.journalEffect({
          kind: 'checkpoint',
          state: 'complete',
          companyId: context.company.id,
          projectId: context.project.id,
          taskId: context.task.id,
          runId: run.id,
          resourceId: checkpointHead,
          idempotencyKey: `checkpoint:${run.id}:${checkpointHead}`,
        })
      }
      const verification = context.task.evidenceKind === 'artifact'
        ? await runArtifactVerification(context.task.artifactPaths, workspaceRoot, this.fingerprintArtifacts)
        : await runVerification(context.project.testCommand, workspaceRoot, this.verificationRuntime)
      await this.store.recordRunVerification(run.id, reviewVerificationMetadata(verification, checkpointHead))
      taskMetricsRecorder()?.noteVerification(sessionId, verification.status, verification.durationMs)
      await this.journalEffect({
        kind: 'verification.receipt',
        state: 'complete',
        companyId: context.company.id,
        projectId: context.project.id,
        taskId: context.task.id,
        runId: run.id,
        idempotencyKey: `verification:${run.id}`,
        data: {
          status: verification.status,
          durationMs: verification.durationMs,
          ...(verification.exitCode === undefined ? {} : { exitCode: verification.exitCode }),
          ...(verification.reason ? { reason: verification.reason } : {}),
        },
      })
      const output = fast.output + formatVerificationEvidence(verification)

      if (verification.status === 'failed') {
        const reason = `Machine verification failed: ${verification.reason ?? `exit ${verification.exitCode ?? 'unknown'}`}`
        await this.store.completeRun(run.id, output, reason)
        await this.failTask(context.task.id, reason)
        const queued = await this.queueVerificationRework(context.task.id, reason)
        this.cleanupTaskRouting(context.task.id)
        this.cleanupSession(sessionId)
        if (queued) await this.continueProject(context.project.id)
        return receipt(run)
      }

      const workflow = await this.workflowKinds(context.project.id)
      if (!workflow.has('review') && taskWorktree) {
        const integrationKey = `integration:${context.task.id}:${checkpointHead ?? run.id}`
        try {
          const recoveredHead = await this.beginIntegrationEffect({
            companyId: context.company.id,
            projectId: context.project.id,
            taskId: context.task.id,
            runId: run.id,
            idempotencyKey: integrationKey,
          })
          if (recoveredHead) {
            await this.store.markIntegrated(context.task.id, recoveredHead)
          } else {
            const integrated = await this.taskWorktrees.integrate(context.project.workspacePath, context.task.id)
            await this.journalEffect({
              kind: 'integration',
              state: 'complete',
              companyId: context.company.id,
              projectId: context.project.id,
              taskId: context.task.id,
              runId: run.id,
              resourceId: integrated.head,
              idempotencyKey: integrationKey,
            })
            await this.store.markIntegrated(context.task.id, integrated.head)
          }
        } catch (cause) {
          await this.journalEffect({
            kind: 'integration',
            state: cause instanceof TaskIntegrationConflictError ? 'failed' : 'uncertain',
            companyId: context.company.id,
            projectId: context.project.id,
            taskId: context.task.id,
            runId: run.id,
            idempotencyKey: integrationKey,
            data: { error: errorMessage(cause) },
          }).catch(() => undefined)
          throw cause
        }
      }
      await this.store.completeRun(run.id, output)
      if (workflow.has('review')) await this.store.markForReview(context.task.id, output)
      else await this.store.completeWithoutReview(context.task.id, output)
      this.cleanupTaskRouting(context.task.id)
      this.cleanupSession(sessionId)
      return receipt(run)
    } catch (cause) {
      const reason = errorMessage(cause)
      if (await this.store.runBySession(sessionId)) {
        await this.store.completeRun(run.id, undefined, reason).catch(() => undefined)
        await this.failTask(context.task.id, reason)
      }
      this.cleanupTaskRouting(context.task.id)
      this.cleanupSession(sessionId)
      throw new Error('Fast path failed closed: ' + reason)
    }
  }

  async reviewTask(taskId: string, explicit = true): Promise<OrganizationRunReceipt> {
    const context = await this.store.taskContext(taskId)
    this.assertPolicy(await this.store.policy(context.company.id, 'task.review'), explicit, 'task review')
    if (!explicit && context.company.autonomyLevel < 3) throw new Error('Autonomy level 3+ is required for automatic review')
    if (context.task.status !== 'review') throw new Error('Task must be ready for review')
    const reviewer = await this.store.reviewerForTask(taskId)
    const reviewerAgent = reviewer.agent
    const reviewerRole = reviewer.role
    const modelOpts = this.resolveAgentModel(reviewerAgent, reviewerRole)
    const taskWorktree = await this.taskWorktrees.existing(context.project.workspacePath, context.task.id)
    await this.assertTaskRunSlot(context.task.id, context.project.id, Boolean(taskWorktree))
    if (!taskWorktree) await this.prepareWorkspace(context.project.workspacePath)
    const reviewHead = taskWorktree ? await this.taskWorktrees.checkpoint(taskWorktree, context.task.title) : undefined
    const executionRun = (await this.store.state()).runs
      .filter((item) => item.taskId === taskId && item.kind === 'task-execution')
      .sort((left, right) => right.startedAt - left.startedAt)[0]
    const recordedVerification = recordedReviewVerification(executionRun, reviewHead, taskWorktree?.root ?? context.project.workspacePath, context.project.testCommand)
    const sessionId = await this.createHarnessSession(taskWorktree?.root, `Review · ${context.task.title}`)
    const run = await this.store.beginRun(
      'task-review',
      context.company.id,
      context.project.id,
      sessionId,
      context.task.id,
      context.task.goalId,
      {
        ...(taskWorktree ? { parallelTask: true } : {}),
        engineId: ND_HARNESS_ENGINE_ID,
        workspaceKind: taskWorktree ? 'git-worktree' : 'project-workspace',
        ...((taskWorktree?.root ?? context.project.workspacePath)
          ? { workspaceRoot: (taskWorktree?.root ?? context.project.workspacePath)! }
          : {}),
        ...(taskWorktree ? { workspaceBranch: taskWorktree.branch } : {}),
        ...(this.executionCoordinator?.currentPermit()?.id ? { runtimePermitId: this.executionCoordinator.currentPermit()!.id } : {}),
      },
    )
    if (reviewHead) await this.store.updateRunProvenance(run.id, { checkpointCommit: reviewHead })
    if (taskWorktree && reviewHead) this.reviewWorktrees.set(sessionId, { worktree: taskWorktree, head: reviewHead })
    this.lastProgressAt.set(sessionId, run.startedAt)
    await this.store.markReviewStarted(taskId, sessionId, reviewerAgent?.id)
    const decisionSupport = await this.decisionSupport?.reviewAssist({
      company: context.company.name,
      project: context.project.name,
      task: {
        id: context.task.id,
        title: context.task.title,
        description: context.task.description,
        acceptanceCriteria: context.task.acceptanceCriteria,
        ...(context.task.workScopes ? { workScopes: context.task.workScopes } : {}),
        ...(context.task.resultSummary ? { resultSummary: context.task.resultSummary } : {}),
      },
    })
    if (decisionSupport) {
      this.decisionSupportReceipts.set(sessionId, decisionSupport)
      await this.journalEffect({
        kind: 'decision.review-assist',
        state: 'complete',
        companyId: context.company.id,
        projectId: context.project.id,
        taskId: context.task.id,
        runId: run.id,
        idempotencyKey: `decision.review-assist:${run.id}`,
        data: {
          mode: decisionSupport.mode,
          threshold: decisionSupport.threshold,
          ...(decisionSupport.selectedProvider ? { selectedProvider: decisionSupport.selectedProvider } : {}),
          escalated: decisionSupport.escalated,
          ...(decisionSupport.kernelError ? { kernelError: decisionSupport.kernelError } : {}),
          attempts: decisionSupport.attempts.map((attempt) => ({
            provider: attempt.provider,
            ok: attempt.ok,
            ...(attempt.result ? {
              model: attempt.result.model,
              minimumConfidence: attempt.result.minimumConfidence,
              latencyMs: attempt.result.latencyMs,
            } : {}),
            ...(attempt.error ? { error: attempt.error } : {}),
          })),
        },
      })
    }
    try {
      const prompt = appendBrowserAccess(
        reviewPrompt(context.task, context, taskWorktree, formatDecisionSupportForReviewer(decisionSupport), recordedVerification),
        sessionId,
        this.browserAccess,
      )
      const reviewWorkspaceRoot = taskWorktree?.root ?? context.project.workspacePath
      await this.harness.run(prompt, {
        sessionId,
        ...modelOpts,
        ...(reviewWorkspaceRoot ? { workspaceCwd: reviewWorkspaceRoot } : {}),
      })
    } catch (cause) {
      const active = await this.store.runBySession(sessionId)
      if (active) {
        await this.store.completeRun(run.id, undefined, errorMessage(cause)).catch(() => undefined)
        await this.store.clearReviewSession(taskId).catch(() => undefined)
      }
      this.cleanupSession(sessionId)
      throw cause
    }
    return receipt(run)
  }

  async runNext(projectId?: string, explicit = true): Promise<OrganizationRunReceipt | null> {
    const state = await this.store.state()
    const id = projectId ?? state.activeProjectId
    if (!id) throw new Error('No active project')
    const project = state.projects.find((item) => item.id === id)
    if (!project) throw new Error('Project not found')
    const company = state.companies.find((item) => item.id === project.companyId)
    if (!company) throw new Error('Company not found')
    if (!explicit && company.autonomyLevel < 3) return null

    const running = state.runs.filter((item) => item.status === 'running')
    const globalRun = running.find((item) => item.kind === 'pm-plan' || !item.taskId)
    if (globalRun) {
      if (globalRun.projectId === id) return receipt(globalRun)
      if (explicit) throw new Error(`Another project already has an active ${globalRun.kind} run in session ${globalRun.sessionId}`)
      return null
    }

    const workflow = await this.workflowKinds(id)
    const reviewing = state.tasks.find((task) => task.projectId === id && task.status === 'review' && !task.reviewSessionId)
    if (reviewing) {
      if (workflow.has('review')) return this.reviewTask(reviewing.id, explicit)
      await this.store.completeWithoutReview(reviewing.id, reviewing.resultSummary ?? 'Worker session completed without a review step in this workflow.')
      return this.runNext(id, explicit)
    }

    const ready = await this.store.nextReadyTask(id)
    if (ready && workflow.has('execute')) {
      const first = await this.runTask(ready.id, explicit)
      if (company.autonomyLevel >= 4) await this.fillParallelReadyTasks(id)
      return first
    }

    if (running.length > 0) return receipt(running.find((item) => item.projectId === id) ?? running[0]!)

    const hasGoals = state.goals.some((goal) => goal.projectId === id)
    if (!hasGoals && workflow.has('plan')) {
      const hasFailedPlan = state.runs.some((run) => run.projectId === id && run.kind === 'pm-plan' && run.status === 'failed')
      if (hasFailedPlan && !explicit) return null
      return this.planProject(id, explicit)
    }
    return null
  }

  /** Cancel one organization run without touching unrelated workers. */
  async cancelRun(runId: string): Promise<void> {
    const state = await this.store.state()
    const run = state.runs.find((item) => item.id === runId && item.status === 'running')
    if (!run) throw new Error('Organization run is not active')
    this.canceledSessions.add(run.sessionId)
    const interruption = this.interruptionFinalizations.get(run.sessionId)
    if (interruption) {
      // The engine already ended. Join its in-flight rollback instead of
      // stopping a replacement runtime or starting another finalization.
      await interruption
      return
    }
    try {
      await this.stopSession(run.sessionId)
    } catch (error) {
      this.canceledSessions.delete(run.sessionId)
      throw error
    }
    const stillActive = await this.store.runBySession(run.sessionId)
    if (stillActive) await this.handleCanceledRun(stillActive, run.sessionId)
  }

  /**
   * Stop every live run for one project before the project is forgotten. Each
   * run goes through the normal cancellation path, so its session is stopped,
   * the task worktree is rolled back to its attempt baseline and the employee
   * that owned it is released. Failures propagate: a project is never forgotten
   * while an agent is still working on it.
   */
  async stopProjectWork(projectId: string): Promise<number> {
    const state = await this.store.state()
    const running = state.runs.filter((run) => run.projectId === projectId && run.status === 'running')
    let stopped = 0
    for (const run of running) {
      try {
        await this.cancelRun(run.id)
        stopped += 1
      } catch (error) {
        // A run that finished on its own between the read and the cancel is done,
        // not a failure to stop.
        const stillRunning = await this.store.activeRun(projectId)
        if (stillRunning) throw error
      }
    }
    return stopped
  }

  /**
   * Called by the existing organization reconciliation loop. A stale session is
   * canceled, rolled back and retried only when Autopilot and bounded policy
   * allow it; the 30-minute task lease is never used as a stall detector.
   */
  async reconcileStalledRuns(now = Date.now()): Promise<number> {
    if (this.stallReconcileBusy) return 0
    this.stallReconcileBusy = true
    let recovered = 0
    try {
      const state = await this.store.state()
      for (const run of state.runs.filter((item) => item.status === 'running' && item.kind === 'task-execution' && item.taskId)) {
        const lastProgress = this.lastProgressAt.get(run.sessionId) ?? run.startedAt
        if (now - lastProgress < stallTimeoutMs()) continue
        const message = `Execution stalled with no engine progress for ${stallTimeoutMs()}ms.`
        try { await this.stopSession(run.sessionId) } catch { /* recovery still fails closed below */ }
        const queued = await this.handleExecutionFailure(run, message, true)
        this.cleanupSession(run.sessionId)
        recovered += 1
        if (queued) {
          await delay(retryBackoffMs(await this.store.executionAttemptCount(run.taskId!)))
          await this.continueProject(run.projectId)
        }
      }
      // A hung reviewer would otherwise hold the task in "Reviewing…" until restart.
      // The work itself is intact, so the task simply returns to the review queue.
      for (const run of state.runs.filter((item) => item.status === 'running' && item.kind === 'task-review' && item.taskId)) {
        const lastProgress = this.lastProgressAt.get(run.sessionId) ?? run.startedAt
        if (now - lastProgress < stallTimeoutMs()) continue
        const message = `Review stalled with no engine progress for ${stallTimeoutMs()}ms; the task is back in review and can be reviewed again.`
        try { await this.stopSession(run.sessionId) } catch { /* the run is still failed and released below */ }
        await this.store.completeRun(run.id, undefined, message)
        await this.store.clearReviewSession(run.taskId!)
        this.cleanupSession(run.sessionId)
        recovered += 1
      }
      return recovered
    } finally {
      this.stallReconcileBusy = false
    }
  }

  async handleHarnessEvent(frame: DshEventFrame): Promise<void> {
    const sessionId = frame.sessionId
    if (!sessionId) return
    this.lastProgressAt.set(sessionId, Date.now())
    const run = await this.store.runBySession(sessionId)
    const cancellation = this.cancellationFinalizations.get(sessionId)
    if (cancellation) {
      await cancellation
      return
    }
    const interruption = this.interruptionFinalizations.get(sessionId)
    if (interruption) {
      await interruption
      return
    }
    // Late terminal frames and unrelated personal chats own no organization
    // run. Its finalizer already released the session; do not release it again.
    if (!run) {
      this.lastProgressAt.delete(sessionId)
      return
    }

    if (frame.kind === 'session-event' && frame.event && run) {
      const data = frame.event.data as Record<string, unknown> | undefined
      const reason = data?.reason
      if (frame.event.type === 'turn/end' && reason && typeof reason === 'object' && (reason as Record<string, unknown>).kind === 'interrupted') {
        if (this.consumeCanceledSession(sessionId)) await this.handleCanceledRun(run, sessionId)
        else {
          const detail = (reason as Record<string, unknown>).message
          const finalization = this.finalizeInterruptedRun(run, sessionId, typeof detail === 'string' ? detail.slice(0, 2_000) : undefined)
          this.interruptionFinalizations.set(sessionId, finalization)
          try { await finalization } finally { this.interruptionFinalizations.delete(sessionId) }
        }
        return
      }
      const text = frame.event.type === 'assistant/chunk'
        ? messageText(data?.chunk)
        : frame.event.type === 'assistant/message'
          ? messageText(data?.message)
          : undefined
      if (text !== undefined) {
        const accumulated = frame.event.type === 'assistant/chunk'
          ? `${this.finalText.get(sessionId) ?? ''}${text}`
          : text
        this.finalText.set(sessionId, accumulated)
        if (!this.structuredHandled.has(sessionId)) {
          if (run.kind === 'pm-plan') await this.handlePlan(run.projectId, sessionId, accumulated)
          if (run.kind === 'task-review' && run.taskId) await this.handleReview(run.taskId, run.projectId, sessionId, accumulated)
        }
      }
      return
    }

    if (frame.kind === 'agent-error' && run) {
      if (this.consumeCanceledSession(sessionId)) {
        await this.handleCanceledRun(run, sessionId)
        return
      }
      if (run.kind === 'task-execution' && run.taskId) {
        const queued = await this.handleExecutionFailure(run, frame.message ?? 'Agent error')
        this.cleanupSession(sessionId)
        if (queued) {
          await delay(retryBackoffMs(await this.store.executionAttemptCount(run.taskId)))
          await this.continueProject(run.projectId)
        }
        return
      }
      await this.store.completeRun(run.id, this.finalText.get(sessionId), frame.message ?? 'Agent error')
      if (run.taskId) await this.failTask(run.taskId, frame.message ?? 'Agent error')
      this.cleanupSession(sessionId)
      if (run.kind !== 'pm-plan') await this.continueProject(run.projectId)
      return
    }

    if (frame.kind !== 'session-status' || frame.running !== false) return

    const canceled = this.consumeCanceledSession(sessionId)
    if (canceled) {
      if (run) await this.handleCanceledRun(run, sessionId)
      else this.cleanupSession(sessionId)
      return
    }

    if (run?.kind === 'task-execution' && run.taskId) {
      const workerOutput = `${this.finalText.get(sessionId) ?? 'Worker session finished.'}${this.routeEvidence(sessionId)}`
      try {
        const context = await this.store.taskContext(run.taskId)
        const worktree = await this.taskWorktrees.existing(context.project.workspacePath, run.taskId)
        const checkpointHead = worktree ? await this.taskWorktrees.checkpoint(worktree, context.task.title) : undefined
        if (checkpointHead) {
          await this.store.updateRunProvenance(run.id, { checkpointCommit: checkpointHead })
          await this.journalEffect({
            kind: 'checkpoint',
            state: 'complete',
            companyId: context.company.id,
            projectId: context.project.id,
            taskId: context.task.id,
            runId: run.id,
            resourceId: checkpointHead,
            idempotencyKey: `checkpoint:${run.id}:${checkpointHead}`,
          })
        }
        const verification = context.task.evidenceKind === 'artifact'
          ? await runArtifactVerification(context.task.artifactPaths, worktree?.root ?? context.project.workspacePath, this.fingerprintArtifacts)
          : await runVerification(context.project.testCommand, worktree?.root ?? context.project.workspacePath, this.verificationRuntime)
        await this.store.recordRunVerification(run.id, reviewVerificationMetadata(verification, checkpointHead))
        taskMetricsRecorder()?.noteVerification(sessionId, verification.status, verification.durationMs)
        await this.journalEffect({
          kind: 'verification.receipt',
          state: 'complete',
          companyId: context.company.id,
          projectId: context.project.id,
          taskId: context.task.id,
          runId: run.id,
          idempotencyKey: `verification:${run.id}`,
          data: {
            status: verification.status,
            durationMs: verification.durationMs,
            ...(verification.exitCode === undefined ? {} : { exitCode: verification.exitCode }),
            ...(verification.reason ? { reason: verification.reason } : {}),
          },
        })
        const output = `${workerOutput}${formatVerificationEvidence(verification)}`
        if (verification.status === 'failed') {
          const message = `Machine verification failed: ${verification.reason ?? `exit ${verification.exitCode ?? 'unknown'}`}`
          await this.store.completeRun(run.id, output, message)
          await this.failTask(run.taskId, message)
          const queued = await this.queueVerificationRework(run.taskId, message)
          this.cleanupTaskRouting(run.taskId)
          this.cleanupSession(sessionId)
          if (queued) await this.continueProject(run.projectId)
          return
        }
        const workflow = await this.workflowKinds(run.projectId)
        if (!workflow.has('review') && worktree) {
          const integrationKey = `integration:${run.taskId}:${checkpointHead ?? run.id}`
          try {
            const recoveredHead = await this.beginIntegrationEffect({
              companyId: context.company.id,
              projectId: context.project.id,
              taskId: run.taskId,
              runId: run.id,
              idempotencyKey: integrationKey,
            })
            if (recoveredHead) {
              await this.store.markIntegrated(run.taskId, recoveredHead)
            } else {
              const integrated = await this.taskWorktrees.integrate(context.project.workspacePath, run.taskId)
              await this.journalEffect({
                kind: 'integration',
                state: 'complete',
                companyId: context.company.id,
                projectId: context.project.id,
                taskId: run.taskId,
                runId: run.id,
                resourceId: integrated.head,
                idempotencyKey: integrationKey,
              })
              await this.store.markIntegrated(run.taskId, integrated.head)
            }
          } catch (cause) {
            await this.journalEffect({
              kind: 'integration',
              state: cause instanceof TaskIntegrationConflictError ? 'failed' : 'uncertain',
              companyId: context.company.id,
              projectId: context.project.id,
              taskId: run.taskId,
              runId: run.id,
              idempotencyKey: integrationKey,
              data: { error: errorMessage(cause) },
            }).catch(() => undefined)
            throw cause
          }
        }
        await this.store.completeRun(run.id, output)
        if (workflow.has('review')) await this.store.markForReview(run.taskId, output)
        else await this.store.completeWithoutReview(run.taskId, output)
        this.cleanupTaskRouting(run.taskId)
      } catch (cause) {
        const message = errorMessage(cause)
        await this.store.completeRun(run.id, workerOutput, message).catch(() => undefined)
        if (cause instanceof TaskIntegrationConflictError) {
          await this.store.markIntegrationConflict(run.taskId, message).catch(() => undefined)
        } else {
          await this.failTask(run.taskId, message)
        }
      }
      this.cleanupSession(sessionId)
      await this.continueProject(run.projectId)
      return
    }

    if (run && this.structuredHandled.has(sessionId)) {
      await this.store.completeRun(run.id, this.finalText.get(sessionId))
    } else if (run && (run.kind === 'pm-plan' || run.kind === 'task-review')) {
      await delay(STRUCTURED_RESULT_GRACE_MS)
      const reopened = await this.store.runBySession(sessionId)
      if (!reopened) {
        this.cleanupSession(sessionId)
        return
      }
      if (this.structuredHandled.has(sessionId)) {
        await this.store.completeRun(run.id, this.finalText.get(sessionId))
      } else {
        const detail = this.structuredErrors.get(sessionId)
        const message = detail
          ? `Structured ${run.kind} failed: ${detail}`
          : `Expected structured ${run.kind} result was not produced`
        await this.store.completeRun(run.id, this.finalText.get(sessionId), message)
        if (run.taskId) {
          // Keep the completed worker evidence reviewable. A malformed or
          // truncated reviewer response is a retryable review failure, not a
          // reason to hide the task behind the blocked state.
          await this.store.clearReviewSession(run.taskId)
        }
      }
    } else if (run) {
      const detail = this.structuredErrors.get(sessionId)
      const message = detail
        ? `Structured ${run.kind} failed: ${detail}`
        : `Expected structured ${run.kind} result was not produced`
      await this.store.completeRun(run.id, this.finalText.get(sessionId), message)
      if (run.taskId) await this.failTask(run.taskId, detail ? `Structured review failed: ${detail}` : 'Structured review result was not produced')
    }

    const project = this.autoAdvance.get(sessionId)
    this.cleanupSession(sessionId)
    if (project) await this.continueProject(project)
  }

  private async handlePlan(projectId: string, sessionId: string, text: string): Promise<void> {
    let plan: ProjectPlanInput | undefined
    let adjustments: string[] = []
    try {
      let mergedLists = 0
      const extracted = extractTaggedJson<ProjectPlanInput>(text, 'nd-dsh-plan', ['goal', 'milestones'], (json) => {
        const repaired = mergeRepeatedArrayKeys(json, ['milestones', 'tasks'])
        mergedLists = repaired.merged
        return repaired.json
      })
      if (!extracted) return
      ;({ plan, adjustments } = normalizeProjectPlan(extracted, { recoverRepeatedLists: mergedLists > 0 }))
      if (mergedLists) adjustments.unshift(`Merged ${mergedLists} repeated milestone/task list(s) the model wrote as duplicate keys.`)
      this.structuredErrors.delete(sessionId)
    } catch (cause) {
      this.structuredErrors.set(sessionId, errorMessage(cause))
      return
    }
    if (this.structuredInFlight.has(sessionId)) return
    this.structuredInFlight.add(sessionId)
    try {
      await this.store.applyPlan(projectId, plan, adjustments)
    } catch (cause) {
      this.structuredErrors.set(sessionId, `Failed to apply plan: ${errorMessage(cause)}`)
      throw cause
    } finally {
      this.structuredInFlight.delete(sessionId)
    }
    this.structuredHandled.add(sessionId)
    this.autoAdvance.set(sessionId, projectId)
  }

  private async handleReview(taskId: string, projectId: string, sessionId: string, text: string): Promise<void> {
    let review: ReviewVerdict | undefined
    try {
      review = extractTaggedJson<ReviewVerdict>(text, 'nd-dsh-review', ['verdict', 'summary'])
      if (!review) return
      if ((review.verdict !== 'pass' && review.verdict !== 'fail') || typeof review.summary !== 'string' || !review.summary.trim()) {
        throw new Error('Invalid ND-DSH review result: verdict must be pass or fail with non-empty summary')
      }
      this.structuredErrors.delete(sessionId)
    } catch (cause) {
      this.structuredErrors.set(sessionId, errorMessage(cause))
      return
    }
    if (this.structuredInFlight.has(sessionId)) return
    this.structuredInFlight.add(sessionId)
    try {
      const issueText = review.issues?.length ? `\nIssues: ${review.issues.join('; ')}` : ''
      let summary = `${review.summary}${issueText}${formatDecisionSupportReceipt(this.decisionSupportReceipts.get(sessionId))}`
      const context = await this.store.taskContext(taskId)
      const reviewRun = await this.store.runBySession(sessionId)
      const reviewRunId = reviewRun?.id ?? sessionId
      let passed = review.verdict === 'pass'
      let integrationConflict = false
      if (passed) {
        const checkpoint = this.reviewWorktrees.get(sessionId)
        if (checkpoint) {
          const integrationKey = `integration:${taskId}:${checkpoint.head}`
          try {
            await this.taskWorktrees.assertUnchanged(checkpoint.worktree, checkpoint.head)
            const recoveredHead = await this.beginIntegrationEffect({
              companyId: context.company.id,
              projectId: context.project.id,
              taskId,
              runId: reviewRunId,
              idempotencyKey: integrationKey,
            })
            if (recoveredHead) {
              await this.store.markIntegrated(taskId, recoveredHead)
            } else {
              const integrated = await this.taskWorktrees.integrate(context.project.workspacePath, taskId)
              await this.journalEffect({
                kind: 'integration',
                state: 'complete',
                companyId: context.company.id,
                projectId: context.project.id,
                taskId,
                runId: reviewRunId,
                resourceId: integrated.head,
                idempotencyKey: integrationKey,
              })
              await this.store.markIntegrated(taskId, integrated.head)
            }
          } catch (cause) {
            await this.journalEffect({
              kind: 'integration',
              state: cause instanceof TaskIntegrationConflictError ? 'failed' : 'uncertain',
              companyId: context.company.id,
              projectId: context.project.id,
              taskId,
              runId: reviewRunId,
              idempotencyKey: integrationKey,
              data: { error: errorMessage(cause) },
            }).catch(() => undefined)
            passed = false
            integrationConflict = cause instanceof TaskIntegrationConflictError
            summary = `${summary}\nIntegration/evidence gate: ${errorMessage(cause)}`
            if (integrationConflict) await this.store.markIntegrationConflict(taskId, summary)
          }
        }
      }
      const executionAttempts = await this.store.executionAttemptCount(taskId)
      const automaticRework = !passed
        && !integrationConflict
        && context.company.autonomyLevel >= 4
        && executionAttempts < MAX_EXECUTION_ATTEMPTS

      await this.journalEffect({
        kind: 'review.result',
        state: 'complete',
        companyId: context.company.id,
        projectId: context.project.id,
        taskId,
        runId: reviewRunId,
        idempotencyKey: `review:${taskId}:${reviewRunId}`,
        data: {
          verdict: passed ? 'pass' : 'fail',
          issueCount: review.issues?.length ?? 0,
          integrationConflict,
        },
      })
      await this.store.completeReview(taskId, passed, summary, review.memory ?? [])
      if (automaticRework) await this.store.queueRework(taskId, summary)
    } finally {
      this.structuredInFlight.delete(sessionId)
    }
    this.structuredHandled.add(sessionId)
    this.autoAdvance.set(sessionId, projectId)
  }

  private async handleExecutionFailure(run: OrganizationRun, message: string, stalled = false): Promise<boolean> {
    if (!run.taskId) return false
    const active = await this.store.runBySession(run.sessionId)
    if (!active) return false
    const rollback = await this.rollbackExecutionAttempt(run.sessionId)
    const canceled = this.consumeCanceledSession(run.sessionId)
    const failure = canceled ? 'Canceled by user before the run completed.' : message
    if (canceled) taskMetricsRecorder()?.noteCanceled(run.sessionId)
    const detail = rollback ? failure : `${failure}\nRollback failed; automatic retry disabled.`
    const output = `${this.finalText.get(run.sessionId) ?? ''}${this.routeEvidence(run.sessionId)}` || undefined
    await this.store.completeRun(run.id, output, detail).catch(() => undefined)
    await this.failTask(run.taskId, detail)
    if (canceled) this.cleanupTaskRouting(run.taskId)
    if (!rollback || canceled) return false
    const context = await this.store.taskContext(run.taskId)
    const attempts = await this.store.executionAttemptCount(run.taskId)
    const retryable = stalled || isRetryableExecutionFailure(message)
    if (context.company.autonomyLevel < 4 || attempts >= MAX_EXECUTION_ATTEMPTS || !retryable) return false
    const fallback = await this.selectFallbackProviderRoute(context)
    if (fallback) this.pendingFallbackRoutes.set(run.taskId, fallback)
    await this.store.queueRework(run.taskId, `${stalled ? 'Stall recovery' : 'Transient engine/provider failure'}: ${message}`)
    return true
  }

  private async queueVerificationRework(taskId: string, message: string): Promise<boolean> {
    const context = await this.store.taskContext(taskId)
    const attempts = await this.store.executionAttemptCount(taskId)
    if (context.company.autonomyLevel < 4 || attempts >= MAX_EXECUTION_ATTEMPTS) return false
    await this.store.queueRework(taskId, message)
    return true
  }

  private async handleCanceledRun(run: OrganizationRun, sessionId: string): Promise<void> {
    const interruption = this.interruptionFinalizations.get(sessionId)
    if (interruption) return interruption
    const existing = this.cancellationFinalizations.get(sessionId)
    if (existing) return existing
    // The cancel RPC response and engine stop/error events arrive independently.
    // Share one finalization so they cannot race Git rollback or release twice.
    const finalization = this.finalizeCanceledRun(run, sessionId)
    this.cancellationFinalizations.set(sessionId, finalization)
    try {
      await finalization
    } finally {
      this.cancellationFinalizations.delete(sessionId)
    }
  }

  private async finalizeInterruptedRun(run: OrganizationRun, sessionId: string, reason?: string): Promise<void> {
    // The journal is authoritative for interruption even when the runtime never
    // emits the separate running=false status. Ordinary turn/end events are not
    // terminal at this boundary: structured assistant output can arrive later.
    if (!(await this.store.runBySession(sessionId))) return
    if (this.consumeCanceledSession(sessionId)) {
      await this.finalizeCanceledRun(run, sessionId)
      return
    }
    const message = `Agent turn interrupted before the run completed.${reason?.trim() ? ` ${reason.trim()}` : ''}`
    if (run.kind === 'task-execution' && run.taskId) {
      const queued = await this.handleExecutionFailure(run, message)
      this.cleanupSession(sessionId)
      if (queued) {
        await delay(retryBackoffMs(await this.store.executionAttemptCount(run.taskId)))
        await this.continueProject(run.projectId)
      }
      return
    }
    await this.store.completeRun(run.id, this.finalText.get(sessionId), message)
    if (run.kind === 'task-review' && run.taskId) await this.store.clearReviewSession(run.taskId)
    this.cleanupSession(sessionId)
  }

  private async finalizeCanceledRun(run: OrganizationRun, sessionId: string): Promise<void> {
    // A delayed caller may still hold the snapshot from before cleanup finished.
    if (!(await this.store.runBySession(sessionId))) return
    const message = 'Canceled by user before the run completed.'
    taskMetricsRecorder()?.noteCanceled(sessionId)
    if (run.kind === 'task-execution') await this.rollbackExecutionAttempt(sessionId)
    const output = `${this.finalText.get(sessionId) ?? ''}${this.routeEvidence(sessionId)}` || undefined
    await this.store.completeRun(run.id, output, message)
    if (run.taskId) {
      await this.failTask(run.taskId, message)
      this.cleanupTaskRouting(run.taskId)
    }
    this.cleanupSession(sessionId)
  }

  private async rollbackExecutionAttempt(sessionId: string): Promise<boolean> {
    const boundary = this.executionBaselines.get(sessionId)
    if (!boundary) return false
    try {
      await this.taskWorktrees.rollback(boundary.worktree, boundary.head)
      return true
    } catch (error) {
      console.warn('Organization attempt rollback failed:', errorMessage(error))
      return false
    }
  }

  private async selectFallbackProviderRoute(context: Awaited<ReturnType<OrganizationStore['taskContext']>>): Promise<ProviderRoute | undefined> {
    const attempted = this.attemptedProviderRoutes.get(context.task.id) ?? new Set<string>()
    const assignedEngineId = this.engines ? await this.engines.assignedEngine(context.agent?.id) : ND_HARNESS_ENGINE_ID
    if (assignedEngineId === ND_HARNESS_ENGINE_ID && attempted.size === 0) {
      const configured = this.resolveAgentModel(context.agent, context.role)
      const provider = configured.provider ?? this.harness.status().provider
      const model = configured.model ?? this.harness.status().model
      if (provider && model) attempted.add(providerRouteKey(provider, model))
    }
    this.attemptedProviderRoutes.set(context.task.id, attempted)

    const catalog = await this.harness.gatewayRpc('session.models').catch(() => undefined)
    if (!catalog?.ok || !catalog.value || typeof catalog.value !== 'object') return undefined
    const groups = (catalog.value as { groups?: unknown }).groups
    if (!Array.isArray(groups)) return undefined
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue
      const provider = typeof (group as { id?: unknown }).id === 'string' ? (group as { id: string }).id.trim() : ''
      const models = (group as { models?: unknown }).models
      if (!provider || !Array.isArray(models)) continue
      for (const item of models) {
        if (!item || typeof item !== 'object') continue
        const model = typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id.trim() : ''
        if (!model || attempted.has(providerRouteKey(provider, model))) continue
        return { provider, model }
      }
    }
    return undefined
  }

  private effectiveExecutionRoute(engineId: string, attempt: number, modelOpts: { provider?: string; model?: string }): ExecutionRoute {
    if (engineId !== ND_HARNESS_ENGINE_ID) return { engineId, attempt }
    const provider = modelOpts.provider ?? this.harness.status().provider
    const model = modelOpts.model ?? this.harness.status().model
    return {
      engineId,
      attempt,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    }
  }

  private noteProviderAttempt(taskId: string, route: ExecutionRoute): void {
    if (!route.provider || !route.model) return
    const routes = this.attemptedProviderRoutes.get(taskId) ?? new Set<string>()
    routes.add(providerRouteKey(route.provider, route.model))
    this.attemptedProviderRoutes.set(taskId, routes)
  }

  private routeEvidence(sessionId: string): string {
    const route = this.executionRoutes.get(sessionId)
    return route ? `\n\n<nd-dsh-execution-route>${JSON.stringify(route)}</nd-dsh-execution-route>` : ''
  }

  private async beginIntegrationEffect(input: {
    companyId: string
    projectId: string
    taskId: string
    runId: string
    idempotencyKey: string
  }): Promise<string | undefined> {
    if (this.core) {
      const recovery = await this.core.request<{
        state: 'notStarted' | 'inProgress' | 'knownComplete' | 'knownFailed' | 'outcomeUncertain'
        record?: { resourceId?: string }
      }>('effectJournal.state', { idempotencyKey: input.idempotencyKey }, 5_000)
      if (recovery.state === 'knownComplete') {
        const head = recovery.record?.resourceId
        if (!head) throw new Error('Completed integration effect has no recorded integrated head.')
        return head
      }
      if (recovery.state === 'inProgress' || recovery.state === 'outcomeUncertain') {
        throw new Error(`Integration effect ${input.idempotencyKey} requires reconciliation before retry.`)
      }
    }
    await this.journalEffect({
      kind: 'integration',
      state: 'intent',
      companyId: input.companyId,
      projectId: input.projectId,
      taskId: input.taskId,
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
    })
    return undefined
  }

  private async journalEffect(input: {
    kind: string
    state: 'intent' | 'complete' | 'failed' | 'uncertain'
    companyId?: string
    projectId?: string
    taskId?: string
    runId?: string
    resourceId?: string
    idempotencyKey?: string
    data?: unknown
  }): Promise<void> {
    if (!this.core) return
    await this.core.request('effectJournal.append', {
      kind: input.kind,
      state: input.state,
      ...(input.companyId ? { companyId: input.companyId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.data === undefined ? {} : { data: input.data }),
    }, 5_000)
  }

  private cleanupTaskRouting(taskId: string): void {
    this.attemptedProviderRoutes.delete(taskId)
    this.pendingFallbackRoutes.delete(taskId)
  }

  private async stopSession(sessionId: string): Promise<void> {
    if (this.executionRoutes.get(sessionId)?.engineId === ND_FAST_PATH_ENGINE_ID) return
    if (this.engineRuns) return this.engineRuns.stopSession(sessionId)
    const result = await this.harness.gatewayRpc('session.cancel', { sessionId })
    if (!result.ok) throw new Error(result.error?.message ?? 'Harness session.cancel failed')
  }

  private consumeCanceledSession(sessionId: string): boolean {
    if (this.canceledSessions.has(sessionId)) return true
    if (!this.harness.consumeCanceledSession(sessionId)) return false
    this.canceledSessions.add(sessionId)
    return true
  }

  private async continueProject(projectId: string): Promise<void> {
    try {
      await this.runNext(projectId, false)
    } catch (error) {
      console.warn('Organization autopilot paused:', error instanceof Error ? error.message : String(error))
    }
  }

  private async fillParallelReadyTasks(projectId: string): Promise<void> {
    if (this.parallelFillProjects.has(projectId)) return
    this.parallelFillProjects.add(projectId)
    try {
      // The bound is an iteration guard, not a capacity decision: it caps how
      // many runs one round starts. Every
      // dispatch still acquires its own permit, and the availability probe is
      // what ends a round when a pool is full.
      for (let attempt = 0; attempt < MAX_AUTOPILOT_PARALLEL_FILL; attempt += 1) {
        const state = await this.store.state()
        const project = state.projects.find((item) => item.id === projectId)
        const company = project ? state.companies.find((item) => item.id === project.companyId) : undefined
        if (!project || company?.autonomyLevel !== 4) return
        const { task, capacityBound } = await this.nextDispatchableTask(projectId)
        if (!task) {
          if (capacityBound) this.capacityWaiting.add(projectId)
          else this.capacityWaiting.delete(projectId)
          return
        }
        this.capacityWaiting.delete(projectId)
        try {
          await this.runTask(task.id, false)
        } catch (error) {
          // A pool filled between the probe and the acquire. The run never
          // started, so no task record and no run receipt claim a failure; the
          // round just waits for the next release.
          if (error instanceof RuntimeCapacityError) {
            this.capacityWaiting.add(projectId)
            return
          }
          console.warn('Parallel autopilot fill paused:', errorMessage(error))
          return
        }
      }
    } finally {
      this.parallelFillProjects.delete(projectId)
    }
  }

  /**
   * The ready task this round should dispatch next, plus whether the round is
   * ending because every candidate hit a full pool. A full project pool refuses
   * all of them; a full role or team pool refuses only the tasks that carry it,
   * so a lower-priority task can still proceed.
   */
  private async nextDispatchableTask(projectId: string): Promise<{ task: OrganizationTask | undefined; capacityBound: boolean }> {
    // The round's dispatch limit must not truncate the readiness scan: a full
    // role pool can hold an arbitrarily long prefix while another role is free.
    const allCandidates = await this.store.readyTasks(projectId)
    const candidates = allCandidates.filter((t) => t.assigneeKind !== 'human' && (t.assignedAgentId || !t.assignedMemberId))
    if (!this.dispatchAvailability) return { task: candidates[0], capacityBound: false }
    let capacityBound = false
    for (const candidate of candidates) {
      const availability = await this.dispatchAvailability(projectId, candidate.id, 'task.execute')
      if (availability.granted) return { task: candidate, capacityBound }
      if (availability.blockedPool) capacityBound = true
    }
    return { task: undefined, capacityBound }
  }

  private resolveAgentModel(agent?: OrganizationAgent, role?: OrganizationRole): { provider?: string; model?: string } {
    const provider = agent?.providerId ?? role?.providerId
    const model = agent?.modelId ?? role?.modelId
    return provider && model ? { provider, model } : {}
  }

  private async failTask(taskId: string, message: string): Promise<void> {
    const state = await this.store.state()
    const task = state.tasks.find((item) => item.id === taskId)
    if (!task) return
    await this.store.blockTask(taskId, message)
    if (task.assignedAgentId) {
      const hasOtherActiveRun = state.runs.some((run) => run.status === 'running' && run.taskId && run.taskId !== taskId
        && state.tasks.find((candidate) => candidate.id === run.taskId)?.assignedAgentId === task.assignedAgentId)
      if (!hasOtherActiveRun) {
        await this.store.mutate({ type: 'agent.update', id: task.assignedAgentId, patch: { status: 'idle' } }).catch(() => undefined)
      }
    }
    console.warn(`Organization task blocked: ${message}`)
  }

  private async assertNoActiveRun(projectId: string): Promise<void> {
    const active = (await this.store.state()).runs.find((item) => item.status === 'running')
    if (!active) return
    if (active.projectId === projectId) throw new Error(`Project already has an active ${active.kind} run in session ${active.sessionId}`)
    throw new Error(`Another project already has an active ${active.kind} run in session ${active.sessionId}`)
  }

  private async assertTaskRunSlot(taskId: string, projectId: string, isolated: boolean): Promise<void> {
    const state = await this.store.state()
    const active = state.runs.filter((item) => item.status === 'running')
    if (active.length === 0) return
    if (!isolated) throw new Error('Task cannot run beside another organization run without an isolated Git worktree')
    const global = active.find((item) => item.kind === 'pm-plan' || !item.taskId)
    if (global) throw new Error(`Global ${global.kind} run is active in session ${global.sessionId}`)
    const sameTask = active.find((item) => item.taskId === taskId)
    if (sameTask) throw new Error(`Task already has an active ${sameTask.kind} run in session ${sameTask.sessionId}`)
    // Agent records are logical employees, not single OS worker slots. The
    // control plane owns bounded capacity; isolated task worktrees own safety.
    for (const run of active) {
      if (!run.taskId) throw new Error('Non-task organization work cannot overlap task execution')
      const context = await this.store.taskContext(run.taskId)
      const worktree = await this.taskWorktrees.existing(context.project.workspacePath, run.taskId)
      if (!worktree) throw new Error(`Active task ${run.taskId} is not isolated in a Git worktree`)
    }
    const project = state.projects.find((item) => item.id === projectId)
    if (!project) throw new Error('Project not found')
  }

  private async resolveTaskEngine(agentId: string | undefined, fallback: boolean, subagentMode: OrganizationSubagentMode): Promise<TaskEngine> {
    if (!this.engines || fallback) {
      if (this.engines && fallback) {
        const descriptor = this.engines.assertAvailable(ND_HARNESS_ENGINE_ID)
        return { id: descriptor.id, name: descriptor.name, ...(descriptor.workerInstructions === undefined ? {} : { workerInstructions: descriptor.workerInstructions }) }
      }
      return { id: ND_HARNESS_ENGINE_ID, name: 'ND Harness' }
    }
    const engineId = await this.engines.assignedEngine(agentId)
    const descriptor = this.engines.assertAvailable(engineId)
    if (subagentMode === 'off' && descriptor.id === CODEX_ENGINE_ID) {
      throw new Error('Subagents are disabled for this company, but the delegated Codex engine requires subagent_codex. Use Codex CLI/direct or enable automatic subagents.')
    }
    return {
      id: descriptor.id,
      name: descriptor.name,
      ...(descriptor.workerInstructions === undefined ? {} : { workerInstructions: descriptor.workerInstructions }),
    }
  }

  private async workflowKinds(projectId: string): Promise<Set<WorkflowKind>> {
    const workflow = await this.store.workflowForProject(projectId)
    const kinds = new Set<WorkflowKind>()
    for (const step of workflow?.steps ?? []) kinds.add(step.kind)
    if (kinds.size === 0) {
      kinds.add('plan')
      kinds.add('execute')
      kinds.add('review')
    }
    return kinds
  }

  private cleanupSession(sessionId: string): void {
    this.browserAccess?.revokeSessionAccess(sessionId)
    void this.executionCoordinator?.releaseSession(sessionId).catch((error) => {
      console.warn('Runtime permit release failed:', error instanceof Error ? error.message : String(error))
    })
    this.finalText.delete(sessionId)
    this.structuredHandled.delete(sessionId)
    this.structuredInFlight.delete(sessionId)
    this.structuredErrors.delete(sessionId)
    this.autoAdvance.delete(sessionId)
    this.reviewWorktrees.delete(sessionId)
    this.executionBaselines.delete(sessionId)
    this.executionRoutes.delete(sessionId)
    this.canceledSessions.delete(sessionId)
    this.lastProgressAt.delete(sessionId)
    this.decisionSupportReceipts.delete(sessionId)
  }

  private assertPolicy(effect: 'allow' | 'ask' | 'deny', explicit: boolean, label: string): void {
    if (effect === 'deny') throw new Error(`${label} is denied by company policy`)
    if (effect === 'ask' && !explicit) throw new Error(`${label} requires human approval`)
  }

  private async prepareWorkspace(workspacePath: string | undefined): Promise<void> {
    if (!workspacePath || this.workspace.state().root === workspacePath) return
    await this.harness.close()
    await this.workspace.setRoot(workspacePath)
  }

  private async createHarnessSession(cwd?: string, title?: string): Promise<string> {
    const sessionId = await (async (): Promise<string> => {
      if (!cwd) return this.harness.createSession()
      const result = await this.harness.gatewayRpc('session.create', { cwd })
      if (!result.ok) throw new Error(result.error?.message ?? 'Harness session.create failed')
      const sessionId = (result.value as { sessionId?: unknown } | undefined)?.sessionId
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('Harness session.create returned no session id')
      return sessionId
    })()
    if (title?.trim()) await this.nameSession(sessionId, title)
    return sessionId
  }

  /**
   * Name a session after the work it performs. The runtime otherwise labels
   * sessions with a first-prompt fallback ("You are Builder acting as…"),
   * which hides the real task from the chat sidebar. Best-effort: a rename
   * failure must never fail the run the session belongs to.
   */
  private async nameSession(sessionId: string, title: string): Promise<void> {
    try {
      await this.harness.renameSession(sessionId, title)
    } catch (cause) {
      console.warn(`organization: session rename failed for ${sessionId}:`, cause instanceof Error ? cause.message : String(cause))
    }
  }

  /**
   * Rename harness-backed organization sessions that still carry the runtime's
   * "You are…" first-prompt fallback — sessions created before ND began naming
   * them at creation time. Only fallback titles are touched, so a user rename
   * or a real title is never overwritten. Safe to re-run: renames no-op once
   * the title is real.
   */
  async backfillSessionTitles(): Promise<void> {
    try {
      const result = await this.harness.gatewayRpc('session.list')
      if (!result.ok) return
      const items = (result.value as { items?: Array<{ sessionId?: unknown; projections?: { values?: Record<string, unknown> } }> } | undefined)?.items ?? []
      const listedTitle = new Map(items.flatMap((item) => {
        const sessionId = item.sessionId
        const title = item.projections?.values?.title
        return typeof sessionId === 'string' && typeof title === 'string' ? [[sessionId, title] as const] : []
      }))
      const state = await this.store.state()
      const projectNameById = new Map(state.projects.map((project) => [project.id, project.name]))
      const taskTitleById = new Map(state.tasks.map((task) => [task.id, task.title]))
      for (const run of state.runs) {
        const current = listedTitle.get(run.sessionId)
        if (current === undefined || !current.trimStart().startsWith('You are')) continue
        const taskTitle = run.taskId ? taskTitleById.get(run.taskId) : undefined
        const title = run.kind === 'pm-plan'
          ? `Plan · ${projectNameById.get(run.projectId) ?? 'project'}`
          : run.kind === 'task-review'
            ? (taskTitle ? `Review · ${taskTitle}` : undefined)
            : taskTitle
        if (!title?.trim()) continue
        await this.nameSession(run.sessionId, title)
      }
    } catch (cause) {
      console.warn('organization: session title backfill failed:', cause instanceof Error ? cause.message : String(cause))
    }
  }

  private async warmProjectTarget(projectId: string): Promise<void> {
    if (!this.projectRuntime) return
    try {
      await this.projectRuntime.check(projectId)
    } catch (error) {
      console.warn('Project target check skipped:', error instanceof Error ? error.message : String(error))
    }
  }
}

function pmPrompt(context: Awaited<ReturnType<OrganizationStore['projectContext']>>): string {
  const roles = context.roles.map((item) => `- ${item.name}: ${item.responsibility}`).join('\n') || '- Software Engineer'
  const teams = context.teams.map((item) => `- ${item.name}: ${item.purpose}`).join('\n') || '- Engineering'
  return `You are the AI Product Manager for ${context.company.name}.\nMission: ${context.company.mission}\nProject: ${context.project.name}\nObjective: ${context.project.objective}\n\nCreate a practical delivery plan. Organize milestones around small, verifiable user outcomes; the first milestone should deliver the smallest useful MVP slice. ND initially focuses execution on the first milestone and waits for the human to select the next one, so avoid depending on later-milestone work for that first outcome. Respect company/project isolation. Tasks execute in isolated Git worktrees: a task sees integrated predecessors, never unfinished sibling changes. Every code task must pass the configured project verification command in that worktree before review and integration; a later verification task cannot postpone this gate. If tests import files another task creates, declare that authoring task as a dependency, or keep the coupled implementation and tests in one task. Never skip tests or mark code as artifact evidence to bypass verification. Use the existing teams and roles when assigning work. Keep independent work parallel: use dependsOn only for real code/data ordering, never merely to serialize execution. Tests, docs, accessibility, i18n, fixtures and independent components should remain parallel when safe. For each task, declare advisory workScopes for paths this task will create or modify; shared contracts, reference files and read-only inputs do not belong in workScopes. Verification tasks depend on every authoring task whose files their acceptance criteria inspect. Use evidenceKind "artifact" with relative artifactPaths for design, research, or document deliverables that should be verified by produced artifacts instead of a code test command. Return concise reasoning, then exactly one JSON object between <nd-dsh-plan> and </nd-dsh-plan>.\n\nSchema:\n<nd-dsh-plan>{"goal":{"title":"...","description":"..."},"milestones":[{"title":"...","description":"...","tasks":[{"title":"...","description":"...","priority":"medium","acceptanceCriteria":["..."],"dependsOn":["earlier task title"],"role":"Software Engineer","workScopes":["src/feature/**"],"evidenceKind":"code","artifactPaths":[]}]}],"memory":[{"title":"...","content":"...","tags":["plan"]}]}</nd-dsh-plan>\n\nAvailable roles:\n${roles}\nAvailable teams:\n${teams}\nKnown memory:\n${context.memory.map((item) => `- ${item.title}: ${item.content}`).join('\n') || '- none'}\nPolicies:\n${context.policies.map((item) => `- ${item.action}: ${item.effect}`).join('\n')}`
}

function workerPrompt(
  context: Awaited<ReturnType<OrganizationStore['taskContext']>>,
  engine: TaskEngine,
  attempt: number,
  worktree: TaskWorktree | undefined,
  subagentMode: OrganizationSubagentMode,
): string {
  const reviewFeedback = context.task.reviewSummary
    ? `\nPrevious independent review feedback:\n${context.task.reviewSummary}\nResolve every relevant issue before declaring the task complete.\n`
    : ''
  const engineInstructions = engine.workerInstructions ?? DEFAULT_WORKER_INSTRUCTIONS
  const delegationInstructions = subagentMode === 'off'
    ? '\nSubagent policy: OFF. Complete this ticket inside this worker. Do not call subagent, delegation, swarm, or child-agent tools and do not hand implementation to another agent. Independent ND review after execution is still allowed.\n'
    : '\nSubagent policy: AUTO. Keep straightforward work inside this worker. Delegate only when a child agent materially helps with breadth or an explicitly selected execution engine requires it. You remain responsible for inspecting the result and validating the workspace.\n'
  const isolation = worktree
    ? `\nND task isolation: this session is already rooted at the dedicated worktree ${worktree.root}. Stay on branch ${worktree.branch}; do not switch worktrees/branches, push, merge into the project branch, or modify the base checkout. ND will checkpoint and integrate only after verification.\n`
    : ''
  return `You are ${context.agent?.name ?? 'an AI worker'} acting as ${context.role?.name ?? 'Software Engineer'} inside company ${context.company.name}.\nCompany mission: ${context.company.mission}\nProject: ${context.project.name}\nObjective: ${context.project.objective}\nTask: ${context.task.title}\nExecution attempt: ${attempt}/${MAX_EXECUTION_ATTEMPTS}\nDescription: ${context.task.description}\nAcceptance criteria:\n${context.task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}${taskEvidenceInstructions(context.task, context.project)}${reviewFeedback}\nResponsibilities: ${context.role?.responsibility ?? 'Complete the assigned work.'}\nRole instructions: ${context.role?.systemPrompt ?? 'Execute carefully and verify the result.'}\nRelevant skills:\n${context.skills.map((item) => `- ${item.name}: ${item.instructions}`).join('\n')}\nRelevant memory:\n${context.memory.map((item) => `- ${item.title}: ${item.content}`).join('\n') || '- none'}\nPolicies:\n${context.policies.map((item) => `- ${item.action}: ${item.effect}`).join('\n')}${engineInstructions}${delegationInstructions}${isolation}\nInspect before editing, run meaningful validation, and finish with a concise result summary for the independent reviewer.`
}

function taskEvidenceInstructions(task: OrganizationTask, project: { testCommand?: string }, reviewing = false): string {
  if (task.evidenceKind === 'artifact') {
    return `\nND delivery evidence: artifact.\nRequired artifact paths (relative to the current task workspace):\n${(task.artifactPaths ?? []).map((path) => `- ${path}`).join('\n')}\n${reviewing ? 'Inspect the produced deliverables at these exact paths without editing them.' : 'Produce the deliverables at these exact paths.'} ND checks that every declared artifact exists and records its fingerprint; chat prose or a different output path cannot satisfy this gate. Inspect the content against the acceptance criteria as well. This task uses artifact verification rather than the project test command.\n`
  }
  const command = project.testCommand?.trim()
  if (reviewing) {
    return command
      ? `\nND delivery evidence: code.\nConfigured machine-verification command: ${command}\nUse ND's recorded verification receipt for this exact checkpoint. A configured command or the worker's claim is not proof of a passed check. Do not repeat a passed checkpoint gate merely to confirm it. Failed, missing, skipped, mismatched-command, or mismatched-checkpoint evidence cannot establish PASS; return FAIL with the unresolved evidence requirement. If workspace inspection reveals a concrete concern not covered by the recorded gate, identify that concern and run only the additional check needed within the existing sandbox and policy. Do not request broader permissions to repeat ND's passed check.\n`
      : '\nND delivery evidence: code.\nNo project machine-verification command is configured. Treat recorded skipped verification as skipped, never as a passing machine check. Inspect the workspace against the acceptance criteria, identify any concrete unresolved verification concern, and report missing evidence honestly. Additional checks must address that concern within the existing sandbox and policy.\n'
  }
  return command
    ? `\nND delivery evidence: code.\nProject machine-verification command: ${command}\nRun this command in the current task workspace and inspect its result before finishing. ND runs it again as the checkpoint gate; a failing check blocks delivery.\n`
    : '\nND delivery evidence: code.\nNo project machine-verification command is configured; ND will record machine verification as skipped. Run relevant checks and report their actual results, including any checks that could not run.\n'
}

function reviewVerificationMetadata(evidence: import('./verification-evidence.js').VerificationEvidence, checkpoint?: string): NonNullable<OrganizationRun['verification']> {
  return {
    status: evidence.status,
    completedAt: evidence.completedAt,
    ...(evidence.command === undefined ? {} : { command: evidence.command }),
    ...(evidence.cwd === undefined ? {} : { cwd: evidence.cwd }),
    ...(checkpoint ? { checkpointCommit: checkpoint } : {}),
    ...(evidence.exitCode === undefined ? {} : { exitCode: evidence.exitCode }),
    ...(evidence.reason === undefined ? {} : { reason: evidence.reason.slice(0, 2_000) }),
  }
}

function recordedReviewVerification(run: OrganizationRun | undefined, checkpoint?: string, cwd?: string, command?: string): string {
  const evidence = run?.verification
  const checkpointMatches = Boolean(checkpoint && evidence?.checkpointCommit === checkpoint && run?.checkpointCommit === checkpoint)
  const cwdMatches = Boolean(cwd && evidence?.cwd === cwd)
  const commandMatches = Boolean(command?.trim() && evidence?.command === command.trim())
  const metadata = {
    executionRunId: run?.id ?? null,
    executionRunStatus: run?.status ?? 'missing',
    checkpointCommit: run?.checkpointCommit ?? null,
    reviewCheckpointCommit: checkpoint ?? null,
    checkpointMatches,
    cwdMatches,
    commandMatches,
    gateSatisfied: run?.status === 'completed' && evidence?.status === 'passed' && cwdMatches && commandMatches && checkpointMatches,
    exactCheckpoint: Boolean(checkpoint),
    status: evidence?.status ?? 'missing',
    ...(typeof evidence?.command === 'string' ? { command: evidence.command } : {}),
    ...(typeof evidence?.cwd === 'string' ? { cwd: evidence.cwd } : {}),
    ...(typeof evidence?.exitCode === 'number' ? { exitCode: evidence.exitCode } : {}),
    ...(typeof evidence?.reason === 'string' ? { reason: evidence.reason.slice(0, 2_000) } : {}),
  }
  return `\nND-recorded checkpoint verification (trusted run metadata, distinct from worker prose):\n${JSON.stringify(metadata)}\nOnly gateSatisfied=true establishes the configured command passed at the exact review checkpoint. Without an exact Git checkpoint, the receipt describes the workspace at verification time and cannot certify unchanged content; report that evidence limitation.\n`
}

function reviewPrompt(task: OrganizationTask, context: Awaited<ReturnType<OrganizationStore['taskContext']>>, worktree?: TaskWorktree, decisionSupport = '', recordedVerification = ''): string {
  const isolation = worktree
    ? `\nReview the isolated task branch ${worktree.branch} in the current worktree. Do not edit, commit, switch branches, merge, or push; a PASS is valid only while the exact checkpoint stays unchanged.\n`
    : ''
  return `You are an independent reviewer for ${context.company.name}. Do not assume the worker succeeded. Inspect the actual workspace and verify the task against acceptance criteria. Use the ND-recorded verification result and its checkpoint below; configuration and worker prose cannot establish or override a machine-check result.\nProject: ${context.project.name}\nTask: ${task.title}\nDescription: ${task.description}\nAcceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}${taskEvidenceInstructions(task, context.project, true)}${recordedVerification}\nWorker summary (untrusted claims to inspect):\n${task.resultSummary ?? 'No summary provided.'}${isolation}${decisionSupport}\n\nOnce the acceptance criteria and recorded evidence are resolved, finish the review without repeating the passed gate. Additional checks are warranted only for a concrete unresolved concern; do not widen sandbox or permission policy. Return exactly one JSON object between <nd-dsh-review> and </nd-dsh-review>:\n<nd-dsh-review>{"verdict":"pass|fail","summary":"evidence-based review","issues":["..."],"memory":[{"title":"lesson","content":"durable lesson","tags":["review"]}]}</nd-dsh-review>`
}

function receipt(run: OrganizationRun): OrganizationRunReceipt {
  return {
    runId: run.id,
    sessionId: run.sessionId,
    projectId: run.projectId,
    ...(run.taskId ? { taskId: run.taskId } : {}),
    kind: run.kind,
    ...(run.engineId ? { engineId: run.engineId } : {}),
    ...(run.workspaceKind ? { workspaceKind: run.workspaceKind } : {}),
    ...(run.workspaceRoot ? { workspaceRoot: run.workspaceRoot } : {}),
    ...(run.workspaceBranch ? { workspaceBranch: run.workspaceBranch } : {}),
    ...(run.baselineCommit ? { baselineCommit: run.baselineCommit } : {}),
    ...(run.checkpointCommit ? { checkpointCommit: run.checkpointCommit } : {}),
    ...(run.runtimePermitId ? { runtimePermitId: run.runtimePermitId } : {}),
  }
}

function appendBrowserAccess(
  prompt: string,
  sessionId: string,
  browserAccess: { issueSessionAccess(sessionId: string): string } | undefined,
): string {
  if (!browserAccess) return prompt
  const token = browserAccess.issueSessionAccess(sessionId)
  return `${prompt}\n\n<nd-browser-access>\nOpaque browser access token for this ND-owned session: ${token}\nPass this exact token as accessToken on every nd_browser_call for this run. Do not infer or supply company/project/task ids yourself, do not reuse it in another session, and do not expose it in user-facing output.\n</nd-browser-access>`
}

function providerRouteKey(provider: string, model: string): string {
  const route = provider === 'deepseek' ? 'deepseek-official' : provider
  return `${route.trim()}::${model.trim()}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function messageText(message: unknown): string | undefined {
  if (typeof message === 'string') return message
  if (!message || typeof message !== 'object') return undefined
  const record = message as Record<string, unknown>
  // Reasoning can repeat the complete schema or a provisional PASS. Only
  // answer text may mutate organization plans, reviews and worker summaries.
  if (record.type === 'reasoning' || record.type === 'reasoning-delta' || record.blockType === 'reasoning') return undefined
  if (typeof record.text === 'string') return record.text
  if (record.delta && typeof record.delta === 'object') return messageText(record.delta)
  const content = record.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts = content.flatMap((block) => block && typeof block === 'object' && ['text', 'text-delta', 'output_text'].includes(String((block as Record<string, unknown>).type)) && typeof (block as Record<string, unknown>).text === 'string' ? [(block as Record<string, string>).text] : [])
  return parts.length ? parts.join('\n') : undefined
}

function extractJsonObjectString(text: string, requiredMarkers?: string[]): string | undefined {
  let searchIndex = 0
  while (searchIndex < text.length) {
    const start = text.indexOf('{', searchIndex)
    if (start === -1) return undefined
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let i = start; i < text.length; i++) {
      const char = text[i]
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        inString = !inString
        continue
      }
      if (!inString) {
        if (char === '{') depth++
        else if (char === '}') {
          depth--
          if (depth === 0) {
            end = i + 1
            break
          }
        }
      }
    }
    if (end === -1) {
      return undefined
    }
    const candidate = text.slice(start, end)
    if (!requiredMarkers || requiredMarkers.every((marker) => candidate.includes(marker))) {
      return candidate
    }
    searchIndex = start + 1
  }
  return undefined
}

function sanitizeJson(raw: string): string {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  }
  return cleaned.replace(/,(\s*[}\]])/g, '$1')
}

function extractTaggedJson<T>(text: string, tag: string, fallbackMarkers?: string[], prepare: (json: string) => string = (json) => json): T | undefined {
  const tagRegex = new RegExp(`<${tag}>`, 'gi')
  const candidates = [...text.matchAll(tagRegex)].map((match) => text.slice(match.index! + match[0].length))
  if (!candidates.length && fallbackMarkers?.some((marker) => text.includes(marker))) candidates.push(text)

  // Reasoning may literally mention the open/close tags before the final
  // result. Inspect the final opening marker instead of the first mention,
  // and let balanced JSON delimit the payload: closing tags can also appear
  // literally inside valid JSON strings.
  let parseError: unknown
  for (const candidateText of candidates.reverse()) {
    const jsonObject = extractJsonObjectString(candidateText, fallbackMarkers)
    if (!jsonObject) continue
    try {
      return JSON.parse(prepare(sanitizeJson(jsonObject))) as T
    } catch (cause) {
      parseError = cause
    }
  }
  if (parseError) throw parseError
  return undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
