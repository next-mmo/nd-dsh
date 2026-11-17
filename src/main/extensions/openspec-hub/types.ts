export interface ProjectConfig {
  id: string
  name: string
  path: string
  store?: string
  watch?: boolean
}

export interface HubConfig {
  projects: ProjectConfig[]
}

export type ChangeStage =
  | 'draft'
  | 'ready-for-review'
  | 'in-implementation'
  | 'ready-to-archive'
  | 'archived'

export interface ArtifactStatus {
  id: string
  status: string
}

export interface Scenario {
  name: string
  rawText: string
}

export interface Requirement {
  name: string
  text: string
  scenarios: Scenario[]
}

export interface SpecDetail {
  id: string
  overview: string
  requirementCount: number
  scenarioCount: number
  requirements: Requirement[]
  markdown: string
  modifiedBy: string[]
}

export interface ChangeSummary {
  id: string
  archived: boolean
  stage: ChangeStage
  artifacts: ArtifactStatus[]
  artifactsDone: number
  artifactTotal: number
  completedTasks: number
  totalTasks: number
  taskPercent: number
  lastModified: string | null
  capabilities: string[]
}

export interface TaskItem {
  text: string
  done: boolean
  section: string
}

export interface ChangeDelta {
  spec: string
  operation: string
  requirements: Requirement[]
}

export interface DeltaFile {
  path: string
  markdown: string
}

export interface ChangeDetail {
  id: string
  summary: ChangeSummary
  proposal: string | null
  design: string | null
  tasksMarkdown: string | null
  tasks: TaskItem[]
  deltas: ChangeDelta[]
  deltaFiles: DeltaFile[]
}

export interface ValidationIssue {
  level: string
  path: string
  message: string
}

export interface ValidationItem {
  id: string
  type: string
  valid: boolean
  issues: ValidationIssue[]
}

export interface ValidationReport {
  status: 'PASS' | 'FAIL' | 'UNAVAILABLE'
  items: ValidationItem[]
  totals: { items: number; passed: number; failed: number }
  error?: string
}

export interface DoctorReport {
  available: boolean
  healthy: boolean
  messages: string[]
}

export type DocKind =
  | 'prd'
  | 'brd'
  | 'checklist'
  | 'architecture'
  | 'api'
  | 'roadmap'
  | 'adr'
  | 'readme'
  | 'agents'

export interface DocMeta {
  id: string
  title: string
  kind: DocKind
  relPath: string
}

export interface ChecklistItem {
  text: string
  done: boolean
  section: string
}

export interface ProjectTotals {
  specs: number
  requirements: number
  scenarios: number
  activeChanges: number
  archivedChanges: number
  taskPercent: number
}

export interface ProjectSnapshot {
  id: string
  name: string
  available: boolean
  error?: string
  updatedAt: string
  schema: string | null
  store?: string
  specs: SpecDetail[]
  changes: ChangeSummary[]
  validation: ValidationReport
  doctor: DoctorReport
  docs: DocMeta[]
  totals: ProjectTotals
}

export interface PortfolioCard {
  id: string
  name: string
  available: boolean
  error?: string
  updatedAt: string
  schema: string | null
  totals: ProjectTotals
  validationStatus: ValidationReport['status']
  doctorHealthy: boolean
  stageCounts: Record<ChangeStage, number>
}

export type TicketStatus = 'open' | 'in-progress' | 'done'
export type TicketPriority = 'low' | 'medium' | 'high'

export interface Ticket {
  id: string
  projectId: string
  title: string
  description: string
  status: TicketStatus
  priority: TicketPriority
  linkedChangeId?: string
  createdAt: string
  updatedAt: string
}

export interface TicketInput {
  title: string
  description?: string
  status?: TicketStatus
  priority?: TicketPriority
  linkedChangeId?: string
}

export interface RouterConfig {
  /** Loopback origin of the ND Router gateway, without /v1. */
  baseUrl: string
  /** Stable external credential (ndr_ext_…). Server-side only; never sent to clients. */
  apiKey: string
  model?: string
}

export interface AssistantOptions {
  router?: RouterConfig
  /** Discovered endpoint even when the key is missing, for honest setup hints. */
  routerEndpoint?: string
  writesEnabled: boolean
  dataDir: string
}

export type ActionPayload =
  | {
      kind: 'edit-doc'
      projectId: string
      docId: string
      mode: 'append' | 'replace' | 'replace-section'
      section?: string
      content: string
    }
  | { kind: 'toggle-checklist'; projectId: string; docId: string; itemText: string; done: boolean }
  | { kind: 'toggle-task'; projectId: string; changeId: string; taskText: string; done: boolean }
  | {
      kind: 'create-ticket'
      projectId: string
      title: string
      description?: string
      priority?: TicketPriority
      linkedChangeId?: string
    }
  | {
      kind: 'update-ticket'
      projectId: string
      ticketId: string
      title?: string
      description?: string
      status?: TicketStatus
      priority?: TicketPriority
      linkedChangeId?: string | null
    }

export interface DiffLine {
  type: 'ctx' | 'add' | 'del'
  text: string
}

export interface ActionPreview {
  target: string
  summary: string
  before?: string
  after?: string
  diff?: DiffLine[]
}

export type ActionStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'failed'

export interface PendingAction {
  id: string
  payload: ActionPayload
  preview: ActionPreview
  createdAt: number
  expiresAt: number
  status: ActionStatus
  result?: string
}

export interface RouterChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type AssistantEvent =
  | { type: 'delta'; text: string }
  | { type: 'read'; target: string; ok: boolean }
  | { type: 'action'; action: PendingAction }
  | { type: 'action-error'; message: string }
  | { type: 'done'; text: string; model: string; rounds: number }
  | { type: 'error'; message: string; code: string }

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}