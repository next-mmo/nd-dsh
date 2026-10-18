export type OrganizationAutonomyLevel = 0 | 1 | 2 | 3 | 4
export type OrganizationPolicyEffect = 'allow' | 'ask' | 'deny'
export type OrganizationEntityStatus = 'active' | 'paused' | 'archived'
export type ProjectStatus = 'planning' | 'active' | 'blocked' | 'completed' | 'archived'
export type AgentStatus = 'idle' | 'working' | 'reviewing' | 'blocked' | 'offline'
export type TaskStatus = 'backlog' | 'ready' | 'in_progress' | 'review' | 'blocked' | 'completed'
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical'
export type TaskEvidenceKind = 'code' | 'artifact'
export type OrganizationWorkspaceKind = 'git-worktree' | 'project-workspace' | 'shared-readonly' | 'sandbox' | 'remote'
export type OrganizationIntegrationState = 'pending' | 'integrated' | 'conflict'
export type OrganizationTeamEventKind =
  | 'progress'
  | 'blocker'
  | 'interface-change'
  | 'artifact-ready'
  | 'handoff'
  | 'review-request'
  | 'dependency-unblocked'
export type OrganizationMemberStatus = 'active' | 'inactive'
export type OrganizationActorKind = 'human' | 'agent' | 'system'
export type OrganizationMessageKind = 'project' | 'task' | 'review'
export type OrganizationMessageCategory = 'chat' | 'question' | 'reply' | 'status' | 'handoff'
export type OrganizationDecisionStatus = 'active' | 'superseded' | 'archived'
export type OrganizationApprovalStatus = 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'cancelled'
export type OrganizationApprovalVerdictKind = 'approve' | 'request_changes' | 'reject'
export type OrganizationApprovalTargetKind = 'task-review' | 'integration' | 'action'
export type TaskAssigneeKind = 'agent' | 'human'

export type OrganizationAccessRole = 'owner' | 'admin' | 'pm' | 'contributor' | 'reviewer' | 'guest'

export type OrganizationCapability =
  | 'company.admin'
  | 'project.manage'
  | 'task.create'
  | 'task.assign'
  | 'task.execute'
  | 'review.approve'
  | 'content.write'
  | 'content.read'

export interface OrganizationProjectGrant {
  projectId: string
  role: OrganizationAccessRole
}

export const ROLE_DEFAULT_CAPABILITIES: Record<OrganizationAccessRole, OrganizationCapability[]> = {
  owner: ['company.admin', 'project.manage', 'task.create', 'task.assign', 'task.execute', 'review.approve', 'content.write', 'content.read'],
  admin: ['company.admin', 'project.manage', 'task.create', 'task.assign', 'task.execute', 'review.approve', 'content.write', 'content.read'],
  pm: ['project.manage', 'task.create', 'task.assign', 'task.execute', 'review.approve', 'content.write', 'content.read'],
  contributor: ['task.create', 'content.write', 'content.read'],
  reviewer: ['review.approve', 'content.write', 'content.read'],
  guest: ['content.read'],
}

export function resolveMemberCapabilities(member: OrganizationMember, projectId?: string): Set<OrganizationCapability> {
  let role = member.accessRole ?? 'contributor'
  if (projectId && member.projectGrants?.length) {
    const grant = member.projectGrants.find((g) => g.projectId === projectId)
    if (grant) role = grant.role
  }
  const defaults = ROLE_DEFAULT_CAPABILITIES[role] ?? ROLE_DEFAULT_CAPABILITIES.contributor
  const capabilities = new Set<OrganizationCapability>(defaults)
  if (member.capabilities) {
    for (const cap of member.capabilities) capabilities.add(cap)
  }
  return capabilities
}

export function hasMemberCapability(member: OrganizationMember, capability: OrganizationCapability, projectId?: string): boolean {
  return resolveMemberCapabilities(member, projectId).has(capability)
}

