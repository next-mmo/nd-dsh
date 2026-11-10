import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { PhoneAudioService } from '../src/main/extensions/phone-audio-service.js'
import type { PhoneAudioCommand, PhoneAudioSignalToRenderer } from '../src/shared/phone-audio.js'

const activeServices: PhoneAudioService[] = []

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

describe('PhoneAudioService HTTP + WebSocket signaling server', () => {
  it('enforces pairing auth, single Android client, SDP/ICE signaling relay, token rotation, and clean shutdown', async () => {
    const commands: PhoneAudioCommand[] = []
    const signals: PhoneAudioSignalToRenderer[] = []

    const svc = new PhoneAudioService({
      headless: true,
      disableRefreshTimer: true,
      readSystemVolume: async () => ({ available: true, level: 80, muted: false }),
      readOutputDevices: async () => [
        { deviceId: 'dev-1', label: 'Speakers (Realtek(R) Audio)', groupId: 'g1', isDefault: true },
        { deviceId: 'dev-2', label: 'U27N3R (Intel(R) Display Audio)', groupId: 'g2', isDefault: false },
      ],
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
      onCommand: (cmd) => commands.push(cmd),
      onSignalToRenderer: (sig) => signals.push(sig),
    })
    activeServices.push(svc)

    expect(svc.isCaptureArmed()).toBe(false)
    const started = await svc.start()
    expect(started.serverRunning).toBe(true)
    expect(started.streamState).toBe('waiting')
    expect(started.port).toBeGreaterThan(0)
    expect(started.pairingCode).toMatch(/^\d{6}$/)
    expect(svc.isCaptureArmed()).toBe(true)
    expect(started.outputDevices.map((d) => d.label)).toEqual([
      'Speakers (Realtek(R) Audio)',
      'U27N3R (Intel(R) Display Audio)',
    ])

    const base = `http://127.0.0.1:${started.port}`

    // Reject invalid token
    const badPage = await fetch(`${base}/?token=wrong`)
    expect(badPage.status).toBe(401)

    // Reject wrong pairing code, accept valid pairing code
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

    // Receiver HTML loads with valid token and requests zero mic/camera APIs
    const okPage = await fetch(`${base}/?token=${encodeURIComponent(pairData.token)}`)
    expect(okPage.status).toBe(200)
    const html = await okPage.text()
    expect(html).toContain('Connect &amp; Play Audio')
    expect(html).not.toContain('getUserMedia')

    // Reject unauthorized WebSocket upgrade
    await expect(connectWs(`ws://127.0.0.1:${started.port}/ws?token=invalid`)).rejects.toThrow()

    // Connect authorized Android WebSocket client
    const { ws, closeCode } = await connectWs(`ws://127.0.0.1:${started.port}/ws?token=${encodeURIComponent(pairData.token)}`)
    const receivedMessages: Array<Record<string, unknown>> = []
    ws.on('message', (raw) => {
      receivedMessages.push(JSON.parse(String(raw)) as Record<string, unknown>)
    })

    ws.send(JSON.stringify({ type: 'client-hello', userAgent: 'Android 14 Chrome/130' }))
    await new Promise((r) => setTimeout(r, 40))

    const readyCmd = commands.find((c) => c.kind === 'client-ready')
    expect(readyCmd?.kind).toBe('client-ready')
    const clientId = readyCmd && readyCmd.kind === 'client-ready' ? readyCmd.clientId : ''
    expect(clientId).toBeTruthy()
    expect(svc.currentSnapshot().client?.remoteAddress).toBe('127.0.0.1')

    // Relay offer + ICE + answer + ping/pong + telemetry
    svc.handleRendererSignal({ kind: 'sdp-offer', clientId, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111' })
    svc.handleRendererSignal({ kind: 'ice-candidate', clientId, candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 9999 typ host' } })
    ws.send(JSON.stringify({ type: 'sdp-answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111' }))
    ws.send(JSON.stringify({ type: 'ping', t: 123.4 }))
    ws.send(JSON.stringify({ type: 'client-telemetry', paused: false, volume: 0.75, latencyMs: 11, jitterMs: 1.5 }))
    await new Promise((r) => setTimeout(r, 40))

    expect(receivedMessages.some((m) => m.type === 'sdp-offer')).toBe(true)
    expect(receivedMessages.some((m) => m.type === 'ice-candidate')).toBe(true)
    expect(receivedMessages.some((m) => m.type === 'pong' && m.t === 123.4)).toBe(true)
    expect(signals.some((s) => s.kind === 'sdp-answer')).toBe(true)
    expect(svc.currentSnapshot().client?.volume).toBe(0.75)
    expect(svc.currentSnapshot().client?.latencyMs).toBe(11)

    // Second concurrent client is rejected (single receiver policy)
    const second = await connectWs(`ws://127.0.0.1:${started.port}/ws?token=${encodeURIComponent(pairData.token)}`)
    expect(await second.closeCode).toBe(4008)

    // Token rotation disconnects active receiver and invalidates previous token
    const rotated = await svc.rotateToken()
    expect(await closeCode).toBe(4003)
    expect(rotated.pairingCode).not.toBe(started.pairingCode)
    const stalePage = await fetch(`${base}/?token=${encodeURIComponent(pairData.token)}`)
    expect(stalePage.status).toBe(401)

    // Stop shuts down server and disarms capture
    const stopped = await svc.stop('Done')
    expect(stopped.serverRunning).toBe(false)
    expect(stopped.streamState).toBe('stopped')
    expect(svc.isCaptureArmed()).toBe(false)
  })
})
