/// <reference lib="dom" />

import { expect, test } from '@playwright/test'
import { IPC } from '../src/shared/contracts.js'
import type { OrganizationDesktopApi, OrganizationSnapshot } from '../src/shared/organization.js'
import { closeApp, createWorkspaceDir, launchApp, type LaunchedApp } from './fixtures.js'

type OrganizationWindow = typeof globalThis & {
  ndDshOrganization: OrganizationDesktopApi
}

type LauncherDesktopWindow = typeof globalThis & {
  ndDsh: {
    window?: {
      toggleLauncherPopup?(): Promise<{ visible: boolean }>
    }
  }
}

test.describe.configure({ mode: 'serial' })

let launched: LaunchedApp
let companyAId = ''
let projectAId = ''
let companyBId = ''
let projectBId = ''
const rendererErrors: string[] = []

const COMPANY_A = 'Launcher Labs'
const COMPANY_B = 'Launcher Commerce'
const PROJECT_A = 'Daily Console'
const PROJECT_B = 'Checkout Desk'

async function state(): Promise<OrganizationSnapshot> {
  return await launched.page.evaluate(async () => {
    return await (globalThis as OrganizationWindow).ndDshOrganization.state()
  })
}

async function openLauncherFromMain(): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, channel) => {
    const target = BrowserWindow.getAllWindows().find((window) => {
      if (window.isDestroyed()) return false
      return !window.webContents.getURL().includes('#/float')
    })
    if (!target) throw new Error('ND main window was not found')
    target.webContents.send(channel)
  }, IPC.windowQuickLauncherEvent)
}

async function openLauncherFromKeyboard(): Promise<void> {
  await launched.page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
}

test.beforeAll(async () => {
  launched = await launchApp()
  launched.page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`))
  launched.page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`)
  })

  const workspaceA = await createWorkspaceDir()
  const workspaceB = await createWorkspaceDir()
  const ids = await launched.page.evaluate(async ({ workspaceA, workspaceB, companyAName, companyBName, projectAName, projectBName }) => {
    const api = (globalThis as OrganizationWindow).ndDshOrganization
    let snapshot = await api.mutate({
      type: 'company.create',
      name: companyAName,
      mission: 'Exercise the daily ND launcher.',
    })
    const companyA = snapshot.companies.find((item) => item.name === companyAName)
    if (!companyA) throw new Error('Company A was not created')

    snapshot = await api.mutate({
      type: 'project.create',
      companyId: companyA.id,
      name: projectAName,
      objective: 'Verify launcher task and note capture.',
      workspacePath: workspaceA,
    })
    const projectA = snapshot.projects.find((item) => item.name === projectAName)
    if (!projectA) throw new Error('Project A was not created')

    snapshot = await api.mutate({
      type: 'company.create',
      name: companyBName,
      mission: 'Verify cross-company launcher switching.',
    })
    const companyB = snapshot.companies.find((item) => item.name === companyBName)
    if (!companyB) throw new Error('Company B was not created')

    snapshot = await api.mutate({
      type: 'project.create',
      companyId: companyB.id,
      name: projectBName,
      objective: 'Verify recent-project launcher switching.',
      workspacePath: workspaceB,
    })
    const projectB = snapshot.projects.find((item) => item.name === projectBName)
    if (!projectB) throw new Error('Project B was not created')

    await api.mutate({ type: 'company.activate', id: companyA.id })
    await api.mutate({ type: 'project.activate', id: projectA.id })
    return { companyAId: companyA.id, projectAId: projectA.id, companyBId: companyB.id, projectBId: projectB.id }
  }, { workspaceA, workspaceB, companyAName: COMPANY_A, companyBName: COMPANY_B, projectAName: PROJECT_A, projectBName: PROJECT_B })

  companyAId = ids.companyAId
  projectAId = ids.projectAId
  companyBId = ids.companyBId
  projectBId = ids.projectBId
})

test.afterAll(async () => {
  await closeApp(launched)
})