export type OrganizationRunKind = 'pm-plan' | 'task-execution' | 'task-review'
export type OrganizationRunStatus = 'running' | 'completed' | 'failed'
export type OrganizationSubagentMode = 'auto' | 'off'
export type OrganizationScope = 'builtin' | 'company' | 'project' | 'team' | 'role' | 'agent'
export type ProjectRuntimeState = 'stopped' | 'starting' | 'ready' | 'unreachable'

/**
 * The report contract for beta projects pins the app under development at
 * :3000; ND-DSH's own preview port is never assumed as a project target.
 */
export const DEFAULT_PROJECT_PORT = 3000

export interface Company {
  id: string
  name: string
  mission: string
  autonomyLevel: OrganizationAutonomyLevel
  /**
   * Controls in-ticket child-agent delegation only. Company teams, parallel
   * task dispatch and independent review remain separate control-plane concepts.
   * Older snapshots omit this field and therefore resolve to "auto".
   */
  subagentMode?: OrganizationSubagentMode
  status: OrganizationEntityStatus
  createdAt: number
  updatedAt: number
}

export interface Project {
  id: string
  companyId: string
  name: string
  objective: string
  status: ProjectStatus
  workspacePath?: string
  repoUrls: string[]
  teamIds: string[]
  progress: number
  /** Persisted execution scope. Missing means all milestones, including older projects. */
  deliveryMilestoneId?: string
  /** Shell command that starts the project's dev server, run in workspacePath. */
  startCommand?: string
  /** Command used when validating or QA-ing the project (informational + agent hint). */
  testCommand?: string
  /** Port of the running app; defaults to 3000. Never ND-DSH's own preview port. */
  targetPort?: number
  /** Explicit full target URL; wins over targetPort when set. */
  targetUrl?: string
  /** Path appended to the target URL for health checks; defaults to '/'. */
  healthCheckPath?: string
  createdAt: number
  updatedAt: number
}

export const PERSONAL_PROJECT_ID = 'personal'
export const PERSONAL_PROJECT_NAME = 'Personal'

export const BUILTIN_PERSONAL_PROJECT: Readonly<Project> = {
  id: PERSONAL_PROJECT_ID,
  companyId: '',
  name: PERSONAL_PROJECT_NAME,
  objective: 'Personal workspace and global chats',
  status: 'active',
  repoUrls: [],
  teamIds: [],
  progress: 0,
  createdAt: 0,
  updatedAt: 0,
}

export function isPersonalProject(projectId: string | undefined | null): boolean {
  return projectId === PERSONAL_PROJECT_ID
}

/** Live state of a project's dev-server runtime and its browser target. */
export interface ProjectRuntimeStatus {
  projectId: string
  state: ProjectRuntimeState
  /** Resolved URL the built-in browser should open for this project. */
  targetUrl?: string
  port?: number
  pid?: number
  startedAt?: number
  checkedAt?: number
  lastError?: string
  /** Workspace validation findings from the latest check/start attempt. */
  validation?: string[]
}

export interface OrganizationRole {
  id: string
  companyId: string
  name: string
  responsibility: string
  systemPrompt: string
  skillIds: string[]
  providerId?: string
  modelId?: string
}

export interface Team {
  id: string
  companyId: string
  name: string
  purpose: string
  roleIds: string[]
  skillIds: string[]
}

export interface OrganizationAgent {
  id: string
  companyId: string
  name: string
  roleId: string
  teamId?: string
  status: AgentStatus
  skillIds: string[]
  currentTaskId?: string
  lastSessionId?: string
  providerId?: string
  modelId?: string
}

export interface OrganizationSkill {
  id: string
  scope: OrganizationScope
  name: string
  description: string
  instructions: string
  companyId?: string
  projectId?: string
  teamId?: string
  roleId?: string
  agentId?: string
}

export interface WorkflowStep {
  id: string
  name: string
  kind: 'plan' | 'execute' | 'review'
  requiredRole?: string
}

export interface OrganizationWorkflow {
  id: string
  name: string
  scope: 'company' | 'project'
  companyId: string
  projectId?: string
  steps: WorkflowStep[]
}

