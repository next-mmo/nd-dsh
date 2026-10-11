/**
 * Remote wallpaper links for the Wallpaper Studio Discovery surface.
 *
 * Links are URLs only — never uploaded binaries — so the data stays small
 * enough for a JSON document rather than a database. The same document shape
 * doubles as the interchange format: a user's own links can be exported and
 * re-imported (or shared) as a bundle file.
 */

export const WALLPAPER_LINKS_SCHEMA = 'nd.wallpaper-links/1'

export const WALLPAPER_LINKS_MAX = 500
export const WALLPAPER_LINK_TITLE_MAX = 200
export const WALLPAPER_LINK_CATEGORY_MAX = 40
export const COLLECTION_NAME_MAX = 80
export const COLLECTIONS_MAX = 50
export const COLLECTION_ENTRIES_MAX = 500

/** Normalize a bundle category label; empty/absent means "uncategorized". */
export function normalizeWallpaperCategory(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.replace(/\s+/g, ' ').trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, WALLPAPER_LINK_CATEGORY_MAX)
}

/** Where a discovered link came from. `bundle` entries are read-only. */
export type WallpaperLinkSource = 'user' | 'bundle'

export interface WallpaperLink {
  id: string
  url: string
  title: string
  source: WallpaperLinkSource
  addedAt: number
  /** Set once the image has been downloaded into the local cache. */
  cachedPath?: string
  cachedSize?: number
  cachedAt?: number
  /** True when this link's cached image is the current desktop wallpaper. */
  active?: boolean
  /**
   * Small preview image for Discovery covers, used by curated bundles so the
   * grid shows real artwork before the full-size wallpaper is downloaded.
   */
  thumbUrl?: string
  /** Curated grouping label ("Nature", "Cities") for bundle filter chips. */
  category?: string
}

export interface WallpaperLinkSeed {
  url: string
  title: string
  thumb?: string
  category?: string
}

export interface WallpaperLinksBundle {
  schema: typeof WALLPAPER_LINKS_SCHEMA
  name: string
  description?: string
  links: WallpaperLinkSeed[]
  /** Curated collections shipped with the bundle; read-only at runtime. */
  collections?: WallpaperCollectionSeed[]
}

/**
 * A user-curated set of wallpapers — "Nature", "Cities" — mixing saved remote
 * links and local images from their folders. Collections are what make a
 * theme playable: next/random walk the collection, and auto-rotate can be
 * pointed at one so the whole day stays on theme.
 */
export type WallpaperCollectionEntryKind = 'link' | 'file'

export interface WallpaperCollectionEntry {
  id: string
  kind: WallpaperCollectionEntryKind
  /** Remote URL for `link` entries, absolute local path for `file` entries. */
  ref: string
  title: string
  addedAt: number
}

export interface WallpaperCollection {
  id: string
  name: string
  createdAt: number
  entries: WallpaperCollectionEntry[]
  /** `bundle` collections ship in the ND bundle and are read-only. */
  source?: WallpaperLinkSource
}

/**
 * A collection as carried inside the ND bundle document. Curated collections
 * hold link entries only — a shipped absolute file path would be meaningless
 * on anyone else's machine — so file entries are dropped when mirroring.
 */
export interface WallpaperCollectionSeed {
  id?: string
  name: string
  createdAt?: number
  entries: WallpaperCollectionEntrySeed[]
}

/** Bundle collection entries are link-only; ids are filled in by the main process. */
export interface WallpaperCollectionEntrySeed {
  id?: string
  kind: WallpaperCollectionEntryKind
  ref: string
  title: string
}

/** What a "save to collections" action adds; validated in the main process. */
export interface WallpaperCollectionItemInput {
  kind: WallpaperCollectionEntryKind
  ref: string
  title?: string
}

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa']

function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4 || parts.some((part) => part.length === 0 || part.length > 3 || !/^\d+$/.test(part))) return false
  const octets = parts.map((part) => Number.parseInt(part, 10))
  if (octets.some((octet) => octet > 255)) return false
  const [a, b] = octets as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/** The four IPv4 bytes hidden in an IPv4-mapped hex tail like `c0a8:1`, if that is what it is. */
function ipv4FromMappedHexTail(tail: string): string | null {
  const groups = tail.split(':')
  if (groups.length === 0 || groups.length > 3) return null
  const bytes: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    const value = Number.parseInt(group, 16)
    bytes.push((value >> 8) & 0xff, value & 0xff)
  }
  if (bytes.length !== 4) return null
  return bytes.join('.')
}

function isPrivateIPv6(host: string): boolean {
  const address = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (address === '::' || address === '::1') return true
  if (address.startsWith('fc') || address.startsWith('fd')) return true // fc00::/7 unique local
  if (address.startsWith('fe8') || address.startsWith('fe9') || address.startsWith('fea') || address.startsWith('feb')) return true // fe80::/10 link-local
  if (address.startsWith('::ffff:')) {
    // IPv4-mapped addresses arrive in dotted or hex form depending on who
    // wrote them; URL normalization turns the dotted form into hex.
    const tail = address.slice('::ffff:'.length)
    if (tail.includes('.')) return isPrivateIPv4(tail)
    const mapped = ipv4FromMappedHexTail(tail)
    return mapped ? isPrivateIPv4(mapped) : false
  }
  return false
}

