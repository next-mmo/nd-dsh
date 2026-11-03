/**
 * OS Toolkit — day/night schedule arithmetic, package copy.
 *
 * This is a deliberate duplicate of `src/shared/os-toolkit-schedule.ts`. The web
 * view is served only from the installed package snapshot, so it cannot import
 * from the app tree; `tests/os-toolkit-schedule.test.ts` runs one shared case
 * table against both files and fails if they drift.
 *
 * Plain JavaScript on purpose: it runs unbuilt inside the frame and stays
 * directly unit-testable from the repo. See `schedule-core.d.ts` for types.
 *
 * Minutes-since-midnight only. DST is irrelevant because the schedule is a daily
 * wall-clock pattern, not an instant: a 25-hour day still switches at 07:00.
 */

export const MINUTES_PER_DAY = 24 * 60

export const OS_TOOLKIT_BACKENDS = ['auto', 'native', 'powertoys']

export function isOsToolkitBackendChoice(value) {
  return typeof value === 'string' && OS_TOOLKIT_BACKENDS.includes(value)
}

/**
 * Parse a 24-hour `HH:MM` string into minutes since midnight.
 *
 * Accepts a one-digit hour (`7:00`) because that is what people type, and rejects
 * everything else rather than clamping: a schedule silently moved to a valid time
 * is worse than a visible error.
 */
export function parseHHMM(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** Inverse of {@link parseHHMM}, zero-padded. */
export function formatHHMM(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= MINUTES_PER_DAY) return null
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

export function minutesOfDay(now) {
  return now.getHours() * 60 + now.getMinutes()
}

function readTimes(schedule) {
  const day = parseHHMM(schedule && schedule.dayStart)
  const night = parseHHMM(schedule && schedule.nightStart)
  if (day === null || night === null) return { reason: 'invalid-time' }
  // Equal times describe no schedule at all. Callers must do nothing rather than
  // pick a winner, or the scheduler would thrash the desktop every tick.
  if (day === night) return { reason: 'equal-times' }
  return { day, night }
}

/** Which theme should be on screen right now. */
export function desiredTheme(schedule, now) {
  const times = readTimes(schedule)
  if (times.reason) return { ok: false, reason: times.reason }
  return { ok: true, theme: isLightNow(times.day, times.night, minutesOfDay(now)) ? 'light' : 'dark' }
}

/**
 * Light window is `[dayStart, nightStart)`. When `dayStart > nightStart` the
 * light window wraps past midnight, so it becomes the union of the two ends of
 * the day rather than an empty range.
 */
export function isLightNow(day, night, current) {
  return day < night ? current >= day && current < night : current >= day || current < night
}

/** The next boundary, for "Dark starts in 2h 13m". */
export function nextChange(schedule, now) {
  const times = readTimes(schedule)
  if (times.reason) return { ok: false, reason: times.reason }
  const current = minutesOfDay(now)
  const until = (target) => (target - current + MINUTES_PER_DAY) % MINUTES_PER_DAY
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
export function timelineSegments(schedule) {
  const times = readTimes(schedule)
  if (times.reason) return []
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
export function describeScheduleIssue(reason) {
  return reason === 'invalid-time'
    ? 'Both times must be 24-hour HH:MM, for example 07:00 and 19:00.'
    : 'The light and dark start times must differ, otherwise there is nothing to schedule.'
}

export const OS_TOOLKIT_SETTING_DEFAULTS = {
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

function readBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function readTime(value, fallback) {
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
 * Coerce a raw settings bag into fully populated settings. Unknown keys are
 * ignored and wrong types fall back to the default. Times that are present but
 * unparseable are preserved verbatim: the schedule then refuses to run and says
 * why, instead of quietly applying defaults.
 */
export function resolveOsToolkitSettings(raw) {
  const source = raw ?? {}
  const defaults = OS_TOOLKIT_SETTING_DEFAULTS
  return {
    schedulerEnabled: readBoolean(source.schedulerEnabled, defaults.schedulerEnabled),
    backend: isOsToolkitBackendChoice(source.backend) ? source.backend : defaults.backend,
    dayStart: readTime(source.dayStart, defaults.dayStart),
    nightStart: readTime(source.nightStart, defaults.nightStart),
    applyApps: readBoolean(source.applyApps, defaults.applyApps),
    applySystem: readBoolean(source.applySystem, defaults.applySystem),
    lightSwitchSync: readBoolean(source.lightSwitchSync, defaults.lightSwitchSync),
    startupReconcile: readBoolean(source.startupReconcile, defaults.startupReconcile),
  }
}

/** Validate one setting before it is stored, throwing a human message. */
export function validateOsToolkitSetting(key, value) {
  if (!OS_TOOLKIT_SETTING_KEYS.includes(key)) {
    throw new Error(`OS Toolkit has no setting named "${key}".`)
  }
  const fallback = OS_TOOLKIT_SETTING_DEFAULTS[key]
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
