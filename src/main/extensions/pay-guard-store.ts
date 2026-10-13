import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

export type SubscriptionCycle = 'weekly' | 'monthly' | 'yearly' | 'one-time'
export type SubscriptionStatus = 'active' | 'paused' | 'cancelled'

export interface Subscription {
  id: string
  name: string
  amount: number
  currency: string
  nextRenewalDate: string // YYYY-MM-DD
  billingDay: number // 1-31 (target day of month preserved across month-end/leap adjustments)
  cycle: SubscriptionCycle
  reminderDays: number // days before renewal to trigger OS reminder (0-30)
  status: SubscriptionStatus
  notes: string
  url: string
  lastPaidDate?: string // YYYY-MM-DD
  lastNotifiedRenewalDate?: string // YYYY-MM-DD to deduplicate OS reminders per cycle
  createdAt: number
  updatedAt: number
}

export interface CreateSubscriptionInput {
  name: string
  amount: number
  currency?: string
  nextRenewalDate: string
  billingDay?: number
  cycle?: SubscriptionCycle
  reminderDays?: number
  status?: SubscriptionStatus
  notes?: string
  url?: string
}

export interface UpdateSubscriptionInput {
  id: string
  name?: string
  amount?: number
  currency?: string
  nextRenewalDate?: string
  billingDay?: number
  cycle?: SubscriptionCycle
  reminderDays?: number
  status?: SubscriptionStatus
  notes?: string
  url?: string
  lastPaidDate?: string
}

export interface UpcomingChargeItem {
  id: string
  name: string
  amount: number
  currency: string
  nextRenewalDate: string
  cycle: SubscriptionCycle
  status: SubscriptionStatus
  reminderDays: number
  daysRemaining: number
  urgency: 'overdue' | 'due-today' | 'due-soon' | 'upcoming'
  notes?: string
  url?: string
}

export interface UpcomingChargeSummary {
  charges: UpcomingChargeItem[]
  totalUpcomingCount: number
  dueSoonCount: number
  monthlyBurnByCurrency: Record<string, number>
  annualBurnByCurrency: Record<string, number>
}

export interface SubscriptionSummary {
  totalCount: number
  activeCount: number
  pausedCount: number
  cancelledCount: number
  monthlyBurnByCurrency: Record<string, number>
  annualBurnByCurrency: Record<string, number>
  nextUpcoming?: UpcomingChargeItem
}

interface Snapshot {
  version: 1
  subscriptions: Subscription[]
}

// --- Date Math Utilities ----------------------------------------------------

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0)
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30
  return 31
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

export function parseIsoDate(dateStr: string): { year: number; month: number; day: number } {
  const match = ISO_DATE_PATTERN.exec(dateStr.trim())
  if (!match) throw new Error(`Invalid ISO date format (expected YYYY-MM-DD): "${dateStr}"`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) throw new Error(`Invalid month in date: ${month}`)
  const maxDay = daysInMonth(year, month)
  if (day < 1 || day > maxDay) throw new Error(`Invalid day in date: ${day} for year ${year}, month ${month}`)
  return { year, month, day }
}

