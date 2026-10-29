import { expect, test } from '@playwright/test'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { closeApp, createWorkspaceDir, e2eModelConfig, launchApp, type LaunchedApp } from './fixtures.js'
import type { DesignDesktopApi } from '../src/shared/design.js'
import type { OrganizationDesktopApi } from '../src/shared/organization.js'

type DesignWindow = typeof globalThis & { ndDshDesign: DesignDesktopApi; ndDshOrganization: OrganizationDesktopApi }

test.skip(
  !e2eModelConfig().configured || process.env.ND_DESIGN_AGENT_E2E !== '1',
  'Set ND_DESIGN_AGENT_E2E=1 with the E2E model route to exercise live ND Agent canvas editing.',
)

test('ND Agent edits the live canvas without hiding it', async () => {
  test.setTimeout(240_000)
  const workspace = await createWorkspaceDir()
  let launched: LaunchedApp | undefined
  const output = join(process.cwd(), 'e2e-results', `design-agent-${Date.now()}`)
  await mkdir(output, { recursive: true })
  const errors: string[] = []
  try {
    launched = await launchApp({ useConfiguredModels: true })
    const { page } = launched
    page.on('pageerror', (error) => errors.push(error.message))
    await page.evaluate(async (workspacePath) => {
      const organization = await (globalThis as DesignWindow).ndDshOrganization.mutate({ type: 'company.create', name: 'Design Agent Check', mission: 'Verify live canvas editing.' })
      const company = organization.companies.find((item) => item.name === 'Design Agent Check')!
      const state = await (globalThis as DesignWindow).ndDshOrganization.mutate({ type: 'project.create', companyId: company.id, name: 'Agent Canvas', objective: 'Let the agent edit a design.', workspacePath })
      const project = state.projects.find((item) => item.companyId === company.id && item.name === 'Agent Canvas')!
      await (globalThis as DesignWindow).ndDshOrganization.mutate({ type: 'project.activate', id: project.id })
    }, workspace)
    await page.getByRole('navigation', { name: 'ND-DSH navigation' }).getByTitle('Design').click()
    await page.getByRole('button', { name: /^ND Pencil/ }).click()
    await page.getByRole('button', { name: 'New ND Pencil Canvas' }).click()
    await expect.poll(async () => (await page.evaluate(() => (globalThis as DesignWindow).ndDshDesign.designState())).status, { timeout: 30_000 }).toBe('ready')
    const opened = await page.evaluate(() => (globalThis as DesignWindow).ndDshDesign.designState())
    const stage = page.getByRole('application', { name: 'ND Pencil canvas' })
    await expect(stage).toBeVisible()
    await page.screenshot({ path: join(output, '01-before.png') })

    const prompt = page.getByRole('textbox', { name: 'Ask ND Agent to edit the canvas' })
    await prompt.fill('Use the nd_design tool now. Add a new rectangle node named "Agent rect" inside Frame 1, fill #2563eb, at x=120, y=120, width=320, height=80. Do not change any other node. Reply with the new revision.')
    await prompt.press('Enter')
    await expect(stage).toBeVisible()

    await expect.poll(async () => {
      const sync = await page.evaluate(() => (globalThis as DesignWindow).ndDshDesign.designSync())
      if (!sync.document) return false
      return Object.values(sync.document.nodes).some((node) => node.name === 'Agent rect')
    }, { timeout: 210_000, intervals: [1000] }).toBe(true)

    await expect(stage).toBeVisible()
    const sync = await page.evaluate(() => (globalThis as DesignWindow).ndDshDesign.designSync())
    expect(sync.document).not.toBeNull()
    const agentRect = Object.values(sync.document!.nodes).find((node) => node.name === 'Agent rect')
    expect(agentRect?.type).toBe('rect')
    const savedFile = join(workspace, opened.documentPath!)
    await expect.poll(async () => {
      const text = await readFile(savedFile, 'utf8')
      return text.includes('Agent rect')
    }, { timeout: 15_000, intervals: [500] }).toBe(true)
    await page.screenshot({ path: join(output, '02-agent-edit.png') })
    expect(errors).toEqual([])
  } finally {
    await closeApp(launched)
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  }
})
