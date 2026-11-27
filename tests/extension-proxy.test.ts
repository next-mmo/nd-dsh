import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { cloneBuiltinExtensionDemos, type AgentExtensionManifest } from '../src/shared/extensions.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const HARNESS_ENGINE_ID = 'nd-harness'

const proxyScript = resolve('scripts/nd-extension-runtime.mjs')
const mcpScript = resolve('scripts/nd-extension-mcp.mjs')

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function enabledCounterCatalog() {
  const root = await mkdtemp(join(tmpdir(), 'nd-ext-proxy-'))
  roots.push(root)
  const catalog = join(root, 'agent-extensions.json')
  const state = join(root, 'agent-extension-state.json')
  const demos = cloneBuiltinExtensionDemos()
  const counter = demos.find((item) => item.id === 'demo-counter-mcp')!
  counter.enabled = true
  await writeFile(catalog, `${JSON.stringify({ version: 1, extensions: demos }, null, 2)}\n`, 'utf8')
  return { root, catalog, state }
}

async function customMcpCatalog() {
  const root = await mkdtemp(join(tmpdir(), 'nd-ext-custom-mcp-'))
  roots.push(root)
  const catalog = join(root, 'agent-extensions.json')
  const state = join(root, 'agent-extension-state.json')
  const server = join(root, 'fake-mcp.mjs')
  await writeFile(server, `
import { createInterface } from 'node:readline'
const lines = createInterface({ input: process.stdin })
const write = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') return write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
  if (message.method === 'notifications/initialized') return
  if (message.method === 'tools/list') return write({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'env_read', description: 'read allowed env', inputSchema: { type: 'object', properties: {} } }] } })
  if (message.method === 'tools/call') return write({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ allowed: process.env.ALLOWED_TOKEN, leaked: process.env.DISALLOWED_SECRET }) }] } })
})
`, 'utf8')
  const extension: AgentExtensionManifest = {
    id: 'custom-safe-mcp',
    name: 'Custom Safe MCP',
    description: 'environment isolation fixture',
    surface: 'mcp',
    version: '1.0.0',
    enabled: true,
    runtime: {
      kind: 'mcp-stdio',
      command: process.execPath,
      args: [server],
      env: { ALLOWED_TOKEN: 'ALLOWED_PARENT_TOKEN' },
    },
    engineRoutes: [],
    providerRoutes: [],
  }
  await writeFile(catalog, `${JSON.stringify({ version: 1, extensions: [extension] }, null, 2)}\n`, 'utf8')
  return { root, catalog, state }
}

async function runProxy(catalog: string, state: string, args: string[], extraEnv: Record<string, string> = {}) {
  const { stdout } = await execFileAsync(process.execPath, [proxyScript, ...args], {
    env: { ...process.env, ...extraEnv, ND_EXTENSION_CATALOG: catalog, ND_EXTENSION_STATE: state },
    timeout: 15_000,
  })
  return JSON.parse(stdout) as unknown
}

