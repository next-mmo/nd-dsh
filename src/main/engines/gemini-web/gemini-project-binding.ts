export interface GeminiGemBinding {
  workspaceRoot: string
  projectId?: string
  projectName: string
  gemRef: string
  gemId: string
  gemUrl: string
  source: 'auto' | 'manual'
  updatedAt: number
}

export interface ParsedGeminiGem {
  gemRef: string
  gemId: string
  gemUrl: string
}

export interface ParsedGeminiConversation {
  chatId?: string
  gemId?: string
}

const GEMINI_ORIGIN = 'https://gemini.google.com'
const CONVERSATION_PATH_PATTERN = /\/(?:app\/|gem\/)([A-Za-z0-9_-]+)/

/**
 * Parse a Gemini Gem URL into a standardized Gem descriptor. Supports:
 * - https://gemini.google.com/gem/1e5f6a... (chat inside the Gem)
 * - https://gemini.google.com/gems/view/1e5f6a... (Gem management page)
 * - https://gemini.google.com/gems/connect/1e5f6a... (Gem share link)
 * - /gem/1e5f6a... (path only)
 */
export function parseGeminiGemInput(input: string): ParsedGeminiGem | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  let pathname = ''
  try {
    const url = new URL(trimmed)
    if (url.origin === GEMINI_ORIGIN) pathname = url.pathname
  } catch {
    pathname = trimmed
  }

  if (!pathname) return null
  const segments = pathname.split('/').filter(Boolean)
  // /gem/<id>, /gems/<id>, /gems/view/<id>, /gems/connect/<id>.
  // The bare /gems library (including /gems/view?dest=create) has no gem id.
  let gemId: string | undefined
  if (segments[0] === 'gem' && segments[1]) {
    gemId = segments[1]
  } else if (segments[0] === 'gems' && segments[1]) {
    if (segments[1] === 'view' || segments[1] === 'connect') gemId = segments[2]
    else gemId = segments[1]
  }
  if (!gemId) return null

  return {
    gemRef: gemId,
    gemId,
    gemUrl: `${GEMINI_ORIGIN}/gem/${gemId}`,
  }
}

/**
 * Extract chat/gem ids from a Gemini conversation URL if present.
 * `/app/<id>` is a plain conversation; `/gem/<id>` is a Gem chat.
 */
export function parseGeminiConversationUrl(url: string): ParsedGeminiConversation | null {
  try {
    const parsed = new URL(url)
    if (parsed.origin !== GEMINI_ORIGIN) return null
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments[0] === 'app' && segments[1]) return { chatId: segments[1] }
    if (segments[0] === 'gem' && segments[1]) return { gemId: segments[1] }
    return null
  } catch {
    return null
  }
}

export function isGeminiPageUrl(value: string): boolean {
  try {
    return new URL(value).origin === GEMINI_ORIGIN
  } catch {
    return false
  }
}

/** A Gemini URL that holds a conversation (plain chat or a Gem chat). */
export function isGeminiConversationUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    if (parsed.origin !== GEMINI_ORIGIN) return false
    const segments = parsed.pathname.split('/').filter(Boolean)
    return (segments[0] === 'app' || segments[0] === 'gem') && segments.length >= 2
  } catch {
    return false
  }
}

export function sameGeminiUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left)
    const b = new URL(right)
    return a.origin === b.origin && a.pathname === b.pathname
  } catch {
    return left === right
  }
}
