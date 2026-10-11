import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NdTranslateService, translateRequest, translationUrl, type TranslateBrowserPort } from '../src/main/extensions/translate-service.js'
import { ND_TRANSLATE_MAX_TEXT } from '../src/shared/nd-translate.js'
import { manifestPermissionIssues, validateNdExtensionManifest } from '../src/shared/extension-package.js'
import { BUILTIN_EXTENSION_PACKAGES } from '../src/shared/builtin-extension-packages.js'

function browser() {
  let url = ''
  let sent = false
  const port: TranslateBrowserPort = {
    createTab: vi.fn(async (target) => { url = target; return { id: 'translation-tab' } }),
    navigate: vi.fn(async (target) => { url = target; return undefined }),
    semanticSnapshot: vi.fn(async () => ({ url, revision: 1, elements: [
      { ref: '@input', tag: 'textarea', role: 'textbox' },
      { ref: '@send', role: 'button', name: 'Send message' },
    ] })),
    fill: vi.fn(async () => ({ ok: true })),
    click: vi.fn(async () => { sent = true; return { ok: true } }),
    readTranslatePage: vi.fn(async () => ({ url, text: url.includes('translate.google.com') || sent ? 'សួស្តី' : '', complete: sent })),
    attachTabForBackgroundRendering: vi.fn(() => () => undefined),
  }
  return port
}

const input = { text: 'Hello', sourceLanguage: 'auto', targetLanguage: 'km', provider: 'google' }
afterEach(() => vi.useRealTimers())

describe('ND Translate input and extension boundary', () => {
  it('installs on demand with only browser and history permissions and no executable runtime', () => {
    const raw = JSON.parse(readFileSync(new URL('../extensions/translate/nd-extension.json', import.meta.url), 'utf8'))
    const validated = validateNdExtensionManifest(raw)
    expect(validated.ok).toBe(true)
    if (!validated.ok) throw new Error('Invalid translation manifest')
    expect(manifestPermissionIssues(validated.manifest)).toEqual([])
    expect(validated.manifest.permissions).toEqual(['browser.navigate', 'translate.history'])
    expect(validated.manifest.executable).toBeUndefined()
    expect(validated.manifest.contributions.commands[0]).toMatchObject({ id: 'translate', host: 'browser.translate', openViewId: 'translator' })
    expect(validated.manifest.contributions.views[0]?.actions).toEqual([
      { id: 'history', title: 'Translation history', host: 'browser.translate.history' },
      { id: 'clear-history', title: 'Clear translation history', host: 'browser.translate.history.clear' },
    ])
    expect(BUILTIN_EXTENSION_PACKAGES.some((item) => item.id === 'nd.translate')).toBe(false)
  })

  it('validates provider, languages, target, text type and length before opening a browser', () => {
    for (const patch of [ { provider: 'other' }, { provider: 'llm:' }, { sourceLanguage: 'evil' }, { targetLanguage: 'auto' }, { text: 42 }, { text: 'x'.repeat(ND_TRANSLATE_MAX_TEXT + 1) } ]) {
      expect(() => translateRequest({ ...input, ...patch })).toThrow()
    }
    expect(translateRequest({})).toEqual({ text: '', sourceLanguage: 'auto', targetLanguage: 'km', provider: 'google' })
    expect(translateRequest({ ...input, provider: 'llm:deepseek', model: ' deepseek-v4-flash ' })).toEqual({ ...input, provider: 'llm:deepseek', model: 'deepseek-v4-flash' })
  })

  it('keeps LLM providers out of the browser workflow and URL routes', async () => {
    const request = translateRequest({ ...input, provider: 'llm:deepseek' })
    expect(() => translationUrl(request)).toThrow('directly by ND')
    await expect(new NdTranslateService(browser()).translate({ ...input, provider: 'llm:deepseek' })).resolves.toMatchObject({
      status: 'error', message: expect.stringContaining('ND Settings'),
    })
  })

  it('validates pasted image data URLs and rejects them in the browser workflow', async () => {
    const image = 'data:image/png;base64,QUJD'
    expect(translateRequest({ ...input, images: [image] }).images).toEqual([image])
    for (const images of [ ['https://example.com/a.png'], [image, image, image, image], ['data:image/png;base64,QUJD'.repeat(1_000_000)] ]) {
      expect(() => translateRequest({ ...input, images })).toThrow()
    }
    await expect(new NdTranslateService(browser()).translate({ ...input, images: [image] })).resolves.toMatchObject({
      status: 'error', message: expect.stringContaining('LLM providers'),
    })
    expect(await new NdTranslateService(browser()).translate({ ...input, text: '', images: [image] })).toMatchObject({
      status: 'error', message: expect.stringContaining('LLM providers'),
    })
  })

  it('encodes submitted content as URL data and keeps an allowlisted HTTPS origin', () => {
    const request = translateRequest({ ...input, text: "a&tl=ru#<script>💙\n ' quote" })
    const url = new URL(translationUrl(request))
    expect(url.origin).toBe('https://translate.google.com')
    expect(url.searchParams.get('text')).toBe(request.text)
    expect(url.searchParams.get('tl')).toBe('km')
    expect(url.hash).toBe('')
  })
})

