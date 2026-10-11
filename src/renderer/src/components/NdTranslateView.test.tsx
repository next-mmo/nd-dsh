import type { ReactElement, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NdInvocationResult } from '../../../shared/nd-invocations'
import type { ModelProvider } from '../../../shared/contracts'

// Drive the actual form handlers without adding a DOM dependency to the app.
// Hooks are keyed per component instance (path through the element tree) so
// conditionally mounted children keep their own state, like real React.
const hooks = vi.hoisted(() => ({
  stack: [] as string[],
  local: new Map<string, number>(),
  store: new Map<string, unknown>(),
  mounted: new Set<string>(),
  effects: new Map<string, () => void>(),
  generation: 1,
  cleanup: null as (() => void) | null,
  slot(instance: string, allocate = true): { key: string; index: number } {
    const index = this.local.get(instance) ?? 0
    if (allocate) this.local.set(instance, index + 1)
    return { key: `${this.generation}:${instance}:${index}`, index }
  },
  enter(instance: string): void {
    this.stack.push(instance)
    this.local.set(instance, 0)
  },
  exit(): void {
    this.stack.pop()
  },
  reset(): void {
    this.generation += 1
    this.store.clear()
    this.mounted.clear()
    this.effects.clear()
    this.local.clear()
    this.stack = []
  },
}))
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useId: () => 'translate',
  useState: (initial: unknown) => {
    const { key } = hooks.slot(hooks.stack[hooks.stack.length - 1] ?? 'root')
    if (!hooks.store.has(key)) hooks.store.set(key, typeof initial === 'function' ? initial() : initial)
    return [hooks.store.get(key), (next: unknown) => {
      hooks.store.set(key, typeof next === 'function' ? (next as (previous: unknown) => unknown)(hooks.store.get(key)) : next)
    }]
  },
  useRef: (initial: unknown) => {
    const { key } = hooks.slot(hooks.stack[hooks.stack.length - 1] ?? 'root')
    if (!hooks.store.has(key)) hooks.store.set(key, { current: initial })
    return hooks.store.get(key)
  },
  useEffect: (effect: () => (() => void) | void) => {
    const { key } = hooks.slot(hooks.stack[hooks.stack.length - 1] ?? 'root')
    if (hooks.mounted.has(key)) return
    hooks.mounted.add(key)
    const cleanupFn = effect()
    if (typeof cleanupFn === 'function') hooks.effects.set(key, cleanupFn)
    hooks.cleanup = () => {
      for (const cleanup of hooks.effects.values()) cleanup()
      hooks.effects.clear()
      hooks.mounted.clear()
    }
  },
}))
import NdTranslateView from './NdTranslateView'

type TestElement = ReactElement<Record<string, unknown>>
function elements(node: ReactNode, path = 'root'): TestElement[] {
  if (Array.isArray(node)) return node.flatMap((child, index) => elements(child, `${path}.${index}`))
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const item = node as TestElement
  const type = item.type as unknown
  const identity = typeof item.key === 'string' && item.key ? `${path}@${item.key}` : path
  if (typeof type === 'function') {
    hooks.enter(identity)
    let rendered: ReactNode
    try {
      rendered = (type as (props: Record<string, unknown>) => ReactNode)(item.props)
    } finally {
      hooks.exit()
    }
    return [item, ...elements(rendered, identity)]
  }
  return [item, ...elements(item.props.children as ReactNode, identity)]
}
function render(): TestElement {
  hooks.enter('root')
  try {
    return NdTranslateView({ context: { kind: 'personal' }, onOpenBrowser }) as TestElement
  } finally {
    hooks.exit()
  }
}
function field(id: string): TestElement {
  const item = elements(render()).find((element) => typeof element.type === 'string' && element.props.id === `translate-${id}`)
  if (!item) throw new Error(`Missing form field: ${id}`)
  return item
}
function change(id: string, value: string): void {
  ;(field(id).props.onChange as (event: unknown) => void)({ target: { value } })
}
async function submit(): Promise<void> {
  const form = elements(render()).find((element) => element.type === 'form')
  if (!form) throw new Error('Missing translate form')
  ;(form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} })
  await Promise.resolve()
  await Promise.resolve()
}
function deferred(): { promise: Promise<NdInvocationResult>; resolve(result: NdInvocationResult): void } {
  let resolve!: (result: NdInvocationResult) => void
  const promise = new Promise<NdInvocationResult>((done) => { resolve = done })
  return { promise, resolve }
}
function message(): string {
  return String(elements(render()).find((element) => element.props.role === 'alert')?.props.children ?? '')
}
function button(label: string): TestElement {
  const item = elements(render()).find((element) => element.props['aria-label'] === label
    || (Array.isArray(element.props.children) && element.props.children.includes(label)))
  if (!item) throw new Error(`Missing button: ${label}`)
  return item
}

