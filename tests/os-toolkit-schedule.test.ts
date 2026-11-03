import { describe, expect, it } from 'vitest'
import {
  describeScheduleIssue as sharedDescribeIssue,
  desiredTheme as sharedDesired,
  formatHHMM as sharedFormat,
  isLightNow as sharedIsLightNow,
  minutesOfDay as sharedMinutesOfDay,
  nextChange as sharedNextChange,
  parseHHMM as sharedParse,
  resolveOsToolkitSettings as sharedResolve,
  timelineSegments as sharedSegments,
  validateOsToolkitSetting as sharedValidate,
} from '../src/shared/os-toolkit-schedule.js'
import {
  describeScheduleIssue as packDescribeIssue,
  desiredTheme as packDesired,
  formatHHMM as packFormat,
  isLightNow as packIsLightNow,
  minutesOfDay as packMinutesOfDay,
  nextChange as packNextChange,
  parseHHMM as packParse,
  resolveOsToolkitSettings as packResolve,
  timelineSegments as packSegments,
  validateOsToolkitSetting as packValidate,
} from '../extensions/nd-os-toolkit/ui/schedule-core.js'

/**
 * The web view is served only from the installed package snapshot, so it cannot
 * import from `src/shared` and carries its own copy of the schedule rules. That
 * duplication is the one real drift risk in this feature, and this file is what
 * prevents it: every case below is run against BOTH copies and the two must
 * produce identical results and identical error wording.
 *
 * The semantic assertions are written independently of the parity loop, so a
 * mistake shared by both copies still fails here.
 */

const at = (hour: number, minute: number): Date => new Date(2026, 0, 15, hour, minute, 0)

function agree<A extends unknown[], R>(label: string, shared: (...args: A) => R, packaged: (...args: A) => R, args: A): void {
  expect(packaged(...args), `${label}(${args.map((value) => JSON.stringify(value)).join(', ')})`)
    .toEqual(shared(...args))
}

function agreeThrows(label: string, shared: () => unknown, packaged: () => unknown): void {
  const collect = (fn: () => unknown): { threw: boolean; message: string } => {
    try {
      return { threw: false, message: String(fn()) }
    } catch (error) {
      return { threw: true, message: error instanceof Error ? error.message : String(error) }
    }
  }
  expect(collect(packaged), `${label} should match`).toEqual(collect(shared))
}

const PARSE_CASES: unknown[] = [
  '00:00', '07:00', '7:00', '12:34', '23:59', ' 07:00 ', '0700', '7:0', '7',
  '24:00', '25:00', '12:60', '12:5', '07:000', '-1:00', '7:00 PM', '', '   ',
  'abc', '07.00', '07:00:00', null, undefined, 7, true, {}, [], ['07:00'],
]

const FORMAT_CASES: unknown[] = [0, 1, 59, 60, 420, 1140, 1439, 1440, 1441, -1, -60, 1.5, 30.5, NaN, Infinity]

const SCHEDULES = [
  { dayStart: '07:00', nightStart: '19:00' },
  { dayStart: '22:00', nightStart: '06:00' },
  { dayStart: '00:00', nightStart: '23:59' },
  { dayStart: '23:59', nightStart: '00:00' },
  { dayStart: '19:00', nightStart: '19:00' },
  { dayStart: '07:00', nightStart: '07:01' },
  { dayStart: '25:00', nightStart: '19:00' },
  { dayStart: '07:00', nightStart: 'nope' },
  { dayStart: '', nightStart: '' },
]

const CLOCK = [at(0, 0), at(6, 0), at(6, 59), at(7, 0), at(12, 0), at(18, 59), at(19, 0), at(19, 1), at(22, 0), at(23, 59)]

/** The subset of SCHEDULES that describes a real schedule. */
const SCHEDULABLE = [
  { dayStart: '07:00', nightStart: '19:00' },
  { dayStart: '22:00', nightStart: '06:00' },
  { dayStart: '00:00', nightStart: '23:59' },
  { dayStart: '23:59', nightStart: '00:00' },
  { dayStart: '07:00', nightStart: '07:01' },
]

/** Light window start/end in minutes, including one that wraps midnight. */
const LIGHT_NIGHT_PAIRS: Array<[number, number]> = [[420, 1140], [1320, 360], [0, 1439], [1439, 0]]

