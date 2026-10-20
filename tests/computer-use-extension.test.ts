import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { NativeHostRegistry } from '../src/main/extensions/native-host.js'
import { InvocationBroker, type NdOrganizationPort } from '../src/main/extensions/invocation-broker.js'
import { manifestPermissionIssues, validateNdExtensionManifest, type NdExtensionManifest } from '../src/shared/extension-package.js'
import { personalContext } from '../src/shared/nd-context.js'

const packagePath = fileURLToPath(new URL('../extensions/nd-computer-use/', import.meta.url))
const manifestPath = new URL('../extensions/nd-computer-use/nd-extension.json', import.meta.url)

async function loadManifest(): Promise<NdExtensionManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const result = validateNdExtensionManifest(parsed)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  return result.manifest
}

const organization: NdOrganizationPort = {
  state: async () => ({
    companies: [{ id: 'c1' } as never],
    projects: [{ id: 'p1', companyId: 'c1' } as never],
    memory: [],
  }),
}

describe('ND Computer Use extension package', () => {
  it('validates as a Personal-only, read-only web-view package', async () => {
    const manifest = await loadManifest()
    expect(manifest.id).toBe('nd.computer-use')
    expect(manifest.contexts).toEqual(['personal'])
    expect(manifest.permissions).toEqual(['computer.read'])
    expect(manifest.executable).toBeUndefined()
    expect(manifestPermissionIssues(manifest)).toEqual([])

    const [view] = manifest.contributions.views
    expect(view?.kind).toBe('web')
    expect(view?.entry).toBe('ui/index.html')
    expect(view?.host).toBeUndefined()
    expect(view?.actions.map((action) => [action.id, action.host])).toEqual([
      ['apps', 'computer.apps.list'],
      ['state', 'computer.app.state'],
    ])
    expect(manifest.contributions.commands[0]?.openViewId).toBe('computer-use')
    expect(manifest.contributions.commands[0]?.host).toBe('computer.apps.list')
  })

  it('installs the shipped UI assets, activates, and uninstalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-computer-use-'))
    try {
      const packages = new ExtensionPackageStore(root)
      const installed = await packages.installFromDirectory(packagePath, { expectId: 'nd.computer-use' })
      expect(installed.id).toBe('nd.computer-use')
      for (const asset of ['ui/index.html', 'ui/app.js', 'ui/core.js', 'ui/core.d.ts']) {
        expect(await packages.snapshotFileFor('nd.computer-use', installed.version, asset)).not.toBeNull()
      }

      const state = new InvocationStateStore(root)
      expect(await state.activation('nd.computer-use', personalContext())).toBeUndefined()
      await state.setActivation('nd.computer-use', personalContext(), true)
      expect((await state.activation('nd.computer-use', personalContext()))?.enabled).toBe(true)

      await packages.uninstall('nd.computer-use')
      expect(await packages.activeManifest('nd.computer-use')).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('ND Computer Use broker gating', () => {
  let root: string
  let packages: ExtensionPackageStore
  let state: InvocationStateStore
  let host: NativeHostRegistry
  let broker: InvocationBroker
  let calls: { method: string; input: Record<string, unknown> }[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nd-computer-use-broker-'))
    packages = new ExtensionPackageStore(join(root, 'packages'))
    state = new InvocationStateStore(join(root, 'state'))
    host = new NativeHostRegistry()
    calls = []
    for (const method of ['computer.apps.list', 'computer.app.state'] as const) {
      host.register(method, async (input) => {
        calls.push({ method, input: { ...input } })
        return method === 'computer.apps.list'
          ? { apps: [], truncated: false }
          : { app: { id: 'win32:notepad', displayName: 'notepad' }, window: { id: 'win32:1:2' }, screenshots: [], accessibility: { tree: '[0] Window' }, textMode: 'full', stateId: 'abc', stats: { nodes: 1, truncated: false, elapsedMs: 1 }, limits: { maxNodes: 1500, maxDepth: 24, maxTextChars: 48_000, maxScreenshotBytes: 131_072 } }
      })
    }
    await packages.registerBuiltin(await loadManifest())
    broker = new InvocationBroker({ packages, state, host, organization })
    await state.setActivation('nd.computer-use', personalContext(), true)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const invoke = (overrides: Partial<Parameters<InvocationBroker['invoke']>[0]>) =>
    broker.invoke({
      extensionId: 'nd.computer-use',
      contributionId: 'computer-use',
      contributionKind: 'view',
      context: personalContext(),
      caller: 'user',
      input: {},
      ...overrides,
    })

  it('loads the web view without running a host method', async () => {
    const view = await broker.loadView('nd.computer-use', 'computer-use', personalContext())
    expect(view).toMatchObject({ kind: 'web', extensionId: 'nd.computer-use', viewId: 'computer-use' })
    expect(view.webView?.entry).toBe('ui/index.html')
    expect(view.rows).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses to load before activation', async () => {
    await state.setActivation('nd.computer-use', personalContext(), false)
    await expect(broker.loadView('nd.computer-use', 'computer-use', personalContext())).rejects.toThrow(/Activate/)
    expect(calls).toEqual([])
  })

  it('routes both read actions to their hosts', async () => {
    const apps = await invoke({ input: { action: 'apps' } })
    expect(apps).toMatchObject({ ok: true })
    const read = await invoke({ input: { action: 'state', app: 'win32:notepad', windowId: 'win32:1:2', includeText: true } })
    expect(read).toMatchObject({ ok: true })
    expect(calls).toEqual([
      { method: 'computer.apps.list', input: { action: 'apps' } },
      { method: 'computer.app.state', input: { action: 'state', app: 'win32:notepad', windowId: 'win32:1:2', includeText: true } },
    ])
  })

  it('never executes the web view without a named action', async () => {
    const result = await invoke({})
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(calls).toEqual([])
  })

  it('keeps the package out of company and project contexts', async () => {
    await expect(
      broker.loadView('nd.computer-use', 'computer-use', { kind: 'company', companyId: 'c1' }),
    ).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('requires an explicit grant before an agent may read window state', async () => {
    const listing = await invoke({ input: { action: 'apps' } })
    expect(listing).toMatchObject({ ok: true })

    const denied = await invoke({ caller: 'agent', input: { action: 'state', app: 'win32:notepad' } })
    expect(denied).toMatchObject({ ok: false, error: { code: 'approval-required' } })
    expect(calls.map((call) => call.method)).toEqual(['computer.apps.list'])

    const approvalId = (denied.value as { approvalId: string }).approvalId
    await broker.approve(approvalId, true)
    const granted = await invoke({ caller: 'agent', input: { action: 'state', app: 'win32:notepad' } })
    expect(granted).toMatchObject({ ok: true })
    expect(calls.map((call) => call.method)).toEqual(['computer.apps.list', 'computer.app.state', 'computer.app.state'])
  })
})
