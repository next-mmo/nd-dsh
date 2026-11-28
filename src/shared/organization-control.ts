import type { ComputeManagementProjection } from './compute-budget.js'
import type { OrganizationDiffRiskAssessment } from './diff-risk.js'
import type { OrganizationRunKind } from './organization.js'

export type OrganizationTurnRoute =
  | 'ready'
  | 'repair_required'
  | 'replan_required'
  | 'human_action_required'
  | 'wait'
  | 'blocked'
  | 'contract_error'

export type OrganizationTurnResultKind =
  | 'validated_progress'
  | 'validated_completion'
  | 'repair_required'
  | 'replan_required'
  | 'human_action_required'
  | 'wait'
  | 'engine_failure'
  | 'validation_failed'
  | 'writeback_failed'
  | 'budget_failed'

export type OrganizationControlAction = 'internal.plan' | 'task.execute' | 'task.review' | 'workflow.continue'
export type HumanActionKind = 'action' | 'gate'
export type HumanActionStatus = 'open' | 'resolved' | 'dismissed'
export type SignalStatus = 'new' | 'triaged' | 'archived'
export type SignalDisposition = 'ignore' | 'ask-human' | 'evidence' | 'task' | 'objective'
export type EvidenceStatus = 'pending_review' | 'verified' | 'failed' | 'stale'
export type EvidenceSource = 'git' | 'workspace-unavailable'
export type LeaseStatus = 'active' | 'released' | 'expired'
export type ReviewFeedbackLabel = 'useful' | 'not_useful' | 'needs_evidence' | 'off_scope' | 'too_expensive' | 'unsafe'

export interface OrganizationTurnDecision {
  route: OrganizationTurnRoute
  action: OrganizationControlAction
  companyId: string
  projectId: string
  taskId?: string
  reason: string
  humanActionIds: string[]
  budgetId?: string
  checkedAt: number
}

export interface OrganizationTurnRecord extends OrganizationTurnDecision {
  id: string
  runId?: string
  sessionId?: string
  result?: OrganizationTurnResultKind
  startedAt: number
  completedAt?: number
}

export interface OrganizationHumanAction {
  id: string
  companyId: string
  projectId?: string
  kind: HumanActionKind
  title: string
  question: string
  scopes: string[]
  boundAgentId?: string
  status: HumanActionStatus
  createdAt: number
  resolvedAt?: number
  resolution?: string
}

export interface OrganizationSignal {
  id: string
  companyId: string
  projectId?: string
  source: string
  title: string
  summary: string
  status: SignalStatus
  disposition?: SignalDisposition | undefined
  confidence?: number
  createdAt: number
  updatedAt: number
}

export interface OrganizationBudget {
  id: string
  companyId: string
  projectId?: string
  dailyTurnLimit?: number
  dailyCostUsd?: number
  monthlyCostUsd?: number
  maxParallelWorkers?: number
  maxReviewWorkers?: number
  roleWorkerLimits?: Record<string, number>
  teamWorkerLimits?: Record<string, number>
  spentTurns: number
  spentCostUsd: number
  spentMonthlyCostUsd: number
  cashAccountingKnown: boolean
  windowStartedAt: number
  monthlyWindowStartedAt: number
  updatedAt: number
}

export interface OrganizationTaskLease {
  id: string
  companyId: string
  projectId: string
  taskId: string
  ownerId: string
  writeScopes: string[]
  status: LeaseStatus
  version: number
  acquiredAt: number
  expiresAt: number
  releasedAt?: number
}

export interface OrganizationEvidenceReceipt {
  id: string
  companyId: string
  projectId: string
  taskId: string
  fingerprint: string
  exact: boolean
  source: EvidenceSource
  changedFiles: string[]
  gitHead?: string
  status: EvidenceStatus
  capturedAt: number
  reviewerRunId?: string
  reviewSummary?: string
  risk?: OrganizationDiffRiskAssessment
  invalidatedAt?: number
}

export interface OrganizationReviewFeedback {
  id: string
  companyId: string
  projectId?: string
  taskId?: string
  runId?: string
  agentId?: string
  label: ReviewFeedbackLabel
  note?: string
  createdAt: number
}

export interface OrganizationControlSnapshot {
  version: 1
  turns: OrganizationTurnRecord[]
  humanActions: OrganizationHumanAction[]
  signals: OrganizationSignal[]
  budgets: OrganizationBudget[]
  leases: OrganizationTaskLease[]
  evidence: OrganizationEvidenceReceipt[]
  feedback: OrganizationReviewFeedback[]
}

export interface OrganizationManagementAttentionItem {
  id: string
  kind: 'gate' | 'action' | 'failed-run' | 'stale-evidence'
  companyId: string
  projectId?: string
  taskId?: string
  /** Set for `failed-run` items so the human can retry the same kind of run. */
  runKind?: OrganizationRunKind
  title: string
  detail: string
  createdAt: number
}

export interface OrganizationAgentPerformance {
  agentId: string
  completedTasks: number
  failedOrBlockedTasks: number
  reviewPassRate: number | null
  turns: number
  humanAttentionEvents: number
}

export interface OrganizationManagementProjection {
  generatedAt: number
  companyId?: string
  projectId?: string
  needsYou: OrganizationManagementAttentionItem[]
  runningRunIds: string[]
  readyToReviewTaskIds: string[]
  newSignalIds: string[]
  verifiedTaskIds: string[]
  staleEvidenceTaskIds: string[]
  budgets: OrganizationBudget[]
  performance: OrganizationAgentPerformance[]
  compute?: ComputeManagementProjection
  metrics: {
    completedTasks: number
    verifiedTasks: number
    blockedTasks: number
    runningRuns: number
    openHumanActions: number
    newSignals: number
    humanAttentionEvents: number
  }
}

export type OrganizationControlMutation =
  | { type: 'human-action.add'; companyId: string; projectId?: string; kind: HumanActionKind; title: string; question: string; scopes?: string[]; boundAgentId?: string }
  | { type: 'human-action.resolve'; id: string; resolution: string; dismiss?: boolean }
  | { type: 'signal.add'; companyId: string; projectId?: string; source: string; title: string; summary: string; confidence?: number }
  | { type: 'signal.triage'; id: string; disposition: SignalDisposition; archive?: boolean }
  | { type: 'budget.set'; companyId: string; projectId?: string; dailyTurnLimit?: number; dailyCostUsd?: number; monthlyCostUsd?: number; maxParallelWorkers?: number; maxReviewWorkers?: number; roleWorkerLimits?: Record<string, number>; teamWorkerLimits?: Record<string, number> }
  | { type: 'feedback.add'; companyId: string; projectId?: string; taskId?: string; runId?: string; agentId?: string; label: ReviewFeedbackLabel; note?: string }

export interface OrganizationControlDesktopApi {
  state(): Promise<OrganizationControlSnapshot>
  mutate(mutation: OrganizationControlMutation): Promise<OrganizationControlSnapshot>
  management(projectId?: string): Promise<OrganizationManagementProjection>
  shouldRun(projectId: string | undefined, action: OrganizationControlAction, taskId?: string): Promise<OrganizationTurnDecision>
  verifyEvidence(taskId: string): Promise<OrganizationEvidenceReceipt | null>
  onChanged(listener: (state: OrganizationControlSnapshot) => void): () => void
}

export const ORGANIZATION_CONTROL_IPC = {
  state: 'organization-control:state',
  mutate: 'organization-control:mutate',
  management: 'organization-control:management',
  shouldRun: 'organization-control:should-run',
  verifyEvidence: 'organization-control:verify-evidence',
  changed: 'organization-control:changed',
} as const
