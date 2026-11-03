import { describe, expect, it, vi } from 'vitest'
import { createCoreOsTheme, validateOsThemeSetParams } from '../src/main/core/core-os-theme.js'
import {
  describeNativeFailure,
  lightSwitchCandidates,
  lightSwitchMessage,
  parseLightSwitchStatus,
} from '../src/main/os/theme.js'

/**
 * The PowerToys Light Switch boundary and the nd-core theme boundary, tested as
 * pure functions. Nothing here spawns a process or touches a registry: the point
 * is that every documented failure becomes a sentence a person can act on, and
 * that a malformed request is rejected before it can reach either boundary.
 */

describe('PowerToys Light Switch exit codes', () => {
  it('maps every documented exit code to an instruction', () => {
    expect(lightSwitchMessage({ exitCode: 0 }).message).toMatch(/applied the change/)
    expect(lightSwitchMessage({ exitCode: 1 }).message).toMatch(/Apply dark mode to/)
    expect(lightSwitchMessage({ exitCode: 2 }).message).toMatch(/update/)
    expect(lightSwitchMessage({ exitCode: 3 }).message).toMatch(/turned off in PowerToys/)
    expect(lightSwitchMessage({ exitCode: 4 }).message).toMatch(/may still have been applied|was re-read/)
  })

  it('offers the native backend exactly when PowerToys cannot serve the request', () => {
    // The two codes that mean "PowerToys will not do this" both surface a fix the
    // studio can turn into a button.
    expect(lightSwitchMessage({ exitCode: 3 }).actionable).toBe('switch-backend-native')
    expect(lightSwitchMessage({ exitCode: null, code: undefined }).actionable).toBe('switch-backend-native')
    expect(lightSwitchMessage({ exitCode: 1 }).actionable).toBeUndefined()
    expect(lightSwitchMessage({ exitCode: 4 }).actionable).toBeUndefined()
  })

  it('names a missing install as not installed rather than as a failure', () => {
    const missing = lightSwitchMessage({ code: 'ENOENT' })
    expect(missing.message).toMatch(/not installed/)
    expect(missing.message).toMatch(/Native backend/)
    expect(missing.actionable).toBe('install-powertoys')
    expect(lightSwitchMessage({ code: 'EACCES' }).actionable).toBe('install-powertoys')
    expect(lightSwitchMessage({ code: 'ETIMEDOUT' }).message).toMatch(/did not answer in time/)
  })

  it('never leaks a raw code or stderr into the user-facing message', () => {
    const cases = [
      { exitCode: 0 }, { exitCode: 1 }, { exitCode: 2 }, { exitCode: 3 }, { exitCode: 4 },
      { exitCode: 99 }, { code: 'ENOENT' }, { code: 'EPERM' }, { code: 'ETIMEDOUT' },
      { exitCode: 1, code: 'ERR_LIGHTSWITCH_FAIL' }, {},
    ]
    for (const value of cases) {
      const message = lightSwitchMessage(value).message
      expect(message.length, JSON.stringify(value)).toBeGreaterThan(10)
      // No IPC codes, no exit-code echoes, no exception identifiers.
      for (const leak of ['exit', 'code=', 'EPERM', 'ENOENT', 'ERR_', 'method_failed', 'undefined']) {
        expect(message.toLowerCase(), `${JSON.stringify(value)} -> ${message}`).not.toContain(leak.toLowerCase())
      }
    }
  })
})

describe('PowerToys Light Switch status parsing', () => {
  it('reads the documented success payload', () => {
    const stdout = '{"version":1,"success":true,"state":{"systemTheme":"dark","appsTheme":"dark","changeSystem":true,"changeApps":true,"scheduleMode":"FixedHours","manualOverride":true}}'
    expect(parseLightSwitchStatus(stdout)).toEqual({
      systemTheme: 'dark',
      appsTheme: 'dark',
      scheduleMode: 'FixedHours',
      manualOverride: true,
      changeSystem: true,
      changeApps: true,
    })
  })

  it('tolerates surrounding whitespace and a partial state', () => {
    expect(parseLightSwitchStatus('\r\n{"success":true,"state":{"systemTheme":"light"}}\n'))
      .toEqual({ systemTheme: 'light' })
  })

  it('degrades to null rather than guessing', () => {
    for (const stdout of [
      '',
      '   ',
      'not json at all',
      '{"version":1}',
      '{"success":true}',
      '{"success":true,"state":null}',
      '{"success":true,"state":[]}',
      '{"success":false,"error":{"code":"x","message":"y"}}',
      '{"success":true,"state":{"unexpected":"value"}}',
      '[1,2,3]',
      '"a string"',
    ]) {
      expect(parseLightSwitchStatus(stdout), stdout).toBeNull()
    }
  })

  it('ignores untyped fields instead of trusting them', () => {
    // scheduleMode stays a string and manualOverride stays a boolean only when the
    // payload says so; a number is not a boolean.
    expect(parseLightSwitchStatus('{"success":true,"state":{"systemTheme":"dark","manualOverride":1,"scheduleMode":"   "}}'))
      .toEqual({ systemTheme: 'dark' })
  })
})