const invoke = vi.fn<(request: unknown) => Promise<NdInvocationResult>>()
const onOpenBrowser = vi.fn<(tabId: string) => Promise<void>>()
const providersList = vi.fn<() => Promise<ModelProvider[]>>()
const providersChanged = vi.fn<(listener: (providers: ModelProvider[]) => void) => () => void>()
beforeEach(() => {
  hooks.reset()
  hooks.cleanup = null
  invoke.mockReset()
  onOpenBrowser.mockReset()
  providersList.mockReset().mockResolvedValue([])
  providersChanged.mockReset().mockReturnValue(() => undefined)
  vi.stubGlobal('window', { ndDsh: { ndExtensions: { invoke }, providers: { list: providersList, onChanged: providersChanged } } })
})
afterEach(() => {
  hooks.cleanup?.()
  vi.unstubAllGlobals()
})

describe('ND Translate form', () => {
  it('defaults to Google and sends the exact source only through the installed view broker', async () => {
    invoke.mockResolvedValue({ ok: true, value: { status: 'translated', translatedText: 'Hello' } })
    expect(field('provider').props.value).toBe('google')
    expect(field('source').props.value).toBe('auto')
    change('text', '  សួស្តី  ')
    await submit()
    expect(invoke).toHaveBeenCalledWith({ extensionId: 'nd.translate', contributionId: 'translator', contributionKind: 'view', caller: 'user', context: { kind: 'personal' }, input: { text: '  សួស្តី  ', sourceLanguage: 'auto', targetLanguage: 'km', provider: 'google' } })
    expect(field('text').props.value).toBe('  សួស្តី  ')
    expect(field('result').props.value).toBe('Hello')
  })

  it('prevents duplicate submissions while a provider request is pending', async () => {
    const pending = deferred()
    invoke.mockReturnValue(pending.promise)
    change('text', 'សួស្តី')
    await submit()
    await submit()
    expect(invoke).toHaveBeenCalledTimes(1)
    pending.resolve({ ok: true, value: { status: 'translated', translatedText: 'Hello' } })
    await pending.promise
  })

  it.each(['text', 'source', 'target', 'provider'])('discards a pending result when %s changes', async (id) => {
    const pending = deferred()
    invoke.mockReturnValue(pending.promise)
    change('text', 'សួស្តី')
    await submit()
    change(id, { text: 'អរគុណ', source: 'km', target: 'fr', provider: 'gemini' }[id]!)
    pending.resolve({ ok: true, value: { status: 'translated', translatedText: 'Hello' } })
    await pending.promise
    await Promise.resolve()
    expect(field('result').props.value).toBe('')
  })

  it('clears a previous translation when the source changes', async () => {
    invoke.mockResolvedValue({ ok: true, value: { status: 'translated', translatedText: 'Hello' } })
    change('text', 'សួស្តី')
    await submit()
    change('text', 'អរគុណ')
    expect(field('result').props.value).toBe('')
  })

  it.each(['login-required', 'challenge', 'error', 'busy'])('reports provider %s without presenting it as translated text', async (status) => {
    invoke.mockResolvedValue({ ok: true, value: { status, message: 'Provider action required' } })
    change('text', 'សួស្តី')
    await submit()
    expect(message()).toContain('Provider action required')
    expect(field('result').props.value).toBe('')
  })

  it('shows permission denials and rejects empty or malformed provider responses', async () => {
    change('text', 'សួស្តី')
    invoke.mockResolvedValue({ ok: false, error: { code: 'denied', message: 'Extension is disabled' } })
    await submit()
    expect(message()).toContain('Extension is disabled')
    invoke.mockResolvedValue({ ok: true, value: { status: 'translated', translatedText: '   ' } })
    await submit()
    expect(message()).toContain('did not return translated text')
    invoke.mockResolvedValue({ ok: true, value: { status: 'invented' } })
    await submit()
    expect(message()).toContain('invalid response')
  })

  it('does not contact a provider for blank or oversized input', async () => {
    change('text', '   ')
    await submit()
    change('text', 'a'.repeat(5001))
    await submit()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('swaps explicit languages and uses the translated text as the new original', async () => {
    invoke.mockResolvedValue({ ok: true, value: { status: 'translated', translatedText: 'Hello' } })
    expect(button('Swap languages').props.disabled).toBe(true)
    change('text', 'សួស្តី')
    change('source', 'en')
    await submit()
    ;(button('Swap languages').props.onClick as () => void)()
    expect(field('source').props.value).toBe('km')
    expect(field('target').props.value).toBe('en')
    expect(field('text').props.value).toBe('Hello')
    expect(field('result').props.value).toBe('')
  })

  it('copies only the current translated text and reports clipboard failure', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    invoke.mockResolvedValue({ ok: true, value: { status: 'translated', translatedText: 'Hello' } })
    change('text', 'សួស្តី')
    await submit()
    ;(button('Copy').props.onClick as () => void)()
    await Promise.resolve()
    expect(writeText).toHaveBeenCalledWith('Hello')
    expect(button('Copied')).toBeDefined()
    writeText.mockRejectedValue(new Error('clipboard unavailable'))
    ;(button('Copied').props.onClick as () => void)()
    await Promise.resolve()
    expect(message()).toContain('Clipboard access failed')
    change('text', 'អរគុណ')
    expect(button('Copy').props.disabled).toBe(true)
  })

  it('recovers after a rejected provider request', async () => {
    invoke.mockRejectedValueOnce(new Error('provider timeout'))
    change('text', 'សួស្តី')
    await submit()
    expect(message()).toContain('provider timeout')
    invoke.mockResolvedValue({ ok: true, value: { status: 'translated', translatedText: 'Hello' } })
    await submit()
    expect(field('result').props.value).toBe('Hello')
    expect(message()).toBe('')
  })

  it('ignores results that arrive after the view closes', async () => {
    const pending = deferred()
    invoke.mockReturnValue(pending.promise)
    change('text', 'សួស្តី')
    await submit()
    hooks.cleanup?.()
    pending.resolve({ ok: true, value: { status: 'translated', translatedText: 'Hello' } })
    await pending.promise
    await Promise.resolve()
    expect(field('result').props.value).toBe('')
  })

  it.each(['translated', 'login-required', 'challenge', 'error'])('opens the exact provider tab for %s results and keeps routing errors in the form', async (status) => {
    invoke.mockResolvedValue({ ok: true, value: { status, translatedText: 'Hello', browserTabId: 'owned-tab', url: 'https://untrusted.example/' } })
    onOpenBrowser.mockRejectedValue(new Error('Provider tab is no longer available'))
    change('text', 'សួស្តី')
    await submit()
    ;(button('Open provider in ND browser').props.onClick as () => void)()
    await Promise.resolve()
    expect(onOpenBrowser).toHaveBeenCalledWith('owned-tab')
    expect(message()).toContain('Provider tab is no longer available')
    expect(field('text').props.value).toBe('សួស្តី')
  })

  it('offers no browser route without a nonempty broker tab id and clears it when input changes', async () => {
    change('text', 'សួស្តី')
    invoke.mockResolvedValue({ ok: true, value: { status: 'error', browserTabId: ' ' } })
    await submit()
    expect(() => button('Open provider in ND browser')).toThrow('Missing button')
    invoke.mockResolvedValue({ ok: true, value: { status: 'error', browserTabId: 'owned-tab' } })
    await submit()
    expect(button('Open provider in ND browser')).toBeDefined()
    change('provider', 'gemini')
    expect(() => button('Open provider in ND browser')).toThrow('Missing button')
  })

  it('preserves source and preferences in memory after a successful browser route for sign-in', async () => {
    onOpenBrowser.mockResolvedValue(undefined)
    invoke.mockResolvedValue({ ok: true, value: { status: 'login-required', browserTabId: 'owned-tab' } })
    change('text', '  សួស្តី  ')
    change('source', 'km')
    change('target', 'fr')
    change('provider', 'chatgpt')
    await submit()
    ;(button('Open provider in ND browser').props.onClick as () => void)()
    await Promise.resolve()
    hooks.cleanup?.()
    hooks.reset()
    expect(field('text').props.value).toBe('  សួស្តី  ')
    expect(field('source').props.value).toBe('km')
    expect(field('target').props.value).toBe('fr')
    expect(field('provider').props.value).toBe('chatgpt')
    expect(field('result').props.value).toBe('')
    change('text', '') // Clear the in-memory draft for the next context opening.
  })

  it('locks source, preferences, swap, clear, and submissions until provider routing finishes', async () => {
    let finish!: () => void
    onOpenBrowser.mockReturnValue(new Promise<void>((resolve) => { finish = resolve }))
    invoke.mockResolvedValue({ ok: true, value: { status: 'translated', translatedText: 'Hello', browserTabId: 'owned-tab' } })
    change('text', 'សួស្តី')
    change('source', 'km')
    await submit()
    ;(button('Open provider in ND browser').props.onClick as () => void)()
    for (const id of ['text', 'provider', 'source', 'target']) expect(field(id).props.disabled).toBe(true)
    expect(button('Swap languages').props.disabled).toBe(true)
    expect(elements(render()).find((element) => element.props.children === 'Clear')?.props.disabled).toBe(true)
    change('text', 'changed during opening')
    change('provider', 'gemini')
    change('source', 'en')
    change('target', 'fr')
    ;(button('Swap languages').props.onClick as () => void)()
    await submit()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(field('text').props.value).toBe('សួស្តី')
    expect(field('source').props.value).toBe('km')
    expect(field('provider').props.value).toBe('google')
    expect(field('target').props.value).toBe('km')
    finish()
    await Promise.resolve()
    expect(field('text').props.disabled).toBe(false)
    change('text', '')
  })

  it('lists persisted translations in history mode and loads one back into the form', async () => {
    const entry = { id: 'h1', text: 'Hello', translatedText: 'សួស្តី', sourceLanguage: 'auto', targetLanguage: 'km', provider: 'google', createdAt: 1 }
    invoke.mockResolvedValue({ ok: true, value: [entry] })
    ;(button('History').props.onClick as () => void)()
    elements(render()) // Mount the history view so its load effect runs.
    await Promise.resolve()
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledWith({ extensionId: 'nd.translate', contributionId: 'translator', contributionKind: 'view', caller: 'user', context: { kind: 'personal' }, input: { action: 'history' } })
    const row = elements(render()).find((element) => element.props.title === 'Load this translation')
    expect(row).toBeDefined()
    ;(row!.props.onClick as () => void)()
    expect(field('text').props.value).toBe('Hello')
    expect(field('provider').props.value).toBe('google')
    expect(field('target').props.value).toBe('km')
  })

  it('clears all history only after an explicit confirmation step', async () => {
    invoke.mockResolvedValue({ ok: true, value: [{ id: 'h1', text: 'Hello', translatedText: 'សួស្តី', sourceLanguage: 'auto', targetLanguage: 'km', provider: 'google', createdAt: 1 }] })
    ;(button('History').props.onClick as () => void)()
    elements(render()) // Mount the history view so its load effect runs.
    await Promise.resolve()
    await Promise.resolve()
    const clearAll = elements(render()).find((element) =>
      Array.isArray(element.props.children) && element.props.children.includes('Clear all'))
    expect(clearAll).toBeDefined()
    ;(clearAll!.props.onClick as () => void)()
    expect(invoke).not.toHaveBeenCalledWith(expect.objectContaining({ input: { action: 'clear-history' } }))
    const confirmClear = elements(render()).find((element) =>
      Array.isArray(element.props.children) && element.props.children.includes('Confirm clear all?'))
    expect(confirmClear).toBeDefined()
    ;(confirmClear!.props.onClick as () => void)()
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ input: { action: 'clear-history' } }))
  })

  it('lists enabled Settings providers as LLM targets, locks out keyless ones, and sends the chosen model', async () => {
    providersList.mockResolvedValue([
      { id: 'deepseek', name: 'DeepSeek', enabled: true, baseUrl: 'https://api.deepseek.com', apiFormat: 'Chat completions (/chat/completions)', apiKey: '', hasApiKey: true, models: [{ id: 'deepseek-v4-flash', context: '1M' }, { id: 'deepseek-v4-pro', context: '1M' }] },
      { id: 'locked', name: 'Locked', enabled: true, baseUrl: '', apiFormat: '', apiKey: '', hasApiKey: false, models: [] },
    ])
    invoke.mockResolvedValue({ ok: true, value: { status: 'translated', translatedText: 'សួស្តី' } })
    render()
    await Promise.resolve()
    await Promise.resolve()
    const locked = elements(render()).find((element) => element.type === 'option' && element.props.value === 'llm:locked')
    expect(locked?.props.disabled).toBe(true)
    change('text', 'Hello')
    change('provider', 'llm:deepseek')
    expect(field('provider').props.value).toBe('llm:deepseek')
    expect(field('model').props.value).toBe('deepseek-v4-flash')
    change('model', 'deepseek-v4-pro')
    await submit()
    expect(invoke).toHaveBeenCalledWith({
      extensionId: 'nd.translate', contributionId: 'translator', contributionKind: 'view', caller: 'user', context: { kind: 'personal' },
      input: { text: 'Hello', sourceLanguage: 'auto', targetLanguage: 'km', provider: 'llm:deepseek', model: 'deepseek-v4-pro' },
    })
  })

  it('loads a history entry made by an LLM provider back into the provider and model fields', async () => {
    providersList.mockResolvedValue([
      { id: 'deepseek', name: 'DeepSeek', enabled: true, baseUrl: 'https://api.deepseek.com', apiFormat: 'Chat completions (/chat/completions)', apiKey: '', hasApiKey: true, models: [{ id: 'deepseek-v4-flash', context: '1M' }, { id: 'deepseek-v4-pro', context: '1M' }] },
    ])
    const entry = { id: 'h2', text: 'Hello', translatedText: 'សួស្តី', sourceLanguage: 'auto', targetLanguage: 'km', provider: 'llm:deepseek', model: 'deepseek-v4-pro', createdAt: 2 }
    invoke.mockResolvedValue({ ok: true, value: [entry] })
    render()
    await Promise.resolve()
    await Promise.resolve()
    ;(button('History').props.onClick as () => void)()
    elements(render())
    await Promise.resolve()
    await Promise.resolve()
    const row = elements(render()).find((element) => element.props.title === 'Load this translation')
    ;(row!.props.onClick as () => void)()
    expect(field('text').props.value).toBe('Hello')
    expect(field('provider').props.value).toBe('llm:deepseek')
    expect(field('model').props.value).toBe('deepseek-v4-pro')
    expect(field('target').props.value).toBe('km')
  })

  it('falls back to Google for a history entry whose LLM provider is no longer enabled', async () => {
    const entry = { id: 'h3', text: 'Hello', translatedText: 'សួស្តី', sourceLanguage: 'auto', targetLanguage: 'km', provider: 'llm:gone', model: 'm1', createdAt: 3 }
    invoke.mockResolvedValue({ ok: true, value: [entry] })
    ;(button('History').props.onClick as () => void)()
    elements(render())
    await Promise.resolve()
    await Promise.resolve()
    const row = elements(render()).find((element) => element.props.title === 'Load this translation')
    ;(row!.props.onClick as () => void)()
    expect(field('provider').props.value).toBe('google')
  })
})

