import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { NativeHostRegistry } from '../src/main/extensions/native-host.js'
import { InvocationBroker, type NdOrganizationPort } from '../src/main/extensions/invocation-broker.js'
import { AssistantEngine, type RouterChatPort } from '../src/main/extensions/openspec-hub/assistant.js'
import { SnapshotCache } from '../src/main/extensions/openspec-hub/cache.js'
import { OpenSpecCli } from '../src/main/extensions/openspec-hub/openspec-cli.js'
import { TicketStore } from '../src/main/extensions/openspec-hub/tickets.js'
import { RootsStore } from '../src/main/extensions/openspec-hub/roots.js'
import { safeJoin } from '../src/main/extensions/openspec-hub/security.js'
import { flipCheckbox, replaceSection } from '../src/main/extensions/openspec-hub/writes.js'
import { HttpError } from '../src/main/extensions/openspec-hub/types.js'
import {
  buildHubConfig,
  NdRouterChatPort,
  OpenSpecHubService,
  OPENSPEC_HUB_ID,
  type OpenSpecRouterPort,
} from '../src/main/extensions/openspec-hub/nd-service.js'
import type { RouterPlaygroundEvent, RouterPlaygroundInput, RouterState } from '../src/shared/router.js'
import {
  manifestPermissionIssues,
  validateNdExtensionManifest,
  type NdExtensionManifest,
} from '../src/shared/extension-package.js'
import { personalContext } from '../src/shared/nd-context.js'

// The package lives in its own Git repo (Pinokio-style). Prefer the staged
// installer build (manifest + ui + vendored CLI, no dev node_modules); when it
// has not been built, fall back to a minimal fixture assembled from the
// committed root manifest so install/broker mechanics stay testable.
const hubRepo = fileURLToPath(new URL('../../openspec-hub/', import.meta.url))
const stagedDir = join(hubRepo, 'dist', 'nd-package')
const hasSibling = existsSync(join(hubRepo, 'nd-extension.json'))
const hasStaged = existsSync(join(stagedDir, 'nd-extension.json'))
const vendorBinRel = 'vendor/openspec/node_modules/@fission-ai/openspec/bin/openspec.js'
const realVendorBin = join(hubRepo, vendorBinRel)
const demoAlpha = join(hubRepo, 'fixtures', 'demo-alpha')
const demoBeta = join(hubRepo, 'fixtures', 'demo-beta')

const FALLBACK_MANIFEST_JSON = JSON.stringify({
  protocol: 'nd.extension/1',
  apiVersion: 1,
  id: OPENSPEC_HUB_ID,
  name: 'OpenSpec Hub',
  version: '0.1.0',
  description: 'Multi-project OpenSpec 2.0 dashboard across your pinned workspaces.',
  contexts: ['personal'],
  permissions: ['openspec.read', 'openspec.write'],
  settings: [
    { key: 'enableWrites', title: 'Allow assistant write proposals', type: 'boolean', default: false },
    { key: 'extraRoots', title: 'Extra project roots (; separated)', type: 'string', default: '' },
  ],
  contributions: {
    tools: [],
    skills: [],
    commands: [
      {
        id: 'open-hub',
        title: 'Open OpenSpec Hub',
        contexts: ['personal'],
        host: 'openspec.health',
        openViewId: 'hub',
      },
    ],
    views: [
      {
        id: 'hub',
        title: 'OpenSpec Hub',
        contexts: ['personal'],
        kind: 'web',
        entry: 'ui/index.html',
        actions: [
          { id: 'health', title: 'Health', host: 'openspec.health' },
          { id: 'projects', title: 'List projects', host: 'openspec.projects.list' },
          { id: 'roots-list', title: 'List roots', host: 'openspec.roots.list' },
          { id: 'roots-add', title: 'Add root', host: 'openspec.roots.add' },
          { id: 'roots-remove', title: 'Remove root', host: 'openspec.roots.remove' },
          { id: 'projects-pick', title: 'Pick project', host: 'openspec.projects.pick' },
          { id: 'snapshot', title: 'Get snapshot', host: 'openspec.snapshot.get' },
          { id: 'change', title: 'Get change', host: 'openspec.change.get' },
          { id: 'spec', title: 'Get spec', host: 'openspec.spec.get' },
          { id: 'doc', title: 'Get doc', host: 'openspec.doc.get' },
          { id: 'validation', title: 'Get validation', host: 'openspec.validation.get' },
          { id: 'refresh', title: 'Refresh project', host: 'openspec.refresh' },
          { id: 'tickets-list', title: 'List tickets', host: 'openspec.tickets.list' },
          { id: 'tickets-save', title: 'Save ticket', host: 'openspec.tickets.save' },
          { id: 'tickets-delete', title: 'Delete ticket', host: 'openspec.tickets.delete' },
          { id: 'assistant-status', title: 'Assistant status', host: 'openspec.assistant.status' },
          { id: 'assistant-models', title: 'Assistant models', host: 'openspec.assistant.models' },
          { id: 'assistant-ask', title: 'Ask assistant', host: 'openspec.assistant.ask' },
          { id: 'assistant-poll', title: 'Poll assistant', host: 'openspec.assistant.poll' },
          { id: 'assistant-active-get', title: 'Get active project', host: 'openspec.assistant.active.get' },
          { id: 'assistant-active-set', title: 'Set active project', host: 'openspec.assistant.active.set' },
          { id: 'actions-list', title: 'List actions', host: 'openspec.actions.list' },
          { id: 'actions-approve', title: 'Approve action', host: 'openspec.actions.approve' },
          { id: 'actions-reject', title: 'Reject action', host: 'openspec.actions.reject' },
        ],
      },
    ],
    workflows: [],
  },
})

