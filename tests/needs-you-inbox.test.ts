import { describe, expect, it } from 'vitest'
import type { OrganizationSnapshot } from '../src/shared/organization.js'
import {
  formatRelativeAge,
  groupNeedsYouItems,
  orgAttentionToNeedsYou,
  presentNeedsYouItem,
  selectNextNeedsYouId,
  type NeedsYouItem,
} from '../src/renderer/src/lib/needs-you-inbox.js'

function sampleOrganization(): OrganizationSnapshot {
  const now = 1_700_000_000_000
  return {
    version: 1,
    activeCompanyId: 'co-1',
    activeProjectId: 'proj-1',
    companies: [{ id: 'co-1', name: 'Acme', mission: 'Build', autonomyLevel: 3, status: 'active', createdAt: now, updatedAt: now }],
    projects: [
      { id: 'proj-1', companyId: 'co-1', name: 'Web App', objective: 'Ship', workspacePath: '/repo/web', status: 'active', repoUrls: [], teamIds: [], progress: 0, createdAt: now, updatedAt: now },
      { id: 'proj-2', companyId: 'co-1', name: 'API', objective: 'Serve', workspacePath: '/repo/api', status: 'active', repoUrls: [], teamIds: [], progress: 0, createdAt: now, updatedAt: now },
    ],
    roles: [],
    teams: [],
    agents: [
      { id: 'ag-1', companyId: 'co-1', name: 'Builder', roleId: 'role-1', status: 'working', skillIds: [] },
      { id: 'ag-2', companyId: 'co-1', name: 'Reviewer', roleId: 'role-2', status: 'idle', skillIds: [] },
    ],
    skills: [],
    workflows: [],
    goals: [],
    milestones: [],
    tasks: [
      { id: 'task-1', companyId: 'co-1', projectId: 'proj-1', title: 'Fix login', description: 'Fix', status: 'review', priority: 'high', acceptanceCriteria: [], dependsOn: [], assignedAgentId: 'ag-1', reviewerAgentId: 'ag-2', createdAt: now, updatedAt: now },
    ],
    memory: [],
    policies: [],
    activity: [],
    runs: [
      { id: 'run-1', companyId: 'co-1', projectId: 'proj-1', taskId: 'task-1', kind: 'task-execution', status: 'running', sessionId: 'sess-1', startedAt: now },
    ],
    coordination: [],
  }
}

describe('unified Needs You inbox model', () => {
  it('merges live runtime approvals/questions with organization attention items and groups cleanly', () => {
    const org = sampleOrganization()
    const orgItems = orgAttentionToNeedsYou([
      {
        id: 'gate-1',
        kind: 'gate',
        companyId: 'co-1',
        projectId: 'proj-2',
        title: 'Approve prod deploy',
        detail: 'Confirm release tag v1.2',
        createdAt: 1000,
      },
      {
        id: 'ev-1',
        kind: 'stale-evidence',
        companyId: 'co-1',
        projectId: 'proj-1',
        taskId: 'task-1',
        title: 'Verification evidence is stale',
        detail: 'Worktree changed after review.',
        createdAt: 2000,
      },
    ])

    const items: NeedsYouItem[] = [
      {
        kind: 'approval',
        id: 'approval:rpc-1',
        sessionId: 'sess-1',
        rpcId: 'rpc-1',
        approvalId: 'apr-1',
        toolName: 'bash',
        reason: 'Run migration script',
        createdAt: 3000,
      },
      ...orgItems,
    ]

    const newest = groupNeedsYouItems(items, org, 'newest')
    expect(newest).toHaveLength(1)
    expect(newest[0]!.items.map((entry) => entry.item.id)).toEqual([
      'approval:rpc-1',
      'org:stale-evidence:ev-1',
      'org:gate:gate-1',
    ])

    const byProject = groupNeedsYouItems(items, org, 'project')
    expect(byProject.map((group) => group.label)).toEqual(['Web App', 'API'])
    expect(byProject[0]!.items).toHaveLength(2)

    const byAgent = groupNeedsYouItems(items, org, 'agent')
    expect(byAgent.map((group) => group.label)).toEqual(['Builder', 'Acme'])
  })

  it('resolves session jump targets for task-linked organization items', () => {
    const org = sampleOrganization()
    const [stale] = orgAttentionToNeedsYou([
      {
        id: 'ev-1',
        kind: 'stale-evidence',
        companyId: 'co-1',
        projectId: 'proj-1',
        taskId: 'task-1',
        title: 'Verification evidence is stale',
        detail: 'Re-check fingerprint.',
        createdAt: 5000,
      },
    ])
    const presented = presentNeedsYouItem(stale!, org)
    expect(presented.badge).toBe('STALE')
    expect(presented.agentName).toBe('Builder')
    expect(presented.projectName).toBe('Web App')
    expect(presented.sessionId).toBe('sess-1')
  })

  it('keeps selection stable when present and advances cleanly when resolved', () => {
    const items: NeedsYouItem[] = [
      { kind: 'approval', id: 'a1', sessionId: 's1', rpcId: 'r1', approvalId: 'ap1', toolName: 'bash', createdAt: 10 },
      { kind: 'question', id: 'q1', sessionId: 's2', rpcId: 'r2', questions: [], createdAt: 20 },
    ]
    expect(selectNextNeedsYouId(items, 'q1')).toBe('q1')
    expect(selectNextNeedsYouId(items, 'resolved-id')).toBe('a1')
    expect(selectNextNeedsYouId([], 'a1')).toBeNull()
  })

  it('formats compact relative ages', () => {
    const now = 1_000_000_000
    expect(formatRelativeAge(now - 10_000, now)).toBe('now')
    expect(formatRelativeAge(now - 5 * 60_000, now)).toBe('5m')
    expect(formatRelativeAge(now - 3 * 3_600_000, now)).toBe('3h')
    expect(formatRelativeAge(now - 2 * 86_400_000, now)).toBe('2d')
  })
})
