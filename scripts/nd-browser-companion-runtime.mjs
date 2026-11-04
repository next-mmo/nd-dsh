#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const PROTOCOL = 1
const DISCOVERY = process.env.ND_BROWSER_COMPANION_DISCOVERY?.trim()
  || join(homedir(), '.nd-dsh', 'browser-companion.json')
const TIMEOUT_MS = 30_000
const MAX_LINE_BYTES = 8 * 1024 * 1024

async function request(method, params = {}) {
  const discovery = JSON.parse(await fs.readFile(DISCOVERY, 'utf8'))
  if (discovery?.version !== PROTOCOL || typeof discovery.endpoint !== 'string' || typeof discovery.token !== 'string') {
    throw new Error('ND browser companion discovery file is invalid or stale')
  }

  const socket = connect(discovery.endpoint)
  socket.setEncoding('utf8')
  let buffer = ''
  const pending = new Map()

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ND browser companion connection timed out')), TIMEOUT_MS)
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ version: PROTOCOL, kind: 'auth', token: discovery.token, client: 'agent' })}\n`)
    })
    socket.once('error', reject)
    socket.on('data', (chunk) => {
      buffer += chunk
      if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) {
        reject(new Error('ND browser companion response exceeded maximum size'))
        socket.destroy()
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.kind === 'auth.ok') {
          clearTimeout(timer)
          resolve()
          continue
        }
        if (message.kind === 'response' && typeof message.id === 'string') {
          const item = pending.get(message.id)
          if (!item) continue
          pending.delete(message.id)
          clearTimeout(item.timer)
          if (message.error) item.reject(new Error(message.error.message ?? 'Browser companion request failed'))
          else item.resolve(message.result)
        }
      }
    })
  })

  await ready
  const id = randomUUID()
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`ND browser companion ${method} timed out`))
      }, TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      socket.write(`${JSON.stringify({ version: PROTOCOL, kind: 'request', id, method, params })}\n`)
    })
  } finally {
    socket.end()
  }
}

export { request }

async function main() {
  const [mode, raw] = process.argv.slice(2)
  if (mode === 'connections') {
    process.stdout.write(`${JSON.stringify(await request('browser.connections'), null, 2)}\n`)
    return
  }
  if (mode === 'call') {
    if (!raw) throw new Error('usage: nd-browser-companion-runtime.mjs call <json-request>')
    const input = JSON.parse(raw)
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.method !== 'string') {
      throw new Error('browser request must be an object with method')
    }
    const { method, ...params } = input
    process.stdout.write(`${JSON.stringify(await request(method, params), null, 2)}\n`)
    return
  }
  throw new Error('usage: nd-browser-companion-runtime.mjs <connections|call> ...')
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isCli) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
