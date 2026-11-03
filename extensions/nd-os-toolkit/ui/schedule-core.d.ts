/**
 * Types for `schedule-core.js`, the package copy of
 * `src/shared/os-toolkit-schedule.ts`. Kept beside the plain-JavaScript module so
 * the repo can typecheck the frame's logic without building it.
 */

export type OsThemeMode = 'light' | 'dark'

export type OsToolkitBackendChoice = 'auto' | 'native' | 'powertoys'

export type ScheduleIssue = 'invalid-time' | 'equal-times'

export interface OsToolkitScheduleTimes {
  dayStart: string
  nightStart: string
}

export type DesiredThemeResult =
  | { ok: true; theme: OsThemeMode }
  | { ok: false; reason: ScheduleIssue }

export type NextChangeResult =
  | { ok: true; at: number; theme: OsThemeMode; minutesUntil: number }
  | { ok: false; reason: ScheduleIssue }

export interface TimelineSegment {
  theme: OsThemeMode
  start: number
  end: number
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

export declare const MINUTES_PER_DAY: number
export declare const OS_TOOLKIT_BACKENDS: readonly OsToolkitBackendChoice[]
export declare const OS_TOOLKIT_SETTING_DEFAULTS: OsToolkitSettings
export declare const OS_TOOLKIT_SETTING_KEYS: string[]

export declare function isOsToolkitBackendChoice(value: unknown): value is OsToolkitBackendChoice
export declare function parseHHMM(value: unknown): number | null
export declare function formatHHMM(minutes: number): string | null
export declare function minutesOfDay(now: Date): number
export declare function desiredTheme(
  schedule: OsToolkitScheduleTimes | null | undefined,
  now: Date,
): DesiredThemeResult
export declare function isLightNow(day: number, night: number, current: number): boolean
export declare function nextChange(
  schedule: OsToolkitScheduleTimes | null | undefined,
  now: Date,
): NextChangeResult
export declare function timelineSegments(
  schedule: OsToolkitScheduleTimes | null | undefined,
): TimelineSegment[]
export declare function describeScheduleIssue(reason: ScheduleIssue): string
export declare function resolveOsToolkitSettings(
  raw: Record<string, unknown> | null | undefined,
): OsToolkitSettings
export declare function validateOsToolkitSetting(key: string, value: unknown): string | boolean
