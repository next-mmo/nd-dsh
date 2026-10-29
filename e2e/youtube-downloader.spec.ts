/// <reference lib="dom" />

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Frame, type Page } from '@playwright/test'
import type { NdExtensionsStateView } from '../src/shared/nd-invocations.js'
import type { NdContext } from '../src/shared/nd-context.js'
import { closeApp, launchApp, type LaunchedApp } from './fixtures.js'

type NdPlatformWindow = typeof globalThis & {
  ndDsh: {
    ndExtensions: {
      installAvailable(extensionId: string): Promise<NdExtensionsStateView>
      setActivation(extensionId: string, context: NdContext, enabled: boolean): Promise<NdExtensionsStateView>
    }
  }
}

test.describe.configure({ mode: 'serial' })

const extensionId = 'nd.youtube-downloader'
const live = process.env.ND_MEDIA_DOWNLOAD_E2E === '1'
const sampleVideo = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
let launched: LaunchedApp
let downloadsDir = ''
let toolsDir = ''
const rendererErrors: string[] = []

test.setTimeout(live ? 600_000 : 120_000)

async function openLauncher(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
  const launcher = page.getByRole('dialog', { name: 'ND Quick Launcher' })
  if (await launcher.isVisible().catch(() => false)) return
  // A second running ND dev instance can own the OS-wide shortcut. Emit the
  // same main-process event the OS shortcut would deliver; this is test-only
  // and keeps the launcher path deterministic on a developer machine.
  await launched.app.evaluate(({ app }) => { app.emit('second-instance') })
  await launcher.waitFor({ state: 'visible', timeout: 10_000 })
}

async function openDownloaderView(page: Page): Promise<Frame> {
  const previous = page.getByRole('dialog', { name: 'YouTube Downloader' }).getByRole('button', { name: 'Close' })
  if (await previous.isVisible().catch(() => false)) {
    await previous.click()
    await page.getByRole('dialog', { name: 'YouTube Downloader' }).waitFor({ state: 'hidden', timeout: 10_000 })
  }

  await openLauncher(page)
  const launcher = page.getByRole('dialog', { name: 'ND Quick Launcher' })
  await launcher.getByPlaceholder('Search ND or type something to capture…').fill('YouTube Downloader')
  await launcher.getByText('YouTube Downloader', { exact: true }).first().click()
  await page.getByRole('dialog', { name: 'YouTube Downloader' }).waitFor({ state: 'visible', timeout: 10_000 })

  const iframe = page.locator('iframe[title="YouTube Downloader"]')
  await iframe.waitFor({ state: 'attached', timeout: 15_000 })
  let frame: Frame | null = null
  await expect.poll(async () => {
    for (const handle of await page.locator('iframe[title="YouTube Downloader"]').elementHandles()) {
      if (!(await handle.isVisible())) continue
      const content = await handle.contentFrame()
      if (content?.url().startsWith('nd-extension-ui://')) {
        frame = content
        return content.url()
      }
    }
    return ''
  }, { timeout: 15_000 }).toContain('nd-extension-ui://')
  return frame!
}

test.beforeAll(async () => {
  // Always isolate both folders: the offline test must not see a developer's
  // real tool installation, and a live run must never write real Downloads.
  downloadsDir = await mkdtemp(join(tmpdir(), 'nd-youtube-downloads-'))
  toolsDir = await mkdtemp(join(tmpdir(), 'nd-youtube-tools-'))
  process.env.ND_DSH_MEDIA_DOWNLOAD_DIR = downloadsDir
  process.env.ND_DSH_MEDIA_TOOLS_ROOT = toolsDir

  launched = await launchApp()
  launched.page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`))
  launched.page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`)
  })
})

test.afterAll(async () => {
  await closeApp(launched)
  await rm(downloadsDir, { recursive: true, force: true }).catch(() => undefined)
  await rm(toolsDir, { recursive: true, force: true }).catch(() => undefined)
})

test('appears in Discover, installs, and activates for Personal', async () => {
  const state = await launched.page.evaluate(async () =>
    await (globalThis as NdPlatformWindow).ndDsh.ndExtensions.installAvailable('nd.youtube-downloader'))
  expect(state.packages.some((item) => item.id === extensionId)).toBe(true)

  const activated = await launched.page.evaluate(async () =>
    await (globalThis as NdPlatformWindow).ndDsh.ndExtensions.setActivation(
      'nd.youtube-downloader',
      { kind: 'personal' },
      true,
    ))
  expect(activated.packages.find((item) => item.id === extensionId)).toBeDefined()
})

test('opens a sandboxed view with the setup card and disabled download', async () => {
  const frame = await openDownloaderView(launched.page)
  expect(frame.url().startsWith('nd-extension-ui://')).toBe(true)

  await expect(frame.locator('#setup-card')).toBeVisible()
  await expect(frame.locator('#tool-list .tool-row')).toHaveCount(2, { timeout: 15_000 })
  await expect(frame.locator('#tool-list')).toContainText('yt-dlp 2026.10.21')
  await expect(frame.locator('#tool-list')).toContainText('Deno 2.9.8')
  await expect(frame.locator('#setup-badge')).toHaveText('Setup required')
  await expect(frame.locator('#start-hint')).toHaveText('Set up the downloader first.', { timeout: 15_000 })
  await expect(frame.locator('#start')).toBeDisabled()
  await expect(frame.locator('#current-title')).toHaveText('No YouTube video detected')
  expect(rendererErrors, `renderer errors: ${rendererErrors.join(' | ')}`).toEqual([])
})

test('downloads a small public video when ND_MEDIA_DOWNLOAD_E2E=1', async () => {
  test.skip(!live, 'Set ND_MEDIA_DOWNLOAD_E2E=1 to download pinned tools and a real video.')
  const frame = await openDownloaderView(launched.page)

  if (await frame.locator('#setup-card').isVisible().catch(() => false)) {
    await frame.locator('#setup-button').click()
  }
  await expect(frame.locator('#setup-badge')).toHaveText('Ready', { timeout: 300_000 })
  await expect(frame.locator('#setup-card')).toBeHidden()

  await frame.locator('#url').fill(sampleVideo)
  await expect(frame.locator('#start')).toBeEnabled({ timeout: 10_000 })
  await frame.locator('#start').click()

  let outcome = 'waiting'
  await expect.poll(async () => {
    const error = await frame.locator('#jobs .error').first().textContent().catch(() => '')
    if (error) {
      outcome = `error: ${error}`
      return outcome
    }
    const jobs = frame.locator('#jobs .job')
    const count = await jobs.count()
    for (let index = 0; index < count; index += 1) {
      const text = await jobs.nth(index).textContent()
      if (text?.includes('Saved')) {
        outcome = 'saved'
        return outcome
      }
    }
    outcome = 'waiting'
    return outcome
  }, { timeout: 300_000, intervals: [1_000, 2_000, 5_000] }).not.toBe('waiting')
  if (outcome.startsWith('error:')) throw new Error(outcome)

  const files = (await readdir(downloadsDir)).filter((name) => name.endsWith('.mp4'))
  expect(files.length).toBe(1)
  const bytes = await readFile(join(downloadsDir, files[0]!))
  expect(bytes.length).toBeGreaterThan(1_000)
  expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp')

  const screenshotPath = process.env.ND_MEDIA_E2E_SCREENSHOT?.trim()
  if (screenshotPath) await launched.page.screenshot({ path: screenshotPath, fullPage: false })
})
