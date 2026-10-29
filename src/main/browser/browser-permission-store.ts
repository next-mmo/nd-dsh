import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { BrowserSitePermission } from '../../shared/browser-platform.js'
import { DEFAULT_BROWSER_PROFILE_ID } from '../../shared/browser-platform.js'

interface Snapshot {
  version: 1
  permissions: BrowserSitePermission[]
}

const MAX_PERMISSIONS = 2_000

export class BrowserPermissionStore {
  private loaded = false
  private value: Snapshot = { version: 1, permissions: [] }
  private saveChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await this.load()
  }

  list(profileId?: string): BrowserSitePermission[] {
    return structuredClone(
      this.value.permissions.filter((item) => !profileId || item.profileId === profileId),
    )
  }

  effect(origin: string, permission: string, profileId = DEFAULT_BROWSER_PROFILE_ID): 'allow' | 'deny' {
    const normalized = normalizeOrigin(origin)
    const record = this.value.permissions.find((item) =>
      item.origin === normalized && item.permission === permission && item.profileId === profileId)
    return record?.effect ?? 'deny'
  }

  async set(origin: string, permission: string, effect: 'allow' | 'deny', profileId = DEFAULT_BROWSER_PROFILE_ID): Promise<BrowserSitePermission> {
    await this.load()
    const normalized = normalizeOrigin(origin)
    const cleanPermission = permission.trim()
    if (!cleanPermission || cleanPermission.length > 128) throw new Error('Browser permission name is invalid')
    const existing = this.value.permissions.find((item) =>
      item.origin === normalized && item.permission === cleanPermission && item.profileId === profileId)
    const record: BrowserSitePermission = {
      origin: normalized,
      permission: cleanPermission,
      effect,
      updatedAt: Date.now(),
      profileId,
    }
    if (existing) this.value.permissions[this.value.permissions.indexOf(existing)] = record
    else this.value.permissions.unshift(record)
    if (this.value.permissions.length > MAX_PERMISSIONS) this.value.permissions.length = MAX_PERMISSIONS
    await this.persist()
    return structuredClone(record)
  }

  async clear(origin?: string, profileId?: string): Promise<number> {
    await this.load()
    if (!origin) {
      const before = this.value.permissions.length
      this.value.permissions = profileId
        ? this.value.permissions.filter((item) => item.profileId !== profileId)
        : []
      const removed = before - this.value.permissions.length
      if (removed) await this.persist()
      return removed
    }
    const normalized = normalizeOrigin(origin)
    const before = this.value.permissions.length
    this.value.permissions = this.value.permissions.filter((item) =>
      item.origin !== normalized || (profileId !== undefined && item.profileId !== profileId))
    const removed = before - this.value.permissions.length
    if (removed) await this.persist()
    return removed
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<Snapshot>
      if (parsed?.version === 1 && Array.isArray(parsed.permissions)) {
        this.value = {
          version: 1,
          permissions: parsed.permissions.filter(validPermission).slice(0, MAX_PERMISSIONS).map((item) => ({
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

function normalizeOrigin(value: string): string {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('Browser permission origin is invalid') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Browser permissions require http/https origins')
  return parsed.origin
}

function validPermission(value: unknown): value is BrowserSitePermission {
  if (!value || typeof value !== 'object') return false
  const record = value as BrowserSitePermission
  return typeof record.origin === 'string'
    && typeof record.permission === 'string'
    && (record.effect === 'allow' || record.effect === 'deny')
    && typeof record.updatedAt === 'number'
    && (record.profileId === undefined || typeof record.profileId === 'string')
}
