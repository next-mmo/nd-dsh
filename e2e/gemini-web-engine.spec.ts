/// <reference lib="dom" />

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { GeminiWebEngine } from '../src/main/engines/gemini-web/gemini-web-engine.js'
import { closeApp, launchApp, type LaunchedApp } from './fixtures.js'

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

test('interactive chat picker exposes Gemini Web without requiring DSH gateway readiness', async () => {
  const { page } = launched
  const enginePicker = page.getByRole('combobox', { name: 'Coding engine' })
  await expect(enginePicker).toBeVisible()
  await enginePicker.click()

  const geminiOption = page.getByRole('option', { name: 'Gemini Web', exact: true })
  await expect(geminiOption).toBeVisible()
  await expect(geminiOption).toBeEnabled()
  expect(rendererErrors).toEqual([])
})

test('detects and sends through the Gemini composer in ND\'s built-in browser', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><main><form><rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea><button type="submit" disabled aria-label="Send message">Send</button></form></main>
      <script>
        const form = document.querySelector('form');
        const editor = form.querySelector('[contenteditable]');
        editor.addEventListener('input', () => { form.querySelector('button').disabled = false; });
        form.addEventListener('submit', event => {
          event.preventDefault();
          document.body.dataset.sent = editor.textContent;
        });
      </script>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/gemini-composer`
  const engine = new GeminiWebEngine({ browser: {} as never, workspace: {} as never, storePath: join(launched.userDataDir, 'gemini-composer-test-sessions.json') })
  const cdp = {
    evaluate: <T>(expression: string): Promise<T> => launched.app.evaluate(async ({ webContents }, input) => {
      const target = webContents.getAllWebContents().find((contents) => contents.getURL() === input.url)
      if (!target) throw new Error('ND built-in browser fixture is unavailable')
      return target.executeJavaScript(input.expression, true)
    }, { url, expression }) as Promise<T>,
  }
  const internals = engine as unknown as {
    captureSnapshot(connection: typeof cdp): Promise<{ composer: boolean }>
    submitPrompt(connection: typeof cdp, prompt: string, signal: AbortSignal): Promise<void>
  }
  try {
    await launched.page.evaluate((targetUrl) => (window as unknown as {
      ndDsh: { browser: { navigate(url: string): Promise<unknown> } }
    }).ndDsh.browser.navigate(targetUrl), url)
    await expect.poll(async () => launched.app.evaluate(({ webContents }, targetUrl) =>
      webContents.getAllWebContents().some((contents) => contents.getURL() === targetUrl && !contents.isLoading()), url)).toBe(true)
    expect((await internals.captureSnapshot(cdp)).composer).toBe(true)
    await internals.submitPrompt(cdp, 'ND gemini composer regression check', new AbortController().signal)
    expect(await cdp.evaluate<string>('document.body.dataset.sent')).toBe('ND gemini composer regression check')
    // Gemini turns are captured through user-query-content / model-response-content.
    await cdp.evaluate(`(() => {
      const main = document.querySelector('main');
      main.insertAdjacentHTML('afterbegin', '<user-query-content><div class="query-text-content"><div class="markdown"><p>ND gemini composer regression check</p></div></div></user-query-content>'
        + '<model-response-content><message-content><div class="markdown"><p>ND_GEMINI_WEB_OK</p></div></message-content><button aria-label="Copy"></button></model-response-content>');
    })()`)
    expect(await internals.captureSnapshot(cdp)).toMatchObject({
      busy: false, complete: true,
      turns: [{ role: 'user', text: 'ND gemini composer regression check' }, { role: 'assistant', text: 'ND_GEMINI_WEB_OK' }],
    })
    await cdp.evaluate(`document.querySelector('main').insertAdjacentHTML('beforeend', '<button aria-label="Stop"></button>')`)
    expect(await internals.captureSnapshot(cdp)).toMatchObject({ busy: true })
  } finally {
    await engine.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