export interface OrganizationGoal {
  id: string
  companyId: string
  projectId: string
  title: string
  description: string
  status: 'active' | 'completed' | 'blocked'
  progress: number
  createdAt: number
}

export interface Milestone {
  id: string
  companyId: string
  projectId: string
  goalId: string
  title: string
  description: string
  status: 'pending' | 'active' | 'completed' | 'blocked'
  order: number
}

export interface OrganizationTaskHandoff {
  id: string
  taskId: string
  timestamp: number
  fromAssignee?: { kind: TaskAssigneeKind; id: string }
  toAssignee?: { kind: TaskAssigneeKind; id: string }
  changedBy: OrganizationActorRef
  reason: string
}

export interface OrganizationTask {
  id: string
  companyId: string
  projectId: string
  goalId?: string
  milestoneId?: string
  /** Human queue order within its milestone; absent preserves priority ordering. */
  queueOrder?: number
  title: string
  description: string
  acceptanceCriteria: string[]
  priority: TaskPriority
  status: TaskStatus
  dependsOn: string[]
  /** Assignee kind: 'agent' or 'human'. Defaults to 'agent' when assignedAgentId is present. */
  assigneeKind?: TaskAssigneeKind
  assignedAgentId?: string
  /** Human member assigned to execute or lead the task. */
  assignedMemberId?: string
  /** Human or agent collaborator IDs assisting on the task. */
  collaboratorIds?: string[]
  /** Human accountable for the overall delivery/outcome of the task. */
  accountableMemberId?: string
  /** Reviewer kind: 'agent' or 'human'. */
  reviewerKind?: TaskAssigneeKind
  reviewerAgentId?: string
  /** Human member assigned to review the task. */
  reviewerMemberId?: string
  /** Audit log of task ownership changes and handoffs. */
  handoffs?: OrganizationTaskHandoff[]
  workScopes?: string[]
  evidenceKind?: TaskEvidenceKind
  artifactPaths?: string[]
  executionSessionId?: string
  reviewSessionId?: string
  resultSummary?: string
  /** Identifies the human submission being reviewed, including non-code work. */
  humanSubmission?: { id: string; memberId: string; checkpointCommit?: string }
  reviewSummary?: string
  /** Integration is independent from task status so a successful review can remain inspectable when merge-back conflicts. */
  integrationState?: OrganizationIntegrationState
  integrationSummary?: string
  integratedHead?: string
  /** Set when a recurring company schedule created this task. */
  sourceScheduleId?: string
  /** Event-trigger provenance prevents duplicate task creation after a crash/retry. */
  sourceTriggerId?: string
  sourceActivityId?: string
  /** Skills requested by an automation/routine in addition to role/team/agent skills. */
  requestedSkillIds?: string[]
  /** Why ND blocked the task, shown to the human until the task moves again. */
  blockedReason?: string
  createdAt: number
  updatedAt: number
}

export interface MemoryEntry {
  id: string
  companyId: string
  projectId?: string
  title: string
  content: string
  tags: string[]
  source: 'human' | 'pm' | 'worker' | 'reviewer'
  createdAt: number
  updatedAt: number
}

export interface OrganizationPolicy {
  id: string
  companyId: string
  action: string
  effect: OrganizationPolicyEffect
  description: string
}

export interface OrganizationActivity {
  id: string
  companyId: string
  projectId?: string
  type: string
  message: string
  createdAt: number
}

export interface OrganizationTeamEvent {
  id: string
  companyId: string
  projectId: string
  teamId?: string
  taskId?: string
  runId?: string
  agentId?: string
  kind: OrganizationTeamEventKind
  summary: string
  createdAt: number
}

export interface OrganizationMember {
  id: string
  companyId: string
  displayName: string
  title?: string
  status: OrganizationMemberStatus
  accessRole?: OrganizationAccessRole
  capabilities?: OrganizationCapability[]
  projectGrants?: OrganizationProjectGrant[]
  createdAt: number
  updatedAt: number
}

