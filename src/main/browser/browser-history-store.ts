import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { BrowserHistoryEntry } from '../../shared/browser-platform.js'
import { DEFAULT_BROWSER_PROFILE_ID } from '../../shared/browser-platform.js'

interface Snapshot {
  version: 1
  entries: BrowserHistoryEntry[]
}

const MAX_HISTORY = 5_000

export class BrowserHistoryStore {
  private loaded = false
  private value: Snapshot = { version: 1, entries: [] }
  private saveChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async list(targetId?: string, profileId?: string): Promise<BrowserHistoryEntry[]> {
    await this.load()
    return structuredClone(
      this.value.entries
        .filter((entry) => !targetId || entry.targetId === targetId)
        .filter((entry) => !profileId || entry.profileId === profileId)
        .sort((a, b) => b.visitedAt - a.visitedAt),
    )
  }

  async record(input: Omit<BrowserHistoryEntry, 'id' | 'visitedAt' | 'profileId'> & { visitedAt?: number; profileId?: string | undefined }): Promise<BrowserHistoryEntry> {
    await this.load()
    const url = input.url.trim()
    if (!url || url === 'about:blank') throw new Error('Browser history URL is invalid')
    const entry: BrowserHistoryEntry = {
      id: randomUUID(),
      targetId: input.targetId,
      tabId: input.tabId,
      url,
      title: input.title.trim().slice(0, 512) || url,
      visitedAt: input.visitedAt ?? Date.now(),
      profileId: input.profileId ?? DEFAULT_BROWSER_PROFILE_ID,
    }
    this.value.entries.unshift(entry)
    if (this.value.entries.length > MAX_HISTORY) this.value.entries.length = MAX_HISTORY
    await this.persist()
    return structuredClone(entry)
  }

  async clear(input: { targetId?: string; origin?: string; profileId?: string } = {}): Promise<number> {
    await this.load()
    const before = this.value.entries.length
    this.value.entries = this.value.entries.filter((entry) => {
      if (input.profileId && entry.profileId !== input.profileId) return true
      if (input.targetId && entry.targetId !== input.targetId) return true
      if (input.origin) {
        try {
          if (new URL(entry.url).origin !== input.origin) return true
        } catch {
          return true
        }
      }
      return false
    })
    const removed = before - this.value.entries.length
    if (removed > 0) await this.persist()
    return removed
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<Snapshot>
      if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
        this.value = {
          version: 1,
          entries: parsed.entries.filter(validEntry).slice(0, MAX_HISTORY).map((entry) => ({
            ...entry,
            profileId: typeof entry.profileId === 'string' && entry.profileId ? entry.profileId : DEFAULT_BROWSER_PROFILE_ID,
          })),
        }
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    const payload = `${JSON.stringify(this.value, null, 2)}\n`
    const operation = this.saveChain.catch(() => undefined).then(async () => {
      await fs.mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temp, payload, { encoding: 'utf8', mode: 0o600 })
        await fs.rename(temp, this.filePath)
      } catch (cause) {
        await fs.rm(temp, { force: true }).catch(() => undefined)
        throw cause
      }
    })
    this.saveChain = operation
    await operation
  }
}

function validEntry(value: unknown): value is BrowserHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as BrowserHistoryEntry
  return typeof entry.id === 'string'
    && typeof entry.targetId === 'string'
    && typeof entry.tabId === 'string'
    && typeof entry.url === 'string'
    && typeof entry.title === 'string'
    && typeof entry.visitedAt === 'number'
    && (entry.profileId === undefined || typeof entry.profileId === 'string')
}
