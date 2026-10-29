import { describe, expect, it, vi } from 'vitest'
import { NdNativeToolBroker } from '../src/main/engines/nd-native/nd-native-tool-broker.js'
import { BUILTIN_BROWSER_TARGET_ID } from '../src/main/browser/browser-controller.js'

const project = 'C:/projects/nd-app'

function fixture(cwd = project) {
  const request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'workspace.read') return { root: params.root, path: params.path, data: 'hello' }
    return { ok: true }
  })
  const callAgent = vi.fn(async () => ({ ok: true }))
  const broker = new NdNativeToolBroker({
    core: { request } as never,
    browser: { callAgent, issueSessionAccess: () => 'opaque-test-token' } as never,
    workspace: { state: () => ({ root: project }) } as never,
    ownsWorktree: () => false,
    engine: () => ({ listSessions: () => [{ sessionId: 'nd-native-one', cwd }] }) as never,
  })
  return { broker, request, callAgent }
}

describe('ND Agent trusted tool broker', () => {
  it('rejects a forged session workspace before any effect is journaled', async () => {
    const { broker, request } = fixture()
    await expect(broker.call({ sessionId: 'nd-native-one', cwd: 'C:/elsewhere', name: 'nd_workspace_read', arguments: { path: 'a.txt' } })).rejects.toThrow(/workspace-bound/)
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects a stored session outside the active project', async () => {
    const { broker, request } = fixture('C:/projects/other')
    await expect(broker.call({ sessionId: 'nd-native-one', cwd: 'C:/projects/other', name: 'nd_workspace_read', arguments: { path: 'a.txt' } })).rejects.toThrow(/outside the active project/)
    expect(request).not.toHaveBeenCalled()
  })

  it('journals before calling the bounded core workspace reader', async () => {
    const { broker, request } = fixture()
    await broker.call({ sessionId: 'nd-native-one', cwd: project, name: 'nd_workspace_read', arguments: { path: 'a.txt' } })
    expect(request.mock.calls.map(([method]) => method)).toEqual(['effectJournal.append', 'workspace.read', 'effectJournal.append'])
    expect(request.mock.calls[0]?.[1].state).toBe('intent')
    expect(request.mock.calls[2]?.[1].state).toBe('complete')
    expect(request.mock.calls[2]?.[1].idempotencyKey).toBe(request.mock.calls[0]?.[1].idempotencyKey)
    expect(request.mock.calls[1]?.[1]).toMatchObject({ root: project, path: 'a.txt', maxBytes: 1024 * 1024 })
  })

  it('journals and dispatches an atomic workspace write only after workspace validation', async () => {
    const { broker, request } = fixture()
    await broker.call({
      sessionId: 'nd-native-one',
      cwd: project,
      name: 'nd_workspace_write',
      arguments: { path: 'src/app.ts', data: 'export const ok = true\n' },
    })
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'effectJournal.append',
      'workspace.write',
      'effectJournal.append',
    ])
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      root: project,
      path: 'src/app.ts',
      data: 'export const ok = true\n',
    })
  })

  it('rejects workspace-write traversal before ND Core sees the write', async () => {
    const { broker, request } = fixture()
    await expect(broker.call({
      sessionId: 'nd-native-one',
      cwd: project,
      name: 'nd_workspace_write',
      arguments: { path: '../outside.txt', data: 'blocked' },
    })).rejects.toThrow(/escapes the session root/)
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'effectJournal.append',
      'effectJournal.append',
    ])
  })

  it('blocks generic workspace writes to ND Pencil documents', async () => {
    const { broker, request } = fixture()
    await expect(broker.call({
      sessionId: 'nd-native-one',
      cwd: project,
      name: 'nd_workspace_write',
      arguments: { path: '.nd/design/home.op', data: '{}' },
    })).rejects.toThrow(/nd_design/)
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'effectJournal.append',
      'effectJournal.append',
    ])
    expect(request.mock.calls[1]?.[1].state).toBe('failed')
  })

  it('routes ND Pencil mutations through the injected design bridge', async () => {
    const { broker, request } = fixture()
    const design = { call: vi.fn(async () => ({ revision: 3, changedIds: ['n1'] })) }
    broker.setDesignAgentTool(design as never)
    await expect(broker.call({
      sessionId: 'nd-native-one',
      cwd: project,
      name: 'nd_design',
      arguments: { action: 'apply', commands: [{ op: 'delete', ids: ['n1'] }] },
    })).resolves.toEqual({ revision: 3, changedIds: ['n1'] })
    expect(design.call).toHaveBeenCalledWith({
      sessionCwd: project,
      action: 'apply',
      args: { action: 'apply', commands: [{ op: 'delete', ids: ['n1'] }] },
    })
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'effectJournal.append',
      'effectJournal.append',
    ])
  })

  it('limits Git to broker-constructed workspace operations', async () => {
    const { broker, request } = fixture()
    await broker.call({
      sessionId: 'nd-native-one',
      cwd: project,
      name: 'nd_git',
      arguments: { operation: 'diff', path: 'src/app.ts' },
    })
    expect(request.mock.calls[1]).toEqual([
      'git.exec',
      expect.objectContaining({ cwd: project, args: ['diff', '--', 'src/app.ts'] }),
      30_000,
    ])
    await expect(broker.call({
      sessionId: 'nd-native-one',
      cwd: project,
      name: 'nd_git',
      arguments: { operation: 'commit', message: 'unsafe' },
    })).rejects.toThrow(/not allowed/)
  })

  it('routes extension calls through the injected governed policy bridge', async () => {
    const { broker } = fixture()
    const invoke = vi.fn(async () => ({ ok: true, value: { items: [] } }))
    broker.setExtensionInvoker(invoke)
    await expect(broker.call({
      sessionId: 'nd-native-one',
      cwd: project,
      name: 'nd_extension_call',
      arguments: { extensionId: 'example.tools', contributionId: 'project.read', input: { query: 'todo' } },
    })).resolves.toEqual({ ok: true, value: { items: [] } })
    expect(invoke).toHaveBeenCalledWith({
      sessionId: 'nd-native-one',
      cwd: project,
      worktree: false,
      extensionId: 'example.tools',
      contributionId: 'project.read',
      input: { query: 'todo' },
    })
  })

  it('injects browser access in the trusted host and blocks other method families', async () => {
    const { broker, callAgent } = fixture()
    await broker.call({ sessionId: 'nd-native-one', cwd: project, name: 'nd_browser_call', arguments: { method: 'browser.targets', params: {} } })
    expect(callAgent).toHaveBeenCalledWith('browser.targets', { targetId: BUILTIN_BROWSER_TARGET_ID, accessToken: 'opaque-test-token' })
    await expect(broker.call({ sessionId: 'nd-native-one', cwd: project, name: 'nd_browser_call', arguments: { method: 'admin.shutdown', params: {} } })).rejects.toThrow(/invalid/)
    expect(callAgent).toHaveBeenCalledTimes(1)
  })

  it('fails closed for shell because cwd is not an OS sandbox', async () => {
    const { broker } = fixture()
    await expect(broker.call({ sessionId: 'nd-native-one', cwd: project, name: 'nd_shell', arguments: { command: 'echo hello' } })).rejects.toThrow(/not an OS sandbox/)
  })

  it('marks a dispatched write uncertain when the host response fails', async () => {
    const { broker, request } = fixture()
    request.mockImplementation(async (method: string) => {
      if (method === 'workspace.write') throw new Error('core transport closed')
      return { ok: true }
    })
    await expect(broker.call({
      sessionId: 'nd-native-one',
      cwd: project,
      name: 'nd_workspace_write',
      arguments: { path: 'src/app.ts', data: 'changed' },
    })).rejects.toThrow(/transport closed/)
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'effectJournal.append',
      'workspace.write',
      'effectJournal.append',
    ])
    expect(request.mock.calls[2]?.[1]).toMatchObject({ state: 'uncertain' })
  })

  it('keeps a pre-dispatch write validation error definite', async () => {
    const { broker, request } = fixture()
    await expect(broker.call({
      sessionId: 'nd-native-one',
      cwd: project,
      name: 'nd_workspace_write',
      arguments: { path: '../outside.txt', data: 'blocked' },
    })).rejects.toThrow(/escapes the session root/)
    expect(request.mock.calls[1]?.[1]).toMatchObject({ state: 'failed' })
  })

  it('marks an interrupted effect uncertain without dispatching the tool again', async () => {
    const { broker, request } = fixture()
    request.mockImplementation(async (method: string) => {
      if (method === 'effectJournal.replay') return {
        records: [{ seq: 1, kind: 'nd-agent.tool', state: 'intent', resourceId: 'nd-native-one', idempotencyKey: 'nd-agent:one', data: { name: 'nd_browser_call' } }],
        truncated: false,
      }
      return { ok: true }
    })
    await expect(broker.reconcile()).resolves.toBe(1)
    expect(request.mock.calls.map(([method]) => method)).toEqual(['effectJournal.replay', 'effectJournal.append'])
    expect(request.mock.calls[1]?.[1]).toMatchObject({ state: 'uncertain', idempotencyKey: 'nd-agent:one' })
  })
})
