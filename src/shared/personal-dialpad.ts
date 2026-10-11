/**
 * The Personal browser dialpad.
 *
 * ND's personal browser opens on a speed dial: the sites personal use actually
 * starts from, plus whatever the user saved. Tiles are pure data so the
 * renderer, the store, and the tests all agree on one list, and a saved link
 * always replaces the built-in tile for the same address instead of doubling it.
 */

export interface DialpadSite {
  id: string
  title: string
  url: string
}

/** ND's built-in speed dial — the sites a personal browser should reach in one click. */
export const PERSONAL_DIALPAD_SITES: readonly DialpadSite[] = [
  { id: 'google', title: 'Google', url: 'https://www.google.com/' },
  { id: 'youtube', title: 'YouTube', url: 'https://www.youtube.com/' },
  { id: 'gmail', title: 'Gmail', url: 'https://mail.google.com/' },
  { id: 'maps', title: 'Maps', url: 'https://www.google.com/maps' },
  { id: 'translate', title: 'Translate', url: 'https://translate.google.com/' },
  { id: 'wikipedia', title: 'Wikipedia', url: 'https://www.wikipedia.org/' },
  { id: 'github', title: 'GitHub', url: 'https://github.com/' },
  { id: 'x', title: 'X', url: 'https://x.com/' },
  { id: 'reddit', title: 'Reddit', url: 'https://www.reddit.com/' },
]

export interface DialpadTile {
  id: string
  title: string
  url: string
  /** `saved` tiles are the user's own links and can be removed from the dialpad. */
  kind: 'site' | 'saved'
}

/** Comparable form of an address: no trailing slash, no hash, lowercase host. */
function addressKey(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`.toLowerCase()
  } catch {
    return url.trim().toLowerCase()
  }
}

/** Short label for a saved tile: the typed title, else the host without `www.`. */
export function dialpadSiteLabel(url: string, title?: string): string {
  const typed = title?.trim()
  if (typed) return typed.slice(0, 120)
  try {
    return new URL(url).hostname.replace(/^www\./, '').slice(0, 120) || url
  } catch {
    return url.slice(0, 120)
  }
}

/**
 * The dialpad's tiles: the user's saved links first (newest first, as stored),
 * then the built-in top sites that the saved links do not already cover.
 */
export function dialpadTiles(saved: readonly { id: string; url: string; title: string }[]): DialpadTile[] {
  const savedTiles: DialpadTile[] = saved.map((link) => ({
    id: link.id,
    title: dialpadSiteLabel(link.url, link.title),
    url: link.url,
    kind: 'saved',
  }))
  const covered = new Set(savedTiles.map((tile) => addressKey(tile.url)))
  const builtIn: DialpadTile[] = PERSONAL_DIALPAD_SITES
    .filter((site) => !covered.has(addressKey(site.url)))
    .map((site) => ({ id: `site:${site.id}`, title: site.title, url: site.url, kind: 'site' }))
  return [...savedTiles, ...builtIn]
}
