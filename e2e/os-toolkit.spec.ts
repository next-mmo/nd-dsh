/// <reference lib="dom" />

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Frame, type Page } from '@playwright/test'
import type { NdExtensionsStateView, NdInvocationRequest } from '../src/shared/nd-invocations.js'
import type { NdContext } from '../src/shared/nd-context.js'
import { closeApp, launchApp, type LaunchedApp } from './fixtures.js'

type NdPlatformWindow = typeof globalThis & {
  ndDsh: {
    ndExtensions: {
      state(): Promise<NdExtensionsStateView>
      installAvailable(extensionId: string): Promise<NdExtensionsStateView>
      setActivation(extensionId: string, context: NdContext, enabled: boolean): Promise<NdExtensionsStateView>
      invoke(request: NdInvocationRequest): Promise<{ ok: boolean; value?: unknown }>
    }
  }
}

const EXTENSION_ID = 'nd.os-toolkit'
const VIEW_TITLE = 'OS Toolkit'
const PERSONAL: NdContext = { kind: 'personal' }
const isWindows = process.platform === 'win32'

test.describe.configure({ mode: 'serial' })

let launched: LaunchedApp
const rendererErrors: string[] = []
/** Captured before the theme test so the desktop is handed back as it was found. */
let originalTheme: { apps: string; system: string } | null = null

async function openLauncher(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
}

/** Run the launcher command and return the package's sandboxed studio frame. */
async function openStudio(page: Page): Promise<Frame> {
  // Close any previous instance so exactly one live frame exists.
  const previous = page.getByRole('dialog', { name: VIEW_TITLE }).getByRole('button', { name: 'Close' })
  if (await previous.isVisible().catch(() => false)) {
    await previous.click()
    await page.getByRole('dialog', { name: VIEW_TITLE }).waitFor({ state: 'hidden', timeout: 10_000 })
  }

  await openLauncher(page)
  const launcher = page.getByRole('dialog', { name: 'ND Quick Launcher' })
  await launcher.getByPlaceholder('Search ND or type something to capture…').fill('OS Toolkit')
  await launcher.getByText('OS Toolkit', { exact: true }).first().click()
  await page.getByRole('dialog', { name: VIEW_TITLE }).waitFor({ state: 'visible', timeout: 10_000 })

  // Anchor on the live iframe: a previous instance can still be attached while its
  // dialog tears down (or parked by keep-alive), and a stale frame swallows input.
  await expect.poll(async () => {
    for (const handle of await page.locator('iframe[title="OS Toolkit"]').elementHandles()) {
      if (!(await handle.isVisible())) continue
      const content = await handle.contentFrame()
      if (content?.url().startsWith('nd-extension-ui://')) return content.url()
    }
    return ''
  }, { timeout: 20_000 }).toContain('nd-extension-ui://')

  const frames = page.frames().filter((frame) => frame.url().startsWith('nd-extension-ui://'))
  const studio = frames.find((frame) => frame.url().includes('index.html')) ?? frames.at(-1)
  if (!studio) throw new Error('No nd-extension-ui frame is attached')
  return studio
}

/**
 * Read what Windows actually stored. This is the point of the feature, so the
 * check is deliberately independent of ND: `reg.exe` sees the registry, not our
 * own report of it.
 */
function readThemeRegistry(): { apps: string; system: string } {
  const output = execFileSync('reg', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
  ], { encoding: 'utf8' })
  const value = (name: string): string => {
    const match = new RegExp(`${name}\\s+REG_DWORD\\s+0x([0-9a-fA-F]+)`).exec(output)
    return match?.[1]?.toLowerCase() ?? 'missing'
  }
  return { apps: value('AppsUseLightTheme'), system: value('SystemUsesLightTheme') }
}

function writeThemeRegistry(apps: string, system: string): void {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
  execFileSync('reg', ['add', key, '/v', 'AppsUseLightTheme', '/t', 'REG_DWORD', '/d', `0x${apps}`, '/f'])
  execFileSync('reg', ['add', key, '/v', 'SystemUsesLightTheme', '/t', 'REG_DWORD', '/d', `0x${system}`, '/f'])
}

function invocationState(userDataDir: string): { activations: Array<{ extensionId: string; settings: Record<string, unknown> }> } {
  return JSON.parse(readFileSync(join(userDataDir, 'nd-invocation-state.json'), 'utf8'))
}

function osToolkitSettings(userDataDir: string): Record<string, unknown> {
  const record = invocationState(userDataDir).activations.find((item) => item.extensionId === EXTENSION_ID)
  return record?.settings ?? {}
}

test.beforeAll(async () => {
  launched = await launchApp()
  launched.page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`))
  launched.page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`)
  })
})

test.afterAll(async () => {
  // Never leave the developer's desktop in a theme the test chose.
  if (isWindows && originalTheme) {
    writeThemeRegistry(originalTheme.apps, originalTheme.system)
  }
  await closeApp(launched)
})