export interface OrganizationActorRef {
  kind: OrganizationActorKind
  id: string
}

export interface OrganizationMessage {
  id: string
  companyId: string
  projectId: string
  kind: OrganizationMessageKind
  category?: OrganizationMessageCategory
  taskId?: string
  replyToId?: string
  author: OrganizationActorRef
  body: string
  mentionActorIds: string[]
  runId?: string
  createdAt: number
  updatedAt: number
}

export interface OrganizationDecision {
  id: string
  companyId: string
  projectId: string
  taskId?: string
  title: string
  summary: string
  rationale: string
  status: OrganizationDecisionStatus
  createdBy: OrganizationActorRef
  supersedesDecisionId?: string
  createdAt: number
  updatedAt: number
}

export interface OrganizationApprovalRequest {
  id: string
  companyId: string
  projectId: string
  taskId?: string
  targetKind: OrganizationApprovalTargetKind
  targetId: string
  targetRevision?: string
  requestedBy: OrganizationActorRef
  requiredApproverKind: 'human'
  status: OrganizationApprovalStatus
  createdAt: number
  resolvedAt?: number
}

export interface OrganizationApprovalVerdict {
  id: string
  requestId: string
  actor: OrganizationActorRef
  verdict: OrganizationApprovalVerdictKind
  comment?: string
  createdAt: number
}

/** Recorded only by ND's trusted machine-verification gate, never worker text. */
export interface OrganizationRunVerification {
  status: 'passed' | 'failed' | 'skipped'
  command?: string
  cwd?: string
  checkpointCommit?: string
  exitCode?: number
  reason?: string
  completedAt: number
}

export interface OrganizationRun {
  id: string
  companyId: string
  projectId: string
  taskId?: string
  goalId?: string
  kind: OrganizationRunKind
  status: OrganizationRunStatus
  sessionId: string
  /** Engine/workspace provenance belongs to ND, not to the vendor session store. */
  engineId?: string
  workspaceKind?: OrganizationWorkspaceKind
  workspaceRoot?: string
  workspaceBranch?: string
  baselineCommit?: string
  checkpointCommit?: string
  verification?: OrganizationRunVerification
  runtimePermitId?: string
  output?: string
  error?: string
  startedAt: number
  completedAt?: number
}

export interface OrganizationSnapshot {
  version: 1
  activeCompanyId?: string
  activeProjectId?: string
  companies: Company[]
  projects: Project[]
  roles: OrganizationRole[]
  teams: Team[]
  agents: OrganizationAgent[]
  skills: OrganizationSkill[]
  workflows: OrganizationWorkflow[]
  goals: OrganizationGoal[]
  milestones: Milestone[]
  tasks: OrganizationTask[]
  memory: MemoryEntry[]
  policies: OrganizationPolicy[]
  activity: OrganizationActivity[]
  runs: OrganizationRun[]
  /** Local human identities for attribution. These are not remote authentication principals. */
  members?: OrganizationMember[]
  /** Durable human-grade project/task/review collaboration. */
  messages?: OrganizationMessage[]
  decisions?: OrganizationDecision[]
  approvalRequests?: OrganizationApprovalRequest[]
  approvalVerdicts?: OrganizationApprovalVerdict[]
  /** Structured machine-oriented team/task handoffs. Missing in older v1 snapshots and normalized to []. */
  coordination: OrganizationTeamEvent[]
}

export interface ProjectPlanInput {
  goal: { title: string; description: string }
  milestones: Array<{
    title: string
    description: string
    tasks: Array<{
      title: string
      description: string
      priority?: TaskPriority
      acceptanceCriteria?: string[]
      dependsOn?: string[]
      role?: string
      workScopes?: string[]
      evidenceKind?: TaskEvidenceKind
      artifactPaths?: string[]
    }>
  }>
  memory?: Array<{ title: string; content: string; tags?: string[] }>
}

