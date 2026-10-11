import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type {
  AgentStatus,
  Company,
  MemoryEntry,
  OrganizationActivity,
  OrganizationActorRef,
  OrganizationAgent,
  OrganizationMember,
  OrganizationMutation,
  OrganizationPolicy,
  OrganizationRole,
  OrganizationRun,
  OrganizationRunKind,
  OrganizationSkill,
  OrganizationSnapshot,
  OrganizationTask,
  OrganizationTaskHandoff,
  OrganizationTeamEventKind,
  OrganizationWorkflow,
  Project,
  ProjectPlanInput,
  Team,
  TaskStatus,
} from '../../shared/organization.js'
import { taskMetricsRecorder } from '../metrics/task-metrics.js'
import { compareDeliveryTasks, taskInDeliveryScope } from '../../shared/organization-delivery.js'
import { BUILTIN_SKILLS, defaultPolicies, defaultWorkflow } from './defaults.js'

type DurableOrganizationSnapshot = OrganizationSnapshot & {
  members: NonNullable<OrganizationSnapshot['members']>
  messages: NonNullable<OrganizationSnapshot['messages']>
  decisions: NonNullable<OrganizationSnapshot['decisions']>
  approvalRequests: NonNullable<OrganizationSnapshot['approvalRequests']>
  approvalVerdicts: NonNullable<OrganizationSnapshot['approvalVerdicts']>
}

const EMPTY: DurableOrganizationSnapshot = {
  version: 1,
  companies: [], projects: [], roles: [], teams: [], agents: [], skills: BUILTIN_SKILLS,
  workflows: [], goals: [], milestones: [], tasks: [], memory: [], policies: [], activity: [], runs: [],
  members: [], messages: [], decisions: [], approvalRequests: [], approvalVerdicts: [], coordination: [],
}

const SNAPSHOT_ARRAY_KEYS = [
  'companies', 'projects', 'roles', 'teams', 'agents', 'skills', 'workflows',
  'goals', 'milestones', 'tasks', 'memory', 'policies', 'activity', 'runs',
] as const

export class OrganizationStore {
  private loaded = false
  private loadPromise: Promise<void> | undefined
  private saveChain: Promise<void> = Promise.resolve()
  private pendingSave: Promise<void> | undefined
  private value: DurableOrganizationSnapshot = clone(EMPTY)
  private onChanged: ((state: OrganizationSnapshot) => void) | undefined

  constructor(private readonly filePath: string) {}

  setOnChanged(listener: ((state: OrganizationSnapshot) => void) | undefined): void {
    this.onChanged = listener
  }

  async state(): Promise<OrganizationSnapshot> {
    await this.load()
    return clone(this.value)
  }

  async mutate(mutation: OrganizationMutation): Promise<OrganizationSnapshot> {
    await this.load()
    switch (mutation.type) {
      case 'company.create': this.createCompany(mutation.name, mutation.mission); break
      case 'company.update': this.updateCompany(mutation.id, mutation.patch); break
      case 'company.activate': this.activateCompany(mutation.id); break
      case 'company.remove': this.removeCompany(mutation.id); break
      case 'project.create': this.createProject(mutation); break
      case 'project.update': this.updateProject(mutation.id, mutation.patch); break
      case 'project.activate': this.activateProject(mutation.id); break
      case 'project.remove': this.removeProject(mutation.id); break
      case 'team.create': this.createTeam(mutation); break
      case 'member.create': this.createMember(mutation); break
      case 'member.update': this.updateMember(mutation.id, mutation.patch); break
      case 'role.create': this.createRole(mutation); break
      case 'role.update': this.updateRole(mutation.id, mutation.patch); break
      case 'agent.create': this.createAgent(mutation); break
      case 'agent.update': this.updateAgent(mutation.id, mutation.patch); break
      case 'skill.create': this.createSkill(mutation); break
      case 'workflow.create': this.createWorkflow(mutation); break
      case 'goal.create': this.createGoal(mutation); break
      case 'milestone.create': this.createMilestone(mutation); break
      case 'task.create': this.createTask(mutation); break
      case 'task.update': this.updateTask(mutation.id, mutation.patch); break
      case 'task.reassign': this.reassignTask(mutation); break
      case 'task.submitWork': this.submitTaskWork(mutation); break
      case 'collaboration.message.add': this.addCollaborationMessage(mutation); break
      case 'decision.create': this.createDecision(mutation); break
      case 'decision.supersede': this.supersedeDecision(mutation); break
      case 'approval.request': this.createApprovalRequest(mutation); break
      case 'approval.resolve': this.resolveApproval(mutation); break
      case 'task.reorder': this.reorderTasks(mutation); break
      case 'memory.add': this.addMemory({ ...mutation, source: 'human' }); break
      case 'policy.set': this.setPolicy(mutation); break
    }
    await this.save()
    return clone(this.value)
  }

  async applyPlan(projectId: string, plan: ProjectPlanInput, adjustments: string[] = []): Promise<void> {
    await this.load()
    const project = this.project(projectId)
    const companyId = project.companyId
    const goalId = randomUUID()
    this.value.goals.push({ id: goalId, companyId, projectId, title: clean(plan.goal.title), description: clean(plan.goal.description), status: 'active', progress: 0, createdAt: Date.now() })
    const taskIdsByTitle = new Map<string, string>()
    const firstPlan = !this.value.milestones.some((item) => item.projectId === projectId)
    for (const milestoneInput of plan.milestones) {
      const milestoneId = randomUUID()
      const order = this.value.milestones.filter((item) => item.projectId === projectId).length
      this.value.milestones.push({ id: milestoneId, companyId, projectId, goalId, title: clean(milestoneInput.title), description: clean(milestoneInput.description), status: 'pending', order })
      if (firstPlan && !project.deliveryMilestoneId) project.deliveryMilestoneId = milestoneId
      for (const input of milestoneInput.tasks) {
        const id = randomUUID()
        taskIdsByTitle.set(input.title.trim().toLowerCase(), id)
        const agent = this.pickAgent(companyId, input.role)
        if (agent?.teamId && !project.teamIds.includes(agent.teamId)) project.teamIds.push(agent.teamId)
        this.value.tasks.push({
          id, companyId, projectId, goalId, milestoneId,
          title: clean(input.title), description: clean(input.description),
          acceptanceCriteria: input.acceptanceCriteria?.map(clean).filter(Boolean) ?? ['Requested outcome is implemented and verified.'],
          priority: input.priority ?? 'medium', status: 'backlog', dependsOn: input.dependsOn ?? [],
          ...(agent ? { assignedAgentId: agent.id } : {}),
          ...taskExecutionHints(input),
          createdAt: Date.now(), updatedAt: Date.now(),
        })
      }
    }
    for (const task of this.value.tasks.filter((item) => item.goalId === goalId)) {
      task.dependsOn = task.dependsOn.map((value) => taskIdsByTitle.get(value.trim().toLowerCase()) ?? value)
    }
    for (const item of plan.memory ?? []) this.addMemory({ companyId, projectId, title: item.title, content: item.content, ...(item.tags ? { tags: item.tags } : {}), source: 'pm' })
    this.refreshProject(projectId)
    const repaired = adjustments.length
      ? ` ND repaired ${adjustments.length} plan issue(s): ${adjustments.slice(0, 5).join(' ')}${adjustments.length > 5 ? ' …' : ''}`
      : ''
    this.activity(companyId, projectId, 'pm.plan', `AI PM created “${plan.goal.title}” with ${plan.milestones.length} milestone(s).${repaired}`)
    await this.save()
  }

  async taskContext(taskId: string): Promise<{ task: OrganizationTask; project: Project; company: Company; agent?: OrganizationAgent; role?: OrganizationRole; member?: OrganizationMember; accountableMember?: OrganizationMember; skills: OrganizationSkill[]; memory: MemoryEntry[]; policies: OrganizationPolicy[] }> {
    await this.load()
    const task = this.task(taskId)
    const project = this.project(task.projectId)
    const company = this.company(task.companyId)
    const agent = task.assignedAgentId ? this.value.agents.find((item) => item.id === task.assignedAgentId) : undefined
    const role = agent ? this.value.roles.find((item) => item.id === agent.roleId) : undefined
    const member = task.assignedMemberId ? this.value.members?.find((item) => item.id === task.assignedMemberId) : undefined
    const accountableMember = task.accountableMemberId ? this.value.members?.find((item) => item.id === task.accountableMemberId) : undefined
    const teamSkills = this.value.teams.find((item) => item.id === agent?.teamId)?.skillIds ?? []
    const ids = new Set([...(agent?.skillIds ?? []), ...(role?.skillIds ?? []), ...teamSkills, ...(task.requestedSkillIds ?? [])])
    const skills = this.value.skills.filter((skill) => skill.scope === 'builtin' || ids.has(skill.id) || skill.companyId === company.id || skill.projectId === project.id)
    const memory = this.value.memory.filter((entry) => entry.companyId === company.id && (!entry.projectId || entry.projectId === project.id)).slice(-30)
    const policies = this.value.policies.filter((item) => item.companyId === company.id)
    return { task: clone(task), project: clone(project), company: clone(company), ...(agent ? { agent: clone(agent) } : {}), ...(role ? { role: clone(role) } : {}), ...(member ? { member: clone(member) } : {}), ...(accountableMember ? { accountableMember: clone(accountableMember) } : {}), skills: clone(skills), memory: clone(memory), policies: clone(policies) }
  }

  async projectContext(projectId: string): Promise<{ project: Project; company: Company; agents: OrganizationAgent[]; roles: OrganizationRole[]; teams: Team[]; memory: MemoryEntry[]; policies: OrganizationPolicy[] }> {
    await this.load()
    const project = this.project(projectId)
    const company = this.company(project.companyId)
    return {
      project: clone(project), company: clone(company),
      agents: clone(this.value.agents.filter((item) => item.companyId === company.id)),
      roles: clone(this.value.roles.filter((item) => item.companyId === company.id)),
      teams: clone(this.value.teams.filter((item) => item.companyId === company.id)),
      memory: clone(this.value.memory.filter((entry) => entry.companyId === company.id && (!entry.projectId || entry.projectId === project.id)).slice(-30)),
      policies: clone(this.value.policies.filter((item) => item.companyId === company.id)),
    }
  }

  async policy(companyId: string, action: string): Promise<OrganizationPolicy['effect']> {
    await this.load()
    return this.value.policies.find((item) => item.companyId === companyId && item.action === action)?.effect ?? 'ask'
  }

  async workflowForProject(projectId: string): Promise<OrganizationWorkflow | undefined> {
    await this.load()
    const project = this.project(projectId)
    const projectWorkflow = this.value.workflows.filter((item) => item.companyId === project.companyId && item.projectId === projectId).at(-1)
    const companyWorkflow = this.value.workflows.filter((item) => item.companyId === project.companyId && !item.projectId).at(-1)
    const workflow = projectWorkflow ?? companyWorkflow
    return workflow ? clone(workflow) : undefined
  }

