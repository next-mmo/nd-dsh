import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { lookup as dnsLookup } from 'node:dns'
import { basename, isAbsolute, join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import {
  COLLECTION_ENTRIES_MAX,
  COLLECTIONS_MAX,
  COLLECTION_NAME_MAX,
  WALLPAPER_LINKS_MAX,
  WALLPAPER_LINKS_SCHEMA,
  WALLPAPER_LINK_TITLE_MAX,
  isPrivateHostname,
  normalizeWallpaperCategory,
  parseWallpaperLinkUrl,
  parseWallpaperLinksBundle,
  type WallpaperCollection,
  type WallpaperCollectionEntry,
  type WallpaperCollectionItemInput,
  type WallpaperLink,
  type WallpaperLinkSeed,
  type WallpaperLinksBundle,
} from '../../shared/wallpaper-links.js'
import { SUPPORTED_WALLPAPER_EXTENSIONS } from './wallpaper.js'

const lookupAsync = promisify(dnsLookup)

/** Wallpapers can legitimately be large; this bounds how much we will cache. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 3

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
}

export function linkIdForUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16)
}

/** Stable identity for a collection entry, derived from what it points at. */
export function collectionEntryId(kind: 'link' | 'file', ref: string): string {
  return createHash('sha256').update(`${kind}:${ref}`).digest('hex').slice(0, 16)
}

/** A collection file entry must be an absolute path to a supported image. */
export function validateCollectionFileRef(ref: string): string {
  const trimmed = ref.trim()
  if (!trimmed) throw new Error('Missing image path')
  if (!isAbsolute(trimmed)) throw new Error('Only images from your folders can be collected')
  if (!SUPPORTED_WALLPAPER_EXTENSIONS.has(basename(trimmed).match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? '')) {
    throw new Error('That file is not a supported wallpaper image')
  }
  return trimmed
}

export function cachePathForUrl(cacheDir: string, url: string, extension: string): string {
  return join(cacheDir, `${linkIdForUrl(url)}${extension}`)
}

/**
 * Finds a previously downloaded image for a URL without fetching. The
 * content-addressed name is known but the extension comes from the response,
 * so probe the small set of types we accept.
 */
export async function findCachedImage(cacheDir: string, url: string): Promise<{ path: string; size: number; modifiedAt: number } | null> {
  for (const extension of Object.values(EXTENSION_BY_CONTENT_TYPE)) {
    const candidate = cachePathForUrl(cacheDir, url, extension)
    try {
      const fileStat = await fs.stat(candidate)
      return { path: candidate, size: fileStat.size, modifiedAt: fileStat.mtimeMs }
    } catch {
      // Try the next extension.
    }
  }
  return null
}

function titleForUrl(url: URL): string {
  const segments = url.pathname.split('/').filter(Boolean)
  const last = segments[segments.length - 1]
  if (last && last.includes('.')) return decodeURIComponent(last).slice(0, 200)
  return url.hostname
}

export interface WallpaperLinkDownloadResult {
  path: string
  size: number
  contentType: string
}

export interface WallpaperLinkDownloadDeps {
  fetchImpl?: typeof fetch
  lookup?: (hostname: string) => Promise<{ address: string }[]>
  maxBytes?: number
  cacheDir: string
}

class DownloadError extends Error {}

/**
 * Resolve every address for a hostname and refuse the fetch if any of them is
 * loopback or private. DNS rebinding means the hostname check at validation
 * time is not enough — the connection target itself must be verified.
 */
async function assertPublicHost(url: URL, deps: WallpaperLinkDownloadDeps): Promise<void> {
  const doLookup = deps.lookup ?? (async (hostname: string) => lookupAsync(hostname, { all: true, verbatim: true }))
  const addresses = await doLookup(url.hostname).catch(() => {
    throw new DownloadError(`Could not resolve ${url.hostname}`)
  })
  if (!addresses || addresses.length === 0) throw new DownloadError(`Could not resolve ${url.hostname}`)
  for (const { address } of addresses) {
    if (isPrivateHostname(address)) {
      throw new DownloadError('That link points at a local or private network address, which ND does not fetch')
    }
  }
}

async function fetchImageResponse(
  url: URL,
  deps: WallpaperLinkDownloadDeps,
): Promise<{ response: Response; finalUrl: URL }> {
  const fetchImpl = deps.fetchImpl ?? fetch
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== 'https:') throw new DownloadError('Only https:// image links are supported')
    await assertPublicHost(current, deps)
    const response = await fetchImpl(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { Accept: 'image/png,image/jpeg,image/webp,image/bmp' },
    }).catch((cause: unknown) => {
      throw new DownloadError(`Could not download the image: ${cause instanceof Error ? cause.message : String(cause)}`)
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      void response.body?.cancel().catch(() => undefined)
      if (!location) throw new DownloadError('The link redirected without a destination')
      if (hop === MAX_REDIRECTS) throw new DownloadError('The link redirected too many times')
      current = new URL(location, current)
      continue
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      throw new DownloadError(`The link returned HTTP ${response.status}`)
    }
    return { response, finalUrl: current }
  }
  throw new DownloadError('The link redirected too many times')
}

