import { messageText } from '../../shared/chat-events.js'
import type { SessionEventEnvelope } from '../../shared/contracts.js'

/**
 * Read the newest assistant message from a finished web turn. ChatGPT prefixes
 * copied text with "ChatGPT said:" and Gemini can echo favicon images, so both
 * are stripped here instead of in every caller.
 */
export function extractLatestAssistantText(events: unknown[]): string | undefined {
  if (!Array.isArray(events)) return undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const envelope = events[i] as SessionEventEnvelope
    if (envelope?.type === 'assistant/message') {
      const data = (envelope.data ?? {}) as Record<string, unknown>
      const text = messageText(data.message) ?? messageText(data)
      if (typeof text === 'string' && text.trim()) {
        return text
          .replace(/^ChatGPT said:\s*/i, '')
          .replace(/!\[[^\]]*\]\(https?:\/\/(?:www\.)?google\.com\/s2\/favicons\?[^)]*\)\s*/gi, '')
          .trim()
      }
    }
  }
  return undefined
}