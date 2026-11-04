import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type {
  ComputeAccount,
  ComputeCashSummary,
  ComputeLedgerSnapshot,
  ComputeManagementProjection,
  ComputeReservation,
  ComputeUsageRecord,
} from '../../shared/compute-budget.js'

const DEFAULT_RESERVATION_MS = 30 * 60 * 1_000

interface ComputeStateFile {
  version: 1
  accounts: ComputeAccount[]
  reservations: ComputeReservation[]
  updatedAt: number
}

export interface ComputeReservationInput {
  accountId: string
  companyId: string
  projectId: string
  taskId?: string
  runId?: string
  reservedUsd?: number
  reservedEntitlementRatio?: number
  expiresAt?: number
}

export interface ComputeCashQuery {
  accountId?: string
  companyId?: string
  projectId?: string
  since?: number
}

export class ComputeLedger {
  private loaded = false
  private loadPromise: Promise<void> | undefined
  private accountingKnown = true
  private readonly accounts = new Map<string, ComputeAccount>()
  private readonly records = new Map<string, ComputeUsageRecord>()
  private readonly reservations = new Map<string, ComputeReservation>()
  private appendChain: Promise<void> = Promise.resolve()
  private stateWriteChain: Promise<void> = Promise.resolve()
  private updatedAt = Date.now()

  constructor(
    private readonly usageFilePath: string,
    private readonly stateFilePath = `${usageFilePath}.state.json`,
  ) {}

  async snapshot(): Promise<ComputeLedgerSnapshot> {
    await this.load()
    await this.expireHeld()
    return {
      version: 1,
      accounts: [...this.accounts.values()].map(clone),
      records: [...this.records.values()].map(clone),
      reservations: [...this.reservations.values()].map(clone),
      accountingKnown: this.accountingKnown,
      updatedAt: this.updatedAt,
    }
  }

  async upsertAccount(account: ComputeAccount): Promise<ComputeAccount> {
    await this.load()
    validateAccount(account)
    this.accounts.set(account.id, clone(account))
    this.updatedAt = Date.now()
    await this.saveState()
    return clone(account)
  }

  async recordUsage(record: ComputeUsageRecord): Promise<boolean> {
    await this.load()
    validateUsageRecord(record)
    this.requireAccount(record.accountId)
    const existing = this.records.get(record.id)
    if (existing) {
      if (!sameRecord(existing, record)) throw new Error(`Compute usage id ${record.id} conflicts with an existing record`)
      return false
    }

    await this.appendUsage(record)
    this.records.set(record.id, clone(record))
    this.updatedAt = Date.now()
    return true
  }

  async reserve(input: ComputeReservationInput): Promise<ComputeReservation> {
    await this.load()
    await this.expireHeld()
    const account = this.requireAccount(input.accountId)
    if (account.status === 'exhausted' || account.status === 'unavailable') {
      throw new Error(`Compute account ${account.label} is ${account.status}`)
    }

    const reservedUsd = optionalNonNegative(input.reservedUsd, 'reservedUsd')
    const reservedEntitlementRatio = optionalRatio(input.reservedEntitlementRatio, 'reservedEntitlementRatio')
    if (reservedUsd === undefined && reservedEntitlementRatio === undefined) {
      throw new Error('Compute reservation must reserve cash or entitlement capacity')
    }

    if (reservedUsd !== undefined) this.assertAccountCashCapacity(account, reservedUsd)

    const now = Date.now()
    const reservation: ComputeReservation = {
      id: randomUUID(),
      accountId: account.id,
      companyId: clean(input.companyId, 'companyId'),
      projectId: clean(input.projectId, 'projectId'),
      ...(input.taskId ? { taskId: clean(input.taskId, 'taskId') } : {}),
      ...(input.runId ? { runId: clean(input.runId, 'runId') } : {}),
      ...(reservedUsd === undefined ? {} : { reservedUsd }),
      ...(reservedEntitlementRatio === undefined ? {} : { reservedEntitlementRatio }),
      state: 'held',
      createdAt: now,
      expiresAt: input.expiresAt === undefined
        ? now + DEFAULT_RESERVATION_MS
        : positiveTimestamp(input.expiresAt, 'expiresAt'),
    }
    if (reservation.expiresAt <= now) throw new Error('expiresAt must be in the future')

    this.reservations.set(reservation.id, reservation)
    this.updatedAt = now
    await this.saveState()
    return clone(reservation)
  }

