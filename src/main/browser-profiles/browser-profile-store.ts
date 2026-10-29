import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import {
  BROWSER_PROFILE_COLORS,
  DEFAULT_BROWSER_PROFILE_ID,
} from '../../shared/browser-platform.js'
import { quarantineFile } from '../logging/log-file.js'

/** Electron partition that held the whole browser before profiles existed. */
const LEGACY_BROWSER_PARTITION = 'persist:nd-dsh-browser'
const PROFILE_PARTITION_PREFIX = 'persist:nd-dsh-browser-'

const MAX_PROFILES = 20
const MAX_NAME_LENGTH = 40
const DEFAULT_PROFILE_NAME = 'Default'
const DEFAULT_PROFILE_COLOR = '#65717b'
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const PROFILE_COLOR_PATTERN = /^#[0-9a-f]{6}$/i

export interface BrowserProfileRecord {
  id: string
  name: string
  color: string
  createdAt: number
  updatedAt: number
}

interface Snapshot {
  version: 1
  profiles: BrowserProfileRecord[]
  activeId: string
  defaultId: string
}

/**
 * Chrome-style browser identities for ND's embedded browser.
 *
 * The seeded `default` profile keeps the historical `persist:nd-dsh-browser`
 * partition, so existing cookies and signed-in ChatGPT/Gemini Web sessions
 * survive the upgrade. Every other profile gets its own Chromium partition,
 * meaning its own cookies, localStorage, IndexedDB and cache.
 */
export class BrowserProfileStore {
  private loaded = false
  private loadPromise: Promise<void> | undefined
  private saveChain: Promise<void> = Promise.resolve()
  private value: Snapshot

  constructor(private readonly filePath: string) {
    this.value = seededSnapshot()
  }

  async initialize(): Promise<void> {
    await this.load()
  }

  async list(): Promise<BrowserProfileRecord[]> {
    await this.load()
    return structuredClone(this.value.profiles)
  }

  /** Sync snapshot for state rendered on every browser tick (loaded at boot). */
  listSync(): BrowserProfileRecord[] {
    return structuredClone(this.value.profiles)
  }

  async get(id: string): Promise<BrowserProfileRecord | undefined> {
    await this.load()
    return this.value.profiles.find((item) => item.id === id)
  }

  /** Sync name lookup for descriptors rendered on every browser state tick. */
  profileName(id: string): string {
    return this.value.profiles.find((item) => item.id === id)?.name ?? DEFAULT_PROFILE_NAME
  }

  /** Profile the browser shows now; persisted so a relaunch resumes it. */
  activeProfileId(): string {
    return this.value.activeId
  }

  /** Profile ND falls back to (fresh start, deleted active profile, global default). */
  defaultProfileId(): string {
    return this.value.defaultId
  }

  async setActive(id: string): Promise<void> {
    await this.load()
    this.requireProfile(id)
    if (this.value.activeId === id) return
    this.value.activeId = id
    await this.save()
  }

  async create(name: string, color?: string): Promise<BrowserProfileRecord> {
    await this.load()
    if (this.value.profiles.length >= MAX_PROFILES) {
      throw new Error(`ND supports up to ${MAX_PROFILES} browser profiles`)
    }
    const cleanName = normalizeName(name)
    this.assertUniqueName(cleanName)
    const now = Date.now()
    const record: BrowserProfileRecord = {
      id: randomUUID(),
      name: cleanName,
      color: normalizeColor(color) ?? nextProfileColor(this.value.profiles),
      createdAt: now,
      updatedAt: now,
    }
    this.value.profiles.push(record)
    await this.save()
    return structuredClone(record)
  }

  async update(id: string, input: { name?: string | undefined; color?: string | undefined }): Promise<BrowserProfileRecord> {
    await this.load()
    const record = this.requireProfile(id)
    if (input.name !== undefined) {
      const cleanName = normalizeName(input.name)
      this.assertUniqueName(cleanName, id)
      record.name = cleanName
    }
    if (input.color !== undefined) {
      const color = normalizeColor(input.color)
      if (!color) throw new Error('Browser profile color must be a #rrggbb value')
      record.color = color
    }
    record.updatedAt = Date.now()
    await this.save()
    return structuredClone(record)
  }

  async setDefault(id: string): Promise<void> {
    await this.load()
    this.requireProfile(id)
    if (this.value.defaultId === id) return
    this.value.defaultId = id
    await this.save()
  }

  async remove(id: string): Promise<boolean> {
    await this.load()
    if (id === DEFAULT_BROWSER_PROFILE_ID) throw new Error('The default browser profile cannot be deleted')
    const index = this.value.profiles.findIndex((item) => item.id === id)
    if (index < 0) return false
    this.value.profiles.splice(index, 1)
    if (this.value.defaultId === id) this.value.defaultId = DEFAULT_BROWSER_PROFILE_ID
    if (this.value.activeId === id) this.value.activeId = this.value.defaultId
    await this.save()
    return true
  }