describe('ND Translate canonical browser workflow', () => {
  it('returns idle without navigation when opening the extension view', async () => {
    const port = browser()
    expect(await new NdTranslateService(port).translate({})).toMatchObject({ status: 'idle', provider: 'google' })
    expect(port.createTab).not.toHaveBeenCalled()
  })

  it('returns an observed stable translation preserving the exact source and owned tab', async () => {
    vi.useFakeTimers()
    const port = browser()
    const pending = new NdTranslateService(port, 100, 1).translate({ ...input, text: ' Hello\n' })
    await vi.advanceTimersByTimeAsync(10)
    expect(await pending).toMatchObject({ status: 'translated', text: ' Hello\n', translatedText: 'សួស្តី', browserTabId: 'translation-tab' })
    expect(port.createTab).toHaveBeenCalledWith('about:blank', true)
    expect(port.navigate).toHaveBeenCalledWith(expect.stringContaining('translate.google.com'), 'translation-tab')
    expect(port.fill).not.toHaveBeenCalled()
  })

  it('keeps the owned tab attached for background rendering and restores it when finished', async () => {
    vi.useFakeTimers()
    const port = browser()
    const restore = vi.fn()
    vi.mocked(port.attachTabForBackgroundRendering).mockReturnValue(restore)
    const pending = new NdTranslateService(port, 100, 1).translate(input)
    await vi.advanceTimersByTimeAsync(10)
    expect(await pending).toMatchObject({ status: 'translated' })
    expect(port.attachTabForBackgroundRendering).toHaveBeenCalledWith('translation-tab')
    expect(port.attachTabForBackgroundRendering).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it.each(['chatgpt', 'gemini'])('submits %s through semantic fill and click, then waits for a completed response', async (provider) => {
    vi.useFakeTimers()
    const port = browser()
    const pending = new NdTranslateService(port, 100, 1).translate({ ...input, provider })
    await vi.advanceTimersByTimeAsync(15)
    expect(await pending).toMatchObject({ status: 'translated', translatedText: 'សួស្តី' })
    expect(port.fill).toHaveBeenCalledWith('translation-tab', '@input', 1, expect.stringContaining('Hello'))
    expect(port.click).toHaveBeenCalledWith('translation-tab', '@send', 1)
  })

  it.each(['chatgpt', 'gemini'])('skips attachment, password and search inputs before the %s composer', async (provider) => {
    vi.useFakeTimers()
    const port = browser()
    vi.mocked(port.semanticSnapshot).mockImplementation(async () => ({
      url: provider === 'chatgpt' ? 'https://chatgpt.com/' : 'https://gemini.google.com/app',
      revision: 1,
      elements: [
        { ref: '@file', tag: 'input', type: 'file', role: 'textbox', editable: true },
        { ref: '@password', tag: 'input', type: 'password', role: 'textbox', sensitive: true },
        { ref: '@search', tag: 'input', type: 'search', role: 'textbox' },
        { ref: '@composer', tag: 'div', role: 'textbox', editable: true },
        { ref: '@send', role: 'button', name: 'Send message' },
      ],
    }))
    const pending = new NdTranslateService(port, 100, 1).translate({ ...input, provider })
    await vi.advanceTimersByTimeAsync(15)
    expect(await pending).toMatchObject({ status: 'translated' })
    expect(port.fill).toHaveBeenCalledWith('translation-tab', '@composer', 1, expect.stringContaining('Hello'))
    expect(port.fill).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ loginRequired: true }, 'login-required'],
    [{ challenge: true }, 'challenge'],
    [{ error: 'Output too long' }, 'error'],
    [{ url: 'https://attacker.example/' }, 'error'],
  ] as const)('reports provider state %j without inventing translation', async (page, status) => {
    const port = browser()
    vi.mocked(port.readTranslatePage).mockResolvedValue({ url: translationUrl(translateRequest(input)), ...page })
    const result = await new NdTranslateService(port, 100, 1).translate(input)
    expect(result.status).toBe(status)
    expect(result.translatedText).toBeUndefined()
  })

  it('rejects source/target changes within Google Translate instead of attributing old results', async () => {
    const port = browser()
    vi.mocked(port.readTranslatePage).mockResolvedValue({ url: 'https://translate.google.com/?sl=auto&tl=en&text=Other', text: 'Other' })
    expect(await new NdTranslateService(port).translate(input)).toMatchObject({ status: 'error', message: expect.stringContaining('input changed') })
  })

  it('rejects a restored assistant response before filling a new prompt', async () => {
    const port = browser()
    vi.mocked(port.readTranslatePage).mockResolvedValue({ url: 'https://chatgpt.com/', text: 'Old answer' })
    expect(await new NdTranslateService(port).translate({ ...input, provider: 'chatgpt' })).toMatchObject({ status: 'error', message: expect.stringContaining('already contains') })
    expect(port.fill).not.toHaveBeenCalled()
  })

  it('prevents parallel requests from changing a shared provider tab', async () => {
    vi.useFakeTimers()
    const port = browser()
    const service = new NdTranslateService(port, 100, 1)
    const first = service.translate(input)
    expect(await service.translate(input)).toMatchObject({ status: 'busy' })
    expect(port.createTab).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10)
    expect((await first).status).toBe('translated')
  })

  it('does not declare a streaming response successful and terminates within the deadline', async () => {
    vi.useFakeTimers()
    const port = browser()
    vi.mocked(port.readTranslatePage).mockResolvedValue({ url: translationUrl(translateRequest(input)), text: 'Partial', pending: true })
    const pending = new NdTranslateService(port, 20, 1).translate(input)
    await vi.advanceTimersByTimeAsync(25)
    expect(await pending).toMatchObject({ status: 'error', message: expect.stringContaining('timed out') })
    expect((await pending).translatedText).toBeUndefined()
  })

  it('does not declare stable AI text complete without a provider completion action', async () => {
    vi.useFakeTimers()
    const port = browser()
    let submitted = false
    vi.mocked(port.click).mockImplementation(async () => { submitted = true; return { ok: true } })
    vi.mocked(port.readTranslatePage).mockImplementation(async () => ({ url: 'https://gemini.google.com/app', text: submitted ? 'Partial answer' : '', pending: false, complete: false }))
    const pending = new NdTranslateService(port, 20, 1).translate({ ...input, provider: 'gemini' })
    await vi.advanceTimersByTimeAsync(25)
    expect(await pending).toMatchObject({ status: 'error', message: expect.stringContaining('timed out') })
    expect((await pending).translatedText).toBeUndefined()
  })

  it('cancels late tab creation on disposal without filling or clicking', async () => {
    const port = browser()
    let resolveTab!: (tab: { id: string }) => void
    vi.mocked(port.createTab).mockImplementation(() => new Promise((resolve) => { resolveTab = resolve }))
    const service = new NdTranslateService(port)
    const pending = service.translate({ ...input, provider: 'chatgpt' })
    service.dispose()
    expect(await pending).toMatchObject({ status: 'error' })
    resolveTab({ id: 'late-tab' })
    await Promise.resolve()
    expect(port.readTranslatePage).not.toHaveBeenCalled()
    expect(port.fill).not.toHaveBeenCalled()
    expect(await service.translate(input)).toMatchObject({ status: 'error', message: expect.stringContaining('shutting down') })
  })

  it('stops after a fill that resolves beyond its deadline', async () => {
    vi.useFakeTimers()
    const port = browser()
    let finishFill!: (value: unknown) => void
    vi.mocked(port.fill).mockImplementation(() => new Promise((resolve) => { finishFill = resolve }))
    const pending = new NdTranslateService(port, 20, 1).translate({ ...input, provider: 'chatgpt' })
    await vi.advanceTimersByTimeAsync(25)
    expect(await pending).toMatchObject({ status: 'error' })
    finishFill({ ok: true })
    await vi.advanceTimersByTimeAsync(5)
    expect(port.click).not.toHaveBeenCalled()
  })

  it('refreshes a stale editor reference before retrying without duplicate submission', async () => {
    vi.useFakeTimers()
    const port = browser()
    vi.mocked(port.fill).mockRejectedValueOnce(Object.assign(new Error('Page changed'), { code: 'STALE_BROWSER_REFERENCE' }))
    const pending = new NdTranslateService(port, 100, 1).translate({ ...input, provider: 'chatgpt' })
    await vi.advanceTimersByTimeAsync(15)
    expect(await pending).toMatchObject({ status: 'translated' })
    expect(port.fill).toHaveBeenCalledTimes(2)
    expect(port.click).toHaveBeenCalledTimes(1)
  })

  it('stops observing after a click that resolves beyond its deadline', async () => {
    vi.useFakeTimers()
    const port = browser()
    let finishClick!: (value: unknown) => void
    vi.mocked(port.click).mockImplementation(() => new Promise((resolve) => { finishClick = resolve }))
    const pending = new NdTranslateService(port, 20, 1).translate({ ...input, provider: 'gemini' })
    await vi.advanceTimersByTimeAsync(25)
    expect(await pending).toMatchObject({ status: 'error' })
    const observations = vi.mocked(port.readTranslatePage).mock.calls.length
    finishClick({ ok: true })
    await vi.advanceTimersByTimeAsync(5)
    expect(port.readTranslatePage).toHaveBeenCalledTimes(observations)
    expect(port.click).toHaveBeenCalledTimes(1)
  })
})
