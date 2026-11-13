import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { PhoneInputService } from '../src/main/extensions/phone-input-service.js'
import type { CoreInput } from '../src/main/core/core-input.js'

const activeServices: PhoneInputService[] = []

afterEach(async () => {
  while (activeServices.length > 0) {
    const svc = activeServices.pop()!
    await svc.dispose()
  }
})

function connectWs(url: string): Promise<{ ws: WebSocket; closeCode: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const closeCode = new Promise<number>((resClose) => {
      ws.on('close', (code) => resClose(code))
    })
    ws.once('open', () => resolve({ ws, closeCode }))
    ws.once('error', (err) => reject(err))
  })
}

function nextMessage(ws: WebSocket, predicate: (msg: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WS message')), timeoutMs)
    const handler = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>
      if (predicate(msg)) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(msg)
      }
    }
    ws.on('message', handler)
  })
}

describe('PhoneInputService HTTP + WebSocket keyboard server', () => {
  it('enforces pairing auth, single client, injection acks, token rotation, and clean shutdown', async () => {
    const texts: string[] = []
    const keys: string[] = []
    const inject: CoreInput = {
      typeText: async (text) => { texts.push(text) },
      sendKey: async (key) => { keys.push(key) },
    }

    const svc = new PhoneInputService({
      inject,
      disableRefreshTimer: true,
      discoverInterfaces: async (port, token) => [
        {
          id: 'wifi:127.0.0.1',
          name: 'Wi-Fi',
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          cidr: '127.0.0.1/8',
          kind: 'wifi',
          label: 'Wi-Fi (Loopback Test)',
          url: `http://127.0.0.1:${port}/?token=${token}`,
          qrSvg: `<svg>${port}</svg>`,
        },
      ],
    })
    activeServices.push(svc)

    const started = await svc.start()
    expect(started.serverRunning).toBe(true)
    expect(started.sessionState).toBe('waiting')
    expect(started.port).toBeGreaterThan(0)
    expect(started.pairingCode).toMatch(/^\d{6}$/)

    const base = `http://127.0.0.1:${started.port}`

    const badPage = await fetch(`${base}/?token=wrong`)
    expect(badPage.status).toBe(401)

    const badPair = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    })
    expect(badPair.status).toBe(401)

    const goodPair = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: started.pairingCode }),
    })
    expect(goodPair.status).toBe(200)
    const pairData = (await goodPair.json()) as { token: string }
    expect(pairData.token).toBeTruthy()

    const okPage = await fetch(`${base}/?token=${encodeURIComponent(pairData.token)}`)
    expect(okPage.status).toBe(200)
    const html = await okPage.text()
    expect(html).toContain('Send to PC')
    expect(html).toContain('data-key="enter"')
    expect(html).not.toContain('getUserMedia')

    await expect(connectWs(`ws://127.0.0.1:${started.port}/ws?token=invalid`)).rejects.toThrow()

    const { ws, closeCode } = await connectWs(`ws://127.0.0.1:${started.port}/ws?token=${encodeURIComponent(pairData.token)}`)
    ws.send(JSON.stringify({ type: 'client-hello', userAgent: 'Android 14 Chrome/130' }))
    await new Promise((r) => setTimeout(r, 40))
    expect(svc.currentSnapshot().sessionState).toBe('connected')
    expect(svc.currentSnapshot().client?.remoteAddress).toBe('127.0.0.1')

    // Khmer text injection round-trips through the sidecar surface.
    const textAck = nextMessage(ws, (m) => m.type === 'ack' && m.id === 1)
    ws.send(JSON.stringify({ type: 'text', text: 'សួស្តី hello', id: 1 }))
    const ack = await textAck
    expect(ack.ok).toBe(true)
    expect(ack.chars).toBe('សួស្តី hello'.length)
    expect(texts).toEqual(['សួស្តី hello'])

    const keyAck = nextMessage(ws, (m) => m.type === 'ack' && m.id === 2)
    ws.send(JSON.stringify({ type: 'key', key: 'enter', id: 2 }))
    expect((await keyAck).ok).toBe(true)
    expect(keys).toEqual(['enter'])

    // Unknown keys and oversize text are rejected without injection.
    const badKeyAck = nextMessage(ws, (m) => m.type === 'ack' && m.id === 3)
    ws.send(JSON.stringify({ type: 'key', key: 'ctrl+c', id: 3 }))
    expect((await badKeyAck).ok).toBe(false)

    const bigAck = nextMessage(ws, (m) => m.type === 'ack' && m.id === 4)
    ws.send(JSON.stringify({ type: 'text', text: 'k'.repeat(2001), id: 4 }))
    expect((await bigAck).ok).toBe(false)
    expect(texts).toHaveLength(1)
    expect(keys).toHaveLength(1)

    expect(svc.currentSnapshot().injectedChars).toBe('សួស្តី hello'.length)
    expect(svc.currentSnapshot().injectedKeys).toBe(1)

    // Second concurrent client is rejected (single keyboard policy).
    const second = await connectWs(`ws://127.0.0.1:${started.port}/ws?token=${encodeURIComponent(pairData.token)}`)
    expect(await second.closeCode).toBe(4008)

    // Token rotation disconnects the active phone and invalidates the old token.
    const rotated = await svc.rotateToken()
    expect(await closeCode).toBe(4003)
    expect(rotated.pairingCode).not.toBe(started.pairingCode)
    const stalePage = await fetch(`${base}/?token=${encodeURIComponent(pairData.token)}`)
    expect(stalePage.status).toBe(401)

    const stopped = await svc.stop('Done')
    expect(stopped.serverRunning).toBe(false)
    expect(stopped.sessionState).toBe('stopped')
  })

  it('fails injection closed when the sidecar surface is absent', async () => {
    const svc = new PhoneInputService({
      disableRefreshTimer: true,
      discoverInterfaces: async (port, token) => [
        {
          id: 'wifi:127.0.0.1', name: 'Wi-Fi', address: '127.0.0.1', netmask: '255.0.0.0',
          cidr: '127.0.0.1/8', kind: 'wifi', label: 'Wi-Fi (Loopback Test)',
          url: `http://127.0.0.1:${port}/?token=${token}`, qrSvg: '<svg/>',
        },
      ],
    })
    activeServices.push(svc)
    const started = await svc.start()
    const pair = await fetch(`http://127.0.0.1:${started.port}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: started.pairingCode }),
    })
    const { token } = (await pair.json()) as { token: string }
    const { ws } = await connectWs(`ws://127.0.0.1:${started.port}/ws?token=${encodeURIComponent(token)}`)
    const ack = nextMessage(ws, (m) => m.type === 'ack' && m.id === 1)
    ws.send(JSON.stringify({ type: 'text', text: 'hi', id: 1 }))
    const result = await ack
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('sidecar')
  })
})