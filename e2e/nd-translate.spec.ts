/// <reference lib="dom" />
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './fixtures.js'
import type { DesktopApi } from '../src/shared/contracts.js'
import { translatePageReadScript } from '../src/main/browser/translate-page-reader.js'

type NdWindow = typeof globalThis & { ndDsh: DesktopApi }

let launched: LaunchedApp
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => { launched = await launchApp() })
test.afterAll(async () => { if (launched) await closeApp(launched) })

test('ND Translate installs on demand and respects activation', async () => {
  const initial = await launched.page.evaluate(() => (globalThis as NdWindow).ndDsh.ndExtensions.state())
  expect(initial.packages.some((item) => item.id === 'nd.translate')).toBe(false)
  expect(initial.available?.find((item) => item.id === 'nd.translate')?.available).toBe(true)
  await launched.page.evaluate(() => (globalThis as NdWindow).ndDsh.ndExtensions.installAvailable('nd.translate'))
  await launched.page.evaluate(() => (globalThis as NdWindow).ndDsh.ndExtensions.setActivation('nd.translate', { kind: 'personal' }, true))
  const commands = await launched.page.evaluate(() => (globalThis as NdWindow).ndDsh.ndExtensions.commands({ kind: 'personal' }))
  expect(commands.some((item) => item.extensionId === 'nd.translate' && item.openViewId === 'translator')).toBe(true)
  await launched.page.evaluate(() => (globalThis as NdWindow).ndDsh.ndExtensions.setActivation('nd.translate', { kind: 'personal' }, false))
  const denied = await launched.page.evaluate(() => (globalThis as NdWindow).ndDsh.ndExtensions.invoke({
    extensionId: 'nd.translate', contributionId: 'translator', contributionKind: 'view',
    context: { kind: 'personal' }, caller: 'user', input: {},
  }))
  expect(denied.ok).toBe(false)
  await launched.page.evaluate(() => (globalThis as NdWindow).ndDsh.ndExtensions.setActivation('nd.translate', { kind: 'personal' }, true))
})

test('translator opens with three providers and handles input changes', async () => {
  await launched.page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
  const launcher = launched.page.getByRole('dialog', { name: 'ND Quick Launcher' })
  await launcher.getByPlaceholder('Search ND or type something to capture…').fill('Translate')
  await launcher.getByText('ND Translate', { exact: true }).click()
  const dialog = launched.page.getByRole('dialog').filter({ has: launched.page.getByLabel('Provider') })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Provider')).toHaveValue('google')
  await expect(dialog.getByLabel('Provider').locator('option')).toHaveCount(3)
  await expect(dialog.getByRole('button', { name: 'Translate', exact: true })).toBeDisabled()
  await dialog.getByLabel('Original text').fill('Hello')
  await expect(dialog.getByRole('button', { name: 'Translate', exact: true })).toBeEnabled()
  await dialog.getByLabel('Provider').selectOption('gemini')
  await expect(dialog.getByLabel('Provider')).toHaveValue('gemini')
  await dialog.screenshot({ path: 'test-results/nd-translate-view.png' })
})

test('Google Translate returns real text through the embedded browser', async () => {
  test.skip(process.env.ND_TRANSLATE_LIVE !== '1', 'Enable ND_TRANSLATE_LIVE=1 for the external provider smoke')
  test.setTimeout(90_000)
  const result = await launched.page.evaluate(() => (globalThis as NdWindow).ndDsh.ndExtensions.invoke({
    extensionId: 'nd.translate', contributionId: 'translator', contributionKind: 'view',
    context: { kind: 'personal' }, caller: 'user',
    input: { text: 'Hello world', sourceLanguage: 'en', targetLanguage: 'es', provider: 'google' },
  }))
  await test.info().attach('google-provider-result', { body: JSON.stringify(result), contentType: 'application/json' })
  if (result.ok && (result.value as { status?: string })?.status === 'error') {
    const page = await launched.app.evaluate(async ({ webContents }, script) => {
      const contents = webContents.getAllWebContents().find((item) => item.getURL().startsWith('https://translate.google.com/'))
      if (!contents) return { missing: true }
      return { observation: await contents.executeJavaScript(script), page: await contents.executeJavaScript(`({title:document.title,body:document.body.innerText.slice(-3000),readyState:document.readyState})`) }
    }, translatePageReadScript('google'))
    await test.info().attach('google-timeout-page', { body: JSON.stringify(page), contentType: 'application/json' })
  }
  expect(result.ok, JSON.stringify(result.error)).toBe(true)
  const value = result.value as { status: string; translatedText?: string; message?: string }
  expect(value.status, value.message).toBe('translated')
  expect(value.translatedText?.toLowerCase()).toContain('hola')
})

