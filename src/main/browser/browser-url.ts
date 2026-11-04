export const DEFAULT_BROWSER_URL = 'about:blank'

/** Keep Chromium's normal identity without exposing the Electron runtime token. */
export function sanitizeBrowserUserAgent(userAgent: string): string {
  const sanitized = userAgent.replace(/\s+Electron\/[^\s]+/gi, '').trim()
  return sanitized || userAgent
}

const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i
const DOMAIN_WITH_PORT = /^(?:[a-z0-9-]+\.)+[a-z0-9-]+:\d+(?:[/?#]|$)/i
const ALLOWED_EXPLICIT_PROTOCOL = /^(?:https?|about):/i
const EXPLICIT_PROTOCOL = /^([a-z][a-z\d+.-]*):/i

export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return DEFAULT_BROWSER_URL

  let candidate: string
  if (LOOPBACK_HOST.test(trimmed)) {
    candidate = `http://${trimmed}`
  } else if (DOMAIN_WITH_PORT.test(trimmed)) {
    candidate = `https://${trimmed}`
  } else if (ALLOWED_EXPLICIT_PROTOCOL.test(trimmed)) {
    candidate = trimmed
  } else {
    const protocol = trimmed.match(EXPLICIT_PROTOCOL)?.[1]
    if (protocol) throw new Error(`Unsupported browser protocol: ${protocol.toLowerCase()}:`)
    candidate = `https://${trimmed}`
  }

  const parsed = new URL(candidate)
  if (!isAllowedBrowserUrl(parsed.toString())) throw new Error(`Unsupported browser protocol: ${parsed.protocol}`)
  return parsed.toString()
}

export function isAllowedBrowserUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.href === 'about:blank'
  } catch {
    return false
  }
}

/**
 * Chromium rejects `webContents.loadURL` with `ERR_ABORTED (-3)` when the target
 * page immediately redirects or supersedes its own initial load (for example,
 * YouTube's `?themeRefresh=1` bootstrap redirect) or when a newer navigation
 * replaces an in-flight one. That matches `did-fail-load` ignoring `-3`.
 */
export function isNavigationAbortedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { errno?: unknown; code?: unknown; message?: unknown }
  if (candidate.errno === -3 || candidate.code === 'ERR_ABORTED') return true
  return typeof candidate.message === 'string' && /\bERR_ABORTED\b|\(-3\)/.test(candidate.message)
}