export function formatIsoDate(year: number, month: number, day: number): string {
  const y = String(year).padStart(4, '0')
  const m = String(month).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function getTodayIso(date = new Date()): string {
  const y = date.getFullYear()
  const m = date.getMonth() + 1
  const d = date.getDate()
  return formatIsoDate(y, m, d)
}

export function differenceInDays(fromDateIso: string, toDateIso: string): number {
  const from = parseIsoDate(fromDateIso)
  const to = parseIsoDate(toDateIso)
  const fromUtc = Date.UTC(from.year, from.month - 1, from.day)
  const toUtc = Date.UTC(to.year, to.month - 1, to.day)
  return Math.round((toUtc - fromUtc) / (24 * 60 * 60 * 1000))
}

/**
 * Advance renewal date according to cycle with month-end and leap date accuracy.
 *
 * Month-end handling preserves the target billingDay:
 * e.g. Jan 31 -> Feb 29 (leap year 2024) -> Mar 31 -> Apr 30 -> May 31.
 *
 * Leap-day handling for yearly cycles:
 * e.g. Feb 29 2024 -> Feb 28 2025 -> Feb 28 2026 -> Feb 28 2027 -> Feb 29 2028.
 */
export function advanceRenewalDate(
  currentDateStr: string,
  cycle: SubscriptionCycle,
  billingDay?: number,
): { nextRenewalDate: string; billingDay: number } | null {
  if (cycle === 'one-time') return null
  const { year, month, day } = parseIsoDate(currentDateStr)
  const targetBillingDay = billingDay !== undefined && billingDay >= 1 && billingDay <= 31 ? billingDay : day

  if (cycle === 'weekly') {
    const currentUtc = Date.UTC(year, month - 1, day)
    const nextUtc = currentUtc + 7 * 24 * 60 * 60 * 1000
    const nextDate = new Date(nextUtc)
    const nextRenewalDate = formatIsoDate(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, nextDate.getUTCDate())
    return { nextRenewalDate, billingDay: targetBillingDay }
  }

  if (cycle === 'monthly') {
    const nextYear = month === 12 ? year + 1 : year
    const nextMonth = month === 12 ? 1 : month + 1
    const maxDays = daysInMonth(nextYear, nextMonth)
    const nextDay = Math.min(targetBillingDay, maxDays)
    const nextRenewalDate = formatIsoDate(nextYear, nextMonth, nextDay)
    return { nextRenewalDate, billingDay: targetBillingDay }
  }

  if (cycle === 'yearly') {
    const nextYear = year + 1
    const maxDays = daysInMonth(nextYear, month)
    const nextDay = Math.min(targetBillingDay, maxDays)
    const nextRenewalDate = formatIsoDate(nextYear, month, nextDay)
    return { nextRenewalDate, billingDay: targetBillingDay }
  }

  return null
}

// --- Validation Helpers -----------------------------------------------------

export function validateSubscriptionInput(input: unknown): CreateSubscriptionInput {
  if (!input || typeof input !== 'object') throw new Error('Subscription input must be an object')
  const record = input as Record<string, unknown>

  const rawName = typeof record.name === 'string' ? record.name.trim() : ''
  if (!rawName) throw new Error('Subscription name is required')
  if (rawName.length > 100) throw new Error('Subscription name must be 100 characters or fewer')

  const rawAmount = typeof record.amount === 'number' ? record.amount : Number(record.amount)
  if (Number.isNaN(rawAmount) || !Number.isFinite(rawAmount) || rawAmount < 0) {
    throw new Error('Subscription amount must be a positive number')
  }
  const amount = Math.round(rawAmount * 100) / 100

  const rawCurrency = typeof record.currency === 'string' ? record.currency.trim().toUpperCase() : 'USD'
  const currency = rawCurrency.length >= 2 && rawCurrency.length <= 5 ? rawCurrency : 'USD'

  const rawDate = typeof record.nextRenewalDate === 'string' ? record.nextRenewalDate.trim() : ''
  if (!rawDate) throw new Error('Next renewal date is required')
  parseIsoDate(rawDate) // validates format and valid day/month

  const rawCycle = typeof record.cycle === 'string' ? record.cycle.toLowerCase() : 'monthly'
  if (rawCycle !== 'weekly' && rawCycle !== 'monthly' && rawCycle !== 'yearly' && rawCycle !== 'one-time') {
    throw new Error('Cycle must be weekly, monthly, yearly, or one-time')
  }
  const cycle = rawCycle as SubscriptionCycle

  const rawReminderDays = typeof record.reminderDays === 'number' ? record.reminderDays : Number(record.reminderDays ?? 3)
  const reminderDays = Number.isInteger(rawReminderDays) && rawReminderDays >= 0 && rawReminderDays <= 30 ? rawReminderDays : 3

  const rawStatus = typeof record.status === 'string' ? record.status.toLowerCase() : 'active'
  if (rawStatus !== 'active' && rawStatus !== 'paused' && rawStatus !== 'cancelled') {
    throw new Error('Status must be active, paused, or cancelled')
  }
  const status = rawStatus as SubscriptionStatus

  const notes = typeof record.notes === 'string' ? record.notes.trim().slice(0, 500) : ''
  const url = typeof record.url === 'string' ? record.url.trim().slice(0, 1000) : ''

  const billingDay = typeof record.billingDay === 'number' && record.billingDay >= 1 && record.billingDay <= 31
    ? record.billingDay
    : parseIsoDate(rawDate).day

  return {
    name: rawName,
    amount,
    currency,
    nextRenewalDate: rawDate,
    billingDay,
    cycle,
    reminderDays,
    status,
    notes,
    url,
  }
}

// --- Calculation Helpers ----------------------------------------------------

export function calculateUpcomingCharges(
  subscriptions: Subscription[],
  options?: { today?: string; daysAhead?: number },
): UpcomingChargeSummary {
  const today = options?.today ?? getTodayIso()
  const daysAhead = options?.daysAhead ?? 30

  const monthlyBurnByCurrency: Record<string, number> = {}
  const annualBurnByCurrency: Record<string, number> = {}

  const activeSubs = subscriptions.filter((s) => s.status === 'active')

  for (const sub of activeSubs) {
    const cur = sub.currency
    let monthly = 0
    let annual = 0
    switch (sub.cycle) {
      case 'weekly':
        monthly = sub.amount * (52 / 12)
        annual = sub.amount * 52
        break
      case 'monthly':
        monthly = sub.amount
        annual = sub.amount * 12
        break
      case 'yearly':
        monthly = sub.amount / 12
        annual = sub.amount
        break
      case 'one-time':
        monthly = 0
        annual = 0
        break
    }
    monthlyBurnByCurrency[cur] = Math.round(((monthlyBurnByCurrency[cur] ?? 0) + monthly) * 100) / 100
    annualBurnByCurrency[cur] = Math.round(((annualBurnByCurrency[cur] ?? 0) + annual) * 100) / 100
  }

  const charges: UpcomingChargeItem[] = []
  let dueSoonCount = 0

  for (const sub of activeSubs) {
    // If one-time and marked paid, skip from upcoming
    if (sub.cycle === 'one-time' && sub.lastPaidDate) continue

    const daysRemaining = differenceInDays(today, sub.nextRenewalDate)
    if (daysRemaining > daysAhead) continue

    let urgency: UpcomingChargeItem['urgency'] = 'upcoming'
    if (daysRemaining < 0) {
      urgency = 'overdue'
      dueSoonCount += 1
    } else if (daysRemaining === 0) {
      urgency = 'due-today'
      dueSoonCount += 1
    } else if (daysRemaining <= sub.reminderDays) {
      urgency = 'due-soon'
      dueSoonCount += 1
    }

    charges.push({
      id: sub.id,
      name: sub.name,
      amount: sub.amount,
      currency: sub.currency,
      nextRenewalDate: sub.nextRenewalDate,
      cycle: sub.cycle,
      status: sub.status,
      reminderDays: sub.reminderDays,
      daysRemaining,
      urgency,
      ...(sub.notes ? { notes: sub.notes } : {}),
      ...(sub.url ? { url: sub.url } : {}),
    })
  }

  charges.sort((a, b) => a.daysRemaining - b.daysRemaining)

  return {
    charges,
    totalUpcomingCount: charges.length,
    dueSoonCount,
    monthlyBurnByCurrency,
    annualBurnByCurrency,
  }
}

// --- Store Implementation ---------------------------------------------------

export class PayGuardStore {
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private subscriptions: Subscription[] = []
  private saveChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async list(): Promise<Subscription[]> {
    await this.load()
    return structuredClone(this.subscriptions)
  }

  async get(id: string): Promise<Subscription | undefined> {
    await this.load()
    const found = this.subscriptions.find((s) => s.id === id)
    return found ? structuredClone(found) : undefined
  }

  async create(input: unknown): Promise<Subscription> {
    await this.load()
    const valid = validateSubscriptionInput(input)
    const now = Date.now()

    const subscription: Subscription = {
      id: randomUUID(),
      name: valid.name,
      amount: valid.amount,
      currency: valid.currency ?? 'USD',
      nextRenewalDate: valid.nextRenewalDate,
      billingDay: valid.billingDay ?? parseIsoDate(valid.nextRenewalDate).day,
      cycle: valid.cycle ?? 'monthly',
      reminderDays: valid.reminderDays ?? 3,
      status: valid.status ?? 'active',
      notes: valid.notes ?? '',
      url: valid.url ?? '',
      createdAt: now,
      updatedAt: now,
    }

    this.subscriptions.push(subscription)
    await this.persist()
    return structuredClone(subscription)
  }

  async update(id: string, input: unknown): Promise<Subscription> {
    await this.load()
    const index = this.subscriptions.findIndex((s) => s.id === id)
    if (index === -1) throw new Error(`Subscription not found: ${id}`)

    const current = this.subscriptions[index]!
    const patch = (input ?? {}) as Record<string, unknown>

    let name = current.name
    if (typeof patch.name === 'string' && patch.name.trim()) {
      if (patch.name.trim().length > 100) throw new Error('Subscription name must be 100 characters or fewer')
      name = patch.name.trim()
    }

    let amount = current.amount
    if (patch.amount !== undefined) {
      const num = typeof patch.amount === 'number' ? patch.amount : Number(patch.amount)
      if (Number.isNaN(num) || !Number.isFinite(num) || num < 0) throw new Error('Amount must be a positive number')
      amount = Math.round(num * 100) / 100
    }

    let currency = current.currency
    if (typeof patch.currency === 'string' && patch.currency.trim()) {
      const c = patch.currency.trim().toUpperCase()
      if (c.length >= 2 && c.length <= 5) currency = c
    }

    let nextRenewalDate = current.nextRenewalDate
    let billingDay = current.billingDay
    const suppliedDate = typeof patch.nextRenewalDate === 'string' && patch.nextRenewalDate.trim()
      ? patch.nextRenewalDate.trim()
      : undefined

    if (suppliedDate !== undefined) {
      parseIsoDate(suppliedDate)
      // Only reset anchor billingDay on an actual date change!
      if (suppliedDate !== current.nextRenewalDate) {
        nextRenewalDate = suppliedDate
        billingDay = parseIsoDate(nextRenewalDate).day
      }
    }
    if (typeof patch.billingDay === 'number' && patch.billingDay >= 1 && patch.billingDay <= 31) {
      billingDay = patch.billingDay
    }

    let cycle = current.cycle
    if (typeof patch.cycle === 'string') {
      const cyc = patch.cycle.toLowerCase()
      if (cyc === 'weekly' || cyc === 'monthly' || cyc === 'yearly' || cyc === 'one-time') cycle = cyc
    }

    let reminderDays = current.reminderDays
    if (patch.reminderDays !== undefined) {
      const r = typeof patch.reminderDays === 'number' ? patch.reminderDays : Number(patch.reminderDays)
      if (Number.isInteger(r) && r >= 0 && r <= 30) reminderDays = r
    }

    let status = current.status
    if (typeof patch.status === 'string') {
      const st = patch.status.toLowerCase()
      if (st === 'active' || st === 'paused' || st === 'cancelled') status = st
    }

    const notes = typeof patch.notes === 'string' ? patch.notes.trim().slice(0, 500) : current.notes
    const url = typeof patch.url === 'string' ? patch.url.trim().slice(0, 1000) : current.url

    // If nextRenewalDate changed to a different date, clear lastNotifiedRenewalDate so reminders work for the new date
    const lastNotifiedRenewalDate = nextRenewalDate !== current.nextRenewalDate
      ? undefined
      : current.lastNotifiedRenewalDate

    const updated: Subscription = {
      ...current,
      name,
      amount,
      currency,
      nextRenewalDate,
      billingDay,
      cycle,
      reminderDays,
      status,
      notes,
      url,
      updatedAt: Date.now(),
      ...(lastNotifiedRenewalDate ? { lastNotifiedRenewalDate } : {}),
    }
    if (lastNotifiedRenewalDate === undefined) {
      delete updated.lastNotifiedRenewalDate
    }

    this.subscriptions[index] = updated
    await this.persist()
    return structuredClone(updated)
  }

  async delete(id: string): Promise<boolean> {
    await this.load()
    const index = this.subscriptions.findIndex((s) => s.id === id)
    if (index === -1) return false
    this.subscriptions.splice(index, 1)
    await this.persist()
    return true
  }

  async markPaid(id: string, paidDate?: string): Promise<Subscription> {
    await this.load()
    const index = this.subscriptions.findIndex((s) => s.id === id)
    if (index === -1) throw new Error(`Subscription not found: ${id}`)

    const current = this.subscriptions[index]!
    const paidIso = paidDate ? (parseIsoDate(paidDate), paidDate.trim()) : getTodayIso()

    if (current.cycle === 'one-time') {
      const updated: Subscription = {
        ...current,
        status: 'cancelled',
        lastPaidDate: paidIso,
        updatedAt: Date.now(),
      }
      this.subscriptions[index] = updated
      await this.persist()
      return structuredClone(updated)
    }

    const advanced = advanceRenewalDate(current.nextRenewalDate, current.cycle, current.billingDay)
    if (!advanced) throw new Error('Could not advance renewal date')

    const updated: Subscription = {
      ...current,
      nextRenewalDate: advanced.nextRenewalDate,
      billingDay: advanced.billingDay,
      lastPaidDate: paidIso,
      updatedAt: Date.now(),
    }
    delete updated.lastNotifiedRenewalDate

    this.subscriptions[index] = updated
    await this.persist()
    return structuredClone(updated)
  }

  async markNotified(id: string, renewalDate: string): Promise<void> {
    await this.load()
    const sub = this.subscriptions.find((s) => s.id === id)
    if (!sub) return
    sub.lastNotifiedRenewalDate = renewalDate
    sub.updatedAt = Date.now()
    await this.persist()
  }

  async upcoming(daysAhead = 30, today?: string): Promise<UpcomingChargeSummary> {
    await this.load()
    return calculateUpcomingCharges(this.subscriptions, {
      daysAhead,
      ...(today ? { today } : {}),
    })
  }

  async summary(today?: string): Promise<SubscriptionSummary> {
    await this.load()
    const upcoming = calculateUpcomingCharges(this.subscriptions, {
      daysAhead: 30,
      ...(today ? { today } : {}),
    })
    return {
      totalCount: this.subscriptions.length,
      activeCount: this.subscriptions.filter((s) => s.status === 'active').length,
      pausedCount: this.subscriptions.filter((s) => s.status === 'paused').length,
      cancelledCount: this.subscriptions.filter((s) => s.status === 'cancelled').length,
      monthlyBurnByCurrency: upcoming.monthlyBurnByCurrency,
      annualBurnByCurrency: upcoming.annualBurnByCurrency,
      ...(upcoming.charges[0] ? { nextUpcoming: upcoming.charges[0] } : {}),
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    if (!this.loadPromise) {
      this.loadPromise = this.performLoad().finally(() => {
        this.loadPromise = null
      })
    }
    await this.loadPromise
  }

  private async performLoad(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (parseErr) {
        throw new Error(
          `Failed to parse Pay Guard store file at ${this.filePath}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        )
      }
      const snapshot = parsed as Partial<Snapshot>
      if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.subscriptions)) {
        throw new Error(`Corrupt Pay Guard store file at ${this.filePath}: invalid schema or version`)
      }
      this.subscriptions = snapshot.subscriptions.filter(
        (item): item is Subscription => Boolean(item && typeof item === 'object' && typeof item.id === 'string'),
      )
      this.loaded = true
    } catch (err: unknown) {
      const isEnoent = Boolean(
        err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT',
      )
      if (isEnoent) {
        this.subscriptions = []
        this.loaded = true
        return
      }
      // Re-throw any other error to prevent wiping corrupt storage
      throw err
    }
  }

  private async persist(): Promise<void> {
    const snapshot: Snapshot = { version: 1, subscriptions: this.subscriptions }
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
