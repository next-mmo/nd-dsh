/**
 * ND Mini Browser — pure session-model helpers for the chrome web view.
 *
 * Plain JavaScript with no DOM access so it runs unbuilt inside the sandboxed
 * iframe and stays directly unit-testable from the repo. The host session
 * payload is authoritative; these helpers only shape what the chrome renders
 * and defensive-copy what they trust.
 */

/**
 * @typedef {Object} ChromeTab
 * @property {string} id
 * @property {string} url
 * @property {string} title
 * @property {boolean} active
 * @property {boolean} alive
 * @property {number} lastActiveAt
 */

/**
 * @typedef {Object} QuickLink
 * @property {string} id
 * @property {string} url
 * @property {string} title
 * @property {number} addedAt
 */

const URL_MAX_LENGTH = 2048

/** True when the row looks like a session tab the bridge returned. */
export function isChromeTab(tab) {
  const row = tab
  return Boolean(
    row && typeof row === 'object'
    && typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 200
    && typeof row.url === 'string' && row.url.length > 0 && row.url.length <= URL_MAX_LENGTH
    && typeof row.title === 'string'
    && typeof row.active === 'boolean'
    && typeof row.alive === 'boolean'
    && typeof row.lastActiveAt === 'number' && Number.isFinite(row.lastActiveAt),
  )
}

/** True when the row looks like a quick link the bridge returned. */
export function isQuickLink(link) {
  const row = link
  return Boolean(
    row && typeof row === 'object'
    && typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 200
    && typeof row.url === 'string' && row.url.length > 0 && row.url.length <= URL_MAX_LENGTH
    && typeof row.title === 'string'
    && typeof row.addedAt === 'number' && Number.isFinite(row.addedAt),
  )
}

/** Defensive view of the session payload; unknown shapes become empty lists. */
export function chromeSession(value) {
  const payload = value && typeof value === 'object' ? value : {}
  const tabs = Array.isArray(payload.tabs) ? payload.tabs.filter(isChromeTab) : []
  const links = Array.isArray(payload.links) ? payload.links.filter(isQuickLink) : []
  return { tabs, links }
}

/** Display label for an address: drop www., trim long paths. */
export function describeAddress(url) {
  try {
    const parsed = new URL(url)
    return parsed.hostname.replace(/^www\./, '') + (parsed.pathname.length > 1 ? parsed.pathname : '')
  } catch {
    return url
  }
}

/** 2–3 letter tile badge derived from the hostname (no network, no favicons). */
export function addressBadge(url) {
  try {
    const label = new URL(url).hostname.replace(/^www\./, '').split('.')[0] || 'ND'
    const letters = label.replace(/[^a-zA-Z0-9]/g, '').slice(0, 3)
    return letters ? letters.toUpperCase() : 'ND'
  } catch {
    return 'ND'
  }
}

/** Short display title when the engine has no page title yet (e.g. sleeping tabs). */
export function fallbackTabTitle(url) {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '')
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') {
      const id = parsed.searchParams.get('v') ?? parsed.pathname.split('/')[1] ?? ''
      return id ? `YouTube · ${id.slice(0, 12)}` : 'YouTube'
    }
    return host
  } catch {
    return url
  }
}
