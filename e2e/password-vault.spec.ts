/// <reference lib="dom" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { NdExtensionsStateView, NdInvocationRequest } from '../src/shared/nd-invocations.js'
import type { NdContext } from '../src/shared/nd-context.js'
import { closeApp, launchApp, type LaunchedApp } from './fixtures.js'

type NdPlatformWindow = typeof globalThis & {
  ndDsh: {
    ndExtensions: {
      state(): Promise<NdExtensionsStateView>
      installAvailable(extensionId: string): Promise<NdExtensionsStateView>
      setActivation(extensionId: string, context: NdContext, enabled: boolean): Promise<NdExtensionsStateView>
      loadView(extensionId: string, viewId: string, context: NdContext): Promise<{ rows: Array<{ id: string; title: string; body?: string }> }>
      invoke(request: NdInvocationRequest): Promise<{ ok: boolean; value?: unknown }>
    }
  }
}

test.describe.configure({ mode: 'serial' })

const SECRET = 'nd-e2e-vault-secret-9f24$'
const TITLE = 'Mail — example.com'
const EDITED_TITLE = 'Mail — renamed'

let launched: LaunchedApp
const rendererErrors: string[] = []

/** The vault entry prompt is its own BrowserWindow: arm the window listener, then trigger. */
async function openVaultPrompt(trigger: () => Promise<void>): Promise<Page> {
  const promptPromise = launched.app.waitForEvent('window')
  await trigger()
  const prompt = await promptPromise
  await prompt.waitForLoadState('domcontentloaded')
  await prompt.locator('#f-title').waitFor({ state: 'visible', timeout: 10_000 })
  return prompt
}

async function closeVaultPrompt(prompt: Page): Promise<void> {
  await expect.poll(() => prompt.isClosed(), { timeout: 10_000 }).toBe(true)
}

/** Run the Password Vault command from the launcher and wait for the view dialog. */
async function openVaultView(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await openLauncher(page)
  const launcher = page.getByRole('dialog', { name: 'ND Quick Launcher' })
  await launcher.getByPlaceholder('Search ND or type something to capture…').fill('Password Vault')
  await launcher.getByText('Password Vault', { exact: true }).click()
  await page.getByRole('dialog', { name: 'Password Vault' }).waitFor({ state: 'visible', timeout: 10_000 })
}

async function openLauncher(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
}

/** Surface toasts (sonner) so a failed action names its cause instead of failing opaquely. */
async function currentToasts(page: Page): Promise<string[]> {
  return await page.locator('[data-sonner-toast]').allInnerTexts().catch(() => [])
}

