/// <reference lib="dom" />

import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Frame, type Page } from '@playwright/test'
import type { NdExtensionsStateView } from '../src/shared/nd-invocations.js'
import { closeApp, launchApp, type LaunchedApp } from './fixtures.js'

type NdPlatformWindow = typeof globalThis & {
  ndDsh: {
    ndExtensions: {
      state(): Promise<NdExtensionsStateView>
      installAvailable(extensionId: string): Promise<NdExtensionsStateView>
      setActivation(extensionId: string, context: { kind: 'personal' }, enabled: boolean): Promise<NdExtensionsStateView>
    }
  }
}

test.describe.configure({ mode: 'serial' })

let launched: LaunchedApp
let server: Server
let port = 0
const rendererErrors: string[] = []

function specDocument(): string {
  return JSON.stringify({
    openapi: '3.0.1',
    info: { title: 'User API', version: '1.0.0' },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    paths: {
      '/users/{id}': {
        get: {
          summary: 'Get a user',
          tags: ['Users'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
    },
  })
}

async function openLauncher(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
}

async function openStudio(page: Page): Promise<Frame> {
  const dialog = page.getByRole('dialog', { name: 'API Studio' })
  if (!(await dialog.isVisible().catch(() => false))) {
    await openLauncher(page)
    const launcher = page.getByRole('dialog', { name: 'ND Quick Launcher' })
    await launcher.getByPlaceholder('Search ND or type something to capture…').fill('API Studio')
    await launcher.getByText('Open API Studio', { exact: true }).click()
    await dialog.waitFor({ state: 'visible', timeout: 15_000 })
  }

  await page.locator('iframe[title="API Studio"]').waitFor({ state: 'attached', timeout: 15_000 })
  let frame: Frame | null = null
  await expect.poll(async () => {
    for (const handle of await page.locator('iframe[title="API Studio"]').elementHandles()) {
      if (!(await handle.isVisible())) continue
      const content = await handle.contentFrame()
      if (content?.url().startsWith('nd-extension-ui://')) {
        frame = content
        return content.url()
      }
    }
    return ''
  }, { timeout: 15_000 }).toContain('nd-extension-ui://')
  return frame!
}

async function waitForWorkspaceSave(frame: Frame): Promise<void> {
  await expect(frame.locator('#save-state')).toHaveText('Saved', { timeout: 10_000 })
}

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/v3/api-docs') {
      const body = specDocument()
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      })
      response.end(body)
      return
    }
    if (request.url === '/users/42') {
      const body = JSON.stringify({ id: 42, name: 'Alice', roles: ['admin'] })
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'x-api-studio-test': 'yes',
      })
      response.end(body)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
  port = address.port

  launched = await launchApp()
  launched.page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`))
  launched.page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`)
  })

  await launched.page.evaluate(async () =>
    await (globalThis as NdPlatformWindow).ndDsh.ndExtensions.installAvailable('nd.api-studio'))
  await launched.page.evaluate(async () =>
    await (globalThis as NdPlatformWindow).ndDsh.ndExtensions.setActivation('nd.api-studio', { kind: 'personal' }, true))
})

