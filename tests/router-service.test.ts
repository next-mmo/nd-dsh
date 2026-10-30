import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RouterPlaygroundEvent, RouterState } from '../src/shared/router.js'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'kwallet',
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (value: Buffer) => Buffer.from(value).toString().replace(/^enc:/, ''),
  },
}))

import { RouterService } from '../src/main/router/router-service.js'

interface FakeProvider {
  id: string
  name: string
  enabled: boolean
  baseUrl: string
  apiFormat: string
  apiKey: string
  models: Array<{ id: string; context: string }>
  maxRetries: number
}

function routerState(combos: Array<{ name: string; hidden: boolean }>): RouterState {
  return {
    providers: [],
    combos: combos.map((combo, index) => ({
      id: `combo-${index}`,
      name: combo.name,
      strategy: 'priority' as const,
      models: [],
      hiddenFromChat: combo.hidden,
    })),
    counters: { requests: 0, ok: 0, failed: 0, lastError: null },
  }
}

describe('RouterService', () => {
  let dir: string
  let server: Server | undefined
  let endpoint: string | undefined
  let savedProviders: FakeProvider[]
  let core: { request: ReturnType<typeof vi.fn> }
  let providers: { list: () => FakeProvider[]; save: (next: FakeProvider[]) => void; setApiKey: ReturnType<typeof vi.fn> }
  let service: RouterService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nd-router-service-'))
    savedProviders = []
    providers = {
      list: () => savedProviders,
      save: (next) => { savedProviders = next },
      setApiKey: vi.fn(),
    }
    core = {
      request: vi.fn(async (method: string) => {
        if (method === 'router.initialize') {
          return {
            endpoint: endpoint ?? 'http://127.0.0.1:3999',
            key: 'ndr_launch_key',
            port: 3130,
            state: routerState([{ name: 'api-route', hidden: false }, { name: 'web-private', hidden: true }]),
          }
        }
        if (method === 'router.usage') {
          return { requests: 0, ok: 0, failed: 0, avgLatencyMs: 0, byProvider: {}, session: { requests: 0, ok: 0, failed: 0, lastError: null } }
        }
        return { updated: true }
      }),
    }
    service = new RouterService(core as never, providers as never, dir, () => undefined)
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server?.close(() => resolve())
        server?.closeAllConnections?.()
      })
      server = undefined
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('initializes with the bridge, external key and port, and hides private combos from chat', async () => {
    await service.initialize({ url: 'http://127.0.0.1:5000', token: 'bridge-token' })
    const [, params] = core.request.mock.calls[0] as [string, Record<string, unknown>]
    expect(params.webBridge).toEqual({ url: 'http://127.0.0.1:5000', token: 'bridge-token' })
    expect(typeof params.externalKey).toBe('string')
    expect(String(params.externalKey).startsWith('ndr_ext_')).toBe(true)
    expect(params.preferredPort).toBeGreaterThan(0)

    const managed = savedProviders.find((provider) => provider.id === 'nd-router')
    expect(managed?.models.map((model) => model.id)).toEqual(['api-route'])
    expect(managed?.enabled).toBe(true)
    expect(providers.setApiKey).toHaveBeenCalledWith('nd-router', 'ndr_launch_key')
    expect(service.externalKeyState()).toMatchObject({ hasKey: true, persisted: true })
  })

  it('streams playground deltas and reports the resolved route', async () => {
    let seenAuthorization: string | undefined
    let seenCombo: string | undefined
    server = createServer((request, response) => {
      seenAuthorization = request.headers.authorization
      seenCombo = request.headers['x-nd-route-combo'] as string | undefined
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-nd-router-provider': 'api-provider',
        'x-nd-router-model': 'api-model',
        'x-nd-router-combo': 'api-route',
        'x-nd-router-latency-ms': '7',
      })
      response.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n')
      response.write('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n')
      response.end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server has no port')
    endpoint = `http://127.0.0.1:${address.port}`
    await service.initialize()

    const events: RouterPlaygroundEvent[] = []
    const done = new Promise<void>((resolve) => {
      service.playgroundStart(
        {
          requestId: 'playground-1',
          route: { kind: 'combo', combo: 'api-route' },
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
        },
        (event) => {
          events.push(event)
          if (event.type === 'done' || event.type === 'error') resolve()
        },
      )
    })
    await done

    expect(events.filter((event) => event.type === 'delta').map((event) => event.delta).join('')).toBe('hello')
    expect(events.find((event) => event.type === 'done')).toMatchObject({
      provider: 'api-provider',
      model: 'api-model',
      combo: 'api-route',
      latencyMs: 7,
    })
    expect(seenAuthorization).toBe('Bearer ndr_launch_key')
    expect(seenCombo).toBe('api-route')
  })

  it('rotates the external key through the router', async () => {
    await service.initialize()
    const before = service.revealExternalKey().key
    const rotated = await service.rotateExternalKey()
    expect(rotated.key).not.toBe(before)
    expect(rotated.persisted).toBe(true)
    expect(core.request).toHaveBeenCalledWith('router.setExternalKey', { externalKey: rotated.key }, 10_000)
    expect(service.revealExternalKey().key).toBe(rotated.key)
  })

  it('aligns the saved 9Router provider with a new managed endpoint without dropping its secret', async () => {
    const calls: Array<{ method: string; input: unknown }> = []
    const localCore = {
      request: vi.fn(async (method: string, input?: unknown) => {
        calls.push({ method, input })
        if (method === 'router.state') {
          return {
            providers: [{
              id: 'nine-router-external',
              kind: 'openai-compatible',
              name: '9Router',
              baseUrl: 'http://127.0.0.1:6536/v1',
              models: ['alicode/glm-5'],
              isActive: true,
              priority: 0,
              hasSecret: true,
              accounts: [],
            }],
            combos: [],
            counters: { requests: 0, ok: 0, failed: 0, lastError: null },
          }
        }
        return {}
      }),
    }
    const localService = new RouterService(localCore as never, providers as never, dir, () => undefined)

    await expect(localService.syncNineRouterEndpoint('http://127.0.0.1:1147/v1')).resolves.toBe(true)

    const save = calls.find((call) => call.method === 'router.saveProvider')
    expect(save?.input).toMatchObject({
      id: 'nine-router-external',
      baseUrl: 'http://127.0.0.1:1147/v1',
      models: ['alicode/glm-5'],
    })
    expect(save?.input).not.toHaveProperty('apiKey')
    expect(save?.input).not.toHaveProperty('clearSecret')
  })
})