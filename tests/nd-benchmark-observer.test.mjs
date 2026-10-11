import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { connectNd } from '../benchmarks/project-brief-live/nd-cdp.mjs'

// Explicit local protocol fixtures, never substituted into the production UI.
const disposers = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() })
async function fixture(respond) {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify([{ url: 'http://localhost:5173/', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}` }]))
  })
  const sockets = new WebSocketServer({ server })
  sockets.on('connection', socket => socket.on('message', bytes => respond(socket, JSON.parse(bytes))))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  disposers.push(() => { for (const socket of sockets.clients) socket.terminate(); return new Promise(done => sockets.close(() => server.close(done))) })
  const client = await connectNd({ endpoint: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 100 })
  disposers.push(() => client.close())
  return client
}
it('rejects in-flight observer requests when the app connection closes', async () => {
  const client = await fixture(socket => socket.close())
  await expect(client.evaluate('1')).rejects.toThrow('connection closed')
  await expect(client.evaluate('2')).rejects.toThrow('connection unavailable')
})
it('bounds requests that receive no response', async () => {
  const client = await fixture(() => {})
  await expect(client.evaluate('1')).rejects.toThrow('request timed out')
})
it('returns observed values and preserves renderer exceptions', async () => {
  const client = await fixture((socket, message) => socket.send(JSON.stringify({ id: message.id, result: message.params.expression === 'value' ? { result: { value: 42 } } : { exceptionDetails: { text: 'fixture exception' } } })))
  expect(await client.evaluate('value')).toBe(42)
  await expect(client.evaluate('exception')).rejects.toThrow('fixture exception')
})