describe('Light Switch discovery paths', () => {
  it('only ever considers fixed install roots', () => {
    const found = lightSwitchCandidates({ ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })
    expect(found).toContain('C:\\Program Files\\PowerToys\\PowerToys.LightSwitch.CLI.exe')
    expect(found).toContain('C:\\Users\\me\\AppData\\Local\\PowerToys\\PowerToys.LightSwitch.CLI.exe')
    expect(found.every((candidate) => candidate.endsWith('PowerToys.LightSwitch.CLI.exe'))).toBe(true)
  })

  it('skips absent environment roots without inventing a path', () => {
    expect(lightSwitchCandidates({})).toEqual([])
    expect(lightSwitchCandidates({ ProgramFiles: '   ' })).toEqual([])
  })
})

describe('the nd-core theme boundary', () => {
  it('rejects a malformed update before crossing into Rust', () => {
    for (const value of [
      null,
      undefined,
      [],
      {},
      'dark',
      { theme: 'sepia' },
      { theme: 'dark', bogus: 1 },
      { theme: 'dark', apps: 'yes' },
      { theme: 'dark', system: 1 },
      // Targeting neither DWORD would be a silent no-op.
      { theme: 'dark', apps: false, system: false },
    ]) {
      expect(() => validateOsThemeSetParams(value), JSON.stringify(value)).toThrow(/Invalid theme update|must target/)
    }
    expect(validateOsThemeSetParams({ theme: 'dark' })).toEqual({ theme: 'dark' })
    expect(validateOsThemeSetParams({ theme: 'light', apps: true, system: false })).toEqual({ theme: 'light', apps: true, system: false })
  })

  it('rebuilds the payload so an unknown key cannot ride along', () => {
    const params = validateOsThemeSetParams({ theme: 'dark', apps: true })
    expect(Object.keys(params).sort()).toEqual(['apps', 'theme'])
  })

  it('detects a sidecar that predates theme support instead of failing obscurely', async () => {
    const request = vi.fn().mockResolvedValue({ available: true, appsTheme: 'dark', systemTheme: 'dark', platform: 'win32' })
    const stale = createCoreOsTheme({ request, health: { capabilities: ['media', 'vault'] } as never })
    expect(stale.supported()).toBe(false)
    // The read degrades to an honest unavailable state naming the repair command,
    // and never reaches the sidecar at all.
    expect(await stale.state()).toMatchObject({ available: false, reason: expect.stringMatching(/core:build:dev/) })
    // The write is refused locally, before it can produce a confusing error.
    await expect(stale.set({ theme: 'dark' })).rejects.toThrow(/unknown nd-core method/)
    expect(request).not.toHaveBeenCalled()

    const fresh = createCoreOsTheme({ request, health: { capabilities: ['media', 'os-theme'] } as never })
    expect(fresh.supported()).toBe(true)
  })

  it('passes the documented method names and timeouts when the sidecar supports them', async () => {
    const state = { available: true as const, appsTheme: 'light' as const, systemTheme: 'light' as const, platform: 'win32' }
    const request = vi.fn().mockResolvedValue(state)
    const theme = createCoreOsTheme({ request, health: { capabilities: ['os-theme'] } as never })
    expect(await theme.state()).toEqual(state)
    expect(await theme.set({ theme: 'dark', apps: true, system: false })).toEqual(state)
    expect(request.mock.calls).toEqual([
      ['os.theme-get', {}, 3_000],
      ['os.theme-set', { theme: 'dark', apps: true, system: false }, 5_000],
    ])
  })

  it('turns a sidecar error into an instruction, and recognizes the stale binary', () => {
    // This exact string is what a stale target/debug binary returns from
    // crates/nd-core/src/main.rs, and binaryVersion cannot tell you.
    const stale = describeNativeFailure(new Error('unknown nd-core method: os.theme-set'))
    expect(stale.actionable).toBe('rebuild-core')
    expect(stale.message).toMatch(/core:build:dev/)

    expect(describeNativeFailure(new Error('ND Core is not running.'))).toMatchObject({
      message: expect.stringMatching(/not running/),
    })
    expect(describeNativeFailure(new Error('Windows refused to store the theme value AppsUseLightTheme (code 5); it may be locked by an organization policy')))
      .toEqual({ message: 'Your organization manages the Windows theme, so ND cannot change it.' })
    expect(describeNativeFailure(new Error('some HRESULT 0x80070005')))
      .toEqual({ message: 'Windows refused the theme change. Check whether your organization manages the theme.' })
  })

  it('never echoes the raw error text back to the user', () => {
    for (const raw of ['code 5', 'HRESULT 0x80070005', 'RegSetValueExW failed', 'os.theme-set']) {
      const message = describeNativeFailure(new Error(raw)).message
      for (const leak of ['0x', 'Reg', 'os.theme', 'code 5']) {
        expect(message, `${raw} -> ${message}`).not.toContain(leak)
      }
    }
  })
})