export type OrganizationMutation =
  | { type: 'company.create'; name: string; mission: string }
  | { type: 'company.update'; id: string; patch: Partial<Pick<Company, 'name' | 'mission' | 'autonomyLevel' | 'subagentMode' | 'status'>> }
  | { type: 'company.activate'; id: string }
  /**
   * Forget a company inside ND: the company and every record ND owns for it
   * (projects, goals, milestones, tasks, run receipts, memory, skills,
   * workflows, roles, teams, agents, policies, coordination) are dropped.
   * Workspace folders on disk are never touched.
   */
  | { type: 'company.remove'; id: string }
  | { type: 'project.create'; companyId: string; name: string; objective: string; workspacePath?: string; repoUrls?: string[]; startCommand?: string; testCommand?: string; targetPort?: number; targetUrl?: string; healthCheckPath?: string }
  | { type: 'project.update'; id: string; patch: Partial<Pick<Project, 'name' | 'objective' | 'status' | 'workspacePath' | 'repoUrls' | 'teamIds' | 'startCommand' | 'testCommand' | 'targetPort' | 'targetUrl' | 'healthCheckPath' | 'deliveryMilestoneId'>> }
  | { type: 'project.activate'; id: string }
  /**
   * Forget a project inside ND: the project and the records ND owns for it
   * (goals, milestones, tasks, run receipts, project-scoped memory, skills and
   * workflows) are dropped. The folder on disk is never touched, so the source
   * tree stays exactly as it is and the folder can be imported again later.
   */
  | { type: 'project.remove'; id: string }
  | { type: 'team.create'; companyId: string; name: string; purpose: string; roleIds?: string[]; skillIds?: string[] }
  | { type: 'member.create'; companyId: string; displayName: string; title?: string; accessRole?: OrganizationAccessRole; capabilities?: OrganizationCapability[]; projectGrants?: OrganizationProjectGrant[] }
  | { type: 'member.update'; id: string; patch: Partial<Pick<OrganizationMember, 'displayName' | 'title' | 'status' | 'accessRole' | 'capabilities' | 'projectGrants'>> }
  | { type: 'role.create'; companyId: string; name: string; responsibility: string; systemPrompt: string; skillIds?: string[]; providerId?: string; modelId?: string }
  | { type: 'role.update'; id: string; patch: Partial<Pick<OrganizationRole, 'name' | 'responsibility' | 'systemPrompt' | 'skillIds' | 'providerId' | 'modelId'>> }
  | { type: 'agent.create'; companyId: string; name: string; roleId: string; teamId?: string; skillIds?: string[]; providerId?: string; modelId?: string }
  | { type: 'agent.update'; id: string; patch: Partial<Pick<OrganizationAgent, 'name' | 'roleId' | 'teamId' | 'status' | 'skillIds' | 'providerId' | 'modelId'>> }
  | { type: 'skill.create'; scope: Exclude<OrganizationScope, 'builtin'>; name: string; description: string; instructions: string; companyId?: string; projectId?: string; teamId?: string; roleId?: string; agentId?: string }
  | { type: 'workflow.create'; companyId: string; projectId?: string; name: string; steps: WorkflowStep[] }
  | { type: 'goal.create'; companyId: string; projectId: string; title: string; description: string }
  | { type: 'milestone.create'; projectId: string; title: string; description: string; goalId?: string }
  | { type: 'task.create'; companyId: string; projectId: string; goalId?: string; milestoneId?: string; title: string; description: string; acceptanceCriteria?: string[]; priority?: TaskPriority; dependsOn?: string[]; assigneeKind?: TaskAssigneeKind; assignedAgentId?: string; assignedMemberId?: string; collaboratorIds?: string[]; accountableMemberId?: string; reviewerKind?: TaskAssigneeKind; reviewerAgentId?: string; reviewerMemberId?: string; workScopes?: string[]; evidenceKind?: TaskEvidenceKind; artifactPaths?: string[]; sourceScheduleId?: string; sourceTriggerId?: string; sourceActivityId?: string; requestedSkillIds?: string[] }
  | { type: 'task.update'; id: string; patch: Partial<Pick<OrganizationTask, 'title' | 'description' | 'acceptanceCriteria' | 'priority' | 'status' | 'dependsOn' | 'assigneeKind' | 'assignedAgentId' | 'assignedMemberId' | 'collaboratorIds' | 'accountableMemberId' | 'reviewerKind' | 'reviewerAgentId' | 'reviewerMemberId' | 'workScopes' | 'evidenceKind' | 'artifactPaths' | 'milestoneId' | 'requestedSkillIds' | 'resultSummary'>> }
  | { type: 'task.reorder'; projectId: string; milestoneId?: string; taskIds: string[] }
  | { type: 'task.reassign'; taskId: string; assignee: { kind: TaskAssigneeKind; id: string }; changedByMemberId?: string; reason: string }
  | { type: 'task.submitWork'; taskId: string; memberId: string; summary: string; artifactPaths?: string[]; checkpointCommit?: string }
  | { type: 'collaboration.message.add'; companyId: string; projectId: string; authorMemberId?: string; authorAgentId?: string; author?: OrganizationActorRef; body: string; taskId?: string; replyToId?: string; mentionActorIds?: string[]; kind?: OrganizationMessageKind; category?: OrganizationMessageCategory; runId?: string }
  | { type: 'decision.create'; companyId: string; projectId: string; authorMemberId: string; title: string; summary: string; rationale: string; taskId?: string }
  | { type: 'decision.supersede'; id: string; authorMemberId: string; title: string; summary: string; rationale: string }
  | { type: 'approval.request'; companyId: string; projectId: string; requesterMemberId: string; targetKind: OrganizationApprovalTargetKind; targetId: string; taskId?: string; targetRevision?: string }
  | { type: 'approval.resolve'; id: string; actorMemberId: string; verdict: OrganizationApprovalVerdictKind; comment?: string }
  | { type: 'memory.add'; companyId: string; projectId?: string; title: string; content: string; tags?: string[] }
  | { type: 'policy.set'; companyId: string; action: string; effect: OrganizationPolicyEffect; description?: string }