describe('OS Toolkit schedule rules are identical in both copies', () => {
  it('agrees on every parseHHMM input, including the hostile ones', () => {
    for (const value of PARSE_CASES) agree('parseHHMM', sharedParse, packParse, [value])
  })

  it('agrees on every formatHHMM input', () => {
    for (const value of FORMAT_CASES) agree('formatHHMM', sharedFormat, packFormat, [value as number])
  })

  it('agrees on the whole day for desiredTheme, nextChange and timelineSegments', () => {
    for (const schedule of SCHEDULES) {
      for (const now of CLOCK) {
        agree('desiredTheme', sharedDesired, packDesired, [schedule, now])
        agree('nextChange', sharedNextChange, packNextChange, [schedule, now])
      }
      agree('timelineSegments', sharedSegments, packSegments, [schedule])
      agree('minutesOfDay', sharedMinutesOfDay, packMinutesOfDay, [at(4, 7)])
    }
  })

  it('agrees on isLightNow for every minute of a crossing and a normal day', () => {
    for (const [day, night] of LIGHT_NIGHT_PAIRS) {
      for (let current = 0; current < 1440; current += 1) {
        agree('isLightNow', sharedIsLightNow, packIsLightNow, [day, night, current])
      }
    }
  })

  it('agrees on settings resolution for malformed and unknown input', () => {
    const cases: unknown[] = [
      undefined,
      null,
      {},
      { schedulerEnabled: 'yes', dayStart: 7, nightStart: '19:00', backend: 'magic' },
      { dayStart: '7:00' },
      { dayStart: '07:00:00', nightStart: '25:00' },
      { backend: 'powertoys', applyApps: false, applySystem: false },
      { unknownKey: 'ignored' },
      { lightSwitchSync: 1, startupReconcile: null },
    ]
    for (const value of cases) agree('resolveOsToolkitSettings', sharedResolve, packResolve, [value as Record<string, unknown>])
  })

  it('agrees on setting validation wording, thrown or returned', () => {
    const cases: Array<[string, unknown]> = [
      ['dayStart', '7:00'],
      ['dayStart', '24:00'],
      ['dayStart', ''],
      ['nightStart', '19:30'],
      ['backend', 'auto'],
      ['backend', 'native'],
      ['backend', 'powertoys'],
      ['backend', 'magic'],
      ['schedulerEnabled', true],
      ['schedulerEnabled', 'true'],
      ['applyApps', false],
      ['lightSwitchSync', 1],
      ['startupReconcile', undefined],
      ['noSuchKey', 'anything'],
    ]
    for (const [key, value] of cases) {
      // agreeThrows compares the returned value AND the thrown message, so both
      // copies have to agree on the wording, not merely on succeeding.
      agreeThrows(`validateOsToolkitSetting(${key}, ${JSON.stringify(value)})`,
        () => sharedValidate(key, value),
        () => packValidate(key, value))
    }
  })

  it('agrees on the two issue wordings', () => {
    for (const reason of ['invalid-time', 'equal-times'] as const) {
      agree('describeScheduleIssue', sharedDescribeIssue, packDescribeIssue, [reason])
    }
  })
})

