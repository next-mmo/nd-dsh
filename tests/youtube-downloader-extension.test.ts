import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserTabDescriptor } from '../src/shared/browser-platform.js'
import {
  manifestPermissionIssues,
  validateNdExtensionManifest,
  type NdExtensionManifest,
} from '../src/shared/extension-package.js'
import { personalContext } from '../src/shared/nd-context.js'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { NativeHostRegistry } from '../src/main/extensions/native-host.js'
import { InvocationBroker, type NdOrganizationPort } from '../src/main/extensions/invocation-broker.js'
import { activeYouTubePage } from '../src/main/media-download/active-tab.js'

const packagePath = fileURLToPath(new URL('../extensions/youtube-downloader/', import.meta.url))
const manifestPath = new URL('../extensions/youtube-downloader/nd-extension.json', import.meta.url)
const extensionId = 'nd.youtube-downloader'
const videoId = 'dQw4w9WgXcQ'
const methods = [
  'media.download.current',
  'media.download.status',
  'media.download.prepare',
  'media.download.start',
  'media.download.cancel',
  'media.download.reveal',
] as const

const organization: NdOrganizationPort = {
  state: async () => ({
    companies: [{ id: 'c1' } as never],
    projects: [{ id: 'p1', companyId: 'c1' } as never],
    memory: [],
  }),
  policy: async () => 'allow',
}

async function loadManifest(): Promise<NdExtensionManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const result = validateNdExtensionManifest(parsed)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  return result.manifest
}

