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

const packagePath = fileURLToPath(new URL('../extensions/disk-cleaner/', import.meta.url))
const manifestPath = new URL('../extensions/disk-cleaner/nd-extension.json', import.meta.url)

async function loadManifest(): Promise<NdExtensionManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const result = validateNdExtensionManifest(parsed)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  return result.manifest
}

describe('ND Disk Cleaner extension package', () => {
  it('validates as a Personal-only web-view package with no missing permissions', async () => {
    const manifest = await loadManifest()
    expect(manifest.id).toBe('nd.disk-cleaner')
    expect(manifest.contexts).toEqual(['personal'])
    expect(manifest.permissions).toEqual(['disk.read', 'disk.write'])
    expect(manifest.executable).toBeUndefined()
    expect(manifestPermissionIssues(manifest)).toEqual([])

    const [view] = manifest.contributions.views
    expect(view?.kind).toBe('web')
    expect(view?.entry).toBe('ui/index.html')
    expect(view?.host).toBeUndefined()
    expect(view?.actions.map((action) => [action.id, action.host])).toEqual([
      ['volumes', 'disk.volumes.list'],
      ['scan-start', 'disk.scan.start'],
      ['scan-status', 'disk.scan.status'],
      ['scan-cancel', 'disk.scan.cancel'],
      ['trash', 'disk.trash.move'],
      ['reveal', 'disk.reveal'],
    ])
    expect(manifest.contributions.commands[0]?.openViewId).toBe('main')
    expect(manifest.contributions.commands[0]?.host).toBe('disk.volumes.list')
  })

  it('installs from its folder including the shipped UI assets, activates, and uninstalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-disk-cleaner-'))
    try {
      const packages = new ExtensionPackageStore(root)
      const installed = await packages.installFromDirectory(packagePath, { expectId: 'nd.disk-cleaner' })
      expect(installed.id).toBe('nd.disk-cleaner')

      // The snapshot carries the whole ui/ tree the web view renders.
      for (const asset of ['ui/index.html', 'ui/app.js', 'ui/sunburst.js', 'ui/sunburst.d.ts']) {
        expect(await packages.snapshotFileFor('nd.disk-cleaner', installed.version, asset)).not.toBeNull()
      }

      const state = new InvocationStateStore(root)
      expect(await state.activation('nd.disk-cleaner', personalContext())).toBeUndefined()
      await state.setActivation('nd.disk-cleaner', personalContext(), true)
      expect((await state.activation('nd.disk-cleaner', personalContext()))?.enabled).toBe(true)

      await packages.uninstall('nd.disk-cleaner')
      expect(await packages.activeManifest('nd.disk-cleaner')).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

const organization: NdOrganizationPort = {
  state: async () => ({
    companies: [{ id: 'c1' } as never],
    projects: [{ id: 'p1', companyId: 'c1' } as never],
    memory: [],
  }),
}

describe('ND Disk Cleaner broker gating', () => {
  let root: string
  let packages: ExtensionPackageStore
  let state: InvocationStateStore
  let host: NativeHostRegistry
  let broker: InvocationBroker
  let calls: { method: string; input: Record<string, unknown> }[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nd-disk-cleaner-broker-'))
    packages = new ExtensionPackageStore(join(root, 'packages'))
    state = new InvocationStateStore(join(root, 'state'))
    host = new NativeHostRegistry()
    calls = []
    const methods = [
      'disk.volumes.list',
      'disk.scan.start',
      'disk.scan.status',
      'disk.scan.cancel',
      'disk.trash.move',
      'disk.reveal',
    ] as const
    for (const method of methods) {
      host.register(method, async (input) => {
        calls.push({ method, input: { ...input } })
        return { ok: true, method, scanId: 'nd-disk-scan-fake', canceled: false, trashed: false }
      })
    }
    await packages.registerBuiltin(await loadManifest())
    broker = new InvocationBroker({ packages, state, host, organization })
    await state.setActivation('nd.disk-cleaner', personalContext(), true)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const invoke = (overrides: Partial<Parameters<InvocationBroker['invoke']>[0]>) =>
    broker.invoke({
      extensionId: 'nd.disk-cleaner',
      contributionId: 'main',
      contributionKind: 'view',
      context: personalContext(),
      caller: 'user',
      input: {},
      ...overrides,
    })

  it('loads the web view with its entry and without running any host method', async () => {
    const view = await broker.loadView('nd.disk-cleaner', 'main', personalContext())
    expect(view).toMatchObject({ kind: 'web', extensionId: 'nd.disk-cleaner', viewId: 'main' })
    expect(view.webView?.entry).toBe('ui/index.html')
    expect(view.rows).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses to load the web view before activation', async () => {
    await state.setActivation('nd.disk-cleaner', personalContext(), false)
    await expect(broker.loadView('nd.disk-cleaner', 'main', personalContext())).rejects.toThrow(/Activate/)
    expect(calls).toEqual([])
  })

  it('routes every declared action to its host and relays the input untouched', async () => {
    const start = await invoke({ input: { action: 'scan-start', root: '/tmp/scan-me' } })
    expect(start).toMatchObject({ ok: true })
    expect(calls).toEqual([{ method: 'disk.scan.start', input: { action: 'scan-start', root: '/tmp/scan-me' } }])

    calls = []
    const trash = await invoke({ input: { action: 'trash', path: '/tmp/scan-me/old.log' } })
    expect(trash).toMatchObject({ ok: true })
    expect(calls).toEqual([{ method: 'disk.trash.move', input: { action: 'trash', path: '/tmp/scan-me/old.log' } }])
  })

  it('never executes a web view without a named action', async () => {
    const result = await invoke({})
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(calls).toEqual([])
  })

  it('keeps the package out of other contexts', async () => {
    await expect(
      broker.loadView('nd.disk-cleaner', 'main', { kind: 'company', companyId: 'c1' }),
    ).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('requires an explicit grant before an agent may scan or trash, then remembers it per action', async () => {
    const first = await invoke({ caller: 'agent', input: { action: 'scan-start', root: '/tmp' } })
    expect(first).toMatchObject({ ok: false, error: { code: 'approval-required' } })
    expect(calls).toEqual([])
    const approvalId = (first.value as { approvalId: string }).approvalId
    await broker.approve(approvalId, true)

    // Approve runs the approved request, and a remembered grant covers that
    // action for the rest of the session without asking again…
    const granted = await invoke({ caller: 'agent', input: { action: 'scan-start', root: '/tmp' } })
    expect(granted).toMatchObject({ ok: true })

    // …but a different host action (trash) is a separate grant decision.
    const trash = await invoke({ caller: 'agent', input: { action: 'trash', path: '/tmp/old.log' } })
    expect(trash).toMatchObject({ ok: false, error: { code: 'approval-required' } })
    expect(calls.map((call) => call.method)).toEqual(['disk.scan.start', 'disk.scan.start'])
  })
})
