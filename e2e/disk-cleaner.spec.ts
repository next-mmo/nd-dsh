/// <reference lib="dom" />

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

test.describe.configure({ mode: 'serial' })

let launched: LaunchedApp
let fixtureDir: string
const rendererErrors: string[] = []

async function openLauncher(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
}

/** Run the disk-cleaner command from the launcher and return the sandboxed frame. */
async function openDiskView(page: Page): Promise<Frame> {
  // Close any previous instance so exactly one live cleaner frame exists.
  const previous = page.getByRole('dialog', { name: 'ND Disk Cleaner' }).getByRole('button', { name: 'Close' })
  if (await previous.isVisible().catch(() => false)) {
    await previous.click()
    await page.getByRole('dialog', { name: 'ND Disk Cleaner' }).waitFor({ state: 'hidden', timeout: 10_000 })
  }
  // Closed views unload by default; wait out the old frame's teardown so the
  // next open cannot race a stale instance's iframe.
  await page.locator('iframe[title="ND Disk Cleaner"]')
    .waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined)

  await openLauncher(page)
  const launcher = page.getByRole('dialog', { name: 'ND Quick Launcher' })
  await launcher.getByPlaceholder('Search ND or type something to capture…').fill('Disk Cleaner')
  await launcher.getByText('Open ND Disk Cleaner', { exact: true }).click()
  await page.getByRole('dialog', { name: 'ND Disk Cleaner' }).waitFor({ state: 'visible', timeout: 10_000 })

  // Anchor on the live iframe: stale frames from earlier dialog instances can
  // linger while their teardown finishes (or parked by keep-alive) — skip
  // hidden handles and take the one actually on the extension scheme.
  const iframe = page.locator('iframe[title="ND Disk Cleaner"]')
  await iframe.waitFor({ state: 'attached', timeout: 15_000 })
  let frame: Frame | null = null
  await expect.poll(async () => {
    for (const handle of await page.locator('iframe[title="ND Disk Cleaner"]').elementHandles()) {
      if (!(await handle.isVisible())) continue
      const content = await handle.contentFrame()
      if (content?.url().startsWith('nd-extension-ui://')) {
        frame = content
        return content.url()
      }
    }
    return ''
  }, { timeout: 15_000 }).toContain('nd-extension-ui://')
  // Navigation is not readiness: wait for the frame's bridge handshake before
  // driving it, or clicks land before the UI script is listening.
  await frame!.locator('body[data-bridge="connected"]').waitFor({ state: 'attached', timeout: 15_000 })
  return frame!
}

/**
 * Scan the fixture folder. The host can re-issue the frame's asset URL around
 * dialog churn, and a click that lands while the fresh document is still
 * binding handlers is silently dropped — so treat "status never moved" as the
 * signal to re-sync and try the gesture again.
 */
async function scanFixtureDir(frame: Frame): Promise<void> {
  await expect(async () => {
    await frame.locator('body[data-bridge="connected"]').waitFor({ state: 'attached', timeout: 15_000 })
    await frame.locator('#path').fill(fixtureDir)
    await frame.locator('#scan').click()
    await expect(frame.locator('#status')).not.toHaveText('Choose a folder or volume to scan', { timeout: 2_000 })
  }).toPass({ timeout: 60_000 })
}

test.beforeAll(async () => {
  launched = await launchApp()
  launched.page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`))
  launched.page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`)
  })
  // The trash host confirms through a native dialog; auto-approve "Move to
  // Trash" so the spec exercises the host path, not the OS modal.
  await launched.app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
  })

  fixtureDir = await mkdtemp(join(tmpdir(), 'nd-disk-cleaner-e2e-'))
  await writeFile(join(fixtureDir, 'big.bin'), Buffer.alloc(2_000_000, 1))
  await writeFile(join(fixtureDir, 'mid.bin'), Buffer.alloc(1_000_000, 2))
  await writeFile(join(fixtureDir, 'notes.txt'), 'cleanup target\n')
  await mkdir(join(fixtureDir, 'nested'))
  await writeFile(join(fixtureDir, 'nested', 'inner.bin'), Buffer.alloc(500_000, 3))
})

