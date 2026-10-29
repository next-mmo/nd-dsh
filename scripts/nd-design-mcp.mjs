#!/usr/bin/env node
/**
 * ND Pencil design MCP bridge.
 *
 * The default ND Harness is the agent route; it does not have in-process access
 * to ND's design session. This stdio MCP server forwards one typed tool to the
 * main-process design bridge over loopback. The bridge is the only mutation
 * path: raw .op writes remain blocked, and the main process validates every
 * command against the active project document.
 */
const BRIDGE_URL = process.env.ND_DSH_DESIGN_MCP_URL?.trim() ?? ''
const BRIDGE_TOKEN = process.env.ND_DSH_DESIGN_MCP_TOKEN?.trim() ?? ''
const HARNESS_CWD = process.env.ND_DSH_DESIGN_CWD?.trim() ?? ''

const TOOLS = [
  {
    name: 'nd_design',
    description:
      'Read or edit the live ND Pencil canvas through ND\'s controlled design session. Use action=state first; then action=apply with insert/update/delete/reorder/group/ungroup commands. Never write .op files with workspace tools.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['state', 'open', 'create', 'apply', 'undo', 'redo', 'save', 'export'],
          description: 'Design session action. Mutations use apply with commands.',
        },
        path: {
          type: 'string',
          description: 'Workspace-relative .op path for open/create.',
        },
        name: {
          type: 'string',
          description: 'Optional document name for create.',
        },
        commands: {
          type: 'array',
          maxItems: 100,
          items: { type: 'object' },
          description: 'Command batch for apply. Coordinates are absolute page coordinates.',
        },
        format: {
          type: 'string',
          enum: ['spec', 'svg'],
          description: 'Export format; writes under .nd/design/.build/.',
        },
      },
      required: ['action'],
    },
  },
]

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function dispatchTool(name, args) {
  if (name !== 'nd_design') throw new Error(`unknown tool: ${name}`)
  if (!BRIDGE_URL || !BRIDGE_TOKEN || !HARNESS_CWD) {
    throw new Error('ND Pencil design bridge is unavailable. Open ND Pencil and retry.')
  }
  const action = typeof args?.action === 'string' ? args.action : ''
  if (!action) throw new Error('nd_design action is required')
  const response = await fetch(`${BRIDGE_URL.replace(/\/$/, '')}/nd-design`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${BRIDGE_TOKEN}`,
    },
    body: JSON.stringify({ cwd: HARNESS_CWD, action, args }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload || payload.ok !== true) {
    throw new Error(payload?.error ?? `ND Pencil bridge answered HTTP ${response.status}`)
  }
  return payload.result
}

async function handleMessage(message) {
  if (message.method === 'initialize') {
    writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'nd-pencil-design', version: '2.0.0' },
      },
    })
    return
  }
  if (message.method === 'notifications/initialized') return
  if (message.method === 'tools/list') {
    writeMessage({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })
    return
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name
    try {
      const value = await dispatchTool(name, message.params?.arguments ?? {})
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      writeMessage({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } })
    } catch (error) {
      writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: { isError: true, content: [{ type: 'text', text: `error: ${error instanceof Error ? error.message : String(error)}` }] },
      })
    }
    return
  }
  if (typeof message.id === 'number') {
    writeMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })
  }
}

function runMcpServer() {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      handleMessage(message).catch((error) => {
        if (typeof message.id === 'number') {
          writeMessage({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: `tool error: ${error instanceof Error ? error.message : String(error)}` }] } })
        }
      })
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

if (process.argv[2] === 'mcp') {
  runMcpServer()
} else {
  console.error('usage: nd-design-mcp.mjs mcp')
  process.exit(1)
}
