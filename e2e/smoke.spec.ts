// The evaluate callbacks in this spec run in the renderer with the trusted
// preload attached; that preload API is not type-exported yet, so the narrow
// surface these probes touch is declared below. `window` itself needs the
// DOM lib.
/// <reference lib="dom" />

import { expect, test } from '@playwright/test'
import type { TerminalDesktopApi } from '../src/shared/terminal.js'
import { closeApp, launchApp, type LaunchedApp } from './fixtures.js'

type RendererWindow = {
  ndDsh: {
    workspace: { state(): Promise<{ root: string }> }
    dsh: { rpc(method: string, params?: unknown): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }> }
    harness: { status(): Promise<{ state: string }> }
  }
}

test.describe.configure({ mode: 'serial' })

let launched: LaunchedApp
const rendererErrors: string[] = []

test.beforeAll(async () => {
  launched = await launchApp()
  // The OS clamps the window to the host display, which would make the pane
  // measurements below depend on the machine running the suite. Pin the app's
  // own default desktop size so the shipped layout is what gets asserted.
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1640, 980)
  })
  await expect.poll(() => launched.page.evaluate(() => window.innerWidth)).toBe(1640)
  launched.page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`))
  launched.page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`)
  })
})

test.afterAll(async () => {
  await closeApp(launched)
})

