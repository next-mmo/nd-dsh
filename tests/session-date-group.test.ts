import { describe, expect, it } from 'vitest'
import {
  bucketEntriesByDate,
  groupSessionsByDate,
  groupSessionsByProject,
  sessionAgeInDays,
  sessionDateGroup,
} from '../src/shared/session-date-group.js'
import type { SidebarProject } from '../src/shared/session-date-group.js'
import type { SessionTreeNode } from '../src/shared/session-tree.js'
import type { EngineSessionSummary, SessionSummary } from '../src/shared/contracts.js'

const DAY = 86_400_000
// Local midnight anchors keep the buckets on calendar days rather than 24h spans.
const NOW = new Date(2026, 9, 20, 13, 0, 0).getTime()

function harness(sessionId: string, updatedAt: number): SessionTreeNode {
  const session = { sessionId, updatedAt, running: false, blank: false } as SessionSummary
  return { session, children: [] }
}

function engine(sessionId: string, updatedAt: number): EngineSessionSummary {
  return { sessionId, engineId: 'chatgpt-web', title: 'Chat', createdAt: updatedAt, updatedAt, running: false }
}

describe('sessionAgeInDays', () => {
  it('counts local calendar days, not elapsed 24h spans', () => {
    expect(sessionAgeInDays(new Date(2026, 9, 20, 0, 5).getTime(), NOW)).toBe(0)
    expect(sessionAgeInDays(new Date(2026, 9, 19, 23, 55).getTime(), NOW)).toBe(1)
  })

  it('clamps a future stamp to today', () => {
    expect(sessionAgeInDays(NOW + 5 * DAY, NOW)).toBe(0)
  })
})

describe('sessionDateGroup', () => {
  it('maps age onto the recency buckets', () => {
    expect(sessionDateGroup(NOW - 2 * 60_000, NOW)).toBe('Today')
    expect(sessionDateGroup(NOW - DAY, NOW)).toBe('Yesterday')
    expect(sessionDateGroup(NOW - 6 * DAY, NOW)).toBe('Last 7 days')
    expect(sessionDateGroup(NOW - 7 * DAY, NOW)).toBe('Last 30 days')
    expect(sessionDateGroup(NOW - 30 * DAY, NOW)).toBe('Earlier')
  })
})

describe('groupSessionsByDate', () => {
  it('interleaves harness and engine chats by recency', () => {
    const groups = groupSessionsByDate(
      [harness('old-chat', NOW - 20 * DAY)],
      [engine('new-chat', NOW - 60_000), engine('mid-chat', NOW - DAY - 60_000)],
      NOW,
    )
    expect(groups.map((group) => group.group)).toEqual(['Today', 'Yesterday', 'Last 30 days'])
    expect(groups[0]!.entries.map((entry) => entry.key)).toEqual(['engine:new-chat'])
    expect(groups[1]!.entries.map((entry) => entry.key)).toEqual(['engine:mid-chat'])
  })

  it('omits empty buckets and keeps newest first inside a bucket', () => {
    const groups = groupSessionsByDate(
      [harness('a', NOW - 3 * 60_000), harness('b', NOW - 9 * 60_000)],
      [],
      NOW,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.group).toBe('Today')
    expect(groups[0]!.entries.map((entry) => entry.key)).toEqual(['harness:a', 'harness:b'])
  })

  it('returns nothing for an empty sidebar', () => {
    expect(groupSessionsByDate([], [], NOW)).toEqual([])
  })
})

describe('groupSessionsByProject', () => {
  const projects: SidebarProject[] = [
    { id: 'personal', name: 'Personal', active: false },
    { id: 'nd-dsh', name: 'nd-dsh', active: true },
  ]
  // The sidebar gets the flat harness list plus the tree projected from it.
  const sessionsOf = (nodes: SessionTreeNode[]): SessionSummary[] =>
    nodes.flatMap((node) => [node.session, ...sessionsOf(node.children)])

  function group(nodes: SessionTreeNode[], engines: EngineSessionSummary[], sessionProjects: Record<string, string>) {
    return groupSessionsByProject(projects, nodes, sessionsOf(nodes), engines, sessionProjects, NOW)
  }

  it('keeps the sidebar project order and still lists a project with no chats', () => {
    const sections = group([harness('a', NOW - 60_000)], [], { a: 'nd-dsh' })
    expect(sections.map((section) => section.id)).toEqual(['personal', 'nd-dsh'])
    expect(sections[0]!.entries).toEqual([])
    expect(sections[1]!.entries.map((entry) => entry.key)).toEqual(['harness:a'])
  })

  it('interleaves harness and engine chats by recency inside a project', () => {
    const sections = group(
      [harness('h', NOW - 2 * 60_000)],
      [engine('e', NOW - 60_000)],
      { h: 'nd-dsh', e: 'nd-dsh' },
    )
    expect(sections[1]!.entries.map((entry) => entry.key)).toEqual(['engine:e', 'harness:h'])
  })

  it('falls back to Personal for unattributed and for removed-project chats', () => {
    const sections = group(
      [harness('loose', NOW - 60_000), harness('orphan', NOW - 2 * 60_000)],
      [],
      { orphan: 'deleted-project' },
    )
    expect(sections[0]!.entries.map((entry) => entry.key)).toEqual(['harness:loose', 'harness:orphan'])
    expect(sections[1]!.entries).toEqual([])
  })

  it('lists a parent thread once, under the project the run recorded', () => {
    const child = { sessionId: 'sub', updatedAt: NOW - 60_000, running: false, origin: 'subagent', parentSessionId: 'h' } as SessionSummary
    const parent = harness('h', NOW - 3 * 60_000)
    parent.children = [{ session: child, children: [] }]
    const sections = group([parent], [], { h: 'nd-dsh' })
    expect(sections[1]!.entries.map((entry) => entry.key)).toEqual(['harness:h'])
    expect(sections[0]!.entries).toEqual([])
  })

  it('buckets each project by recency only when the project has chats', () => {
    const sections = group(
      [harness('today', NOW - 60_000), harness('month', NOW - 40 * DAY)],
      [],
      { today: 'nd-dsh', month: 'nd-dsh' },
    )
    expect(sections[0]!.groups).toEqual([])
    expect(sections[1]!.groups.map((bucket) => bucket.group)).toEqual(['Today', 'Earlier'])
  })
})

describe('bucketEntriesByDate', () => {
  it('orders the fixed buckets newest first regardless of input order', () => {
    const groups = bucketEntriesByDate([
      { kind: 'engine', key: 'old', updatedAt: NOW - 40 * DAY, session: engine('old', NOW - 40 * DAY) },
      { kind: 'engine', key: 'new', updatedAt: NOW - 60_000, session: engine('new', NOW - 60_000) },
      { kind: 'engine', key: 'week', updatedAt: NOW - 3 * DAY, session: engine('week', NOW - 3 * DAY) },
    ], NOW)
    expect(groups.map((group) => group.group)).toEqual(['Today', 'Last 7 days', 'Earlier'])
  })
})