describe('OS Toolkit schedule rules mean what they say', () => {
  it('parses only real 24-hour times and normalizes a one-digit hour', () => {
    expect(sharedParse('07:00')).toBe(420)
    // A one-digit hour is accepted because that is what people type.
    expect(sharedParse('7:00')).toBe(420)
    expect(sharedParse(' 07:00 ')).toBe(420)
    expect(sharedParse('24:00')).toBeNull()
    expect(sharedParse('07:60')).toBeNull()
    expect(sharedParse('7:0')).toBeNull()
    expect(sharedParse(420)).toBeNull()
    expect(sharedFormat(420)).toBe('07:00')
    expect(sharedFormat(1440)).toBeNull()
    expect(sharedFormat(-1)).toBeNull()
  })

  it('keeps light between the two times on a normal day', () => {
    const day = { dayStart: '07:00', nightStart: '19:00' }
    expect(sharedDesired(day, at(6, 59))).toEqual({ ok: true, theme: 'dark' })
    expect(sharedDesired(day, at(7, 0))).toEqual({ ok: true, theme: 'light' })
    expect(sharedDesired(day, at(12, 0))).toEqual({ ok: true, theme: 'light' })
    expect(sharedDesired(day, at(18, 59))).toEqual({ ok: true, theme: 'light' })
    expect(sharedDesired(day, at(19, 0))).toEqual({ ok: true, theme: 'dark' })
  })

  it('wraps light past midnight when the day start is after the night start', () => {
    const crossing = { dayStart: '22:00', nightStart: '06:00' }
    expect(sharedDesired(crossing, at(22, 0))).toEqual({ ok: true, theme: 'light' })
    expect(sharedDesired(crossing, at(23, 59))).toEqual({ ok: true, theme: 'light' })
    expect(sharedDesired(crossing, at(0, 0))).toEqual({ ok: true, theme: 'light' })
    expect(sharedDesired(crossing, at(5, 59))).toEqual({ ok: true, theme: 'light' })
    expect(sharedDesired(crossing, at(6, 0))).toEqual({ ok: true, theme: 'dark' })
    expect(sharedDesired(crossing, at(12, 0))).toEqual({ ok: true, theme: 'dark' })
    expect(sharedDesired(crossing, at(21, 59))).toEqual({ ok: true, theme: 'dark' })
  })

  it('refuses to schedule equal times rather than picking a winner', () => {
    // This is the anti-thrash rule: choosing either theme would flip the desktop
    // every tick, and the scheduler must do nothing instead.
    expect(sharedDesired({ dayStart: '19:00', nightStart: '19:00' }, at(12, 0)))
      .toEqual({ ok: false, reason: 'equal-times' })
    expect(sharedNextChange({ dayStart: '19:00', nightStart: '19:00' }, at(12, 0)))
      .toEqual({ ok: false, reason: 'equal-times' })
    expect(sharedSegments({ dayStart: '19:00', nightStart: '19:00' })).toEqual([])
    expect(sharedDescribeIssue('equal-times')).toMatch(/must differ/)
  })

  it('reports an invalid pair instead of coercing it', () => {
    expect(sharedDesired({ dayStart: '25:00', nightStart: '19:00' }, at(12, 0)))
      .toEqual({ ok: false, reason: 'invalid-time' })
    expect(sharedSegments({ dayStart: '07:00', nightStart: 'nope' })).toEqual([])
    expect(sharedDescribeIssue('invalid-time')).toMatch(/HH:MM/)
  })

  it('names the next boundary and how far away it is', () => {
    const day = { dayStart: '07:00', nightStart: '19:00' }
    expect(sharedNextChange(day, at(12, 0))).toEqual({ ok: true, at: 1140, theme: 'dark', minutesUntil: 420 })
    expect(sharedNextChange(day, at(20, 0))).toEqual({ ok: true, at: 420, theme: 'light', minutesUntil: 660 })
    expect(sharedNextChange(day, at(7, 0))).toEqual({ ok: true, at: 420, theme: 'light', minutesUntil: 0 })
    expect(sharedNextChange(day, at(6, 30))).toEqual({ ok: true, at: 420, theme: 'light', minutesUntil: 30 })
  })

  it('covers the entire day with contiguous segments whose theme matches desiredTheme', () => {
    // Only the schedulable pairs; equal and unparseable pairs must return [].
    for (const schedule of SCHEDULABLE) {
      const segments = sharedSegments(schedule)
      expect(segments.length).toBeGreaterThan(0)
      expect(segments[0]?.start).toBe(0)
      expect(segments[segments.length - 1]?.end).toBe(1440)
      for (let index = 1; index < segments.length; index += 1) {
        expect(segments[index]?.start, `${schedule.dayStart}-${schedule.nightStart} gap at ${index}`).toBe(segments[index - 1]?.end)
      }
      // The strongest check: whatever the ring draws must be what the scheduler
      // would apply, minute for minute.
      for (let minute = 0; minute < 1440; minute += 1) {
        const segment = segments.find((item) => minute >= item.start && minute < item.end)
        const desired = sharedDesired(schedule, new Date(2026, 0, 15, Math.floor(minute / 60), minute % 60, 0))
        expect(desired.ok ? desired.theme : null, `${schedule.dayStart}/${schedule.nightStart} at minute ${minute}`)
          .toBe(segment?.theme ?? null)
      }
    }
  })

  it('defaults every effectful switch to off and keeps times normalized', () => {
    const resolved = sharedResolve({ dayStart: '7:00', nightStart: '19:00' })
    expect(resolved.schedulerEnabled).toBe(false)
    expect(resolved.backend).toBe('auto')
    expect(resolved.dayStart).toBe('07:00')
    // Both targets default to on; the shared validator rejects the pair that would
    // be a silent no-op.
    expect(resolved.applyApps).toBe(true)
    expect(resolved.applySystem).toBe(true)
    expect(sharedResolve({ schedulerEnabled: 'yes' as unknown as boolean }).schedulerEnabled).toBe(false)
  })

  it('preserves a corrupt stored time so the schedule refuses rather than applying a default', () => {
    // Coercing this to 07:00 would silently move the user's schedule to a time
    // they never chose. Doing nothing and saying why is the safe answer.
    expect(sharedResolve({ dayStart: '25:00' }).dayStart).toBe('25:00')
    expect(sharedResolve({ dayStart: '25:00' }).nightStart).toBe('19:00')
    expect(sharedDesired({ dayStart: '25:00', nightStart: '19:00' }, at(12, 0)))
      .toEqual({ ok: false, reason: 'invalid-time' })
    // Absent or wrong-typed is genuinely "not configured", so the default applies.
    expect(sharedResolve({ dayStart: '' }).dayStart).toBe('07:00')
    expect(sharedResolve({ dayStart: '   ' }).dayStart).toBe('07:00')
    expect(sharedResolve({ dayStart: 7 }).dayStart).toBe('07:00')
    expect(sharedResolve({ dayStart: undefined }).dayStart).toBe('07:00')
  })

  it('validates the backend enum and rejects unknown keys', () => {
    expect(sharedValidate('backend', 'powertoys')).toBe('powertoys')
    expect(() => sharedValidate('backend', 'magic')).toThrow(/auto, native, powertoys/)
    expect(() => sharedValidate('noSuchKey', 1)).toThrow(/no setting named/)
    expect(sharedValidate('dayStart', '7:05')).toBe('07:05')
  })
})