test.afterAll(async () => {
  await closeApp(launched)
  await rm(fixtureDir, { recursive: true, force: true })
})

test('appears in Discover and installs on demand for Personal', async () => {
  // Dev builds surface the external package in the Discover catalog; packaged
  // releases fetch it from the separately published catalog (zero app payload).
  const state = await launched.page.evaluate(async () =>
    await (globalThis as NdPlatformWindow).ndDsh.ndExtensions.installAvailable('nd.disk-cleaner'))
  expect(state.packages.some((item) => item.id === 'nd.disk-cleaner')).toBe(true)

  const activated = await launched.page.evaluate(async () =>
    await (globalThis as NdPlatformWindow).ndDsh.ndExtensions.setActivation('nd.disk-cleaner', { kind: 'personal' }, true))
  expect(activated.packages.find((item) => item.id === 'nd.disk-cleaner')).toBeDefined()
})

test('the launcher command opens the package web view in a sandboxed frame', async () => {
  const frame = await openDiskView(launched.page)
  expect(frame.url().startsWith('nd-extension-ui://')).toBe(true)
  await frame.locator('#status').waitFor({ state: 'visible', timeout: 10_000 })
  await expect(frame.locator('#scan')).toBeVisible()
})

test('scanning a folder shows its biggest items and drills into folders', async () => {
  const frame = await openDiskView(launched.page)
  await scanFixtureDir(frame)

  // The scan runs in nd-core with live progress; the rows appear when it lands.
  await expect(frame.locator('.row[data-name="big.bin"]')).toBeVisible({ timeout: 30_000 })
  await expect(frame.locator('.row[data-name="mid.bin"]')).toBeVisible()
  await expect(frame.locator('.row[data-name="nested"]')).toBeVisible()
  await expect(frame.locator('#status')).toContainText('3.34 MB', { timeout: 10_000 })

  // Zoom into the folder through the list; its child file is a real row.
  await frame.locator('.row[data-name="nested"]').click()
  await expect(frame.locator('.row[data-name="inner.bin"]')).toBeVisible({ timeout: 10_000 })
  await expect(frame.locator('#breadcrumb')).toContainText('nested')

  // Esc steps back out to the scan root.
  await frame.locator('body').press('Escape')
  await expect(frame.locator('.row[data-name="big.bin"]')).toBeVisible({ timeout: 10_000 })
})

test('trash asks the host, confirms natively, and the item leaves disk', async () => {
  const frame = await openDiskView(launched.page)
  await scanFixtureDir(frame)
  await expect(frame.locator('.row[data-name="notes.txt"]')).toBeVisible({ timeout: 30_000 })

  await frame.locator('.row[data-name="notes.txt"] .row-action.trash').click()
  await expect(frame.locator('.row[data-name="notes.txt"]')).toHaveCount(0, { timeout: 15_000 })
  expect(existsSync(join(fixtureDir, 'notes.txt'))).toBe(false)

  // The chart totals stay honest without a rescan.
  await expect(frame.locator('#status')).toContainText('trash', { timeout: 10_000 })
})

test('the cleaner UI renders on changes and leaves no renderer errors', async () => {
  const frame = await openDiskView(launched.page)
  await scanFixtureDir(frame)
  await expect(frame.locator('.row[data-name="big.bin"]')).toBeVisible({ timeout: 30_000 })
  // The canvas has painted the tree (a plain 2D canvas, drawn only on state changes).
  const painted = await frame.locator('#sunburst').evaluate((canvas: HTMLCanvasElement) => canvas.width > 0 && canvas.height > 0)
  expect(painted).toBe(true)

  expect(rendererErrors, `renderer errors: ${rendererErrors.join(' | ')}`).toEqual([])
})