  async settle(reservationId: string, record: ComputeUsageRecord): Promise<{ reservation: ComputeReservation; recorded: boolean }> {
    await this.load()
    await this.expireHeld()
    const reservation = this.requireReservation(reservationId)
    if (reservation.state === 'settled') {
      const existing = this.records.get(record.id)
      if (!existing || !sameRecord(existing, record)) throw new Error('Settled reservation does not match this usage record')
      return { reservation: clone(reservation), recorded: false }
    }
    if (reservation.state !== 'held') throw new Error(`Compute reservation is ${reservation.state}`)
    if (record.accountId !== reservation.accountId) throw new Error('Usage account does not match reservation account')
    if (record.companyId !== reservation.companyId || record.projectId !== reservation.projectId) {
      throw new Error('Usage scope does not match reservation scope')
    }

    validateUsageRecord(record)
    const actual = record.actualCashUsd
    if (actual !== undefined && reservation.reservedUsd !== undefined && actual > reservation.reservedUsd + Number.EPSILON) {
      throw new Error(`Actual cash $${actual.toFixed(6)} exceeds reserved cash $${reservation.reservedUsd.toFixed(6)}`)
    }

    const existing = this.records.get(record.id)
    let recorded = false
    if (existing) {
      if (!sameRecord(existing, record)) throw new Error(`Compute usage id ${record.id} conflicts with an existing record`)
    } else {
      await this.appendUsage(record)
      this.records.set(record.id, clone(record))
      recorded = true
    }

    const now = Date.now()
    reservation.state = 'settled'
    reservation.settledAt = now
    if (actual !== undefined) reservation.settledUsd = actual
    this.updatedAt = now
    await this.saveState()
    return { reservation: clone(reservation), recorded }
  }

  async release(reservationId: string): Promise<ComputeReservation> {
    await this.load()
    const reservation = this.requireReservation(reservationId)
    if (reservation.state === 'released' || reservation.state === 'expired') return clone(reservation)
    if (reservation.state === 'settled') throw new Error('Settled reservations cannot be released')
    const now = Date.now()
    reservation.state = 'released'
    reservation.releasedAt = now
    this.updatedAt = now
    await this.saveState()
    return clone(reservation)
  }

  async cashSummary(query: ComputeCashQuery = {}): Promise<ComputeCashSummary> {
    await this.load()
    await this.expireHeld()
    let actualCashUsd = 0
    for (const record of this.records.values()) {
      if (!matchesUsage(record, query)) continue
      if (record.actualCashUsd !== undefined) actualCashUsd += record.actualCashUsd
    }
    let heldUsd = 0
    let activeReservations = 0
    for (const reservation of this.reservations.values()) {
      if (reservation.state !== 'held' || !matchesReservation(reservation, query)) continue
      activeReservations += 1
      heldUsd += reservation.reservedUsd ?? 0
    }
    return {
      accountingKnown: this.accountingKnown,
      actualCashUsd,
      heldUsd,
      activeReservations,
    }
  }

  async management(query: ComputeCashQuery = {}): Promise<ComputeManagementProjection> {
    const summary = await this.cashSummary(query)
    const accounts = [...this.accounts.values()].filter((account) => !query.companyId || !account.companyId || account.companyId === query.companyId)
    return {
      ...summary,
      staleAccountIds: accounts.filter((account) => account.status === 'stale').map((account) => account.id),
      exhaustedAccountIds: accounts.filter((account) => account.status === 'exhausted').map((account) => account.id),
    }
  }

  private assertAccountCashCapacity(account: ComputeAccount, requestedUsd: number): void {
    const heldUsd = [...this.reservations.values()]
      .filter((item) => item.accountId === account.id && item.state === 'held')
      .reduce((sum, item) => sum + (item.reservedUsd ?? 0), 0)

    const localSinceRefresh = [...this.records.values()]
      .filter((item) => item.accountId === account.id
        && item.actualCashUsd !== undefined
        && item.observedAt >= (account.refreshedAt ?? 0))
      .reduce((sum, item) => sum + (item.actualCashUsd ?? 0), 0)

    for (const meter of account.meters) {
      if (meter.kind !== 'cash_usd' || meter.limitUsd === undefined) continue
      const projected = meter.spentUsd + localSinceRefresh + heldUsd + requestedUsd
      if (projected > meter.limitUsd + Number.EPSILON) {
        throw new Error(`Compute account cash limit would be exceeded (${projected.toFixed(6)}/${meter.limitUsd.toFixed(6)} USD)`)
      }
    }
  }