/**
 * Download a remote wallpaper image into the local cache.
 *
 * Everything about this is bounded on purpose: https only, public hosts only
 * (verified against DNS, not just the URL string), image content types only,
 * a hard size cap enforced while streaming, and a timeout. The file lands
 * under a content-addressed name so repeated adds of the same link reuse one
 * cached file.
 */
export async function downloadWallpaperImage(url: string, deps: WallpaperLinkDownloadDeps): Promise<WallpaperLinkDownloadResult> {
  const parsed = parseWallpaperLinkUrl(url)
  const { response } = await fetchImageResponse(parsed, deps)

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  const extension = EXTENSION_BY_CONTENT_TYPE[contentType]
  if (!extension) {
    void response.body?.cancel().catch(() => undefined)
    throw new DownloadError(`That link is not a supported image (got ${contentType || 'unknown type'}; PNG, JPEG, WebP, and BMP are supported)`)
  }

  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES
  const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    void response.body?.cancel().catch(() => undefined)
    throw new DownloadError(`The image is too large (${Math.round(declaredLength / (1024 * 1024))} MB; the limit is ${Math.round(maxBytes / (1024 * 1024))} MB)`)
  }

  await fs.mkdir(deps.cacheDir, { recursive: true })
  const target = cachePathForUrl(deps.cacheDir, parsed.toString(), extension)
  const temp = `${target}.download-${process.pid}-${Date.now()}`
  let written = 0
  const handle = await fs.open(temp, 'w')
  try {
    const reader = response.body!.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      written += value.byteLength
      if (written > maxBytes) throw new DownloadError(`The image is too large (the limit is ${Math.round(maxBytes / (1024 * 1024))} MB)`)
      await handle.write(value)
    }
    await handle.close()
    // A zero-byte body is a broken server, not a wallpaper.
    if (written === 0) throw new DownloadError('The link returned an empty image')
    await fs.rename(temp, target)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await fs.unlink(temp).catch(() => undefined)
    throw error
  }
  return { path: target, size: written, contentType }
}

/** Filesystem paths for the read-only ND-curated bundle shipped with the app. */
export function bundledWallpaperLinksPath(paths: { appPath: string; resourcesPath?: string | undefined }): string {
  return paths.resourcesPath
    ? join(paths.resourcesPath, 'nd-bundles', 'wallpaper-links.json')
    : join(paths.appPath, 'resources', 'nd-bundles', 'wallpaper-links.json')
}

export function bundledWallpaperLinksWithSource(raw: string): WallpaperLink[] {
  const bundle = parseWallpaperLinksBundle(JSON.parse(raw))
  return bundle.links.map((seed) => bundledLinkFromSeed(seed))
}

export function bundledLinkFromSeed(seed: WallpaperLinkSeed): WallpaperLink {
  const url = parseWallpaperLinkUrl(seed.url).toString()
  const thumbUrl = seed.thumb ? parseWallpaperLinkUrl(seed.thumb).toString() : undefined
  return {
    id: `bundle-${linkIdForUrl(url)}`,
    url,
    title: seed.title || titleForUrl(new URL(url)),
    source: 'bundle',
    addedAt: 0,
    ...(thumbUrl ? { thumbUrl } : {}),
    ...(seed.category ? { category: seed.category } : {}),
  }
}

/**
 * Dev-only curation of the shipped ND bundle document. Unpacked builds write
 * `resources/nd-bundles/wallpaper-links.json` in place so a curation pass lands
 * as a normal git diff; packaged builds never reach these helpers.
 */
