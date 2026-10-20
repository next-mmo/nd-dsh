import type { SessionSummary } from '../../../shared/contracts.js'

export type CenterView = 'company' | 'dsh' | 'browser' | 'editor' | 'settings'

export type { TodoItem, AskQuestion, ThreadEntry, ThreadImage, SessionThread } from '../../../shared/chat-types.js'

export interface DshSessionStore {
  sessions: SessionSummary[]
  activeSessionId: string | null
}
