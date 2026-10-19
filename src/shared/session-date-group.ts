import type { EngineSessionSummary, SessionSummary } from './contracts.js'
import type { SessionTreeNode } from './session-tree.js'
import { PERSONAL_PROJECT_ID, resolveSessionProjectIds } from './session-project-scope.js'

/**
 * Recency buckets for the chats sidebar. Ordered newest first so the renderer can
 * emit headers without sorting again.
 */
export const SESSION_DATE_GROUPS = ['Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'Earlier'] as const

export type SessionDateGroup = (typeof SESSION_DATE_GROUPS)[number]

export type SidebarSessionEntry =
  | { kind: 'harness'; key: string; updatedAt: number; node: SessionTreeNode }
  | { kind: 'engine'; key: string; updatedAt: number; session: EngineSessionSummary }

export interface SidebarSessionGroup {
  group: SessionDateGroup
  entries: SidebarSessionEntry[]
}

const DAY_MS = 86_400_000

/** Project rows the sidebar lists chats under, in the order it should show them. */
export interface SidebarProject {
  id: string
  name: string
  active: boolean
}

export interface SidebarProjectSection extends SidebarProject {
  /** Every chat belonging to this project, newest first. */
  entries: SidebarSessionEntry[]
  /** `entries` bucketed by recency; empty when the sidebar lists chats flat. */
  groups: SidebarSessionGroup[]
}

function startOfDay(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Whole local days between a session and `now`, clamped at zero for future stamps. */
export function sessionAgeInDays(updatedAt: number, now: number): number {
  // Rounding absorbs the ±1h a local calendar day shifts across a DST boundary.
  return Math.max(0, Math.round((startOfDay(now) - startOfDay(updatedAt)) / DAY_MS))
}

export function sessionDateGroup(updatedAt: number, now: number): SessionDateGroup {
  const days = sessionAgeInDays(updatedAt, now)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'Last 7 days'
  if (days < 30) return 'Last 30 days'
  return 'Earlier'
}

/**
 * Merge the harness session tree and engine chats into one recency-ordered list
 * bucketed by date.
 *
 * Both sources arrive as separate lists, so an ungrouped sidebar shows every
 * harness chat above every ChatGPT/Gemini chat. Grouping interleaves them, which
 * is what a date header needs to mean. A harness root keeps its subagents with it
 * rather than splitting the thread across buckets.
 */
function toSidebarEntries(
  harnessNodes: readonly SessionTreeNode[],
  engineSessions: readonly EngineSessionSummary[],
): SidebarSessionEntry[] {
  return [
    ...harnessNodes.map((node): SidebarSessionEntry => ({
      kind: 'harness',
      key: `harness:${node.session.sessionId}`,
      updatedAt: node.session.updatedAt,
      node,
    })),
    ...engineSessions.map((session): SidebarSessionEntry => ({
      kind: 'engine',
      key: `engine:${session.sessionId}`,
      updatedAt: session.updatedAt,
      session,
    })),
  ]
}

/**
 * Bucket an already-merged entry list under its recency headers.
 *
 * Both sources arrive as separate lists, so an ungrouped sidebar shows every
 * harness chat above every ChatGPT/Gemini chat. Sorting interleaves them, which
 * is what a date header needs to mean. A harness root keeps its subagents with it
 * rather than splitting the thread across buckets.
 */
export function bucketEntriesByDate(
  entries: readonly SidebarSessionEntry[],
  now: number,
): SidebarSessionGroup[] {
  const buckets = new Map<SessionDateGroup, SidebarSessionEntry[]>()
  for (const entry of [...entries].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const group = sessionDateGroup(entry.updatedAt, now)
    const bucket = buckets.get(group)
    if (bucket) bucket.push(entry)
    else buckets.set(group, [entry])
  }

  return SESSION_DATE_GROUPS
    .filter((group) => buckets.has(group))
    .map((group) => ({ group, entries: buckets.get(group)! }))
}

export function groupSessionsByDate(
  harnessNodes: readonly SessionTreeNode[],
  engineSessions: readonly EngineSessionSummary[],
  now: number,
): SidebarSessionGroup[] {
  return bucketEntriesByDate(toSidebarEntries(harnessNodes, engineSessions), now)
}

/**
 * Split the whole chat list into one collapsible section per project.
 *
 * The sidebar used to show only the active project's chats; sections let it show
 * every project at once. A chat is attributed through the same subagent-inheriting
 * resolver the scoping filter uses, and anything that resolves to no project — or
 * to one that has since been removed — lands under Personal, so grouping can never
 * silently drop a chat the way a strict per-project filter would.
 *
 * Projects with no chats still get a section: it is how you switch to them.
 */
export function groupSessionsByProject(
  projects: readonly SidebarProject[],
  harnessNodes: readonly SessionTreeNode[],
  harnessSessions: readonly SessionSummary[],
  engineSessions: readonly EngineSessionSummary[],
  sessionProjects: Readonly<Record<string, string>>,
  now: number,
): SidebarProjectSection[] {
  const resolvedHarness = resolveSessionProjectIds(harnessSessions, sessionProjects)
  const projectIds = new Set(projects.map((project) => project.id))
  const personalId = projects.some((project) => project.id === PERSONAL_PROJECT_ID)
    ? PERSONAL_PROJECT_ID
    : projects[0]?.id

  const ownerOf = (entry: SidebarSessionEntry): string | undefined => {
    const projectId = entry.kind === 'harness'
      ? resolvedHarness.get(entry.node.session.sessionId)
      : sessionProjects[entry.session.sessionId]
    return projectId && projectIds.has(projectId) ? projectId : personalId
  }

  const byProject = new Map<string, SidebarSessionEntry[]>()
  for (const entry of toSidebarEntries(harnessNodes, engineSessions)) {
    const projectId = ownerOf(entry)
    if (!projectId) continue
    const bucket = byProject.get(projectId)
    if (bucket) bucket.push(entry)
    else byProject.set(projectId, [entry])
  }

  return projects.map((project) => {
    const entries = [...(byProject.get(project.id) ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
    return { ...project, entries, groups: bucketEntriesByDate(entries, now) }
  })
}
