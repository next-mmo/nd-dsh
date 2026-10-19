import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

export const ACCOUNT_STATUSES = ['planned', 'awaiting-code', 'active', 'disabled'] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]

/**
 * Account metadata only. Credentials and verification codes never enter this
 * store: passwords belong in ND Vault, and codes are entered by the user
 * directly on the service's page.
 */
export interface ManagedAccount {
  id: string
  service: string
  email: string
  username: string
  mailboxUrl: string
  siteUrl: string
  status: AccountStatus
  notes: string
  createdAt: number
  updatedAt: number
}

export interface AccountInput {
  service: string
  email: string
  username?: string
  mailboxUrl?: string
  siteUrl?: string
  status?: AccountStatus
  notes?: string
}

interface Snapshot {
  version: 1
  accounts: ManagedAccount[]
}

const SERVICE_MAX = 80
const EMAIL_MAX = 320
const USERNAME_MAX = 320
const URL_MAX = 2_048
const NOTES_MAX = 10_000
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export function asAccountStatus(value: unknown): AccountStatus {
  if (typeof value === 'string' && (ACCOUNT_STATUSES as readonly string[]).includes(value)) {
    return value as AccountStatus
  }
  throw new Error(`Status must be one of: ${ACCOUNT_STATUSES.join(', ')}`)
}

export function asAccountId(value: unknown): string {
  const id = text(value, 'Account id', 128)
  if (!id) throw new Error('Account id is required')
  return id
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new Error(`${label} must be at most ${max} characters`)
  if (CONTROL_CHARS.test(trimmed)) throw new Error(`${label} must not contain control characters`)
  return trimmed
}

function httpUrl(value: unknown, label: string): string {
  const raw = text(value, label, URL_MAX)
  if (!raw) return ''
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${label} must be an http(s) URL`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${label} must be an http(s) URL`)
  }
  return parsed.toString()
}

function email(value: unknown): string {
  const address = text(value, 'Email', EMAIL_MAX)
  if (!address || !/^[^\s@]+@[^\s@]+$/.test(address) || address.includes('..')) {
    throw new Error('Email must be a valid address')
  }
  return address
}

function normalizeCreate(input: Record<string, unknown>): AccountInput {
  const service = text(input.service, 'Service', SERVICE_MAX)
  if (!service) throw new Error('Service is required')
  return {
    service,
    email: email(input.email),
    username: text(input.username ?? '', 'Username', USERNAME_MAX),
    mailboxUrl: httpUrl(input.mailboxUrl ?? '', 'Mailbox URL'),
    siteUrl: httpUrl(input.siteUrl ?? '', 'Site URL'),
    status: input.status === undefined ? 'planned' : asAccountStatus(input.status),
    notes: text(input.notes ?? '', 'Notes', NOTES_MAX),
  }
}

/** Patch semantics: omitted fields keep their current value, provided ones are validated. */
function normalizePatch(input: Record<string, unknown>): Partial<AccountInput> {
  const patch: Partial<AccountInput> = {}
  if (input.service !== undefined) {
    const service = text(input.service, 'Service', SERVICE_MAX)
    if (!service) throw new Error('Service is required')
    patch.service = service
  }
  if (input.email !== undefined) patch.email = email(input.email)
  if (input.username !== undefined) patch.username = text(input.username, 'Username', USERNAME_MAX)
  if (input.mailboxUrl !== undefined) patch.mailboxUrl = httpUrl(input.mailboxUrl, 'Mailbox URL')
  if (input.siteUrl !== undefined) patch.siteUrl = httpUrl(input.siteUrl, 'Site URL')
  if (input.status !== undefined) patch.status = asAccountStatus(input.status)
  if (input.notes !== undefined) patch.notes = text(input.notes, 'Notes', NOTES_MAX)
  return patch
}

/**
 * Local account inventory for the Account Manager web view. One JSON file in
 * userData, written atomically. It stores service/email/status metadata only;
 * secrets stay in ND Vault and verification codes are never persisted.
 */
export class AccountMgtStore {
  private loaded = false
  private accounts: ManagedAccount[] = []
  private saveChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async list(query?: string): Promise<ManagedAccount[]> {
    await this.load()
    const needle = typeof query === 'string' ? query.trim().toLowerCase().slice(0, 200) : ''
    return this.accounts
      .filter((account) => !needle || [account.service, account.email, account.username, account.notes]
        .some((field) => field.toLowerCase().includes(needle)))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((account) => structuredClone(account))
  }

  async create(input: Record<string, unknown>): Promise<ManagedAccount> {
    await this.load()
    const normalized = normalizeCreate(input)
    const now = Date.now()
    const account: ManagedAccount = {
      id: randomUUID(),
      service: normalized.service,
      email: normalized.email,
      username: normalized.username ?? '',
      mailboxUrl: normalized.mailboxUrl ?? '',
      siteUrl: normalized.siteUrl ?? '',
      status: normalized.status ?? 'planned',
      notes: normalized.notes ?? '',
      createdAt: now,
      updatedAt: now,
    }
    this.accounts.push(account)
    await this.persist()
    return structuredClone(account)
  }

  async update(id: unknown, input: Record<string, unknown>): Promise<ManagedAccount> {
    await this.load()
    const accountId = asAccountId(id)
    const index = this.accounts.findIndex((account) => account.id === accountId)
    if (index === -1) throw new Error('That account record no longer exists')
    const current = this.accounts[index]!
    const patch = normalizePatch(input)
    const next: ManagedAccount = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    }
    this.accounts[index] = next
    await this.persist()
    return structuredClone(next)
  }

  async delete(id: unknown): Promise<boolean> {
    await this.load()
    const accountId = asAccountId(id)
    const before = this.accounts.length
    this.accounts = this.accounts.filter((account) => account.id !== accountId)
    if (this.accounts.length === before) return false
    await this.persist()
    return true
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<Snapshot>
      if (parsed?.version === 1 && Array.isArray(parsed.accounts)) {
        this.accounts = parsed.accounts.filter(validAccount)
      }
    } catch {
      // Missing or unreadable: start empty. A save rewrites the file atomically.
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    const snapshot: Snapshot = { version: 1, accounts: this.accounts }
    const payload = `${JSON.stringify(snapshot, null, 2)}\n`
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

function validAccount(value: unknown): value is ManagedAccount {
  if (!value || typeof value !== 'object') return false
  const account = value as Partial<ManagedAccount>
  return typeof account.id === 'string' && account.id.length > 0
    && typeof account.service === 'string' && account.service.length > 0
    && typeof account.email === 'string' && account.email.length > 0
    && typeof account.username === 'string'
    && typeof account.mailboxUrl === 'string'
    && typeof account.siteUrl === 'string'
    && typeof account.status === 'string' && (ACCOUNT_STATUSES as readonly string[]).includes(account.status)
    && typeof account.notes === 'string'
    && typeof account.createdAt === 'number' && Number.isFinite(account.createdAt)
    && typeof account.updatedAt === 'number' && Number.isFinite(account.updatedAt)
}
