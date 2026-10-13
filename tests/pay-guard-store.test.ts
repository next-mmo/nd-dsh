import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  advanceRenewalDate,
  calculateUpcomingCharges,
  daysInMonth,
  differenceInDays,
  isLeapYear,
  parseIsoDate,
  PayGuardStore,
  validateSubscriptionInput,
} from '../src/main/extensions/pay-guard-store.js'

describe('ND Pay Guard Date Math & Leap/Month-end Accuracy', () => {
  it('correctly calculates leap years including century exceptions', () => {
    expect(isLeapYear(2024)).toBe(true)
    expect(isLeapYear(2020)).toBe(true)
    expect(isLeapYear(2000)).toBe(true)
    expect(isLeapYear(2023)).toBe(false)
    expect(isLeapYear(2025)).toBe(false)
    expect(isLeapYear(1900)).toBe(false)
    expect(isLeapYear(2100)).toBe(false)
  })

  it('reports exact days in month for leap and non-leap years', () => {
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2025, 2)).toBe(28)
    expect(daysInMonth(2024, 1)).toBe(31)
    expect(daysInMonth(2024, 4)).toBe(30)
    expect(daysInMonth(2024, 12)).toBe(31)
  })

  it('calculates calendar difference in days without timezone shifts', () => {
    expect(differenceInDays('2026-10-12', '2026-10-12')).toBe(0)
    expect(differenceInDays('2026-10-12', '2026-10-15')).toBe(3)
    expect(differenceInDays('2026-10-15', '2026-10-12')).toBe(-3)
    expect(differenceInDays('2024-02-28', '2024-03-01')).toBe(2) // 2024 is leap (Feb 29 exists)
    expect(differenceInDays('2025-02-28', '2025-03-01')).toBe(1) // 2025 non-leap
  })

  it('advances weekly cycles by 7 days', () => {
    const next = advanceRenewalDate('2026-10-12', 'weekly')
    expect(next?.nextRenewalDate).toBe('2026-10-19')
  })

  it('advances monthly cycles preserving 31st billingDay across February and 30-day months', () => {
    // Jan 31 in leap year 2024 -> Feb 29
    const feb = advanceRenewalDate('2024-01-31', 'monthly')
    expect(feb?.nextRenewalDate).toBe('2024-02-29')
    expect(feb?.billingDay).toBe(31)

    // Advancing from Feb 29 with preserved billingDay 31 -> Mar 31!
    const mar = advanceRenewalDate(feb!.nextRenewalDate, 'monthly', feb!.billingDay)
    expect(mar?.nextRenewalDate).toBe('2024-03-31')
    expect(mar?.billingDay).toBe(31)

    // Advancing from Mar 31 with preserved billingDay 31 -> Apr 30
    const apr = advanceRenewalDate(mar!.nextRenewalDate, 'monthly', mar!.billingDay)
    expect(apr?.nextRenewalDate).toBe('2024-04-30')

    // Advancing from Apr 30 with preserved billingDay 31 -> May 31!
    const may = advanceRenewalDate(apr!.nextRenewalDate, 'monthly', apr!.billingDay)
    expect(may?.nextRenewalDate).toBe('2024-05-31')

    // In a non-leap year (2025), Jan 31 -> Feb 28
    const febNonLeap = advanceRenewalDate('2025-01-31', 'monthly')
    expect(febNonLeap?.nextRenewalDate).toBe('2025-02-28')
  })

  it('advances yearly cycles preserving leap day on subsequent leap years', () => {
    // Feb 29, 2024 (leap year)
    const y2025 = advanceRenewalDate('2024-02-29', 'yearly', 29)
    expect(y2025?.nextRenewalDate).toBe('2025-02-28')
    expect(y2025?.billingDay).toBe(29)

    const y2026 = advanceRenewalDate(y2025!.nextRenewalDate, 'yearly', y2025!.billingDay)
    expect(y2026?.nextRenewalDate).toBe('2026-02-28')

    const y2027 = advanceRenewalDate(y2026!.nextRenewalDate, 'yearly', y2026!.billingDay)
    expect(y2027?.nextRenewalDate).toBe('2027-02-28')

    // 2028 is a leap year again: restores Feb 29!
    const y2028 = advanceRenewalDate(y2027!.nextRenewalDate, 'yearly', y2027!.billingDay)
    expect(y2028?.nextRenewalDate).toBe('2028-02-29')
  })

  it('returns null when advancing one-time subscriptions', () => {
    expect(advanceRenewalDate('2026-10-12', 'one-time')).toBeNull()
  })

  it('validates ISO dates strictly', () => {
    expect(parseIsoDate('2026-10-12')).toEqual({ year: 2026, month: 10, day: 12 })
    expect(() => parseIsoDate('2026-02-30')).toThrow(/Invalid day/)
    expect(() => parseIsoDate('invalid-date')).toThrow(/Invalid ISO date/)
  })
})

