/**
 * Day/night theme scheduler for the OS Toolkit extension.
 *
 * Windows 11 exposes no custom theme schedule, and PowerToys Light Switch cannot
 * be driven into having one (its CLI reuses times already saved in PowerToys
 * Settings), so ND owns the schedule. This controller is deliberately shaped like
 * `PayGuardScheduler`: a bounded, `unref`'d interval that re-checks activation on
 * every tick and stops itself, because AGENTS.md requires native background jobs
 * to reconcile activation and settings and stop when disabled.
 *
 * Two rules keep it from being annoying:
 *
 * 1. It only applies when the *desired* theme differs from the one ND last
 *    applied. A person who flips Windows to light during dark hours keeps light
 *    until the next boundary; ND does not fight them every tick.
 * 2. An unschedulable pair of times (equal, or unparseable) means "do nothing",
 *    never "pick a winner".
 */

import process from 'node:process'
import {
  desiredTheme,
  resolveOsToolkitSettings,
  OS_TOOLKIT_EXTENSION_ID,
  type OsThemeMode,
  type OsToolkitSettings,
} from '../../shared/os-toolkit-schedule.js'
import type { CoreOsTheme } from '../core/core-os-theme.js'
import {
  applyOsTheme,
  disableLightSwitchSchedule,
  probeLightSwitch,
  resolveBackend,
  type ApplyOsThemeResult,
} from '../os/theme.js'
import type { InvocationStateStore } from './invocation-state.js'
import type { ExtensionPackageStore } from './package-store.js'

const DEFAULT_POLL_INTERVAL_MS = 60_000
/** A theme schedule has minute resolution; polling faster buys nothing. */
const MIN_POLL_INTERVAL_MS = 30_000

const PERSONAL_CONTEXT = { kind: 'personal' } as const

export interface OsToolkitSchedulerOptions {
  state: InvocationStateStore
  packages: ExtensionPackageStore
  core?: CoreOsTheme
  platform?: NodeJS.Platform
  now?: () => Date
  pollIntervalMs?: number
  onLog?: (line: string) => void
  /** Injectable so tests never touch a real desktop. */
  apply?: typeof applyOsTheme
  resolve?: typeof resolveBackend
  disableLightSwitch?: typeof disableLightSwitchSchedule
  /**
   * Reads the theme currently on screen. Injectable because the fallback path
   * spawns Light Switch's CLI, and a unit test must not.
   */
  readScreen?: () => Promise<OsThemeMode | null>
}

export interface OsToolkitReconcileResult {
  ran: boolean
  reason: string
  theme?: OsThemeMode
  result?: ApplyOsThemeResult
}

export class OsToolkitScheduler {
  private readonly state: InvocationStateStore
  private readonly packages: ExtensionPackageStore
  private readonly core: CoreOsTheme | undefined
  private readonly platform: NodeJS.Platform
  private readonly now: () => Date
  private readonly pollIntervalMs: number
  private readonly onLog: (line: string) => void
  private readonly applyFn: typeof applyOsTheme
  private readonly resolveFn: typeof resolveBackend
  private readonly disableLightSwitchFn: typeof disableLightSwitchSchedule
  private readonly readScreenFn: () => Promise<OsThemeMode | null>

  private timer: NodeJS.Timeout | null = null
  private running = false
  private runChain: Promise<OsToolkitReconcileResult> = Promise.resolve({ ran: false, reason: 'idle' })
  /** The theme ND last put on screen, or null when ND has not applied anything. */
  private lastAppliedTheme: OsThemeMode | null = null
  private lightSwitchScheduleDisabled = false

  constructor(options: OsToolkitSchedulerOptions) {
    this.state = options.state
    this.packages = options.packages
    this.core = options.core
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? ((): Date => new Date())
    this.pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    this.onLog = options.onLog ?? ((): void => undefined)
    this.applyFn = options.apply ?? applyOsTheme
    this.resolveFn = options.resolve ?? resolveBackend
    this.disableLightSwitchFn = options.disableLightSwitch ?? disableLightSwitchSchedule
    this.readScreenFn = options.readScreen ?? ((): Promise<OsThemeMode | null> => this.readScreenTheme())
  }

  get isRunning(): boolean {
    return this.running
  }

  /**
   * Reconcile with extension state: stop when uninstalled, deactivated, or when
   * the schedule is switched off; otherwise run the bounded timer and, if the
   * user asked for it, apply the correct theme immediately.
   */
  async sync(): Promise<void> {
    const active = await this.isActive()
    if (!active) {
      this.stop()
      return
    }
    const settings = await this.settings()
    this.start()
    if (settings.startupReconcile) {
      await this.reconcile()
      return
    }
    // Declining startup reconcile must not mean "override me at the first tick":
    // seed from whatever is already on screen so only a real boundary applies.
    await this.primeFromScreen()
  }