async function loadManifest(): Promise<NdExtensionManifest> {
  const raw = hasSibling ? await readFile(join(hubRepo, 'nd-extension.json'), 'utf8') : FALLBACK_MANIFEST_JSON
  const parsed: unknown = JSON.parse(raw)
  const result = validateNdExtensionManifest(parsed)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  return result.manifest
}

async function installablePackage(root: string): Promise<string> {
  if (hasStaged) return stagedDir
  const dir = join(root, 'fixture-package')
  await mkdir(join(dir, 'ui'), { recursive: true })
  const raw = hasSibling ? await readFile(join(hubRepo, 'nd-extension.json'), 'utf8') : FALLBACK_MANIFEST_JSON
  await writeFile(join(dir, 'nd-extension.json'), raw)
  await writeFile(join(dir, 'ui', 'index.html'), '<!doctype html><title>OpenSpec Hub</title>')
  const bin = join(dir, vendorBinRel)
  await mkdir(join(bin, '..'), { recursive: true })
  await writeFile(bin, '#!/usr/bin/env node\n// placeholder: install-mechanics fixture, never executed\n')
  return dir
}

const organization: NdOrganizationPort = {
  state: async () => ({
    companies: [{ id: 'c1' } as never],
    projects: [{ id: 'p1', companyId: 'c1' } as never],
    memory: [],
  }),
}

