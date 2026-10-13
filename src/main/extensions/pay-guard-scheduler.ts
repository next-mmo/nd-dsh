import { Notification } from 'electron'
import type { ExtensionPackageStore } from './package-store.js'
import type { InvocationStateStore } from './invocation-state.js'
import {
  differenceInDays,
  getTodayIso,
  type PayGuardStore,
  type Subscription,
} from './pay-guard-store.js'

export const PAY_GUARD_EXTENSION_ID = 'nd.pay-guard'
export const DEFAULT_SCHEDULER_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes bounded timer
export const NOTIFICATION_SETTLE_TIMEOUT_MS = 5000 // 5 seconds bounded timeout

export interface PayGuardNotificationPayload {
  title: string
  body: string
}

export type PayGuardDeliveryReason = 'shown' | 'failed' | 'timeout' | 'unsupported' | 'error'

export interface PayGuardDeliveryOutcome {
  delivered: boolean
  reason: PayGuardDeliveryReason
  error?: string | undefined
}

export interface NativeNotificationOptions {
  timeoutMs?: number | undefined
  NotificationClass?: unknown
}

// Retain active notification references in module scope to prevent V8 GC
// collection prior to asynchronous native OS presentation or failure callbacks.
const activeNotificationReferences = new Set<unknown>()

export function getActiveNotificationReferenceCount(): number {
  return activeNotificationReferences.size
}

/**
 * Event-based native notification delivery wrapping Electron's Notification API.
 * Attaches show and failed listeners BEFORE calling show(), retains the instance
 * in memory until settled, and settles with a truthful outcome on show, failed, or timeout.
 */
