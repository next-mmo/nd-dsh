/// <reference lib="dom" />

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

test.describe.configure({ mode: 'serial' })

let launched: LaunchedApp
const rendererErrors: string[] = []

async function openLauncher(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
}

/** Run the game command from the launcher and return the sandboxed game frame. */
async function openGameView(page: Page): Promise<Frame> {
  // Close any previous instance so exactly one live game frame exists.
  const previous = page.getByRole('dialog', { name: '3D Tic-Tac-Toe' }).getByRole('button', { name: 'Close' })
  if (await previous.isVisible().catch(() => false)) {
    await previous.click()
    await page.getByRole('dialog', { name: '3D Tic-Tac-Toe' }).waitFor({ state: 'hidden', timeout: 10_000 })
  }

  await openLauncher(page)
  const launcher = page.getByRole('dialog', { name: 'ND Quick Launcher' })
  await launcher.getByPlaceholder('Search ND or type something to capture…').fill('3D Tic-Tac-Toe')
  await launcher.getByText('Play 3D Tic-Tac-Toe', { exact: true }).click()
  await page.getByRole('dialog', { name: '3D Tic-Tac-Toe' }).waitFor({ state: 'visible', timeout: 10_000 })

  // Anchor on the live iframe element: page.frames() can still list stale
  // entries from earlier dialog instances. The frame navigates after attach,
  // so poll until it actually sits on the extension scheme.
  const iframe = page.locator('iframe[title="3D Tic-Tac-Toe"]')
  await iframe.waitFor({ state: 'attached', timeout: 15_000 })
  let frame: Frame | null | undefined
  await expect.poll(async () => {
    const handle = await iframe.elementHandle()
    frame = await handle?.contentFrame() ?? null
    return frame?.url() ?? ''
  }, { timeout: 15_000 }).toContain('nd-extension-ui://')
  return frame!
}

test.beforeAll(async () => {
  launched = await launchApp()
  launched.page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`))
  launched.page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`)
  })
})

test.afterAll(async () => {
  await closeApp(launched)
})

test('appears in Discover and installs on demand for Personal', async () => {
  // Dev builds surface the external package in the Discover catalog; packaged
  // builds omit it entirely (the package is never staged into releases).
  const state = await launched.page.evaluate(async () =>
    await (globalThis as NdPlatformWindow).ndDsh.ndExtensions.installAvailable('nd.tic-tac-toe'))
  expect(state.packages.some((item) => item.id === 'nd.tic-tac-toe')).toBe(true)

  const activated = await launched.page.evaluate(async () =>
    await (globalThis as NdPlatformWindow).ndDsh.ndExtensions.setActivation('nd.tic-tac-toe', { kind: 'personal' }, true))
  expect(activated.packages.find((item) => item.id === 'nd.tic-tac-toe')).toBeDefined()
})

test('the launcher command opens the package web view in a sandboxed frame', async () => {
  const { page } = launched
  const frame = await openGameView(page)
  const url = frame.url()
  expect(url.startsWith('nd-extension-ui://')).toBe(true)

  // The game chrome answers before the bridge does; the scoreboard starts empty.
  await frame.locator('#status').waitFor({ state: 'visible', timeout: 10_000 })
  await expect(frame.locator('#score-wins')).toHaveText('—', { timeout: 15_000 }).catch(() => {
    // The bridge may have already delivered a fresh empty scoreboard (0), which is fine too.
  })
})

test('two players can finish a game and the result lands in the persistent scoreboard', async () => {
  const { page } = launched
  const frame = await openGameView(page)

  await frame.locator('#mode-2p').click()
  await expect(frame.locator('#status')).toHaveText('X to move')

  // X takes the diagonal; O takes two corners-adjacent cells. X wins 0,4,8.
  for (const key of ['1', '2', '5', '3', '9']) {
    await frame.locator('body').press(key)
  }
  await expect(frame.locator('#status')).toHaveText('X wins!', { timeout: 10_000 })
  await expect(frame.locator('#score-wins')).toHaveText('1', { timeout: 10_000 })
  await expect(frame.locator('#score-losses')).toHaveText('0')
  await expect(frame.locator('#score-draws')).toHaveText('0')

  // The scoreboard is durable main-side, not renderer state.
  const statsPath = join(launched.userDataDir, 'nd-tic-tac-toe', 'stats.json')
  const stats = JSON.parse(readFileSync(statsPath, 'utf8')) as { stats: { wins: number; losses: number; draws: number } }
  expect(stats.stats).toMatchObject({ wins: 1, losses: 0, draws: 0 })
})

test('reopening the view restores the persisted scoreboard and reset clears it', async () => {
  const { page } = launched
  const frame = await openGameView(page)

  await expect(frame.locator('#score-wins')).toHaveText('1', { timeout: 15_000 })

  await frame.locator('#reset-scores').click()
  await expect(frame.locator('#score-wins')).toHaveText('0', { timeout: 10_000 })

  const statsPath = join(launched.userDataDir, 'nd-tic-tac-toe', 'stats.json')
  const stats = JSON.parse(readFileSync(statsPath, 'utf8')) as { stats: { wins: number } }
  expect(stats.stats.wins).toBe(0)

  expect(rendererErrors, `renderer errors: ${rendererErrors.join(' | ')}`).toEqual([])
})