describe('YouTube Downloader ND extension package', () => {
  it('validates as a Personal-only web-view package with the media permission', async () => {
    const manifest = await loadManifest()
    expect(manifest.id).toBe(extensionId)
    expect(manifest.contexts).toEqual(['personal'])
    expect(manifest.permissions).toEqual(['media.download'])
    expect(manifest.executable).toBeUndefined()
    expect(manifestPermissionIssues(manifest)).toEqual([])

    const [view] = manifest.contributions.views
    expect(view?.kind).toBe('web')
    expect(view?.entry).toBe('ui/index.html')
    expect(view?.host).toBeUndefined()
    expect(view?.actions.map((action) => [action.id, action.host])).toEqual([
      ['current', 'media.download.current'],
      ['status', 'media.download.status'],
      ['prepare', 'media.download.prepare'],
      ['start', 'media.download.start'],
      ['cancel', 'media.download.cancel'],
      ['reveal', 'media.download.reveal'],
    ])
    expect(manifest.contributions.commands[0]?.openViewId).toBe('downloader')
  })

  it('installs its UI assets, activates, and uninstalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-youtube-downloader-'))
    try {
      const packages = new ExtensionPackageStore(root)
      const installed = await packages.installFromDirectory(packagePath, { expectId: extensionId })
      expect(installed.id).toBe(extensionId)
      for (const asset of ['ui/index.html', 'ui/app.js', 'ui/styles.css', 'ui/media-core.js', 'ui/media-core.d.ts']) {
        expect(await packages.snapshotFileFor(extensionId, installed.version, asset)).not.toBeNull()
      }

      const state = new InvocationStateStore(root)
      expect(await state.activation(extensionId, personalContext())).toBeUndefined()
      await state.setActivation(extensionId, personalContext(), true)
      expect((await state.activation(extensionId, personalContext()))?.enabled).toBe(true)

      await packages.uninstall(extensionId)
      expect(await packages.activeManifest(extensionId)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('YouTube Downloader broker routing', () => {
  let root: string
  let packages: ExtensionPackageStore
  let state: InvocationStateStore
  let host: NativeHostRegistry
  let broker: InvocationBroker
  let calls: Array<{ host: string; input: Record<string, unknown>; caller: string; contextKind: string }>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nd-youtube-broker-'))
    packages = new ExtensionPackageStore(root)
    state = new InvocationStateStore(root)
    host = new NativeHostRegistry()
    calls = []
    for (const method of methods) {
      host.register(method, async (input, context) => {
        calls.push({ host: method, input, caller: context.caller, contextKind: context.context.kind })
        return { method, action: typeof input.action === 'string' ? input.action : null }
      })
    }
    await packages.installFromDirectory(packagePath, { expectId: extensionId })
    broker = new InvocationBroker({ packages, state, host, organization })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function invoke(input: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    return broker.invoke({
      extensionId,
      contributionId: 'downloader',
      contributionKind: 'view',
      context: personalContext(),
      caller: 'user',
      input,
      ...overrides,
    } as Parameters<InvocationBroker['invoke']>[0])
  }

  it('gates the web view on activation and never runs a host on load', async () => {
    await expect(broker.loadView(extensionId, 'downloader', personalContext())).rejects.toThrow(/Activate/i)
    await state.setActivation(extensionId, personalContext(), true)
    const view = await broker.loadView(extensionId, 'downloader', personalContext())
    expect(view.kind).toBe('web')
    expect(view.rows).toEqual([])
    expect(view.webView?.entry).toBe('ui/index.html')
    expect(view.actions).toHaveLength(6)
    expect(calls).toHaveLength(0)
  })

  it('routes a named action to its declared host and rejects unknown actions or contexts', async () => {
    await state.setActivation(extensionId, personalContext(), true)
    const current = await invoke({ action: 'current' })
    expect(current).toMatchObject({ ok: true, value: { method: 'media.download.current' } })
    expect(calls.at(-1)).toMatchObject({ caller: 'user', contextKind: 'personal' })

    const unknown = await invoke({ action: 'nope' })
    expect(unknown).toMatchObject({ ok: false, error: { code: 'invalid' } })

    const company = await invoke({ action: 'current' }, { context: { kind: 'company', companyId: 'c1' } })
    expect(company).toMatchObject({ ok: false, error: { code: 'denied' } })
    expect(calls).toHaveLength(1)
  })

  it('requires an explicit agent approval for the sensitive start action', async () => {
    await state.setActivation(extensionId, personalContext(), true)
    const first = await invoke({ action: 'start', url: `https://youtu.be/${videoId}`, mode: 'video' }, { caller: 'agent' })
    expect(first).toMatchObject({ ok: false, error: { code: 'approval-required' } })
    expect(calls).toHaveLength(0)
    const approvalId = (first.value as { approvalId: string }).approvalId
    const approved = await broker.approve(approvalId)
    expect(approved.ok).toBe(true)
    expect(calls.at(-1)).toMatchObject({ host: 'media.download.start', caller: 'agent' })
  })

  it('denies invocations after activation is turned off', async () => {
    await state.setActivation(extensionId, personalContext(), true)
    await state.setActivation(extensionId, personalContext(), false)
    const result = await invoke({ action: 'status' })
    expect(result).toMatchObject({ ok: false, error: { code: 'denied' } })
    expect(calls).toHaveLength(0)
  })
})

describe('activeYouTubePage', () => {
  const tab = (overrides: Partial<BrowserTabDescriptor> & Pick<BrowserTabDescriptor, 'id' | 'url' | 'active'>): BrowserTabDescriptor => ({
    targetId: 'builtin',
    profileId: 'builtin:default',
    title: 'A video',
    visible: true,
    ...overrides,
  })

  it('returns only the active YouTube page and canonicalizes it', () => {
    const page = activeYouTubePage([
      tab({ id: 'background', url: `https://www.youtube.com/watch?v=${videoId}`, active: false, title: 'Background' }),
      tab({ id: 'active', url: `https://youtu.be/${videoId}?t=4`, active: true, title: '  Active   title  ' }),
    ])
    expect(page).toEqual({
      url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      title: 'Active title',
    })
  })

  it('does not scan a background YouTube tab when the active tab is not YouTube', () => {
    expect(activeYouTubePage([
      tab({ id: 'background', url: `https://www.youtube.com/watch?v=${videoId}`, active: false }),
      tab({ id: 'active', url: 'https://example.com/', active: true, title: 'Example' }),
    ])).toBeNull()
  })

  it('falls back to a stable title and rejects non-video pages', () => {
    expect(activeYouTubePage([
      tab({ id: 'active', url: `https://www.youtube.com/shorts/${videoId}`, active: true, title: '   ' }),
    ])?.title).toBe(`YouTube ${videoId}`)
    expect(activeYouTubePage([
      tab({ id: 'active', url: 'https://www.youtube.com/feed/subscriptions', active: true }),
    ])).toBeNull()
  })
})
