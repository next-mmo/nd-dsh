import type { ThreadEntry, TodoItem } from './chat-types.js'
import { stripWorkspaceContext } from './workspace-context.js'

const RESULT_MAX_CHARS = 2_000

/** Source kind the Harness tags on the turn's real prompt. */
const USER_MESSAGE_SOURCE = 'user'

/**
 * Read the Harness source tag from a user/message payload. Absent means a
 * session recorded before the tag existed, which only ever held real prompts.
 */
function messageSourceKind(data: Record<string, unknown>): string | undefined {
  const source = data.source
  if (!source || typeof source !== 'object') return undefined
  const kind = (source as Record<string, unknown>).kind
  return typeof kind === 'string' && kind ? kind : undefined
}

export interface HistoryEventEnvelope {
  type: string
  seq: number
  data?: unknown
}

/** Returns the entry at `index` in a form the fold may mutate. */
type OwnEntry = (index: number) => ThreadEntry

export function foldHistory(events: HistoryEventEnvelope[]): ThreadEntry[] {
  const entries: ThreadEntry[] = []
  const own: OwnEntry = (index) => entries[index]!
  for (const envelope of events) {
    if (!envelope) continue
    foldEventInto(entries, envelope, own)
  }
  return entries
}

/**
 * Copy-on-write: only the entry an event changes is replaced, so React may replay
 * an updater against the same previous state, and unchanged entries keep their
 * identity for memoized rows.
 */
export function foldEvent(entries: ThreadEntry[], envelope: HistoryEventEnvelope): ThreadEntry[] {
  const next = [...entries]
  const own: OwnEntry = (index) => (next[index] = { ...next[index]! })
  foldEventInto(next, envelope, own)
  return next
}

