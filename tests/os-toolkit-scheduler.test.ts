import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { OsToolkitScheduler } from '../src/main/extensions/os-toolkit-scheduler.js'
import type { ApplyOsThemeOptions, BackendResolution } from '../src/main/os/theme.js'
import type { OsThemeMode, OsToolkitSettings, ThemeApplyTarget } from '../src/shared/os-toolkit-schedule.js'
import { validateNdExtensionManifest, type NdExtensionManifest } from '../src/shared/extension-package.js'
import { OS_TOOLKIT_EXTENSION_ID } from '../src/shared/os-toolkit-schedule.js'
import { personalContext } from '../src/shared/nd-context.js'

const manifestPath = new URL('../extensions/nd-os-toolkit/nd-extension.json', import.meta.url)

async function loadManifest(): Promise<NdExtensionManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const result = validateNdExtensionManifest(parsed)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  return result.manifest
}

function resolution(backend: 'native' | 'powertoys'): BackendResolution {
  return {
    backend,
    reason: `${backend} chosen for the test`,
    nativeAvailable: true,
    lightSwitch: {
      installed: backend === 'powertoys',
      enabled: backend === 'powertoys',
      path: null,
      message: 'test probe',
    },
  }
}

/** A fake clock the test can advance across a schedule boundary. */
let clock = new Date(2026, 0, 15, 12, 0, 0)
const at = (hour: number, minute: number): void => {
  clock = new Date(2026, 0, 15, hour, minute, 0)
}