describe.skipIf(!hasSibling)('OpenSpec Hub extension package', () => {
  it('validates as a Personal-only web-view package with read/write permissions', async () => {
    const manifest = await loadManifest()
    expect(manifest.id).toBe(OPENSPEC_HUB_ID)
    expect(manifest.contexts).toEqual(['personal'])
    expect(manifest.permissions).toEqual(['openspec.read', 'openspec.write'])
    expect(manifest.executable).toBeUndefined()
    expect(manifestPermissionIssues(manifest)).toEqual([])
    expect(manifest.settings?.map((s) => s.key)).toEqual(['enableWrites', 'extraRoots'])

    const [view] = manifest.contributions.views
    expect(view?.kind).toBe('web')
    expect(view?.entry).toBe('ui/index.html')
    expect(view?.host).toBeUndefined()
    expect(view?.actions.map((action) => [action.id, action.host])).toEqual([
      ['health', 'openspec.health'],
      ['projects', 'openspec.projects.list'],
      ['roots-list', 'openspec.roots.list'],
      ['roots-add', 'openspec.roots.add'],
      ['roots-remove', 'openspec.roots.remove'],
      ['projects-pick', 'openspec.projects.pick'],
      ['snapshot', 'openspec.snapshot.get'],
      ['change', 'openspec.change.get'],
      ['spec', 'openspec.spec.get'],
      ['doc', 'openspec.doc.get'],
      ['validation', 'openspec.validation.get'],
      ['refresh', 'openspec.refresh'],
      ['tickets-list', 'openspec.tickets.list'],
      ['tickets-save', 'openspec.tickets.save'],
      ['tickets-delete', 'openspec.tickets.delete'],
      ['assistant-status', 'openspec.assistant.status'],
      ['assistant-models', 'openspec.assistant.models'],
      ['assistant-ask', 'openspec.assistant.ask'],
      ['assistant-poll', 'openspec.assistant.poll'],
      ['assistant-active-get', 'openspec.assistant.active.get'],
      ['assistant-active-set', 'openspec.assistant.active.set'],
      ['actions-list', 'openspec.actions.list'],
      ['actions-approve', 'openspec.actions.approve'],
      ['actions-reject', 'openspec.actions.reject'],
    ])
    expect(manifest.contributions.commands[0]?.openViewId).toBe('hub')
  })

  it('installs with its UI and vendored CLI, activates, and uninstalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-openspec-hub-'))
    try {
      const packages = new ExtensionPackageStore(root)
      const source = await installablePackage(root)
      const installed = await packages.installFromDirectory(source, { expectId: OPENSPEC_HUB_ID })
      expect(installed.id).toBe(OPENSPEC_HUB_ID)

      for (const rel of ['nd-extension.json', 'ui/index.html', vendorBinRel]) {
        expect(await packages.snapshotFileFor(OPENSPEC_HUB_ID, installed.version, rel), rel).not.toBeNull()
      }
      if (hasStaged) {
        expect(await packages.snapshotFileFor(OPENSPEC_HUB_ID, installed.version, 'vendor/openspec/package.json')).not.toBeNull()
      }

      const state = new InvocationStateStore(root)
      expect(await state.activation(OPENSPEC_HUB_ID, personalContext())).toBeUndefined()
      await state.setActivation(OPENSPEC_HUB_ID, personalContext(), true)
      expect((await state.activation(OPENSPEC_HUB_ID, personalContext()))?.enabled).toBe(true)

      await packages.uninstall(OPENSPEC_HUB_ID)
      expect(await packages.activeManifest(OPENSPEC_HUB_ID)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('OpenSpec Hub broker gating', () => {
  let root: string
  let packages: ExtensionPackageStore
  let state: InvocationStateStore
  let host: NativeHostRegistry
  let broker: InvocationBroker
  let calls: string[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nd-openspec-hub-broker-'))
    packages = new ExtensionPackageStore(join(root, 'packages'))
    state = new InvocationStateStore(join(root, 'state'))
    host = new NativeHostRegistry()
    calls = []

    for (const method of [
      'openspec.projects.list',
      'openspec.snapshot.get',
      'openspec.tickets.save',
      'openspec.roots.list',
      'openspec.roots.add',
      'openspec.roots.remove',
      'openspec.projects.pick',
      'openspec.assistant.active.get',
      'openspec.assistant.active.set',
    ] as const) {
      host.register(method, async (input) => {
        calls.push(method)
        return { ok: true, method, input }
      })
    }

    await packages.installFromDirectory(await installablePackage(root), { expectId: OPENSPEC_HUB_ID })
    await state.setActivation(OPENSPEC_HUB_ID, personalContext(), true)

    broker = new InvocationBroker({ packages, state, host, organization })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const invoke = (overrides: Partial<Parameters<InvocationBroker['invoke']>[0]>) =>
    broker.invoke(
      {
        extensionId: OPENSPEC_HUB_ID,
        contributionId: 'hub',
        contributionKind: 'view',
        context: personalContext(),
        caller: 'user',
        input: {},
        ...overrides,
      },
      overrides.caller === 'agent' ? { credentialBacked: true } : undefined,
    )

  it('loads the web view with its entry and without running any host method', async () => {
    const view = await broker.loadView(OPENSPEC_HUB_ID, 'hub', personalContext())
    expect(view).toMatchObject({ kind: 'web', extensionId: OPENSPEC_HUB_ID, viewId: 'hub' })
    expect(view.webView?.entry).toBe('ui/index.html')
    expect(view.rows).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses to load the web view before activation', async () => {
    await state.setActivation(OPENSPEC_HUB_ID, personalContext(), false)
    await expect(broker.loadView(OPENSPEC_HUB_ID, 'hub', personalContext())).rejects.toThrow(/Activate/)
    expect(calls).toEqual([])
  })

  it('never executes the web view without a named action', async () => {
    const result = await invoke({})
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(calls).toEqual([])
  })

  it('routes declared actions to their hosts and relays input untouched', async () => {
    const projects = await invoke({ input: { action: 'projects' } })
    expect(projects).toMatchObject({ ok: true })
    const save = await invoke({ input: { action: 'tickets-save', projectId: 'demo-alpha', title: 'T' } })
    expect(save).toMatchObject({ ok: true, value: { method: 'openspec.tickets.save', input: { projectId: 'demo-alpha', title: 'T' } } })
    const add = await invoke({ input: { action: 'roots-add', path: 'C:/repo', name: 'Repo' } })
    expect(add).toMatchObject({ ok: true, value: { method: 'openspec.roots.add', input: { path: 'C:/repo', name: 'Repo' } } })
    const pick = await invoke({ input: { action: 'projects-pick' } })
    expect(pick).toMatchObject({ ok: true, value: { method: 'openspec.projects.pick' } })
    expect(calls).toEqual(['openspec.projects.list', 'openspec.tickets.save', 'openspec.roots.add', 'openspec.projects.pick'])
  })

  it('relays the active-project preference and lets agents set it without a grant', async () => {
    const get = await invoke({ input: { action: 'assistant-active-get' } })
    expect(get).toMatchObject({ ok: true, value: { method: 'openspec.assistant.active.get' } })
    const set = await invoke({ input: { action: 'assistant-active-set', projectId: 'demo-alpha' } })
    expect(set).toMatchObject({ ok: true, value: { method: 'openspec.assistant.active.set', input: { projectId: 'demo-alpha' } } })
    const agentSet = await invoke({ caller: 'agent', input: { action: 'assistant-active-set', projectId: 'demo-beta' } })
    expect(agentSet).toMatchObject({ ok: true, value: { method: 'openspec.assistant.active.set', input: { projectId: 'demo-beta' } } })
    expect(calls).toEqual(['openspec.assistant.active.get', 'openspec.assistant.active.set', 'openspec.assistant.active.set'])
  })

  it('requires an explicit grant before an agent may register a project root', async () => {
    const result = await invoke({ caller: 'agent', input: { action: 'roots-add', path: 'C:/repo' } })
    expect(result).toMatchObject({ ok: false, error: { code: 'approval-required' } })
    expect(calls).toEqual([])
    await broker.approve((result.value as { approvalId: string }).approvalId, true)
    const granted = await invoke({ caller: 'agent', input: { action: 'roots-add', path: 'C:/repo' } })
    expect(granted).toMatchObject({ ok: true })
    expect(calls).toEqual(['openspec.roots.add', 'openspec.roots.add'])
  })

  it('denies a Personal-only package in a project context', async () => {
    const result = await invoke({
      context: { kind: 'project', companyId: 'c1', projectId: 'p1' },
      input: { action: 'projects' },
    })
    expect(result).toMatchObject({ ok: false })
    expect(calls).toEqual([])
  })

  it('requires an explicit grant before an agent may read a sensitive snapshot', async () => {
    const result = await invoke({ caller: 'agent', input: { action: 'snapshot', projectId: 'demo-alpha' } })
    expect(result).toMatchObject({ ok: false, error: { code: 'approval-required' } })
    expect(calls).toEqual([])
    const approvalId = (result.value as { approvalId: string }).approvalId
    await broker.approve(approvalId, true)
    const granted = await invoke({ caller: 'agent', input: { action: 'snapshot', projectId: 'demo-alpha' } })
    expect(granted).toMatchObject({ ok: true })
    // Approving replays the held call; the explicit retry runs under the fresh grant.
    expect(calls).toEqual(['openspec.snapshot.get', 'openspec.snapshot.get'])
  })
})

describe('buildHubConfig', () => {
  it('keeps pinned workspaces with openspec/, adds extraRoots, and dedupes by canonical path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-openspec-hub-config-'))
    try {
      const alpha = join(root, 'demo-alpha')
      const beta = join(root, 'demo-beta')
      const plain = join(root, 'No Spec Here')
      await mkdir(join(alpha, 'openspec'), { recursive: true })
      await mkdir(join(beta, 'openspec'), { recursive: true })
      await mkdir(plain, { recursive: true })
      const config = buildHubConfig(
        [
          { root: alpha, name: 'Demo Alpha' },
          { root: plain, name: 'Plain' },
        ],
        `${beta};${alpha}`,
      )
      expect(config.projects.map((p) => p.id)).toEqual(['demo-alpha', 'demo-beta'])
      expect(config.projects[0]?.name).toBe('Demo Alpha')
      expect(config.projects[1]?.path).toBe(beta)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('appends registered roots with display names and dedupes against earlier sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-openspec-hub-registered-'))
    try {
      const alpha = join(root, 'demo-alpha')
      const beta = join(root, 'demo-beta')
      const extra = join(root, 'Extra Repo')
      await mkdir(join(alpha, 'openspec'), { recursive: true })
      await mkdir(join(beta, 'openspec'), { recursive: true })
      await mkdir(join(extra, 'openspec'), { recursive: true })
      const config = buildHubConfig([{ root: alpha }], beta, [
        { path: extra, name: 'Extra Repo' },
        { path: beta, name: 'Should Dedupe' },
      ])
      expect(config.projects.map((p) => p.id)).toEqual(['demo-alpha', 'demo-beta', 'extra-repo'])
      expect(config.projects[1]?.name).toBe('demo-beta')
      expect(config.projects[2]?.name).toBe('Extra Repo')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('sanitizes directory names into safe project ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-openspec-hub-ids-'))
    try {
      const messy = join(root, 'My Project (2026)')
      await mkdir(join(messy, 'openspec'), { recursive: true })
      const config = buildHubConfig([{ root: messy }], '')
      expect(config.projects[0]?.id).toBe('my-project-2026')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('RootsStore (registered project directories)', () => {
  it('registers openspec directories, persists them, and removes them by path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-openspec-roots-'))
    try {
      const project = join(root, 'my-repo')
      await mkdir(join(project, 'openspec'), { recursive: true })
      const store = new RootsStore(join(root, 'data'))
      expect(store.list()).toEqual([])
      const added = store.add(project, 'My Repo')
      expect(added.name).toBe('My Repo')
      expect(store.list()).toEqual([added])
      expect(new RootsStore(join(root, 'data')).list()).toEqual([added])
      store.remove(project)
      expect(store.list()).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects relative, missing, non-openspec, and duplicate directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-openspec-roots-bad-'))
    try {
      const plain = join(root, 'plain')
      const project = join(root, 'repo')
      await mkdir(plain, { recursive: true })
      await mkdir(join(project, 'openspec'), { recursive: true })
      const store = new RootsStore(join(root, 'data'))
      const errOf = (fn: () => unknown): unknown => {
        try {
          fn()
        } catch (error) {
          return error
        }
        throw new Error('expected the call to throw')
      }
      expect(errOf(() => store.add('relative/path'))).toBeInstanceOf(HttpError)
      expect(errOf(() => store.add(join(root, 'missing')))).toMatchObject({ statusCode: 404, code: 'root-missing' })
      expect(errOf(() => store.add(plain))).toMatchObject({ statusCode: 400, code: 'root-not-openspec' })
      store.add(project)
      expect(errOf(() => store.add(project))).toMatchObject({ statusCode: 409, code: 'duplicate-root' })
      expect(errOf(() => store.remove(plain))).toMatchObject({ statusCode: 404, code: 'unknown-root' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('TicketStore (ND port)', () => {
  it('creates, lists, updates, and deletes tickets in the Hub data dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-openspec-hub-tickets-'))
    try {
      const store = new TicketStore(root)
      const created = store.create('demo-alpha', { title: 'Fix login', priority: 'high' })
      expect(created.id).toMatch(/^t-[0-9a-f]{8}$/)
      expect(store.list('demo-alpha')).toHaveLength(1)

      const updated = store.update('demo-alpha', created.id, { status: 'in-progress' })
      expect(updated.status).toBe('in-progress')
      expect(updated.title).toBe('Fix login')

      const cleared = store.update('demo-alpha', created.id, { linkedChangeId: null })
      expect(cleared.linkedChangeId).toBeUndefined()

      store.delete('demo-alpha', created.id)
      expect(store.list('demo-alpha')).toEqual([])
      expect(() => store.delete('demo-alpha', created.id)).toThrow(HttpError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects invalid titles and unsafe project ids at the boundary', () => {
    const store = new TicketStore(join(tmpdir(), 'nd-openspec-hub-unused'))
    expect(() => store.create('demo-alpha', { title: '  ' })).toThrow(/title/)
    expect(() => store.list('../evil')).toThrow(/identifier/)
    expect(() => store.create('demo-alpha', { title: 'x'.repeat(201) })).toThrow(/title/)
  })
})

describe.skipIf(!hasSibling || !existsSync(realVendorBin))('OpenSpec engine over the vendored CLI', () => {
  it('scans a real fixture workspace through the installed CLI', async () => {
    const config = { projects: [{ id: 'demo-alpha', name: 'Demo Alpha', path: demoAlpha }] }
    const cache = new SnapshotCache(config, new OpenSpecCli(realVendorBin))
    expect((await cache.portfolio()).map((p) => p.id)).toEqual(['demo-alpha'])
    const snapshot = await cache.get('demo-alpha')
    expect(snapshot.available).toBe(true)
    expect(snapshot.changes.length).toBeGreaterThan(0)
    expect(snapshot.specs.length).toBeGreaterThan(0)
    expect(snapshot.docs.length).toBeGreaterThan(0)
  }, 60_000)

  it('runs an assistant turn through a stub RouterChatPort and buffers events for polling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-openspec-hub-engine-'))
    try {
      const config = { projects: [{ id: 'demo-alpha', name: 'Demo Alpha', path: demoAlpha }] }
      const cache = new SnapshotCache(config, new OpenSpecCli(realVendorBin))
      const router: RouterChatPort = {
        models: async () => ['stub-model', 'p1/cohere/north-mini-code:free'],
        chat: async () => ({ text: 'Stub answer about the project.' }),
      }
      const engine = new AssistantEngine({
        config,
        cache,
        tickets: new TicketStore(root),
        writesEnabled: false,
        router,
        defaultModel: 'stub-model',
      })
      expect(engine.configured).toBe(true)
      expect(engine.writesEnabled).toBe(false)
      expect(await engine.models()).toEqual({ models: ['stub-model', 'p1/cohere/north-mini-code:free'], default: 'stub-model' })

      const { jobId } = engine.ask({ message: 'Summarize pending changes', projectId: 'demo-alpha' })
      await vi.waitFor(() => {
        expect(engine.poll(jobId).status).toBe('done')
      }, { timeout: 20_000 })
      const { events } = engine.poll(jobId)
      const done = events.find((e) => e.type === 'done')
      expect(done).toMatchObject({ type: 'done', text: 'Stub answer about the project.', model: 'stub-model' })

      // Free-tier model ids carry ':' and nested '/'; both must survive validation and routing.
      const colon = engine.ask({ message: 'hello', projectId: 'demo-alpha', model: 'p1/cohere/north-mini-code:free' })
      await vi.waitFor(() => {
        expect(engine.poll(colon.jobId).status).toBe('done')
      }, { timeout: 20_000 })
      expect(engine.poll(colon.jobId).events.find((e) => e.type === 'done')).toMatchObject({ model: 'p1/cohere/north-mini-code:free' })

      const unconfigured = new AssistantEngine({ config, cache, tickets: new TicketStore(root), writesEnabled: false })
      expect(unconfigured.configured).toBe(false)
      const bad = unconfigured.ask({ message: 'hello' })
      await vi.waitFor(() => {
        expect(unconfigured.poll(bad.jobId).status).toBe('error')
      }, { timeout: 5_000 })
      expect(unconfigured.poll(bad.jobId).events.some((e) => e.type === 'error' && e.code === 'assistant-unavailable')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

function routerStub(overrides: Partial<OpenSpecRouterPort> & { state?: () => Promise<RouterState> }): OpenSpecRouterPort {
  return {
    state: async () => ({ providers: [], combos: [], counters: { requests: 0, ok: 0, failed: 0 } }) as RouterState,
    playgroundStart: () => {},
    playgroundStop: () => {},
    ...overrides,
  }
}

describe('NdRouterChatPort', () => {
  it('lists combos plus active chat lanes, including secret-less free/CLI kinds but not TTS', async () => {
    const port = new NdRouterChatPort(
      routerStub({
        state: async () =>
          ({
            endpoint: 'http://127.0.0.1:9',
            combos: [{ id: 'fast-combo' }],
            providers: [
              { id: 'p1', kind: 'openai-compatible', isActive: true, hasSecret: true, models: ['m1', 'm2'] },
              { id: 'p2', kind: 'openai-compatible', isActive: false, hasSecret: true, models: ['m3'] },
              { id: 'p3', kind: 'openai-compatible', isActive: true, hasSecret: false, models: ['m4'] },
              { id: 'kilo', kind: 'kilo-gateway', isActive: true, hasSecret: false, models: ['openrouter/free', 'cohere/north-mini-code:free'] },
              { id: 'agy', kind: 'antigravity', isActive: true, hasSecret: false, models: ['gemini-3.8-flash-medium'] },
              { id: 'tts', kind: 'edge-tts', isActive: true, hasSecret: false, models: ['en-US-AriaNeural'] },
            ],
            counters: { requests: 0, ok: 0, failed: 0 },
          }) as unknown as RouterState,
      }),
    )
    expect(await port.models()).toEqual([
      'fast-combo',
      'p1/m1',
      'p1/m2',
      'kilo/openrouter/free',
      'kilo/cohere/north-mini-code:free',
      'agy/gemini-3.8-flash-medium',
    ])
  })

  it('streams a combo turn through the playground lane and accumulates deltas', async () => {
    let captured: RouterPlaygroundInput | undefined
    let emit: ((event: RouterPlaygroundEvent) => void) | undefined
    const port = new NdRouterChatPort(
      routerStub({
        state: async () =>
          ({ combos: [{ id: 'fast-combo' }], providers: [], counters: { requests: 0, ok: 0, failed: 0 } }) as unknown as RouterState,
        playgroundStart: (input, onEvent) => {
          captured = input
          emit = onEvent
        },
      }),
    )
    const deltas: string[] = []
    const pending = port.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'fast-combo',
      onDelta: (text) => deltas.push(text),
    })
    await vi.waitFor(() => expect(captured).toBeDefined())
    expect(captured?.route).toEqual({ kind: 'combo', combo: 'fast-combo' })
    expect(captured?.stream).toBe(true)
    const requestId = captured!.requestId
    emit!({ requestId, type: 'delta', delta: 'Hel' })
    emit!({ requestId, type: 'delta', delta: 'lo' })
    emit!({ requestId: 'other-request', type: 'delta', delta: 'IGNORED' })
    emit!({ requestId, type: 'done', text: 'Hello' })
    expect(await pending).toEqual({ text: 'Hello' })
    expect(deltas).toEqual(['Hel', 'lo'])
  })

  it('routes provider/model ids to the model lane', async () => {
    let captured: RouterPlaygroundInput | undefined
    const port = new NdRouterChatPort(
      routerStub({
        playgroundStart: (input, onEvent) => {
          captured = input
          onEvent({ requestId: input.requestId, type: 'done', text: 'ok' })
        },
      }),
    )
    expect(await port.chat({ messages: [], model: 'p1/m1' })).toEqual({ text: 'ok' })
    expect(captured?.route).toEqual({ kind: 'model', providerId: 'p1', model: 'm1' })
  })

  it('surfaces router errors as HttpError 502 and aborts as 499 with playgroundStop', async () => {
    const stopped: string[] = []
    const port = new NdRouterChatPort(
      routerStub({
        playgroundStart: (input, onEvent) => {
          if (input.messages.length === 0) {
            onEvent({ requestId: input.requestId, type: 'error', error: 'upstream down' })
          }
        },
        playgroundStop: (requestId) => stopped.push(requestId),
      }),
    )
    await expect(port.chat({ messages: [], model: 'fast-combo' })).rejects.toMatchObject({
      statusCode: 502,
      code: 'router-error',
    })

    const controller = new AbortController()
    const pending = port.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'fast-combo', signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ statusCode: 499, code: 'cancelled' })
    expect(stopped).toHaveLength(1)
  })
})

describe('OpenSpecHubService', () => {
  it('gates on installation, rebuilds bundles on settings changes, and caches scans', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-openspec-hub-service-'))
    try {
      const alpha = join(root, 'demo-alpha')
      const beta = join(root, 'demo-beta')
      await mkdir(join(alpha, 'openspec'), { recursive: true })
      await mkdir(join(beta, 'openspec'), { recursive: true })
      const packages = new ExtensionPackageStore(join(root, 'packages'))
      const workspaces = {
        list: async () => ({
          version: 1 as const,
          items: [{ id: 'w1', root: alpha, name: 'Demo Alpha', addedAt: 0 }],
        }),
      }
      const service = new OpenSpecHubService({ workspaces, packages, dataDir: join(root, 'data') })

      await expect(service.bundleFor({})).rejects.toMatchObject({ statusCode: 503, code: 'extension-not-installed' })

      await packages.installFromDirectory(await installablePackage(root), { expectId: OPENSPEC_HUB_ID })
      const bundle = await service.bundleFor({})
      expect(bundle.engine.writesEnabled).toBe(false)
      expect(bundle.config.projects.map((p) => p.id)).toEqual(['demo-alpha'])
      expect(await service.bundleFor({})).toBe(bundle)

      const writable = await service.bundleFor({ enableWrites: true })
      expect(writable).not.toBe(bundle)
      expect(writable.engine.writesEnabled).toBe(true)

      const extra = await service.bundleFor({ enableWrites: true, extraRoots: beta })
      expect(extra.config.projects.map((p) => p.id)).toEqual(['demo-alpha', 'demo-beta'])

      expect(await service.routerConfigured()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rebuilds the bundle when a project root is registered or removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-openspec-hub-roots-svc-'))
    try {
      const alpha = join(root, 'demo-alpha')
      const beta = join(root, 'demo-beta')
      await mkdir(join(alpha, 'openspec'), { recursive: true })
      await mkdir(join(beta, 'openspec'), { recursive: true })
      const packages = new ExtensionPackageStore(join(root, 'packages'))
      const workspaces = {
        list: async () => ({
          version: 1 as const,
          items: [{ id: 'w1', root: alpha, name: 'Demo Alpha', addedAt: 0 }],
        }),
      }
      const service = new OpenSpecHubService({ workspaces, packages, dataDir: join(root, 'data') })
      await packages.installFromDirectory(await installablePackage(root), { expectId: OPENSPEC_HUB_ID })

      const before = await service.bundleFor({})
      expect(before.config.projects.map((p) => p.id)).toEqual(['demo-alpha'])

      service.roots.add(beta, 'Registered Beta')
      const added = await service.bundleFor({})
      expect(added).not.toBe(before)
      expect(added.config.projects.map((p) => p.id)).toEqual(['demo-alpha', 'demo-beta'])
      expect(added.config.projects[1]?.name).toBe('Registered Beta')

      service.roots.remove(beta)
      const removed = await service.bundleFor({})
      expect(removed.config.projects.map((p) => p.id)).toEqual(['demo-alpha'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when the vendored CLI is missing from the snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-openspec-hub-nocli-'))
    try {
      const service = new OpenSpecHubService({
        workspaces: { list: async () => ({ version: 1 as const, items: [] }) },
        packages: {
          record: async () => ({ manifest: { version: '9.9.9' } }) as never,
          snapshotDir: () => join(root, 'does-not-exist'),
        },
        dataDir: join(root, 'data'),
      })
      await expect(service.bundleFor({})).rejects.toMatchObject({ statusCode: 503, code: 'cli-missing' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports router configuration from the playground endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-openspec-hub-router-'))
    try {
      const packages = {
        record: async () => undefined,
        snapshotDir: () => root,
      }
      const workspaces = { list: async () => ({ version: 1 as const, items: [] }) }
      const configured = new OpenSpecHubService({
        workspaces,
        packages,
        dataDir: root,
        router: routerStub({ state: async () => ({ endpoint: 'http://127.0.0.1:9' }) as unknown as RouterState }),
      })
      expect(await configured.routerConfigured()).toBe(true)
      const broken = new OpenSpecHubService({
        workspaces,
        packages,
        dataDir: root,
        router: routerStub({ state: async () => { throw new Error('sidecar down') } }),
      })
      expect(await broken.routerConfigured()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves CRLF line endings in flipCheckbox and replaceSection and blocks case-insensitive .env paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-openspec-hub-crlf-'))
    try {
      const projectRoot = join(root, 'proj')
      await mkdir(join(projectRoot, 'openspec', 'changes', 'add-feature'), { recursive: true })

      expect(flipCheckbox('- [ ] 1.1 First item\r', true)).toBe('- [x] 1.1 First item\r')
      expect(flipCheckbox('- [x] 1.2 Second item\r', false)).toBe('- [ ] 1.2 Second item\r')

      const proposalMd = '# Change: Demo\r\n\r\n## Why\r\nOld reason.\r\n\r\n## What Changes\r\n- Item A\r\n'
      const afterReplace = replaceSection(proposalMd, 'Why', 'Updated reason line 1.\nUpdated reason line 2.')
      expect(afterReplace).toContain('## Why\r\n\r\nUpdated reason line 1.\r\nUpdated reason line 2.\r\n\r\n## What Changes\r\n')

      expect(() => safeJoin(projectRoot, 'openspec/.ENV.local')).toThrow(/not readable/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!hasStaged)('OpenSpecHubService with the staged package', () => {
  it('scans pinned workspaces end-to-end through the installed vendored CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-openspec-hub-e2e-'))
    try {
      const packages = new ExtensionPackageStore(join(root, 'packages'))
      await packages.installFromDirectory(stagedDir, { expectId: OPENSPEC_HUB_ID })
      const service = new OpenSpecHubService({
        workspaces: {
          list: async () => ({
            version: 1 as const,
            items: [
              { id: 'w1', root: demoAlpha, name: 'Demo Alpha', addedAt: 0 },
              { id: 'w2', root: demoBeta, name: 'Demo Beta', addedAt: 0 },
            ],
          }),
        },
        packages,
        dataDir: join(root, 'data'),
      })
      const { cache } = await service.bundleFor({})
      const portfolio = await cache.portfolio()
      expect(portfolio.map((p) => p.id).sort()).toEqual(['demo-alpha', 'demo-beta'])
      const snapshot = await cache.get('demo-alpha')
      expect(snapshot.available).toBe(true)
      expect(snapshot.changes.length).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})