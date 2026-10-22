/// <reference lib="dom" />

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { GeminiWebEngine } from '../src/main/engines/gemini-web/gemini-web-engine.js'
import { closeApp, launchApp, serveFakeOrigin, type LaunchedApp } from './fixtures.js'

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

test('links, persists, and clears a Gemini skill from the chat panel', async () => {
  const { page } = launched
  const geminiOption = page.getByRole('option', { name: 'Gemini Web', exact: true })
  if (!(await geminiOption.isVisible().catch(() => false))) {
    await page.getByRole('combobox', { name: 'Coding engine' }).click()
  }
  await geminiOption.click()
  await expect(page.getByText('Gemini Skill:')).toBeVisible()
  await expect(page.getByText('No skill linked')).toBeVisible()

  await page.getByRole('button', { name: 'Link Skill' }).click()
  const dialog = page.getByRole('dialog', { name: 'Link Gemini Skill' })
  await expect(dialog).toBeVisible()
  await dialog.getByPlaceholder(/gemini\.google\.com\/app/).fill('https://gemini.google.com/app/e2eSkillChat1')
  await dialog.getByRole('button', { name: 'Save Skill Link' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('e2eSkillChat1', { exact: true })).toBeVisible()
  await expect(page.getByText('No skill linked')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Open in Gemini' })).toBeVisible()

  // Main-process state must agree with what the renderer shows.
  const stored = await page.evaluate(() => (window as unknown as {
    ndDsh: { geminiWeb: { getGemBinding(root?: string): Promise<{ gemUrl: string } | null> } }
  }).ndDsh.geminiWeb.getGemBinding())
  expect(stored?.gemUrl).toBe('https://gemini.google.com/app/e2eSkillChat1')

  await page.getByRole('button', { name: 'Change' }).click()
  await page.getByRole('dialog', { name: 'Link Gemini Skill' }).getByRole('button', { name: 'Clear Skill' }).click()
  await expect(page.getByText('No skill linked')).toBeVisible()
  expect(rendererErrors).toEqual([])
})

test('ND chat round-trips a prompt through Gemini Web and renders the reply', async () => {
  const { page, app } = launched
  const fakeGeminiHtml = `<!doctype html><main><form><rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea><button type="submit" disabled aria-label="Send message">Send</button></form>
      <button type="button" data-test-id="bard-mode-menu-button" aria-label="Open mode picker, currently Flash">Flash</button></main>
      <script>
        const form = document.querySelector('form');
        const editor = form.querySelector('[contenteditable]');
        const main = document.querySelector('main');
        const modelButton = document.querySelector('[data-test-id="bard-mode-menu-button"]');
        const models = [
          { id: '3.8 Flash', description: 'All-around help' },
          { id: '3.1 Pro', description: 'Advanced reasoning' },
        ];
        let selectedModel = '3.8 Flash';
        const closeModelMenu = () => document.querySelector('gem-menu')?.remove();
        modelButton.addEventListener('click', () => {
          if (document.querySelector('gem-menu')) return;
          const menu = document.createElement('gem-menu');
          menu.setAttribute('role', 'menu');
          menu.setAttribute('data-test-id', 'gem-mode-menu');
          for (const model of models) {
            const item = document.createElement('gem-menu-item');
            item.setAttribute('role', 'menuitem');
            item.setAttribute('data-mode-id', model.id.replace(/\\W+/g, '-'));
            item.setAttribute('data-test-id', 'bard-mode-option-' + model.id.replace(/\\W+/g, '-'));
            if (model.id === selectedModel) item.classList.add('selected');
            item.innerHTML = '<div class="label-container"><span class="label">' + model.id + '</span><div class="sublabel">' + model.description + '</div></div>';
            item.addEventListener('click', () => {
              selectedModel = model.id;
              document.body.dataset.model = model.id;
              modelButton.textContent = model.id.endsWith('Pro') ? 'Pro' : 'Flash';
              modelButton.setAttribute('aria-label', 'Open mode picker, currently ' + modelButton.textContent);
              closeModelMenu();
            });
            menu.appendChild(item);
          }
          document.body.appendChild(menu);
        });
        document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModelMenu(); });
        editor.addEventListener('input', () => { form.querySelector('button').disabled = !editor.textContent; });
        form.addEventListener('submit', event => {
          event.preventDefault();
          const prompt = editor.textContent;
          main.insertAdjacentHTML('afterbegin', '<user-query-content><div class="query-text-content"><div class="markdown"><p>' + prompt + '</p></div></div></user-query-content>');
          setTimeout(() => main.insertAdjacentHTML('beforeend', '<model-response-content><message-content><div class="markdown"><p>ND_GEMINI_E2E_REPLY: ' + prompt + '</p></div></message-content><button aria-label="Copy"></button></model-response-content>'), 400);
        });
      </script>`
  // Serve the real Gemini origin from the fixed page: no Google login in CI.
  await serveFakeOrigin(app, 'gemini.google.com', fakeGeminiHtml)

  await page.evaluate(() => (window as unknown as { ndDsh: { geminiWeb: { setGemBinding(root: string, input: string): Promise<unknown> } } }).ndDsh.geminiWeb.setGemBinding('', 'https://gemini.google.com/app/e2eChatLink9'))
  const textarea = page.locator('aside', { hasText: 'Gemini Skill:' }).locator('textarea').last()
  await expect(textarea).toBeVisible()
  await textarea.fill('Say hello from the e2e')
  await textarea.press('Enter')
  await expect(page.getByText('ND_GEMINI_E2E_REPLY: Say hello from the e2e').first()).toBeVisible({ timeout: 60_000 })
  // ND opened the bound skill chat, not the default Gemini home.
  await expect.poll(async () => app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().some((contents) => contents.getURL().includes('/app/e2eChatLink9')))).toBe(true)

  // Model support reads Gemini's own menu and pins the choice for the chat.
  const modelButton = page.getByRole('button', { name: 'Gemini Web model' })
  await expect(modelButton).toBeVisible()
  await modelButton.click()
  await page.getByRole('menuitemradio', { name: '3.1 Pro' }).click()
  await expect(modelButton).toContainText('3.1 Pro')
  await textarea.fill('Use the pro model')
  await textarea.press('Enter')
  await expect(page.getByText('ND_GEMINI_E2E_REPLY: Use the pro model').first()).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.getURL().startsWith('https://gemini.google.com')) continue
      const model = await contents.executeJavaScript('document.body.dataset.model || ""', true).catch(() => '')
      if (model) return model
    }
    return ''
  })).toBe('3.1 Pro')
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