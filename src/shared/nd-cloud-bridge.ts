import type { OrganizationSnapshot, TaskPriority, TaskStatus } from './organization.js'

/**
 * Experimental, read-only ND Cloud export contract.
 *
 * This module has no network access and grants no cloud permissions.
 * Trusted host code must obtain explicit opt-in and recheck membership before
 * invoking any sender. Cloud claims and local member attribution are NOT auth.
 */
export const ND_CLOUD_BRIDGE_VERSION = 1 as const

export interface NdCloudProjectBinding {
  schemaVersion: 1
  enabled: boolean
  tenantId: string
  cloudProjectId: string
  localCompanyId: string
  localProjectId: string
  capabilities: readonly 'kanban.read'[]
}

export interface NdCloudTaskSummary {
  id: string
  title: string
  status: TaskStatus
  priority: TaskPriority
  updatedAt: number
}

export interface NdCloudKanbanProjection {
  schema_version: 1
  source_system: 'nd-dsh'
  tenant_id: string
  cloud_project_id: string
  local_project_id: string
  generated_at: number
  tasks: NdCloudTaskSummary[]
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function safeId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

export function isValidNdCloudReadBinding(value: unknown): value is NdCloudProjectBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const binding = value as Record<string, unknown>
  return binding.schemaVersion === ND_CLOUD_BRIDGE_VERSION
    && binding.enabled === true
    && safeId(binding.tenantId)
    && safeId(binding.cloudProjectId)
    && safeId(binding.localCompanyId)
    && safeId(binding.localProjectId)
    && Array.isArray(binding.capabilities)
    && binding.capabilities.length === 1
    && binding.capabilities[0] === 'kanban.read'
}

/**
 * Export only explicitly bound project task summaries. No run output,
 * comments, approval records, user identities, paths, tokens or memory.
 * Null means an unauthorized/invalid/nonexistent binding, never an empty
 * successful sync. The caller must independently enforce authenticated scope.
 */
export function buildNdCloudKanbanProjection(
  snapshot: OrganizationSnapshot,
  binding: unknown,
  generatedAt: number,
): NdCloudKanbanProjection | null {
  if (!isValidNdCloudReadBinding(binding) || !Number.isSafeInteger(generatedAt) || generatedAt < 0) return null
  const project = snapshot.projects.find(
    (item) => item.id === binding.localProjectId && item.companyId === binding.localCompanyId,
  )
  const company = snapshot.companies.find((item) => item.id === binding.localCompanyId)
  if (!project || !company) return null

  const tasks = snapshot.tasks
    .filter((task) => task.projectId === project.id && task.companyId === company.id)
    .map((task): NdCloudTaskSummary => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      updatedAt: task.updatedAt,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))

  return {
    schema_version: ND_CLOUD_BRIDGE_VERSION,
    source_system: 'nd-dsh',
    tenant_id: binding.tenantId,
    cloud_project_id: binding.cloudProjectId,
    local_project_id: binding.localProjectId,
    generated_at: generatedAt,
    tasks,
  }
}

/**
 * Cloud-origin commands are intentionally unsupported in this pilot.
 * A read-only projection must never become an alternative mutation path.
 */
export function canNdCloudDispatchLocalCommand(_value: unknown): false {
  return false
}

/**
 * Wire-compatible with the loopback-only Go pilot's PUT
 * /v1/projects/{project}/board endpoint.
 *
 * Pure data conversion. Only a trusted main-process host with a separately
 * enrolled, revocable host credential may transmit it. Never place that
 * credential in the renderer, a project file or a URL.
 */
export interface NdCloudBoardSubmission {
  schema_version: 1
  source_system: 'nd-dsh'
  tenant_id: string
  cloud_project_id: string
  local_company_id: string
  local_project_id: string
  revision: number
  tasks: Array<{
    id: string
    title: string
    status: TaskStatus
    priority: TaskPriority
    updated_at: number
  }>
}

export function buildNdCloudBoardSubmission(
  snapshot: OrganizationSnapshot,
  binding: unknown,
  revision: number,
): NdCloudBoardSubmission | null {
  if (!isValidNdCloudReadBinding(binding) || !Number.isSafeInteger(revision) || revision < 1) return null
  const projection = buildNdCloudKanbanProjection(snapshot, binding, 0)
  if (!projection || projection.tasks.length > 500) return null
  const ids = new Set<string>()
  const encoder = new TextEncoder()
  for (const task of projection.tasks) {
    if (!safeId(task.id) || !task.title.trim() || encoder.encode(task.title).length > 250 ||
      !Number.isSafeInteger(task.updatedAt) || task.updatedAt < 0 || ids.has(task.id)) return null
    ids.add(task.id)
  }
  return {
    schema_version: ND_CLOUD_BRIDGE_VERSION,
    source_system: 'nd-dsh',
    tenant_id: binding.tenantId,
    cloud_project_id: binding.cloudProjectId,
    local_company_id: binding.localCompanyId,
    local_project_id: binding.localProjectId,
    revision,
    tasks: projection.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      updated_at: task.updatedAt,
    })),
  }
}