test('appears in Discover and installs on demand for Personal', async () => {
  // Dev builds surface the external package in the Discover catalog; packaged
  // builds omit it entirely, because it is never staged into a release.
  const state = await launched.page.evaluate(async (id) =>
    await (globalThis as NdPlatformWindow).ndDsh.ndExtensions.installAvailable(id), EXTENSION_ID)
  expect(state.packages.some((item) => item.id === EXTENSION_ID)).toBe(true)
  const available = state.available ?? []
  expect(available.find((item) => item.id === EXTENSION_ID)?.name).toBe('OS Toolkit')

  const activated = await launched.page.evaluate(async (args) =>
    await (globalThis as NdPlatformWindow).ndDsh.ndExtensions.setActivation(args.id, args.context, true),
  { id: EXTENSION_ID, context: PERSONAL })
  expect(activated.packages.find((item) => item.id === EXTENSION_ID)).toBeDefined()
})

test('installs with the schedule off, so nothing can change the desktop unprompted', async () => {
  const settings = osToolkitSettings(launched.userDataDir)
  // Installing must not arm a timer that moves the desktop.
  expect(settings.schedulerEnabled ?? false).toBe(false)
})

test('the launcher command opens the studio in a sandboxed frame', async () => {
  const frame = await openStudio(launched.page)
  expect(frame.url().startsWith('nd-extension-ui://')).toBe(true)

  await frame.locator('#countdown').waitFor({ state: 'visible', timeout: 10_000 })
  // The chrome answers before the bridge does; wait for the round trip to land by
  // watching a host-only field leave its placeholder.
  await expect.poll(async () => (await frame.locator('#backend-reason').textContent())?.trim() ?? '', {
    timeout: 20_000,
  }).not.toBe('Not probed yet.')

  // Everything is enabled only after real settings arrive, so an early click
  // cannot build a draft out of defaults.
  await expect(frame.locator('#save')).toBeEnabled({ timeout: 15_000 })
  await expect(frame.locator('#act-light')).toBeEnabled()
  await expect(frame.locator('#set-schedulerEnabled')).toBeEnabled()
})

test('the 24-hour ring draws the schedule and the legend matches it', async () => {
  const frame = await openStudio(launched.page)
  await expect(frame.locator('#save')).toBeEnabled({ timeout: 20_000 })

  const painted = await frame.evaluate(async () => {
    const canvas = document.getElementById('ring') as HTMLCanvasElement | null
    if (!canvas) return { painted: false, reason: 'no canvas' }
    const ctx = canvas.getContext('2d')
    if (!ctx) return { painted: false, reason: 'no 2d context' }
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let inked = 0
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 0) inked += 1
    }
    return { painted: inked > 200, inked }
  })
  expect(painted.painted, JSON.stringify(painted)).toBe(true)

  // Legend text comes from the same resolved settings the ring used, so they can
  // not disagree.
  const day = await frame.locator('#legend-day').textContent()
  const night = await frame.locator('#legend-night').textContent()
  expect(day).toMatch(/^\d{2}:\d{2}$/)
  expect(night).toMatch(/^\d{2}:\d{2}$/)
  expect(day).not.toBe(night)
})

test('editing times and saving persists them to the invocation state store', async () => {
  const frame = await openStudio(launched.page)
  await expect(frame.locator('#save')).toBeEnabled({ timeout: 20_000 })
  // Both pickers must hold a real value before the edit begins, or a draft built
  // from an empty input would be a validation error rather than a save.
  await expect(frame.locator('#set-dayStart')).not.toHaveValue('')
  await expect(frame.locator('#set-nightStart')).not.toHaveValue('')

  await frame.locator('#set-dayStart').fill('08:30')
  await frame.locator('#set-nightStart').fill('21:15')
  await frame.locator('#save').click()
  // Assert the success wording specifically: any non-empty status would also
  // satisfy a "not empty" check and hide a rejected save.
  await expect(frame.locator('#status')).toContainText(/Saved/, { timeout: 15_000 })

  await expect.poll(() => osToolkitSettings(launched.userDataDir), { timeout: 15_000 }).toMatchObject({
    dayStart: '08:30',
    nightStart: '21:15',
  })

  // Reopening shows the stored values, not defaults: the store is the source.
  const reopened = await openStudio(launched.page)
  await expect(reopened.locator('#save')).toBeEnabled({ timeout: 20_000 })
  await expect(reopened.locator('#set-dayStart')).toHaveValue('08:30')
  await expect(reopened.locator('#set-nightStart')).toHaveValue('21:15')
})

