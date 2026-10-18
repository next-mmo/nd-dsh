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
}

const GEMINI_ORIGIN = 'https://gemini.google.com'
const CHAT_PATH_PATTERN = /(?:^|\/)app\/([A-Za-z0-9_-]+)/
const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/

/**
 * Parse a Gemini chat link (normal chat / skill chat) into a standardized descriptor.
 * Supports:
 * - https://gemini.google.com/app/fa5b05f3a25f7f76
 * - https://gemini.google.com/u/0/app/fa5b05f3a25f7f76 (Google multi-account URLs)
 * - gemini.google.com/app/fa5b05f3a25f7f76
 * - /app/fa5b05f3a25f7f76
 * - fa5b05f3a25f7f76 (bare chat ID)
 */
export function parseGeminiSkillLinkInput(input: string): ParsedGeminiGem | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // If user pasted a bare chat ID (e.g. fa5b05f3a25f7f76)
  if (CHAT_ID_PATTERN.test(trimmed) && !trimmed.includes('/') && !trimmed.includes('.')) {
    return {
      gemRef: trimmed,
      gemId: trimmed,
      gemUrl: `${GEMINI_ORIGIN}/app/${trimmed}`,
    }
  }

  let pathname = ''
  let origin = ''
  try {
    const candidate = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : trimmed.startsWith('/')
        ? `${GEMINI_ORIGIN}${trimmed}`
        : `https://${trimmed}`
    const url = new URL(candidate)
    origin = url.origin
    pathname = url.pathname
  } catch {
    pathname = trimmed
  }

  if (origin && origin !== GEMINI_ORIGIN && !origin.endsWith('.gemini.google.com')) {
    return null
  }

  const match = CHAT_PATH_PATTERN.exec(pathname)
  if (!match || !match[1]) return null
  const chatId = match[1]

  return {
    gemRef: chatId,
    gemId: chatId,
    gemUrl: `${GEMINI_ORIGIN}/app/${chatId}`,
  }
}

/**
 * Extract chat ID from a Gemini conversation URL.
 */
export function parseGeminiConversationUrl(url: string): ParsedGeminiConversation | null {
  try {
    const parsed = new URL(url)
    if (parsed.origin !== GEMINI_ORIGIN && !parsed.origin.endsWith('.gemini.google.com')) return null
    const match = CHAT_PATH_PATTERN.exec(parsed.pathname)
    if (match && match[1]) return { chatId: match[1] }
    return null
  } catch {
    return null
  }
}

export function isGeminiPageUrl(value: string): boolean {
  try {
    const origin = new URL(value).origin
    return origin === GEMINI_ORIGIN || origin.endsWith('.gemini.google.com')
  } catch {
    return false
  }
}

/** A Gemini URL that holds a conversation (/app/<chatId>). */
export function isGeminiConversationUrl(value: string): boolean {
  return parseGeminiConversationUrl(value) !== null
}

export function sameGeminiUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left)
    const b = new URL(right)
    if (a.origin !== b.origin) return false
    const aMatch = CHAT_PATH_PATTERN.exec(a.pathname)
    const bMatch = CHAT_PATH_PATTERN.exec(b.pathname)
    if (aMatch && bMatch) return aMatch[1] === bMatch[1]
    return a.pathname === b.pathname
  } catch {
    return left === right
  }
}