export interface BundledWallpaperLinkEdit {
  url?: string
  title?: string
  thumb?: string
  category?: string
}

/** Read + parse the bundle document; a missing file starts as an empty doc. */
export async function readWallpaperLinksBundle(filePath: string): Promise<WallpaperLinksBundle> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schema: WALLPAPER_LINKS_SCHEMA, name: 'ND Curated Wallpaper Links', links: [] }
    }
    throw error
  }
  return parseWallpaperLinksBundle(JSON.parse(raw))
}

/**
 * Re-validate the serialized document before writing, so a bad edit never lands
 * on disk. Entries keep the shipped one-per-line style so a curation pass diffs
 * as exactly the lines that changed.
 */
export async function writeWallpaperLinksBundle(filePath: string, bundle: WallpaperLinksBundle): Promise<void> {
  const entry = (seed: WallpaperLinkSeed): string => {
    const parts = [`"url": ${JSON.stringify(seed.url)}`]
    if (seed.thumb) parts.push(`"thumb": ${JSON.stringify(seed.thumb)}`)
    parts.push(`"title": ${JSON.stringify(seed.title)}`)
    if (seed.category) parts.push(`"category": ${JSON.stringify(seed.category)}`)
    return `    { ${parts.join(', ')} }`
  }
  const head = [`  "schema": ${JSON.stringify(bundle.schema)}`, `  "name": ${JSON.stringify(bundle.name)}`]
  if (bundle.description) head.push(`  "description": ${JSON.stringify(bundle.description)}`)
  const linksBlock = bundle.links.length > 0 ? `[\n${bundle.links.map(entry).join(',\n')}\n  ]` : '[]'
  // One line per curated collection so curation diffs stay readable.
  const collectionsBlock = bundle.collections && bundle.collections.length > 0
    ? `[\n${bundle.collections.map((collection) => {
        const entries = collection.entries
          .map((seed) => `      { "kind": ${JSON.stringify(seed.kind)}, "ref": ${JSON.stringify(seed.ref)}, "title": ${JSON.stringify(seed.title)}${seed.id ? `, "id": ${JSON.stringify(seed.id)}` : ''} }`)
          .join(',\n')
        return `    { "id": ${JSON.stringify(collection.id ?? '')}, "name": ${JSON.stringify(collection.name)}, "createdAt": ${JSON.stringify(collection.createdAt ?? 0)}, "entries": [\n${entries}\n    ] }`
      }).join(',\n')}\n  ]`
    : null
  // Keep whatever line endings the checkout already uses, so a curation pass
  // never shows up as whole-file EOL churn in git.
  let eol = '\n'
  try {
    if ((await fs.readFile(filePath, 'utf8')).includes('\r\n')) eol = '\r\n'
  } catch {
    // First write for a missing file; LF is fine.
  }
  const payload = `{\n${head.join(',\n')},\n  "links": ${linksBlock}${collectionsBlock ? `,\n  "collections": ${collectionsBlock}` : ''}\n}\n`.replace(/\n/g, eol)
  parseWallpaperLinksBundle(JSON.parse(payload))
  await fs.mkdir(join(filePath, '..'), { recursive: true })
  await fs.writeFile(filePath, payload, 'utf8')
}

export async function addBundledWallpaperLink(filePath: string, edit: BundledWallpaperLinkEdit): Promise<WallpaperLinksBundle> {
  const bundle = await readWallpaperLinksBundle(filePath)
  const url = parseWallpaperLinkUrl(edit.url ?? '').toString()
  if (bundle.links.some((seed) => seed.url === url)) throw new Error('That link is already in the ND bundle')
  if (bundle.links.length >= WALLPAPER_LINKS_MAX) {
    throw new Error(`The ND bundle is full (max ${WALLPAPER_LINKS_MAX} links); remove some before adding more`)
  }
  const thumb = edit.thumb?.trim() ? parseWallpaperLinkUrl(edit.thumb).toString() : undefined
  const category = normalizeWallpaperCategory(edit.category)
  bundle.links.push({
    url,
    title: (edit.title?.trim() || titleForUrl(new URL(url))).slice(0, WALLPAPER_LINK_TITLE_MAX),
    ...(thumb ? { thumb } : {}),
    ...(category ? { category } : {}),
  })
  await writeWallpaperLinksBundle(filePath, bundle)
  return bundle
}