describe('OsToolkitScheduler', () => {
  let root: string
  let packages: ExtensionPackageStore
  let state: InvocationStateStore
  let applied: Array<{ target: ThemeApplyTarget; options: ApplyOsThemeOptions }>
  let disabledCalls: number
  let screenTheme: OsThemeMode | null
  let resolveBackend: 'native' | 'powertoys'

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nd-os-toolkit-scheduler-'))
    packages = new ExtensionPackageStore(join(root, 'packages'))
    state = new InvocationStateStore(join(root, 'state'))
    applied = []
    disabledCalls = 0
    screenTheme = 'light'
    resolveBackend = 'native'
    at(12, 0)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function installAndActivate(enabled = true): Promise<void> {
    await packages.registerBuiltin(await loadManifest())
    await state.setActivation(OS_TOOLKIT_EXTENSION_ID, personalContext(), enabled)
  }

  async function configure(overrides: Partial<OsToolkitSettings>): Promise<void> {
    for (const [key, value] of Object.entries(overrides)) {
      await state.setSetting(OS_TOOLKIT_EXTENSION_ID, personalContext(), key, value)
    }
  }

  function build(): OsToolkitScheduler {
    return new OsToolkitScheduler({
      state,
      packages,
      platform: 'win32',
      now: () => clock,
      resolve: async (choice) => ({ ...resolution(resolveBackend), reason: `${choice} -> ${resolveBackend}` }),
      disableLightSwitch: async () => {
        disabledCalls += 1
        return { ok: true, message: 'Light Switch schedule disabled' }
      },
      readScreen: async () => screenTheme,
      apply: async (target, options) => {
        applied.push({ target, options })
        return { ok: true, backend: options.backend, message: `applied ${target}` }
      },
    })
  }

  it('does not start when the package is not installed', async () => {
    // Installed means present; nothing here may activate a timer for a package
    // the user never installed.
    await state.setActivation(OS_TOOLKIT_EXTENSION_ID, personalContext(), true)
    const scheduler = build()
    await scheduler.sync()
    expect(scheduler.isRunning).toBe(false)
    expect(applied).toEqual([])
  })

  it('does not start when installed but not activated', async () => {
    await installAndActivate(false)
    await configure({ schedulerEnabled: true, dayStart: '07:00', nightStart: '19:00' })
    const scheduler = build()
    await scheduler.sync()
    expect(scheduler.isRunning).toBe(false)
    expect(applied).toEqual([])
  })

  it('does not start on a platform whose theme it cannot control', async () => {
    await installAndActivate()
    await configure({ schedulerEnabled: true, dayStart: '07:00', nightStart: '19:00' })
    const darwin = new OsToolkitScheduler({
      state,
      packages,
      platform: 'darwin',
      now: () => clock,
      apply: async () => ({ ok: true, backend: 'native', message: 'no' }),
    })
    await darwin.sync()
    expect(darwin.isRunning).toBe(false)
  })

  it('starts and applies the right theme once the schedule is switched on', async () => {
    await installAndActivate()
    await configure({ schedulerEnabled: true, dayStart: '07:00', nightStart: '19:00' })
    at(12, 0)
    const scheduler = build()
    await scheduler.sync()
    expect(scheduler.isRunning).toBe(true)
    expect(applied).toHaveLength(1)
    expect(applied[0]?.target).toBe('light')
  })

  it('stops when the extension is deactivated', async () => {
    await installAndActivate()
    await configure({ schedulerEnabled: true, dayStart: '07:00', nightStart: '19:00' })
    const scheduler = build()
    await scheduler.sync()
    expect(scheduler.isRunning).toBe(true)
    await state.setActivation(OS_TOOLKIT_EXTENSION_ID, personalContext(), false)
    await scheduler.sync()
    expect(scheduler.isRunning).toBe(false)
  })

  it('applies nothing while the schedule switch is off, even at a boundary', async () => {
    // This is the default-off guarantee: installing the package must never move
    // the desktop.
    await installAndActivate()
    await configure({ schedulerEnabled: false, dayStart: '07:00', nightStart: '19:00' })
    at(19, 0)
    const scheduler = build()
    await scheduler.sync()
    expect(scheduler.isRunning).toBe(true)
    const reconciled = await scheduler.reconcile()
    expect(reconciled.ran).toBe(false)
    expect(reconciled.reason).toMatch(/switched off/)
    expect(applied).toEqual([])
  })

  it('does not re-apply the same theme on repeated ticks', async () => {
    // The anti-thrash rule: without this, a per-minute timer would rewrite the
    // registry every minute forever.
    await installAndActivate()
    await configure({ schedulerEnabled: true, dayStart: '07:00', nightStart: '19:00' })
    at(12, 0)
    const scheduler = build()
    await scheduler.sync()
    expect(applied).toHaveLength(1)
    await scheduler.reconcile()
    await scheduler.reconcile()
    await scheduler.reconcile()
    expect(applied).toHaveLength(1)
  })

  it('applies again only when the boundary is crossed', async () => {
    await installAndActivate()
    await configure({ schedulerEnabled: true, dayStart: '07:00', nightStart: '19:00' })
    const scheduler = build()
    at(12, 0)
    await scheduler.sync()
    expect(applied.map((call) => call.target)).toEqual(['light'])

    at(18, 59)
    await scheduler.reconcile()
    expect(applied).toHaveLength(1)

    at(19, 0)
    await scheduler.reconcile()
    expect(applied.map((call) => call.target)).toEqual(['light', 'dark'])

    at(7, 0)
    await scheduler.reconcile()
    expect(applied.map((call) => call.target)).toEqual(['light', 'dark', 'light'])
  })

  it('wraps midnight when the light start is after the dark start', async () => {
    await installAndActivate()
    await configure({ schedulerEnabled: true, dayStart: '22:00', nightStart: '06:00' })
    const scheduler = build()
    at(5, 0)
    await scheduler.sync()
    expect(applied.map((call) => call.target)).toEqual(['light'])
    at(6, 0)
    await scheduler.reconcile()
    expect(applied.map((call) => call.target)).toEqual(['light', 'dark'])
    at(21, 59)
    await scheduler.reconcile()
    expect(applied).toHaveLength(2)
    at(22, 0)
    await scheduler.reconcile()
    expect(applied.map((call) => call.target)).toEqual(['light', 'dark', 'light'])
  })

  it('applies nothing for equal times rather than picking a winner', async () => {
    await installAndActivate()
    await configure({ schedulerEnabled: true, dayStart: '19:00', nightStart: '19:00' })
    const scheduler = build()
    await scheduler.sync()
    const reconciled = await scheduler.reconcile()
    expect(reconciled.ran).toBe(false)
    expect(reconciled.reason).toMatch(/nothing to schedule/)
    expect(reconciled.reason).toMatch(/equal-times/)
    expect(applied).toEqual([])
  })

  it('applies nothing for an unparseable time', async () => {
    await installAndActivate()
    await configure({ schedulerEnabled: true })
    // Written straight to the store, bypassing the host validator, to prove the
    // scheduler itself refuses rather than trusting what it reads.
    await state.setSetting(OS_TOOLKIT_EXTENSION_ID, personalContext(), 'dayStart', '25:00')
    const scheduler = build()
    await scheduler.sync()
    const reconciled = await scheduler.reconcile()
    expect(reconciled.ran).toBe(false)
    expect(reconciled.reason).toMatch(/invalid-time/)
    expect(applied).toEqual([])
  })

  it('leaves the current theme alone at startup when startupReconcile is off', async () => {
    // With reconcile declined, ND must not override the desktop on the first tick
    // either: it seeds its notion of "last applied" from what is on screen.
    await installAndActivate()
    await configure({ schedulerEnabled: true, startupReconcile: false, dayStart: '07:00', nightStart: '19:00' })
    screenTheme = 'light'
    at(12, 0)
    const scheduler = build()
    await scheduler.sync()
    expect(applied).toEqual([])
    await scheduler.reconcile()
    expect(applied).toEqual([])
  })

  it('still honours a real boundary when startupReconcile is off', async () => {
    await installAndActivate()
    await configure({ schedulerEnabled: true, startupReconcile: false, dayStart: '07:00', nightStart: '19:00' })
    screenTheme = 'light'
    at(12, 0)
    const scheduler = build()
    await scheduler.sync()
    at(19, 0)
    await scheduler.reconcile()
    expect(applied.map((call) => call.target)).toEqual(['dark'])
  })

  it('passes the apps and system targets through to the backend', async () => {
    await installAndActivate()
    await configure({ schedulerEnabled: true, dayStart: '07:00', nightStart: '19:00', applyApps: false, applySystem: true })
    at(12, 0)
    const scheduler = build()
    await scheduler.sync()
    expect(applied[0]?.options.apps).toBe(false)
    expect(applied[0]?.options.system).toBe(true)
    expect(applied[0]?.options.backend).toBe('native')
  })

  it('turns off Light Switch\'s own schedule exactly once when delegating to it', async () => {
    // Two schedulers writing one registry key makes the last writer win and
    // neither predictable, so ND disables theirs — once, not every tick.
    await installAndActivate()
    await configure({ schedulerEnabled: true, backend: 'powertoys', lightSwitchSync: true, dayStart: '07:00', nightStart: '19:00' })
    resolveBackend = 'powertoys'
    at(12, 0)
    const scheduler = build()
    await scheduler.sync()
    expect(disabledCalls).toBe(1)
    expect(applied[0]?.options.backend).toBe('powertoys')
    at(19, 0)
    await scheduler.reconcile()
    expect(disabledCalls).toBe(1)
  })

  it('leaves Light Switch\'s schedule running when the user declined to sync them', async () => {
    await installAndActivate()
    await configure({ schedulerEnabled: true, backend: 'powertoys', lightSwitchSync: false, dayStart: '07:00', nightStart: '19:00' })
    resolveBackend = 'powertoys'
    at(12, 0)
    const scheduler = build()
    await scheduler.sync()
    expect(disabledCalls).toBe(0)
  })

  it('never touches Light Switch when using the native backend', async () => {
    await installAndActivate()
    await configure({ schedulerEnabled: true, backend: 'native', lightSwitchSync: true, dayStart: '07:00', nightStart: '19:00' })
    at(12, 0)
    const scheduler = build()
    await scheduler.sync()
    expect(disabledCalls).toBe(0)
  })

  it('re-checks activation mid-tick and stops itself when disabled underneath it', async () => {
    await installAndActivate()
    await configure({ schedulerEnabled: true, dayStart: '07:00', nightStart: '19:00' })
    at(20, 0)
    const scheduler = build()
    // Start with no theme applied so the tick would normally act.
    await scheduler.sync()
    expect(scheduler.isRunning).toBe(true)
    const appliedAtSync = applied.length
    await state.setActivation(OS_TOOLKIT_EXTENSION_ID, personalContext(), false)
    at(7, 0)
    const reconciled = await scheduler.reconcile()
    expect(reconciled.ran).toBe(false)
    expect(reconciled.reason).toMatch(/not active/)
    expect(scheduler.isRunning).toBe(false)
    expect(applied).toHaveLength(appliedAtSync)
  })
})
