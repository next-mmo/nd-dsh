import { expect, test } from '@playwright/test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { closeApp, createWorkspaceDir, launchApp, type LaunchedApp } from './fixtures.js'
import { electronTargetIdentity } from '../scripts/e2e-electron-target.mjs'
import type { DesignDesktopApi } from '../src/shared/design.js'
import type { OrganizationDesktopApi } from '../src/shared/organization.js'

type DesignWindow = typeof globalThis & { ndDshDesign: DesignDesktopApi; ndDshOrganization: OrganizationDesktopApi }

test('in-repo ND Pencil draws, saves and reopens a project design', async () => {
  const target = electronTargetIdentity()
  const output = join(process.cwd(), 'e2e-results', `design-editor-${Date.now()}`)
  await mkdir(output, { recursive: true })
  const workspace = await createWorkspaceDir()
  let launched: LaunchedApp | undefined
  const errors: string[] = []
  try {
    launched = await launchApp()
    const { page, app } = launched
    page.on('pageerror', (error) => errors.push(error.message))
    await page.evaluate(async (workspacePath) => {
      const organization = await (globalThis as DesignWindow).ndDshOrganization.mutate({ type: 'company.create', name: 'Design Release Check', mission: 'Verify the in-repo design surface.' })
      const company = organization.companies.find((item) => item.name === 'Design Release Check')!
      const state = await (globalThis as DesignWindow).ndDshOrganization.mutate({ type: 'project.create', companyId: company.id, name: 'Design Check', objective: 'Create and save a design.', workspacePath })
      const project = state.projects.find((item) => item.companyId === company.id && item.name === 'Design Check')!
      await (globalThis as DesignWindow).ndDshOrganization.mutate({ type: 'project.activate', id: project.id })
    }, workspace)
    await page.getByRole('navigation', { name: 'ND-DSH navigation' }).getByTitle('Design').click()
    await page.getByRole('button', { name: /^ND Pencil/ }).click()
    await page.getByRole('button', { name: 'New ND Pencil Canvas' }).click()
    await expect.poll(async () => (await page.evaluate(() => (globalThis as DesignWindow).ndDshDesign.designState())).status, { timeout: 30_000 }).toBe('ready')
    const opened = await page.evaluate(() => (globalThis as DesignWindow).ndDshDesign.designState())
    expect(opened.engine).toBe('nd-pencil')
    expect(opened.documentPath).toMatch(/\.op$/)
    expect(opened.revision).toBeGreaterThan(0)
    const documentFile = join(workspace, opened.documentPath!)
    const initial = JSON.parse(await readFile(documentFile, 'utf8'))
    expect(initial.format).toBe('nd-pencil')
    expect(initial.version).toBe(2)

    const stage = page.getByRole('application', { name: 'ND Pencil canvas' })
    await expect(stage).toBeVisible()
    const box = await stage.boundingBox()
    if (!box) throw new Error('ND Pencil stage has no bounds')
    await page.getByRole('button', { name: 'Rectangle (R)' }).click()
    const startX = box.x + box.width * 0.38
    const startY = box.y + box.height * 0.42
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(startX + step * 16, startY + step * 10)
    }
    await page.mouse.up()
    await expect.poll(async () => (await page.evaluate(() => (globalThis as DesignWindow).ndDshDesign.designState())).dirty, { timeout: 10_000 }).toBe(true)
    await page.getByTitle('Save (Ctrl+S)').click()
    await expect.poll(async () => (await page.evaluate(() => (globalThis as DesignWindow).ndDshDesign.designState())).dirty, { timeout: 10_000 }).toBe(false)
    const saved = JSON.parse(await readFile(documentFile, 'utf8'))
    const savedNodes = Object.values(saved.nodes) as Array<{ type: string }>
    expect(savedNodes.some((node) => node.type === 'rect')).toBe(true)
    await page.screenshot({ path: join(output, '01-canvas.png') })

    const childUrls = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((item) => item.getURL()))
    expect(childUrls.some((url) => url.includes('?frame='))).toBe(false)
    expect(childUrls.some((url) => url.includes('embed=vscode'))).toBe(false)

    await page.getByRole('button', { name: 'Close canvas' }).click()
    await expect.poll(async () => (await page.evaluate(() => (globalThis as DesignWindow).ndDshDesign.designState())).documentPath).toBeUndefined()
    await page.getByRole('button', { name: /^ND Pencil/ }).click()
    await page.getByText('home.op', { exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => (globalThis as DesignWindow).ndDshDesign.designState())).status, { timeout: 30_000 }).toBe('ready')
    const reopened = await page.evaluate(() => (globalThis as DesignWindow).ndDshDesign.designState())
    expect(reopened.documentPath).toBe(opened.documentPath)
    expect(reopened.dirty).toBe(false)
    expect(JSON.parse(await readFile(documentFile, 'utf8')).format).toBe('nd-pencil')
    await page.screenshot({ path: join(output, '02-reopened.png') })
    expect(errors).toEqual([])
    await writeFile(join(output, 'functional-result.json'), JSON.stringify({ target, opened, reopened, nodeCount: savedNodes.length, errors }, null, 2))
  } finally {
    await closeApp(launched)
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  }
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'pass', target, cleanup: 'pass', finishedAt: new Date().toISOString() }, null, 2))
})