  async activeRun(projectId: string): Promise<OrganizationRun | undefined> {
    await this.load()
    const found = this.value.runs.find((item) => item.projectId === projectId && item.status === 'running')
    return found ? clone(found) : undefined
  }

  async runBySession(sessionId: string): Promise<OrganizationRun | undefined> {
    await this.load()
    const found = this.value.runs.find((item) => item.sessionId === sessionId && item.status === 'running')
    return found ? clone(found) : undefined
  }

  async executionAttemptCount(taskId: string): Promise<number> {
    await this.load()
    this.task(taskId)
    return this.value.runs.filter((item) => item.taskId === taskId && item.kind === 'task-execution').length
  }

  async beginRun(
    kind: OrganizationRunKind,
    companyId: string,
    projectId: string,
    sessionId: string,
    taskId?: string,
    goalId?: string,
    options: {
      parallelTask?: boolean
      engineId?: string
      workspaceKind?: OrganizationRun['workspaceKind']
      workspaceRoot?: string
      workspaceBranch?: string
      baselineCommit?: string
      runtimePermitId?: string
    } = {},
  ): Promise<OrganizationRun> {
    await this.load()
    this.company(companyId); this.project(projectId)
    if (taskId) {
      const task = this.task(taskId)
      if (task.companyId !== companyId || task.projectId !== projectId) throw new Error('Organization run task crosses company/project boundary')
    }

    const active = this.value.runs.filter((item) => item.status === 'running')
    if (!options.parallelTask) {
      const blocking = active[0]
      if (blocking) throw new Error(`Another organization run is already active in session ${blocking.sessionId}`)
    } else {
      if ((kind !== 'task-execution' && kind !== 'task-review') || !taskId) {
        throw new Error('Parallel organization runs are limited to isolated task execution/review')
      }
      const sameSession = active.find((item) => item.sessionId === sessionId)
      if (sameSession) throw new Error(`Session ${sessionId} already owns an active organization run`)
      const global = active.find((item) => item.kind === 'pm-plan' || !item.taskId)
      if (global) throw new Error(`Global organization run ${global.kind} is active in session ${global.sessionId}`)
      const sameTask = active.find((item) => item.taskId === taskId)
      if (sameTask) throw new Error(`Task already has an active ${sameTask.kind} run in session ${sameTask.sessionId}`)
    }

    const run: OrganizationRun = {
      id: randomUUID(), companyId, projectId, kind, status: 'running', sessionId,
      ...(taskId ? { taskId } : {}), ...(goalId ? { goalId } : {}),
      ...(options.engineId ? { engineId: options.engineId } : {}),
      ...(options.workspaceKind ? { workspaceKind: options.workspaceKind } : {}),
      ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
      ...(options.workspaceBranch ? { workspaceBranch: options.workspaceBranch } : {}),
      ...(options.baselineCommit ? { baselineCommit: options.baselineCommit } : {}),
      ...(options.runtimePermitId ? { runtimePermitId: options.runtimePermitId } : {}),
      startedAt: Date.now(),
    }
    this.value.runs.unshift(run)
    // Cost measurement starts where the run does, so a run that never reaches a
    // terminal state is still visible as unfinished instead of absent.
    taskMetricsRecorder()?.beginRun({ runId: run.id, sessionId, kind, ...(taskId ? { taskId } : {}), startedAt: run.startedAt })
    this.activity(companyId, projectId, `run.${kind}`, `${kind} started in session ${short(sessionId)}.`)
    await this.save()
    return clone(run)
  }

  async updateRunProvenance(
    runId: string,
    patch: Partial<Pick<OrganizationRun, 'runtimePermitId' | 'checkpointCommit'>>,
  ): Promise<void> {
    await this.load()
    const run = must(this.value.runs.find((item) => item.id === runId), 'Organization run')
    if (patch.runtimePermitId !== undefined) run.runtimePermitId = clean(patch.runtimePermitId)
    if (patch.checkpointCommit !== undefined) {
      const checkpoint = clean(patch.checkpointCommit)
      run.checkpointCommit = checkpoint
      if (run.taskId) this.cancelStaleApprovals(run.taskId, checkpoint)
    }
    await this.save()
  }

  async completeRun(runId: string, output?: string, error?: string): Promise<void> {
    await this.load()
    const run = must(this.value.runs.find((item) => item.id === runId), 'Organization run')
    run.status = error ? 'failed' : 'completed'
    if (output) run.output = output.slice(0, 40_000)
    if (error) run.error = error.slice(0, 8_000)
    run.completedAt = Date.now()
    taskMetricsRecorder()?.finishRun(run.id, run.status === 'failed' ? run.error ?? 'Organization run failed.' : undefined)
    await this.save()
  }

  /** Main-process gate metadata. Deliberately absent from renderer mutations. */
  async recordRunVerification(runId: string, evidence: NonNullable<OrganizationRun['verification']>): Promise<void> {
    await this.load()
    const run = must(this.value.runs.find((item) => item.id === runId), 'Organization run')
    if (run.kind !== 'task-execution' || run.status !== 'running') throw new Error('Verification requires an active task execution')
    run.verification = clone(evidence)
    await this.save()
  }

  /**
   * A desktop restart means no in-memory Harness turn can still be running.
   * Convert persisted running receipts into explicit failed/interrupted work so
   * they cannot permanently lock the company. Tasks remain retryable but never
   * auto-resume partially applied workspace changes without the user seeing it.
   */
  async reconcileInterruptedRuns(reason = 'ND-DSH restarted before the run finished.'): Promise<number> {
    await this.load()
    const running = this.value.runs.filter((item) => item.status === 'running')
    if (running.length === 0) return 0

    const now = Date.now()
    const message = reason.trim() || 'ND-DSH restarted before the run finished.'
    const projects = new Set<string>()
    for (const run of running) {
      run.status = 'failed'
      run.error = `Interrupted: ${message}`.slice(0, 8_000)
      run.completedAt = now
      projects.add(run.projectId)
      taskMetricsRecorder()?.interruptRun(run.id, run.error)

      if (run.taskId) {
        const task = this.value.tasks.find((item) => item.id === run.taskId)
        if (task) {
          if (run.kind === 'task-review') {
            task.status = 'review'
            delete task.reviewSessionId
          } else {
            task.status = 'blocked'
            const interruption = `Execution interrupted: ${message}`
            task.reviewSummary = [task.reviewSummary, interruption].filter(Boolean).join('\n\n').slice(0, 20_000)
          }
          task.updatedAt = now
          // Settle by the owner this run actually belonged to: an interrupted
          // review releases the reviewer, an interrupted execution the worker.
          this.releaseTaskAgent(run.kind === 'task-review' ? task.reviewerAgentId : task.assignedAgentId, task.id)
        }
      }

      this.activity(run.companyId, run.projectId, 'run.interrupted', `${run.kind} in session ${short(run.sessionId)} was interrupted by an app restart.`)
    }

    for (const projectId of projects) this.refreshProject(projectId)
    await this.save()
    return running.length
  }

  async markExecution(taskId: string, sessionId: string): Promise<void> {
    await this.load()
    const task = this.task(taskId)
    task.status = 'in_progress'; task.executionSessionId = sessionId; delete task.reviewSessionId; delete task.blockedReason
    delete task.humanSubmission
    task.integrationState = 'pending'; delete task.integrationSummary; delete task.integratedHead
    task.updatedAt = Date.now()
    this.setAgent(task.assignedAgentId, 'working', task.id, sessionId)
    this.activity(task.companyId, task.projectId, 'task.execute', `Started “${task.title}”.`)
    this.teamEvent(task, 'progress', `Execution started for “${task.title}”.`)
    await this.save()
  }

  async blockTask(taskId: string, reason: string): Promise<void> {
    await this.load()
    const task = this.task(taskId)
    task.status = 'blocked'
    task.blockedReason = reason.trim().slice(0, 2_000) || 'Blocked by ND.'
    task.updatedAt = Date.now()
    this.activity(task.companyId, task.projectId, 'task.blocked', `Blocked “${task.title}”: ${task.blockedReason}`)
    this.refreshProject(task.projectId)
    await this.save()
  }

  async markForReview(taskId: string, summary: string): Promise<void> {
    await this.load()
    const task = this.task(taskId)
    task.status = 'review'; task.resultSummary = summary.slice(0, 20_000); task.updatedAt = Date.now()
    this.releaseTaskAgent(task.assignedAgentId, task.id)
    this.activity(task.companyId, task.projectId, 'task.review-ready', `“${task.title}” is ready for independent review.`)
    this.teamEvent(task, 'review-request', `“${task.title}” is checkpointed and ready for independent review.`)
    this.refreshProject(task.projectId)
    await this.save()
  }

  async markReviewStarted(taskId: string, sessionId: string, reviewerAgentId?: string): Promise<void> {
    await this.load()
    const task = this.task(taskId)
    const reviewer = reviewerAgentId
      ? this.value.agents.find((item) => item.id === reviewerAgentId && item.companyId === task.companyId)
      : this.pickReviewer(task)
    if (reviewerAgentId && !reviewer) throw new Error('Reviewer crosses company boundary')
    task.reviewSessionId = sessionId
    if (reviewer) task.reviewerAgentId = reviewer.id
    task.updatedAt = Date.now()
    this.setAgent(reviewer?.id, 'reviewing', task.id, sessionId)
    await this.save()
  }

  async reviewerForTask(taskId: string): Promise<{ agent?: OrganizationAgent; role?: OrganizationRole }> {
    await this.load()
    const task = this.task(taskId)
    const agent = this.pickReviewer(task)
    const role = agent ? this.value.roles.find((item) => item.id === agent.roleId) : undefined
    return {
      ...(agent ? { agent: clone(agent) } : {}),
      ...(role ? { role: clone(role) } : {}),
    }
  }

  /** A failed review run releases its session so the Review action can retry. */
  async clearReviewSession(taskId: string): Promise<void> {
    await this.load()
    const task = this.task(taskId)
    delete task.reviewSessionId
    task.updatedAt = Date.now()
    this.releaseTaskAgent(task.reviewerAgentId, taskId)
    await this.save()
  }

