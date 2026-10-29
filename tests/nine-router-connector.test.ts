import { describe, expect, it, vi } from 'vitest'
import { discoverNineRouterModels, parseNineRouterBaseUrl } from '../src/main/router/nine-router-connector.js'

describe('9Router connector safety', () => {
  it('permits localhost gateway URL', () => {
    expect(parseNineRouterBaseUrl('http://127.0.0.1:20128/v1').hostname).toBe('127.0.0.1')
  })
  it('requires TLS on non-loopback', () => {
    expect(() => parseNineRouterBaseUrl('http://example.com/v1')).toThrow(/HTTPS/)
  })
  it('rejects credential URLs and arbitrary paths', () => {
    expect(() => parseNineRouterBaseUrl('http://name:secret@localhost:20128/v1')).toThrow()
    expect(() => parseNineRouterBaseUrl('http://localhost:20128/admin')).toThrow()
    expect(() => parseNineRouterBaseUrl('file:///v1')).toThrow()
  })
  it('discovers slash-separated model IDs and never prints the key', async () => {
    const mock = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.headers).toEqual({
        authorization: 'Bearer test-key',
        accept: 'application/json',
      })
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'cc/claude' }, { id: 'ocg/glm' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const models = await discoverNineRouterModels({ baseUrl: 'http://127.0.0.1:20128/v1', apiKey: 'test-key' }, mock as unknown as typeof fetch)
    expect(models.map(m => m.id)).toEqual(['cc/claude', 'ocg/glm'])
    expect(mock).toHaveBeenCalledTimes(1)
  })
  it('rejects a missing key', async () => {
    await expect(discoverNineRouterModels({ baseUrl: 'http://localhost:20128/v1', apiKey: '' })).rejects.toThrow(/required/)
  })
})