async function runGateway(catalog: string, state: string, messages: unknown[], args: string[] = [], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [mcpScript, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ND_EXTENSION_NODE: process.execPath,
      ND_EXTENSION_PROXY: proxyScript,
      ND_EXTENSION_CATALOG: catalog,
      ND_EXTENSION_STATE: state,
      ...env,
    },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`)
  child.stdin.end()
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP gateway did not exit')) }, 10_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolveExit()
      else reject(new Error(stderr || `gateway exited ${String(code)}`))
    })
  })
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as {
    id?: number
    result?: { tools?: Array<{ name: string }>; content?: Array<{ text?: string }> }
  })
}

describe('ND extension portable runtime', () => {
  it('lists the built-in Counter MCP contract', async () => {
    const { catalog, state } = await enabledCounterCatalog()
    const tools = await runProxy(catalog, state, ['list', 'demo-counter-mcp', HARNESS_ENGINE_ID]) as Array<{ name: string }>
    expect(tools.map((tool) => tool.name)).toEqual(['counter_get', 'counter_add', 'counter_reset'])
  })

  it('executes reset +3 +4 get through the same persisted counter state', async () => {
    const { catalog, state } = await enabledCounterCatalog()
    await runProxy(catalog, state, ['call', 'demo-counter-mcp', 'counter_reset', '{}', HARNESS_ENGINE_ID])
    await runProxy(catalog, state, ['call', 'demo-counter-mcp', 'counter_add', '{"amount":3}', HARNESS_ENGINE_ID])
    await runProxy(catalog, state, ['call', 'demo-counter-mcp', 'counter_add', '{"amount":4}', HARNESS_ENGINE_ID])
    const result = await runProxy(catalog, state, ['call', 'demo-counter-mcp', 'counter_get', '{}', HARNESS_ENGINE_ID]) as { content: Array<{ text: string }> }
    expect(result.content[0]?.text).toBe('7')
  })

  it('refuses tool execution after an extension is disabled in the catalog', async () => {
    const { catalog, state } = await enabledCounterCatalog()
    const snapshot = JSON.parse(await readFile(catalog, 'utf8')) as { extensions: Array<{ id: string; enabled: boolean }> }
    const counter = snapshot.extensions.find((item) => item.id === 'demo-counter-mcp')!
    counter.enabled = false
    await writeFile(catalog, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    await expect(runProxy(catalog, state, ['call', 'demo-counter-mcp', 'counter_get', '{}', HARNESS_ENGINE_ID])).rejects.toThrow(/disabled/i)
  })

  it('passes only safe base environment plus explicitly referenced secrets to custom MCP children', async () => {
    const { catalog, state } = await customMcpCatalog()
    const tools = await runProxy(catalog, state, ['list', 'custom-safe-mcp', HARNESS_ENGINE_ID], {
      ALLOWED_PARENT_TOKEN: 'allowed-value',
      DISALLOWED_SECRET: 'must-not-leak',
    }) as Array<{ name: string }>
    expect(tools[0]?.name).toBe('env_read')
    const result = await runProxy(catalog, state, ['call', 'custom-safe-mcp', 'env_read', '{}', HARNESS_ENGINE_ID], {
      ALLOWED_PARENT_TOKEN: 'allowed-value',
      DISALLOWED_SECRET: 'must-not-leak',
    }) as { content: Array<{ text: string }> }
    const observed = JSON.parse(result.content[0]!.text) as { allowed?: string; leaked?: string }
    expect(observed.allowed).toBe('allowed-value')
    expect(observed).not.toHaveProperty('leaked')
  })

  it('keeps the Harness MCP tool catalog stable while extensions change underneath it', async () => {
    const { catalog, state } = await enabledCounterCatalog()
    const replies = await runGateway(catalog, state, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ])
    const names = replies.find((reply) => reply.id === 2)?.result?.tools?.map((tool) => tool.name)
    expect(names).toEqual(['nd_extension_list', 'nd_browser_call', 'nd_extension_call'])
  })

  it('limits Antigravity to browser tools and delivers screenshot pixels with frame coordinates', async () => {
    const { root, catalog, state } = await enabledCounterCatalog()
    const runtime = join(root, 'browser.mjs')
    await writeFile(runtime, `export async function request() {
      return { frameId: 'test-frame', viewport: { width: 320, height: 200 }, dataUrl: 'data:image/png;base64,dGVzdA==' }
    }`)
    const replies = await runGateway(catalog, state, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nd_browser_call', arguments: { method: 'browser.screenshot' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nd_extension_list', arguments: {} } },
    ], ['--browser-only'], { ND_BROWSER_COMPANION_RUNTIME: runtime })
    expect(replies.find(reply => reply.id === 1)?.result?.tools?.map(tool => tool.name)).toEqual(['nd_browser_call'])
    const content = replies.find(reply => reply.id === 2)?.result?.content
    expect(JSON.parse(content?.[0]?.text ?? '{}')).toEqual({ frameId: 'test-frame', viewport: { width: 320, height: 200 } })
    expect(content?.[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'dGVzdA==' })
    expect(replies.find(reply => reply.id === 3)?.result).toMatchObject({ isError: true })
  })

  it('forwards routed MCP call results as native gateway content', async () => {
    const { catalog, state } = await enabledCounterCatalog()
    const replies = await runGateway(catalog, state, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: {
          name: 'nd_extension_call',
          arguments: { extensionId: 'demo-counter-mcp', toolName: 'counter_reset', arguments: {} },
        },
      },
    ])
    expect(replies.find((reply) => reply.id === 3)?.result?.content?.[0]?.text).toBe('0')
  })
})
