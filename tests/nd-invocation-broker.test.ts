import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DAILY_ESSENTIALS_MANIFEST, PROJECT_WORKFLOW_MANIFEST, WALLPAPER_MANAGER_MANIFEST } from '../src/shared/builtin-extension-packages.js'
import { ND_EXTENSION_API_VERSION, ND_EXTENSION_PROTOCOL, type NdExtensionManifest } from '../src/shared/extension-package.js'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { NativeHostRegistry } from '../src/main/extensions/native-host.js'
import { InvocationBroker, type NdOrganizationPort } from '../src/main/extensions/invocation-broker.js'

let root: string
let packages: ExtensionPackageStore
let state: InvocationStateStore
let host: NativeHostRegistry
let broker: InvocationBroker
let calls: Array<{ host: string; input: Record<string, unknown>; contextKey: string }>
let policyEffect: 'allow' | 'ask' | 'deny'

const organization: NdOrganizationPort = {
  state: async () => ({
    companies: [{ id: 'c1' } as never],
    projects: [{ id: 'p1', companyId: 'c1' } as never],
    memory: [],
  }),
  policy: async () => policyEffect,
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nd-broker-'))
  packages = new ExtensionPackageStore(join(root, 'packages'))
  state = new InvocationStateStore(join(root, 'state'))
  host = new NativeHostRegistry()
  calls = []
  policyEffect = 'allow'
  for (const method of ['note.create', 'note.search', 'capture.screen', 'clipboard.read', 'workflow.list', 'os.wallpaper.chooseAndSet', 'os.wallpaper.next', 'os.wallpaper.previous', 'os.wallpaper.random', 'os.wallpaper.folders.add', 'os.wallpaper.status', 'os.wallpaper.preview', 'os.wallpaper.applySelected'] as const) {
    host.register(method, async (input, context) => {
      calls.push({ host: method, input, contextKey: context.context.kind })
      if (method === 'os.wallpaper.status') {
        return [{ id: 'mountains.jpg', title: 'mountains.jpg', detail: '1024 KB' }]
      }
      return { ok: true, method }
    })
  }
  await packages.registerBuiltin(DAILY_ESSENTIALS_MANIFEST)
  await packages.registerBuiltin(WALLPAPER_MANAGER_MANIFEST)
  await packages.registerBuiltin(PROJECT_WORKFLOW_MANIFEST)
  broker = new InvocationBroker({ packages, state, host, organization })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const personal = { kind: 'personal' } as const
const company = { kind: 'company', companyId: 'c1' } as const
const project = { kind: 'project', companyId: 'c1', projectId: 'p1' } as const

const EXECUTABLE_TOOL_MANIFEST: NdExtensionManifest = {
  protocol: ND_EXTENSION_PROTOCOL,
  id: 'nd.test-executable-tool',
  name: 'Executable Tool Test',
  description: 'Test-only MCP tool package.',
  version: '1.0.0',
  apiVersion: ND_EXTENSION_API_VERSION,
  contexts: ['personal'],
  permissions: [],
  settings: [],
  contributions: {
    tools: [{ id: 'echo-tool', title: 'Echo tool', contexts: ['personal'], toolName: 'echo' }],
    skills: [],
    commands: [],
    views: [],
    workflows: [],
  },
  executable: { kind: 'mcp-stdio', command: 'node', args: ['tool.js'], env: {} },
}

function invoke(overrides: Partial<Parameters<InvocationBroker['invoke']>[0]>) {
  return broker.invoke({
    extensionId: DAILY_ESSENTIALS_MANIFEST.id,
    contributionId: 'quick-note',
    contributionKind: 'command',
    context: personal,
    caller: 'user',
    input: { text: 'hello' },
    ...overrides,
  })
}

describe('InvocationBroker authorization', () => {
  it('lists nothing until the package is activated in that context', async () => {
    expect(await broker.commands(personal)).toEqual([])
    await state.setActivation(DAILY_ESSENTIALS_MANIFEST.id, personal, true)
    const commands = await broker.commands(personal)
    expect(commands.map((command) => command.contributionId)).toContain('quick-note')

    await state.setActivation(PROJECT_WORKFLOW_MANIFEST.id, project, true)
    expect((await broker.commands(personal)).map((command) => command.extensionId)).not.toContain(PROJECT_WORKFLOW_MANIFEST.id)
    expect((await broker.commands(project)).map((command) => command.extensionId)).toContain(PROJECT_WORKFLOW_MANIFEST.id)
  })

  it('keeps wallpaper personal and requires an explicit agent approval', async () => {
    await state.setActivation(WALLPAPER_MANAGER_MANIFEST.id, personal, true)

    const user = await broker.invoke({
      extensionId: WALLPAPER_MANAGER_MANIFEST.id,
      contributionId: 'choose-wallpaper',
      contributionKind: 'command',
      context: personal,
      caller: 'user',
      input: {},
    })
    expect(user.ok).toBe(true)
    expect(calls.at(-1)?.host).toBe('os.wallpaper.chooseAndSet')

    const agent = await broker.invoke({
      extensionId: WALLPAPER_MANAGER_MANIFEST.id,
      contributionId: 'choose-wallpaper',
      contributionKind: 'command',
      context: personal,
      caller: 'agent',
      input: {},
    })
    expect(agent).toMatchObject({ ok: false, error: { code: 'approval-required' } })

    const wrongContext = await broker.invoke({
      extensionId: WALLPAPER_MANAGER_MANIFEST.id,
      contributionId: 'choose-wallpaper',
      contributionKind: 'command',
      context: company,
      caller: 'user',
      input: {},
    })
    expect(wrongContext).toMatchObject({ ok: false, error: { code: 'denied' } })
  })

  it('supports wallpaper cycling commands and loads the wallpaper-studio detail view', async () => {
    await state.setActivation(WALLPAPER_MANAGER_MANIFEST.id, personal, true)

    const next = await broker.invoke({
      extensionId: WALLPAPER_MANAGER_MANIFEST.id,
      contributionId: 'next-wallpaper',
      contributionKind: 'command',
      context: personal,
      caller: 'user',
      input: {},
    })
    expect(next.ok).toBe(true)
    expect(calls.at(-1)?.host).toBe('os.wallpaper.next')

    const setFolder = await broker.invoke({
      extensionId: WALLPAPER_MANAGER_MANIFEST.id,
      contributionId: 'set-wallpaper-folder',
      contributionKind: 'command',
      context: personal,
      caller: 'user',
      input: {},
    })
    expect(setFolder.ok).toBe(true)
    expect(calls.at(-1)?.host).toBe('os.wallpaper.folders.add')

    const previous = await broker.invoke({
      extensionId: WALLPAPER_MANAGER_MANIFEST.id,
      contributionId: 'previous-wallpaper',
      contributionKind: 'command',
      context: personal,
      caller: 'user',
      input: {},
    })
    expect(previous.ok).toBe(true)
    expect(calls.at(-1)?.host).toBe('os.wallpaper.previous')

    const view = await broker.loadView(WALLPAPER_MANAGER_MANIFEST.id, 'wallpaper-studio', personal)
    expect(view.kind).toBe('detail')
    expect(view.title).toBe('Wallpaper Studio')
    expect(view.rows).toHaveLength(1)
    expect(view.rows[0]?.title).toBe('mountains.jpg')
    expect(view.actions.map((a) => a.id)).toContain('apply')
    expect(view.actions.map((a) => a.id)).toContain('prev')
    expect(view.actions.map((a) => a.id)).toContain('next')
    expect(view.actions.map((a) => a.id)).toContain('random')
    expect(view.actions.map((a) => a.id)).toContain('preview')
  })

  it('denies an unknown package or contribution', async () => {
    expect(await invoke({ extensionId: 'nd.missing' })).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    await state.setActivation(DAILY_ESSENTIALS_MANIFEST.id, personal, true)
    expect(await invoke({ contributionId: 'nope' })).toMatchObject({ ok: false, error: { code: 'invalid' } })
  })

  it('denies a context the contribution does not support', async () => {
    await state.setActivation(PROJECT_WORKFLOW_MANIFEST.id, personal, true)
    const result = await broker.invoke({
      extensionId: PROJECT_WORKFLOW_MANIFEST.id,
      contributionId: 'repository-tasks',
      contributionKind: 'view',
      context: personal,
      caller: 'user',
      input: {},
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'denied' } })
    expect(calls).toHaveLength(0)
  })

  it('denies an unactivated context and a mismatched company/project pair', async () => {
    await state.setActivation(DAILY_ESSENTIALS_MANIFEST.id, personal, true)
    expect(await invoke({ context: company })).toMatchObject({ ok: false, error: { code: 'denied' } })

    await state.setActivation(DAILY_ESSENTIALS_MANIFEST.id, project, true)
    const mismatched = await invoke({ context: { kind: 'project', companyId: 'c1', projectId: 'other' } })
    expect(mismatched).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(calls).toHaveLength(0)
  })

  it('runs a user invocation through the allowlisted host method', async () => {
    await state.setActivation(DAILY_ESSENTIALS_MANIFEST.id, personal, true)
    const result = await invoke({ input: { text: 'buy milk' } })
    expect(result.ok).toBe(true)
    expect(calls).toEqual([{ host: 'note.create', input: { text: 'buy milk' }, contextKey: 'personal' }])
  })

  it('deny wins over a user-level request', async () => {
    await state.setActivation(DAILY_ESSENTIALS_MANIFEST.id, company, true)
    policyEffect = 'deny'
    const result = await invoke({ context: company })
    expect(result).toMatchObject({ ok: false, error: { code: 'denied' } })
    expect(calls).toHaveLength(0)
  })

  it('requires an agent grant: pending approval, then one-shot consumption', async () => {
    await state.setActivation(DAILY_ESSENTIALS_MANIFEST.id, personal, true)
    const first = await invoke({ caller: 'agent', input: { text: 'auto' } })
    expect(first).toMatchObject({ ok: false, error: { code: 'approval-required' } })
    const approvalId = (first.value as { approvalId: string }).approvalId
    expect(broker.pendingApprovals()).toHaveLength(1)

    const approved = await broker.approve(approvalId)
    expect(approved.ok).toBe(true)
    expect(broker.pendingApprovals()).toHaveLength(0)

    const second = await invoke({ caller: 'agent', input: { text: 'auto again' } })
    expect(second).toMatchObject({ ok: false, error: { code: 'approval-required' } })
  })

  it('remembers a grant when the user allows it and revoking it fails closed again', async () => {
    await state.setActivation(DAILY_ESSENTIALS_MANIFEST.id, personal, true)
    const first = await invoke({ caller: 'agent', input: { text: 'auto' } })
    const approvalId = (first.value as { approvalId: string }).approvalId
    await broker.approve(approvalId, true)

    expect((await invoke({ caller: 'agent', input: { text: 'again' } })).ok).toBe(true)
    const grants = await state.grants()
    expect(grants).toHaveLength(1)
    await state.revokeGrant(grants[0]!.id)
    expect(await invoke({ caller: 'agent', input: { text: 'third' } })).toMatchObject({ ok: false, error: { code: 'approval-required' } })
  })

  it('binds agent calls to the run credential context and permitted capabilities', async () => {
    await state.setActivation(DAILY_ESSENTIALS_MANIFEST.id, personal, true)
    await state.setActivation(DAILY_ESSENTIALS_MANIFEST.id, company, true)
    const credential = broker.mintRunCredential({ sessionId: 'sess-1', engineId: 'nd-harness', context: company, allowed: ['note.create'] })
    const allowed = await broker.invokeAsAgent({ token: credential.token, extensionId: DAILY_ESSENTIALS_MANIFEST.id, contributionId: 'quick-note', input: { text: 'from agent' } })
    expect(allowed.ok).toBe(true)
    expect(calls.at(-1)?.contextKey).toBe('company')

    const outside = await broker.invokeAsAgent({ token: credential.token, extensionId: DAILY_ESSENTIALS_MANIFEST.id, contributionId: 'capture-screen', input: {} })
    expect(outside).toMatchObject({ ok: false, error: { code: 'denied' } })

    broker.revokeSessionCredentials('sess-1')
    const revoked = await broker.invokeAsAgent({ token: credential.token, extensionId: DAILY_ESSENTIALS_MANIFEST.id, contributionId: 'quick-note', input: { text: 'late' } })
    expect(revoked).toMatchObject({ ok: false, error: { code: 'denied' } })
  })

  it('does not misroute executable MCP tool contributions through native host placeholders', async () => {
    await packages.registerBuiltin(EXECUTABLE_TOOL_MANIFEST)
    await state.setActivation(EXECUTABLE_TOOL_MANIFEST.id, personal, true)
    const credential = broker.mintRunCredential({ sessionId: 'sess-tool', engineId: 'nd-native', context: personal })
    const result = await broker.invokeAsAgent({
      token: credential.token,
      extensionId: EXECUTABLE_TOOL_MANIFEST.id,
      contributionId: 'echo-tool',
      input: { text: 'hello' },
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(calls).toHaveLength(0)
  })

  it('expires run credentials and rejects unknown tokens', async () => {
    const expired = broker.mintRunCredential({ sessionId: 'sess-2', engineId: 'nd-harness', context: personal, ttlMs: -1 })
    expect(broker.redeemRunCredential(expired.token)).toBeUndefined()
    expect(await broker.invokeAsAgent({ token: 'ndrun_unknown', extensionId: DAILY_ESSENTIALS_MANIFEST.id, contributionId: 'quick-note', input: {} }))
      .toMatchObject({ ok: false, error: { code: 'denied' } })
  })

  it('records content-free audit rows for allowed and denied decisions', async () => {
    await state.setActivation(DAILY_ESSENTIALS_MANIFEST.id, personal, true)
    await invoke({ input: { text: 'super-secret-note-body' } })
    await invoke({ caller: 'agent', input: { text: 'agent-secret-body' } })
    const audit = await state.audit()
    expect(audit.length).toBeGreaterThanOrEqual(2)
    expect(audit.some((entry) => entry.decision === 'allowed')).toBe(true)
    expect(audit.some((entry) => entry.decision === 'approval-required')).toBe(true)
    const serialized = JSON.stringify(audit)
    expect(serialized).not.toContain('super-secret-note-body')
    expect(serialized).not.toContain('agent-secret-body')
  })

  it('runs a declared view action through the same authorization path', async () => {
    await state.setActivation(DAILY_ESSENTIALS_MANIFEST.id, personal, true)
    const result = await broker.invoke({
      extensionId: DAILY_ESSENTIALS_MANIFEST.id,
      contributionId: 'notes',
      contributionKind: 'view',
      context: personal,
      caller: 'user',
      input: { action: 'note-delete', noteId: 'note-1' },
    })
    // note.delete is declared by the package, so the action resolves to that
    // host method — which this test registry intentionally does not implement.
    expect(result).toMatchObject({ ok: false, error: { code: 'failed' } })
  })

  it('invokes previous-wallpaper command and prev & preview view actions in personal context', async () => {
    await state.setActivation(WALLPAPER_MANAGER_MANIFEST.id, personal, true)

    // 1. previous-wallpaper command
    const cmdResult = await broker.invoke({
      extensionId: WALLPAPER_MANAGER_MANIFEST.id,
      contributionId: 'previous-wallpaper',
      contributionKind: 'command',
      context: personal,
      caller: 'user',
      input: {},
    })
    expect(cmdResult).toMatchObject({ ok: true, value: { ok: true, method: 'os.wallpaper.previous' } })

    // 2. prev view action
    const prevActionResult = await broker.invoke({
      extensionId: WALLPAPER_MANAGER_MANIFEST.id,
      contributionId: 'wallpaper-studio',
      contributionKind: 'view',
      context: personal,
      caller: 'user',
      input: { action: 'prev' },
    })
    expect(prevActionResult).toMatchObject({ ok: true, value: { ok: true, method: 'os.wallpaper.previous' } })

    // 3. preview view action
    const previewActionResult = await broker.invoke({
      extensionId: WALLPAPER_MANAGER_MANIFEST.id,
      contributionId: 'wallpaper-studio',
      contributionKind: 'view',
      context: personal,
      caller: 'user',
      input: { action: 'preview', id: 'lake.png' },
    })
    expect(previewActionResult).toMatchObject({ ok: true, value: { ok: true, method: 'os.wallpaper.preview' } })
  })
})

