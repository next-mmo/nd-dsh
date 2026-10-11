import { describe, expect, it, vi } from 'vitest'
import type { GatewayClient } from '../src/main/dsh/gateway-client.js'
import { asRunImages } from '../src/main/run-images.js'
import { HarnessService } from '../src/main/harness/harness-service.js'

describe('asRunImages', () => {
  it('accepts omitted, empty-slot-free base64 images with a supported media type', () => {
    expect(asRunImages(undefined)).toBeUndefined()
    expect(asRunImages([{ data: 'QUJD', mediaType: 'image/png', name: 'shot.png' }])).toEqual([
      { data: 'QUJD', mediaType: 'image/png', name: 'shot.png' },
    ])
    expect(asRunImages([{ data: 'QUJD', mediaType: 'image/webp' }])).toEqual([{ data: 'QUJD', mediaType: 'image/webp' }])
  })

  it('rejects non-list shapes, empty lists, and more than three images', () => {
    expect(() => asRunImages({})).toThrow('images must be a non-empty list')
    expect(() => asRunImages([])).toThrow('images must be a non-empty list')
    expect(() => asRunImages([
      { data: 'QQ==', mediaType: 'image/png' },
      { data: 'QQ==', mediaType: 'image/png' },
      { data: 'QQ==', mediaType: 'image/png' },
      { data: 'QQ==', mediaType: 'image/png' },
    ])).toThrow('at most 3 images')
  })

  it('rejects non-object entries, unsupported media types, and non-base64 data', () => {
    expect(() => asRunImages(['nope'])).toThrow('Image 1 must be an object')
    expect(() => asRunImages([{ data: 'QUJD', mediaType: 'image/svg+xml' }])).toThrow('Image 1 must be a PNG, JPEG, WebP, or GIF')
    expect(() => asRunImages([{ data: 'data:image/png;base64,QUJD', mediaType: 'image/png' }])).toThrow('base64-encoded')
    expect(() => asRunImages([{ data: '!!!!', mediaType: 'image/png' }])).toThrow('base64-encoded')
  })

  it('rejects oversized payloads and malformed names', () => {
    expect(() => asRunImages([{ data: 'Q'.repeat(8_000_001), mediaType: 'image/png' }])).toThrow('under 6 MB')
    expect(() => asRunImages([{ data: 'QUJD', mediaType: 'image/png', name: '   ' }])).toThrow('Image 1 name must be a short non-empty string')
  })
})

interface RunImagesSeam {
  workspace: {
    assertUsable(): void
    state(): { root: string; name: string }
  }
  browser: { selectedUiTarget(): unknown; selectedUiAnnotation(): unknown; clearSelection(id: string): void }
  externalElements: { consumeAll(): unknown[] }
  eventHub: { ensure(sessionId: string): Promise<void> }
  sessionCwdById: Map<string, string>
  canceledSessions: Set<string>
  runningSessions: Set<string>
  activeSessionId?: string
  statusValue: { provider?: string; model?: string }
  updateStatus(state: string, error?: string): void
  ensureStarted(force: boolean): Promise<unknown>
  rpcWithRecovery(gateway: unknown, method: string, payload: unknown): Promise<{ gateway: unknown; result: { ok: true; value: unknown } }>
  run(prompt: string, options?: { images?: Array<{ data: string; mediaType: string; name?: string }> }): Promise<{ sessionId: string; messageId?: string }>
}

function runImagesFixture() {
  const service = Object.create(HarnessService.prototype) as RunImagesSeam
  service.workspace = {
    assertUsable: vi.fn(),
    state: () => ({ root: '/workspace', name: 'Sample Workspace' }),
  }
  service.browser = {
    selectedUiTarget: vi.fn(() => undefined),
    selectedUiAnnotation: vi.fn(() => undefined),
    clearSelection: vi.fn(),
  }
  service.externalElements = { consumeAll: vi.fn(() => []) }
  service.eventHub = { ensure: vi.fn(async () => undefined) }
  service.sessionCwdById = new Map()
  service.canceledSessions = new Set()
  service.runningSessions = new Set()
  service.activeSessionId = 'session-1'
  service.statusValue = {}
  service.updateStatus = vi.fn()
  service.ensureStarted = vi.fn(async () => ({}))
  const gateway = {} as unknown as GatewayClient
  const prompts: Array<{ sessionId: string; mode: string; content: Array<Record<string, unknown>> }> = []
  service.rpcWithRecovery = vi.fn(async (_gateway: unknown, method: string, payload: unknown) => {
    expect(method).toBe('session.prompt')
    prompts.push(payload as never)
    return { gateway, result: { ok: true as const, value: { messageId: 'message-1' } } }
  })
  return { service, prompts }
}

describe('HarnessService run pasted images', () => {
  it('joins options.images into the session.prompt content after the prompt text', async () => {
    const { service, prompts } = runImagesFixture()
    const result = await service.run('Describe this', {
      images: [
        { data: 'QUJD', mediaType: 'image/png', name: 'pasted-1.png' },
        { data: 'REVG', mediaType: 'image/webp', name: 'pasted-2.webp' },
      ],
    })
    expect(result).toEqual({ sessionId: 'session-1', messageId: 'message-1' })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.content[0]).toMatchObject({ type: 'text' })
    expect(prompts[0]!.content[1]).toEqual({ type: 'image', mediaType: 'image/png', data: 'QUJD', name: 'pasted-1.png' })
    expect(prompts[0]!.content[2]).toEqual({ type: 'image', mediaType: 'image/webp', data: 'REVG', name: 'pasted-2.webp' })
    expect(String(prompts[0]!.content[0]?.text ?? '')).toContain('Describe this')
  })

  it('runs a text-only prompt without image entries when no images are provided', async () => {
    const { service, prompts } = runImagesFixture()
    await service.run('Plain prompt')
    expect(prompts[0]!.content).toHaveLength(1)
    expect(prompts[0]!.content[0]).toMatchObject({ type: 'text' })
  })
})