export async function updateBundledWallpaperLink(filePath: string, currentUrl: string, edit: BundledWallpaperLinkEdit): Promise<WallpaperLinksBundle> {
  const bundle = await readWallpaperLinksBundle(filePath)
  const normalized = parseWallpaperLinkUrl(currentUrl).toString()
  const seed = bundle.links.find((entry) => entry.url === normalized)
  if (!seed) throw new Error('That ND bundle link no longer exists')
  if (edit.url !== undefined && edit.url.trim() !== '') {
    const next = parseWallpaperLinkUrl(edit.url).toString()
    if (next !== normalized && bundle.links.some((entry) => entry.url === next)) {
      throw new Error('That link is already in the ND bundle')
    }
    seed.url = next
  }
  if (edit.title !== undefined) seed.title = (edit.title.trim() || titleForUrl(new URL(seed.url))).slice(0, WALLPAPER_LINK_TITLE_MAX)
  if (edit.thumb !== undefined) {
    const thumb = edit.thumb.trim() ? parseWallpaperLinkUrl(edit.thumb).toString() : undefined
    if (thumb) seed.thumb = thumb
    else delete seed.thumb
  }
  if (edit.category !== undefined) {
    const category = normalizeWallpaperCategory(edit.category)
    if (category) seed.category = category
    else delete seed.category
  }
  await writeWallpaperLinksBundle(filePath, bundle)
  return bundle
}

export async function removeBundledWallpaperLink(filePath: string, currentUrl: string): Promise<{ removed: boolean; bundle: WallpaperLinksBundle }> {
  const bundle = await readWallpaperLinksBundle(filePath)
  const normalized = parseWallpaperLinkUrl(currentUrl).toString()
  const before = bundle.links.length
  bundle.links = bundle.links.filter((entry) => entry.url !== normalized)
  if (bundle.links.length === before) return { removed: false, bundle }
  await writeWallpaperLinksBundle(filePath, bundle)
  return { removed: true, bundle }
}

/**
 * Mirror the user's collections into the bundle document (dev builds only, the
 * caller gates on `app.isPackaged`). File entries are dropped: a curated
 * collection ships link entries only, since an absolute local path would be
 * meaningless on anyone else's machine.
 */
export async function writeBundledCollections(filePath: string, collections: WallpaperCollection[]): Promise<WallpaperLinksBundle> {
  const bundle = await readWallpaperLinksBundle(filePath)
  bundle.collections = collections.slice(0, COLLECTIONS_MAX).map((collection) => ({
    id: collection.id,
    name: collection.name.slice(0, COLLECTION_NAME_MAX),
    createdAt: collection.createdAt,
    entries: collection.entries
      .filter((entry) => entry.kind === 'link')
      .slice(0, COLLECTION_ENTRIES_MAX)
      .map((entry) => ({ id: entry.id, kind: 'link' as const, ref: entry.ref, title: entry.title })),
  }))
  await writeWallpaperLinksBundle(filePath, bundle)
  return bundle
}

/**
 * Owns the user's saved links in `<userData>/wallpaper-links.json`.
 *
 * A document that cannot be parsed is moved aside with a `.corrupt-<ts>`
 * suffix rather than deleted, so a bad write can never silently destroy a
 * user's curated collection.
 */
export class WallpaperLinkStore {
  private links: WallpaperLink[] = []
  private collections: WallpaperCollection[] = []
  private ready: Promise<void> | null = null

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  initialize(): Promise<void> {
    this.ready ??= this.read()
    return this.ready
  }

