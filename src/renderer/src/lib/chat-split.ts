export const MAX_SPLIT_PANES = 4
export const CHAT_SPLIT_STORAGE_KEY = 'nd-dsh-chat-split-panes'

export interface SplitPaneItem {
  sessionId: string
}

export type SplitCandidateState = 'working' | 'needs-you' | 'ready' | 'archived'

export interface SplitChatCandidate {
  sessionId: string
  title: string
  engineLabel: string
  projectLabel?: string
  state: SplitCandidateState
  updatedAt?: number
}

const STATE_RANK: Record<SplitCandidateState, number> = {
  working: 0,
  'needs-you': 1,
  ready: 2,
  archived: 3,
}

export function readStoredSplitPanes(storage?: Pick<Storage, 'getItem'>): SplitPaneItem[] {
  try {
    const target = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
    if (!target) return []
    const parsed: unknown = JSON.parse(target.getItem(CHAT_SPLIT_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const panes: SplitPaneItem[] = []
    for (const entry of parsed) {
      const sessionId = typeof entry === 'string'
        ? entry.trim()
        : entry && typeof entry === 'object' && typeof (entry as { sessionId?: unknown }).sessionId === 'string'
          ? (entry as { sessionId: string }).sessionId.trim()
          : ''
      if (!sessionId || seen.has(sessionId)) continue
      seen.add(sessionId)
      panes.push({ sessionId })
      if (panes.length >= MAX_SPLIT_PANES) break
    }
    return panes
  } catch {
    return []
  }
}

export function persistSplitPanes(panes: readonly SplitPaneItem[], storage?: Pick<Storage, 'setItem'>): void {
  try {
    const target = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
    if (!target) return
    target.setItem(CHAT_SPLIT_STORAGE_KEY, JSON.stringify(panes.slice(0, MAX_SPLIT_PANES)))
  } catch {
    // Storage unavailable; split layout still works in memory for this session.
  }
}

export function addSplitPane(panes: readonly SplitPaneItem[], sessionId: string): SplitPaneItem[] {
  const cleaned = sessionId.trim()
  if (!cleaned) return [...panes]
  if (panes.some((pane) => pane.sessionId === cleaned)) return [...panes]
  if (panes.length >= MAX_SPLIT_PANES) {
    return [...panes.slice(0, MAX_SPLIT_PANES - 1), { sessionId: cleaned }]
  }
  return [...panes, { sessionId: cleaned }]
}

export function removeSplitPane(panes: readonly SplitPaneItem[], index: number): SplitPaneItem[] {
  if (index < 0 || index >= panes.length) return [...panes]
  return panes.filter((_, currentIndex) => currentIndex !== index)
}

export function swapSplitPanes(panes: readonly SplitPaneItem[], fromIndex: number, toIndex: number): SplitPaneItem[] {
  if (fromIndex === toIndex) return [...panes]
  if (fromIndex < 0 || fromIndex >= panes.length || toIndex < 0 || toIndex >= panes.length) return [...panes]
  const next = [...panes]
  const temp = next[fromIndex]!
  next[fromIndex] = next[toIndex]!
  next[toIndex] = temp
  return next
}

/**
 * Sort split-picker candidates by live urgency: working agents first, then
 * chats waiting on human decisions, then idle/ready, then archived.
 */
export function sortSplitCandidates(candidates: readonly SplitChatCandidate[]): SplitChatCandidate[] {
  return [...candidates].sort((a, b) => {
    const rankDelta = STATE_RANK[a.state] - STATE_RANK[b.state]
    if (rankDelta !== 0) return rankDelta
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  })
}

export function splitGridClass(paneCount: number): string {
  if (paneCount <= 1) return 'grid-cols-1 grid-rows-1'
  if (paneCount === 2) return 'grid-cols-2 grid-rows-1'
  return 'grid-cols-2 grid-rows-2'
}

export function splitPaneSpanClass(paneCount: number, index: number): string {
  // 3 panes use a 2x2 grid with the first pane spanning both rows (rex-desk layout).
  if (paneCount === 3 && index === 0) return 'row-span-2'
  return ''
}
