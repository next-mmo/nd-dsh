import { afterEach, describe, expect, it, vi } from 'vitest'
import { translateWithLlm } from '../src/main/extensions/translate-llm.js'
import type { ProviderStore } from '../src/main/providers.js'
import type { ModelProvider } from '../src/shared/contracts.js'

function provider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    enabled: true,
    baseUrl: 'https://api.deepseek.com',
    apiFormat: 'Chat completions (/chat/completions)',
    apiKey: 'sk-test-placeholder',
    models: [{ id: 'deepseek-v4-flash', context: '1M' }],
    ...overrides,
  }
}

function store(providers: ModelProvider[]): Pick<ProviderStore, 'allEnabled'> {
  return { allEnabled: () => providers }
}

const input = { text: 'Hello', sourceLanguage: 'auto', targetLanguage: 'km', provider: 'llm:deepseek' }
const fetchMock = vi.fn<typeof fetch>()

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

describe('ND Translate LLM provider path', () => {
  it('translates through the provider chat completions endpoint with the stored credential', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'សួស្តី' } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await translateWithLlm(store([provider()]), input)
    expect(result).toMatchObject({ status: 'translated', translatedText: 'សួស្តី', provider: 'llm:deepseek', model: 'deepseek-v4-flash' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer sk-test-placeholder' })
    const body = JSON.parse(String(init?.body))
    expect(body.model).toBe('deepseek-v4-flash')
    expect(body.messages[0].content).toContain('Hello')
    expect(body.messages[0].content).toContain('Khmer')
  })

  it('routes Anthropic Messages and Responses formats to their own endpoints', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const anthropic = provider({ id: 'claude', name: 'Claude', baseUrl: 'https://api.anthropic.com', apiFormat: 'Anthropic Messages (/v1/messages)', models: [{ id: 'claude-sonnet', context: '200K' }] })
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ content: [{ type: 'text', text: 'bonjour' }] }), { status: 200 }))
    const first = await translateWithLlm(store([anthropic]), { ...input, provider: 'llm:claude', targetLanguage: 'fr' })
    expect(first).toMatchObject({ status: 'translated', translatedText: 'bonjour' })
    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.objectContaining({
      headers: expect.objectContaining({ 'x-api-key': 'sk-test-placeholder' }),
    }))

    const responses = provider({ id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com', apiFormat: 'Responses (/responses)', models: [{ id: 'gpt-mini', context: '128K' }] })
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ output_text: 'hola' }), { status: 200 }))
    const second = await translateWithLlm(store([responses]), { ...input, provider: 'llm:openai', targetLanguage: 'es' })
    expect(second).toMatchObject({ status: 'translated', translatedText: 'hola' })
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/responses', expect.any(Object))
  })

  it('surfaces provider-reported failure details in the result message', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Insufficient balance for this model' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await translateWithLlm(store([provider()]), input)
    expect(result.status).toBe('error')
    expect(result.message).toContain('Insufficient balance')
    expect(result.translatedText).toBeUndefined()
  })

  it('reports rejected credentials and unreachable endpoints distinctly', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
    const auth = await translateWithLlm(store([provider()]), input)
    expect(auth.status).toBe('error')
    expect(auth.message).toContain('rejected the API key')

    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const unreachable = await translateWithLlm(store([provider()]), input)
    expect(unreachable.status).toBe('error')
    expect(unreachable.message).toContain('Could not reach')
    expect(unreachable.message).toContain('api.deepseek.com')
  })

  it('rejects disabled providers, missing credentials, missing models, and unknown model overrides', async () => {
    vi.stubGlobal('fetch', fetchMock)
    expect(await translateWithLlm(store([]), input)).toMatchObject({ status: 'error', message: expect.stringContaining('not enabled') })
    expect(await translateWithLlm(store([provider({ apiKey: '' })]), input)).toMatchObject({ status: 'error', message: expect.stringContaining('no API key') })
    expect(await translateWithLlm(store([provider({ models: [] })]), input)).toMatchObject({ status: 'error', message: expect.stringContaining('no model configured') })
    expect(await translateWithLlm(store([provider()]), { ...input, model: 'unknown-model' })).toMatchObject({ status: 'error', message: expect.stringContaining('not configured') })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps a single LLM translation running at a time', async () => {
    let finish!: (response: Response) => void
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => { finish = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const first = translateWithLlm(store([provider()]), input)
    expect(await translateWithLlm(store([provider()]), input)).toMatchObject({ status: 'busy' })
    finish(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }))
    expect(await first).toMatchObject({ status: 'translated', translatedText: 'ok' })
  })

  it('returns idle without contacting a provider for blank text', async () => {
    vi.stubGlobal('fetch', fetchMock)
    expect(await translateWithLlm(store([provider()]), { ...input, text: '   ' })).toMatchObject({ status: 'idle' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends pasted images as OpenAI chat content parts with an image-aware prompt', async () => {
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'សួស្តី' } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await translateWithLlm(store([provider()]), { ...input, text: '', images: [image] })
    expect(result).toMatchObject({ status: 'translated', translatedText: 'សួស្តី', images: [image] })
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(String(init?.body))
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: expect.stringContaining('image(s)') },
      { type: 'image_url', image_url: { url: image } },
    ])
  })

  it('encodes Anthropic images as base64 sources and Responses images as input_image parts', async () => {
    const image = 'data:image/webp;base64,QUJD'
    vi.stubGlobal('fetch', fetchMock)
    const anthropic = provider({ id: 'claude', name: 'Claude', baseUrl: 'https://api.anthropic.com', apiFormat: 'Anthropic Messages (/v1/messages)', models: [{ id: 'claude-sonnet', context: '200K' }] })
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ content: [{ type: 'text', text: 'bonjour' }] }), { status: 200 }))
    const first = await translateWithLlm(store([anthropic]), { ...input, provider: 'llm:claude', targetLanguage: 'fr', text: '', images: [image] })
    expect(first).toMatchObject({ status: 'translated' })
    const anthropicBody = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))
    expect(anthropicBody.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'QUJD' } })
    expect(anthropicBody.messages[0].content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('image(s)') })

    const responses = provider({ id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com', apiFormat: 'Responses (/responses)', models: [{ id: 'gpt-mini', context: '128K' }] })
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ output_text: 'hola' }), { status: 200 }))
    const second = await translateWithLlm(store([responses]), { ...input, provider: 'llm:openai', targetLanguage: 'es', text: '', images: [image] })
    expect(second).toMatchObject({ status: 'translated' })
    const responsesBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))
    expect(responsesBody.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: expect.stringContaining('image(s)') }, { type: 'input_image', image_url: image }] }])
  })

  it('rejects malformed or excess images before contacting a provider', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const image = 'data:image/png;base64,QUJD'
    await expect(translateWithLlm(store([provider()]), { ...input, images: ['https://example.com/a.png'] })).rejects.toThrow('screenshots or photos')
    await expect(translateWithLlm(store([provider()]), { ...input, images: [image, image, image, image] })).rejects.toThrow('at most 3')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
