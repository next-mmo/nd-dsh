import type { ProjectPlanInput } from './organization.js'

export interface ReviewVerdict {
  verdict: 'pass' | 'fail'
  summary: string
  issues?: string[]
  memory?: Array<{ title: string; content: string; tags?: string[] }>
}

export type AssistantSegment =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'review'; review: ReviewVerdict }
  | { kind: 'plan'; plan: ProjectPlanInput }

/**
 * Models sometimes write one `"milestones": [...]` entry per milestone (or one
 * `"tasks": [...]` per task) inside the same object. That is valid JSON, but a
 * parser keeps only the last duplicate key and silently drops the rest of the
 * plan. Merge arrays in their containing object, including repeats separated
 * by other fields, without interpreting punctuation inside quoted strings.
 */
export function mergeRepeatedArrayKeys(json: string, keys: readonly string[]): { json: string; merged: number } {
  if (json.length > 2_000_000) throw new Error('Structured JSON exceeds the size limit')
  const mergeKeys = new Set(keys)
  let merged = 0
  let cursor = 0
  const whitespace = (): void => { while (/\s/.test(json[cursor] ?? '') && cursor < json.length) cursor += 1 }
  const expect = (character: string): void => {
    whitespace()
    if (json[cursor] !== character) throw new Error(`Invalid structured JSON at position ${cursor}`)
    cursor += 1
  }
  const string = (): string => {
    const start = cursor
    expect('"')
    while (cursor < json.length) {
      const character = json[cursor++]
      if (character === '\\') cursor += 1
      else if (character === '"') return JSON.parse(json.slice(start, cursor)) as string
    }
    throw new Error('Unterminated string in structured JSON')
  }
  const value = (depth: number): unknown => {
    if (depth > 128) throw new Error('Structured JSON exceeds the nesting limit')
    whitespace()
    if (json[cursor] === '"') return string()
    if (json[cursor] === '[') {
      cursor += 1
      const items: unknown[] = []
      whitespace()
      if (json[cursor] === ']') { cursor += 1; return items }
      for (;;) {
        items.push(value(depth + 1))
        whitespace()
        if (json[cursor] === ']') { cursor += 1; return items }
        expect(',')
      }
    }
    if (json[cursor] === '{') {
      cursor += 1
      // Null prototype preserves JSON keys such as __proto__ as ordinary data.
      const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      whitespace()
      if (json[cursor] === '}') { cursor += 1; return object }
      for (;;) {
        whitespace()
        const key = string()
        expect(':')
        const next = value(depth + 1)
        const previous = object[key]
        if (mergeKeys.has(key) && Array.isArray(previous) && Array.isArray(next)) {
          for (const item of next) previous.push(item)
          merged += 1
        } else object[key] = next
        whitespace()
        if (json[cursor] === '}') { cursor += 1; return object }
        expect(',')
      }
    }
    const start = cursor
    while (cursor < json.length && !/[\s,}\]]/.test(json[cursor]!)) cursor += 1
    if (start === cursor) throw new Error(`Invalid structured JSON at position ${cursor}`)
    return JSON.parse(json.slice(start, cursor)) as unknown
  }
  const result = value(0)
  whitespace()
  if (cursor !== json.length) throw new Error(`Invalid structured JSON at position ${cursor}`)
  return { json: merged ? JSON.stringify(result) : json, merged }
}

const TAGGED_BLOCK_PATTERN = /<(nd-dsh-review|nd-dsh-plan)>\s*([\s\S]*?)\s*<\/\1>/g

function parseTaggedBody<T>(raw: string, repeatedArrayKeys: readonly string[] = []): T | undefined {
  let body = raw.trim()
  if (body.startsWith('```')) body = body.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  try {
    return JSON.parse(mergeRepeatedArrayKeys(body, repeatedArrayKeys).json) as T
  } catch {
    return undefined
  }
}

/**
 * Leading "Reasoning"/"Thinking" label a model writes ahead of its answer.
 * ND's planning and review prompts ask for "concise reasoning, then" a tagged
 * block, and models reproduce that shape in plain chat too, so the label is
 * what separates deliberation from the answer.
 */
const REASONING_LABEL = new RegExp(
  [
    // Bold/strong label, punctuation inside or outside the markers.
    '^(?:\\*\\*|__)\\s*(?:reasoning|thinking)\\s*[:.\\u2014\\u2013-]?\\s*(?:\\*\\*|__)\\s*[:.\\u2014\\u2013-]?\\s*',
    // Markdown heading label.
    '|^#{1,6}\\s+(?:reasoning|thinking)\\s*[:.\\u2014\\u2013-]?\\s*',
    // Bare label followed by punctuation; a bare "Reasoning about…" is prose.
    '|^(?:reasoning|thinking)\\s*[:.\\u2014\\u2013-]\\s*',
  ].join(''),
  'i',
)

/**
 * Splits a text chunk that opens with a reasoning label into its deliberation
 * and the answer that follows. `preamble` marks a chunk the model wrote
 * immediately before a tagged block: the prompt asked for reasoning "then"
 * the block, so the whole chunk is deliberation. Elsewhere the first blank
 * line ends it, so an unlabelled answer is never swallowed.
 */
function splitReasoningLead(text: string, preamble: boolean): { reasoning: string | undefined; rest: string } {
  const match = REASONING_LABEL.exec(text)
  if (!match) return { reasoning: undefined, rest: text }
  const body = text.slice(match[0].length)
  if (preamble) return { reasoning: body.trim(), rest: '' }
  const breakIndex = body.search(/\n[ \t]*\n/)
  if (breakIndex === -1) return { reasoning: body.trim(), rest: '' }
  return { reasoning: body.slice(0, breakIndex).trim(), rest: body.slice(breakIndex).trim() }
}

/**
 * Splits an assistant message into plain-text segments and structured
 * protocol blocks (review verdicts, project plans) so the chat can render
 * cards instead of raw tagged JSON. A leading reasoning preamble becomes its
 * own segment so deliberation never renders as answer prose. Blocks whose
 * JSON is malformed or not yet fully streamed stay as plain text.
 */
export function splitAssistantSegments(text: string): AssistantSegment[] {
  const segments: AssistantSegment[] = []
  const pushText = (chunk: string, preamble: boolean): void => {
    const trimmed = chunk.trim()
    if (!trimmed) return
    const { reasoning, rest } = splitReasoningLead(trimmed, preamble)
    if (reasoning !== undefined) {
      segments.push({ kind: 'reasoning', text: reasoning })
      if (rest) segments.push({ kind: 'text', text: rest })
      return
    }
    segments.push({ kind: 'text', text: trimmed })
  }
  let cursor = 0
  for (const match of text.matchAll(TAGGED_BLOCK_PATTERN)) {
    pushText(text.slice(cursor, match.index), true)
    cursor = (match.index ?? 0) + match[0].length
    const tag = match[1]
    const body = match[2] ?? ''
    if (tag === 'nd-dsh-review') {
      const review = parseTaggedBody<ReviewVerdict>(body)
      if (review && (review.verdict === 'pass' || review.verdict === 'fail') && typeof review.summary === 'string') {
        segments.push({ kind: 'review', review })
        continue
      }
    } else {
      const plan = parseTaggedBody<ProjectPlanInput>(body, ['milestones', 'tasks'])
      if (plan?.goal?.title && Array.isArray(plan.milestones) && plan.milestones.length > 0) {
        segments.push({ kind: 'plan', plan })
        continue
      }
    }
    pushText(body, false)
  }
  pushText(text.slice(cursor), false)
  return segments
}
