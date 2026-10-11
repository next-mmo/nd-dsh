import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { NativeHostRegistry } from '../src/main/extensions/native-host.js'
import { InvocationBroker, type NdOrganizationPort } from '../src/main/extensions/invocation-broker.js'
import { createCoreVault, type CoreVaultListResult } from '../src/main/core/core-vault.js'
import { manifestPermissionIssues, validateNdExtensionManifest, type NdExtensionManifest } from '../src/shared/extension-package.js'
import { personalContext } from '../src/shared/nd-context.js'

const packagePath = fileURLToPath(new URL('../extensions/password-vault/', import.meta.url))
const manifestPath = new URL('../extensions/password-vault/nd-extension.json', import.meta.url)

async function loadManifest(): Promise<NdExtensionManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const result = validateNdExtensionManifest(parsed)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  return result.manifest
}

describe('Password Vault ND extension package', () => {
  it('validates with no missing permissions and stays Personal-only', async () => {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    const result = validateNdExtensionManifest(parsed)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(manifestPermissionIssues(result.manifest)).toEqual([])
    expect(result.manifest.id).toBe('nd.password-vault')
    expect(result.manifest.contexts).toEqual(['personal'])
    expect(result.manifest.permissions).toEqual(['vault.read', 'vault.write'])
    expect(result.manifest.executable).toBeUndefined()
  })

  it('contributes the commands, view, and row actions it documents', async () => {
    const manifest = await loadManifest()
    expect(manifest.contributions.commands.map((command) => command.id)).toEqual(['open-vault', 'add-entry'])
    expect(manifest.contributions.commands[0]?.openViewId).toBe('vault')
    expect(manifest.contributions.commands[1]?.host).toBe('vault.create')
    const [view] = manifest.contributions.views
    expect(view?.kind).toBe('list')
    expect(view?.host).toBe('vault.list')
    expect(view?.itemTitleKey).toBe('title')
    expect(view?.itemBodyKey).toBe('detail')
    expect(view?.actions.map((action) => [action.id, action.host])).toEqual([
      ['copy-secret', 'vault.copy'],
      ['edit', 'vault.update'],
      ['delete', 'vault.delete'],
    ])
  })

  it('installs from its folder, activates for Personal, and uninstalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-password-vault-'))
    try {
      const packages = new ExtensionPackageStore(root)
      const installed = await packages.installFromDirectory(packagePath, { expectId: 'nd.password-vault' })
      expect(installed.id).toBe('nd.password-vault')
      expect(installed.hasExecutable).toBe(false)

      const state = new InvocationStateStore(root)
      expect(await state.activation('nd.password-vault', personalContext())).toBeUndefined()
      await state.setActivation('nd.password-vault', personalContext(), true)
      expect((await state.activation('nd.password-vault', personalContext()))?.enabled).toBe(true)

      await packages.uninstall('nd.password-vault')
      expect(await packages.activeManifest('nd.password-vault')).toBeUndefined()
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

describe('Password Vault broker gating', () => {
  let root: string
  let packages: ExtensionPackageStore
  let state: InvocationStateStore
  let host: NativeHostRegistry
  let broker: InvocationBroker
  let calls: string[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nd-password-vault-broker-'))
    packages = new ExtensionPackageStore(join(root, 'packages'))
    state = new InvocationStateStore(join(root, 'state'))
    host = new NativeHostRegistry()
    calls = []
    for (const method of ['vault.list', 'vault.get', 'vault.create', 'vault.update', 'vault.delete', 'vault.copy'] as const) {
      host.register(method, async () => {
        calls.push(method)
        return method === 'vault.list'
          ? [{ id: 'e1', title: 'Mail', detail: 'user@example.com' }]
          : { ok: true, method }
      })
    }
    await packages.registerBuiltin(await loadManifest())
    broker = new InvocationBroker({ packages, state, host, organization })
    await state.setActivation('nd.password-vault', personalContext(), true)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const invoke = (overrides: Partial<Parameters<InvocationBroker['invoke']>[0]>) =>
    broker.invoke({
      extensionId: 'nd.password-vault',
      contributionId: 'open-vault',
      contributionKind: 'command',
      context: personalContext(),
      caller: 'user',
      input: {},
      ...overrides,
    })

  it('runs the open-vault command for the user through vault.list', async () => {
    const result = await invoke({})
    expect(result.ok).toBe(true)
    expect(calls).toEqual(['vault.list'])
  })

  it('rejects company and project contexts at the host descriptor', async () => {
    const company = await invoke({ context: { kind: 'company', companyId: 'c1' } })
    expect(company).toMatchObject({ ok: false, error: { code: 'denied' } })
    expect(calls).toEqual([])
  })

  it('requires an explicit grant before an agent may list or copy secrets', async () => {
    const list = await invoke({ caller: 'agent' })
    expect(list).toMatchObject({ ok: false, error: { code: 'approval-required' } })
    const approvalId = (list.value as { approvalId: string }).approvalId
    await broker.approve(approvalId, true)
    expect((await invoke({ caller: 'agent' })).ok).toBe(true)

    const copy = await invoke({ contributionId: 'vault', contributionKind: 'view', caller: 'agent', input: { id: 'e1', action: 'copy-secret' } })
    expect(copy).toMatchObject({ ok: false, error: { code: 'approval-required' } })
  })

  it('routes a view action to its declared host through the same broker', async () => {
    const result = await invoke({ contributionId: 'vault', contributionKind: 'view', input: { id: 'e1', action: 'copy-secret' } })
    expect(result.ok).toBe(true)
    expect(calls).toEqual(['vault.copy'])
  })
})

describe('createCoreVault request mapping', () => {
  it('sends camelCase params and unwraps entries', async () => {
    const requests: Array<{ method: string; params: unknown }> = []
    const listResult: CoreVaultListResult = {
      entries: [{ id: 'e1', title: 'Mail', username: 'u', url: 'https://x', updatedAt: 5 }],
      total: 1,
    }
    const core = {
      request: async <T>(method: string, params: unknown): Promise<T> => {
        requests.push({ method, params })
        if (method === 'vault.list') return listResult as T
        if (method === 'vault.delete') return { deleted: true } as T
        return { entry: { id: 'e1', title: 'Mail', username: 'u', url: '', notes: '', secret: 's', createdAt: 1, updatedAt: 2 } } as T
      },
    }
    const vault = createCoreVault(core)
    expect(await vault.list('/v', 'mail')).toEqual(listResult)
    expect((await vault.get('/v', 'e1')).secret).toBe('s')
    expect((await vault.create('/v', { title: 'Mail', username: 'u', url: '', notes: '', secret: 's' })).id).toBe('e1')
    expect(await vault.delete('/v', 'e1')).toBe(true)
    expect(requests.map((request) => request.method)).toEqual(['vault.list', 'vault.get', 'vault.create', 'vault.delete'])
    expect(requests[0]?.params).toEqual({ vaultPath: '/v', query: 'mail' })
  })
})