test('translation UI returns text and preserves the draft after inspecting its provider', async () => {
  test.skip(process.env.ND_TRANSLATE_LIVE !== '1', 'Enable ND_TRANSLATE_LIVE=1 for the external provider smoke')
  test.setTimeout(90_000)
  const dialog = launched.page.getByRole('dialog').filter({ has: launched.page.getByLabel('Provider') })
  await dialog.getByLabel('Provider').selectOption('google')
  await dialog.getByLabel('Source language').selectOption('en')
  await dialog.getByLabel('Target language').selectOption('es')
  await dialog.getByLabel('Original text').fill('Hello world')
  await dialog.getByRole('button', { name: 'Translate', exact: true }).click()
  await expect(dialog.getByLabel('Translation', { exact: true })).toHaveValue(/hola/i, { timeout: 40_000 })
  await expect(dialog.getByLabel('Original text')).toHaveValue('Hello world')
  await dialog.screenshot({ path: 'test-results/nd-translate-success.png' })
  await dialog.getByRole('button', { name: 'Open provider in ND browser' }).click()
  await expect(dialog).not.toBeVisible()
  const state = await launched.page.evaluate(() => (globalThis as NdWindow).ndDsh.browserPlatform.state())
  expect(state.selection).toMatchObject({ mode: 'tab', targetId: 'builtin' })
  await launched.page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
  const launcher = launched.page.getByRole('dialog', { name: 'ND Quick Launcher' })
  await launcher.getByPlaceholder('Search ND or type something to capture…').fill('Translate')
  await launcher.getByText('ND Translate', { exact: true }).click()
  await expect(dialog.getByLabel('Original text')).toHaveValue('Hello world')
  await expect(dialog.getByLabel('Source language')).toHaveValue('en')
  await expect(dialog.getByLabel('Target language')).toHaveValue('es')
  await expect(dialog.getByLabel('Translation', { exact: true })).toHaveValue('')
})

test('AI providers translate or report an explicit authentication barrier', async () => {
  test.skip(process.env.ND_TRANSLATE_AI_LIVE !== '1', 'Enable ND_TRANSLATE_AI_LIVE=1 for external AI provider smoke')
  test.setTimeout(90_000)
  for (const provider of ['chatgpt', 'gemini'] as const) {
    const result = await launched.page.evaluate((selectedProvider) => (globalThis as NdWindow).ndDsh.ndExtensions.invoke({
      extensionId: 'nd.translate', contributionId: 'translator', contributionKind: 'view',
      context: { kind: 'personal' }, caller: 'user',
      input: { text: 'Hello world', sourceLanguage: 'en', targetLanguage: 'es', provider: selectedProvider },
    }), provider)
    await test.info().attach(`${provider}-provider-result`, { body: JSON.stringify(result), contentType: 'application/json' })
    expect.soft(result.ok, `${provider}: ${JSON.stringify(result.error)}`).toBe(true)
    if (!result.ok) continue
    const value = result.value as { status: string; translatedText?: string; message?: string }
    console.log(`ND Translate ${provider}: ${value.status}`)
    if (value.status === 'error') {
      const diagnostic = await launched.app.evaluate(async ({ webContents }, { selected, script }) => {
        const origin = selected === 'chatgpt' ? 'https://chatgpt.com/' : 'https://gemini.google.com/'
        const contents = webContents.getAllWebContents().find((item) => item.getURL().startsWith(origin))
        if (!contents) return { missing: true }
        return {
          observation: await contents.executeJavaScript(script),
          responseAncestors: await contents.executeJavaScript(`Array.from(document.querySelectorAll('p')).filter(e=>/hola mundo/i.test(e.innerText)).slice(0,3).map(e=>{const rows=[];for(let i=0;e&&i<8;i++,e=e.parentElement)rows.push({tag:e.tagName,class:e.className,attrs:Array.from(e.attributes).filter(a=>/^(data-|role)/.test(a.name)).map(a=>[a.name,a.value]),width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,display:getComputedStyle(e).display,visibility:getComputedStyle(e).visibility,buttons:Array.from(e.querySelectorAll('button')).slice(0,10).map(b=>({label:b.getAttribute('aria-label'),testid:b.getAttribute('data-testid'),width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height}))});return rows})`),
          structure: await contents.executeJavaScript(`({title:document.title,body:document.body.innerText.slice(-4000),turns:Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]')).slice(-3).map(e=>({role:e.getAttribute('data-turn'),author:e.getAttribute('data-message-author-role'),text:e.innerText.slice(0,600),content:Array.from(e.querySelectorAll('.markdown,[data-message-content],[class~="prose"],button[data-testid="copy-turn-action-button"]')).map(c=>({tag:c.tagName,testid:c.getAttribute('data-testid'),width:c.getBoundingClientRect().width,height:c.getBoundingClientRect().height,display:getComputedStyle(c).display,visibility:getComputedStyle(c).visibility,text:c.innerText.slice(0,200)}))})),controls:Array.from(document.querySelectorAll('button,input,[role="dialog"],dialog')).map(e=>({tag:e.tagName,role:e.getAttribute('role'),type:e.getAttribute('type'),label:e.getAttribute('aria-label'),testid:e.getAttribute('data-testid'),text:e.innerText?.slice(0,100),visible:e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0})).slice(-30)})`),
        }
      }, { selected: provider, script: translatePageReadScript(provider) })
      await test.info().attach(`${provider}-timeout-page`, { body: JSON.stringify(diagnostic), contentType: 'application/json' })
    }
    expect.soft(['translated', 'login-required', 'challenge'], `${provider}: ${value.message}`).toContain(value.status)
    if (value.status === 'translated') expect.soft(value.translatedText?.toLowerCase(), provider).toContain('hola')
    else expect.soft(value.message, provider).toBeTruthy()
  }
})
