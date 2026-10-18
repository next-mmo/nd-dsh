import { PERSONAL_PROJECT_ID } from './organization.js'

export { PERSONAL_PROJECT_ID }

/**
 * Project scoping for the chat sidebar.
 *
 * The gateway session list is workspace-scoped: organization runs and manual
 * chats record their session in the same workspace. ND attributes sessions to
 * projects (or the built-in Personal project).
 *
 * - With no active project (standalone workspace), all sessions remain visible.
 * - When Personal is the active project, personal sessions (and unassigned legacy chats)
 *   are visible, while company project sessions are hidden.
 * - When a company project is active, only sessions attributed to that project are
 *   visible, avoiding cross-project chat pollution.
 * - Subagents inherit the attribution of their parent.
 */
export function isSessionInProjectScope(
  sessionId: string,
  activeProjectId: string | undefined,
  sessionProjects: Readonly<Record<string, string>>,
): boolean {
  if (!activeProjectId) return true
  const projectId = sessionProjects[sessionId]
  if (activeProjectId === PERSONAL_PROJECT_ID) {
    return projectId === undefined || projectId === PERSONAL_PROJECT_ID
  }
  return projectId === activeProjectId
}

export function filterSessionsInProjectScope<T extends { sessionId: string; parentSessionId?: string; origin?: 'subagent' }>(
  items: readonly T[],
  activeProjectId: string | undefined,
  sessionProjects: Readonly<Record<string, string>>,
): T[] {
  if (!activeProjectId) return [...items]
  const byId = new Map(items.map((item) => [item.sessionId, item]))
  const resolvedProjects = new Map<string, string | undefined>()

  const projectFor = (sessionId: string, trail = new Set<string>()): string | undefined => {
    if (resolvedProjects.has(sessionId)) return resolvedProjects.get(sessionId)
    const direct = sessionProjects[sessionId]
    if (direct !== undefined) {
      resolvedProjects.set(sessionId, direct)
      return direct
    }
    if (trail.has(sessionId)) return undefined
    const item = byId.get(sessionId)
    const parentId = item?.origin === 'subagent' ? item.parentSessionId : undefined
    if (!parentId) {
      resolvedProjects.set(sessionId, undefined)
      return undefined
    }
    const nextTrail = new Set(trail)
    nextTrail.add(sessionId)
    const inherited = projectFor(parentId, nextTrail)
    resolvedProjects.set(sessionId, inherited)
    return inherited
  }

  return items.filter((item) => {
    const projectId = projectFor(item.sessionId)
    if (activeProjectId === PERSONAL_PROJECT_ID) {
      return projectId === undefined || projectId === PERSONAL_PROJECT_ID
    }
    return projectId === activeProjectId
  })
}