  start(): void {
    if (this.running && this.timer) return
    this.running = true
    this.timer = setInterval(() => {
      void this.reconcile().catch(() => undefined)
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
    this.lightSwitchScheduleDisabled = false
  }

  /**
   * Called by the `nativeTheme` drift listener and `powerMonitor` resume, where an
   * OS theme change from any source (including PowerToys) is worth re-checking.
   * Serialized across concurrent callers so overlapping ticks cannot double-apply.
   */
  async reconcile(): Promise<OsToolkitReconcileResult> {
    const operation = this.runChain
      .catch(() => ({ ran: false, reason: 'previous reconcile failed' }))
      .then(() => this.executeReconcile())
    this.runChain = operation
    return operation
  }

  private async executeReconcile(): Promise<OsToolkitReconcileResult> {
    // Re-check activation on every tick and self-stop, so a disable in another
    // window can never be missed.
    if (!(await this.isActive())) {
      this.stop()
      return { ran: false, reason: 'extension is not active' }
    }
    const settings = await this.settings()
    if (!settings.schedulerEnabled) {
      return { ran: false, reason: 'the day/night schedule is switched off' }
    }

    const desired = desiredTheme(settings, this.now())
    if (!desired.ok) {
      // Equal or unparseable times describe no schedule. Doing nothing is the
      // only safe answer; picking one would thrash the desktop every tick.
      return { ran: false, reason: `nothing to schedule (${desired.reason})` }
    }
    if (this.lastAppliedTheme === desired.theme) {
      return { ran: false, reason: `Windows is already scheduled for ${desired.theme} mode`, theme: desired.theme }
    }

    const resolution = await this.resolveFn(settings.backend, {
      ...(this.core === undefined ? {} : { core: this.core }),
      platform: this.platform,
      onLog: this.onLog,
    })
    if (!this.running) {
      return { ran: false, reason: 'the scheduler stopped while resolving the backend' }
    }

    if (resolution.backend === 'powertoys' && settings.lightSwitchSync && !this.lightSwitchScheduleDisabled) {
      // Two schedulers writing one registry key means the last writer wins and
      // neither is predictable. Turn theirs off once, and say so.
      const disabled = await this.disableLightSwitchFn({ platform: this.platform, onLog: this.onLog })
      this.lightSwitchScheduleDisabled = disabled.ok
      this.onLog(`[os-toolkit] ${disabled.message}`)
    }

    const result = await this.applyFn(desired.theme, {
      backend: resolution.backend,
      apps: settings.applyApps,
      system: settings.applySystem,
      ...(this.core === undefined ? {} : { core: this.core }),
      platform: this.platform,
      onLog: this.onLog,
    })
    if (result.ok) {
      this.lastAppliedTheme = desired.theme
    } else {
      this.onLog(`[os-toolkit] could not apply ${desired.theme} mode: ${result.message}`)
    }
    return { ran: result.ok, reason: result.message, theme: desired.theme, result }
  }

  private async primeFromScreen(): Promise<void> {
    if (this.lastAppliedTheme !== null) return
    const current = await this.readScreenFn()
    if (current) this.lastAppliedTheme = current
  }

  /** Best-effort read of what is on screen right now, without changing anything. */
  async readScreenTheme(): Promise<OsThemeMode | null> {
    if (this.platform === 'win32' && this.core?.supported()) {
      const state = await this.core.state()
      if (state.available) return state.systemTheme
    }
    const status = await probeLightSwitch({ platform: this.platform, onLog: this.onLog })
    return status.systemTheme ?? status.appsTheme ?? null
  }

  private async settings(): Promise<OsToolkitSettings> {
    const raw = await this.state.settingsFor(OS_TOOLKIT_EXTENSION_ID, PERSONAL_CONTEXT)
    return resolveOsToolkitSettings(raw)
  }

  /**
   * Installed *and* activated *and* on a platform this can drive. Installation is
   * availability while activation is authorization, and neither implies the other.
   */
  private async isActive(): Promise<boolean> {
    if (this.platform !== 'win32') return false
    try {
      const manifest = await this.packages.activeManifest(OS_TOOLKIT_EXTENSION_ID)
      if (!manifest) return false
      const activation = await this.state.activation(OS_TOOLKIT_EXTENSION_ID, PERSONAL_CONTEXT)
      return activation?.enabled === true
    } catch {
      return false
    }
  }
}
