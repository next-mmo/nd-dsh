import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { BrowserCredentialSummary } from '../../shared/browser-platform.js'
import { DEFAULT_BROWSER_PROFILE_ID } from '../../shared/browser-platform.js'

interface StoredCredential extends BrowserCredentialSummary {
  encryptedPassword: string
}

interface Snapshot {
  version: 1
  credentials: StoredCredential[]
}

export class BrowserCredentialVault {
  private loaded = false
  private value: Snapshot = { version: 1, credentials: [] }
  private saveChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  available(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  async list(profileId?: string): Promise<BrowserCredentialSummary[]> {
    await this.load()
    return this.value.credentials
      .filter((item) => !profileId || item.profileId === profileId)
      .map(({ encryptedPassword: _encryptedPassword, ...summary }) => structuredClone(summary))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async save(input: { origin: string; username: string; password: string; label?: string | undefined }, profileId = DEFAULT_BROWSER_PROFILE_ID): Promise<BrowserCredentialSummary> {
    await this.load()
    if (!this.available()) throw new Error('Secure browser credential storage is unavailable on this machine')
    const origin = normalizeOrigin(input.origin)
    const username = input.username.trim().slice(0, 512)
    const password = input.password
    if (!username) throw new Error('Browser credential username is required')
    if (!password || password.length > 32_768) throw new Error('Browser credential password is invalid')

    const now = Date.now()
    const existing = this.value.credentials.find((item) =>
      item.origin === origin && item.username === username && item.profileId === profileId)
    const encryptedPassword = safeStorage.encryptString(password).toString('base64')
    const record: StoredCredential = existing
      ? {
          ...existing,
          ...(input.label?.trim() ? { label: input.label.trim().slice(0, 256) } : {}),
          encryptedPassword,
          updatedAt: now,
        }
      : {
          id: randomUUID(),
          origin,
          username,
          profileId,
          ...(input.label?.trim() ? { label: input.label.trim().slice(0, 256) } : {}),
          encryptedPassword,
          createdAt: now,
          updatedAt: now,
        }

    if (existing) {
      this.value.credentials[this.value.credentials.indexOf(existing)] = record
    } else {
      this.value.credentials.push(record)
    }
    await this.persist()
    return summary(record)
  }

  async remove(id: string): Promise<boolean> {
    await this.load()
    const index = this.value.credentials.findIndex((item) => item.id === id)
    if (index < 0) return false
    this.value.credentials.splice(index, 1)
    await this.persist()
    return true
  }

  async secret(id: string, expectedOrigin?: string, expectedProfileId?: string): Promise<{ summary: BrowserCredentialSummary; password: string }> {
    await this.load()
    if (!this.available()) throw new Error('Secure browser credential storage is unavailable on this machine')
    const record = this.value.credentials.find((item) => item.id === id)
    if (!record) throw new Error('Browser credential not found')
    if (expectedOrigin && normalizeOrigin(expectedOrigin) !== record.origin) {
      throw new Error('Browser credential belongs to a different origin')
    }
    if (expectedProfileId && (record.profileId ?? DEFAULT_BROWSER_PROFILE_ID) !== expectedProfileId) {
      throw new Error('Browser credential belongs to a different browser profile')
    }
    const encrypted = Buffer.from(record.encryptedPassword, 'base64')
    const password = safeStorage.decryptString(encrypted)
    return { summary: summary(record), password }
  }

  /** Drop every saved login owned by a deleted profile. */
  async removeProfile(profileId: string): Promise<number> {
    await this.load()
    const before = this.value.credentials.length
    this.value.credentials = this.value.credentials.filter((item) => item.profileId !== profileId)
    const removed = before - this.value.credentials.length
    if (removed) await this.persist()
    return removed
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<Snapshot>
      if (parsed?.version === 1 && Array.isArray(parsed.credentials)) {
        this.value = {
          version: 1,
          credentials: parsed.credentials.filter(validStoredCredential).map((item) => ({
            ...item,
            profileId: typeof item.profileId === 'string' && item.profileId ? item.profileId : DEFAULT_BROWSER_PROFILE_ID,
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

function summary(record: StoredCredential): BrowserCredentialSummary {
  const { encryptedPassword: _encryptedPassword, ...value } = record
  return structuredClone(value)
}

function normalizeOrigin(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Browser credential origin must be a valid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Browser credentials require an http/https origin')
  return parsed.origin
}

function validStoredCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== 'object') return false
  const record = value as StoredCredential
  return typeof record.id === 'string'
    && typeof record.origin === 'string'
    && typeof record.username === 'string'
    && typeof record.encryptedPassword === 'string'
    && typeof record.createdAt === 'number'
    && typeof record.updatedAt === 'number'
    && (record.profileId === undefined || typeof record.profileId === 'string')
}
