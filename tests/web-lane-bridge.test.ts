import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebLaneBridge, type WebLaneBridgeDescriptor } from '../src/main/router/web-lane-bridge.js'
import { WebTurnError } from '../src/main/engines/web-turn.js'

const bridges: WebLaneBridge[] = []

afterEach(async () => {
  await Promise.all(bridges.map((bridge) => bridge.stop()))
  bridges.length = 0
})

async function startBridge(run: (input: { engineId: string; prompt: string; model?: string; signal?: AbortSignal }) => Promise<unknown>): Promise<{
  bridge: WebLaneBridge
  descriptor: WebLaneBridgeDescriptor
  runWebLane: ReturnType<typeof vi.fn>
}> {
  const runWebLane = vi.fn(run)
  const bridge = new WebLaneBridge({ engineRouter: { runWebLane } as never, log: () => undefined })
  bridges.push(bridge)
  const descriptor = await bridge.start()
  return { bridge, descriptor, runWebLane }
}

function post(descriptor: WebLaneBridgeDescriptor, body: unknown, token = descriptor.token): Promise<Response> {
  return fetch(`${descriptor.url}/v1/web/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await delay(10)
  }
  throw new Error('condition was not reached in time')
}

describe('WebLaneBridge', () => {
  it('rejects an invalid bridge credential', async () => {
    const { descriptor } = await startBridge(async () => ({ text: 'ok' }))
    const response = await post(descriptor, { engine: 'chatgpt-web', prompt: 'hi' }, 'wrong')
    expect(response.status).toBe(401)
  })

  it('returns the finished web turn and forwards the request', async () => {
    const { descriptor, runWebLane } = await startBridge(async (input) => ({
      text: 'web answer',
      engineId: input.engineId,
      model: input.model ?? 'default',
      latencyMs: 42,
    }))
    const response = await post(descriptor, { requestId: 'r1', engine: 'gemini-web', model: '3.5 Flash-Lite', prompt: 'hello' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, text: 'web answer', engineId: 'gemini-web', model: '3.5 Flash-Lite' })
    expect(runWebLane).toHaveBeenCalledWith(expect.objectContaining({ engineId: 'gemini-web', prompt: 'hello', model: '3.5 Flash-Lite' }))
  })

  it('maps sign-in and busy failures to stable codes', async () => {
    let code: 'login-required' | 'page-busy' = 'login-required'
    const { descriptor } = await startBridge(async () => {
      if (code === 'login-required') {
        throw new WebTurnError({ code: 'login-required', message: 'Sign in to ChatGPT Web', phase: 'open' })
      }
      throw new WebTurnError({ code: 'page-busy', message: 'The visible browser is busy', phase: 'open' })
    })
    const signedOut = await post(descriptor, { engine: 'chatgpt-web', prompt: 'hi' })
    expect(signedOut.status).toBe(503)
    expect(await signedOut.json()).toMatchObject({ code: 'web_signed_out' })
    code = 'page-busy'
    const busy = await post(descriptor, { engine: 'chatgpt-web', prompt: 'hi' })
    expect(busy.status).toBe(429)
    expect(await busy.json()).toMatchObject({ code: 'browser_busy' })
  })

  it('serializes turns and rejects an overflowing queue', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { descriptor, runWebLane } = await startBridge(async (input) => {
      await gate
      return { text: 'ok', engineId: input.engineId, model: 'default', latencyMs: 1 }
    })

    const first = post(descriptor, { requestId: 'r1', engine: 'chatgpt-web', prompt: 'one' })
    await waitFor(() => runWebLane.mock.calls.length === 1)
    const second = post(descriptor, { requestId: 'r2', engine: 'chatgpt-web', prompt: 'two' })
    const third = post(descriptor, { requestId: 'r3', engine: 'chatgpt-web', prompt: 'three' })
    await delay(40)
    const overflow = await post(descriptor, { requestId: 'r4', engine: 'chatgpt-web', prompt: 'four' })
    expect(overflow.status).toBe(429)
    expect(await overflow.json()).toMatchObject({ code: 'queue_full' })

    release()
    const responses = await Promise.all([first, second, third])
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
    expect(runWebLane).toHaveBeenCalledTimes(3)
  })

  it('cancels an active turn with a stable response', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { descriptor, bridge, runWebLane } = await startBridge(async (input) => {
      await gate
      return { text: 'ok', engineId: input.engineId, model: 'default', latencyMs: 1 }
    })
    const pending = post(descriptor, { requestId: 'cancel-me', engine: 'gemini-web', prompt: 'slow' })
    await waitFor(() => runWebLane.mock.calls.length === 1)
    bridge.cancel('cancel-me')
    const response = await pending
    expect(response.status).toBe(499)
    expect(await response.json()).toMatchObject({ code: 'turn_cancelled' })
    release()
    await delay(20)
  })

  it('rejects an empty prompt before creating a turn', async () => {
    const { descriptor, runWebLane } = await startBridge(async () => ({ text: 'ok' }))
    const response = await post(descriptor, { engine: 'chatgpt-web', prompt: '   ' })
    expect(response.status).toBe(400)
    expect(runWebLane).not.toHaveBeenCalled()
  })
})