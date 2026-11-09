import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { quarantineFile } from '../logging/log-file.js'
import { normalizeTotpSecret } from './access-totp.js'

const MAX_ACCOUNTS = 20
const MAX_EMAIL_LENGTH = 320
const MAX_LABEL_LENGTH = 80
const MAX_SECRET_LENGTH = 512
const DEFAULT_IMAP_HOST = 'imap.gmail.com'
const DEFAULT_IMAP_PORT = 993
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const HOST_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i

export interface AccessAccountSummary {
  id: string
  email: string
  label: string
  imapHost: string
  imapPort: number
  hasPassword: boolean
  hasTotp: boolean
  createdAt: number
  updatedAt: number
}

export interface AccessAccountSecrets {
  appPassword: string
  totpSecret?: string
}

interface StoredAccessAccount {
  id: string
  email: string
  label: string
  imapHost: string
  imapPort: number
  encryptedPassword: string
  encryptedTotp?: string
  createdAt: number
  updatedAt: number
}

interface Snapshot {
  version: 1
  accounts: StoredAccessAccount[]
}

export interface AccessAccountInput {
  email: string
  label?: string | undefined
  appPassword: string
  totpSecret?: string | undefined
  imapHost?: string | undefined
  imapPort?: number | undefined
}

export interface AccessAccountPatch {
  label?: string | undefined
  appPassword?: string | undefined
  totpSecret?: string | undefined
  imapHost?: string | undefined
  imapPort?: number | undefined
}

/**
 * ND Access secrets live only in this sealed store. The file holds OS-encrypted
 * blobs (Windows DPAPI via safeStorage); no renderer, agent, CLI, or REST route
 * can read them. Only the access.* host methods decrypt in-process, and they
 * return derived results (mail rows, codes), never the stored secret.
 */
export class AccessStore {
  private loaded = false
  private loadPromise: Promise<void> | undefined
  private saveChain: Promise<void> = Promise.resolve()
  private value: Snapshot = { version: 1, accounts: [] }

  constructor(private readonly filePath: string) {}

