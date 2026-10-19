import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AccountMgtStore } from '../src/main/extensions/account-mgt-store.js'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { NativeHostRegistry } from '../src/main/extensions/native-host.js'
import { InvocationBroker, type NdOrganizationPort } from '../src/main/extensions/invocation-broker.js'
import { manifestPermissionIssues, validateNdExtensionManifest, type NdExtensionManifest } from '../src/shared/extension-package.js'
import { personalContext } from '../src/shared/nd-context.js'

const packagePath = fileURLToPath(new URL('../extensions/account-mgt/', import.meta.url))
const manifestPath = new URL('../extensions/account-mgt/nd-extension.json', import.meta.url)

async function loadManifest(): Promise<NdExtensionManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const result = validateNdExtensionManifest(parsed)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  return result.manifest
}

describe('Account Manager ND extension package', () => {
  it('validates as a Personal-only web view with mailbox navigation and no executable', async () => {
    const manifest = await loadManifest()
    expect(manifest.id).toBe('nd.account-mgt')
    expect(manifest.contexts).toEqual(['personal'])
    expect(manifest.permissions).toEqual(['accountmgt.read', 'accountmgt.write', 'browser.navigate'])
    expect(manifest.executable).toBeUndefined()
    expect(manifestPermissionIssues(manifest)).toEqual([])

    const [view] = manifest.contributions.views
    expect(view?.kind).toBe('web')
    expect(view?.entry).toBe('ui/index.html')
    expect(view?.host).toBeUndefined()
    expect(view?.actions.map((action) => [action.id, action.host])).toEqual([
      ['list', 'accountmgt.accounts.list'],
      ['create', 'accountmgt.accounts.create'],
      ['update', 'accountmgt.accounts.update'],
      ['delete', 'accountmgt.accounts.delete'],
      ['open-site', 'browser.openUrl'],
      ['open-mailbox', 'browser.openUrl'],
    ])
    expect(manifest.contributions.commands[0]?.openViewId).toBe('accounts')
  })

  it('never accepts passwords or verification codes in its UI', async () => {
    const html = await readFile(new URL('../extensions/account-mgt/ui/index.html', import.meta.url), 'utf8')
    const app = await readFile(new URL('../extensions/account-mgt/ui/app.js', import.meta.url), 'utf8')

    expect(html).not.toMatch(/type=["']password["']/i)
    expect(html).not.toMatch(/one-time-code/i)
    expect(app).not.toMatch(/type=["']password["']/i)
    expect(app).not.toMatch(/one-time-code/i)
    // The frame has no network and never reads a mailbox or ChatGPT DOM itself.
    expect(html).toContain("connect-src 'none'")
    expect(html).toContain('id="register-open-mailbox"')
    expect(app).toContain("registerOpenMailbox")
    expect(app).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|DOMParser/)
  })

  it('installs from its folder including the UI assets, activates, and uninstalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-account-mgt-'))
    try {
      const packages = new ExtensionPackageStore(root)
      const installed = await packages.installFromDirectory(packagePath, { expectId: 'nd.account-mgt' })
      expect(installed.id).toBe('nd.account-mgt')

      for (const asset of ['nd-extension.json', 'ui/index.html', 'ui/app.js', 'ui/styles.css']) {
        expect(await packages.snapshotFileFor('nd.account-mgt', installed.version, asset)).not.toBeNull()
      }

      const state = new InvocationStateStore(root)
      expect(await state.activation('nd.account-mgt', personalContext())).toBeUndefined()
      await state.setActivation('nd.account-mgt', personalContext(), true)
      expect((await state.activation('nd.account-mgt', personalContext()))?.enabled).toBe(true)

      await packages.uninstall('nd.account-mgt')
      expect(await packages.activeManifest('nd.account-mgt')).toBeUndefined()
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

describe('Account Manager broker gating', () => {
  let root: string
  let packages: ExtensionPackageStore
  let state: InvocationStateStore
  let host: NativeHostRegistry
  let broker: InvocationBroker
  let calls: string[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nd-account-mgt-broker-'))
    packages = new ExtensionPackageStore(join(root, 'packages'))
    state = new InvocationStateStore(join(root, 'state'))
    host = new NativeHostRegistry()
    calls = []
    for (const method of [
      'accountmgt.accounts.list',
      'accountmgt.accounts.create',
      'accountmgt.accounts.update',
      'accountmgt.accounts.delete',
      'browser.openUrl',
    ] as const) {
      host.register(method, async (input) => {
        calls.push(method)
        return { ok: true, method, id: input.id ?? null, url: input.url ?? null }
      })
    }
    await packages.registerBuiltin(await loadManifest())
    broker = new InvocationBroker({ packages, state, host, organization })
    await state.setActivation('nd.account-mgt', personalContext(), true)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const invoke = (overrides: Partial<Parameters<InvocationBroker['invoke']>[0]>) =>
    broker.invoke({
      extensionId: 'nd.account-mgt',
      contributionId: 'accounts',
      contributionKind: 'view',
      context: personalContext(),
      caller: 'user',
      input: {},
      ...overrides,
    })

  it('loads the web view without running a host method', async () => {
    const view = await broker.loadView('nd.account-mgt', 'accounts', personalContext())
    expect(view).toMatchObject({ kind: 'web', extensionId: 'nd.account-mgt', viewId: 'accounts' })
    expect(view.webView?.entry).toBe('ui/index.html')
    expect(view.rows).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses to load the view before activation', async () => {
    await state.setActivation('nd.account-mgt', personalContext(), false)
    await expect(broker.loadView('nd.account-mgt', 'accounts', personalContext())).rejects.toThrow(/Activate/)
    expect(calls).toEqual([])
  })

  it('routes each declared action to its host, including mailbox navigation', async () => {
    expect(await invoke({ input: { action: 'list' } })).toMatchObject({ ok: true })
    expect(await invoke({ input: { action: 'create', service: 'ChatGPT' } })).toMatchObject({ ok: true })
    expect(await invoke({ input: { action: 'update', id: 'a1', status: 'active' } })).toMatchObject({ ok: true })
    expect(await invoke({ input: { action: 'delete', id: 'a1' } })).toMatchObject({ ok: true })
    expect(await invoke({ input: { action: 'open-mailbox', url: 'https://www.mailticking.com/' } })).toMatchObject({ ok: true })
    expect(await invoke({ input: { action: 'open-site', url: 'https://chatgpt.com/auth/login' } })).toMatchObject({ ok: true })
    expect(calls).toEqual([
      'accountmgt.accounts.list',
      'accountmgt.accounts.create',
      'accountmgt.accounts.update',
      'accountmgt.accounts.delete',
      'browser.openUrl',
      'browser.openUrl',
    ])
  })

  it('never executes a web view without a named action', async () => {
    const result = await invoke({})
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(calls).toEqual([])
  })

  it('denies a non-personal context', async () => {
    const result = await invoke({ context: { kind: 'company', companyId: 'c1' }, input: { action: 'list' } })
    expect(result).toMatchObject({ ok: false, error: { code: 'denied' } })
    expect(calls).toEqual([])
  })

  it('requires an explicit grant before an agent may read account metadata', async () => {
    const result = await invoke({ caller: 'agent', input: { action: 'list' } })
    expect(result).toMatchObject({ ok: false, error: { code: 'approval-required' } })
    expect(calls).toEqual([])

    const approvalId = (result.value as { approvalId: string }).approvalId
    await broker.approve(approvalId, true)
    expect(calls).toEqual(['accountmgt.accounts.list'])

    const granted = await invoke({ caller: 'agent', input: { action: 'list' } })
    expect(granted).toMatchObject({ ok: true })
    expect(calls).toEqual(['accountmgt.accounts.list', 'accountmgt.accounts.list'])
  })
})

describe('AccountMgtStore', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nd-account-mgt-store-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('creates, lists, updates, and deletes metadata with atomic persistence', async () => {
    const file = join(root, 'accounts.json')
    const store = new AccountMgtStore(file)
    const created = await store.create({
      service: 'ChatGPT',
      email: 'user@example.com',
      mailboxUrl: 'https://www.mailticking.com/inbox/abc',
      siteUrl: 'https://chatgpt.com/auth/login',
      status: 'planned',
      notes: 'Primary account',
    })
    expect(created).toMatchObject({
      service: 'ChatGPT',
      email: 'user@example.com',
      mailboxUrl: 'https://www.mailticking.com/inbox/abc',
      siteUrl: 'https://chatgpt.com/auth/login',
      status: 'planned',
    })
    expect(created.id).toBeTruthy()

    const updated = await store.update(created.id, { status: 'active', notes: 'Verified' })
    expect(updated).toMatchObject({ status: 'active', notes: 'Verified' })
    expect(updated.createdAt).toBe(created.createdAt)

    const reloaded = new AccountMgtStore(file)
    expect(await reloaded.list()).toEqual([updated])
    expect(await reloaded.list('verified')).toHaveLength(1)
    expect(await reloaded.list('missing')).toHaveLength(0)

    expect(await store.delete(created.id)).toBe(true)
    expect(await store.delete(created.id)).toBe(false)
    expect(await new AccountMgtStore(file).list()).toEqual([])
  })

  it('rejects missing fields, invalid statuses, non-http links, and control characters', async () => {
    const store = new AccountMgtStore(join(root, 'accounts.json'))
    await expect(store.create({ service: '', email: 'user@example.com' })).rejects.toThrow(/Service/)
    await expect(store.create({ service: 'ChatGPT', email: 'not-an-email' })).rejects.toThrow(/Email/)
    await expect(store.create({ service: 'ChatGPT', email: 'user@example.com', status: 'unknown' })).rejects.toThrow(/Status/)
    await expect(store.create({ service: 'ChatGPT', email: 'user@example.com', siteUrl: 'javascript:alert(1)' })).rejects.toThrow(/http/)
    await expect(store.create({ service: 'ChatGPT', email: 'user@example.com', mailboxUrl: 'ftp://example.com' })).rejects.toThrow(/http/)
    await expect(store.create({ service: 'Bad\u0000Service', email: 'user@example.com' })).rejects.toThrow(/control/)

    const created = await store.create({ service: 'ChatGPT', email: 'user@example.com' })
    await expect(store.update(created.id, { status: 'unknown' })).rejects.toThrow(/Status/)
    await expect(store.update('missing', { status: 'active' })).rejects.toThrow(/no longer exists/)
  })

  it('serializes concurrent saves and survives a corrupt file', async () => {
    const file = join(root, 'accounts.json')
    const store = new AccountMgtStore(file)
    await Promise.all([
      store.create({ service: 'ChatGPT', email: 'one@example.com' }),
      store.create({ service: 'ChatGPT', email: 'two@example.com' }),
    ])
    expect(await new AccountMgtStore(file).list()).toHaveLength(2)

    await writeFile(file, '{not json', 'utf8')
    expect(await new AccountMgtStore(file).list()).toEqual([])
  })
})