  async completeReview(taskId: string, passed: boolean, summary: string, memories: Array<{ title: string; content: string; tags?: string[] }> = []): Promise<void> {
    await this.load()
    const task = this.task(taskId)
    task.status = passed ? 'completed' : 'blocked'; task.reviewSummary = summary.slice(0, 20_000); task.updatedAt = Date.now()
    this.releaseTaskAgent(task.reviewerAgentId, task.id)
    this.addMemory({
      companyId: task.companyId,
      projectId: task.projectId,
      title: `Review: ${task.title}`,
      content: summary,
      tags: ['review', passed ? 'passed' : 'failed'],
      source: 'reviewer',
    })
    for (const item of memories) this.addMemory({ companyId: task.companyId, projectId: task.projectId, title: item.title, content: item.content, ...(item.tags ? { tags: item.tags } : {}), source: 'reviewer' })
    this.activity(task.companyId, task.projectId, passed ? 'task.completed' : 'task.blocked', `${passed ? 'Passed' : 'Failed'} review: “${task.title}”.`)
    this.refreshProject(task.projectId)
    await this.save()
  }

  async queueRework(taskId: string, reason: string): Promise<void> {
    await this.load()
    const task = this.task(taskId)
    if (task.status !== 'blocked') throw new Error('Only a blocked task can be queued for rework')
    task.status = 'ready'
    task.integrationState = 'pending'
    delete task.integrationSummary
    delete task.integratedHead
    task.updatedAt = Date.now()
    this.activity(task.companyId, task.projectId, 'task.rework', `Queued rework for “${task.title}”: ${reason.slice(0, 500)}`)
    this.teamEvent(task, 'blocker', `Rework queued for “${task.title}”: ${reason.slice(0, 500)}`)
    this.refreshProject(task.projectId)
    await this.save()
  }

  async markIntegrationConflict(taskId: string, summary: string): Promise<void> {
    await this.load()
    const task = this.task(taskId)
    task.status = 'blocked'
    task.integrationState = 'conflict'
    task.integrationSummary = clean(summary).slice(0, 20_000)
    delete task.integratedHead
    task.updatedAt = Date.now()
    this.releaseTaskAgent(task.assignedAgentId, task.id)
    this.activity(task.companyId, task.projectId, 'task.integration-conflict', `Integration conflict for “${task.title}”.`)
    this.teamEvent(task, 'blocker', `Integration conflict for “${task.title}”: ${task.integrationSummary.slice(0, 500)}`)
    this.refreshProject(task.projectId)
    await this.save()
  }

  async markIntegrated(taskId: string, head: string): Promise<void> {
    await this.load()
    const task = this.task(taskId)
    task.integrationState = 'integrated'
    task.integratedHead = clean(head)
    delete task.integrationSummary
    task.updatedAt = Date.now()
    this.cancelPendingIntegrationApprovals(task.id)
    this.activity(task.companyId, task.projectId, 'task.integrated', `Integrated “${task.title}” at ${short(task.integratedHead)}.`)
    this.teamEvent(task, 'progress', `“${task.title}” integrated at ${short(task.integratedHead)}.`)
    await this.save()
  }

  async completeWithoutReview(taskId: string, summary: string): Promise<void> {
    await this.load()
    const task = this.task(taskId)
    task.status = 'completed'
    task.resultSummary = summary.slice(0, 20_000)
    task.reviewSummary = 'Completed by workflow without an independent review step.'
    task.updatedAt = Date.now()
    this.releaseTaskAgent(task.assignedAgentId, task.id)
    this.addMemory({
      companyId: task.companyId,
      projectId: task.projectId,
      title: `Task result: ${task.title}`,
      content: summary,
      tags: ['task', 'completed', 'no-review'],
      source: 'worker',
    })
    this.activity(task.companyId, task.projectId, 'task.completed', `Completed “${task.title}” without a review step.`)
    this.refreshProject(task.projectId)
    await this.save()
  }

  /**
   * Every dispatchable task in priority order. Parallel dispatch needs the whole
   * list, not just its head: a per-role or per-team cap can refuse the highest
   * priority task while a lower one still has room.
   */
  async readyTasks(projectId: string): Promise<OrganizationTask[]> {
    await this.load(); this.refreshProject(projectId)
    const project = this.project(projectId)
    return this.value.tasks
      .filter((item) => item.status === 'ready' && taskInDeliveryScope(item, project))
      .sort(compareDeliveryTasks)
      .map(clone)
  }

  async nextReadyTask(projectId: string): Promise<OrganizationTask | undefined> {
    return (await this.readyTasks(projectId))[0]
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

    const backupPath = this.backupPath()
    try {
      this.value = await this.readSnapshot(backupPath)
      this.loaded = true
      console.warn(`Recovered organization state from backup after primary load failed: ${errorMessage(primaryError)}`)
      await this.save()
      return
    } catch (backupError) {
      if (isMissing(primaryError) && isMissing(backupError)) {
        this.loaded = true
        return
      }
      throw new Error(`Organization state could not be loaded. Primary: ${errorMessage(primaryError)}. Backup: ${errorMessage(backupError)}.`)
    }
  }

  private async readSnapshot(path: string): Promise<DurableOrganizationSnapshot> {
    const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as unknown
    return normalizeSnapshot(parsed)
  }

  /**
   * Durable once the returned promise settles. Saves requested while a write is in
   * flight share the next write, which snapshots state when it starts, so a burst
   * of mutations costs one snapshot, one serialization, and one listener update
   * instead of one per mutation.
   */
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
        console.warn('Failed to persist organization backup:', error)
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

  private createCompany(name: string, mission: string): void {
    const now = Date.now(); const id = randomUUID()
    const company: Company = { id, name: clean(name), mission: clean(mission), autonomyLevel: 2, subagentMode: 'auto', status: 'active', createdAt: now, updatedAt: now }
    this.value.companies.push(company); this.value.activeCompanyId = id; delete this.value.activeProjectId
    const productRole = this.seedRole(id, 'Product Manager', 'Own outcomes, roadmaps, prioritization, delegation, risks, and acceptance.', 'Act as the company project manager. Convert goals into executable work and keep the organization aligned.', ['builtin:strategy', 'builtin:project-plan', 'builtin:task-breakdown', 'builtin:memory'])
    const engineerRole = this.seedRole(id, 'Software Engineer', 'Implement assigned project work safely and verify it.', 'Inspect the workspace, implement the assigned outcome, run relevant validation, and report concrete results.', ['builtin:implementation', 'builtin:qa', 'builtin:browser'])
    const reviewerRole = this.seedRole(id, 'Reviewer', 'Independently verify completed work.', 'Review work independently against requirements, tests, regressions, and maintainability. Never rubber-stamp.', ['builtin:review', 'builtin:qa'])
    const researcherRole = this.seedRole(id, 'Researcher', 'Research product, technical, market, and operational questions.', 'Research current evidence and produce concise decision-ready findings.', ['builtin:research', 'builtin:browser'])
    const productTeam = this.seedTeam(id, 'Product', 'Plans company and project outcomes.', [productRole.id], ['builtin:strategy', 'builtin:project-plan'])
    const engineeringTeam = this.seedTeam(id, 'Engineering', 'Builds and validates product work.', [engineerRole.id], ['builtin:implementation', 'builtin:qa'])
    const qualityTeam = this.seedTeam(id, 'Quality & Research', 'Reviews work and resolves unknowns.', [reviewerRole.id, researcherRole.id], ['builtin:review', 'builtin:research'])
    this.seedAgent(id, 'AI PM', productRole.id, productTeam.id)
    this.seedAgent(id, 'Builder', engineerRole.id, engineeringTeam.id)
    this.seedAgent(id, 'Reviewer', reviewerRole.id, qualityTeam.id)
    this.seedAgent(id, 'Researcher', researcherRole.id, qualityTeam.id)
    this.value.members.push({ id: randomUUID(), companyId: id, displayName: 'Owner', title: 'Workspace Owner', status: 'active', accessRole: 'owner', createdAt: now, updatedAt: now })
    this.value.workflows.push(defaultWorkflow(id)); this.value.policies.push(...defaultPolicies(id))
    this.activity(id, undefined, 'company.created', `Created ${company.name} with a default AI workforce and safety policy.`)
  }

