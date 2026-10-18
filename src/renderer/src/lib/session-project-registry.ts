const SESSION_PROJECTS_STORAGE_KEY = 'nd-session-projects'

export function getStoredSessionProjects(): Record<string, string> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return {}
    const raw = window.localStorage.getItem(SESSION_PROJECTS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function storeSessionProject(sessionId: string, projectId: string): void {
  try {
    if (!sessionId || !projectId) return
    if (typeof window === 'undefined' || !window.localStorage) return
    const current = getStoredSessionProjects()
    if (current[sessionId] === projectId) return
    current[sessionId] = projectId
    window.localStorage.setItem(SESSION_PROJECTS_STORAGE_KEY, JSON.stringify(current))
    window.dispatchEvent(new CustomEvent('nd-session-projects-changed', { detail: { sessionId, projectId } }))
  } catch {
    // ignore
  }
}
