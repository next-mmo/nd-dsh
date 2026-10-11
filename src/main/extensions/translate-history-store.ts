import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { ND_TRANSLATE_MAX_TEXT, isBrowserTranslateProvider, isLlmProvider, type NdTranslateHistoryEntry } from '../../shared/nd-translate.js'

interface StoredEntry extends NdTranslateHistoryEntry {
  contextKey: string
}

interface Snapshot {
  version: 1
  entries: StoredEntry[]
}

const MAX_ENTRIES = 200

export class TranslateHistoryStore {
  private loaded = false
  private value: Snapshot = { version: 1, entries: [] }
  private saveChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await this.load()
  }

  async list(contextKey: string): Promise<NdTranslateHistoryEntry[]> {
    await this.load()
    return this.value.entries
      .filter((entry) => entry.contextKey === contextKey)
      .map(({ contextKey: _ignored, ...entry }) => structuredClone(entry))
  }

  async add(contextKey: string, entry: Omit<NdTranslateHistoryEntry, 'id' | 'createdAt'>): Promise<NdTranslateHistoryEntry> {
    await this.load()
    const record: StoredEntry = { ...entry, id: randomUUID(), contextKey, createdAt: Date.now() }
    this.value.entries.unshift(record)
    if (this.value.entries.length > MAX_ENTRIES) this.value.entries.length = MAX_ENTRIES
    await this.persist()
    const { contextKey: _ignored, ...saved } = record
    return structuredClone(saved)
  }

  async remove(contextKey: string, id?: string): Promise<number> {
    await this.load()
    const before = this.value.entries.length
    this.value.entries = this.value.entries.filter((entry) =>
      id === undefined
        ? entry.contextKey !== contextKey
        : !(entry.contextKey === contextKey && entry.id === id))
    const removed = before - this.value.entries.length
    if (removed) await this.persist()
    return removed
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<Snapshot>
      if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
        this.value = { version: 1, entries: parsed.entries.filter(validEntry).slice(0, MAX_ENTRIES) }
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

function validEntry(value: unknown): value is StoredEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<StoredEntry>
  return typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 64
    && typeof entry.contextKey === 'string' && entry.contextKey.length <= 256
    && typeof entry.text === 'string' && entry.text.length <= ND_TRANSLATE_MAX_TEXT
    && typeof entry.translatedText === 'string' && entry.translatedText.length <= ND_TRANSLATE_MAX_TEXT
    && typeof entry.sourceLanguage === 'string' && entry.sourceLanguage.length <= 16
    && typeof entry.targetLanguage === 'string' && entry.targetLanguage.length <= 16
    && typeof entry.provider === 'string' && entry.provider.length <= 128
    && (isBrowserTranslateProvider(entry.provider) || isLlmProvider(entry.provider))
    && (entry.model === undefined || (typeof entry.model === 'string' && entry.model.length <= 128))
    && typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
}