test.afterAll(async () => {
  await closeApp(launched)
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('is discoverable as an on-demand package and opens in a sandboxed frame', async () => {
  const state = await launched.page.evaluate(async () =>
    await (globalThis as NdPlatformWindow).ndDsh.ndExtensions.state())
  expect((state.available ?? []).find((item) => item.id === 'nd.api-studio')).toMatchObject({
    id: 'nd.api-studio',
    name: 'ND API Studio',
    available: true,
    installed: true,
  })

  const frame = await openStudio(launched.page)
  expect(frame.url().startsWith('nd-extension-ui://')).toBe(true)
  await frame.locator('#boot').waitFor({ state: 'detached', timeout: 20_000 })
  await expect(frame.locator('.empty strong')).toHaveText('No request open')
})

test('sends a request through the Rust runtime and saves it into a collection', async () => {
  const frame = await openStudio(launched.page)
  await frame.locator('.empty').getByRole('button', { name: 'New request' }).click()

  await frame.locator('.url-input').fill(`http://127.0.0.1:${port}/users/42`)
  await frame.locator('.send-btn').click()

  await expect(frame.locator('.response-head .status-pill')).toHaveText('200 OK', { timeout: 20_000 })
  await expect(frame.locator('.response-body')).toContainText('Alice')
  await expect(frame.locator('.response-meta')).toContainText('ms')

  await frame.locator('.editor-tabs').getByRole('button', { name: /Save to/ }).click()
  const modal = frame.locator('.modal-card')
  await expect(modal.getByRole('heading', { name: 'Save request' })).toBeVisible()
  await modal.locator('input.field').nth(0).fill('Get user 42')
  await modal.locator('input.field').nth(1).fill('User Service')
  await modal.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(frame.locator('.sidebar')).toContainText('User Service')
  await expect(frame.locator('.sidebar')).toContainText('Get user 42')
  await waitForWorkspaceSave(frame)

  const workspacePath = join(launched.userDataDir, 'nd-api-studio', 'workspace.json')
  const stored = JSON.parse(readFileSync(workspacePath, 'utf8')) as { version: number; encrypted: boolean }
  expect(stored.version).toBe(1)
  expect(typeof stored.encrypted).toBe('boolean')
})

test('resolves {{variables}} from the active environment', async () => {
  const frame = await openStudio(launched.page)
  await frame.getByRole('button', { name: 'Environments' }).click()
  await frame.locator('.env-editor').getByRole('button', { name: 'Add variable' }).click()
  const row = frame.locator('.variable-row').first()
  await row.locator('input.kv-input').nth(0).fill('baseUrl')
  await row.locator('input.kv-input').nth(1).fill(`http://127.0.0.1:${port}`)
  await waitForWorkspaceSave(frame)

  await frame.getByRole('button', { name: 'Collections' }).click()
  await frame.locator('.tabstrip button[title="New request"]').click()
  await frame.locator('.url-input').fill('{{baseUrl}}/users/42')
  await frame.locator('.send-btn').click()

  await expect(frame.locator('.response-head .status-pill')).toHaveText('200 OK', { timeout: 20_000 })
  await expect(frame.locator('.response-body')).toContainText('Alice')
})

test('imports an OpenAPI URL, tries an operation, and keeps history across reopen', async () => {
  const frame = await openStudio(launched.page)
  await frame.getByRole('button', { name: 'Docs' }).click()
  await frame.locator('#import-button').click()

  const modal = frame.locator('.modal-card')
  await modal.locator('.segmented').getByRole('button', { name: 'URL' }).click()
  await modal.locator('input[placeholder="http://localhost:8080/v3/api-docs"]').fill(`http://127.0.0.1:${port}/v3/api-docs`)
  await modal.locator('.modal-actions').getByRole('button', { name: 'Import' }).click()
  await expect(modal).toBeHidden({ timeout: 30_000 })

  await expect(frame.locator('.doc-scroll')).toContainText('User API', { timeout: 20_000 })
  await frame.locator('.op-item').filter({ hasText: '/users/{id}' }).click()
  await frame.getByRole('button', { name: 'Try it out' }).click()

  // The active environment already has baseUrl from the previous test, so the
  // Try It Out request keeps the variable and resolves it at send time.
  await expect(frame.locator('.url-input')).toHaveValue('{{baseUrl}}/users/{id}')
  await frame.locator('.editor-tab').filter({ hasText: 'Path' }).click()
  await frame.locator('.kv-row input.kv-input.value').first().fill('42')
  await frame.locator('.send-btn').click()
  await expect(frame.locator('.response-head .status-pill')).toHaveText('200 OK', { timeout: 20_000 })
  await expect(frame.locator('.response-body')).toContainText('Alice')

  await frame.getByRole('button', { name: 'History' }).click()
  await expect(frame.locator('.history-table')).toContainText('/users/{id}')
  await expect(frame.locator('.history-table')).toContainText('200')
  await waitForWorkspaceSave(frame)

  const specs = await readdir(join(launched.userDataDir, 'nd-api-studio', 'specs'))
  expect(specs.some((name) => name.endsWith('.txt'))).toBe(true)

  const dialog = launched.page.getByRole('dialog', { name: 'API Studio' })
  await dialog.getByRole('button', { name: 'Close' }).click()
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 })

  const reopened = await openStudio(launched.page)
  await reopened.getByRole('button', { name: 'Collections' }).click()
  await expect(reopened.locator('.sidebar')).toContainText('User Service')
  await expect(reopened.locator('.sidebar')).toContainText('Get user 42')

  expect(rendererErrors, `renderer errors: ${rendererErrors.join(' | ')}`).toEqual([])
})
