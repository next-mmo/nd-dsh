import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

const children: ReturnType<typeof spawn>[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
})

function runMcp(env: Record<string, string>): Promise<ReturnType<typeof spawn>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['scripts/nd-design-mcp.mjs', 'mcp'], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    children.push(child)
    child.once('error', reject)
    child.once('spawn', () => resolvePromise(child))
  })
}

function request(child: ReturnType<typeof spawn>, message: unknown): void {
  child.stdin?.write(`${JSON.stringify(message)}\n`)
}

function readUntil(child: ReturnType<typeof spawn>, id: number): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      child.stdout?.off('data', onData)
      reject(new Error(`MCP response ${id} timed out`))
    }, 5_000)
    const onData = (chunk: Buffer | string): void => {
      buffer += String(chunk)
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let parsed: Record<string, unknown>
        try { parsed = JSON.parse(line) } catch { continue }
        if (parsed.id === id) {
          clearTimeout(timer)
          child.stdout?.off('data', onData)
          resolvePromise(parsed)
          return
        }
      }
    }
    child.stdout?.on('data', onData)
  })
}

describe('ND Pencil design MCP server', () => {
  it('exposes one nd_design tool and forwards calls through the loopback bridge', async () => {
    let received: Record<string, unknown> | undefined
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        received = { authorization: request.headers.authorization, body: JSON.parse(body) }
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ ok: true, result: { open: true, revision: 4 } }))
      })
    })
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()))
    const address = server.address() as AddressInfo
    const child = await runMcp({
      ND_DSH_DESIGN_MCP_URL: `http://127.0.0.1:${address.port}`,
      ND_DSH_DESIGN_MCP_TOKEN: 'test-token',
      ND_DSH_DESIGN_CWD: 'C:/project',
    })
    try {
      request(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
      await expect(readUntil(child, 1)).resolves.toMatchObject({ result: { serverInfo: { name: 'nd-pencil-design' } } })
      request(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
      const tools = await readUntil(child, 2)
      expect((tools.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual(['nd_design'])
      request(child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nd_design', arguments: { action: 'state' } } })
      const result = await readUntil(child, 3)
      expect(result.result).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('"open": true') }] })
      expect(received).toMatchObject({
        authorization: 'Bearer test-token',
        body: { cwd: 'C:/project', action: 'state', args: { action: 'state' } },
      })
    } finally {
      child.kill()
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    }
  })

  it('reports a clear error when the design bridge is unavailable', async () => {
    const child = await runMcp({
      ND_DSH_DESIGN_MCP_URL: '',
      ND_DSH_DESIGN_MCP_TOKEN: '',
      ND_DSH_DESIGN_CWD: '',
    })
    request(child, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nd_design', arguments: { action: 'state' } } })
    const result = await readUntil(child, 4)
    expect(JSON.stringify(result)).toContain('design bridge is unavailable')
  })
})