  private async expireHeld(): Promise<void> {
    const now = Date.now()
    let changed = false
    for (const reservation of this.reservations.values()) {
      if (reservation.state === 'held' && reservation.expiresAt <= now) {
        reservation.state = 'expired'
        reservation.releasedAt = now
        changed = true
      }
    }
    if (!changed) return
    this.updatedAt = now
    await this.saveState()
  }

  private requireAccount(accountId: string): ComputeAccount {
    const account = this.accounts.get(accountId)
    if (!account) throw new Error(`Compute account not found: ${accountId}`)
    return account
  }

  private requireReservation(id: string): ComputeReservation {
    const reservation = this.reservations.get(id)
    if (!reservation) throw new Error(`Compute reservation not found: ${id}`)
    return reservation
  }

  private async appendUsage(record: ComputeUsageRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`
    const write = this.appendChain.catch(() => undefined).then(async () => {
      await fs.mkdir(dirname(this.usageFilePath), { recursive: true })
      await fs.appendFile(this.usageFilePath, line, 'utf8')
    })
    this.appendChain = write
    await write
  }

  private async saveState(): Promise<void> {
    const snapshot: ComputeStateFile = {
      version: 1,
      accounts: [...this.accounts.values()].map(clone),
      reservations: [...this.reservations.values()].map(clone),
      updatedAt: this.updatedAt,
    }
    const text = `${JSON.stringify(snapshot, null, 2)}\n`
    const write = this.stateWriteChain.catch(() => undefined).then(async () => {
      await fs.mkdir(dirname(this.stateFilePath), { recursive: true })
      const temp = `${this.stateFilePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temp, text, 'utf8')
        await fs.rename(temp, this.stateFilePath)
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
    })
    this.stateWriteChain = write
    await write
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = this.loadFromDisk().finally(() => { this.loadPromise = undefined })
    return this.loadPromise
  }

  private async loadFromDisk(): Promise<void> {
    await this.loadState()
    await this.loadUsage()
    this.loaded = true
  }

  private async loadState(): Promise<void> {
    let raw: string
    try {
      raw = await fs.readFile(this.stateFilePath, 'utf8')
    } catch (error) {
      if (!isMissing(error)) {
        this.accountingKnown = false
        console.warn('Compute state is unreadable; paid-budget accounting is conservative until repaired:', error)
      }
      return
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ComputeStateFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.reservations)) {
        throw new Error('Unsupported compute state')
      }
      for (const account of parsed.accounts) {
        validateAccount(account)
        this.accounts.set(account.id, clone(account))
      }
      for (const reservation of parsed.reservations) {
        validateReservation(reservation)
        this.reservations.set(reservation.id, clone(reservation))
      }
      if (typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)) this.updatedAt = parsed.updatedAt
    } catch (error) {
      this.accountingKnown = false
      console.warn('Compute state is invalid; paid-budget accounting is conservative until repaired:', error)
    }
  }

  private async loadUsage(): Promise<void> {
    let raw: string
    try {
      raw = await fs.readFile(this.usageFilePath, 'utf8')
    } catch (error) {
      if (!isMissing(error)) {
        this.accountingKnown = false
        console.warn('Compute usage ledger is unreadable; paid-budget accounting is conservative until repaired:', error)
      }
      return
    }

    let skipped = 0
    let start = 0
    while (start < raw.length) {
      let end = raw.indexOf('\n', start)
      if (end === -1) end = raw.length
      const line = raw.slice(start, end).trim()
      start = end + 1
      if (!line) continue
      try {
        const record = JSON.parse(line) as ComputeUsageRecord
        validateUsageRecord(record)
        const existing = this.records.get(record.id)
        if (existing && !sameRecord(existing, record)) {
          skipped += 1
          this.accountingKnown = false
          continue
        }
        this.records.set(record.id, record)
      } catch {
        skipped += 1
        this.accountingKnown = false
      }
    }
    if (skipped > 0) console.warn(`Compute usage ledger skipped ${skipped} invalid or conflicting line(s)`)
  }
}