function translateButton(): TestElement {
  const item = elements(render()).find((element) => element.props.type === 'submit')
  if (!item) throw new Error('Missing translate submit button')
  return item
}

const PASTED_URL = 'data:image/png;base64,QUJD'
class FakeFileReader {
  result: string | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL(): void {
    this.result = PASTED_URL
    queueMicrotask(() => { if (this.onload) this.onload() })
  }
}

function pasteImages(count: number): void {
  const files = Array.from({ length: count }, (): File => ({ type: 'image/png', size: 100 }) as unknown as File)
  const event = {
    clipboardData: { items: files.map((file) => ({ kind: 'file', type: 'image/png', getAsFile: () => file })) },
    preventDefault: vi.fn(),
  }
  ;(field('text').props.onPaste as (event: unknown) => void)(event)
}
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
function pastedImages(): string[] {
  return elements(render()).filter((element) => element.type === 'img').map((element) => String(element.props.src))
}

describe('ND Translate image paste', () => {
  beforeEach(() => {
    vi.stubGlobal('FileReader', FakeFileReader)
  })

  it('shows pasted images as removable thumbnails and sends them with the request', async () => {
    invoke.mockResolvedValue({ ok: true, value: { status: 'translated', translatedText: 'សួស្តី' } })
    pasteImages(2)
    await flush()
    expect(pastedImages()).toEqual([PASTED_URL, PASTED_URL])
    expect(field('text').props.value).toBe('')
    expect(translateButton().props.disabled).toBe(false)

    const remove = elements(render()).find((element) => element.props['aria-label'] === 'Remove image 1')
    ;(remove!.props.onClick as () => void)()
    expect(pastedImages()).toEqual([PASTED_URL])

    change('text', 'Hello')
    await submit()
    expect(invoke).toHaveBeenCalledWith({
      extensionId: 'nd.translate', contributionId: 'translator', contributionKind: 'view', caller: 'user', context: { kind: 'personal' },
      input: { text: 'Hello', sourceLanguage: 'auto', targetLanguage: 'km', provider: 'google', images: [PASTED_URL] },
    })
  })

  it('clears pasted images together with the text', async () => {
    pasteImages(1)
    await flush()
    change('text', 'Hello')
    const clear = elements(render()).find((element) => element.props.children === 'Clear')
    ;(clear!.props.onClick as () => void)()
    expect(field('text').props.value).toBe('')
    expect(pastedImages()).toEqual([])
  })

  it('surfaces the provider error when images reach a browser provider', async () => {
    invoke.mockResolvedValue({ ok: true, value: { status: 'error', message: 'Image translation works with LLM providers from Settings → Models. Pick one in the provider menu.' } })
    pasteImages(1)
    await flush()
    await submit()
    expect(message()).toContain('LLM providers')
  })
})