/**
 * Hostnames the desktop must never fetch on a user's behalf. The renderer can
 * ask the main process to download any stored URL, so loopback and private
 * ranges are refused at validation time and again at DNS resolution time.
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return true
  if (host === 'localhost' || BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  if (host.includes(':')) return isPrivateIPv6(host)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateIPv4(host)
  return false
}

/**
 * Validate a user- or bundle-supplied link. Only public HTTPS image links are
 * accepted; anything else fails with a message written for the person who
 * pasted the URL.
 */
export function parseWallpaperLinkUrl(raw: string): URL {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('Enter an image URL')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('That is not a valid URL')
  }
  if (url.protocol !== 'https:') throw new Error('Only https:// image links are supported')
  if (url.username || url.password) throw new Error('Links with embedded credentials are not allowed')
  if (isPrivateHostname(url.hostname)) throw new Error('Links to local or private network addresses are not allowed')
  if (url.port && url.port !== '443') throw new Error('Only the standard HTTPS port (443) is supported')
  return url
}

/** Validate an imported or bundled links document; returns the usable seeds. */
export function parseWallpaperLinksBundle(raw: unknown): WallpaperLinksBundle {
  if (!raw || typeof raw !== 'object') throw new Error('Not a wallpaper links file')
  const record = raw as Record<string, unknown>
  if (record.schema !== WALLPAPER_LINKS_SCHEMA) {
    throw new Error(`Unsupported links file format (expected ${WALLPAPER_LINKS_SCHEMA})`)
  }
  const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim().slice(0, 200) : 'Wallpaper links'
  const description = typeof record.description === 'string' ? record.description.slice(0, 500) : undefined
  if (!Array.isArray(record.links)) throw new Error('The links file has no links array')
  const links: WallpaperLinkSeed[] = []
  const seen = new Set<string>()
  for (const entry of record.links) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    if (typeof item.url !== 'string') continue
    let url: URL
    try {
      url = parseWallpaperLinkUrl(item.url)
    } catch {
      continue // One bad entry must not sink an otherwise usable bundle.
    }
    const key = url.toString()
    if (seen.has(key)) continue
    seen.add(key)
    // A broken thumb URL must not sink its link; the cover just falls back to
    // the placeholder until the full image is downloaded.
    let thumb: string | undefined
    if (typeof item.thumb === 'string' && item.thumb.trim()) {
      try {
        thumb = parseWallpaperLinkUrl(item.thumb).toString()
      } catch {
        thumb = undefined
      }
    }
    const seed: WallpaperLinkSeed = {
      url: key,
      title: typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, WALLPAPER_LINK_TITLE_MAX) : url.hostname,
    }
    if (thumb) seed.thumb = thumb
    const category = normalizeWallpaperCategory(item.category)
    if (category) seed.category = category
    links.push(seed)
  }
  const collections = parseBundleCollections(record.collections)
  return {
    schema: WALLPAPER_LINKS_SCHEMA,
    name,
    ...(description ? { description } : {}),
    links,
    ...(collections.length ? { collections } : {}),
  }
}

/**
 * Curated collections inside a bundle document. Link entries only: a shipped
 * absolute file path would point at somebody else's disk, so file entries are
 * dropped here rather than failing the collection.
 */
function parseBundleCollections(raw: unknown): WallpaperCollectionSeed[] {
  if (!Array.isArray(raw)) return []
  const collections: WallpaperCollectionSeed[] = []
  const seenNames = new Set<string>()
  for (const entry of raw.slice(0, COLLECTIONS_MAX)) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const collectionName = typeof item.name === 'string' ? item.name.trim().slice(0, COLLECTION_NAME_MAX) : ''
    if (!collectionName || seenNames.has(collectionName.toLowerCase())) continue
    seenNames.add(collectionName.toLowerCase())
    const entries: WallpaperCollectionEntrySeed[] = []
    const seenRefs = new Set<string>()
    for (const rawEntry of Array.isArray(item.entries) ? item.entries.slice(0, COLLECTION_ENTRIES_MAX) : []) {
      if (!rawEntry || typeof rawEntry !== 'object') continue
      const candidate = rawEntry as Record<string, unknown>
      if (candidate.kind !== 'link' || typeof candidate.ref !== 'string') continue
      let ref: string
      try {
        ref = parseWallpaperLinkUrl(candidate.ref).toString()
      } catch {
        continue
      }
      if (seenRefs.has(ref)) continue
      seenRefs.add(ref)
      entries.push({
        ...(typeof candidate.id === 'string' && candidate.id.trim() ? { id: candidate.id.trim().slice(0, 64) } : {}),
        kind: 'link',
        ref,
        title: typeof candidate.title === 'string' && candidate.title.trim() ? candidate.title.trim().slice(0, WALLPAPER_LINK_TITLE_MAX) : new URL(ref).hostname,
      })
    }
    collections.push({
      ...(typeof item.id === 'string' && item.id.trim() ? { id: item.id.trim().slice(0, 64) } : {}),
      name: collectionName,
      ...(typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? { createdAt: item.createdAt } : {}),
      entries,
    })
  }
  return collections
}
