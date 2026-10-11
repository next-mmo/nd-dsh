import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * A real tab of the ND built-in browser that this package's chrome opened.
 * The descriptor mirrors the live engine tab; the store keeps only enough to
 * restore it after the app restarts (sleeping tabs resume by URL).
 */
export interface MiniBrowserTab {
  id: string
  url: string
  title: string
  openedAt: number
  lastActiveAt: number
}

/** A saved quick link: one click to open in a new browser tab. */
export interface MiniLink {
  id: string
  url: string
  title: string
  addedAt: number
}

interface Snapshot {
  version: 1
  tabs: MiniBrowserTab[]
  links: MiniLink[]
}

const URL_MAX = 2_048
const TITLE_MAX = 300
const MAX_TABS = 24
const MAX_LINKS = 120

/** Acceptable href for a browser tab: any http(s) URL — YouTube included, nothing scheme-weird. */
export function browserTabUrl(text: string): string | undefined {
  let candidate: URL
  try {
    candidate = new URL(text.trim())
  } catch {
    return undefined
  }
  if (candidate.protocol !== 'https:' && candidate.protocol !== 'http:') return undefined
  if (!candidate.hostname || candidate.hostname.includes(' ') || candidate.hostname.length > 253) return undefined
  const normalized = candidate.toString()
  return normalized.length <= URL_MAX ? normalized : undefined
}

/** Host-ish label for chrome rows when no title is known yet. */
export function miniTabTitle(text: string, url: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (trimmed && !/^https?:\/\//i.test(trimmed)) return trimmed.slice(0, TITLE_MAX)
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Host-side validation for bridge inputs: the broker relays, the host checks. */
export function asMiniEntryId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new Error('Entry id must be a non-empty string')
  }
  return value
}

/**
 * Durable session + quick links for the Mini ND Browser chrome. One JSON file
 * in userData, written atomically; a corrupt file falls back to defaults
 * because an open-tab list is never worth failing an extension view over.
 */
export class MiniBrowserStore {
  private loaded = false
  private value: Snapshot = { version: 1, tabs: [], links: [] }
  private saveChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    /** Parent folder of the legacy YouTube queue file; migrated into links once. */
    private readonly legacyQueuePath: string | undefined = undefined,
  ) {}

  async tabs(): Promise<MiniBrowserTab[]> {
    await this.load()
    return structuredClone(this.value.tabs)
  }

  async links(): Promise<MiniLink[]> {
    await this.load()
    return structuredClone(this.value.links)
  }

  /** Records a live engine tab in the session (upsert by engine tab id). */
  async rememberTab(id: string, url: string, title: string): Promise<MiniBrowserTab[]> {
    const entry: MiniBrowserTab = {
      id,
      url,
      title: miniTabTitle(title, url),
      openedAt: Date.now(),
      lastActiveAt: Date.now(),
    }
    await this.load()
    this.value.tabs = [{ ...entry }, ...this.value.tabs.filter((item) => item.id !== entry.id)].slice(0, MAX_TABS)
    await this.persist()
    return structuredClone(this.value.tabs)
  }

  async touchTab(id: string): Promise<MiniBrowserTab[]> {
    await this.load()
    this.value.tabs = this.value.tabs.map((item) => (item.id === id ? { ...item, lastActiveAt: Date.now() } : item))
    await this.persist()
    return structuredClone(this.value.tabs)
  }

  async forgetTab(id: string): Promise<MiniBrowserTab[]> {
    await this.load()
    this.value.tabs = this.value.tabs.filter((item) => item.id !== id)
    await this.persist()
    return structuredClone(this.value.tabs)
  }

  async saveLink(url: string, title: string): Promise<MiniLink[]> {
    const href = browserTabUrl(url)
    if (!href) throw new Error('That does not look like a website link')
    await this.load()
    const entry: MiniLink = {
      id: `link:${randomUUID()}`,
      url: href,
      title: miniTabTitle(title, href),
      addedAt: Date.now(),
    }
    const rest = this.value.links.filter((item) => item.url !== entry.url)
    rest.unshift(entry)
    this.value.links = rest.slice(0, MAX_LINKS)
    await this.persist()
    return structuredClone(this.value.links)
  }

  async removeLink(id: string): Promise<MiniLink[]> {
    await this.load()
    this.value.links = this.value.links.filter((item) => item.id !== id)
    await this.persist()
    return structuredClone(this.value.links)
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<Snapshot>
      if (Array.isArray(raw.tabs)) {
        this.value.tabs = raw.tabs
          .filter((entry): entry is MiniBrowserTab => {
            return typeof entry?.id === 'string' && entry.id.length > 0 && entry.id.length <= 200
              && typeof entry?.url === 'string' && browserTabUrl(entry.url) !== undefined
              && typeof entry?.title === 'string' && entry.title.length > 0 && entry.title.length <= URL_MAX
              && typeof entry?.openedAt === 'number' && Number.isFinite(entry.openedAt)
              && typeof entry?.lastActiveAt === 'number' && Number.isFinite(entry.lastActiveAt)
          })
          .slice(0, MAX_TABS)
      }
      if (Array.isArray(raw.links)) {
        this.value.links = raw.links
          .filter((entry): entry is MiniLink => {
            return typeof entry?.id === 'string' && entry.id.length > 0 && entry.id.length <= 200
              && typeof entry?.url === 'string' && browserTabUrl(entry.url) !== undefined
              && typeof entry?.title === 'string' && entry.title.length > 0 && entry.title.length <= URL_MAX
              && typeof entry?.addedAt === 'number' && Number.isFinite(entry.addedAt)
          })
          .slice(0, MAX_LINKS)
      }
    } catch {
      // Missing or corrupt file: start from the default snapshot.
    }
    await this.migrateLegacyYouTubeQueue()
  }

  /** The package's former life as YouTube Mini: fold the old queue into quick links once. */
  private async migrateLegacyYouTubeQueue(): Promise<void> {
    if (!this.legacyQueuePath || this.value.links.length > 0) return
    try {
      const raw = JSON.parse(await fs.readFile(this.legacyQueuePath, 'utf8')) as { entries?: unknown }
      if (!Array.isArray(raw.entries)) return
      const links = raw.entries
        .filter((entry): entry is MiniLink => {
          return typeof (entry as MiniLink)?.url === 'string' && browserTabUrl((entry as MiniLink).url) !== undefined
            && typeof (entry as MiniLink)?.title === 'string' && (entry as MiniLink).title.length > 0
            && typeof (entry as MiniLink)?.addedAt === 'number' && Number.isFinite((entry as MiniLink).addedAt)
        })
        .map((entry) => ({ ...entry, id: `link:${randomUUID()}` }))
        .filter((entry, index, all) => all.findIndex((other) => other.url === entry.url) === index)
        .slice(0, MAX_LINKS)
      if (links.length === 0) return
      this.value.links = links
      await this.persist()
    } catch {
      // No legacy file or unreadable: nothing to migrate.
    }
  }

  private async persist(): Promise<void> {
    const snapshot: Snapshot = { version: 1, tabs: this.value.tabs, links: this.value.links }
    const previous = this.saveChain
    this.saveChain = previous.then(async () => {
      await fs.mkdir(dirname(this.filePath), { recursive: true })
      await fs.writeFile(this.filePath, JSON.stringify(snapshot, null, 2), 'utf8')
    }).catch(() => undefined)
    await this.saveChain
  }
}

/** Legacy queue location delegate: `<userData>/nd-youtube-mini/queue.json`. */
export function legacyYouTubeQueuePath(userData: string): string {
  return join(userData, 'nd-youtube-mini', 'queue.json')
}
