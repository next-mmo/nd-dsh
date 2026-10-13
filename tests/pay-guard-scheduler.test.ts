import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { PayGuardStore } from '../src/main/extensions/pay-guard-store.js'
import {
  PayGuardScheduler,
  deliverPayGuardNotification,
  formatReminderMessage,
  getActiveNotificationReferenceCount,
  type PayGuardNotificationPayload,
} from '../src/main/extensions/pay-guard-scheduler.js'
import { personalContext } from '../src/shared/nd-context.js'

const packagePath = fileURLToPath(new URL('../extensions/nd-pay-guard/', import.meta.url))

describe('PayGuardScheduler Reminders & Deduplication', () => {
  let root: string
  let store: PayGuardStore
  let state: InvocationStateStore
  let packages: ExtensionPackageStore
  let notifications: PayGuardNotificationPayload[]
  let scheduler: PayGuardScheduler
  let mockToday: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nd-pay-guard-scheduler-'))
    const storeFile = join(root, 'subscriptions.json')
    store = new PayGuardStore(storeFile)
    state = new InvocationStateStore(join(root, 'state'))
    packages = new ExtensionPackageStore(join(root, 'packages'))
    notifications = []
    mockToday = '2026-10-12'

    // Install and activate Pay Guard
    await packages.installFromDirectory(packagePath, { expectId: 'nd.pay-guard' })
    await state.setActivation('nd.pay-guard', personalContext(), true)

    scheduler = new PayGuardScheduler({
      store,
      state,
      packages,
      notifier: (payload) => {
        notifications.push(payload)
        return true
      },
      pollIntervalMs: 60_000,
      today: () => mockToday,
    })
  })

  afterEach(async () => {
    scheduler.stop()
    await rm(root, { recursive: true, force: true })
  })

  it('formats reminder messages accurately for today, tomorrow, and multiple days', () => {
    const sub = { name: 'Netflix', amount: 15.99, currency: 'USD', nextRenewalDate: '2026-10-12' }
    expect(formatReminderMessage(sub, 0)).toBe('Netflix is due for renewal today (USD 15.99).')
    expect(formatReminderMessage(sub, 1)).toBe('Netflix renews tomorrow (USD 15.99).')
    expect(formatReminderMessage(sub, 3)).toBe('Netflix renews in 3 days on 2026-10-12 (USD 15.99).')
    expect(formatReminderMessage(sub, -1)).toBe('Netflix was due for renewal on 2026-10-12 (USD 15.99).')
  })

  it('dispatches OS reminder when renewal is within reminder window', async () => {
    // Due in 2 days, reminder threshold is 3 days
    await store.create({
      name: 'GitHub Copilot',
      amount: 10,
      currency: 'USD',
      nextRenewalDate: '2026-10-14',
      reminderDays: 3,
      status: 'active',
    })

    const sent = await scheduler.checkAndNotify()
    expect(sent).toBe(1)
    expect(notifications.length).toBe(1)
    expect(notifications[0]?.title).toBe('ND Pay Guard')
    expect(notifications[0]?.body).toContain('GitHub Copilot')
    expect(notifications[0]?.body).toContain('renews in 2 days')

    // Subscription record has recorded lastNotifiedRenewalDate
    const list = await store.list()
    expect(list[0]?.lastNotifiedRenewalDate).toBe('2026-10-14')
  })

  it('deduplicates reminders for the same renewal cycle date', async () => {
    await store.create({
      name: 'Copilot',
      amount: 10,
      currency: 'USD',
      nextRenewalDate: '2026-10-13', // Tomorrow
      reminderDays: 3,
      status: 'active',
    })

    // First check triggers notification
    const firstSent = await scheduler.checkAndNotify()
    expect(firstSent).toBe(1)
    expect(notifications.length).toBe(1)

    // Second check on the same date does NOT re-notify
    const secondSent = await scheduler.checkAndNotify()
    expect(secondSent).toBe(0)
    expect(notifications.length).toBe(1)
  })

  it('allows notification for next cycle after marking paid', async () => {
    const sub = await store.create({
      name: 'ChatGPT',
      amount: 20,
      currency: 'USD',
      nextRenewalDate: '2026-10-12', // Due today
      cycle: 'monthly',
      reminderDays: 3,
      status: 'active',
    })

    await scheduler.checkAndNotify()
    expect(notifications.length).toBe(1)

    // Mark paid advances renewal to 2026-11-12 and clears lastNotifiedRenewalDate
    await store.markPaid(sub.id, '2026-10-12')

    // Forward mock today to November 10 (2 days before new renewal)
    mockToday = '2026-11-10'
    const newSent = await scheduler.checkAndNotify()
    expect(newSent).toBe(1)
    expect(notifications.length).toBe(2)
    expect(notifications[1]?.body).toContain('renews in 2 days on 2026-11-12')
  })

  it('skips paused and cancelled subscriptions', async () => {
    await store.create({
      name: 'Gym',
      amount: 50,
      nextRenewalDate: '2026-10-12',
      reminderDays: 3,
      status: 'paused',
    })
    await store.create({
      name: 'Old SaaS',
      amount: 15,
      nextRenewalDate: '2026-10-12',
      reminderDays: 3,
      status: 'cancelled',
    })

    const sent = await scheduler.checkAndNotify()
    expect(sent).toBe(0)
    expect(notifications.length).toBe(0)
  })

  it('skips notifications and stops running if extension is deactivated or uninstalled', async () => {
    await store.create({
      name: 'SaaS Due',
      amount: 10,
      nextRenewalDate: '2026-10-12',
      reminderDays: 3,
      status: 'active',
    })

    // Deactivate Pay Guard
    await state.setActivation('nd.pay-guard', personalContext(), false)

    scheduler.start()
    expect(scheduler.isRunning).toBe(true)

    await scheduler.sync()
    expect(scheduler.isRunning).toBe(false) // Automatically stopped!

    const sent = await scheduler.checkAndNotify()
    expect(sent).toBe(0)
    expect(notifications.length).toBe(0)
  })

  it('sends test notification immediately', async () => {
    const res = await scheduler.sendTestNotification()
    expect(res.ok).toBe(true)
    expect(res.delivered).toBe(true)
    expect(notifications.length).toBe(1)
    expect(notifications[0]?.body).toContain('Test notification: OS reminders are active')
  })

  it('remains retryable without marking notified when notifier returns false or throws', async () => {
    let shouldFail = true
    let shouldThrow = false

    const failScheduler = new PayGuardScheduler({
      store,
      state,
      packages,
      notifier: (payload) => {
        if (shouldThrow) throw new Error('OS Notification Error')
        if (shouldFail) return false
        notifications.push(payload)
        return true
      },
      today: () => mockToday,
    })

    const sub = await store.create({
      name: 'Retryable SaaS',
      amount: 12,
      nextRenewalDate: '2026-10-12',
      reminderDays: 3,
      status: 'active',
    })

    // 1. Notifier returns false
    const sent1 = await failScheduler.checkAndNotify()
    expect(sent1).toBe(0)
    expect(notifications.length).toBe(0)
    expect((await store.get(sub.id))?.lastNotifiedRenewalDate).toBeUndefined()

    // 2. Notifier throws
    shouldThrow = true
    const sent2 = await failScheduler.checkAndNotify()
    expect(sent2).toBe(0)
    expect(notifications.length).toBe(0)
    expect((await store.get(sub.id))?.lastNotifiedRenewalDate).toBeUndefined()

    // 3. Notifier succeeds: now delivers and marks notified!
    shouldThrow = false
    shouldFail = false
    const sent3 = await failScheduler.checkAndNotify()
    expect(sent3).toBe(1)
    expect(notifications.length).toBe(1)
    expect((await store.get(sub.id))?.lastNotifiedRenewalDate).toBe('2026-10-12')
  })

  it('serializes overlapping checkAndNotify calls so notifications are delivered exactly once', async () => {
    await store.create({
      name: 'Concurrent SaaS',
      amount: 15,
      nextRenewalDate: '2026-10-12',
      reminderDays: 3,
      status: 'active',
    })

    // Trigger 3 concurrent checks simultaneously
    const [sent1, sent2, sent3] = await Promise.all([
      scheduler.checkAndNotify(),
      scheduler.checkAndNotify(),
      scheduler.checkAndNotify(),
    ])

    // Total sent across the 3 concurrent runs must be exactly 1!
    expect(sent1 + sent2 + sent3).toBe(1)
    expect(notifications.length).toBe(1)
  })

  it('catches up on missed overdue renewals beyond 1 day when reopening ND', async () => {
    // Renewal was due 5 days ago (2026-10-07) while ND was closed
    await store.create({
      name: 'Missed Cloud Renewal',
      amount: 50,
      currency: 'USD',
      nextRenewalDate: '2026-10-07',
      reminderDays: 3,
      status: 'active',
    })

    // ND starts up on 2026-10-12
    const sent = await scheduler.checkAndNotify()
    expect(sent).toBe(1)
    expect(notifications.length).toBe(1)
    expect(notifications[0]?.body).toContain('was due for renewal on 2026-10-07')

    // Deduplicated: second startup check does not repeat
    const sentAgain = await scheduler.checkAndNotify()
    expect(sentAgain).toBe(0)
    expect(notifications.length).toBe(1)
  })

  it('supports async notifier with truthful failure, instructions, and successful retry', async () => {
    let mode: 'async-fail' | 'async-reject' | 'async-success' = 'async-fail'

    const asyncScheduler = new PayGuardScheduler({
      store,
      state,
      packages,
      notifier: async (payload) => {
        if (mode === 'async-reject') {
          throw new Error('Asynchronous OS transport error')
        }
        if (mode === 'async-fail') {
          return {
            delivered: false,
            reason: 'failed',
            error: 'The operation couldn’t be completed. (UNErrorDomain error 1.)',
          }
        }
        notifications.push(payload)
        return { delivered: true, reason: 'shown' }
      },
      today: () => mockToday,
    })

    const sub = await store.create({
      name: 'Async Retry SaaS',
      amount: 25,
      nextRenewalDate: '2026-10-12',
      reminderDays: 3,
      status: 'active',
    })

    // 1. Async failure outcome yields truthful test result with actionable guidance
    const testFailRes = await asyncScheduler.sendTestNotification()
    expect(testFailRes.ok).toBe(false)
    expect(testFailRes.delivered).toBe(false)
    expect(testFailRes.message).toContain('UNErrorDomain error 1')
    expect(testFailRes.guidance).toContain('macOS Notification Settings')
    expect(testFailRes.guidance).toContain('Unsigned Dev Environment')

    // 2. Scheduled check with async failure: does not mark notified
    const sent1 = await asyncScheduler.checkAndNotify()
    expect(sent1).toBe(0)
    expect((await store.get(sub.id))?.lastNotifiedRenewalDate).toBeUndefined()

    // 3. Scheduled check with async rejection: does not mark notified
    mode = 'async-reject'
    const sent2 = await asyncScheduler.checkAndNotify()
    expect(sent2).toBe(0)
    expect((await store.get(sub.id))?.lastNotifiedRenewalDate).toBeUndefined()

    // 4. Retry succeeds: marks notified!
    mode = 'async-success'
    const sent3 = await asyncScheduler.checkAndNotify()
    expect(sent3).toBe(1)
    expect(notifications.length).toBe(1)
    expect((await store.get(sub.id))?.lastNotifiedRenewalDate).toBe('2026-10-12')

    // 5. Subsequent run: deduplicated!
    const sent4 = await asyncScheduler.checkAndNotify()
    expect(sent4).toBe(0)
    expect(notifications.length).toBe(1)

    // 6. Test notification on success
    const testSuccessRes = await asyncScheduler.sendTestNotification()
    expect(testSuccessRes.ok).toBe(true)
    expect(testSuccessRes.delivered).toBe(true)
  })
})

