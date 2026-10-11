import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { GatewayClient, pickFreePort } from '../src/main/dsh/gateway-client.js'
import type { SessionStreamFrame } from '../src/main/dsh/gateway-client.js'

describe('pickFreePort', () => {
  it('returns a valid, bindable loopback port', async () => {
    const port = await pickFreePort()
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThanOrEqual(1_024)
    expect(port).toBeLessThanOrEqual(65_535)
  })

  it('returns distinct ports across calls', async () => {
    const first = await pickFreePort()
    const second = await pickFreePort()
    expect(first).not.toBe(second)
  })
})

describe('GatewayClient.rpc', () => {
  it('negotiates the updated slash endpoints and named arguments after a legacy 404', async () => {
    const requests: unknown[] = []
    const server = createServer(async (request, response) => {
      if (request.url === '/api/session.list') {
        response.writeHead(404).end()
        return
      }
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const envelope = JSON.parse(body)
      requests.push({ url: request.url, method: envelope.method, payload: envelope.payload })
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { items: [] } },
      }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const client = new GatewayClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    try {
      expect((await client.rpc('session.list')).ok).toBe(true)
      expect((await client.rpc('session.models')).ok).toBe(true)
      // Zero-parameter and named-parameter remotes reject the request envelope,
      // so their args are shaped individually.
      expect((await client.rpc('agentPreset.list')).ok).toBe(true)
      expect((await client.rpc('settings.update', { ns: 'agent-presets', patch: { default: 'code' } })).ok).toBe(true)
      expect(requests).toEqual([
        { url: '/api/session/list', method: 'session/list', payload: { args: { _request: {} } } },
        { url: '/api/session/modelCatalog', method: 'session/modelCatalog', payload: { args: {} } },
        { url: '/api/agentPresets/list', method: 'agentPresets/list', payload: { args: {} } },
        { url: '/api/settings/update', method: 'settings/update', payload: { args: { ns: 'agent-presets', patch: { default: 'code' } } } },
      ])
    } finally {
      client.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('posts the dotted method name and bare payload before the remote face is negotiated', async () => {
    const requests: unknown[] = []
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const envelope = JSON.parse(body)
      requests.push({ url: request.url, method: envelope.method, payload: envelope.payload })
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { presets: [] } },
      }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const client = new GatewayClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    try {
      // A dotted-face runtime matches the path against its own route table and
      // 404s anything else, so the roster's singular wire name is load-bearing:
      // the plural name reaches no route and the preset panel never loads.
      expect((await client.rpc('agentPreset.list', {})).ok).toBe(true)
      expect(requests).toEqual([
        { url: '/api/agentPreset.list', method: 'agentPreset.list', payload: {} },
      ])
    } finally {
      client.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('returns a structured unreachable result instead of throwing when the runtime is down', async () => {
    // A reserved-then-released port has nothing listening on it.
    const port = await pickFreePort()
    const client = new GatewayClient(`http://127.0.0.1:${port}`)
    const result = await client.rpc('session.list', {})
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('gateway-unreachable')
    expect(result.error?.message).toContain('session.list')
  })

  it('exchanges a DSH launch token and reuses its session cookie for RPC', async () => {
    const server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/?token=launch-token') {
        response.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-test=signed; Path=/; HttpOnly; SameSite=Strict' })
        response.end()
        return
      }
      if (request.method === 'POST' && request.url === '/api/session.list') {
        if (request.headers.cookie !== 'dsh-auth-test=signed') {
          response.writeHead(401).end('Unauthorized')
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          type: 'server-response',
          rpcId: 'server-owned-in-this-test',
          result: { ok: true, value: { items: [] } },
        }))
        return
      }
      response.writeHead(404).end()
    })
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    })

    try {
      const client = await GatewayClient.authenticate(`http://127.0.0.1:${port}/?token=launch-token`)
      await expect(client.rpc('session.list')).resolves.toEqual({ ok: true, value: { items: [] } })
      client.close()
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})

describe('GatewayClient.followSession', () => {
  it('opens a session/follow stream over the remote mux and delivers snapshot and live frames', async () => {
    const { server, wss } = streamServer()
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    })
    const client = new GatewayClient(`http://127.0.0.1:${port}`)
    const frames: SessionStreamFrame[] = []
    try {
      const handle = client.followSession('s1', (frame) => frames.push(frame))
      const opened = await onceOpen(wss)
      expect(opened.message).toMatchObject({ type: 'open', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 's1' }, maxMessages: 50 } } } })
      opened.reply({
        type: 'snapshot', cursor: 2,
        records: [{ type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: {} } }],
      })
      await handle.ready
      opened.reply({ type: 'event', event: { type: 'assistant/chunk', seq: 3, time: 3, data: {}, surfaceOp: { op: 'workbench/open', surface: 'review' } } })
      await vi.waitFor(() => expect(frames).toHaveLength(2))
      expect(frames[0]).toMatchObject({ type: 'snapshot', cursor: 2 })
      expect(frames[1]).toMatchObject({ type: 'event', event: { type: 'assistant/chunk', seq: 3, surfaceOp: { op: 'workbench/open', surface: 'review' } } })
      handle.close()
    } finally {
      client.close()
      await closeStreamServer(server, wss)
    }
  })

  it('rejects the opening snapshot when the stream errors, and stops following', async () => {
    const { server, wss } = streamServer()
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    })
    const client = new GatewayClient(`http://127.0.0.1:${port}`)
    try {
      const handle = client.followSession('gone', () => {})
      const opened = await onceOpen(wss)
      opened.raw({ type: 'error', streamId: opened.message.streamId, error: { code: 'session/not-found', message: 'session "gone" not found' } })
      await expect(handle.ready).rejects.toThrow('not found')
    } finally {
      client.close()
      await closeStreamServer(server, wss)
    }
  })
})

interface StreamServer {
  server: Server
  wss: WebSocketServer
}

function streamServer(): StreamServer {
  const wss = new WebSocketServer({ noServer: true })
  const server = createServer()
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (websocket) => wss.emit('connection', websocket, request))
  })
  return { server, wss }
}

interface OpenedStream {
  message: Record<string, unknown>
  reply: (value: unknown) => void
  raw: (message: Record<string, unknown>) => void
}

function onceOpen(wss: WebSocketServer): Promise<OpenedStream> {
  return new Promise((resolve) => {
    wss.once('connection', (socket: WebSocket) => {
      socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>
        resolve({
          message,
          reply: (value: unknown) => socket.send(JSON.stringify({ type: 'item', streamId: message.streamId, value })),
          raw: (next: Record<string, unknown>) => socket.send(JSON.stringify(next)),
        })
      })
    })
  })
}

async function closeStreamServer(server: Server, wss: WebSocketServer): Promise<void> {
  for (const socket of wss.clients) socket.terminate()
  await new Promise<void>((resolve) => wss.close(() => resolve()))
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