test('a rejected save writes nothing, leaving the stored schedule untouched', async () => {
  // Regression: the handler used to persist key by key, so a payload with one bad
  // field committed the earlier fields and abandoned the rest — a half-applied
  // schedule, including `schedulerEnabled` flipped on against stale times.
  const before = { ...osToolkitSettings(launched.userDataDir) }
  expect(before.dayStart).toBe('08:30')

  const rejected = await launched.page.evaluate(async (args) => await (globalThis as NdPlatformWindow).ndDsh.ndExtensions.invoke({
    extensionId: args.id,
    contributionId: 'studio:schedule-save',
    contributionKind: 'view',
    context: { kind: 'personal' },
    caller: 'user',
    input: { action: 'schedule-save', settings: args.settings },
  }), {
    id: EXTENSION_ID,
    // Two valid fields then one impossible time: nothing may be persisted.
    settings: { schedulerEnabled: true, dayStart: '25:00' },
  })
  expect(rejected.ok).toBe(false)
  expect(JSON.stringify(rejected)).toMatch(/24-hour time/)

  const after = osToolkitSettings(launched.userDataDir)
  expect(after).toEqual(before)
  expect(after.schedulerEnabled).not.toBe(true)
})

test('equal times are refused on the spot and the timeline explains itself', async () => {
  const frame = await openStudio(launched.page)
  await expect(frame.locator('#save')).toBeEnabled({ timeout: 20_000 })

  await frame.locator('#set-dayStart').fill('10:00')
  await frame.locator('#set-nightStart').fill('10:00')
  await frame.locator('#save').click()

  await expect(frame.locator('#status')).toContainText(/must differ/, { timeout: 15_000 })
  // Nothing was written, so the stored pair is still the previously valid one.
  expect(osToolkitSettings(launched.userDataDir)).toMatchObject({ dayStart: '08:30', nightStart: '21:15' })

  // And a schedulable pair restores a live countdown.
  await frame.locator('#set-nightStart').fill('22:00')
  await frame.locator('#save').click()
  await expect(frame.locator('#countdown')).toContainText(/mode in/, { timeout: 15_000 })
})

test('the PowerToys backend is only offered when Light Switch can actually serve it', async () => {
  const frame = await openStudio(launched.page)
  await expect(frame.locator('#save')).toBeEnabled({ timeout: 20_000 })

  const state = await frame.evaluate(async () => {
    const reason = document.getElementById('backend-reason')?.textContent ?? ''
    const lightSwitch = document.getElementById('lightswitch-state')?.textContent ?? ''
    const button = document.getElementById('backend-powertoys') as HTMLButtonElement | null
    return { reason, lightSwitch, disabled: button?.disabled ?? true, title: button?.title ?? '' }
  })
  expect(state.reason.length).toBeGreaterThan(0)
  // Off Windows there is no Light Switch, and on Windows it is only offered when
  // the probe says the service answered. Either way the button is never a
  // clickable control that fails on click.
  if (state.disabled) {
    expect(state.title.length + state.lightSwitch.length).toBeGreaterThan(0)
  }
})

test('the native backend really changes the Windows theme, and the fix is offered when it cannot', async () => {
  test.skip(!isWindows, 'the Windows theme registry only exists on Windows')

  const coreReady = await launched.page.evaluate(async (id) =>
    await (globalThis as NdPlatformWindow).ndDsh.ndExtensions.invoke({
      extensionId: id,
      contributionId: 'studio:probe',
      contributionKind: 'view',
      context: { kind: 'personal' },
      caller: 'user',
      input: { action: 'probe' },
    }), EXTENSION_ID)
  expect(coreReady.ok, JSON.stringify(coreReady)).toBe(true)
  const probed = coreReady.value as { nativeAvailable?: boolean; reason?: string; lightSwitch?: { message?: string } }
  if (probed.nativeAvailable !== true) {
    // This is the honest outcome, not a failure: the running sidecar predates
    // os.theme-*, which `binaryVersion` cannot reveal. The message names the fix.
    throw new Error(`nd-core cannot change the theme in this run: ${JSON.stringify(probed)}`)
  }

  originalTheme = readThemeRegistry()
  expect(originalTheme.apps).not.toBe('missing')

  const frame = await openStudio(launched.page)
  await expect(frame.locator('#act-dark')).toBeEnabled({ timeout: 20_000 })

  // Force the native path so this asserts our own registry write, not PowerToys'.
  await frame.locator('#backend-native').click()
  await frame.locator('#save').click()
  await expect(frame.locator('#badge-backend b')).toHaveText('Native', { timeout: 15_000 })

  await frame.locator('#act-dark').click()
  await expect(frame.locator('#status')).toContainText(/dark/i, { timeout: 15_000 })
  await expect.poll(() => readThemeRegistry().system, { timeout: 15_000 }).toBe('0')

  await frame.locator('#act-light').click()
  await expect.poll(() => readThemeRegistry().system, { timeout: 15_000 }).toBe('1')

  // The badge is re-read from Windows rather than echoing what we asked for.
  await expect.poll(async () => (await frame.locator('#badge-theme b').textContent())?.trim(), {
    timeout: 15_000,
  }).toBe('light')
})

test('the studio stays quiet and reports renderer errors at the end', async () => {
  const frame = await openStudio(launched.page)
  await expect(frame.locator('#save')).toBeEnabled({ timeout: 20_000 })
  expect(rendererErrors, `renderer errors: ${rendererErrors.join(' | ')}`).toEqual([])
})