  private requireProfile(id: string): BrowserProfileRecord {
    const record = this.value.profiles.find((item) => item.id === id)
    if (!record) throw new Error('Browser profile not found')
    return record
  }

  private assertUniqueName(name: string, ignoreId?: string): void {
    const key = name.toLowerCase()
    if (this.value.profiles.some((item) => item.id !== ignoreId && item.name.toLowerCase() === key)) {
      throw new Error(`A browser profile named "${name}" already exists`)
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = this.loadFromDisk().finally(() => { this.loadPromise = undefined })
    return this.loadPromise
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object') throw new Error('browser profile file is not an object')
      const record = parsed as Record<string, unknown>
      if (record.version !== 1) throw new Error('browser profile file has an unsupported schema')
      const profiles = sanitizeProfiles(record.profiles)
      if (!profiles.some((item) => item.id === DEFAULT_BROWSER_PROFILE_ID)) {
        profiles.unshift(seedDefaultProfile())
      }
      const defaultId = typeof record.defaultId === 'string' && profiles.some((item) => item.id === record.defaultId)
        ? record.defaultId
        : DEFAULT_BROWSER_PROFILE_ID
      const activeId = typeof record.activeId === 'string' && profiles.some((item) => item.id === record.activeId)
        ? record.activeId
        : defaultId
      this.value = { version: 1, profiles, activeId, defaultId }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Starting empty and persisting over an unreadable file would erase the
        // user's profile list; keep the file aside for recovery instead.
        await quarantineFile(this.filePath, error)
      }
      this.value = seededSnapshot()
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    const snapshot = structuredClone(this.value)
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`
    const write = this.saveChain.catch(() => undefined).then(async () => {
      await fs.mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600 })
        await fs.rename(temp, this.filePath)
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
    })
    this.saveChain = write
    return write
  }
}

/** Chromium partition for a profile record; the default keeps existing data. */
export function browserProfilePartition(profileId: string): string {
  const clean = profileId.trim()
  if (!PROFILE_ID_PATTERN.test(clean)) throw new Error('Browser profile id is invalid')
  if (clean === DEFAULT_BROWSER_PROFILE_ID) return LEGACY_BROWSER_PARTITION
  return `${PROFILE_PARTITION_PREFIX}${clean}`
}

export function isBrowserProfileId(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_ID_PATTERN.test(value.trim())
}

function seededSnapshot(): Snapshot {
  return {
    version: 1,
    profiles: [seedDefaultProfile()],
    activeId: DEFAULT_BROWSER_PROFILE_ID,
    defaultId: DEFAULT_BROWSER_PROFILE_ID,
  }
}

function seedDefaultProfile(): BrowserProfileRecord {
  const now = Date.now()
  return {
    id: DEFAULT_BROWSER_PROFILE_ID,
    name: DEFAULT_PROFILE_NAME,
    color: DEFAULT_PROFILE_COLOR,
    createdAt: now,
    updatedAt: now,
  }
}

function sanitizeProfiles(raw: unknown): BrowserProfileRecord[] {
  if (!Array.isArray(raw)) return []
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  const profiles: BrowserProfileRecord[] = []
  for (const item of raw.slice(0, MAX_PROFILES)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const candidate = item as Record<string, unknown>
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    if (!PROFILE_ID_PATTERN.test(id) || seenIds.has(id)) continue
    const name = typeof candidate.name === 'string' ? candidate.name.trim().slice(0, MAX_NAME_LENGTH) : ''
    if (!name || seenNames.has(name.toLowerCase())) continue
    const createdAt = finiteNumber(candidate.createdAt) ?? Date.now()
    profiles.push({
      id,
      name,
      color: normalizeColor(candidate.color) ?? DEFAULT_PROFILE_COLOR,
      createdAt,
      updatedAt: finiteNumber(candidate.updatedAt) ?? createdAt,
    })
    seenIds.add(id)
    seenNames.add(name.toLowerCase())
  }
  return profiles
}

function normalizeName(value: string): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) throw new Error('Browser profile name is required')
  if (name.length > MAX_NAME_LENGTH) throw new Error(`Browser profile name exceeds ${MAX_NAME_LENGTH} characters`)
  return name
}

function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const color = value.trim().toLowerCase()
  return PROFILE_COLOR_PATTERN.test(color) ? color : undefined
}

function nextProfileColor(profiles: BrowserProfileRecord[]): string {
  const used = new Set(profiles.map((item) => item.color.toLowerCase()))
  return BROWSER_PROFILE_COLORS.find((color) => !used.has(color)) ?? BROWSER_PROFILE_COLORS[0]
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
