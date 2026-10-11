/// <reference lib="dom" />

import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './fixtures.js'

test.describe.configure({ mode: 'serial' })

let launched: LaunchedApp
const rendererErrors: string[] = []
const shots = join(tmpdir(), 'nd-guide-shots')

test.beforeAll(async () => {
  await mkdir(shots, { recursive: true })
  launched = await launchApp()
  launched.page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`))
  launched.page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`)
  })
})

test.afterAll(async () => {
  await closeApp(launched)
})

test('a user can read the extension developer guide from Settings → Extensions', async () => {
  await launched.page.getByLabel('ND-DSH navigation').getByRole('button', { name: 'Settings' }).click()
  await launched.page.getByRole('tab', { name: 'Extensions' }).click()

  const guideButton = launched.page.getByRole('button', { name: 'Developer guide' })
  await expect(guideButton).toBeVisible()
  await expect(launched.page.getByRole('button', { name: 'Install from folder' })).toBeVisible()
  await launched.page.screenshot({ path: join(shots, '1-extensions-toolbar.png') })

  await guideButton.click()
  const dialog = launched.page.getByRole('dialog', { name: 'Extension developer guide' })
  await expect(dialog).toBeVisible()

  // Overview section: real guide content, rendered as prose rather than source.
  await expect(dialog).toContainText('ND Extensions')
  await expect(dialog).toContainText('Is there an SDK?')
  await expect(dialog).toContainText('No published SDK, and no scaffolding CLI')
  await launched.page.screenshot({ path: join(shots, '2-guide-overview.png') })

  // Relative repo links must not leak as literal "[label](../../path)" text.
  const overviewText = await dialog.innerText()
  expect(overviewText).not.toContain('](../')
  expect(overviewText).not.toContain('](authoring.md')
  console.log('OVERVIEW CHARS:', overviewText.length)

  await dialog.getByRole('button', { name: 'Authoring guide' }).click()
  await expect(dialog).toContainText('Authoring ND extensions')
  await expect(dialog).toContainText('The host methods v1 exposes')
  await expect(dialog).toContainText('note.create')
  await expect(dialog).toContainText('os.wallpaper.applySelected')
  await expect(dialog).toContainText('Two different things are both called "extensions"')
  await launched.page.screenshot({ path: join(shots, '3-guide-authoring.png') })

  const authoringText = await dialog.innerText()
  expect(authoringText).not.toContain('](../')
  console.log('AUTHORING CHARS:', authoringText.length)
  console.log('SHOTS:', shots)

  expect(rendererErrors, `renderer errors: ${rendererErrors.join(' | ')}`).toEqual([])
})
