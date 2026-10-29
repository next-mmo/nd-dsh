import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesignAgentBridge } from '../src/main/design/design-agent-bridge.js'

const bridges: DesignAgentBridge[] = []

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.destroy()))
})

describe('ND Pencil design bridge', () => {
  it('authenticates loopback calls and forwards the typed design action', async () => {
    const call = vi.fn(async () => ({ open: true, outline: [] }))
    const bridge = new DesignAgentBridge({ call } as never, 'C:/repo/scripts/nd-design-mcp.mjs')
    bridges.push(bridge)
    await bridge.start()
    const url = process.env.ND_DSH_DESIGN_MCP_URL!
    const token = process.env.ND_DSH_DESIGN_MCP_TOKEN!
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(token.length).toBeGreaterThan(20)

    const unauthorized = await fetch(`${url}/nd-design`, { method: 'POST', body: '{}' })
    expect(unauthorized.status).toBe(401)

    const response = await fetch(`${url}/nd-design`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ cwd: 'C:/repo', action: 'state', args: { action: 'state' } }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, result: { open: true, outline: [] } })
    expect(call).toHaveBeenCalledWith({
      sessionCwd: 'C:/repo',
      action: 'state',
      args: { action: 'state' },
    })
  })

  it('rejects a bridge call when the tool refuses the session workspace', async () => {
    const bridge = new DesignAgentBridge({ call: async () => { throw new Error('ND Pencil can only be edited from the active project root') } } as never, 'entry')
    bridges.push(bridge)
    await bridge.start()
    const response = await fetch(`${process.env.ND_DSH_DESIGN_MCP_URL}/nd-design`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.ND_DSH_DESIGN_MCP_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: 'C:/worktree', action: 'state', args: {} }),
    })
    expect(response.status).toBe(400)
    const payload = await response.json() as { ok: boolean; error: string }
    expect(payload.ok).toBe(false)
    expect(payload.error).toMatch(/active project root/)
  })
})