export async function deliverPayGuardNotification(
  payload: PayGuardNotificationPayload,
  options?: NativeNotificationOptions,
): Promise<PayGuardDeliveryOutcome> {
  const timeoutMs = options?.timeoutMs ?? NOTIFICATION_SETTLE_TIMEOUT_MS
  const NotificationCtor = (options?.NotificationClass ?? Notification) as any

  if (
    !NotificationCtor ||
    typeof NotificationCtor !== 'function' ||
    (typeof NotificationCtor.isSupported === 'function' && !NotificationCtor.isSupported())
  ) {
    return {
      delivered: false,
      reason: 'unsupported',
      error: 'OS notifications are not supported in this environment.',
    }
  }

  return new Promise<PayGuardDeliveryOutcome>((resolve) => {
    let notification: any
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (notification) {
        activeNotificationReferences.delete(notification)
        try {
          if (typeof notification.removeAllListeners === 'function') {
            notification.removeAllListeners('show')
            notification.removeAllListeners('failed')
          } else if (typeof notification.off === 'function') {
            notification.off('show', onShow)
            notification.off('failed', onFailed)
          } else if (typeof notification.removeListener === 'function') {
            notification.removeListener('show', onShow)
            notification.removeListener('failed', onFailed)
          }
        } catch {
          // ignore cleanup issues
        }
      }
    }

    const settle = (outcome: PayGuardDeliveryOutcome) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(outcome)
    }

    const onShow = () => {
      settle({ delivered: true, reason: 'shown' })
    }

    const onFailed = (_event?: unknown, error?: unknown) => {
      const errorMsg =
        typeof error === 'string' && error.trim()
          ? error
          : error instanceof Error
            ? error.message
            : 'macOS Notification Center rejected notification presentation'
      settle({
        delivered: false,
        reason: 'failed',
        error: errorMsg,
      })
    }

    try {
      notification = new NotificationCtor({
        title: payload.title,
        body: payload.body,
      })

      activeNotificationReferences.add(notification)

      // Attach show and failed listeners BEFORE calling show()
      if (typeof notification.once === 'function') {
        notification.once('show', onShow)
        notification.once('failed', onFailed)
      } else if (typeof notification.on === 'function') {
        notification.on('show', onShow)
        notification.on('failed', onFailed)
      }

      timer = setTimeout(() => {
        settle({
          delivered: false,
          reason: 'timeout',
          error: `Notification delivery timed out waiting for OS presentation after ${timeoutMs}ms.`,
        })
      }, timeoutMs)
      if (typeof timer.unref === 'function') {
        timer.unref()
      }

      if (typeof notification.show === 'function') {
        notification.show()
      } else {
        settle({
          delivered: false,
          reason: 'error',
          error: 'Notification instance lacks show() method.',
        })
      }
    } catch (err) {
      settle({
        delivered: false,
        reason: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
}

export function normalizeDeliveryOutcome(res: unknown): PayGuardDeliveryOutcome {
  if (typeof res === 'boolean') {
    return {
      delivered: res,
      reason: res ? 'shown' : 'failed',
      error: res ? undefined : 'Notification delivery rejected.',
    }
  }
  if (res && typeof res === 'object' && 'delivered' in res) {
    const obj = res as { delivered?: unknown; reason?: unknown; error?: unknown }
    const delivered = Boolean(obj.delivered)
    return {
      delivered,
      reason: (typeof obj.reason === 'string'
        ? obj.reason
        : delivered
          ? 'shown'
          : 'failed') as PayGuardDeliveryReason,
      error: typeof obj.error === 'string' ? obj.error : undefined,
    }
  }
  // undefined / void
  return {
    delivered: res !== false,
    reason: res !== false ? 'shown' : 'failed',
  }
}

export function buildNotificationGuidance(outcome: PayGuardDeliveryOutcome): string {
  if (outcome.reason === 'unsupported') {
    return 'Desktop notifications are not supported in this runtime environment. ND must run in a desktop Electron environment with system notification support.'
  }

  const lines = [
    '• macOS Notification Settings: Open System Settings → Notifications and ensure ND / Electron is allowed, with Focus / Do Not Disturb disabled.',
    '• Unsigned Dev Environment: Unpackaged Electron dev binaries have an unbound Info.plist (adhoc linker signature), which macOS UNNotification rejects. Deep sign a local copy (`codesign --force --deep --sign - /path/to/Electron.app`) or test in a packaged build.',
  ]

  if (outcome.reason === 'timeout') {
    lines.unshift('• Notification timed out waiting for OS presentation confirmation.')
  } else if (outcome.error) {
    lines.unshift(`• OS Error: ${outcome.error}`)
  }

  return lines.join('\n')
}

export type PayGuardNotifier = (
  payload: PayGuardNotificationPayload,
) =>
  | boolean
  | PayGuardDeliveryOutcome
  | void
  | Promise<boolean | PayGuardDeliveryOutcome | void>

export interface PayGuardTestNotificationResult {
  ok: boolean
  delivered: boolean
  message: string
  error?: string | undefined
  reason?: PayGuardDeliveryReason | undefined
  guidance?: string | undefined
}

export function formatReminderMessage(
  sub: Pick<Subscription, 'name' | 'amount' | 'currency' | 'nextRenewalDate'>,
  diffDays: number,
): string {
  const formattedCost = `${sub.currency} ${sub.amount.toFixed(2)}`
  if (diffDays === 0) {
    return `${sub.name} is due for renewal today (${formattedCost}).`
  }
  if (diffDays === 1) {
    return `${sub.name} renews tomorrow (${formattedCost}).`
  }
  if (diffDays > 1) {
    return `${sub.name} renews in ${diffDays} days on ${sub.nextRenewalDate} (${formattedCost}).`
  }
  return `${sub.name} was due for renewal on ${sub.nextRenewalDate} (${formattedCost}).`
}

export interface PayGuardSchedulerOptions {
  store: PayGuardStore
  state: InvocationStateStore
  packages: ExtensionPackageStore
  notifier?: PayGuardNotifier
  pollIntervalMs?: number
  today?: () => string
}

export class PayGuardScheduler {
  private readonly store: PayGuardStore
  private readonly state: InvocationStateStore
  private readonly packages: ExtensionPackageStore
  private readonly notifier: PayGuardNotifier
  private readonly pollIntervalMs: number
  private readonly getToday: () => string
  private timer: NodeJS.Timeout | null = null
  private running = false
  private runChain: Promise<number> = Promise.resolve(0)

  constructor(options: PayGuardSchedulerOptions) {
    this.store = options.store
    this.state = options.state
    this.packages = options.packages
    this.notifier = options.notifier ?? deliverPayGuardNotification
    this.pollIntervalMs = Math.max(10_000, options.pollIntervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS)
    this.getToday = options.today ?? getTodayIso
  }

  get isRunning(): boolean {
    return this.running
  }

  /**
   * Sync scheduler with extension state:
   * Stops timer if extension is uninstalled or deactivated.
   * Starts bounded timer and evaluates reminders at startup if active.
   */
  async sync(): Promise<void> {
    const isAvailable = await this.isActive()
    if (!isAvailable) {
      this.stop()
      return
    }
    this.start()
    await this.checkAndNotify()
  }

  start(): void {
    if (this.running && this.timer) return
    this.running = true
    this.timer = setInterval(() => {
      void this.checkAndNotify().catch(() => undefined)
    }, this.pollIntervalMs)
    if (typeof this.timer?.unref === 'function') {
      this.timer.unref()
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.running = false
  }

  /**
   * Evaluates all tracked subscriptions for upcoming or overdue renewal charges.
   * Serialized across concurrent callers to prevent duplicate notifications.
   */
  async checkAndNotify(options?: { forceToday?: string }): Promise<number> {
    const operation = this.runChain
      .catch(() => 0)
      .then(() => this.executeCheck(options))
    this.runChain = operation
    return operation
  }

  private async executeCheck(options?: { forceToday?: string }): Promise<number> {
    const active = await this.isActive()
    if (!active) {
      this.stop()
      return 0
    }

    const today = options?.forceToday ?? this.getToday()
    const subscriptions = await this.store.list()
    let sentCount = 0

    for (const sub of subscriptions) {
      // Re-check live activation before each dispatch
      if (!(await this.isActive())) return sentCount

      // Re-read live subscription state to prevent duplicate delivery
      const liveSub = await this.store.get(sub.id)
      if (!liveSub || liveSub.status !== 'active') continue

      // Skip one-time charges that were already paid
      if (liveSub.cycle === 'one-time' && liveSub.lastPaidDate) continue

      const diffDays = differenceInDays(today, liveSub.nextRenewalDate)

      // Within reminder window or overdue (catch up on missed renewals beyond 1 day)
      const isDue = diffDays <= liveSub.reminderDays
      if (!isDue) continue

      // Deduplicate: avoid firing multiple OS reminders for the same renewal date
      if (liveSub.lastNotifiedRenewalDate === liveSub.nextRenewalDate) continue

      const title = 'ND Pay Guard'
      const body = formatReminderMessage(liveSub, diffDays)

      let outcome: PayGuardDeliveryOutcome = { delivered: false, reason: 'failed' }
      try {
        const result = await Promise.resolve(this.notifier({ title, body }))
        outcome = normalizeDeliveryOutcome(result)
      } catch (err) {
        outcome = {
          delivered: false,
          reason: 'error',
          error: err instanceof Error ? err.message : String(err),
        }
      }

      // Only mark notified and increment count when delivery actually succeeded
      if (outcome.delivered) {
        await this.store.markNotified(liveSub.id, liveSub.nextRenewalDate)
        sentCount += 1
      }
    }

    return sentCount
  }

  /**
   * Send an immediate test notification to verify OS delivery.
   */
  async sendTestNotification(): Promise<PayGuardTestNotificationResult> {
    const title = 'ND Pay Guard'
    const body =
      'Test notification: OS reminders are active! Keep ND running and ensure system notifications are enabled to receive renewal alerts.'
    let outcome: PayGuardDeliveryOutcome = { delivered: false, reason: 'failed' }
    try {
      const result = await Promise.resolve(this.notifier({ title, body }))
      outcome = normalizeDeliveryOutcome(result)
    } catch (err) {
      outcome = {
        delivered: false,
        reason: 'error',
        error: err instanceof Error ? err.message : String(err),
      }
    }

    if (outcome.delivered) {
      return {
        ok: true,
        delivered: true,
        message: 'Test notification delivered to system notification center.',
      }
    }

    const guidance = buildNotificationGuidance(outcome)
    const failureMsg = outcome.error
      ? `OS desktop notification failed: ${outcome.error}`
      : 'OS desktop notification could not be delivered.'

    return {
      ok: false,
      delivered: false,
      message: failureMsg,
      error: outcome.error,
      reason: outcome.reason,
      guidance,
    }
  }

  private async isActive(): Promise<boolean> {
    try {
      const manifest = await this.packages.activeManifest(PAY_GUARD_EXTENSION_ID)
      if (!manifest) return false
      const activation = await this.state.activation(PAY_GUARD_EXTENSION_ID, { kind: 'personal' })
      return activation?.enabled === true
    } catch {
      return false
    }
  }
}