test('Ctrl/Cmd+K opens the launcher and Escape returns to the same surface', async () => {
  const { page } = launched
  await page.getByRole('navigation', { name: 'ND-DSH navigation' }).getByTitle('Settings').click()
  await expect(page).toHaveURL(/#\/settings/)

  await openLauncherFromKeyboard()
  const dialog = page.getByRole('dialog', { name: 'ND Quick Launcher' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByPlaceholder('Search ND or type something to capture…')).toBeFocused()
  // The in-app launcher opens on the current company/project context; the
  // selector and the footer both name it, so match either occurrence.
  await expect(dialog.getByText(`${COMPANY_A} · ${PROJECT_A}`, { exact: true }).first()).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/#\/settings/)
  expect(rendererErrors).toEqual([])
})

test('typed launcher actions create a real task and project-scoped memory', async () => {
  const { page } = launched

  await openLauncherFromKeyboard()
  let dialog = page.getByRole('dialog', { name: 'ND Quick Launcher' })
  const input = dialog.getByPlaceholder('Search ND or type something to capture…')
  await input.fill('Launcher E2E task')
  await dialog.getByText(/Create task · Launcher E2E task/).click()

  await expect(page).toHaveURL(/#\/company$/)
  let snapshot = await state()
  const task = snapshot.tasks.find((item) => item.title === 'Launcher E2E task')
  expect(task?.companyId).toBe(companyAId)
  expect(task?.projectId).toBe(projectAId)
  expect(task?.description).toBe('Launcher E2E task')
  expect(task?.acceptanceCriteria).toContain('Requested outcome is implemented and verified.')

  await openLauncherFromKeyboard()
  dialog = page.getByRole('dialog', { name: 'ND Quick Launcher' })
  await dialog.getByPlaceholder('Search ND or type something to capture…').fill('Launcher E2E note')
  await dialog.getByText(/Quick note · Launcher E2E note/).click()

  snapshot = await state()
  const note = snapshot.memory.find((item) => item.title === 'Launcher E2E note')
  expect(note?.companyId).toBe(companyAId)
  expect(note?.projectId).toBe(projectAId)
  expect(note?.content).toBe('Launcher E2E note')
  expect(note?.tags).toEqual(['launcher', 'manual'])
  expect(rendererErrors).toEqual([])
})

test('main-process launcher event switches recent project context and exposes capture commands', async () => {
  const { page } = launched

  await openLauncherFromMain()
  let dialog = page.getByRole('dialog', { name: 'ND Quick Launcher' })
  await expect(dialog).toBeVisible()
  await dialog.getByPlaceholder('Search ND or type something to capture…').fill(PROJECT_B)
  await dialog.getByText(PROJECT_B, { exact: true }).click()

  const switched = await state()
  expect(switched.activeCompanyId).toBe(companyBId)
  expect(switched.activeProjectId).toBe(projectBId)
  await expect(page).toHaveURL(/#\/company$/)

  await openLauncherFromMain()
  dialog = page.getByRole('dialog', { name: 'ND Quick Launcher' })
  await expect(dialog.getByText('Capture External Screen', { exact: true })).toBeVisible()
  await expect(dialog.getByText('External Capture Tools', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Capture Clipboard', { exact: true })).toBeVisible()
  // Wallpaper Manager is personal-only, so a project-scoped launcher must not
  // surface its native OS command.
  await expect(dialog.getByText('Choose wallpaper', { exact: true })).toHaveCount(0)
  await expect(dialog.getByText(`${COMPANY_B} · ${PROJECT_B}`, { exact: true }).first()).toBeVisible()
  await page.keyboard.press('Escape')

  expect(rendererErrors).toEqual([])
})

test('launcher popup window toggles like Raycast and creates a task without opening the main window', async () => {
  const { page } = launched

  const popupPromise = launched.app.waitForEvent('window')
  await page.evaluate(() => (globalThis as LauncherDesktopWindow).ndDsh.window?.toggleLauncherPopup?.())
  const popup = await popupPromise
  popup.on('pageerror', (error) => rendererErrors.push(`popup pageerror: ${error.message}`))
  popup.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(`popup console: ${message.text()}`)
  })
  await expect.poll(() => popup.url()).toContain('#/launcher')

  const dialog = popup.getByRole('dialog', { name: 'ND Quick Launcher' })
  await expect(dialog).toBeVisible()
  const popupInput = dialog.getByPlaceholder('Search ND or type something to capture…')
  await expect(popupInput).toBeFocused()
  // Built-in native extensions contribute through the same command registry as
  // core actions; do not execute the wallpaper command in automation because it
  // intentionally opens a real OS picker and changes the user's desktop.
  await expect(dialog.getByText('Choose wallpaper', { exact: true })).toBeVisible()

  // The popup always opens on Personal: a typed task therefore needs an
  // explicit project context first, and never inherits the window's active one.
  await popupInput.fill('Launcher E2E popup task')
  await dialog.getByText(/Create task · Launcher E2E popup task/).click()
  await expect(popup.getByText('Tasks need a project context. Pick one in Context first.')).toBeVisible()
  expect(await popup.evaluate(() => document.hasFocus())).toBe(true)
  expect((await state()).tasks.find((item) => item.title === 'Launcher E2E popup task')).toBeUndefined()

  // Failed validation keeps the popup focused so the user can correct context.
  const contextLabel = `${COMPANY_B} · ${PROJECT_B}`
  await expect(dialog).toBeVisible()
  await popupInput.fill('')
  await dialog.getByText(contextLabel, { exact: true }).first().click()
  await popupInput.fill('Launcher E2E popup task')
  await dialog.getByText(/Create task · Launcher E2E popup task/).click()

  const snapshot = await state()
  const popupTask = snapshot.tasks.find((item) => item.title === 'Launcher E2E popup task')
  // The task lands in the context the popup explicitly shows — Company B's
  // Checkout Desk, not a stale scope and never cross-company.
  expect(popupTask?.companyId).toBe(companyBId)
  expect(popupTask?.projectId).toBe(projectBId)
  expect(popupTask?.acceptanceCriteria).toContain('Requested outcome is implemented and verified.')

  // The picked action closes the popup; the same toggle opens it again and a
  // second press hides it — the Raycast show/hide contract.
  const reopenToggle = await page.evaluate(() => (globalThis as LauncherDesktopWindow).ndDsh.window?.toggleLauncherPopup?.())
  expect(reopenToggle?.visible).toBe(true)
  await expect(dialog).toBeVisible()
  const closeToggle = await page.evaluate(() => (globalThis as LauncherDesktopWindow).ndDsh.window?.toggleLauncherPopup?.())
  expect(closeToggle?.visible).toBe(false)

  expect(rendererErrors).toEqual([])
})
