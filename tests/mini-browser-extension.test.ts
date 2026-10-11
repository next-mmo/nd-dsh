import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { NativeHostRegistry } from '../src/main/extensions/native-host.js'
import { InvocationBroker, type NdOrganizationPort } from '../src/main/extensions/invocation-broker.js'
import { MiniBrowserStore, asMiniEntryId, browserTabUrl, miniTabTitle, legacyYouTubeQueuePath, type MiniLink } from '../src/main/extensions/mini-browser-store.js'
import { manifestPermissionIssues, validateNdExtensionManifest, type NdExtensionManifest } from '../src/shared/extension-package.js'
import { personalContext } from '../src/shared/nd-context.js'

const packagePath = fileURLToPath(new URL('../extensions/nd-mini-browser/', import.meta.url))
const manifestPath = new URL('../extensions/nd-mini-browser/nd-extension.json', import.meta.url)

async function loadManifest(): Promise<NdExtensionManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const result = validateNdExtensionManifest(parsed)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  return result.manifest
}

describe('Mini ND Browser extension package', () => {
  it('validates as a personal keep-alive chrome with tab and quick-link actions', async () => {
    const manifest = await loadManifest()
    expect(manifest.id).toBe('nd.mini-browser')
    expect(manifest.contexts).toEqual(['personal'])
    expect(manifest.permissions).toEqual(['minibrowser.read', 'minibrowser.write'])
    expect(manifest.executable).toBeUndefined()
    expect(manifestPermissionIssues(manifest)).toEqual([])

    const chrome = manifest.contributions.views.find((view) => view.kind === 'web')
    expect(chrome).toBeDefined()
    expect(chrome?.entry).toBe('ui/index.html')
    expect(chrome?.host).toBeUndefined()
    expect(chrome?.actions.map((action) => [action.id, action.host])).toEqual([
      ['session', 'minibrowser.session.list'],
      ['open', 'minibrowser.tab.open'],
      ['activate', 'minibrowser.tab.activate'],
      ['close', 'minibrowser.tab.close'],
      ['link-save', 'minibrowser.link.save'],
      ['link-remove', 'minibrowser.link.remove'],
    ])
    expect(manifest.contributions.commands.some((command) => command.openViewId === 'mini-browser')).toBe(true)
    expect(manifest.contributions.commands.some((command) => command.id === 'mini-browser-open-url' && command.host === 'minibrowser.tab.open')).toBe(true)
  })

  it('installs from its folder including the chrome UI, activates, and uninstalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-mini-browser-'))
    try {
      const packages = new ExtensionPackageStore(root)
      const installed = await packages.installFromDirectory(packagePath, { expectId: 'nd.mini-browser' })
      expect(installed.id).toBe('nd.mini-browser')

      for (const asset of ['ui/index.html', 'ui/chrome.js', 'ui/chrome-core.js', 'ui/chrome-core.d.ts']) {
        expect(await packages.snapshotFileFor('nd.mini-browser', installed.version, asset)).not.toBeNull()
      }

      const state = new InvocationStateStore(root)
      expect(await state.activation('nd.mini-browser', personalContext())).toBeUndefined()
      await state.setActivation('nd.mini-browser', personalContext(), true)
      expect((await state.activation('nd.mini-browser', personalContext()))?.enabled).toBe(true)

      await packages.uninstall('nd.mini-browser')
      expect(await packages.activeManifest('nd.mini-browser')).toBeUndefined()
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

describe('Mini ND Browser broker gating', () => {
  let root: string
  let packages: ExtensionPackageStore
  let state: InvocationStateStore
  let host: NativeHostRegistry
  let broker: InvocationBroker
  let calls: string[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nd-mini-browser-broker-'))
    packages = new ExtensionPackageStore(join(root, 'packages'))
    state = new InvocationStateStore(join(root, 'state'))
    host = new NativeHostRegistry()
    calls = []
    for (const method of [
      'minibrowser.session.list',
      'minibrowser.link.list',
      'minibrowser.tab.open',
      'minibrowser.tab.activate',
      'minibrowser.tab.close',
      'minibrowser.link.save',
      'minibrowser.link.remove',
    ] as const) {
      host.register(method, async (input) => {
        calls.push(method)
        const signature = JSON.stringify(input)
        return { ok: true, method, input: signature.length > 200 ? `${signature.slice(0, 200)}…` : signature }
      })
    }
    await packages.registerBuiltin(await loadManifest())
    broker = new InvocationBroker({ packages, state, host, organization })
    await state.setActivation('nd.mini-browser', personalContext(), true)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const invoke = (overrides: Partial<Parameters<InvocationBroker['invoke']>[0]>) =>
    broker.invoke({
      extensionId: 'nd.mini-browser',
      contributionId: 'mini-browser',
      contributionKind: 'view',
      context: personalContext(),
      caller: 'user',
      input: {},
      ...overrides,
    })

  it('loads the keep-alive chrome with its entry and without running any host method', async () => {
    const view = await broker.loadView('nd.mini-browser', 'mini-browser', personalContext())
    expect(view).toMatchObject({ kind: 'web', extensionId: 'nd.mini-browser', viewId: 'mini-browser' })
    expect(view.webView?.entry).toBe('ui/index.html')
    expect(view.rows).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses to load the chrome before activation', async () => {
    await state.setActivation('nd.mini-browser', personalContext(), false)
    await expect(broker.loadView('nd.mini-browser', 'mini-browser', personalContext())).rejects.toThrow(/Activate/)
    expect(calls).toEqual([])
  })

  it('refuses the chrome entirely in company context', async () => {
    await expect(broker.loadView('nd.mini-browser', 'mini-browser', { kind: 'company', companyId: 'c1' })).rejects.toThrow(/not available/)
    expect(calls).toEqual([])
  })

  it('renders the quick links list view without a bridge frame', async () => {
    const view = await broker.loadView('nd.mini-browser', 'mini-browser-quick-links', personalContext())
    expect(view.kind).toBe('list')
    expect(calls).toContain('minibrowser.link.list')
  })

  it('routes chrome actions to their declared hosts', async () => {
    const session = await invoke({ input: { action: 'session' } })
    expect(session).toMatchObject({ ok: true })
    const open = await invoke({ input: { action: 'open', url: 'https://www.example.com/nt' } })
    expect(open).toMatchObject({ ok: true })
    const activate = await invoke({ input: { action: 'activate', id: 'tab-1' } })
    expect(activate).toMatchObject({ ok: true })
    const close = await invoke({ input: { action: 'close', id: 'tab-1' } })
    expect(close).toMatchObject({ ok: true })
    const linkSave = await invoke({ input: { action: 'link-save', url: 'https://www.example.com/ls' } })
    expect(linkSave).toMatchObject({ ok: true })
    const linkRemove = await invoke({ input: { action: 'link-remove', id: 'link:x' } })
    expect(linkRemove).toMatchObject({ ok: true })
    expect(calls).toEqual([
      'minibrowser.session.list',
      'minibrowser.tab.open',
      'minibrowser.tab.activate',
      'minibrowser.tab.close',
      'minibrowser.link.save',
      'minibrowser.link.remove',
    ])
  })

  it('never executes the chrome without a named action', async () => {
    const result = await invoke({})
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(calls).toEqual([])
  })

  it('requires an explicit grant before an agent may open tabs or touch links', async () => {
    const result = await invoke({ caller: 'agent', input: { action: 'open', url: 'https://www.example.com/nt' } })
    expect(result).toMatchObject({ ok: false, error: { code: 'approval-required' } })
    expect(calls).toEqual([])
    const approvalId = (result.value as { approvalId: string }).approvalId
    await broker.approve(approvalId, true)
    const granted = await invoke({ caller: 'agent', input: { action: 'open', url: 'https://www.example.com/nt' } })
    expect(granted).toMatchObject({ ok: true })
  })
})

describe('MiniBrowserStore', () => {
  it('accepts only http(s) web addresses for tabs and links', () => {
    expect(browserTabUrl('https://docs.nd.dev/stuff?x=1')).toBe('https://docs.nd.dev/stuff?x=1')
    expect(browserTabUrl('http://localhost:8000/index.html#top')).toBe('http://localhost:8000/index.html#top')
    expect(browserTabUrl('about:blank')).toBeUndefined()
    expect(browserTabUrl('javascript:alert(1)')).toBeUndefined()
    expect(browserTabUrl('not a link')).toBeUndefined()
    expect(browserTabUrl('')).toBeUndefined()
  })

  it('titles chrome rows and dedupes quick links by URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-mini-browser-store-'))
    try {
      const store = new MiniBrowserStore(join(root, 'session.json'))
      expect(miniTabTitle('', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ')).toBe('youtube.com')
      expect(miniTabTitle('Big Buck Bunny', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ')).toBe('Big Buck Bunny')

      await store.rememberTab('tab-1', 'https://docs.nd.dev/x', 'Docs')
      await store.touchTab('tab-1')
      expect((await store.tabs())[0]).toMatchObject({ id: 'tab-1', title: 'Docs' })

      const afterSave = await store.saveLink('https://www.example.com/nt', 'example')
      expect(afterSave).toHaveLength(1)
      _expectLinkShape(afterSave[0]!, 'www.example.com/nt')

      const second = await store.saveLink('https://www.example.com/nt', 'same again')
      expect(second).toHaveLength(1)
      expect(second[0]).toMatchObject({ title: 'same again' })

      await store.saveLink('https://other.example/y', '')
      const afterRemove = await store.removeLink((await store.links()).find((item) => item.url === 'https://www.example.com/nt')!.id)
      expect(afterRemove).toHaveLength(1)
      expect(afterRemove[0]).toMatchObject({ url: 'https://other.example/y' })

      await store.forgetTab('tab-1')
      expect(await store.tabs()).toEqual([])

      // A fresh instance reads the same file back.
      const reloaded = await new MiniBrowserStore(join(root, 'session.json')).links()
      expect(reloaded).toHaveLength(1)
      expect(reloaded[0]).toMatchObject({ url: 'https://other.example/y' })

      await expect(store.saveLink('javascript:alert(1)', '')).rejects.toThrow(/not look like/)
      expect(() => asMiniEntryId('')).toThrow(/Entry id/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('migrates the legacy YouTube Mini queue into quick links once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-mini-browser-migrate-'))
    try {
      const legacy = join(root, 'nd-youtube-mini')
      const { mkdir, writeFile } = await import('node:fs/promises')
      await mkdir(legacy, { recursive: true })
      await writeFile(join(legacy, 'queue.json'), JSON.stringify({
        version: 1,
        entries: [
          { id: 'yt:aqz-KE-bpKQ', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', title: 'Big Buck Bunny', addedAt: 5 },
          { id: 'junk', url: 'https://example.com/nope', title: 'Nope', addedAt: 6 },
        ],
      }), 'utf8')

      const store = new MiniBrowserStore(join(root, 'session.json'), legacyYouTubeQueuePath(root))
      const links: MiniLink[] = await store.links()
      // The former YouTube queue folds into quick links: every entry that is a
      // valid web address migrates (YouTube Mini only ever held watch links,
      // so the two shapes collapse into one rule).
      expect(links).toHaveLength(2)
      expect(links[0]).toMatchObject({ url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', title: 'Big Buck Bunny' })

      // The store file now carries the migrated links; a fresh store sees them
      // even after the legacy file disappears.
      const reloaded = await new MiniBrowserStore(join(root, 'session.json'), undefined).links()
      expect(reloaded).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function _expectLinkShape(link: MiniLink, fragment: string): void {
  expect(link.id.startsWith('link:')).toBe(true)
  expect(link.url).toContain(fragment)
}