/** vault.list forces the sidecar start; the create test must not race it. */
async function waitForVaultReady(page: Page): Promise<void> {
  await expect.poll(async () => {
    try {
      const view = await page.evaluate(async () => await (globalThis as NdPlatformWindow).ndDsh.ndExtensions.loadView('nd.password-vault', 'vault', { kind: 'personal' }))
      return Array.isArray(view.rows)
    } catch {
      return false
    }
  }, { timeout: 30_000 }).toBe(true)
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

test('installs on demand and activates for Personal', async () => {
  const state = await launched.page.evaluate(async () => await (globalThis as NdPlatformWindow).ndDsh.ndExtensions.installAvailable('nd.password-vault'))
  expect(state.packages.some((item) => item.id === 'nd.password-vault')).toBe(true)

  const activated = await launched.page.evaluate(async () => await (globalThis as NdPlatformWindow).ndDsh.ndExtensions.setActivation('nd.password-vault', { kind: 'personal' }, true))
  expect(activated.packages.find((item) => item.id === 'nd.password-vault')).toBeDefined()
})

test('Add Vault Entry opens the ND-owned prompt and stores the secret encrypted at rest', async () => {
  const { page } = launched
  await waitForVaultReady(page)
  await openLauncher(page)
  const launcher = page.getByRole('dialog', { name: 'ND Quick Launcher' })
  await launcher.getByPlaceholder('Search ND or type something to capture…').fill('Add Vault Entry')

  const prompt = await openVaultPrompt(async () => {
    await launcher.getByText('Add Vault Entry', { exact: true }).click()
  })
  await prompt.locator('#f-title').fill(TITLE)
  await prompt.locator('#f-username').fill('you@example.com')
  await prompt.locator('#f-url').fill('https://mail.example.com')
  await prompt.locator('#f-secret').fill(SECRET)
  await prompt.getByRole('button', { name: 'Save entry' }).click()
  await closeVaultPrompt(prompt)

  // The vault file exists, parses as an envelope, and never contains the secret.
  const vaultPath = join(launched.userDataDir, 'nd-vault', 'vault.ndvault')
  const vaultFile = readFileSync(vaultPath, 'utf8')
  const envelope = JSON.parse(vaultFile) as { version: number; nonce: string; ciphertext: string }
  expect(envelope.version).toBe(1)
  expect(envelope.nonce).toBeTruthy()
  expect(envelope.ciphertext).toBeTruthy()
  expect(vaultFile).not.toContain(SECRET)
  expect(vaultFile).not.toContain('Mail')
  expect(readFileSync(join(launched.userDataDir, 'nd-vault', 'vault.ndvault.key'), 'utf8')).toContain('"version": 1')
})

test('the vault view lists the entry as metadata without ever showing the secret', async () => {
  const { page } = launched
  await openVaultView(page)
  const view = page.getByRole('dialog', { name: 'Password Vault' })
  await expect(view.getByText(TITLE)).toBeVisible()
  await expect(view.getByText('you@example.com')).toBeVisible()
  expect(await view.innerText()).not.toContain(SECRET)
})

test('Copy secret puts the real secret on the clipboard', async () => {
  const { page } = launched
  const view = page.getByRole('dialog', { name: 'Password Vault' })
  await view.getByRole('button', { name: 'Copy secret' }).first().click()

  await expect.poll(async () => await launched.app.evaluate(({ clipboard }) => clipboard.readText()), {
    timeout: 10_000,
  }).toBe(SECRET)
})

test('Edit opens the prefilled prompt, keeps the secret, and saves the new title', async () => {
  const { page } = launched
  const view = page.getByRole('dialog', { name: 'Password Vault' })

  const prompt = await openVaultPrompt(async () => {
    await view.getByRole('button', { name: 'Edit' }).first().click()
  })
  await expect(prompt.locator('#f-title')).toHaveValue(TITLE)
  await expect(prompt.locator('#f-username')).toHaveValue('you@example.com')
  // The prefilled secret must survive the edit round trip unchanged.
  await expect(prompt.locator('#f-secret')).toHaveValue(SECRET)
  await prompt.locator('#f-title').fill(EDITED_TITLE)
  await prompt.getByRole('button', { name: 'Save changes' }).click()
  await closeVaultPrompt(prompt)

  await expect(view.getByText(EDITED_TITLE)).toBeVisible({ timeout: 10_000 })
})

test('Cancel in the prompt changes nothing', async () => {
  const { page } = launched
  const view = page.getByRole('dialog', { name: 'Password Vault' })
  const prompt = await openVaultPrompt(async () => {
    await view.getByRole('button', { name: 'Edit' }).first().click()
  })
  await prompt.locator('#f-title').fill('Should never persist')
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click()
  await closeVaultPrompt(prompt)
  await expect(view.getByText(EDITED_TITLE)).toBeVisible({ timeout: 10_000 })
  await expect(view.getByText('Should never persist')).toHaveCount(0)
})

test('Delete removes the entry and leaves the encrypted file behind', async () => {
  const { page } = launched
  const view = page.getByRole('dialog', { name: 'Password Vault' })
  await view.getByRole('button', { name: 'Delete' }).first().click()

  await expect(view.getByText(EDITED_TITLE)).toHaveCount(0, { timeout: 10_000 })
  await expect(view.getByText('No entries yet')).toBeVisible()
  const vaultPath = join(launched.userDataDir, 'nd-vault', 'vault.ndvault')
  expect(readFileSync(vaultPath, 'utf8')).not.toContain(EDITED_TITLE)

  expect(rendererErrors, `renderer errors: ${rendererErrors.join(' | ')}`).toEqual([])
})
