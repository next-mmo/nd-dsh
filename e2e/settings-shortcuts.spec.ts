/// <reference lib="dom" />

// Settings → General → Shortcuts: proves the key recorder refuses combinations
// the operating system owns, accepts a free one, persists it, and resets it.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './fixtures.js'

test.describe.configure({ mode: 'serial' })

let launched: LaunchedApp
const SHOT_DIR = 'test-results/settings-shortcuts'

/** A key the operating system claims on this host, and the owner ND must name. */
const OS_RESERVED = process.platform === 'darwin'
  ? { press: 'Meta+Space', owner: 'Spotlight' }
  : { press: 'Meta+l', owner: process.platform === 'win32' ? 'Windows reserves Win+key' : 'desktop shell reserves Super' }

/**
 * A combination nothing claims: three modifiers clear ND's two-modifier floor,
 * and Ctrl+Alt+Shift+P is not an OS, shell, or ND accelerator on any platform.
 * Playwright's `press` only knows F1-F12, so a spare function key is not an option.
 */
const FREE_KEY = {
  press: 'Control+Alt+Shift+P',
  accelerator: process.platform === 'darwin' ? 'Control+Alt+Shift+P' : 'CommandOrControl+Alt+Shift+P',
}
const DEFAULT_BINDING = 'CommandOrControl+Shift+Space'

async function persistedBinding(): Promise<string | undefined> {
  const raw = await readFile(join(launched.userDataDir, 'settings.json'), 'utf8').catch(() => undefined)
  if (raw === undefined) return undefined
  return (JSON.parse(raw) as { shortcuts?: { quickLauncher?: string } }).shortcuts?.quickLauncher
}

test.beforeAll(async () => {
  launched = await launchApp()
})

test.afterAll(async () => {
  await closeApp(launched)
})

test('rebinds the quick launcher key without stealing a system hotkey', async () => {
  const { page } = launched

  await page.getByRole('navigation', { name: 'ND-DSH navigation' }).getByTitle('Settings').click()
  await page.getByRole('tablist', { name: 'General sub-tabs' }).getByRole('tab', { name: 'Shortcuts', exact: true }).click()

  const region = page.getByRole('region', { name: 'Settings' })
  await expect(region.getByRole('heading', { name: 'Global shortcuts' })).toBeVisible()
  // Scoped to one row: with four bindable actions, "Active"/"Unavailable" chips
  // appear once per row and would otherwise trip Playwright strict mode.
  const launcherRow = region.getByRole('group', { name: 'Quick launcher', exact: true })
  const readout = launcherRow.getByRole('status', { name: 'Quick launcher key' })
  const shipped = ((await readout.textContent()) ?? '').trim()
  expect(shipped).not.toBe('')

  // The behavior radio moved onto this tab from General → Runtime.
  await expect(region.getByRole('heading', { name: 'Quick launcher' })).toBeVisible()

  // The snipping-tool family is bindable alongside the launcher key.
  for (const label of ['Capture area', 'Capture full screen', 'Capture full screen after a delay']) {
    await expect(region.getByText(label, { exact: true })).toBeVisible()
  }

  // The countdown length is a persisted preference.
  const delayGroup = region.getByRole('radiogroup', { name: 'Capture delay' })
  await expect(delayGroup).toBeVisible()
  await delayGroup.getByRole('button', { name: '5s' }).click()
  const withDelay = JSON.parse(await readFile(join(launched.userDataDir, 'settings.json'), 'utf8')) as { captureDelaySeconds?: number }
  expect(withDelay.captureDelaySeconds).toBe(5)
  await page.screenshot({ path: `${SHOT_DIR}/shortcuts-delay.png` })

  const record = launcherRow.getByRole('button', { name: /a new key for Quick launcher/ })
  const reset = launcherRow.getByRole('button', { name: /Reset the Quick launcher key/ })
  const alert = launcherRow.getByRole('alert')
  const active = launcherRow.getByText('Active', { exact: true })

  // Another ND instance may already hold the shipped key, so the starting point
  // is either registered or reported as unavailable — never silently blank.
  if (!(await active.isVisible())) {
    await expect(launcherRow.getByText('Unavailable', { exact: true })).toBeVisible()
    expect(await persistedBinding() ?? DEFAULT_BINDING).toBe(DEFAULT_BINDING)
  }
  await expect(alert).toHaveCount(0)
  await expect(reset).toBeDisabled()
  await page.screenshot({ path: `${SHOT_DIR}/shortcuts-default.png` })

  await record.click()
  await expect(readout).toHaveText('Press keys…')
  await expect(record).toHaveText('Cancel')

  // A key the OS owns: refused in the renderer, before ND asks Electron for it.
  await page.keyboard.press(OS_RESERVED.press)
  await expect(alert).toContainText(OS_RESERVED.owner)
  await page.screenshot({ path: `${SHOT_DIR}/shortcuts-os-reserved.png` })

  // One modifier is not enough: ND would swallow ordinary typing everywhere.
  await page.keyboard.press('Control+c')
  await expect(alert).toContainText('at least two modifiers')

  // Ctrl+Alt+A is Capture area's own default, so it is refused as a duplicate.
  await page.keyboard.press('Control+Alt+a')
  await expect(alert).toContainText('ND already uses this key for Capture area')
  await page.screenshot({ path: `${SHOT_DIR}/shortcuts-duplicate.png` })

  // Escape cancels recording, and ND stops swallowing keystrokes.
  await page.keyboard.press('Escape')
  await expect(record).toHaveText('Record')
  await expect(readout).toHaveText(shipped)
  await expect(alert).toHaveCount(0)
  expect(await persistedBinding() ?? DEFAULT_BINDING).toBe(DEFAULT_BINDING)

  // A free key is accepted, registered, and persisted.
  await record.click()
  await page.keyboard.press(FREE_KEY.press)
  await expect(readout).not.toHaveText(shipped)
  await expect(alert).toHaveCount(0)
  await expect(reset).toBeEnabled()
  await expect(active).toBeVisible()
  expect(await persistedBinding()).toBe(FREE_KEY.accelerator)
  await page.screenshot({ path: `${SHOT_DIR}/shortcuts-rebound.png` })

  // Reset returns to the shipped key when it is free. If another process took it
  // while ND was running, ND keeps the working binding and says why instead.
  await reset.click()
  const after = await persistedBinding()
  expect([DEFAULT_BINDING, FREE_KEY.accelerator]).toContain(after)
  if (after === DEFAULT_BINDING) await expect(readout).toHaveText(shipped)
  else await expect(readout).toHaveText(/P$/)
  await expect(active).toBeVisible()
  await page.screenshot({ path: `${SHOT_DIR}/shortcuts-reset.png` })

  // The OS hotkey path itself: main forwards the request and the renderer must
  // react. Playwright cannot press a real RegisterHotKey combination, so this
  // sends exactly the event the registry's handler sends.
  await launched.app.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
    target?.webContents.send('window:capture-request', 'fullCapture')
  })
  // A capture must land in the composer as an UNSENT attachment, never as a
  // message already on its way to the agent.
  // A capture must land in the composer as an UNSENT attachment, and ND brings
  // itself back from float mode so the user sees it waiting.
  await expect(launched.page.getByAltText('Pasted image 1')).toBeVisible()
  await expect(launched.page.getByText(/attached to the chat composer/)).toBeVisible()
  await page.screenshot({ path: `${SHOT_DIR}/shortcuts-attached.png` })
})
