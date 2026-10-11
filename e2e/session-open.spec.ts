// The evaluate callbacks run in the renderer with the trusted preload attached;
// that API is not type-exported, so the narrow surface these probes touch is
// declared below. `window` itself needs the DOM lib.
/// <reference lib="dom" />

import { expect, test } from '@playwright/test'
import type { NdHomeChatView } from '../src/shared/nd-invocations.js'
import { closeApp, launchApp, type LaunchedApp } from './fixtures.js'

type GatewayRpcResult = { ok: boolean; value?: unknown; error?: { message?: string } }

interface SessionListRow {
  sessionId: string
  blank?: boolean
  projections?: { values?: Record<string, unknown> }
}

type RendererWindow = typeof globalThis & {
  ndDsh: {
    home: {
      ensureChat(context: { kind: 'personal' }): Promise<NdHomeChatView>
      bindChat(chatId: string, sessionId: string): Promise<NdHomeChatView>
    }
    dsh: { rpc(method: string, params?: unknown): Promise<GatewayRpcResult> }
  }
}

test.describe.configure({ mode: 'serial' })

let launched: LaunchedApp
const rendererErrors: string[] = []

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

/** Gateway RPC through ND's own bridge, so the session scoping the sidebar sees applies here too. */
async function rpc(method: string, params: unknown = {}): Promise<GatewayRpcResult> {
  return await launched.page.evaluate(
    async (input) => await (globalThis as RendererWindow).ndDsh.dsh.rpc(input.method, input.params),
    { method, params },
  )
}

async function sessionList(): Promise<SessionListRow[]> {
  const result = await rpc('session.list')
  if (!result.ok) throw new Error(result.error?.message ?? 'session.list failed')
  return ((result.value ?? {}) as { items?: SessionListRow[] }).items ?? []
}

/**
 * The shell starts with the sessions sidebar collapsed when the window is too
 * narrow to give the chat column its expanded minimum, so the picker has to be
 * opened before its cards can be asserted.
 */
async function showSessionSidebar(): Promise<void> {
  const expand = launched.page.getByTitle('Expand sessions sidebar')
  if (await expand.count() > 0) await expand.click()
}

async function waitForSession(predicate: (row: SessionListRow) => boolean, describe: string): Promise<SessionListRow> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const row = (await sessionList()).find(predicate)
    if (row) return row
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${describe}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * A blank thread is hidden from the sidebar unless it is the selected one
 * (ChatPanel filters `!blank || active`), so a visible card with a unique
 * title is only reachable by selecting exactly that session. Both tests
 * rename their session first and assert the blank flag, so a runtime change
 * to blank semantics fails here instead of turning the selection claim
 * vacuous.
 */
test('Home chat Open selects the bound session in the Agent workbench', async () => {
  const { page } = launched

  const home = await page.evaluate(async () => {
    const api = globalThis as RendererWindow
    const chat = await api.ndDsh.home.ensureChat({ kind: 'personal' })
    const created = await api.ndDsh.dsh.rpc('session.create', { cwd: chat.workDir })
    const sessionId = (created.value as { sessionId?: string } | undefined)?.sessionId
    if (!created.ok || typeof sessionId !== 'string') throw new Error(created.error?.message ?? 'session.create returned no session id')
    const renamed = await api.ndDsh.dsh.rpc('session.rename', { sessionId, title: 'E2E home chat' })
    if (!renamed.ok) throw new Error(renamed.error?.message ?? 'session.rename failed')
    await api.ndDsh.home.bindChat(chat.chatId, sessionId)
    return { sessionId }
  })

  // The bound personal chat runs in ND-managed storage outside the active
  // workspace, so its presence in session.list is itself ND's visibility
  // contract for Home chats.
  const listed = await waitForSession(
    (row) => row.sessionId === home.sessionId && row.projections?.values?.title === 'E2E home chat',
    'the home-bound session in session.list',
  )
  expect(listed.blank).toBe(true)

  await page.getByRole('navigation', { name: 'ND-DSH navigation' }).getByTitle('Personal').click()
  const openChat = page.getByRole('button', { name: 'Open', exact: true })
  await expect(openChat).toHaveCount(1)
  await expect(openChat).toBeEnabled()
  await openChat.click()

  await expect(page.getByPlaceholder('Ask the agent to work here — @ files/browser targets, / skills')).toBeVisible()
  await showSessionSidebar()
  await expect(page.getByRole('button', { name: 'E2E home chat' })).toHaveCount(1)
  expect(rendererErrors).toEqual([])
})

test('Agent preset New session opens the created session', async () => {
  const { page } = launched
  const before = new Set((await sessionList()).map((row) => row.sessionId))

  await page.getByRole('navigation', { name: 'ND-DSH navigation' }).getByTitle('Settings').click()
  await page.getByRole('tab', { name: 'Agent presets' }).click()
  const startPreset = page.getByRole('button', { name: 'New session', exact: true }).first()
  await expect(startPreset).toBeVisible()
  await startPreset.click()

  const created = await waitForSession((row) => !before.has(row.sessionId), 'the preset-created session in session.list')
  expect(created.blank).toBe(true)

  await expect(page.getByPlaceholder('Ask the agent to work here — @ files/browser targets, / skills')).toBeVisible()
  // Only the new session is selected; the still-blank home thread from the
  // previous test must have left the sidebar with it.
  await showSessionSidebar()
  await expect(page.getByRole('button', { name: 'New Chat Thread' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'E2E home chat' })).toHaveCount(0)
  expect(rendererErrors).toEqual([])
})