  private updateCompany(id: string, patch: Partial<Pick<Company, 'name' | 'mission' | 'autonomyLevel' | 'subagentMode' | 'status'>>): void {
    const company = this.company(id); Object.assign(company, patch); company.name = clean(company.name); company.mission = clean(company.mission); company.updatedAt = Date.now()
  }
  private activateCompany(id: string): void { this.company(id); this.value.activeCompanyId = id; const project = this.value.projects.find((item) => item.companyId === id); if (project) this.value.activeProjectId = project.id; else delete this.value.activeProjectId }
  /**
   * Forget a company inside ND. Every record the company owns is dropped:
   * projects, goals, milestones, tasks, runs, coordination, memory, skills,
   * workflows, roles, teams, agents, and policies. Workspace folders on disk
   * are never touched. A running run is refused so a live session can never be
   * orphaned by removal.
   */
  private removeCompany(id: string): void {
    const company = this.company(id)
    const live = this.value.runs.find((run) => run.companyId === id && run.status === 'running')
    if (live) throw new Error(`Cancel the running ${live.kind} before removing this company`)
    const taskIds = new Set(this.value.tasks.filter((task) => task.companyId === id).map((task) => task.id))
    this.value.companies = this.value.companies.filter((item) => item.id !== id)
    this.value.projects = this.value.projects.filter((item) => item.companyId !== id)
    this.value.goals = this.value.goals.filter((item) => item.companyId !== id)
    this.value.milestones = this.value.milestones.filter((item) => item.companyId !== id)
    this.value.tasks = this.value.tasks.filter((item) => item.companyId !== id)
    this.value.runs = this.value.runs.filter((item) => item.companyId !== id)
    this.value.coordination = this.value.coordination.filter((item) => item.companyId !== id)
    this.value.members = this.value.members.filter((item) => item.companyId !== id)
    this.value.messages = this.value.messages.filter((item) => item.companyId !== id)
    this.value.decisions = this.value.decisions.filter((item) => item.companyId !== id)
    const approvalIds = new Set(this.value.approvalRequests.filter((item) => item.companyId === id).map((item) => item.id))
    this.value.approvalRequests = this.value.approvalRequests.filter((item) => item.companyId !== id)
    this.value.approvalVerdicts = this.value.approvalVerdicts.filter((item) => !approvalIds.has(item.requestId))
    this.value.memory = this.value.memory.filter((item) => item.companyId !== id)
    this.value.skills = this.value.skills.filter((item) => item.companyId !== id)
    this.value.workflows = this.value.workflows.filter((item) => item.companyId !== id)
    this.value.roles = this.value.roles.filter((item) => item.companyId !== id)
    this.value.teams = this.value.teams.filter((item) => item.companyId !== id)
    this.value.agents = this.value.agents.filter((item) => item.companyId !== id)
    this.value.policies = this.value.policies.filter((item) => item.companyId !== id)
    this.value.activity = this.value.activity.filter((item) => item.companyId !== id)
    for (const agent of this.value.agents) {
      if (agent.currentTaskId && taskIds.has(agent.currentTaskId)) { agent.status = 'idle'; delete agent.currentTaskId }
    }
    if (this.value.activeCompanyId === id) {
      const next = this.value.companies[0]
      if (next) {
        this.value.activeCompanyId = next.id
        const nextProject = this.value.projects.find((item) => item.companyId === next.id)
        if (nextProject) this.value.activeProjectId = nextProject.id
        else delete this.value.activeProjectId
      } else {
        delete this.value.activeCompanyId
        delete this.value.activeProjectId
      }
    }
  }
  private createProject(input: Extract<OrganizationMutation, { type: 'project.create' }>): void {
    this.company(input.companyId); const now = Date.now(); const workspacePath = normalizeWorkspacePath(input.workspacePath); const project: Project = {
      id: randomUUID(), companyId: input.companyId, name: clean(input.name), objective: clean(input.objective), status: 'planning', repoUrls: input.repoUrls?.map(clean).filter(Boolean) ?? [], teamIds: [], progress: 0,
      ...(workspacePath ? { workspacePath } : {}),
      createdAt: now, updatedAt: now,
    }
    applyRuntimeFields(project, input)
    this.value.projects.push(project); this.value.activeCompanyId = input.companyId; this.value.activeProjectId = project.id; this.activity(input.companyId, project.id, 'project.created', `Created project “${project.name}”.`)
  }
  private updateProject(id: string, patch: Extract<OrganizationMutation, { type: 'project.update' }>['patch']): void {
    const project = this.project(id)
    const deliveryBefore = project.deliveryMilestoneId
    if (patch.deliveryMilestoneId !== undefined && typeof patch.deliveryMilestoneId !== 'string') throw new Error('Delivery milestone must be a milestone ID or empty string')
    if (patch.deliveryMilestoneId) this.assertMilestoneProject(patch.deliveryMilestoneId, id)
    const { workspacePath, ...rest } = patch
    Object.assign(project, rest)
    if (patch.deliveryMilestoneId === '') delete project.deliveryMilestoneId
    if (patch.deliveryMilestoneId !== undefined && deliveryBefore !== project.deliveryMilestoneId) {
      const label = this.value.milestones.find((item) => item.id === project.deliveryMilestoneId)?.title ?? 'All work'
      this.activity(project.companyId, id, 'delivery.scope', `Delivery scope set to “${label}”. Existing workers and reviews can finish.`)
    }
    if (workspacePath !== undefined) {
      const normalized = normalizeWorkspacePath(workspacePath)
      if (normalized) project.workspacePath = normalized
      else deleteProjectKey(project, 'workspacePath')
    }
    project.name = clean(project.name)
    project.objective = clean(project.objective)
    applyRuntimeFields(project, patch)
    project.updatedAt = Date.now()
  }
  private activateProject(id: string): void { const project = this.project(id); this.value.activeProjectId = id; this.value.activeCompanyId = project.companyId }
  /**
   * Forget a project inside ND. Comparable to removing a folder from an editor
   * workspace: the folder and its files are untouched, only ND's own records for
   * the project disappear. A running run is refused so a live session can never
   * be orphaned by removal.
   */
  private removeProject(id: string): void {
    const project = this.project(id)
    const live = this.value.runs.find((run) => run.projectId === id && run.status === 'running')
    if (live) throw new Error(`Cancel the running ${live.kind} before removing this project`)
    const taskIds = new Set(this.value.tasks.filter((task) => task.projectId === id).map((task) => task.id))
    this.value.projects = this.value.projects.filter((item) => item.id !== id)
    this.value.goals = this.value.goals.filter((item) => item.projectId !== id)
    this.value.milestones = this.value.milestones.filter((item) => item.projectId !== id)
    this.value.tasks = this.value.tasks.filter((item) => item.projectId !== id)
    this.value.runs = this.value.runs.filter((item) => item.projectId !== id)
    this.value.coordination = this.value.coordination.filter((item) => item.projectId !== id)
    this.value.messages = this.value.messages.filter((item) => item.projectId !== id)
    this.value.decisions = this.value.decisions.filter((item) => item.projectId !== id)
    const approvalIds = new Set(this.value.approvalRequests.filter((item) => item.projectId === id).map((item) => item.id))
    this.value.approvalRequests = this.value.approvalRequests.filter((item) => item.projectId !== id)
    this.value.approvalVerdicts = this.value.approvalVerdicts.filter((item) => !approvalIds.has(item.requestId))
    this.value.memory = this.value.memory.filter((item) => item.projectId !== id)
    this.value.skills = this.value.skills.filter((item) => item.projectId !== id)
    this.value.workflows = this.value.workflows.filter((item) => item.projectId !== id)
    for (const agent of this.value.agents) {
      if (agent.currentTaskId && taskIds.has(agent.currentTaskId)) { agent.status = 'idle'; delete agent.currentTaskId }
    }
    if (this.value.activeProjectId === id) {
      const next = this.value.projects.find((item) => item.companyId === project.companyId)
      if (next) this.value.activeProjectId = next.id
      else delete this.value.activeProjectId
    }
    this.activity(project.companyId, undefined, 'project.removed', `Removed project “${project.name}” from ND. Files in its folder were not changed.`)
  }
  private createTeam(input: Extract<OrganizationMutation, { type: 'team.create' }>): void { this.company(input.companyId); for (const roleId of input.roleIds ?? []) this.assertRoleCompany(roleId, input.companyId); this.value.teams.push({ id: randomUUID(), companyId: input.companyId, name: clean(input.name), purpose: clean(input.purpose), roleIds: input.roleIds ?? [], skillIds: input.skillIds ?? [] }) }
  private createRole(input: Extract<OrganizationMutation, { type: 'role.create' }>): void { this.company(input.companyId); this.value.roles.push({ id: randomUUID(), companyId: input.companyId, name: clean(input.name), responsibility: clean(input.responsibility), systemPrompt: clean(input.systemPrompt), skillIds: input.skillIds ?? [], ...(input.providerId ? { providerId: input.providerId } : {}), ...(input.modelId ? { modelId: input.modelId } : {}) }) }
  private updateRole(id: string, patch: Extract<OrganizationMutation, { type: 'role.update' }>['patch']): void { const role = must(this.value.roles.find((item) => item.id === id), 'Role'); Object.assign(role, patch) }
  private createAgent(input: Extract<OrganizationMutation, { type: 'agent.create' }>): void { this.company(input.companyId); this.assertRoleCompany(input.roleId, input.companyId); if (input.teamId) this.assertTeamCompany(input.teamId, input.companyId); this.value.agents.push({ id: randomUUID(), companyId: input.companyId, name: clean(input.name), roleId: input.roleId, status: 'idle', skillIds: input.skillIds ?? [], ...(input.teamId ? { teamId: input.teamId } : {}), ...(input.providerId ? { providerId: input.providerId } : {}), ...(input.modelId ? { modelId: input.modelId } : {}) }) }
  private updateAgent(id: string, patch: Extract<OrganizationMutation, { type: 'agent.update' }>['patch']): void { const agent = must(this.value.agents.find((item) => item.id === id), 'Agent'); Object.assign(agent, patch) }
  private createSkill(input: Extract<OrganizationMutation, { type: 'skill.create' }>): void { const companyId = input.companyId; if (!companyId) throw new Error('Scoped skills require companyId'); this.company(companyId); if (input.projectId && this.project(input.projectId).companyId !== companyId) throw new Error('Project skill crosses company boundary'); if (input.teamId) this.assertTeamCompany(input.teamId, companyId); if (input.roleId) this.assertRoleCompany(input.roleId, companyId); if (input.agentId && !this.value.agents.some((item) => item.id === input.agentId && item.companyId === companyId)) throw new Error('Agent skill crosses company boundary'); this.value.skills.push({ id: randomUUID(), scope: input.scope, name: clean(input.name), description: clean(input.description), instructions: clean(input.instructions), companyId, ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.teamId ? { teamId: input.teamId } : {}), ...(input.roleId ? { roleId: input.roleId } : {}), ...(input.agentId ? { agentId: input.agentId } : {}) }) }
  private createWorkflow(input: Extract<OrganizationMutation, { type: 'workflow.create' }>): void { this.company(input.companyId); if (input.projectId && this.project(input.projectId).companyId !== input.companyId) throw new Error('Workflow crosses company boundary'); if (!input.steps.length) throw new Error('Workflow must contain at least one step'); this.value.workflows.push({ id: randomUUID(), companyId: input.companyId, name: clean(input.name), scope: input.projectId ? 'project' : 'company', ...(input.projectId ? { projectId: input.projectId } : {}), steps: input.steps }) }
  private createGoal(input: Extract<OrganizationMutation, { type: 'goal.create' }>): void { if (this.project(input.projectId).companyId !== input.companyId) throw new Error('Goal crosses company boundary'); this.value.goals.push({ id: randomUUID(), companyId: input.companyId, projectId: input.projectId, title: clean(input.title), description: clean(input.description), status: 'active', progress: 0, createdAt: Date.now() }); this.refreshProject(input.projectId) }
  private assertMilestoneProject(id: string, projectId: string) {
    if (typeof id !== 'string') throw new Error('Milestone must be an ID')
    const milestone = this.value.milestones.find((item) => item.id === id && item.projectId === projectId)
    if (!milestone) throw new Error('Milestone does not belong to this project')
    return milestone
  }

  private createMilestone(input: Extract<OrganizationMutation, { type: 'milestone.create' }>): void {
    const project = this.project(input.projectId)
    const title = clean(input.title)
    const description = clean(input.description)
    if (!title || !description) throw new Error('A milestone requires a title and verifiable outcome')
    let goal = input.goalId
      ? this.value.goals.find((item) => item.id === input.goalId && item.projectId === project.id)
      : this.value.goals.filter((item) => item.projectId === project.id).at(-1)
    if (input.goalId && !goal) throw new Error('Goal does not belong to this project')
    if (!goal) {
      goal = { id: randomUUID(), companyId: project.companyId, projectId: project.id, title: project.name, description: project.objective, status: 'active', progress: 0, createdAt: Date.now() }
      this.value.goals.push(goal)
    }
    const milestones = this.value.milestones.filter((item) => item.projectId === project.id)
    const milestone = { id: randomUUID(), companyId: project.companyId, projectId: project.id, goalId: goal.id, title, description, status: 'pending' as const, order: milestones.length }
    this.value.milestones.push(milestone)
    if (!milestones.length) project.deliveryMilestoneId = milestone.id
    this.activity(project.companyId, project.id, 'milestone.created', `Created milestone “${title}”.`)
    this.refreshProject(project.id)
  }

  private reorderTasks(input: Extract<OrganizationMutation, { type: 'task.reorder' }>): void {
    const project = this.project(input.projectId)
    if (input.milestoneId) this.assertMilestoneProject(input.milestoneId, input.projectId)
    if (!Array.isArray(input.taskIds) || !input.taskIds.every((id) => typeof id === 'string')) throw new Error('Task order must contain task IDs')
    const tasks = this.value.tasks.filter((task) => task.projectId === input.projectId && (task.milestoneId ?? '') === (input.milestoneId ?? ''))
    const ids = new Set(input.taskIds)
    if (ids.size !== input.taskIds.length || ids.size !== tasks.length || tasks.some((task) => !ids.has(task.id))) {
      throw new Error('Task order must include every task in this milestone exactly once')
    }
    const positions = new Map(input.taskIds.map((id, index) => [id, index]))
    for (const task of tasks) { task.queueOrder = positions.get(task.id)!; task.updatedAt = Date.now() }
    this.activity(project.companyId, project.id, 'task.reordered', `Ordered ${tasks.length} task(s) in ${this.value.milestones.find((item) => item.id === input.milestoneId)?.title ?? 'Unassigned work'}.`)
  }
  private createTask(input: Extract<OrganizationMutation, { type: 'task.create' }>): void {
    const project = this.project(input.projectId)
    if (project.companyId !== input.companyId) throw new Error('Project does not belong to company')
    const milestone = input.milestoneId ? this.assertMilestoneProject(input.milestoneId, project.id) : undefined
    if (input.goalId && !this.value.goals.some((goal) => goal.id === input.goalId && goal.projectId === project.id)) throw new Error('Goal does not belong to this project')
    if (milestone && input.goalId && input.goalId !== milestone.goalId) throw new Error('Task goal does not match milestone')
    if (input.assignedAgentId && !this.value.agents.some((item) => item.id === input.assignedAgentId && item.companyId === input.companyId)) throw new Error('Assigned agent crosses company boundary')
    if (input.assignedMemberId && !this.value.members.some((item) => item.id === input.assignedMemberId && item.companyId === input.companyId && item.status === 'active')) throw new Error('Assigned member crosses company boundary')
    if (input.accountableMemberId && !this.value.members.some((item) => item.id === input.accountableMemberId && item.companyId === input.companyId && item.status === 'active')) throw new Error('Accountable member crosses company boundary')
    if (input.reviewerMemberId && !this.value.members.some((item) => item.id === input.reviewerMemberId && item.companyId === input.companyId && item.status === 'active')) throw new Error('Reviewer member crosses company boundary')
    if (input.reviewerAgentId && !this.value.agents.some((item) => item.id === input.reviewerAgentId && item.companyId === input.companyId)) throw new Error('Reviewer agent crosses company boundary')
    for (const collaboratorId of input.collaboratorIds ?? []) this.assertActorInCompany(collaboratorId, input.companyId)
    for (const dependency of input.dependsOn ?? []) if (!this.value.tasks.some((item) => item.id === dependency && item.projectId === input.projectId)) throw new Error('Task dependency crosses project boundary')
    for (const skillId of input.requestedSkillIds ?? []) {
      const skill = this.value.skills.find((item) => item.id === skillId)
      if (!skill) throw new Error(`Requested skill not found: ${skillId}`)
      if (skill.scope !== 'builtin' && skill.companyId !== input.companyId) throw new Error('Requested skill crosses company boundary')
      if (skill.projectId && skill.projectId !== input.projectId) throw new Error('Requested skill crosses project boundary')
    }
    const duplicateTrigger = input.sourceTriggerId && input.sourceActivityId
      ? this.value.tasks.find((item) => item.sourceTriggerId === input.sourceTriggerId && item.sourceActivityId === input.sourceActivityId)
      : undefined
    if (duplicateTrigger) return

    const isHuman = input.assigneeKind === 'human' || Boolean(input.assignedMemberId)
    const agent = !isHuman
      ? (input.assignedAgentId ? this.value.agents.find((item) => item.id === input.assignedAgentId) : this.pickAgent(input.companyId))
      : undefined
    if (agent?.teamId && !project.teamIds.includes(agent.teamId)) project.teamIds.push(agent.teamId)
    const now = Date.now()
    this.value.tasks.push({
      id: randomUUID(),
      companyId: input.companyId,
      projectId: input.projectId,
      title: clean(input.title),
      description: clean(input.description),
      acceptanceCriteria: input.acceptanceCriteria?.map(clean).filter(Boolean) ?? ['Requested outcome is implemented and verified.'],
      priority: input.priority ?? 'medium',
      status: 'backlog',
      dependsOn: input.dependsOn ?? [],
      assigneeKind: isHuman ? 'human' : 'agent',
      ...(isHuman && input.assignedMemberId ? { assignedMemberId: input.assignedMemberId } : {}),
      ...(agent ? { assignedAgentId: agent.id } : {}),
      ...(input.collaboratorIds?.length ? { collaboratorIds: [...new Set(input.collaboratorIds)] } : {}),
      ...(input.accountableMemberId ? { accountableMemberId: input.accountableMemberId } : {}),
      ...(input.reviewerKind ? { reviewerKind: input.reviewerKind } : {}),
      ...(input.reviewerMemberId ? { reviewerMemberId: input.reviewerMemberId } : {}),
      ...(input.reviewerAgentId ? { reviewerAgentId: input.reviewerAgentId } : {}),
      ...((milestone?.goalId ?? input.goalId) ? { goalId: milestone?.goalId ?? input.goalId } : {}),
      ...(milestone ? { milestoneId: milestone.id } : {}),
      ...taskExecutionHints(input),
      ...(input.sourceScheduleId ? { sourceScheduleId: clean(input.sourceScheduleId) } : {}),
      ...(input.sourceTriggerId ? { sourceTriggerId: clean(input.sourceTriggerId) } : {}),
      ...(input.sourceActivityId ? { sourceActivityId: clean(input.sourceActivityId) } : {}),
      ...(input.requestedSkillIds?.length ? { requestedSkillIds: [...new Set(input.requestedSkillIds)] } : {}),
      createdAt: now,
      updatedAt: now,
    })
    this.refreshProject(input.projectId)
  }
  private updateTask(id: string, patch: Extract<OrganizationMutation, { type: 'task.update' }>['patch']): void {
    const task = this.task(id)
    const milestoneBefore = task.milestoneId
    if (patch.milestoneId !== undefined && typeof patch.milestoneId !== 'string') throw new Error('Task milestone must be a milestone ID or empty string')
    const milestone = patch.milestoneId ? this.assertMilestoneProject(patch.milestoneId, task.projectId) : undefined
    if (patch.milestoneId !== undefined && patch.milestoneId !== (task.milestoneId ?? '') && (task.status === 'in_progress' || task.status === 'review')) throw new Error('Cannot move a task to another milestone while it is in progress or review')
    if (patch.assignedAgentId && !this.value.agents.some((item) => item.id === patch.assignedAgentId && item.companyId === task.companyId)) throw new Error('Assigned agent crosses company boundary')
    if (patch.assignedMemberId && !this.value.members.some((item) => item.id === patch.assignedMemberId && item.companyId === task.companyId && item.status === 'active')) throw new Error('Assigned member crosses company boundary')
    if (patch.accountableMemberId && !this.value.members.some((item) => item.id === patch.accountableMemberId && item.companyId === task.companyId && item.status === 'active')) throw new Error('Accountable member crosses company boundary')
    if (patch.reviewerMemberId && !this.value.members.some((item) => item.id === patch.reviewerMemberId && item.companyId === task.companyId && item.status === 'active')) throw new Error('Reviewer member crosses company boundary')
    if (patch.reviewerAgentId && !this.value.agents.some((item) => item.id === patch.reviewerAgentId && item.companyId === task.companyId)) throw new Error('Reviewer agent crosses company boundary')
    for (const collaboratorId of patch.collaboratorIds ?? []) this.assertActorInCompany(collaboratorId, task.companyId)
    const changesAssignee = (patch.assignedAgentId !== undefined && patch.assignedAgentId !== task.assignedAgentId)
      || (patch.assignedMemberId !== undefined && patch.assignedMemberId !== task.assignedMemberId)
      || (patch.assigneeKind !== undefined && patch.assigneeKind !== task.assigneeKind)
    if (changesAssignee && (task.status === 'in_progress' || task.status === 'review' || this.value.runs.some((run) => run.taskId === task.id && run.status === 'running'))) {
      throw new Error('Cannot reassign a task while it is in progress or review')
    }
    for (const dependency of patch.dependsOn ?? []) if (!this.value.tasks.some((item) => item.id === dependency && item.projectId === task.projectId)) throw new Error('Task dependency crosses project boundary')
    const nextPatch = { ...patch }
    if (patch.workScopes !== undefined) nextPatch.workScopes = normalizeWorkScopes(patch.workScopes)
    if (patch.artifactPaths !== undefined) nextPatch.artifactPaths = normalizeArtifactPaths(patch.artifactPaths)
    if (patch.requestedSkillIds !== undefined) {
      for (const skillId of patch.requestedSkillIds) {
        const skill = this.value.skills.find((item) => item.id === skillId)
        if (!skill) throw new Error(`Requested skill not found: ${skillId}`)
        if (skill.scope !== 'builtin' && skill.companyId !== task.companyId) throw new Error('Requested skill crosses company boundary')
        if (skill.projectId && skill.projectId !== task.projectId) throw new Error('Requested skill crosses project boundary')
      }
      nextPatch.requestedSkillIds = [...new Set(patch.requestedSkillIds)]
    }
    const effectiveEvidence = patch.evidenceKind ?? task.evidenceKind ?? ((nextPatch.artifactPaths ?? task.artifactPaths)?.length ? 'artifact' : 'code')
    const effectiveArtifacts = nextPatch.artifactPaths ?? task.artifactPaths ?? []
    if (effectiveEvidence === 'artifact' && effectiveArtifacts.length === 0) throw new Error('Artifact tasks require at least one artifact path')
    Object.assign(task, nextPatch)
    if (patch.milestoneId !== undefined && patch.milestoneId !== (milestoneBefore ?? '')) {
      delete task.queueOrder
      if (milestone) task.goalId = milestone.goalId
      else delete task.milestoneId
    }
    if (patch.milestoneId === '') delete task.milestoneId
    if (task.status !== 'blocked') delete task.blockedReason
    task.updatedAt = Date.now()
    this.refreshProject(task.projectId)
  }

  private reassignTask(input: Extract<OrganizationMutation, { type: 'task.reassign' }>): void {
    const task = this.task(input.taskId)
    if (task.status === 'in_progress' || task.status === 'review' || this.value.runs.some((run) => run.taskId === task.id && run.status === 'running')) {
      throw new Error('Cannot reassign a task while it is in progress or review')
    }
    const reason = clean(input.reason)
    if (!reason) throw new Error('A reason is required when reassigning a task')
    const fromAssignee = task.assigneeKind === 'human' && task.assignedMemberId
      ? { kind: 'human' as const, id: task.assignedMemberId }
      : task.assignedAgentId
        ? { kind: 'agent' as const, id: task.assignedAgentId }
        : undefined
    const changedBy: OrganizationActorRef = input.changedByMemberId
      ? { kind: 'human', id: this.member(input.changedByMemberId, task.companyId).id }
      : { kind: 'system', id: 'system' }

    if (input.assignee.kind === 'human') {
      const member = this.member(input.assignee.id, task.companyId)
      task.assigneeKind = 'human'
      task.assignedMemberId = member.id
      delete task.assignedAgentId
    } else {
      const agent = must(this.value.agents.find((item) => item.id === input.assignee.id && item.companyId === task.companyId), 'Organization agent')
      task.assigneeKind = 'agent'
      task.assignedAgentId = agent.id
      delete task.assignedMemberId
    }

    const handoff: OrganizationTaskHandoff = {
      id: randomUUID(),
      taskId: task.id,
      timestamp: Date.now(),
      ...(fromAssignee ? { fromAssignee } : {}),
      toAssignee: { kind: input.assignee.kind, id: input.assignee.id },
      changedBy,
      reason,
    }
    delete task.humanSubmission
    if (!task.handoffs) task.handoffs = []
    task.handoffs.push(handoff)
    task.updatedAt = Date.now()
    const targetName = input.assignee.kind === 'human'
      ? this.value.members.find((m) => m.id === input.assignee.id)?.displayName ?? 'Human member'
      : this.value.agents.find((a) => a.id === input.assignee.id)?.name ?? 'AI agent'
    this.activity(task.companyId, task.projectId, 'task.reassigned', `Reassigned “${task.title}” to ${targetName}: ${reason}`)
    this.refreshProject(task.projectId)
  }

  private submitTaskWork(input: Extract<OrganizationMutation, { type: 'task.submitWork' }>): void {
    const task = this.task(input.taskId)
    const member = this.member(input.memberId, task.companyId)
    if (task.assigneeKind !== 'human' || task.assignedMemberId !== member.id) throw new Error('Only the assigned human member can submit work')
    if (task.status !== 'in_progress' && task.status !== 'ready') throw new Error('Human work can only be submitted for a ready or in progress task')
    if (this.value.runs.some((run) => run.taskId === task.id && run.status === 'running')) throw new Error('Cannot submit human work while an automated run is active')
    const summary = clean(input.summary)
    if (!summary) throw new Error('Work submission requires a summary of delivered outcomes')
    const artifacts = input.artifactPaths ? normalizeArtifactPaths(input.artifactPaths) : undefined
    const checkpointCommit = input.checkpointCommit?.trim()
    task.humanSubmission = { id: randomUUID(), memberId: member.id, ...(checkpointCommit ? { checkpointCommit } : {}) }
    this.cancelStaleApprovals(task.id, task.humanSubmission.id)
    task.resultSummary = summary
    if (artifacts) {
      task.artifactPaths = artifacts
      if (task.artifactPaths.length) task.evidenceKind = 'artifact'
    }
    const hasReviewer = Boolean(task.reviewerMemberId || task.reviewerAgentId)
    task.status = hasReviewer ? 'review' : 'completed'
    task.updatedAt = Date.now()
    if (hasReviewer && task.reviewerMemberId) {
      this.value.approvalRequests.push({
        id: randomUUID(),
        companyId: task.companyId,
        projectId: task.projectId,
        taskId: task.id,
        targetKind: 'task-review',
        targetId: task.id,
        targetRevision: task.humanSubmission.id,
        requestedBy: { kind: 'human', id: member.id },
        requiredApproverKind: 'human',
        status: 'pending',
        createdAt: Date.now(),
      })
    }
    this.activity(task.companyId, task.projectId, 'task.submitted', `${member.displayName} submitted work for “${task.title}”.`)
    this.refreshProject(task.projectId)
  }
  private addMemory(input: { companyId: string; projectId?: string; title: string; content: string; tags?: string[]; source: MemoryEntry['source']; type?: string }): void { this.company(input.companyId); const now = Date.now(); this.value.memory.push({ id: randomUUID(), companyId: input.companyId, ...(input.projectId ? { projectId: input.projectId } : {}), title: clean(input.title), content: clean(input.content), tags: input.tags?.map(clean).filter(Boolean) ?? [], source: input.source, createdAt: now, updatedAt: now }) }
  private setPolicy(input: Extract<OrganizationMutation, { type: 'policy.set' }>): void { this.company(input.companyId); const existing = this.value.policies.find((item) => item.companyId === input.companyId && item.action === input.action); if (existing) { existing.effect = input.effect; if (input.description) existing.description = clean(input.description) } else this.value.policies.push({ id: randomUUID(), companyId: input.companyId, action: clean(input.action), effect: input.effect, description: clean(input.description ?? input.action) }) }

  private refreshProject(projectId: string): void {
    const project = this.project(projectId)
    const tasks = this.value.tasks.filter((item) => item.projectId === projectId)
    for (const task of tasks) {
      if (task.status === 'backlog' && task.dependsOn.every((id) => this.value.tasks.find((item) => item.id === id)?.status === 'completed')) task.status = 'ready'
    }

    project.progress = tasks.length ? Math.round(tasks.filter((item) => item.status === 'completed').length / tasks.length * 100) : 0
    const allCompleted = tasks.length > 0 && tasks.every((item) => item.status === 'completed')
    const hasRunnable = tasks.some((item) => item.status === 'in_progress' || item.status === 'review' || item.status === 'ready')
    const hasBlocked = tasks.some((item) => item.status === 'blocked')
    if (allCompleted) project.status = 'completed'
    else if (hasRunnable) project.status = 'active'
    else if (hasBlocked) project.status = 'blocked'
    else if (tasks.length > 0) project.status = 'planning'
    project.updatedAt = Date.now()

    for (const milestone of this.value.milestones.filter((item) => item.projectId === projectId)) {
      const milestoneTasks = tasks.filter((task) => task.milestoneId === milestone.id)
      if (!milestoneTasks.length) milestone.status = 'pending'
      else if (milestoneTasks.every((task) => task.status === 'completed')) milestone.status = 'completed'
      else if (milestoneTasks.some((task) => task.status === 'ready' || task.status === 'in_progress' || task.status === 'review')) milestone.status = 'active'
      else if (milestoneTasks.some((task) => task.status === 'blocked')) milestone.status = 'blocked'
      else milestone.status = 'pending'
    }

    for (const goal of this.value.goals.filter((item) => item.projectId === projectId)) {
      const goalTasks = tasks.filter((task) => task.goalId === goal.id)
      goal.progress = goalTasks.length ? Math.round(goalTasks.filter((task) => task.status === 'completed').length / goalTasks.length * 100) : 0
      if (goal.progress === 100) goal.status = 'completed'
      else if (goalTasks.some((task) => task.status === 'ready' || task.status === 'in_progress' || task.status === 'review')) goal.status = 'active'
      else if (goalTasks.some((task) => task.status === 'blocked')) goal.status = 'blocked'
      else goal.status = 'active'
    }
  }
  private createMember(input: Extract<OrganizationMutation, { type: 'member.create' }>): void {
    this.company(input.companyId)
    const now = Date.now()
    if (input.projectGrants) {
      for (const grant of input.projectGrants) {
        if (!this.value.projects.some((p) => p.id === grant.projectId && p.companyId === input.companyId)) {
          throw new Error('Project grant crosses company boundary')
        }
      }
    }
    this.value.members.push({
      id: randomUUID(),
      companyId: input.companyId,
      displayName: clean(input.displayName),
      ...(input.title?.trim() ? { title: input.title.trim().slice(0, 120) } : {}),
      status: 'active',
      accessRole: input.accessRole ?? 'contributor',
      ...(input.capabilities?.length ? { capabilities: [...new Set(input.capabilities)] } : {}),
      ...(input.projectGrants?.length ? { projectGrants: input.projectGrants } : {}),
      createdAt: now,
      updatedAt: now,
    })
    this.activity(input.companyId, undefined, 'member.created', `Added local member “${input.displayName.trim()}” (${input.accessRole ?? 'contributor'}).`)
  }

  private updateMember(id: string, patch: Extract<OrganizationMutation, { type: 'member.update' }>['patch']): void {
    const member = must(this.value.members.find((item) => item.id === id), 'Organization member')
    if (patch.displayName !== undefined) member.displayName = clean(patch.displayName)
    if (patch.title !== undefined) {
      if (patch.title.trim()) member.title = patch.title.trim().slice(0, 120)
      else delete member.title
    }
    if (patch.status !== undefined) member.status = patch.status
    if (patch.accessRole !== undefined) member.accessRole = patch.accessRole
    if (patch.capabilities !== undefined) member.capabilities = [...new Set(patch.capabilities)]
    if (patch.projectGrants !== undefined) {
      for (const grant of patch.projectGrants) {
        if (!this.value.projects.some((p) => p.id === grant.projectId && p.companyId === member.companyId)) {
          throw new Error('Project grant crosses company boundary')
        }
      }
      member.projectGrants = patch.projectGrants
    }
    member.updatedAt = Date.now()
    this.activity(member.companyId, undefined, 'member.updated', `Updated local member “${member.displayName}”.`)
  }

  private addCollaborationMessage(input: Extract<OrganizationMutation, { type: 'collaboration.message.add' }>): void {
    const project = this.project(input.projectId)
    if (project.companyId !== input.companyId) throw new Error('Collaboration message crosses company boundary')
    const author: OrganizationActorRef = input.author
      ?? (input.authorMemberId ? { kind: 'human' as const, id: this.member(input.authorMemberId, input.companyId).id } : undefined)
      ?? (input.authorAgentId ? { kind: 'agent' as const, id: input.authorAgentId } : undefined)
      ?? { kind: 'system' as const, id: 'system' }
    if (author.kind === 'human') {
      this.member(author.id, input.companyId)
    } else if (author.kind === 'agent') {
      const agent = this.value.agents.find((item) => item.id === author.id && item.companyId === input.companyId)
      if (!agent) throw new Error('Agent author crosses company boundary')
    }
    const task = input.taskId ? this.task(input.taskId) : undefined
    if (task && task.projectId !== input.projectId) throw new Error('Collaboration task crosses project boundary')
    if (input.replyToId) {
      const parent = must(this.value.messages.find((item) => item.id === input.replyToId), 'Parent collaboration message')
      if (parent.projectId !== input.projectId || parent.taskId !== input.taskId) throw new Error('Reply crosses collaboration thread boundary')
    }
    const mentionActorIds = [...new Set((input.mentionActorIds ?? []).map((item) => item.trim()).filter(Boolean))]
    for (const actorId of mentionActorIds) this.assertActorInCompany(actorId, input.companyId)
    const now = Date.now()
    const body = clean(input.body).slice(0, 20_000)
    this.value.messages.push({
      id: randomUUID(),
      companyId: input.companyId,
      projectId: input.projectId,
      kind: input.kind ?? (input.taskId ? 'task' : 'project'),
      ...(input.category ? { category: input.category } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.replyToId ? { replyToId: input.replyToId } : {}),
      author,
      body,
      mentionActorIds,
      ...(input.runId ? { runId: clean(input.runId) } : {}),
      createdAt: now,
      updatedAt: now,
    })
    const authorName = author.kind === 'human'
      ? this.value.members.find((m) => m.id === author.id)?.displayName ?? 'Human member'
      : this.value.agents.find((a) => a.id === author.id)?.name ?? 'Agent'
    this.activity(input.companyId, input.projectId, 'collaboration.message', `${authorName} posted ${input.taskId ? 'a task comment' : 'a project message'}.`)
  }

  private createDecision(input: Extract<OrganizationMutation, { type: 'decision.create' }>): void {
    const project = this.project(input.projectId)
    if (project.companyId !== input.companyId) throw new Error('Decision crosses company boundary')
    const member = this.member(input.authorMemberId, input.companyId)
    if (input.taskId && this.task(input.taskId).projectId !== input.projectId) throw new Error('Decision task crosses project boundary')
    const now = Date.now()
    this.value.decisions.push({
      id: randomUUID(),
      companyId: input.companyId,
      projectId: input.projectId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      title: clean(input.title).slice(0, 240),
      summary: clean(input.summary).slice(0, 4_000),
      rationale: clean(input.rationale).slice(0, 12_000),
      status: 'active',
      createdBy: { kind: 'human', id: member.id },
      createdAt: now,
      updatedAt: now,
    })
    this.activity(input.companyId, input.projectId, 'decision.created', `${member.displayName} recorded decision “${input.title.trim()}”.`)
  }

  private supersedeDecision(input: Extract<OrganizationMutation, { type: 'decision.supersede' }>): void {
    const previous = must(this.value.decisions.find((item) => item.id === input.id), 'Decision')
    if (previous.status !== 'active') throw new Error('Only an active decision can be superseded')
    const member = this.member(input.authorMemberId, previous.companyId)
    const now = Date.now()
    previous.status = 'superseded'
    previous.updatedAt = now
    this.value.decisions.push({
      id: randomUUID(),
      companyId: previous.companyId,
      projectId: previous.projectId,
      ...(previous.taskId ? { taskId: previous.taskId } : {}),
      title: clean(input.title).slice(0, 240),
      summary: clean(input.summary).slice(0, 4_000),
      rationale: clean(input.rationale).slice(0, 12_000),
      status: 'active',
      createdBy: { kind: 'human', id: member.id },
      supersedesDecisionId: previous.id,
      createdAt: now,
      updatedAt: now,
    })
    this.activity(previous.companyId, previous.projectId, 'decision.superseded', `${member.displayName} superseded decision “${previous.title}”.`)
  }

  private createApprovalRequest(input: Extract<OrganizationMutation, { type: 'approval.request' }>): void {
    const project = this.project(input.projectId)
    if (project.companyId !== input.companyId) throw new Error('Approval request crosses company boundary')
    const requester = this.member(input.requesterMemberId, input.companyId)
    const task = input.taskId ? this.task(input.taskId) : undefined
    if (task && task.projectId !== input.projectId) throw new Error('Approval task crosses project boundary')
    const checkpointBound = input.targetKind === 'task-review' || input.targetKind === 'integration'
    if (checkpointBound && !task) throw new Error('Task approval requires a task')
    if (checkpointBound && task && input.targetId.trim() !== task.id) throw new Error('Task approval targetId must match taskId')
    if (input.targetKind === 'integration' && task?.integrationState === 'integrated') {
      throw new Error('Task is already integrated; an integration approval cannot undo merged work. Create a follow-up task or decision instead.')
    }
    const latestRevision = task ? this.latestCheckpoint(task.id) : undefined
    const requestedRevision = input.targetRevision?.trim()
    if (checkpointBound && !latestRevision) throw new Error('Checkpoint-bound approval requires a real task checkpoint')
    if (checkpointBound && requestedRevision && requestedRevision !== latestRevision) {
      throw new Error(`Approval target is stale: requested checkpoint ${requestedRevision}, current checkpoint is ${latestRevision}`)
    }
    const revision = checkpointBound ? latestRevision : requestedRevision
    if (this.value.approvalRequests.some((item) => item.status === 'pending' && item.targetKind === input.targetKind && item.targetId === input.targetId && item.targetRevision === revision)) {
      throw new Error('An equivalent approval request is already pending')
    }
    const request = {
      id: randomUUID(),
      companyId: input.companyId,
      projectId: input.projectId,
      ...(task ? { taskId: task.id } : {}),
      targetKind: input.targetKind,
      targetId: clean(input.targetId).slice(0, 512),
      ...(revision ? { targetRevision: revision.slice(0, 256) } : {}),
      requestedBy: { kind: 'human' as const, id: requester.id },
      requiredApproverKind: 'human' as const,
      status: 'pending' as const,
      createdAt: Date.now(),
    }
    this.value.approvalRequests.push(request)
    this.activity(input.companyId, input.projectId, 'approval.requested', `${requester.displayName} requested explicit ${input.targetKind} approval.`)
  }

  private resolveApproval(input: Extract<OrganizationMutation, { type: 'approval.resolve' }>): void {
    const request = must(this.value.approvalRequests.find((item) => item.id === input.id), 'Approval request')
    if (request.status !== 'pending') throw new Error('Approval request is no longer pending')
    const member = this.member(input.actorMemberId, request.companyId)
    const approvalTask = request.taskId ? this.task(request.taskId) : undefined
    if (request.targetKind === 'task-review' && approvalTask?.humanSubmission && approvalTask.reviewerMemberId !== member.id) throw new Error('Only the assigned human reviewer can resolve this submission')
    if (request.targetKind === 'integration' && approvalTask?.integrationState === 'integrated') {
      throw new Error('Integration approval is no longer actionable because the checkpoint has already been integrated.')
    }
    if (request.taskId && request.targetRevision) {
      const current = request.targetKind === 'task-review' && approvalTask?.humanSubmission
        ? approvalTask.humanSubmission.id
        : this.latestCheckpoint(request.taskId)
      if (current !== request.targetRevision) {
        throw new Error(`Approval target is stale: expected checkpoint ${request.targetRevision}, current checkpoint is ${current ?? 'unavailable'}`)
      }
    }
    const status = input.verdict === 'approve' ? 'approved' : input.verdict === 'request_changes' ? 'changes_requested' : 'rejected'
    request.status = status
    request.resolvedAt = Date.now()
    if (request.taskId) {
      const task = approvalTask ?? this.task(request.taskId)
      if (input.verdict === 'approve' && request.targetKind === 'task-review' && task.humanSubmission && task.status === 'review') {
        task.status = 'completed'
        task.reviewSummary = input.comment?.trim().slice(0, 20_000) || 'Approved by the assigned human reviewer.'
        task.updatedAt = request.resolvedAt
        this.refreshProject(task.projectId)
      } else if (input.verdict === 'request_changes') {
        task.status = 'ready'
        task.integrationState = 'pending'
        delete task.integrationSummary
        delete task.integratedHead
        delete task.blockedReason
        task.updatedAt = request.resolvedAt
        this.teamEvent(task, 'blocker', `Human changes requested for “${task.title}”.`)
        this.refreshProject(task.projectId)
      } else if (input.verdict === 'reject') {
        task.status = 'blocked'
        task.blockedReason = input.comment?.trim().slice(0, 2_000) || 'Rejected by explicit human approval.'
        task.updatedAt = request.resolvedAt
        this.teamEvent(task, 'blocker', `Human rejected approval for “${task.title}”.`)
        this.refreshProject(task.projectId)
      }
    }
    this.value.approvalVerdicts.push({
      id: randomUUID(),
      requestId: request.id,
      actor: { kind: 'human', id: member.id },
      verdict: input.verdict,
      ...(input.comment?.trim() ? { comment: input.comment.trim().slice(0, 8_000) } : {}),
      createdAt: request.resolvedAt,
    })
    this.activity(request.companyId, request.projectId, `approval.${status}`, `${member.displayName} ${status.replace('_', ' ')} ${request.targetKind} approval.`)
  }

  private member(id: string, companyId: string) {
    const member = must(this.value.members.find((item) => item.id === id), 'Organization member')
    if (member.companyId !== companyId || member.status !== 'active') throw new Error('Organization member is not active in this company')
    return member
  }

  private assertActorInCompany(id: string, companyId: string): void {
    if (this.value.members.some((item) => item.id === id && item.companyId === companyId && item.status === 'active')) return
    if (this.value.agents.some((item) => item.id === id && item.companyId === companyId)) return
    throw new Error('Mention actor crosses company boundary')
  }

  private latestCheckpoint(taskId: string): string | undefined {
    return this.value.runs.find((item) => item.taskId === taskId && item.checkpointCommit)?.checkpointCommit
  }

  private cancelStaleApprovals(taskId: string, checkpoint: string): void {
    const now = Date.now()
    for (const request of this.value.approvalRequests) {
      if (request.taskId !== taskId || request.status !== 'pending' || !request.targetRevision || request.targetRevision === checkpoint) continue
      request.status = 'cancelled'
      request.resolvedAt = now
      this.activity(request.companyId, request.projectId, 'approval.cancelled', `Cancelled stale ${request.targetKind} approval after checkpoint changed.`)
    }
  }

  private cancelPendingIntegrationApprovals(taskId: string): void {
    const now = Date.now()
    for (const request of this.value.approvalRequests) {
      if (request.taskId !== taskId || request.targetKind !== 'integration' || request.status !== 'pending') continue
      request.status = 'cancelled'
      request.resolvedAt = now
      this.activity(request.companyId, request.projectId, 'approval.cancelled', 'Cancelled integration approval because the checkpoint was already integrated.')
    }
  }

  private seedRole(companyId: string, name: string, responsibility: string, systemPrompt: string, skillIds: string[]): OrganizationRole { const role = { id: randomUUID(), companyId, name, responsibility, systemPrompt, skillIds }; this.value.roles.push(role); return role }
  private seedTeam(companyId: string, name: string, purpose: string, roleIds: string[], skillIds: string[]): Team { const team = { id: randomUUID(), companyId, name, purpose, roleIds, skillIds }; this.value.teams.push(team); return team }
  private seedAgent(companyId: string, name: string, roleId: string, teamId: string): OrganizationAgent { const agent: OrganizationAgent = { id: randomUUID(), companyId, name, roleId, teamId, status: 'idle', skillIds: [] }; this.value.agents.push(agent); return agent }
  private pickAgent(companyId: string, roleHint?: string): OrganizationAgent | undefined {
    const hint = roleHint?.trim().toLowerCase() ?? ''
    const roles = this.value.roles.filter((role) => role.companyId === companyId)
    const hintedRole = hint ? roles.find((item) => item.name.toLowerCase().includes(hint) || hint.includes(item.name.toLowerCase())) : undefined
    const role = hintedRole ?? roles.find((item) => /engineer/i.test(item.name)) ?? roles[0]
    if (!role) return undefined
    const agents = this.value.agents.filter((agent) => agent.companyId === companyId && agent.roleId === role.id)
    return agents
      .map((agent, index) => ({
        agent,
        index,
        open: this.value.tasks.filter((task) => task.assignedAgentId === agent.id && task.status !== 'completed').length,
      }))
      .sort((a, b) => a.open - b.open || a.index - b.index)[0]?.agent
  }

  private pickReviewer(task: OrganizationTask): OrganizationAgent | undefined {
    const roles = this.value.roles.filter((role) => role.companyId === task.companyId)
    const reviewerRoleIds = new Set(roles.filter((role) => /review|quality|qa/i.test(role.name)).map((role) => role.id))
    const candidates = this.value.agents.filter((agent) => agent.companyId === task.companyId && reviewerRoleIds.has(agent.roleId))
    if (!candidates.length) return this.pickAgent(task.companyId, 'review')
    const worker = task.assignedAgentId ? this.value.agents.find((item) => item.id === task.assignedAgentId) : undefined
    const workerRole = worker ? roles.find((role) => role.id === worker.roleId) : undefined
    const workerRoute = routeKey(worker, workerRole)
    return candidates
      .map((agent, index) => {
        const role = roles.find((item) => item.id === agent.roleId)
        const route = routeKey(agent, role)
        const sameRoute = Boolean(workerRoute && route && workerRoute === route)
        const reviews = this.value.tasks.filter((item) => item.reviewerAgentId === agent.id).length
        return { agent, index, sameRoute, reviews, busy: agent.status === 'reviewing' ? 1 : 0 }
      })
      .sort((a, b) => a.busy - b.busy || Number(a.sameRoute) - Number(b.sameRoute) || a.reviews - b.reviews || a.index - b.index)[0]?.agent
  }
  private setAgent(agentId: string | undefined, status: AgentStatus, taskId?: string, sessionId?: string): void { if (!agentId) return; const agent = this.value.agents.find((item) => item.id === agentId); if (!agent) return; agent.status = status; if (taskId) agent.currentTaskId = taskId; else delete agent.currentTaskId; if (sessionId) agent.lastSessionId = sessionId }

  /**
   * Settle the agent that owns a task once that task stops being in flight.
   *
   * The owner is read from the task, never from the agent's `currentTaskId`: an
   * agent holds one such slot but can own several concurrent tasks, so a second
   * task starting overwrites it and settling the first would silently find
   * nobody. That left a reviewer stuck in `reviewing`, which `pickReviewer`
   * then deprioritises forever.
   *
   * The agent is reported idle only when no other task of its work is still
   * running or in review; otherwise the slot is re-pointed at that work so the
   * single status field stays truthful instead of advertising a busy agent as
   * available for the next dispatch.
   */
  private releaseTaskAgent(agentId: string | undefined, settledTaskId: string): void {
    if (!agentId) return
    const agent = this.value.agents.find((item) => item.id === agentId)
    if (!agent) return
    const remaining = this.value.tasks.find((task) => task.id !== settledTaskId
      && (task.assignedAgentId === agentId || task.reviewerAgentId === agentId)
      && (task.status === 'in_progress' || task.status === 'review'))
    if (remaining) {
      this.setAgent(agentId, remaining.status === 'review' ? 'reviewing' : 'working', remaining.id)
      return
    }
    this.setAgent(agentId, 'idle')
  }
  private assertRoleCompany(roleId: string, companyId: string): void { if (!this.value.roles.some((item) => item.id === roleId && item.companyId === companyId)) throw new Error('Role crosses company boundary') }
  private assertTeamCompany(teamId: string, companyId: string): void { if (!this.value.teams.some((item) => item.id === teamId && item.companyId === companyId)) throw new Error('Team crosses company boundary') }
  private company(id: string): Company { return must(this.value.companies.find((item) => item.id === id), 'Company') }
  private project(id: string): Project { return must(this.value.projects.find((item) => item.id === id), 'Project') }
  private task(id: string): OrganizationTask { return must(this.value.tasks.find((item) => item.id === id), 'Task') }
  private teamEvent(task: OrganizationTask, kind: OrganizationTeamEventKind, summary: string): void {
    const agent = task.assignedAgentId ? this.value.agents.find((item) => item.id === task.assignedAgentId) : undefined
    this.value.coordination.unshift({
      id: randomUUID(),
      companyId: task.companyId,
      projectId: task.projectId,
      ...(agent?.teamId ? { teamId: agent.teamId } : {}),
      taskId: task.id,
      ...(agent ? { agentId: agent.id } : {}),
      kind,
      summary: summary.slice(0, 4_000),
      createdAt: Date.now(),
    })
    this.value.coordination = this.value.coordination.slice(0, 500)
  }
  private activity(companyId: string, projectId: string | undefined, type: string, message: string): void { const row: OrganizationActivity = { id: randomUUID(), companyId, type, message, createdAt: Date.now(), ...(projectId ? { projectId } : {}) }; this.value.activity.unshift(row); this.value.activity = this.value.activity.slice(0, 500) }
}

