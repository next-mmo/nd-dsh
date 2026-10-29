/// <reference lib="dom" />

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { BrowserPlatformState } from '../src/shared/browser-platform.js'
import { closeApp, launchApp, type LaunchedApp } from './fixtures.js'

type RendererWindow = {
  ndDsh: {
    browserPlatform: {
      state(): Promise<BrowserPlatformState>
      createProfile(name: string, color?: string): Promise<BrowserPlatformState>
      selectProfile(profileId: string): Promise<BrowserPlatformState>
      setDefaultProfile(profileId: string): Promise<BrowserPlatformState>
      deleteProfile(profileId: string): Promise<BrowserPlatformState>
    }
  }
}

const COOKIE_URL = 'https://nd-profile.test/'
const LEGACY_PARTITION = 'persist:nd-dsh-browser'
const workPartition = (profileId: string): string => `persist:nd-dsh-browser-${profileId}`

function readState(launched: LaunchedApp): Promise<BrowserPlatformState> {
  return launched.page.evaluate(() =>
    (window as unknown as RendererWindow).ndDsh.browserPlatform.state())
}

function readCookie(launched: LaunchedApp, partition: string): Promise<string[]> {
  return launched.app.evaluate(async ({ session }, part) => {
    const cookies = await session.fromPartition(part).cookies.get({ url: 'https://nd-profile.test/' })
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).sort()
  }, partition)
}

async function setCookie(launched: LaunchedApp, partition: string, value: string): Promise<void> {
  await launched.app.evaluate(async ({ session }, input) => {
    await session.fromPartition(input.partition).cookies.set({
      url: 'https://nd-profile.test/',
      name: 'identity',
      value: input.value, expirationDate: Math.floor(Date.now() / 1000) + 3600,
    })
  }, { partition, value })
}

test.describe.configure({ mode: 'serial' })

let profileDir = ''

test.beforeAll(async () => {
  profileDir = await mkdtemp(join(tmpdir(), 'nd-dsh-profiles-e2e-'))
})

test.afterAll(async () => {
  await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
})

test('ND browser profiles isolate cookies, switch in the UI, and survive a restart', async () => {
  const first = await launchApp({ userDataDir: profileDir })
  let workId = ''
  try {
    await expect.poll(async () => (await readState(first)).profiles.length, { timeout: 30_000 }).toBe(1)
    await setCookie(first, LEGACY_PARTITION, 'default')

    // Create a profile like Chrome's "Add profile": ND switches to it and opens
    // its own blank tab immediately.
    const created = await first.page.evaluate(() =>
      (window as unknown as RendererWindow).ndDsh.browserPlatform.createProfile('Work', '#4f7cff'))
    const work = created.profiles.find((profile) => profile.name === 'Work')
    expect(work).toBeTruthy()
    workId = work!.id
    expect(work!.active).toBe(true)
    expect(created.profiles.find((profile) => profile.id === 'default')?.active).toBe(false)
    expect(created.tabs.find((tab) => tab.active)?.profileId).toBe(`builtin:${workId}`)

    await setCookie(first, workPartition(workId), 'work')
    expect(await readCookie(first, LEGACY_PARTITION)).toEqual(['identity=default'])
    expect(await readCookie(first, workPartition(workId))).toEqual(['identity=work'])

    // "Global default" selection: Work becomes the profile ND falls back to.
    const withDefault = await first.page.evaluate((id) =>
      (window as unknown as RendererWindow).ndDsh.browserPlatform.setDefaultProfile(id), workId)
    expect(withDefault.profiles.find((profile) => profile.id === workId)?.isDefault).toBe(true)

    // The toolbar profile chip switches identities and shows the active one.
    await first.page.getByLabel('ND-DSH navigation').getByRole('button', { name: 'Agent' }).click()
    await first.page.getByRole('tablist', { name: 'Agent workspace panes' }).getByRole('button', { name: 'Browser' }).click()
    const browserRegion = first.page.getByRole('region', { name: 'Built-in browser' })
    await expect(browserRegion).toBeVisible()
    const profileChip = browserRegion.getByRole('button', { name: 'Browser profile' })
    await expect(profileChip).toContainText('Work')
    await profileChip.click()
    const popover = first.page.getByRole('dialog')
    await expect(popover.getByText('Browser profiles')).toBeVisible()
    await expect(popover.getByRole('button', { name: /^Default/ })).toBeVisible()
    await popover.getByRole('button', { name: /^Default/ }).click()
    await expect.poll(async () => (await readState(first)).profiles.find((profile) => profile.active)?.id)
      .toBe('default')
    await expect(profileChip).toContainText('Default')

    await profileChip.click()
    await first.page.getByRole('dialog').getByRole('button', { name: /^Work/ }).click()
    await expect.poll(async () => (await readState(first)).profiles.find((profile) => profile.active)?.id)
      .toBe(workId)
    await expect(profileChip).toContainText('Work')

    // Settings → General → Browser hosts the full profile manager.
    await first.page.getByLabel('ND-DSH navigation').getByTitle('Settings').click()
    const sections = first.page.getByRole('tablist', { name: 'Settings sections' })
    await sections.getByRole('tab', { name: 'General', exact: true }).click()
    await first.page.getByRole('tablist', { name: 'General sub-tabs' })
      .getByRole('tab', { name: 'Browser', exact: true }).click()
    await expect(first.page.getByRole('heading', { name: 'Browser profiles' })).toBeVisible()
    const workRow = first.page.getByRole('group', { name: 'Browser profile Work' })
    await expect(workRow).toContainText('ACTIVE')
    await expect(workRow).toContainText('DEFAULT')
    await expect(first.page.getByRole('group', { name: 'Browser profile Default' })).toContainText('1 tab')

    // The default profile is protected.
    const refusal = await first.page.evaluate(async () => {
      try {
        await (window as unknown as RendererWindow).ndDsh.browserPlatform.deleteProfile('default')
        return ''
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause)
      }
    })
    expect(refusal).toMatch(/default browser profile cannot be deleted/i)
  } finally {
    await closeApp(first, { removeUserData: false })
  }

  const second = await launchApp({ userDataDir: profileDir })
  try {
    await expect.poll(async () => (await readState(second)).profiles.length, { timeout: 30_000 }).toBe(2)
    const restored = await readState(second)
    expect(restored.profiles.find((profile) => profile.active)?.id).toBe(workId)
    expect(restored.profiles.find((profile) => profile.id === workId)?.isDefault).toBe(true)
    expect(await readCookie(second, LEGACY_PARTITION)).toEqual(['identity=default'])
    expect(await readCookie(second, workPartition(workId))).toEqual(['identity=work'])

    // A global default profile is protected too; hand the default back before
    // deleting Work.
    const resetDefault = await second.page.evaluate(() =>
      (window as unknown as RendererWindow).ndDsh.browserPlatform.setDefaultProfile('default'))
    expect(resetDefault.profiles.find((profile) => profile.isDefault)?.id).toBe('default')

    // Deleting the active profile falls back to the default identity and
    // removes the profile from the manager.
    const afterDelete = await second.page.evaluate((id) =>
      (window as unknown as RendererWindow).ndDsh.browserPlatform.deleteProfile(id), workId)
    expect(afterDelete.profiles.some((profile) => profile.id === workId)).toBe(false)
    expect(afterDelete.profiles.find((profile) => profile.active)?.id).toBe('default')
    expect(afterDelete.tabs.every((tab) => tab.profileId === 'builtin:default')).toBe(true)
  } finally {
    await closeApp(second)
  }
})
