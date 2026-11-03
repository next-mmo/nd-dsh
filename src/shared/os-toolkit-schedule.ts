/**
 * Day/night theme schedule arithmetic for the OS Toolkit extension.
 *
 * Deliberately DOM-free, dependency-free and wall-clock based so the exact same
 * rules run in three places: the main-process scheduler, the package's web view
 * (`extensions/nd-os-toolkit/ui/schedule-core.js`, which is a copy because the
 * frame is served from the package snapshot and cannot import `src/shared`), and
 * the unit tests that assert the two copies agree.
 *
 * Minutes-since-midnight only. DST is irrelevant because the schedule is a daily
 * wall-clock pattern, not an instant: a 25-hour day still switches at 07:00.
 */

export type OsThemeMode = 'light' | 'dark'

/**
 * The one place the package id is spelled. `nd-os-toolkit/nd-extension.json`,
 * the main-process wiring, and the scheduler all read it from here so they cannot
 * drift apart.
 */
export const OS_TOOLKIT_EXTENSION_ID = 'nd.os-toolkit'

export const MINUTES_PER_DAY = 24 * 60

export const OS_TOOLKIT_BACKENDS = ['auto', 'native', 'powertoys'] as const
export type OsToolkitBackendChoice = (typeof OS_TOOLKIT_BACKENDS)[number]

export function isOsToolkitBackendChoice(value: unknown): value is OsToolkitBackendChoice {
  return typeof value === 'string' && (OS_TOOLKIT_BACKENDS as readonly string[]).includes(value)
}

/** The two times that define the schedule, as stored in extension settings. */
export interface OsToolkitScheduleTimes {
  dayStart: string
  nightStart: string
}

export type ScheduleIssue = 'invalid-time' | 'equal-times'

export type DesiredThemeResult =
  | { ok: true; theme: OsThemeMode }
  | { ok: false; reason: ScheduleIssue }

export type NextChangeResult =
  | { ok: true; at: number; theme: OsThemeMode; minutesUntil: number }
  | { ok: false; reason: ScheduleIssue }

export interface TimelineSegment {
  theme: OsThemeMode
  /** Inclusive start, minutes since midnight. */
  start: number
  /** Exclusive end. Always greater than `start`: a crossing range is split. */
  end: number
}

/**
 * Parse a 24-hour `HH:MM` string into minutes since midnight.
 *
 * Accepts a one-digit hour (`7:00`) because that is what people type, and rejects
 * everything else rather than clamping: a schedule silently moved to a valid time
 * is worse than a visible error.
 */
export function parseHHMM(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** Inverse of {@link parseHHMM}, zero-padded. */
export function formatHHMM(minutes: number): string | null {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= MINUTES_PER_DAY) return null
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

export function minutesOfDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes()
}

function readTimes(schedule: OsToolkitScheduleTimes | null | undefined): { day: number; night: number } | { reason: ScheduleIssue } {
  const day = parseHHMM(schedule?.dayStart)
  const night = parseHHMM(schedule?.nightStart)
  if (day === null || night === null) return { reason: 'invalid-time' }
  // Equal times describe no schedule at all. Callers must do nothing rather than
  // pick a winner, or the scheduler would thrash the desktop every tick.
  if (day === night) return { reason: 'equal-times' }
  return { day, night }
}

/** Which theme should be on screen right now. */
export function desiredTheme(schedule: OsToolkitScheduleTimes | null | undefined, now: Date): DesiredThemeResult {
  const times = readTimes(schedule)
  if ('reason' in times) return { ok: false, reason: times.reason }
  return { ok: true, theme: isLightNow(times.day, times.night, minutesOfDay(now)) ? 'light' : 'dark' }
}

/**
 * Light window is `[dayStart, nightStart)`. When `dayStart > nightStart` the
 * light window wraps past midnight, so it becomes the union of the two ends of
 * the day rather than an empty range.
 */
export function isLightNow(day: number, night: number, current: number): boolean {
  return day < night
    ? current >= day && current < night
    : current >= day || current < night
}

/** The next boundary, for "Dark starts in 2h 13m" and for scheduler countdowns. */
export function nextChange(schedule: OsToolkitScheduleTimes | null | undefined, now: Date): NextChangeResult {
  const times = readTimes(schedule)
  if ('reason' in times) return { ok: false, reason: times.reason }
  const current = minutesOfDay(now)
  const until = (target: number): number => (target - current + MINUTES_PER_DAY) % MINUTES_PER_DAY
  const toDay = until(times.day)
  const toNight = until(times.night)
  return toDay <= toNight
    ? { ok: true, at: times.day, theme: 'light', minutesUntil: toDay }
    : { ok: true, at: times.night, theme: 'dark', minutesUntil: toNight }
}

/**
 * The whole day as ordered theme segments, for the 24-hour timeline ring.
 * Returns an empty array for an unschedulable pair so the UI renders an
 * actionable explanation instead of a blank or misleading timeline.
 */
export function timelineSegments(schedule: OsToolkitScheduleTimes | null | undefined): TimelineSegment[] {
  const times = readTimes(schedule)
  if ('reason' in times) return []
  const { day, night } = times
  return day < night
    ? [
        { theme: 'dark', start: 0, end: day },
        { theme: 'light', start: day, end: night },
        { theme: 'dark', start: night, end: MINUTES_PER_DAY },
      ]
    : [
        { theme: 'light', start: 0, end: night },
        { theme: 'dark', start: night, end: day },
        { theme: 'light', start: day, end: MINUTES_PER_DAY },
      ]
}