function normalizeSnapshot(value: unknown): DurableOrganizationSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Organization snapshot must be a JSON object')
  const record = value as Record<string, unknown>
  if (record.version !== 1) throw new Error(`Unsupported organization snapshot version: ${String(record.version)}`)
  for (const key of SNAPSHOT_ARRAY_KEYS) {
    if (!Array.isArray(record[key])) throw new Error(`Organization snapshot field ${key} must be an array`)
  }
  for (const key of ['members', 'messages', 'decisions', 'approvalRequests', 'approvalVerdicts', 'coordination'] as const) {
    if (record[key] !== undefined && !Array.isArray(record[key])) {
      throw new Error(`Organization snapshot field ${key} must be an array when present`)
    }
  }
  const parsed = record as unknown as OrganizationSnapshot
  return {
    ...clone(EMPTY),
    ...parsed,
    members: parsed.members ?? [],
    messages: parsed.messages ?? [],
    decisions: parsed.decisions ?? [],
    approvalRequests: parsed.approvalRequests ?? [],
    approvalVerdicts: parsed.approvalVerdicts ?? [],
    skills: mergeBuiltins(parsed.skills),
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

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function clean(value: string): string { const text = value.trim(); if (!text) throw new Error('Organization text fields cannot be empty'); return text }
function must<T>(value: T | undefined, label: string): T { if (!value) throw new Error(`${label} not found`); return value }
function clone<T>(value: T): T { return structuredClone(value) }
function mergeBuiltins(skills: OrganizationSkill[]): OrganizationSkill[] { const custom = skills.filter((item) => item.scope !== 'builtin'); return [...clone(BUILTIN_SKILLS), ...custom] }
function taskExecutionHints(input: { workScopes?: string[]; evidenceKind?: OrganizationTask['evidenceKind']; artifactPaths?: string[] }): Partial<Pick<OrganizationTask, 'workScopes' | 'evidenceKind' | 'artifactPaths'>> {
  const workScopes = normalizeWorkScopes(input.workScopes ?? [])
  const artifactPaths = normalizeArtifactPaths(input.artifactPaths ?? [])
  const evidenceKind = input.evidenceKind ?? (artifactPaths.length ? 'artifact' : 'code')
  if (evidenceKind === 'artifact' && artifactPaths.length === 0) throw new Error('Artifact tasks require at least one artifact path')
  return {
    ...(workScopes.length ? { workScopes } : {}),
    ...(evidenceKind === 'artifact' ? { evidenceKind } : {}),
    ...(artifactPaths.length ? { artifactPaths } : {}),
  }
}
function normalizeWorkScopes(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > 32) throw new Error('Task workScopes must contain at most 32 entries')
  return [...new Set(values.map((value) => value.trim().replaceAll('\\', '/')).filter(Boolean).map((value) => {
    if (value.length > 512 || /[\u0000-\u001f]/.test(value)) throw new Error('Task work scope is invalid')
    return value.replace(/^\.\//, '')
  }))]
}
function normalizeArtifactPaths(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > 32) throw new Error('Task artifactPaths must contain at most 32 entries')
  return [...new Set(values.map((value) => value.trim().replaceAll('\\', '/')).filter(Boolean).map((value) => {
    if (value.length > 512 || isAbsolute(value) || value.split('/').includes('..') || /[\u0000-\u001f]/.test(value)) throw new Error('Task artifact path must stay relative to the workspace')
    return value.replace(/^\.\//, '')
  }))]
}
function routeKey(agent?: OrganizationAgent, role?: OrganizationRole): string | undefined {
  const provider = agent?.providerId ?? role?.providerId
  const model = agent?.modelId ?? role?.modelId
  return provider && model ? provider.trim() + '::' + model.trim() : undefined
}
function short(value: string): string { return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value }

/**
 * Project runtime fields arrive from free-form inputs; blank text and
 * out-of-range ports mean "unset" and must delete the stored key instead of
 * persisting an empty string that later reads as configured.
 */
function applyRuntimeFields(target: Project, source: { startCommand?: string; testCommand?: string; targetPort?: number; targetUrl?: string; healthCheckPath?: string }): void {
  const text = (key: 'startCommand' | 'testCommand' | 'targetUrl' | 'healthCheckPath'): void => {
    const value = source[key]
    if (value === undefined) return
    const trimmed = value.trim()
    if (trimmed) target[key] = trimmed
    else deleteProjectKey(target, key)
  }
  text('startCommand'); text('testCommand'); text('targetUrl'); text('healthCheckPath')
  const port = source.targetPort
  if (port === undefined) return
  if (Number.isInteger(port) && port >= 1 && port <= 65_535) target.targetPort = port
  else deleteProjectKey(target, 'targetPort')
}

function deleteProjectKey(target: object, key: string): void { delete (target as Record<string, unknown>)[key] }

/**
 * Project workspaces are durable machine paths, not shell snippets. Keep them
 * canonical and reject escaped/control-character input before it can strand a
 * project in an impossible workspace after a restart.
 */
function normalizeWorkspacePath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('Workspace path must be text')
  const path = value.trim()
  if (!path) return undefined
  if (/[\u0000-\u001f]/.test(path)) {
    throw new Error('Workspace path contains control characters. Select the folder instead of pasting an escaped path.')
  }
  if (!isAbsolute(path)) {
    throw new Error('Workspace path must be absolute. Select the project folder instead of entering a relative path.')
  }
  return resolve(path)
}