function foldEventInto(entries: ThreadEntry[], envelope: HistoryEventEnvelope, own: OwnEntry): void {
  const data = (envelope.data ?? {}) as Record<string, unknown>
  switch (envelope.type) {
    case 'user/message': {
      const text = messageText(data.message) ?? messageText(data)
      if (!text) return
      const source = messageSourceKind(data)
      // A turn carries the user's own prompt plus synthetic context messages —
      // workspace instructions, the runtime context snapshot, and the skill
      // catalog — each tagged with its own source kind. Only the user's prompt
      // is the user's message; the rest is internal and must not be attributed
      // to the user or rendered as something they typed.
      if (source !== undefined && source !== USER_MESSAGE_SOURCE) {
        const last = entries.at(-1)
        if (last?.kind === 'context' && last.source === source && last.text === text) return
        entries.push({ kind: 'context', id: crypto.randomUUID(), source, text })
        return
      }
      const hasLegacyUserPrefix = /^(?:#+\s*)?You said\b/i.test(text)
      const visible = stripWorkspaceContext(text)
        .replace(/^(?:#+\s*)?You said\b[^\n]*\n+/i, '')
        .replace(/^You said:\s*/i, '')
        .trim()
      if (!visible) return
      const last = entries.at(-1)
      if (last?.kind === 'user' && last.text === visible) return
      if (hasLegacyUserPrefix && entries.some((entry) => entry.kind === 'user' && entry.text === visible)) return
      entries.push({ kind: 'user', id: crypto.randomUUID(), text: visible, ...(data.skillMention ? { skillMention: data.skillMention as import('./skill-catalog.js').SkillSuggestion } : {}) })
      return
    }
    case 'assistant/chunk': {
      const text = messageText(data.chunk) ?? messageText(data)
      if (!text) return
      const last = entries.at(-1)
      if (last?.kind === 'assistant' && last.streaming) {
        const owned = own(entries.length - 1) as typeof last
        owned.text = `${last.text}${text}`
      } else {
        entries.push({ kind: 'assistant', id: crypto.randomUUID(), text, streaming: true })
      }
      return
    }
    case 'assistant/message': {
      const rawText = messageText(data.message) ?? messageText(data)
      if (rawText === undefined) return
      const hasLegacyPrefix = /^ChatGPT said:\s*/i.test(rawText)
      const text = rawText
        .replace(/^ChatGPT said:\s*/i, '')
        .replace(/!\[[^\]]*\]\(https?:\/\/(?:www\.)?google\.com\/s2\/favicons\?[^)]*\)\s*/gi, '')
        .trim() || rawText
      if (typeof data.replaceFromEndAssistantOffset === 'number' && data.replaceFromEndAssistantOffset >= 0) {
        let seenFromEnd = 0
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i]?.kind === 'assistant') {
            if (seenFromEnd === data.replaceFromEndAssistantOffset) {
              const owned = own(i) as Extract<ThreadEntry, { kind: 'assistant' }>
              owned.text = text
              owned.streaming = false
              return
            }
            seenFromEnd += 1
          }
        }
      }
      const last = entries.at(-1)
      if (last?.kind === 'assistant' && last.streaming) {
        const owned = own(entries.length - 1) as typeof last
        owned.text = text
        owned.streaming = false
        return
      }
      // If an earlier assistant turn was recorded as a bare "Edit" button placeholder
      // (before a generated image finished loading) or re-serialized with updated
      // Markdown images, upgrade that existing assistant turn in place.
      const firstLine = text.split('\n')[0]?.trim() ?? ''
      for (let i = 0; i < entries.length; i++) {
        const existing = entries[i]
        if (existing?.kind !== 'assistant' || existing.streaming) continue
        if (existing.text === text && (hasLegacyPrefix || last?.kind === 'assistant')) return
        if (existing.text === 'Edit' && text.startsWith('![')) {
          const owned = own(i) as Extract<ThreadEntry, { kind: 'assistant' }>
          owned.text = text
          return
        }
        const existingFirstLine = existing.text.split('\n')[0]?.trim() ?? ''
        if (firstLine.length >= 20 && firstLine === existingFirstLine && (text.includes('![') || existing.text.includes('!['))) {
          const owned = own(i) as Extract<ThreadEntry, { kind: 'assistant' }>
          owned.text = text
          return
        }
      }
      entries.push({ kind: 'assistant', id: crypto.randomUUID(), text })
      return
    }
    case 'agent/reasoning': {
      const text = typeof data.text === 'string' ? data.text : ''
      if (!text) return
      const last = entries.at(-1)
      if (last?.kind === 'reasoning' && last.text.length < 4000) {
        const owned = own(entries.length - 1) as typeof last
        owned.text = `${last.text}\n${text}`
      } else {
        entries.push({ kind: 'reasoning', id: crypto.randomUUID(), text })
      }
      return
    }
    case 'tool/call': {
      const callId = typeof data.callId === 'string' ? data.callId : undefined
      const name = typeof data.name === 'string' ? data.name : 'tool'
      entries.push({ kind: 'tool', id: crypto.randomUUID(), ...(callId === undefined ? {} : { callId }), name, args: data.arguments, status: 'running' })
      return
    }
    case 'tool/result': {
      const callId = typeof data.callId === 'string' ? data.callId : undefined
      const runningIndex = entries.findIndex((entry) =>
        entry.kind === 'tool'
        && entry.status === 'running'
        && (callId === undefined || entry.callId === callId))
      const text = messageText(data.message) ?? ''
      const summary = typeof data.error === 'string' ? `Error: ${data.error}` : text.slice(0, RESULT_MAX_CHARS)
      if (runningIndex === -1) {
        entries.push({ kind: 'tool', id: crypto.randomUUID(), name: 'tool', status: typeof data.error === 'string' ? 'error' : 'done', result: summary })
      } else {
        const entry = entries[runningIndex]
        if (entry?.kind === 'tool') {
          const owned = own(runningIndex) as typeof entry
          owned.status = typeof data.error === 'string' ? 'error' : 'done'
          owned.result = summary
        }
      }
      return
    }
    case 'todo/write': {
      const todos = Array.isArray(data.todos) ? data.todos as unknown as TodoItem[] : []
      const last = entries.at(-1)
      if (last?.kind === 'todo') (own(entries.length - 1) as typeof last).items = todos
      else entries.push({ kind: 'todo', id: crypto.randomUUID(), items: todos })
      return
    }
    default:
      // turn/step markers, request headers, compaction records, and plugin
      // events stay out of the surface; the trajectory view owns those.
      return
  }
}

export function messageText(message: unknown): string | undefined {
  if (typeof message === 'string') return message
  if (!message || typeof message !== 'object') return undefined
  const record = message as Record<string, unknown>
  if (typeof record.content === 'string') return record.content
  if (typeof record.text === 'string') return record.text
  if (record.delta && typeof record.delta === 'object') return messageText(record.delta)
  if (!Array.isArray(record.content)) return undefined
  const parts: string[] = []
  for (const block of record.content) {
    if (block && typeof block === 'object' && ['text', 'text-delta', 'output_text'].includes(String((block as Record<string, unknown>).type))) {
      const text = (block as Record<string, unknown>).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