/** One shared wording for both refusals, so main and the frame never disagree. */
export function describeScheduleIssue(reason: ScheduleIssue): string {
  return reason === 'invalid-time'
    ? 'Both times must be 24-hour HH:MM, for example 07:00 and 19:00.'
    : 'The light and dark start times must differ, otherwise there is nothing to schedule.'
}

export interface OsToolkitSettings {
  schedulerEnabled: boolean
  backend: OsToolkitBackendChoice
  dayStart: string
  nightStart: string
  applyApps: boolean
  applySystem: boolean
  lightSwitchSync: boolean
  startupReconcile: boolean
}

/**
 * Every effectful default is off. `schedulerEnabled` gates the timer, so nothing
 * changes the desktop until the user asks for it.
 */
export const OS_TOOLKIT_SETTING_DEFAULTS: OsToolkitSettings = {
  schedulerEnabled: false,
  backend: 'auto',
  dayStart: '07:00',
  nightStart: '19:00',
  applyApps: true,
  applySystem: true,
  lightSwitchSync: true,
  startupReconcile: true,
}

export const OS_TOOLKIT_SETTING_KEYS = Object.keys(OS_TOOLKIT_SETTING_DEFAULTS)

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readTime(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  // Absent or blank means "not configured", so the default is the honest answer.
  if (trimmed.length === 0) return fallback
  const minutes = parseHHMM(trimmed)
  // A valid time is normalized so what is stored is what the UI shows (`7:00` →
  // `07:00`).
  if (minutes !== null) return formatHHMM(minutes) ?? trimmed
  // Present but unusable is kept verbatim, so `desiredTheme` can report
  // `invalid-time` and the scheduler can do nothing. Coercing it to a default
  // would silently move a person's schedule to a time they never chose, which is
  // exactly what `parseHHMM` refuses to do for the same reason.
  return trimmed
}

/**
 * Coerce a raw activation-settings bag into fully populated settings.
 *
 * Values arrive from the web view as arbitrary JSON and the broker does not
 * validate payloads, so unknown keys are ignored and wrong types fall back to the
 * default. Times that are present but unparseable are preserved verbatim: the
 * schedule then refuses to run and says why, instead of quietly applying defaults.
 */
export function resolveOsToolkitSettings(raw: Record<string, unknown> | null | undefined): OsToolkitSettings {
  const source = raw ?? {}
  return {
    schedulerEnabled: readBoolean(source.schedulerEnabled, OS_TOOLKIT_SETTING_DEFAULTS.schedulerEnabled),
    backend: isOsToolkitBackendChoice(source.backend) ? source.backend : OS_TOOLKIT_SETTING_DEFAULTS.backend,
    dayStart: readTime(source.dayStart, OS_TOOLKIT_SETTING_DEFAULTS.dayStart),
    nightStart: readTime(source.nightStart, OS_TOOLKIT_SETTING_DEFAULTS.nightStart),
    applyApps: readBoolean(source.applyApps, OS_TOOLKIT_SETTING_DEFAULTS.applyApps),
    applySystem: readBoolean(source.applySystem, OS_TOOLKIT_SETTING_DEFAULTS.applySystem),
    lightSwitchSync: readBoolean(source.lightSwitchSync, OS_TOOLKIT_SETTING_DEFAULTS.lightSwitchSync),
    startupReconcile: readBoolean(source.startupReconcile, OS_TOOLKIT_SETTING_DEFAULTS.startupReconcile),
  }
}

/**
 * Validate one setting before it is stored.
 *
 * Throws with a human message rather than returning a code, because the string is
 * what the extension UI surfaces. Rejecting here keeps an invalid time out of
 * `nd-invocation-state.json` entirely instead of relying on every reader to cope.
 */
export function validateOsToolkitSetting(key: string, value: unknown): string | boolean {
  if (!(OS_TOOLKIT_SETTING_KEYS as string[]).includes(key)) {
    throw new Error(`OS Toolkit has no setting named "${key}".`)
  }
  const fallback = OS_TOOLKIT_SETTING_DEFAULTS[key as keyof OsToolkitSettings]
  if (typeof fallback === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`"${key}" must be true or false.`)
    return value
  }
  if (key === 'backend') {
    if (!isOsToolkitBackendChoice(value)) {
      throw new Error(`"${key}" must be one of: ${OS_TOOLKIT_BACKENDS.join(', ')}.`)
    }
    return value
  }
  const minutes = parseHHMM(value)
  if (minutes === null) {
    throw new Error(`"${key}" must be a 24-hour time such as 07:00.`)
  }
  return formatHHMM(minutes) ?? String(value)
}

/** Light, dark, or flip whatever is on screen. */
export type ThemeApplyTarget = OsThemeMode | 'toggle'

const APPLY_COMMANDS: Record<string, ThemeApplyTarget> = {
  'light-now': 'light',
  'dark-now': 'dark',
  'toggle': 'toggle',
}

/**
 * Resolve which theme a `ostoolkit.theme.apply` call means.
 *
 * A command contribution carries no payload of its own, so the three launcher
 * commands convey their intent through the contribution id; the studio's `apply`
 * action passes an explicit `mode` instead. Anything else is refused rather than
 * defaulted, because guessing here would change the user's desktop unexpectedly.
 */
export function osToolkitApplyTarget(extensionId: string, contributionId: string, rawMode: unknown): ThemeApplyTarget {
  if (extensionId !== OS_TOOLKIT_EXTENSION_ID) throw new Error('Only OS Toolkit can change the Windows theme.')
  const fromCommand = APPLY_COMMANDS[contributionId]
  if (fromCommand) return fromCommand
  if (rawMode === 'light' || rawMode === 'dark' || rawMode === 'toggle') return rawMode
  throw new Error('Choose light, dark, or toggle.')
}