  private async read(): Promise<void> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch {
      return // First run; nothing saved yet.
    }
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed?.links)) throw new Error('links array missing')
      this.links = parsed.links
        .filter((entry: unknown): entry is WallpaperLink => {
          if (!entry || typeof entry !== 'object') return false
          const item = entry as WallpaperLink
          return typeof item.id === 'string' && typeof item.url === 'string' && typeof item.title === 'string'
        })
        .map((entry: WallpaperLink) => ({ ...entry, source: 'user' as const }))
      this.collections = Array.isArray(parsed.collections)
        ? parsed.collections
          .filter((entry: unknown): entry is WallpaperCollection => {
            if (!entry || typeof entry !== 'object') return false
            const item = entry as WallpaperCollection
            return typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.entries)
          })
          .map((entry: WallpaperCollection) => ({
            ...entry,
            entries: entry.entries.filter((item) => item
              && typeof item.id === 'string'
              && (item.kind === 'link' || item.kind === 'file')
              && typeof item.ref === 'string'),
          }))
        : []
    } catch {
      const backup = `${this.filePath}.corrupt-${Date.now()}`
      await fs.rename(this.filePath, backup).catch(() => undefined)
      this.links = []
      this.collections = []
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(join(this.filePath, '..'), { recursive: true })
    const payload = JSON.stringify({ schema: 'nd.wallpaper-links/1', links: this.links, collections: this.collections }, null, 2)
    await fs.writeFile(this.filePath, payload, 'utf8')
  }

  list(): WallpaperLink[] {
    return this.links.map((link) => ({ ...link }))
  }

  /** Adds a validated link, or returns the existing entry for that URL. */
  async add(url: string, title?: string, cached?: { path: string; size: number }, thumbUrl?: string): Promise<{ link: WallpaperLink; created: boolean }> {
    const normalized = parseWallpaperLinkUrl(url).toString()
    const existing = this.links.find((link) => link.url === normalized)
    if (existing) {
      if (cached) this.applyCache(existing, cached)
      await this.persist()
      return { link: { ...existing }, created: false }
    }
    if (this.links.length >= WALLPAPER_LINKS_MAX) {
      throw new Error(`The link list is full (max ${WALLPAPER_LINKS_MAX} links); remove some before adding more`)
    }
    const link: WallpaperLink = {
      id: linkIdForUrl(normalized),
      url: normalized,
      title: (title?.trim() || titleForUrl(new URL(normalized))).slice(0, 200),
      source: 'user',
      addedAt: this.now(),
      ...(thumbUrl ? { thumbUrl } : {}),
      ...(cached ? { cachedPath: cached.path, cachedSize: cached.size, cachedAt: this.now() } : {}),
    }
    this.links.push(link)
    await this.persist()
    return { link: { ...link }, created: true }
  }

  applyCache(existing: WallpaperLink, cached: { path: string; size: number }): void {
    existing.cachedPath = cached.path
    existing.cachedSize = cached.size
    existing.cachedAt = this.now()
  }

  async recordCache(id: string, cached: { path: string; size: number }): Promise<WallpaperLink | null> {
    const link = this.links.find((entry) => entry.id === id)
    if (!link) return null
    this.applyCache(link, cached)
    await this.persist()
    return { ...link }
  }

  async remove(id: string): Promise<{ removed: boolean; cachedPath?: string }> {
    const index = this.links.findIndex((link) => link.id === id)
    if (index < 0) return { removed: false }
    const [link] = this.links.splice(index, 1)
    // A link that is gone cannot appear in a collection; drop it everywhere.
    if (link) {
      let purged = false
      for (const collection of this.collections) {
        const before = collection.entries.length
        collection.entries = collection.entries.filter((entry) => !(entry.kind === 'link' && entry.ref === link.url))
        if (collection.entries.length !== before) purged = true
      }
      if (purged) {
        await this.persist()
        return { removed: true, ...(link.cachedPath ? { cachedPath: link.cachedPath } : {}) }
      }
    }
    await this.persist()
    return { removed: true, ...(link?.cachedPath ? { cachedPath: link.cachedPath } : {}) }
  }

  /** Merges bundle-format seeds; existing URLs are skipped, not duplicated. */
  async importLinks(seeds: WallpaperLinkSeed[]): Promise<{ added: number; skipped: number }> {
    let added = 0
    let skipped = 0
    for (const seed of seeds) {
      const normalized = parseWallpaperLinkUrl(seed.url).toString()
      if (this.links.some((link) => link.url === normalized)) {
        skipped += 1
        continue
      }
      if (this.links.length >= WALLPAPER_LINKS_MAX) break
      const thumbUrl = seed.thumb ? parseWallpaperLinkUrl(seed.thumb).toString() : undefined
      this.links.push({
        id: linkIdForUrl(normalized),
        url: normalized,
        title: (seed.title || titleForUrl(new URL(normalized))).slice(0, 200),
        source: 'user',
        addedAt: this.now(),
        ...(thumbUrl ? { thumbUrl } : {}),
      })
      added += 1
    }
    if (added > 0) await this.persist()
    return { added, skipped }
  }

  /** The user's own links in the same document format the ND bundle uses. */
  exportBundle(): { schema: 'nd.wallpaper-links/1'; name: string; links: WallpaperLinkSeed[] } {
    return {
      schema: 'nd.wallpaper-links/1',
      name: 'My wallpaper links',
      links: this.links.map((link) => ({
        url: link.url,
        title: link.title,
        ...(link.thumbUrl ? { thumb: link.thumbUrl } : {}),
      })),
    }
  }

  find(id: string): WallpaperLink | null {
    const link = this.links.find((entry) => entry.id === id)
    return link ? { ...link } : null
  }

  // --- Collections -------------------------------------------------------------

  listCollections(): WallpaperCollection[] {
    return this.collections.map((collection) => ({ ...collection, entries: collection.entries.map((entry) => ({ ...entry })) }))
  }

  findCollection(id: string): WallpaperCollection | null {
    const collection = this.collections.find((entry) => entry.id === id)
    return collection ? { ...collection, entries: collection.entries.map((item) => ({ ...item })) } : null
  }

  async createCollection(name: string): Promise<WallpaperCollection> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Enter a collection name')
    if (this.collections.length >= COLLECTIONS_MAX) throw new Error(`Too many collections (max ${COLLECTIONS_MAX})`)
    if (this.collections.some((collection) => collection.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error(`A collection named “${trimmed.slice(0, COLLECTION_NAME_MAX)}” already exists`)
    }
    const collection: WallpaperCollection = {
      id: `col-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      name: trimmed.slice(0, COLLECTION_NAME_MAX),
      createdAt: this.now(),
      entries: [],
    }
    this.collections.push(collection)
    await this.persist()
    return { ...collection, entries: [] }
  }

  async deleteCollection(id: string): Promise<{ deleted: boolean }> {
    const index = this.collections.findIndex((collection) => collection.id === id)
    if (index < 0) return { deleted: false }
    this.collections.splice(index, 1)
    await this.persist()
    return { deleted: true }
  }

  /**
   * Adds items to a collection, deduplicating by what they point at. Link
   * items must be valid https URLs; file items must be absolute paths to
   * supported images (existence is checked when one is applied).
   */
  async addToCollection(id: string, items: WallpaperCollectionItemInput[]): Promise<{ added: number; skipped: number; collection: WallpaperCollection | null }> {
    const collection = this.collections.find((entry) => entry.id === id)
    if (!collection) throw new Error('That collection no longer exists')
    let added = 0
    let skipped = 0
    for (const item of items) {
      if (collection.entries.length >= COLLECTION_ENTRIES_MAX) break
      let ref: string
      if (item.kind === 'link') {
        ref = parseWallpaperLinkUrl(item.ref).toString()
      } else if (item.kind === 'file') {
        ref = validateCollectionFileRef(item.ref)
      } else {
        skipped += 1
        continue
      }
      const entryId = collectionEntryId(item.kind, ref)
      const existing = collection.entries.find((entry) => entry.id === entryId)
      if (existing) {
        // Refresh the label so a better title sticks; the entry itself stays.
        const title = item.title?.trim()
        if (title && title !== existing.title) {
          existing.title = title.slice(0, 200)
          added += 1
        }
        skipped += 1
        continue
      }
      collection.entries.push({
        id: entryId,
        kind: item.kind,
        ref,
        title: (item.title?.trim() || (item.kind === 'link' ? new URL(ref).hostname : basename(ref))).slice(0, 200),
        addedAt: this.now(),
      })
      added += 1
    }
    if (added > 0) await this.persist()
    return { added, skipped, collection: { ...collection, entries: collection.entries.map((entry) => ({ ...entry })) } }
  }

  async removeFromCollection(id: string, entryId: string): Promise<{ removed: boolean }> {
    const collection = this.collections.find((entry) => entry.id === id)
    if (!collection) return { removed: false }
    const index = collection.entries.findIndex((entry) => entry.id === entryId)
    if (index < 0) return { removed: false }
    collection.entries.splice(index, 1)
    await this.persist()
    return { removed: true }
  }
}