function validateAccount(account: ComputeAccount): void {
  clean(account.id, 'account.id')
  clean(account.label, 'account.label')
  if (!Array.isArray(account.meters)) throw new Error('account.meters must be an array')
  if (account.fixedMonthlyCostUsd !== undefined) nonNegative(account.fixedMonthlyCostUsd, 'fixedMonthlyCostUsd')
  for (const meter of account.meters) {
    if (meter.kind === 'cash_usd') {
      nonNegative(meter.spentUsd, 'cash meter spentUsd')
      if (meter.limitUsd !== undefined) nonNegative(meter.limitUsd, 'cash meter limitUsd')
    } else if (meter.kind === 'provider_value_usd') {
      nonNegative(meter.limitUsd, 'provider-value meter limitUsd')
      nonNegative(meter.usedUsd, 'provider-value meter usedUsd')
    } else if (meter.kind === 'quota_ratio') {
      ratio(meter.remainingRatio, 'quota meter remainingRatio')
    } else if (meter.kind === 'credits') {
      nonNegative(meter.remaining, 'credits remaining')
      if (meter.limit !== undefined) nonNegative(meter.limit, 'credits limit')
    } else {
      nonNegativeInteger(meter.inputTokens, 'inputTokens')
      nonNegativeInteger(meter.outputTokens, 'outputTokens')
      if (meter.reasoningTokens !== undefined) nonNegativeInteger(meter.reasoningTokens, 'reasoningTokens')
    }
  }
}

function validateUsageRecord(record: ComputeUsageRecord): void {
  clean(record.id, 'usage.id')
  clean(record.accountId, 'usage.accountId')
  positiveTimestamp(record.observedAt, 'usage.observedAt')
  if (record.actualCashUsd !== undefined) nonNegative(record.actualCashUsd, 'actualCashUsd')
  if (record.providerValueUsd !== undefined) nonNegative(record.providerValueUsd, 'providerValueUsd')
  if (record.inputTokens !== undefined) nonNegativeInteger(record.inputTokens, 'inputTokens')
  if (record.outputTokens !== undefined) nonNegativeInteger(record.outputTokens, 'outputTokens')
  if (record.reasoningTokens !== undefined) nonNegativeInteger(record.reasoningTokens, 'reasoningTokens')
}

function validateReservation(reservation: ComputeReservation): void {
  clean(reservation.id, 'reservation.id')
  clean(reservation.accountId, 'reservation.accountId')
  clean(reservation.companyId, 'reservation.companyId')
  clean(reservation.projectId, 'reservation.projectId')
  if (reservation.reservedUsd !== undefined) nonNegative(reservation.reservedUsd, 'reservation.reservedUsd')
  if (reservation.reservedEntitlementRatio !== undefined) ratio(reservation.reservedEntitlementRatio, 'reservation.reservedEntitlementRatio')
  if (reservation.settledUsd !== undefined) nonNegative(reservation.settledUsd, 'reservation.settledUsd')
  positiveTimestamp(reservation.createdAt, 'reservation.createdAt')
  positiveTimestamp(reservation.expiresAt, 'reservation.expiresAt')
}

function matchesUsage(record: ComputeUsageRecord, query: ComputeCashQuery): boolean {
  if (query.accountId && record.accountId !== query.accountId) return false
  if (query.companyId && record.companyId !== query.companyId) return false
  if (query.projectId && record.projectId !== query.projectId) return false
  if (query.since !== undefined && record.observedAt < query.since) return false
  return true
}

function matchesReservation(reservation: ComputeReservation, query: ComputeCashQuery): boolean {
  if (query.accountId && reservation.accountId !== query.accountId) return false
  if (query.companyId && reservation.companyId !== query.companyId) return false
  if (query.projectId && reservation.projectId !== query.projectId) return false
  if (query.since !== undefined && reservation.createdAt < query.since) return false
  return true
}

function sameRecord(left: ComputeUsageRecord, right: ComputeUsageRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function optionalNonNegative(value: number | undefined, label: string): number | undefined {
  return value === undefined ? undefined : nonNegative(value, label)
}

function optionalRatio(value: number | undefined, label: string): number | undefined {
  return value === undefined ? undefined : ratio(value, label)
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`)
  return value
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`)
  return value
}

function ratio(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`)
  return value
}

function positiveTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive epoch timestamp`)
  return value
}

function clean(value: string, label: string): string {
  const text = value.trim()
  if (!text) throw new Error(`${label} cannot be empty`)
  return text
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
