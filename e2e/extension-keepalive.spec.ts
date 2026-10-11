/// <reference lib="dom" />

import { expect, test } from '@playwright/test'
import type { NdContext } from '../src/shared/nd-context.js'
import type { OrganizationDesktopApi } from '../src/shared/organization.js'
import { closeApp, launchApp, type LaunchedApp } from './fixtures.js'

// Keep-alive contract for `kind: 'web'` extension views: opening one puts a
// closable tab on the header's company row, closing the dialog (or navigating
// the app) backgrounds the view WITHOUT reloading its frame — same asset
// token, same game state — and only the tab's × button truly closes it.

test.describe.configure({ mode: 'serial' })

type NdPlatformWindow = typeof globalThis & {
  ndDshOrganization: OrganizationDesktopApi
  ndDsh: {
    ndExtensions: {
      state(): Promise<{ packages: Array<{ id: string }> }>
      installAvailable(extensionId: string): Promise<unknown>
      setActivation(extensionId: string, context: NdContext, enabled: boolean): Promise<unknown>
    }
  }
}

let launched: LaunchedApp
const rendererErrors: string[] = []
const GAME_TAB = /3D Tic-Tac-Toe/

function webviewFrameUrl(page: LaunchedApp['page']): string {
  return page.frames().find((frame) => frame.url().startsWith('nd-extension-ui://'))?.url() ?? ''
}

test.beforeAll(async () => {
  launched = await launchApp()
  launched.page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`))
  launched.page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`)
  })
  // The keep-alive tabs render on the header's company row, so seed an
  // organization the same way the product does on first run.
  await launched.page.evaluate(async () => {
    await (globalThis as NdPlatformWindow).ndDshOrganization.mutate({
      type: 'company.create',
      name: 'Keepalive Labs',
      mission: 'Exercise extension view keep-alive.',
    })
  })
})

test.afterAll(async () => {
  await closeApp(launched)
})

test('an opened web view stays alive in the background until its tab is closed', async () => {
  const page = launched.page

  await page.getByLabel('ND-DSH navigation').getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('tab', { name: 'Extensions' }).click()
  await page.evaluate(async () => {
    const api = (globalThis as NdPlatformWindow).ndDsh.ndExtensions
    const state = await api.state()
    if (!state.packages.some((item) => item.id === 'nd.tic-tac-toe')) {
      await api.installAvailable('nd.tic-tac-toe')
    }
    await api.setActivation('nd.tic-tac-toe', { kind: 'personal' }, true)
  })

  const card = page.locator('article', { hasText: 'ND 3D Tic-Tac-Toe' })
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: /^Open/ }).first().click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  // While the modal dialog is open the rest of the app is aria-hidden (Radix
  // modal semantics), so the header tab is checked after the dialog closes.
  await expect.poll(() => webviewFrameUrl(page), { timeout: 15_000 }).not.toBe('')
  const urlBefore = webviewFrameUrl(page)
  expect(urlBefore).toContain('nd.tic-tac-toe')

  // Closing the dialog backgrounds the view; the tab stays and the frame
  // keeps its token (no reload, no fresh loadView).
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  const tab = page.getByRole('tab', { name: GAME_TAB })
  await expect(tab, `renderer errors: ${rendererErrors.join(' | ')}`).toBeVisible()
  await expect.poll(() => webviewFrameUrl(page)).toBe(urlBefore)

  // Navigating the app away and back keeps the backgrounded view alive.
  await page.getByLabel('ND-DSH navigation').getByRole('button', { name: 'Personal' }).click()
  await expect(tab).toBeVisible()
  await expect.poll(() => webviewFrameUrl(page)).toBe(urlBefore)

  // Reopening from the tab re-docks the SAME frame.
  await tab.click()
  await expect(dialog).toBeVisible()
  await expect.poll(() => webviewFrameUrl(page)).toBe(urlBefore)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // The tab's × is what truly closes it: tab and frame both go away.
  await tab.getByRole('button', { name: 'Close 3D Tic-Tac-Toe' }).click()
  await expect(page.getByRole('tab', { name: GAME_TAB })).toHaveCount(0)
  await expect(dialog).toBeHidden()
  await expect.poll(() => webviewFrameUrl(page)).toBe('')

  expect(rendererErrors).toEqual([])
})

test('keep-alive tabs stay visible on a narrow window with a full company row', async () => {
  const page = launched.page
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 640, deviceScaleFactor: 1, mobile: false })
  try {
    await page.getByLabel('ND-DSH navigation').getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('tab', { name: 'Extensions' }).click()

    const card = page.locator('article', { hasText: 'ND 3D Tic-Tac-Toe' })
    await card.getByRole('button', { name: /^Open/ }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    const tab = page.getByRole('tab', { name: GAME_TAB })
    await expect(tab).toBeVisible()
    const box = await tab.boundingBox()
    expect(box, 'tab must have on-screen geometry').toBeTruthy()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(900)

    await tab.getByRole('button', { name: 'Close 3D Tic-Tac-Toe' }).click()
    await expect(page.getByRole('tab', { name: GAME_TAB })).toHaveCount(0)
  } finally {
    await session.send('Emulation.clearDeviceMetricsOverride')
  }
})