  available(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  async list(): Promise<AccessAccountSummary[]> {
    await this.load()
    return this.value.accounts
      .map(summary)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async get(id: string): Promise<AccessAccountSummary> {
    await this.load()
    return summary(this.require(id))
  }

  async create(input: AccessAccountInput): Promise<AccessAccountSummary> {
    await this.load()
    this.requireAvailable()
    if (this.value.accounts.length >= MAX_ACCOUNTS) {
      throw new Error(`ND Access supports up to ${MAX_ACCOUNTS} accounts`)
    }
    const account = this.compose(input)
    if (this.value.accounts.some((item) => item.email === account.email)) {
      throw new Error(`ND Access already has an account for ${account.email}`)
    }
    const now = Date.now()
    const record: StoredAccessAccount = {
      id: randomUUID(),
      ...account,
      createdAt: now,
      updatedAt: now,
    }
    this.value.accounts.push(record)
    await this.persist()
    return summary(record)
  }

  async update(id: string, patch: AccessAccountPatch): Promise<AccessAccountSummary> {
    await this.load()
    this.requireAvailable()
    const record = this.require(id)
    if (patch.label !== undefined) record.label = cleanLabel(patch.label)
    if (patch.imapHost !== undefined) record.imapHost = cleanHost(patch.imapHost)
    if (patch.imapPort !== undefined) record.imapPort = cleanPort(patch.imapPort)
    if (patch.appPassword !== undefined) {
      record.encryptedPassword = encryptSecret(cleanSecret(patch.appPassword, 'Gmail app password'), 'Gmail app password')
    }
    if (patch.totpSecret !== undefined) {
      const secret = patch.totpSecret.trim()
      if (secret) record.encryptedTotp = encryptSecret(normalizeTotpSecret(secret), '2FA secret')
      else delete record.encryptedTotp
    }
    record.updatedAt = Date.now()
    await this.persist()
    return summary(record)
  }

  async remove(id: string): Promise<boolean> {
    await this.load()
    const index = this.value.accounts.findIndex((item) => item.id === id)
    if (index < 0) return false
    this.value.accounts.splice(index, 1)
    await this.persist()
    return true
  }

  /** In-process only. Never expose the result through IPC. */
  async secrets(id: string): Promise<AccessAccountSecrets> {
    await this.load()
    this.requireAvailable()
    const record = this.require(id)
    const appPassword = decryptSecret(record.encryptedPassword, 'Gmail app password')
    const totpSecret = record.encryptedTotp
      ? decryptSecret(record.encryptedTotp, '2FA secret')
      : undefined
    return { appPassword, ...(totpSecret ? { totpSecret } : {}) }
  }

  private compose(input: AccessAccountInput): Omit<StoredAccessAccount, 'id' | 'createdAt' | 'updatedAt'> {
    const email = cleanEmail(input.email)
    const label = cleanLabel(input.label ?? '')
    const appPassword = cleanSecret(input.appPassword, 'Gmail app password')
    const imapHost = cleanHost(input.imapHost ?? DEFAULT_IMAP_HOST)
    const imapPort = cleanPort(input.imapPort ?? DEFAULT_IMAP_PORT)
    const totpRaw = input.totpSecret?.trim() ?? ''
    return {
      email,
      label,
      imapHost,
      imapPort,
      encryptedPassword: encryptSecret(appPassword, 'Gmail app password'),
      ...(totpRaw ? { encryptedTotp: encryptSecret(normalizeTotpSecret(totpRaw), '2FA secret') } : {}),
    }
  }

  private requireAvailable(): void {
    if (!this.available()) {
      throw new Error('Secure local storage is unavailable on this machine; ND Access refuses to store secrets in plaintext')
    }
  }

  private require(id: string): StoredAccessAccount {
    const clean = id.trim()
    if (!clean || clean.length > 64) throw new Error('ND Access account is invalid')
    const record = this.value.accounts.find((item) => item.id === clean)
    if (!record) throw new Error('ND Access account not found')
    return record
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
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('access store is not an object')
      const record = parsed as Record<string, unknown>
      if (record.version !== 1) throw new Error('access store has an unsupported schema')
      this.value = {
        version: 1,
        accounts: sanitizeStoredAccounts(record.accounts),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await quarantineFile(this.filePath, error)
      }
      this.value = { version: 1, accounts: [] }
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    const payload = `${JSON.stringify(this.value, null, 2)}\n`
    this.saveChain = this.saveChain.then(async () => {
      await fs.mkdir(dirname(this.filePath), { recursive: true })
      await fs.writeFile(this.filePath, payload, { encoding: 'utf8', mode: 0o600 })
    })
    return this.saveChain
  }
}

function summary(record: StoredAccessAccount): AccessAccountSummary {
  return {
    id: record.id,
    email: record.email,
    label: record.label,
    imapHost: record.imapHost,
    imapPort: record.imapPort,
    hasPassword: Boolean(record.encryptedPassword),
    hasTotp: Boolean(record.encryptedTotp),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function cleanEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw new Error('Enter a valid mailbox email address')
  }
  return email
}

function cleanLabel(value: string): string {
  const label = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_LABEL_LENGTH)
  return label
}

function cleanHost(value: string): string {
  const host = value.trim().toLowerCase()
  if (!host || host.length > 255 || !HOST_PATTERN.test(host) || host.includes('..')) {
    throw new Error('IMAP host is invalid')
  }
  return host
}

function cleanPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error('IMAP port is invalid')
  return value
}

function cleanSecret(value: string, label: string): string {
  const secret = value.trim()
  if (!secret) throw new Error(`${label} is required`)
  if (secret.length > MAX_SECRET_LENGTH) throw new Error(`${label} is too long`)
  if (secret.includes('\0')) throw new Error(`${label} must not contain NUL`)
  return secret
}

function encryptSecret(value: string, label: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(`Secure local storage is unavailable; cannot store the ${label}`)
  }
  return safeStorage.encryptString(value).toString('base64')
}

function decryptSecret(value: string, label: string): string {
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    throw new Error(`Could not decrypt the ${label}. Save the secret again in ND Access`)
  }
}

function sanitizeStoredAccounts(value: unknown): StoredAccessAccount[] {
  if (!Array.isArray(value)) return []
  const accounts: StoredAccessAccount[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id || record.id.length > 64) continue
    if (typeof record.email !== 'string' || !EMAIL_PATTERN.test(record.email)) continue
    if (typeof record.encryptedPassword !== 'string' || !record.encryptedPassword) continue
    if (typeof record.imapHost !== 'string' || !HOST_PATTERN.test(record.imapHost)) continue
    if (typeof record.imapPort !== 'number' || !Number.isInteger(record.imapPort)) continue
    const createdAt = typeof record.createdAt === 'number' ? record.createdAt : Date.now()
    const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : createdAt
    accounts.push({
      id: record.id,
      email: record.email.toLowerCase(),
      label: typeof record.label === 'string' ? record.label.slice(0, MAX_LABEL_LENGTH) : '',
      imapHost: record.imapHost.toLowerCase(),
      imapPort: record.imapPort,
      encryptedPassword: record.encryptedPassword,
      ...(typeof record.encryptedTotp === 'string' && record.encryptedTotp ? { encryptedTotp: record.encryptedTotp } : {}),
      createdAt,
      updatedAt,
    })
    if (accounts.length >= MAX_ACCOUNTS) break
  }
  return accounts
}