export interface OrganizationRunReceipt {
  runId: string
  sessionId: string
  projectId: string
  taskId?: string
  kind: OrganizationRunKind
  engineId?: string
  workspaceKind?: OrganizationWorkspaceKind
  workspaceRoot?: string
  workspaceBranch?: string
  baselineCommit?: string
  checkpointCommit?: string
  runtimePermitId?: string
}

export interface OrganizationDesktopApi {
  state(): Promise<OrganizationSnapshot>
  mutate(mutation: OrganizationMutation): Promise<OrganizationSnapshot>
  planProject(projectId: string): Promise<OrganizationRunReceipt>
  runTask(taskId: string): Promise<OrganizationRunReceipt>
  reviewTask(taskId: string): Promise<OrganizationRunReceipt>
  runNext(projectId?: string): Promise<OrganizationRunReceipt | null>
  cancelRun(runId: string): Promise<void>
  onChanged(listener: (state: OrganizationSnapshot) => void): () => void
  projectRuntime(projectId: string): Promise<ProjectRuntimeStatus>
  startProjectRuntime(projectId: string): Promise<ProjectRuntimeStatus>
  stopProjectRuntime(projectId: string): Promise<ProjectRuntimeStatus>
  onRuntimeChanged(listener: (status: ProjectRuntimeStatus) => void): () => void
}

export const ORGANIZATION_IPC = {
  state: 'organization:state',
  mutate: 'organization:mutate',
  planProject: 'organization:plan-project',
  runTask: 'organization:run-task',
  reviewTask: 'organization:review-task',
  runNext: 'organization:run-next',
  cancelRun: 'organization:cancel-run',
  changed: 'organization:changed',
  runtimeState: 'organization:runtime-state',
  runtimeStart: 'organization:runtime-start',
  runtimeStop: 'organization:runtime-stop',
  runtimeChanged: 'organization:runtime-changed',
} as const