describe('PayGuardStore CRUD & Persistence', () => {
  let tempDir: string
  let storeFile: string
  let store: PayGuardStore

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nd-pay-guard-store-'))
    storeFile = join(tempDir, 'subscriptions.json')
    store = new PayGuardStore(storeFile)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates and lists subscriptions with validated defaults', async () => {
    const sub = await store.create({
      name: 'GitHub Copilot',
      amount: 10,
      currency: 'usd',
      nextRenewalDate: '2026-11-01',
      cycle: 'monthly',
      reminderDays: 3,
      notes: 'Work subscription',
      url: 'https://github.com/settings/billing',
    })

    expect(sub.id).toBeDefined()
    expect(sub.name).toBe('GitHub Copilot')
    expect(sub.amount).toBe(10)
    expect(sub.currency).toBe('USD')
    expect(sub.billingDay).toBe(1)
    expect(sub.status).toBe('active')
    expect(sub.createdAt).toBeGreaterThan(0)

    const list = await store.list()
    expect(list.length).toBe(1)
    expect(list[0]?.id).toBe(sub.id)

    const fetched = await store.get(sub.id)
    expect(fetched?.name).toBe('GitHub Copilot')
  })

  it('rejects invalid inputs on creation', async () => {
    await expect(store.create({ name: '', amount: 10, nextRenewalDate: '2026-11-01' })).rejects.toThrow(/name is required/)
    await expect(store.create({ name: 'Test', amount: -5, nextRenewalDate: '2026-11-01' })).rejects.toThrow(/positive number/)
    await expect(store.create({ name: 'Test', amount: 10, nextRenewalDate: '2026-13-01' })).rejects.toThrow(/Invalid month/)
  })

  it('updates subscription fields and resets notification token when date changes', async () => {
    const sub = await store.create({
      name: 'Netflix',
      amount: 15.99,
      nextRenewalDate: '2026-10-20',
      cycle: 'monthly',
    })

    // Simulate previous notification
    await store.markNotified(sub.id, '2026-10-20')
    const notified = await store.get(sub.id)
    expect(notified?.lastNotifiedRenewalDate).toBe('2026-10-20')

    // Updating name preserves lastNotifiedRenewalDate
    const updatedName = await store.update(sub.id, { name: 'Netflix Premium' })
    expect(updatedName.name).toBe('Netflix Premium')
    expect(updatedName.lastNotifiedRenewalDate).toBe('2026-10-20')

    // Changing nextRenewalDate resets lastNotifiedRenewalDate
    const updatedDate = await store.update(sub.id, { nextRenewalDate: '2026-11-20' })
    expect(updatedDate.nextRenewalDate).toBe('2026-11-20')
    expect(updatedDate.lastNotifiedRenewalDate).toBeUndefined()
  })

  it('deletes subscriptions cleanly', async () => {
    const sub = await store.create({
      name: 'Spotify',
      amount: 9.99,
      nextRenewalDate: '2026-10-25',
    })
    expect(await store.delete(sub.id)).toBe(true)
    expect(await store.get(sub.id)).toBeUndefined()
    expect((await store.list()).length).toBe(0)
    expect(await store.delete('non-existent')).toBe(false)
  })

  it('marks paid, advances renewal date, and records lastPaidDate', async () => {
    const sub = await store.create({
      name: 'ChatGPT Plus',
      amount: 20,
      nextRenewalDate: '2024-01-31',
      cycle: 'monthly',
    })
    await store.markNotified(sub.id, '2024-01-31')

    const paid = await store.markPaid(sub.id, '2024-01-31')
    expect(paid.lastPaidDate).toBe('2024-01-31')
    expect(paid.nextRenewalDate).toBe('2024-02-29') // Leap year 2024
    expect(paid.billingDay).toBe(31)
    expect(paid.lastNotifiedRenewalDate).toBeUndefined() // Cleared for next cycle!

    // Mark paid again: March 31
    const paid2 = await store.markPaid(sub.id, '2024-02-29')
    expect(paid2.nextRenewalDate).toBe('2024-03-31')
  })

  it('cancels one-time subscriptions upon markPaid', async () => {
    const sub = await store.create({
      name: 'Conference Ticket',
      amount: 250,
      nextRenewalDate: '2026-11-15',
      cycle: 'one-time',
    })

    const paid = await store.markPaid(sub.id, '2026-11-15')
    expect(paid.status).toBe('cancelled')
    expect(paid.lastPaidDate).toBe('2026-11-15')
  })

  it('calculates upcoming charges and monthly/annual burn rate grouped by currency', async () => {
    await store.create({
      name: 'Copilot',
      amount: 10,
      currency: 'USD',
      nextRenewalDate: '2026-10-15', // 3 days away
      cycle: 'monthly',
      reminderDays: 3,
      status: 'active',
    })
    await store.create({
      name: 'Server Host',
      amount: 50,
      currency: 'EUR',
      nextRenewalDate: '2026-10-13', // 1 day away
      cycle: 'monthly',
      reminderDays: 3,
      status: 'active',
    })
    await store.create({
      name: 'Domain Annual',
      amount: 120,
      currency: 'USD',
      nextRenewalDate: '2026-10-20', // 8 days away
      cycle: 'yearly',
      reminderDays: 7,
      status: 'active',
    })
    await store.create({
      name: 'Paused Gym',
      amount: 40,
      currency: 'USD',
      nextRenewalDate: '2026-10-14',
      cycle: 'monthly',
      status: 'paused',
    })

    const upcoming = await store.upcoming(30, '2026-10-12')
    expect(upcoming.charges.length).toBe(3) // Paused gym is excluded
    expect(upcoming.charges[0]?.name).toBe('Server Host') // closest first
    expect(upcoming.charges[0]?.urgency).toBe('due-soon') // 1 day away <= 3 reminder days

    // Monthly burn:
    // USD: 10 (Copilot) + 120/12 (Domain) = 20
    // EUR: 50 (Server Host)
    expect(upcoming.monthlyBurnByCurrency.USD).toBe(20)
    expect(upcoming.monthlyBurnByCurrency.EUR).toBe(50)

    // Annual burn:
    // USD: 10 * 12 + 120 = 240
    // EUR: 50 * 12 = 600
    expect(upcoming.annualBurnByCurrency.USD).toBe(240)
    expect(upcoming.annualBurnByCurrency.EUR).toBe(600)

    const summary = await store.summary('2026-10-12')
    expect(summary.totalCount).toBe(4)
    expect(summary.activeCount).toBe(3)
    expect(summary.pausedCount).toBe(1)
  })

  it('re-reads persisted state from disk on a new store instance', async () => {
    await store.create({ name: 'Service A', amount: 9.99, nextRenewalDate: '2026-11-01' })

    const store2 = new PayGuardStore(storeFile)
    const list = await store2.list()
    expect(list.length).toBe(1)
    expect(list[0]?.name).toBe('Service A')
  })

  it('preserves billingDay anchor when updating name with identical renewal date, restoring 31 on next cycle', async () => {
    const sub = await store.create({
      name: 'Original Service',
      amount: 15,
      nextRenewalDate: '2024-01-31',
      cycle: 'monthly',
    })
    // Mark paid advances to Feb 29 (in 2024 leap year)
    const feb = await store.markPaid(sub.id, '2024-01-31')
    expect(feb.nextRenewalDate).toBe('2024-02-29')
    expect(feb.billingDay).toBe(31)

    // UI edit sends the current date back alongside a renamed title
    const renamed = await store.update(sub.id, {
      name: 'Renamed Service',
      nextRenewalDate: '2024-02-29',
    })
    expect(renamed.name).toBe('Renamed Service')
    expect(renamed.billingDay).toBe(31) // Did not lose 31!

    // Next markPaid restores 31 in March!
    const mar = await store.markPaid(sub.id, '2024-02-29')
    expect(mar.nextRenewalDate).toBe('2024-03-31')
    expect(mar.billingDay).toBe(31)
  })

  it('handles concurrent creates from a cold store without losing entries', async () => {
    const coldStore = new PayGuardStore(storeFile)
    const results = await Promise.all([
      coldStore.create({ name: 'Service 1', amount: 10, nextRenewalDate: '2026-11-01' }),
      coldStore.create({ name: 'Service 2', amount: 20, nextRenewalDate: '2026-11-02' }),
      coldStore.create({ name: 'Service 3', amount: 30, nextRenewalDate: '2026-11-03' }),
    ])
    expect(results.length).toBe(3)
    const list = await coldStore.list()
    expect(list.length).toBe(3)
    const names = list.map((s) => s.name).sort()
    expect(names).toEqual(['Service 1', 'Service 2', 'Service 3'])
  })

  it('fails cleanly without wiping corrupt storage when file contains invalid JSON', async () => {
    const fs = await import('node:fs/promises')
    await fs.writeFile(storeFile, 'CORRUPT_JSON_DATA{invalid', 'utf8')

    const corruptStore = new PayGuardStore(storeFile)
    await expect(corruptStore.list()).rejects.toThrow(/Failed to parse Pay Guard store/)

    // Content on disk is preserved and not overwritten with empty snapshot
    const content = await fs.readFile(storeFile, 'utf8')
    expect(content).toBe('CORRUPT_JSON_DATA{invalid')
  })
})
