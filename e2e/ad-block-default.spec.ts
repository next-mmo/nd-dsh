/// <reference lib="dom" />

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { BrowserExtensionRecord, BrowserPlatformState } from '../src/shared/browser-platform.js'
import { closeApp, launchApp, type LaunchedApp } from './fixtures.js'

type RendererWindow = {
  ndDsh: {
    browserPlatform: {
      state(): Promise<BrowserPlatformState>
      setExtensionEnabled(extensionId: string, enabled: boolean): Promise<BrowserExtensionRecord[]>
      showExtensionPopup(extensionId: string): Promise<BrowserPlatformState>
    }
  }
}

interface PopupSnapshot {
  state: string
  rulesets: string
  enabledRulesets: string[]
}

const AD_BLOCK_CATALOG_ID = 'nd-ad-block'

test.describe.configure({ mode: 'serial' })

// One profile across both cases: the second case is only meaningful on a
// profile the first case already turned the ad block on in.
let profileDir = ''

test.beforeAll(async () => {
  profileDir = await mkdtemp(join(tmpdir(), 'nd-dsh-adblock-e2e-'))
})

test.afterAll(async () => {
  await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
})

const findAdBlock = (state: BrowserPlatformState): BrowserExtensionRecord | undefined =>
  state.extensions.find((extension) => extension.catalogId === AD_BLOCK_CATALOG_ID)

test('a first launch turns the bundled ad block on', async () => {
  const launched: LaunchedApp = await launchApp({ userDataDir: profileDir })
  const { app, page } = launched
  try {
    await expect.poll(async () => {
      const state = await page.evaluate(() =>
        (window as unknown as RendererWindow).ndDsh.browserPlatform.state())
      return findAdBlock(state)?.enabled ?? false
    }, { timeout: 30_000 }).toBe(true)

    const record = findAdBlock(await page.evaluate(() =>
      (window as unknown as RendererWindow).ndDsh.browserPlatform.state()))
    expect(record?.source).toBe('bundled')
    expect(record?.error).toBeUndefined()
    expect(record?.id).toMatch(/^[a-p]{32}$/)
    // The package must be loaded from a writable per-profile copy: Chromium
    // writes its rule-set index inside the extension directory, and a packaged
    // ND install keeps the bundled resources read-only.
    expect(record?.path.startsWith(launched.userDataDir), `loaded from ${record?.path}`).toBe(true)

    // The rule sets are the blocking mechanism, and Electron leaves them
    // disabled unless the extension activates them itself.
    await page.getByRole('navigation', { name: 'ND-DSH navigation' }).getByTitle('Agent').click()
    await page.getByRole('tablist', { name: 'Agent workspace panes' }).getByRole('button', { name: 'Browser' }).click()
    await expect(page.getByRole('region', { name: 'Built-in browser' })).toBeVisible()

    await page.evaluate((id) =>
      (window as unknown as RendererWindow).ndDsh.browserPlatform.showExtensionPopup(id), record!.id)

    const readPopup = () => app.evaluate(async ({ webContents }, id): Promise<PopupSnapshot | null> => {
      const popup = webContents.getAllWebContents().find((contents) =>
        contents.getURL().startsWith(`chrome-extension://${id}/`))
      if (!popup) return null
      return popup.executeJavaScript(`(async () => ({
        state: document.getElementById('state')?.textContent ?? '',
        rulesets: document.getElementById('rulesets')?.textContent ?? '',
        enabledRulesets: await chrome.declarativeNetRequest.getEnabledRulesets(),
      }))()`) as Promise<PopupSnapshot>
    }, record!.id)

    await expect.poll(async () => (await readPopup())?.state ?? '', { timeout: 20_000 }).toBe('On')
    const popup = await readPopup()
    expect(popup?.enabledRulesets.sort()).toEqual(['nd_ads', 'nd_youtube'])
  } finally {
    await closeApp(launched, { removeUserData: false })
  }
})

test('an ad block the user switched off stays off after a restart', async () => {
  const first = await launchApp({ userDataDir: profileDir })
  let extensionPath = ''
  try {
    const record = findAdBlock(await first.page.evaluate(() =>
      (window as unknown as RendererWindow).ndDsh.browserPlatform.state()))
    expect(record?.enabled, 'ad block was not enabled before the disable step').toBe(true)
    extensionPath = record!.path

    const afterDisable = await first.page.evaluate((id) =>
      (window as unknown as RendererWindow).ndDsh.browserPlatform.setExtensionEnabled(id, false), record!.id)
    expect(afterDisable.find((extension) => extension.path === extensionPath)?.enabled).toBe(false)
  } finally {
    await closeApp(first, { removeUserData: false })
  }

  const second = await launchApp({ userDataDir: profileDir })
  try {
    // Identity is the package path here: an extension that is not loaded has no
    // runtime id yet, so it is reported under a path-derived one.
    await expect.poll(async () => {
      const state = await second.page.evaluate(() =>
        (window as unknown as RendererWindow).ndDsh.browserPlatform.state())
      const record = findAdBlock(state)
      return record ? { enabled: record.enabled, path: record.path } : null
    }, { timeout: 30_000 }).toEqual({ enabled: false, path: extensionPath })
  } finally {
    await closeApp(second, { removeUserData: false })
  }
})