describe('deliverPayGuardNotification event-based delivery & lifecycle', () => {
  it('resolves delivered=true on show event and retains reference until settled', async () => {
    class FakeShowNotification extends EventEmitter {
      static isSupported() {
        return true
      }
      constructor(public options: { title: string; body: string }) {
        super()
      }
      show() {
        setTimeout(() => {
          this.emit('show')
        }, 10)
      }
    }

    expect(getActiveNotificationReferenceCount()).toBe(0)
    const promise = deliverPayGuardNotification(
      { title: 'Test', body: 'Body' },
      { NotificationClass: FakeShowNotification, timeoutMs: 1000 },
    )
    expect(getActiveNotificationReferenceCount()).toBe(1) // Reference retained!

    const outcome = await promise
    expect(outcome.delivered).toBe(true)
    expect(outcome.reason).toBe('shown')
    expect(getActiveNotificationReferenceCount()).toBe(0) // Cleaned up after settle!
  })

  it('resolves delivered=false on failed event and retains reference until settled', async () => {
    class FakeFailedNotification extends EventEmitter {
      static isSupported() {
        return true
      }
      constructor(public options: { title: string; body: string }) {
        super()
      }
      show() {
        setTimeout(() => {
          this.emit('failed', {}, 'The operation couldn’t be completed. (UNErrorDomain error 1.)')
        }, 10)
      }
    }

    expect(getActiveNotificationReferenceCount()).toBe(0)
    const promise = deliverPayGuardNotification(
      { title: 'Test', body: 'Body' },
      { NotificationClass: FakeFailedNotification, timeoutMs: 1000 },
    )
    expect(getActiveNotificationReferenceCount()).toBe(1) // Reference retained!

    const outcome = await promise
    expect(outcome.delivered).toBe(false)
    expect(outcome.reason).toBe('failed')
    expect(outcome.error).toContain('UNErrorDomain error 1')
    expect(getActiveNotificationReferenceCount()).toBe(0) // Cleaned up after settle!
  })

  it('resolves delivered=false on timeout if no events are emitted', async () => {
    class FakeSilentNotification extends EventEmitter {
      static isSupported() {
        return true
      }
      constructor(public options: { title: string; body: string }) {
        super()
      }
      show() {
        // silent: does not emit show or failed
      }
    }

    expect(getActiveNotificationReferenceCount()).toBe(0)
    const promise = deliverPayGuardNotification(
      { title: 'Test', body: 'Body' },
      { NotificationClass: FakeSilentNotification, timeoutMs: 50 },
    )
    expect(getActiveNotificationReferenceCount()).toBe(1) // Reference retained!

    const outcome = await promise
    expect(outcome.delivered).toBe(false)
    expect(outcome.reason).toBe('timeout')
    expect(outcome.error).toContain('timed out')
    expect(getActiveNotificationReferenceCount()).toBe(0) // Cleaned up after settle!
  })

  it('resolves delivered=false when notification is unsupported', async () => {
    class FakeUnsupportedNotification extends EventEmitter {
      static isSupported() {
        return false
      }
    }

    const outcome = await deliverPayGuardNotification(
      { title: 'Test', body: 'Body' },
      { NotificationClass: FakeUnsupportedNotification },
    )
    expect(outcome.delivered).toBe(false)
    expect(outcome.reason).toBe('unsupported')
    expect(getActiveNotificationReferenceCount()).toBe(0)
  })

  it('resolves delivered=false when Notification constructor throws synchronously', async () => {
    class FakeThrowingNotification {
      static isSupported() {
        return true
      }
      constructor() {
        throw new Error('OS native error')
      }
    }

    const outcome = await deliverPayGuardNotification(
      { title: 'Test', body: 'Body' },
      { NotificationClass: FakeThrowingNotification },
    )
    expect(outcome.delivered).toBe(false)
    expect(outcome.reason).toBe('error')
    expect(outcome.error).toBe('OS native error')
    expect(getActiveNotificationReferenceCount()).toBe(0)
  })
})
