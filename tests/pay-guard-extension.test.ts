import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { NativeHostRegistry } from '../src/main/extensions/native-host.js'
import { InvocationBroker, type NdOrganizationPort } from '../src/main/extensions/invocation-broker.js'
import {
  manifestPermissionIssues,
  validateNdExtensionManifest,
  type NdExtensionManifest,
} from '../src/shared/extension-package.js'
import { personalContext, type NdContext } from '../src/shared/nd-context.js'

const packagePath = fileURLToPath(new URL('../extensions/nd-pay-guard/', import.meta.url))
const manifestPath = new URL('../extensions/nd-pay-guard/nd-extension.json', import.meta.url)

async function loadManifest(): Promise<NdExtensionManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const result = validateNdExtensionManifest(parsed)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  return result.manifest
}

describe('ND Pay Guard Extension Package Contract', () => {
  it('validates as a Personal-only web-view package with no missing permissions', async () => {
    const manifest = await loadManifest()
    expect(manifest.id).toBe('nd.pay-guard')
    expect(manifest.contexts).toEqual(['personal'])
    expect(manifest.permissions).toEqual(['payguard.read', 'payguard.write', 'browser.openExternal'])
    expect(manifest.executable).toBeUndefined()
    expect(manifestPermissionIssues(manifest)).toEqual([])

    const [view] = manifest.contributions.views
    expect(view?.kind).toBe('web')
    expect(view?.entry).toBe('ui/index.html')
    expect(view?.host).toBeUndefined()
    expect(view?.actions.map((action) => [action.id, action.host])).toEqual([
      ['list', 'payguard.subscriptions.list'],
      ['create', 'payguard.subscriptions.create'],
      ['update', 'payguard.subscriptions.update'],
      ['delete', 'payguard.subscriptions.delete'],
      ['mark-paid', 'payguard.subscriptions.markPaid'],
      ['upcoming', 'payguard.subscriptions.upcoming'],
      ['notify-test', 'payguard.notifications.test'],
      ['open-url', 'browser.openExternal'],
    ])
    expect(manifest.contributions.commands[0]?.openViewId).toBe('guard')
  })

  it('installs from directory including all UI assets, activates, and uninstalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-pay-guard-install-'))
    try {
      const packages = new ExtensionPackageStore(root)
      const installed = await packages.installFromDirectory(packagePath, { expectId: 'nd.pay-guard' })
      expect(installed.id).toBe('nd.pay-guard')

      for (const asset of [
        'ui/index.html',
        'ui/pay-guard.js',
        'ui/pay-guard-core.js',
        'ui/pay-guard-core.d.ts',
      ]) {
        expect(await packages.snapshotFileFor('nd.pay-guard', installed.version, asset)).not.toBeNull()
      }

      const state = new InvocationStateStore(root)
      expect(await state.activation('nd.pay-guard', personalContext())).toBeUndefined()
      await state.setActivation('nd.pay-guard', personalContext(), true)
      expect((await state.activation('nd.pay-guard', personalContext()))?.enabled).toBe(true)

      await packages.uninstall('nd.pay-guard')
      expect(await packages.activeManifest('nd.pay-guard')).toBeUndefined()
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

describe('ND Pay Guard Broker Gating & Native Host Routing', () => {
  let root: string
  let packages: ExtensionPackageStore
  let state: InvocationStateStore
  let host: NativeHostRegistry
  let broker: InvocationBroker
  let calls: string[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nd-pay-guard-broker-'))
    packages = new ExtensionPackageStore(join(root, 'packages'))
    state = new InvocationStateStore(join(root, 'state'))
    host = new NativeHostRegistry()
    calls = []

    for (const method of [
      'payguard.subscriptions.list',
      'payguard.subscriptions.create',
      'payguard.subscriptions.update',
      'payguard.subscriptions.delete',
      'payguard.subscriptions.markPaid',
      'payguard.subscriptions.upcoming',
      'payguard.notifications.test',
      'browser.openExternal',
    ] as const) {
      host.register(method, async (input) => {
        calls.push(method)
        return { ok: true, method, input }
      })
    }

    await packages.registerBuiltin(await loadManifest())
    broker = new InvocationBroker({ packages, state, host, organization })
    await state.setActivation('nd.pay-guard', personalContext(), true)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const invoke = (overrides: Partial<Parameters<InvocationBroker['invoke']>[0]>) =>
    broker.invoke({
      extensionId: 'nd.pay-guard',
      contributionId: 'guard',
      contributionKind: 'view',
      context: personalContext(),
      caller: 'user',
      input: {},
      ...overrides,
    })

  it('loads the web view without invoking any data host methods', async () => {
    const view = await broker.loadView('nd.pay-guard', 'guard', personalContext())
    expect(view).toMatchObject({ kind: 'web', extensionId: 'nd.pay-guard', viewId: 'guard' })
    expect(view.webView?.entry).toBe('ui/index.html')
    expect(view.rows).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses to load the web view if deactivated', async () => {
    await state.setActivation('nd.pay-guard', personalContext(), false)
    await expect(broker.loadView('nd.pay-guard', 'guard', personalContext())).rejects.toThrow(/Activate/)
    expect(calls).toEqual([])
  })

  it('routes view actions to declared host methods', async () => {
    const listRes = await invoke({ input: { action: 'list' } })
    expect(listRes.ok).toBe(true)

    const createRes = await invoke({ input: { action: 'create', name: 'Copilot', amount: 10 } })
    expect(createRes.ok).toBe(true)

    const markPaidRes = await invoke({ input: { action: 'mark-paid', id: '123' } })
    expect(markPaidRes.ok).toBe(true)

    const notifyRes = await invoke({ input: { action: 'notify-test' } })
    expect(notifyRes.ok).toBe(true)

    expect(calls).toEqual([
      'payguard.subscriptions.list',
      'payguard.subscriptions.create',
      'payguard.subscriptions.markPaid',
      'payguard.notifications.test',
    ])
  })

  it('denies execution when invoked in company or project context', async () => {
    const companyRes = await invoke({
      context: { kind: 'company', companyId: 'c1' },
      input: { action: 'list' },
    })
    expect(companyRes.ok).toBe(false)
    expect(companyRes.error?.code).toBe('denied')

    const projectRes = await invoke({
      context: { kind: 'project', companyId: 'c1', projectId: 'p1' },
      input: { action: 'list' },
    })
    expect(projectRes.ok).toBe(false)
    expect(projectRes.error?.code).toBe('denied')
  })
})
