import { describe, expect, it } from 'vitest'
import { buildNdCloudBoardSubmission, buildNdCloudKanbanProjection, canNdCloudDispatchLocalCommand, isValidNdCloudReadBinding } from '../src/shared/nd-cloud-bridge.js'
import type { OrganizationSnapshot } from '../src/shared/organization.js'

const binding = {
  schemaVersion: 1,
  enabled: true,
  tenantId: 'tenant-a',
  cloudProjectId: 'cloud-project-a',
  localCompanyId: 'company-a',
  localProjectId: 'project-a',
  capabilities: ['kanban.read'],
} as const

const snapshot = {
  version: 1,
  companies: [{ id: 'company-a' }, { id: 'company-b' }],
  projects: [
    { id: 'project-a', companyId: 'company-a' },
    { id: 'project-b', companyId: 'company-a' },
    { id: 'project-c', companyId: 'company-b' },
  ],
  tasks: [
    { id: 'task-a', companyId: 'company-a', projectId: 'project-a', title: 'Ship A', status: 'ready', priority: 'high', updatedAt: 3, description: 'PRIVATE', artifactPaths: ['/secret'], executionSessionId: 'session-secret' },
    { id: 'task-b', companyId: 'company-a', projectId: 'project-b', title: 'Other Project', status: 'completed', priority: 'low', updatedAt: 1 },
    { id: 'task-c', companyId: 'company-b', projectId: 'project-c', title: 'Other Company', status: 'in_progress', priority: 'critical', updatedAt: 2 },
    { id: 'task-inconsistent', companyId: 'company-b', projectId: 'project-a', title: 'Malformed Foreign Task', status: 'ready', priority: 'high', updatedAt: 2 },
  ],
} as unknown as OrganizationSnapshot

describe('ND Cloud gated read-only projection', () => {
  it('exports exactly one opted-in project', () => {
    const result = buildNdCloudKanbanProjection(snapshot, binding, 42)
    expect(result).toEqual({
      schema_version: 1,
      source_system: 'nd-dsh',
      tenant_id: 'tenant-a',
      cloud_project_id: 'cloud-project-a',
      local_project_id: 'project-a',
      generated_at: 42,
      tasks: [{ id: 'task-a', title: 'Ship A', status: 'ready', priority: 'high', updatedAt: 3 }],
    })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|secret|Other Project|Other Company|Malformed/)
  })

  it('rejects disabled binding, unknown project, and wrong company/project pair', () => {
    expect(buildNdCloudKanbanProjection(snapshot, { ...binding, enabled: false }, 42)).toBeNull()
    expect(buildNdCloudKanbanProjection(snapshot, { ...binding, localProjectId: 'unknown' }, 42)).toBeNull()
    expect(buildNdCloudKanbanProjection(snapshot, { ...binding, localCompanyId: 'company-b' }, 42)).toBeNull()
  })

  it('rejects unsupported versions, capabilities, arbitrary object claims and invalid IDs', () => {
    expect(isValidNdCloudReadBinding(binding)).toBe(true)
    expect(isValidNdCloudReadBinding({ ...binding, schemaVersion: 2 })).toBe(false)
    expect(isValidNdCloudReadBinding({ ...binding, capabilities: ['kanban.read', 'task.write'] })).toBe(false)
    expect(isValidNdCloudReadBinding({ ...binding, capabilities: ['task.write'] })).toBe(false)
    expect(isValidNdCloudReadBinding({ ...binding, tenantId: '../other' })).toBe(false)
    expect(isValidNdCloudReadBinding({ ...binding, tenantId: '' })).toBe(false)
    expect(isValidNdCloudReadBinding(null)).toBe(false)
  })

  it('rejects bad generation timestamps', () => {
    for (const t of [-1, NaN, Infinity, 0.1]) expect(buildNdCloudKanbanProjection(snapshot, binding, t)).toBeNull()
  })

  it('never accepts cloud-initiated task execution or approval', () => {
    expect(canNdCloudDispatchLocalCommand({ type: 'task.execute', projectId: 'project-a' })).toBe(false)
    expect(canNdCloudDispatchLocalCommand({ type: 'approval.resolve', verdict: 'approve' })).toBe(false)
  })
})

describe('ND Cloud Go pilot request contract', () => {
  it('serializes a minimal host-only board submission with explicit revision', () => {
    expect(buildNdCloudBoardSubmission(snapshot, binding, 7)).toEqual({
      schema_version: 1,
      source_system: 'nd-dsh',
      tenant_id: 'tenant-a',
      cloud_project_id: 'cloud-project-a',
      local_company_id: 'company-a',
      local_project_id: 'project-a',
      revision: 7,
      tasks: [{ id: 'task-a', title: 'Ship A', status: 'ready', priority: 'high', updated_at: 3 }],
    })
    expect(JSON.stringify(buildNdCloudBoardSubmission(snapshot, binding, 7))).not.toMatch(/PRIVATE|secret|Other Project|Other Company/)
  })

  it('rejects absent host opt-in, invalid revisions and oversized boards', () => {
    expect(buildNdCloudBoardSubmission(snapshot, { ...binding, enabled: false }, 1)).toBeNull()
    for (const revision of [0, -1, NaN, Infinity, 0.4]) {
      expect(buildNdCloudBoardSubmission(snapshot, binding, revision)).toBeNull()
    }
    const oversized = {
      ...snapshot,
      tasks: Array.from({ length: 501 }, (_, i) => ({
        id: 't-' + i, companyId: 'company-a', projectId: 'project-a',
        title: 'Task ' + i, status: 'ready', priority: 'low', updatedAt: i,
      })),
    } as unknown as OrganizationSnapshot
    expect(buildNdCloudBoardSubmission(oversized, binding, 1)).toBeNull()
  })
})