test('product shell boots in General and can enter the Coding workspace', async () => {
  const { page } = launched
  await expect(page.getByRole('banner').getByText('ND-DSH', { exact: true })).toBeVisible()
  const profiles = page.getByRole('group', { name: 'Workspace profile' })
  const general = profiles.getByRole('button', { name: 'GENERAL', exact: true })
  const coding = profiles.getByRole('button', { name: 'CODING', exact: true })
  await expect(general).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('group', { name: 'Coding surface' })).toHaveCount(0)
  const navigation = page.getByRole('navigation', { name: 'ND-DSH navigation' })
  for (const label of ['Personal', 'Company', 'Agent', 'Design', 'Settings']) {
    await expect(navigation.getByTitle(label)).toBeVisible()
  }
  await expect(navigation.getByTitle('QA')).toHaveCount(0)

  await coding.click()
  await expect(coding).toHaveAttribute('aria-pressed', 'true')
  const codingSurface = page.getByRole('group', { name: 'Coding surface' })
  await expect(codingSurface.getByRole('button', { name: 'ND', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(codingSurface.getByRole('button', { name: 'DSH', exact: true })).toBeVisible()
  await expect(navigation.getByTitle('QA')).toBeVisible()
})

test('persisted Coding keeps a QA deep link across renderer reload', async () => {
  const { page } = launched
  const navigation = page.getByRole('navigation', { name: 'ND-DSH navigation' })
  await navigation.getByTitle('QA').click()
  await expect(page).toHaveURL(/#\/qa$/)

  await page.reload()
  const profiles = page.getByRole('group', { name: 'Workspace profile' })
  await expect(profiles.getByRole('button', { name: 'CODING', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page).toHaveURL(/#\/qa$/)
  await expect(page.getByRole('heading', { name: 'Project checks', exact: true })).toBeVisible()
})

test('header segment switches between ND and DSH coding surfaces', async () => {
  const { page } = launched
  const codingSurface = page.getByRole('group', { name: 'Coding surface' })
  const nd = codingSurface.getByRole('button', { name: 'ND', exact: true })
  const dsh = codingSurface.getByRole('button', { name: 'DSH', exact: true })

  await dsh.click()
  await expect(dsh).toHaveAttribute('aria-pressed', 'true')
  const dshSurface = page.getByRole('region', { name: 'DSH coding surface' })
  await expect(dshSurface).toBeVisible()
  // A clean CI machine has to boot the real vendored Harness before this can
  // appear; allow cold-start headroom without substituting a fake gateway.
  await expect(dshSurface.getByText(/Gateway :\d+/)).toBeVisible({ timeout: 60_000 })
  await expect(dshSurface.getByRole('button', { name: 'Reload DSH coding surface' })).toBeVisible()
  await expect(dshSurface.getByRole('button', { name: 'Open DSH coding surface externally' })).toBeVisible()

  const profiles = page.getByRole('group', { name: 'Workspace profile' })
  await profiles.getByRole('button', { name: 'GENERAL', exact: true }).click()
  await expect(profiles.getByRole('button', { name: 'GENERAL', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('group', { name: 'Coding surface' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'DSH coding surface' })).toHaveCount(0)

  const directDshAttempt = await page.evaluate(async () => {
    const api = globalThis as typeof globalThis & {
      ndDsh: { surface: { set(surface: 'dsh'): Promise<unknown> } }
    }
    try {
      await api.ndDsh.surface.set('dsh')
      return 'accepted'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })
  expect(directDshAttempt).toContain('requires the Coding workspace profile')

  await profiles.getByRole('button', { name: 'CODING', exact: true }).click()
  const restoredCodingSurface = page.getByRole('group', { name: 'Coding surface' })
  await expect(restoredCodingSurface.getByRole('button', { name: 'ND', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(rendererErrors).toEqual([])
})

test('real Harness gateway creates and reads a chat session', async () => {
  const { page } = launched
  const probe = await page.evaluate(async () => {
    // This callback runs in the renderer, so the trusted preload API is only
    // reachable through `window` here; module-scope helpers do not exist there.
    const api = window as unknown as RendererWindow
    const workspace = await api.ndDsh.workspace.state()
    const created = await api.ndDsh.dsh.rpc('session.create', { cwd: workspace.root })
    if (!created.ok) {
      const status = await api.ndDsh.harness.status()
      return {
        state: status.state,
        createdOk: false,
        historyOk: false,
        sessionId: '',
        error: created.error?.message ?? 'session.create failed',
      }
    }

    const sessionId = (created.value as { sessionId?: unknown } | undefined)?.sessionId
    if (typeof sessionId !== 'string' || !sessionId) {
      const status = await api.ndDsh.harness.status()
      return {
        state: status.state,
        createdOk: false,
        historyOk: false,
        sessionId: '',
        error: 'session.create returned no session id',
      }
    }

    const history = await api.ndDsh.dsh.rpc('session.history', { sessionId })
    const status = await api.ndDsh.harness.status()
    return {
      state: status.state,
      createdOk: true,
      historyOk: history.ok,
      sessionId,
      error: history.ok ? '' : history.error?.message ?? 'session.history failed',
    }
  })

  expect(probe.state).not.toBe('error')
  expect(probe.createdOk, probe.error).toBe(true)
  expect(probe.sessionId).not.toBe('')
  expect(probe.historyOk, probe.error).toBe(true)
  expect(rendererErrors).toEqual([])
})

test('terminal toggle is hosted by the active thread header', async () => {
  const { page } = launched
  await page.getByRole('navigation', { name: 'ND-DSH navigation' }).getByTitle('Agent').click()

  const threadHeader = page.locator('header').filter({ hasText: 'ACTIVE THREAD' })
  const enginePicker = threadHeader.getByRole('combobox', { name: 'Coding engine' })
  await expect(enginePicker).toBeVisible()
  await enginePicker.click()
  await expect(page.getByRole('option', { name: 'Default · ND Harness' })).toBeVisible()
  await expect(page.getByRole('option', { name: /Codex CLI/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(threadHeader.getByRole('button', { name: /Terminal/ })).toBeVisible()

  const workspaceTabs = page.getByRole('tablist', { name: 'Agent workspace panes' })
  await expect(workspaceTabs.getByRole('button', { name: /Terminal/ })).toHaveCount(0)
})

test('dedicated terminal runs a real PTY command through the sandboxed bridge', async () => {
  const { page } = launched
  const result = await page.evaluate(async () => {
    const api = (globalThis as typeof globalThis & { ndDshTerminal: TerminalDesktopApi }).ndDshTerminal
    const sessionId = `terminal-e2e-${Date.now()}`
    const marker = 'ND_TERMINAL_E2E_OK'
    const created = await api.create({ sessionId, title: 'E2E terminal' })
    const terminal = created.terminals[0]
    if (!terminal) throw new Error('Terminal was not created')
    try {
      const streamed = await new Promise<string>((resolve, reject) => {
        let output = ''
        const timeout = setTimeout(() => { off(); reject(new Error('Timed out waiting for PTY output')) }, 15_000)
        const off = api.onOutput((event) => {
          if (event.sessionId !== sessionId || event.terminalId !== terminal.id) return
          output += event.data
          if (output.includes(marker)) { clearTimeout(timeout); off(); resolve(output) }
        })
        void api.write(sessionId, terminal.id, `node -e "console.log(Buffer.from('TkRfVEVSTUlOQUxfRTJFX09L','base64').toString())"\r`).catch((error) => { clearTimeout(timeout); off(); reject(error) })
      })
      const latest = await api.state(sessionId)
      const snapshot = latest.terminals.find((item) => item.id === terminal.id)
      if (!snapshot) throw new Error('Terminal disappeared after command execution')
      return { streamed, buffer: snapshot.buffer, status: snapshot.status, shell: snapshot.shell }
    } finally {
      await api.close(sessionId, terminal.id).catch(() => undefined)
    }
  })
  expect(result.streamed).toContain('ND_TERMINAL_E2E_OK')
  expect(result.buffer).toContain('ND_TERMINAL_E2E_OK')
  expect(result.status).toBe('running')
  expect(result.shell.length).toBeGreaterThan(0)
  expect(rendererErrors).toEqual([])
})

test('primary surfaces switch without renderer errors', async () => {
  const { page } = launched
  const navigation = page.getByRole('navigation', { name: 'ND-DSH navigation' })
  for (const label of ['Company', 'Agent', 'Design', 'QA', 'Settings']) {
    await navigation.getByTitle(label).click()
    const route = label === 'Settings'
      ? /#\/settings\?tab=general$/
      : new RegExp(`#/${label.toLowerCase()}$`)
    await expect(page).toHaveURL(route)
  }
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  expect(rendererErrors).toEqual([])
})

test('Company exposes operations and long-horizon strategy controls', async () => {
  const { page } = launched
  await page.getByRole('navigation', { name: 'ND-DSH navigation' }).getByTitle('Company').click()
  await expect(page).toHaveURL(/#\/company$/)
  await page.evaluate(async () => {
    const api = (globalThis as typeof globalThis & {
      ndDshOrganization: {
        state(): Promise<{ companies: Array<{ id: string }> }>
        mutate(value: { type: 'company.create'; name: string; mission: string }): Promise<unknown>
      }
    }).ndDshOrganization
    const state = await api.state()
    if (state.companies.length === 0) {
      await api.mutate({
        type: 'company.create',
        name: 'E2E Company',
        mission: 'Verify the AI company operations surface',
      })
    }
  })
  await page.getByRole('button', { name: 'Operations', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Needs You', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Verification', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Signal Inbox', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'AI Employee Performance', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Strategy', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Release Readiness', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Strategic Anchors', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Company Brain', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Automation & Agent Routines', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Human Review Feed', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Action Audit', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Company Workspace', exact: true }).click()
  expect(rendererErrors).toEqual([])
})

test('Settings sub-tabs update their addressable route', async () => {
  const { page } = launched
  const navigation = page.getByRole('navigation', { name: 'ND-DSH navigation' })
  await navigation.getByTitle('Settings').click()

  const sections = page.getByRole('tablist', { name: 'Settings sections' })
  await sections.getByRole('tab', { name: 'Capabilities', exact: true }).click()
  await expect(page).toHaveURL(/#\/settings\?tab=capabilities$/)

  const subTabs = page.getByRole('tablist', { name: 'Capabilities sub-tabs' })
  await subTabs.getByRole('tab', { name: 'Memory', exact: true }).click()
  await expect(page).toHaveURL(/#\/settings\?tab=capabilities&subtab=memory$/)
  await expect(page.getByRole('heading', { name: 'Memory providers', exact: true })).toBeVisible()
  await expect(page.getByText('OpenViking Memory', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Download & Setup' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Not in this release' })).toHaveCount(0)

  await subTabs.getByRole('tab', { name: 'Lifecycle', exact: true }).click()
  await expect(page).toHaveURL(/#\/settings\?tab=capabilities&subtab=lifecycle$/)
  await expect(page.getByText('Approved setup only', { exact: true })).toBeVisible()
})

test('theme persistence and embedded browser controls respond', async () => {
  const { page } = launched
  await page.getByRole('button', { name: 'Theme' }).click()
  await page.getByRole('menuitemradio', { name: 'Light' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await page.getByRole('navigation', { name: 'ND-DSH navigation' }).getByTitle('Agent').click()
  const panes = page.getByRole('tablist', { name: 'Agent workspace panes' })
  await panes.getByRole('button', { name: 'Browser' }).click()
  await expect(page.getByRole('region', { name: 'Built-in browser' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Address' })).toHaveValue('about:blank')
  await panes.getByRole('button', { name: 'Files' }).click()

  await page.getByRole('button', { name: 'Theme' }).click()
  await page.getByRole('menuitemradio', { name: 'System' }).click()
  expect(rendererErrors).toEqual([])
})

test('Design Live App keeps the workspace and inspector panes usable', async () => {
  const { page } = launched
  await page.getByRole('navigation', { name: 'ND-DSH navigation' }).getByTitle('Design').click()

  const workspacePane = page.getByRole('complementary', { name: 'Design workspace' })
  const liveApp = page.getByRole('region', { name: 'Built-in browser' })
  const inspectorPane = page.getByRole('complementary', { name: 'Design inspector' })
  await expect(workspacePane).toBeVisible()
  await expect(liveApp).toBeVisible()
  await expect(inspectorPane).toBeVisible()

  const [workspaceBox, liveAppBox, inspectorBox] = await Promise.all([
    workspacePane.boundingBox(),
    liveApp.boundingBox(),
    inspectorPane.boundingBox(),
  ])
  // Electron can report CSS layout widths on fractional device pixels even
  // when the resizable panel has enforced its integer-pixel minimum.
  expect(Math.round(workspaceBox?.width ?? 0)).toBeGreaterThanOrEqual(200)
  expect(Math.round(inspectorBox?.width ?? 0)).toBeGreaterThanOrEqual(220)
  expect(liveAppBox?.x).toBeGreaterThanOrEqual((workspaceBox?.x ?? 0) + (workspaceBox?.width ?? 0))
  expect(inspectorBox?.x).toBeGreaterThanOrEqual((liveAppBox?.x ?? 0) + (liveAppBox?.width ?? 0))
})

test('QA opens project checks', async () => {
  const { page } = launched
  await page.getByRole('navigation', { name: 'ND-DSH navigation' }).getByTitle('QA').click()
  await expect(page).toHaveURL(/#\/qa$/)
  await expect(page.getByRole('heading', { name: 'Project checks', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Checks', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveCount(3)
})
