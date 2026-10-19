export interface ChatGptProjectBinding {
  workspaceRoot: string
  projectId?: string
  projectName: string
  chatGptProjectRef: string
  chatGptProjectId: string
  chatGptProjectUrl: string
  source: 'auto' | 'manual'
  updatedAt: number
}

export interface ParsedChatGptProject {
  projectRef: string
  projectId: string
  slug?: string
  projectUrl: string
}

export interface ParsedChatGptConversation {
  projectRef?: string
  chatId: string
}

const CHATGPT_ORIGIN = 'https://chatgpt.com'
const PROJECT_REF_PATTERN = /^(g-p-[a-zA-Z0-9]+)(?:-(.+))?$/
const PROJECT_PATH_PATTERN = /\/g\/(g-p-[a-zA-Z0-9]+(?:-[a-zA-Z0-9_-]+)?)/
// Signed-in chats live under /c/; signed-out guest chats live under /uc/.
const CONVERSATION_PATH_PATTERN = /(?:^|\/)(?:c|uc)\/([a-zA-Z0-9-]+)/

/**
 * Parse a user input or URL into a standardized ChatGPT Project descriptor.
 * Supports:
 * - https://chatgpt.com/g/g-p-6a9bf...-todo/project
 * - https://chatgpt.com/g/g-p-6a9bf...-todo/c/6aaac7f...
 * - https://chatgpt.com/g/g-p-6a9bf.../project?tab=chats
 * - /g/g-p-6a9bf...-todo/project
 * - g-p-6a9bf...-todo or g-p-6a9bf...
 */
export function parseChatGptProjectInput(input: string): ParsedChatGptProject | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  let candidateRef = ''
  try {
    const url = new URL(trimmed)
    if (url.origin === CHATGPT_ORIGIN) {
      const match = PROJECT_PATH_PATTERN.exec(url.pathname)
      if (match && match[1]) candidateRef = match[1]
    }
  } catch {
    const match = PROJECT_PATH_PATTERN.exec(trimmed)
    if (match && match[1]) candidateRef = match[1]
    else if (trimmed.startsWith('g-p-')) candidateRef = trimmed.replace(/\/.*$/, '')
  }

  if (!candidateRef) return null

  const refMatch = PROJECT_REF_PATTERN.exec(candidateRef)
  if (!refMatch || !refMatch[1]) return null

  const projectId = refMatch[1]
  const slug = refMatch[2] || undefined

  return {
    projectRef: candidateRef,
    projectId,
    ...(slug ? { slug } : {}),
    projectUrl: `${CHATGPT_ORIGIN}/g/${candidateRef}/project`,
  }
}

/**
 * Extract project reference and chat ID from a ChatGPT URL if present.
 */
export function parseChatGptConversationUrl(url: string): ParsedChatGptConversation | null {
  try {
    const parsed = new URL(url)
    if (parsed.origin !== CHATGPT_ORIGIN) return null
    const chatMatch = CONVERSATION_PATH_PATTERN.exec(parsed.pathname)
    if (!chatMatch || !chatMatch[1]) return null
    const chatId = chatMatch[1]

    const projMatch = PROJECT_PATH_PATTERN.exec(parsed.pathname)
    const projectRef = projMatch && projMatch[1] ? projMatch[1] : undefined

    return {
      ...(projectRef ? { projectRef } : {}),
      chatId,
    }
  } catch {
    return null
  }
}

export interface DiscoveredProjectItem {
  name: string
  href?: string
  url?: string
}

/**
 * Attempt to match an ND project name or prefix against a list of projects found
 * on https://chatgpt.com/projects.
 * Evaluates:
 * 1. Exact name match (case-insensitive)
 * 2. Prefix match (e.g. project name starts with or is prefix of item name)
 * 3. URL slug match (e.g. href slug contains the project name)
 */
export function matchProjectByNameOrPrefix(
  projectName: string,
  items: DiscoveredProjectItem[],
): (ParsedChatGptProject & { name: string }) | null {
  const target = projectName.trim().toLowerCase()
  if (!target) return null

  // 1. Exact match on name
  for (const item of items) {
    const cleanName = item.name.trim().toLowerCase()
    const rawLink = item.href || item.url || ''
    if (cleanName === target && rawLink) {
      const parsed = parseChatGptProjectInput(rawLink)
      if (parsed) return { ...parsed, name: item.name.trim() }
    }
  }

  // 2. Prefix match on name
  for (const item of items) {
    const cleanName = item.name.trim().toLowerCase()
    const rawLink = item.href || item.url || ''
    if ((cleanName.startsWith(target) || target.startsWith(cleanName)) && rawLink) {
      const parsed = parseChatGptProjectInput(rawLink)
      if (parsed) return { ...parsed, name: item.name.trim() }
    }
  }

  // 3. Slug match on href
  for (const item of items) {
    const rawLink = item.href || item.url || ''
    if (!rawLink) continue
    const parsed = parseChatGptProjectInput(rawLink)
    if (parsed?.slug && (parsed.slug.toLowerCase() === target || parsed.slug.toLowerCase().startsWith(target))) {
      return { ...parsed, name: item.name.trim() }
    }
  }

  return null
}
