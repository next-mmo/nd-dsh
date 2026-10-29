import { expect, test } from '@playwright/test'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { closeApp, createWorkspaceDir, launchApp, type LaunchedApp } from './fixtures.js'
import type { DesignDesktopApi } from '../src/shared/design.js'
import type { OrganizationDesktopApi } from '../src/shared/organization.js'

type DesignWindow = typeof globalThis & { ndDshDesign: DesignDesktopApi; ndDshOrganization: OrganizationDesktopApi }

const LEGACY = JSON.stringify({
  version: '0.8.4',
  name: 'Legacy marketing',
  children: [
    { type: 'frame', id: 'legacy-frame', name: 'Landing', x: 0, y: 0, width: 1200, height: 800, fill: [{ type: 'solid', color: '#ffffff' }], children: [] },
    { type: 'rectangle', id: 'legacy-cta', name: 'CTA', x: 80, y: 80, width: 240, height: 64, fill: [{ type: 'solid', color: '#2563eb' }] },
    { type: 'text', id: 'legacy-copy', name: 'Headline', x: 80, y: 180, width: 520, height: 60, content: 'Legacy design', fontSize: 40, fontFamily: 'Inter', fill: [{ type: 'solid', color: '#18181b' }] },
  ],
})

test('legacy OpenPencil .op imports with a report and a durable backup', async () => {
  const workspace = await createWorkspaceDir()
  await mkdir(join(workspace, '.nd/design'), { recursive: true })
  await writeFile(join(workspace, '.nd/design/legacy.op'), LEGACY, 'utf8')
  let launched: LaunchedApp | undefined
  const output = join(process.cwd(), 'e2e-results', `design-migration-${Date.now()}`)
  await mkdir(output, { recursive: true })
  try {
    launched = await launchApp()
    const { page } = launched
    await page.evaluate(async (workspacePath) => {
      const organization = await (globalThis as DesignWindow).ndDshOrganization.mutate({ type: 'company.create', name: 'Migration Check', mission: 'Verify legacy design import.' })
      const company = organization.companies.find((item) => item.name === 'Migration Check')!
      const state = await (globalThis as DesignWindow).ndDshOrganization.mutate({ type: 'project.create', companyId: company.id, name: 'Legacy Import', objective: 'Import and save a legacy design.', workspacePath })
      const project = state.projects.find((item) => item.companyId === company.id && item.name === 'Legacy Import')!
      await (globalThis as DesignWindow).ndDshOrganization.mutate({ type: 'project.activate', id: project.id })
    }, workspace)
    await page.getByRole('navigation', { name: 'ND-DSH navigation' }).getByTitle('Design').click()
    await page.getByRole('button', { name: /^ND Pencil/ }).click()
    await page.getByText('legacy.op', { exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => (globalThis as DesignWindow).ndDshDesign.designState())).status, { timeout: 30_000 }).toBe('ready')
    const opened = await page.evaluate(() => (globalThis as DesignWindow).ndDshDesign.designState())
    expect(opened.dirty).toBe(true)
    expect(opened.migration?.from).toBe('openpencil-0.8.4')
    await expect(page.getByText('Legacy .op imported')).toBeVisible()
    await page.getByTitle('Save (Ctrl+S)').click()
    await expect.poll(async () => (await page.evaluate(() => (globalThis as DesignWindow).ndDshDesign.designState())).dirty, { timeout: 10_000 }).toBe(false)
    const saved = JSON.parse(await readFile(join(workspace, '.nd/design/legacy.op'), 'utf8'))
    expect(saved.format).toBe('nd-pencil')
    expect(saved.version).toBe(2)
    expect(saved.nodes['legacy-cta']?.type).toBe('rect')
    expect(saved.nodes['legacy-copy']?.text).toBe('Legacy design')
    const backups = await readdir(join(workspace, '.nd/design/.backups'))
    expect(backups.some((name) => name.startsWith('legacy.v084-'))).toBe(true)
    await page.screenshot({ path: join(output, 'legacy-imported.png') })
  } finally {
    await closeApp(launched)
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  }
})