const BROWSER_TAB = /Mini Browser/

test('the Mini Browser chrome stays alive and opens real ND browser tabs', async () => {
  const page = launched.page

  await page.getByLabel('ND-DSH navigation').getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('tab', { name: 'Extensions' }).click()
  await page.evaluate(async () => {
    const api = (globalThis as NdPlatformWindow).ndDsh.ndExtensions
    const state = await api.state()
    if (!state.packages.some((item) => item.id === 'nd.mini-browser')) {
      await api.installAvailable('nd.mini-browser')
    }
    await api.setActivation('nd.mini-browser', { kind: 'personal' }, true)
  })

  const card = page.locator('article', { hasText: 'ND Mini Browser' })
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: /^Open/ }).first().click()

  const dialog = page.getByRole('dialog')
  const closeDialog = page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true })
  await expect(dialog).toBeVisible()

  await expect.poll(() => webviewFrameUrl(page)).not.toBe('')
  const urlBefore = webviewFrameUrl(page)
  expect(urlBefore).toContain('nd.mini-browser')

  // Opening two addresses creates REAL engine tabs; the chrome lists them
  // (each Open re-renders the session rows from the live target).
  const frame = page.frames().find((candidate) => candidate.url() === urlBefore)
  expect(frame, 'chrome frame is reachable').toBeTruthy()
  // The builtin target carries a default tab; wait for the chrome's initial
  // session render so the baseline row count is stable before opening anything.
  await expect
    .poll(async () => await frame!.locator('#tabs li').count(), { timeout: 15_000 })
    .toBeGreaterThan(0)
  const startedRows = await frame!.locator('#tabs > li:not(.empty)').count()
  // Opening an address creates a REAL engine tab, auto-hides the chrome, and
  // surfaces the site in the ND browser pane (browser-focus event). The next
  // address re-docks the keep-alive chrome from its header tab first.
  // A real tab attach waits on the site itself, so the waits here are generous:
  // an unreachable network makes the open take far longer than a DNS-warm run.
  const headerTab = page.getByRole('tab', { name: BROWSER_TAB })
  for (const address of ['https://example.com/mnt-1', 'https://example.com/mnt-2']) {
    const marker = address.split('/').at(-1)!
    if (await dialog.isVisible()) {
      await frame!.locator('#address').fill(address)
      await frame!.locator('#open').click()
      await expect(dialog, `after open (${marker}) — hash ${page.url()}`).toBeHidden({ timeout: 30_000 })
    } else {
      await headerTab.click()
      await expect
        .poll(() => page.url(), { timeout: 10_000, message: `redock click — hash did not reach settings (was ${page.url()})` })
        .toContain('settings')
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      const redocked = page.frames().find((candidate) => candidate.url() === urlBefore)
      await redocked!.locator('#address').fill(address)
      await redocked!.locator('#open').click()
      await expect(dialog).toBeHidden({ timeout: 30_000 })
    }
    await expect.poll(async () => (await page.frames().find((candidate) => candidate.url() === urlBefore)!.locator('#tabs')).textContent(), { timeout: 30_000 }).toContain(marker)
    // The browser-focus event names the context that opened the tab, and the
    // site is presented there. The Mini Browser is a Personal-only package, so
    // its tabs surface in the Personal space — never under the company that
    // happens to be active.
    await expect
      .poll(() => page.url())
      .toContain('home')
    await expect(page.getByRole('region', { name: 'Personal browser' })).toBeVisible()
  }
  await expect.poll(async () => (await page.frames().find((candidate) => candidate.url() === urlBefore)!.locator('#tabs > li:not(.empty)').count())).toBe(startedRows + 2)

  // Re-dock the keep-alive chrome: the same frame, with the opened tabs listed.
  await headerTab.click()
  await expect(dialog).toBeVisible()
  await expect.poll(() => webviewFrameUrl(page)).toBe(urlBefore)
  const redocked = page.frames().find((candidate) => candidate.url() === urlBefore)
  await expect.poll(async () => (await redocked!.locator('#tabs > li:not(.empty)').count())).toBe(startedRows + 2)

  // Closing from the chrome auto-hides + surfaces the browser pane each time;
  // the last open row drops back to the pre-test count.
  for (let index = startedRows + 2; index > startedRows; index -= 1) {
    if (await dialog.isHidden()) {
      await headerTab.click()
      await expect(dialog).toBeVisible()
    }
    const current = page.frames().find((candidate) => candidate.url() === urlBefore)
    await current!.getByRole('button', { name: /Close tab/ }).first().click()
    await expect(dialog).toBeHidden()
    await expect
      .poll(async () => (await page.frames().find((candidate) => candidate.url() === urlBefore)!.locator('#tabs > li:not(.empty)').count()))
      .toBe(index - 1)
  }

  await closeDialog.click()
  await expect(dialog).toBeHidden()
  const tab = page.getByRole('tab', { name: BROWSER_TAB })
  await expect(tab).toBeVisible()
  await tab.getByRole('button', { name: 'Close Mini Browser' }).click()
  await expect(page.getByRole('tab', { name: BROWSER_TAB })).toHaveCount(0)
  await expect.poll(() => webviewFrameUrl(page)).toBe('')

  expect(rendererErrors).toEqual([])
})
