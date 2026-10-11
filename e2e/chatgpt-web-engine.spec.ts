/// <reference lib="dom" />

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ChatGptWebEngine } from '../src/main/engines/chatgpt-web/chatgpt-web-engine.js'
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

test('interactive chat picker exposes ChatGPT Web without requiring DSH gateway readiness', async () => {
  const { page } = launched
  const enginePicker = page.getByRole('combobox', { name: 'Coding engine' })
  await expect(enginePicker).toBeVisible()
  await enginePicker.click()

  const chatGptOption = page.getByRole('option', { name: 'ChatGPT Web', exact: true })
  await expect(chatGptOption).toBeVisible()
  await expect(chatGptOption).toBeEnabled()
  expect(rendererErrors).toEqual([])
})

for (const [name, markup] of [
  ['project ProseMirror', '<div class="ProseMirror" contenteditable="true" role="textbox"></div>'],
  ['plaintext ProseMirror', '<div class="ProseMirror" contenteditable="plaintext-only" role="textbox"></div>'],
  ['legacy textarea', '<textarea id="prompt-textarea"></textarea>'],
  ['legacy Lexical', '<div contenteditable="true" data-lexical-editor="true"></div>'],
] as const) {
  test(`detects and sends through the ${name} composer in ND's built-in browser`, async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><main><form>${markup}<button type="submit" disabled>Send</button></form></main>
        <script>
          const form = document.querySelector('form');
          const editor = form.querySelector('textarea, [contenteditable]');
          editor.addEventListener('input', () => { form.querySelector('button').disabled = false; });
          form.addEventListener('submit', event => {
            event.preventDefault();
            document.body.dataset.sent = editor.value ?? editor.textContent;
          });
        </script>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/composer`
    const engine = new ChatGptWebEngine({ browser: {} as never, workspace: {} as never,
      git: {} as never, storePath: join(launched.userDataDir, 'composer-test-sessions.json') })
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
      await internals.submitPrompt(cdp, 'ND composer regression check', new AbortController().signal)
      expect(await cdp.evaluate<string>('document.body.dataset.sent')).toBe('ND composer regression check')
      // Current ChatGPT turns expose accessible headings without either of
      // the historical data attributes. The reply must still reach ND.
      await cdp.evaluate(`(() => {
        const main = document.querySelector('main');
        const conversation = document.createElement('div');
        conversation.innerHTML = '<div><h5 hidden>You said:</h5><div>ND composer regression check</div></div>'
          + '<div><h6 hidden>ChatGPT said:</h6><div class="MarkdownRoot-current"><p>ND_CHATGPT_WEB_OK</p></div><button aria-label="Copy"></button></div>';
        main.prepend(conversation);
      })()`)
      expect(await internals.captureSnapshot(cdp)).toMatchObject({
        busy: false, complete: true,
        turns: [{ role: 'user', text: 'ND composer regression check' }, { role: 'assistant', text: 'ND_CHATGPT_WEB_OK' }],
      })
      await cdp.evaluate(`document.querySelector('form').insertAdjacentHTML('beforeend', '<button type="button" aria-label="Stop streaming"></button>')`)
      expect(await internals.captureSnapshot(cdp)).toMatchObject({ busy: true })
    } finally {
      await engine.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}
