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
  ND_HOST_METHODS,
  manifestPermissionIssues,
  ndHostMethod,
  validateNdExtensionManifest,
  type NdExtensionManifest,
} from '../src/shared/extension-package.js'
import { OS_TOOLKIT_EXTENSION_ID, osToolkitApplyTarget } from '../src/shared/os-toolkit-schedule.js'
import { personalContext } from '../src/shared/nd-context.js'

const packagePath = fileURLToPath(new URL('../extensions/nd-os-toolkit/', import.meta.url))
const manifestPath = new URL('../extensions/nd-os-toolkit/nd-extension.json', import.meta.url)

async function loadManifest(): Promise<NdExtensionManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const result = validateNdExtensionManifest(parsed)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  return result.manifest
}

describe('OS Toolkit ND extension package', () => {
  it('validates as a Personal-only web-view package with no missing permissions', async () => {
    const manifest = await loadManifest()
    expect(manifest.id).toBe(OS_TOOLKIT_EXTENSION_ID)
    expect(manifest.name).toBe('OS Toolkit')
    expect(manifest.contexts).toEqual(['personal'])
    expect(manifest.permissions).toEqual(['ostoolkit.read', 'ostoolkit.write'])
    expect(manifest.executable).toBeUndefined()
    expect(manifest.category).toBe('system')
    expect(manifestPermissionIssues(manifest)).toEqual([])

    const [view] = manifest.contributions.views
    expect(view?.kind).toBe('web')
    expect(view?.entry).toBe('ui/index.html')
    // A web view has no data host of its own; only named actions execute.
    expect(view?.host).toBeUndefined()
    expect(view?.actions.map((action) => [action.id, action.host])).toEqual([
      ['status', 'ostoolkit.theme.status'],
      ['probe', 'ostoolkit.backends.probe'],
      ['schedule-get', 'ostoolkit.schedule.get'],
      ['schedule-save', 'ostoolkit.schedule.save'],
      ['apply', 'ostoolkit.theme.apply'],
    ])
  })

  it('declares contexts explicitly on every contribution', async () => {
    // Known authoring defect: a contribution missing `contexts` silently
    // mis-scopes, so this is pinned rather than left to convention.
    const manifest = await loadManifest()
    const all = [
      ...manifest.contributions.commands,
      ...manifest.contributions.views,
      ...manifest.contributions.tools,
      ...manifest.contributions.skills,
    ]
    expect(all.length).toBeGreaterThan(0)
    for (const contribution of all) {
      expect(contribution.contexts, `${contribution.id} must declare contexts`).toEqual(['personal'])
    }
  })

  it('keeps the read/write split: only theme.apply is sensitive', async () => {
    const reads = ['ostoolkit.theme.status', 'ostoolkit.backends.probe', 'ostoolkit.schedule.get']
    for (const id of reads) {
      const descriptor = ndHostMethod(id)
      expect(descriptor, id).toBeDefined()
      expect(descriptor?.sensitive, `${id} must not prompt`).toBe(false)
      expect(descriptor?.permission, id).toBe('ostoolkit.read')
      expect(descriptor?.contexts, id).toEqual(['personal'])
    }
    const save = ndHostMethod('ostoolkit.schedule.save')
    // Saving config mutates nothing the user can see, so it is a write without a
    // desktop effect and stays non-sensitive.
    expect(save?.sensitive).toBe(false)
    expect(save?.permission).toBe('ostoolkit.write')

    const apply = ndHostMethod('ostoolkit.theme.apply')
    // Changing the whole desktop always needs an explicit grant from an agent.
    expect(apply?.sensitive).toBe(true)
    expect(apply?.permission).toBe('ostoolkit.write')

    // Every host method the manifest references must exist in the allowlist, or
    // the broker refuses that contribution at resolve time. Derived from the
    // manifest rather than listed, so a new action cannot slip past unregistered.
    const manifest = await loadManifest()
    const declared = [...new Set([
      ...manifest.contributions.commands.map((command) => command.host),
      ...manifest.contributions.views.flatMap((view) => view.actions.map((action) => action.host)),
    ])]
    const allowlist: string[] = ND_HOST_METHODS.map((method) => method.id)
    expect(declared.length).toBeGreaterThan(0)
    for (const id of declared) {
      expect(allowlist, `${id} missing from ND_HOST_METHODS`).toContain(id)
    }
  })

  it('describes its eight settings with the effectful switch defaulted off', async () => {
    const manifest = await loadManifest()
    expect(manifest.settings.map((field) => field.key)).toEqual([
      'schedulerEnabled',
      'backend',
      'dayStart',
      'nightStart',
      'applyApps',
      'applySystem',
      'lightSwitchSync',
      'startupReconcile',
    ])
    const schedulerEnabled = manifest.settings.find((field) => field.key === 'schedulerEnabled')
    expect(schedulerEnabled?.type).toBe('boolean')
    expect(schedulerEnabled?.default).toBe(false)
    // A schedule needs minute resolution and the manifest type has no time widget,
    // so times are HH:MM strings validated in the host.
    expect(manifest.settings.find((field) => field.key === 'dayStart')?.type).toBe('string')
    expect(manifest.settings.find((field) => field.key === 'nightStart')?.type).toBe('string')
  })

  it('installs from its folder including the shipped UI, activates, and uninstalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-os-toolkit-'))
    try {
      const packages = new ExtensionPackageStore(root)
      const installed = await packages.installFromDirectory(packagePath, { expectId: OS_TOOLKIT_EXTENSION_ID })
      expect(installed.id).toBe(OS_TOOLKIT_EXTENSION_ID)

      for (const asset of [
        'nd-extension.json',
        'ui/index.html',
        'ui/bridge.js',
        'ui/schedule-core.js',
        'ui/schedule-core.d.ts',
        'ui/studio.js',
      ]) {
        expect(await packages.snapshotFileFor(OS_TOOLKIT_EXTENSION_ID, installed.version, asset), asset).not.toBeNull()
      }

      const state = new InvocationStateStore(root)
      expect(await state.activation(OS_TOOLKIT_EXTENSION_ID, personalContext())).toBeUndefined()
      await state.setActivation(OS_TOOLKIT_EXTENSION_ID, personalContext(), true)
      expect((await state.activation(OS_TOOLKIT_EXTENSION_ID, personalContext()))?.enabled).toBe(true)

      await packages.uninstall(OS_TOOLKIT_EXTENSION_ID)
      expect(await packages.activeManifest(OS_TOOLKIT_EXTENSION_ID)).toBeUndefined()
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

const HOST_METHODS = [
  'ostoolkit.theme.status',
  'ostoolkit.backends.probe',
  'ostoolkit.schedule.get',
  'ostoolkit.schedule.save',
  'ostoolkit.theme.apply',
] as const

describe('OS Toolkit broker gating', () => {
  let root: string
  let packages: ExtensionPackageStore
  let state: InvocationStateStore
  let host: NativeHostRegistry
  let broker: InvocationBroker
  let calls: string[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nd-os-toolkit-broker-'))
    packages = new ExtensionPackageStore(join(root, 'packages'))
    state = new InvocationStateStore(join(root, 'state'))
    host = new NativeHostRegistry()
    calls = []
    for (const method of HOST_METHODS) {
      host.register(method, async (input, context) => {
        calls.push(method)
        return { ok: true, method, host: context.host, input }
      })
    }
    await packages.registerBuiltin(await loadManifest())
    broker = new InvocationBroker({ packages, state, host, organization })
    await state.setActivation(OS_TOOLKIT_EXTENSION_ID, personalContext(), true)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const invoke = (
    overrides: Partial<Parameters<InvocationBroker['invoke']>[0]>,
    options?: { credentialBacked?: boolean },
  ) => broker.invoke({
    extensionId: OS_TOOLKIT_EXTENSION_ID,
    contributionId: 'studio:status',
    contributionKind: 'view',
    context: personalContext(),
    caller: 'user',
    input: {},
    ...overrides,
  }, options)

  it('loads the web view with its entry and without running any host method', async () => {
    const view = await broker.loadView(OS_TOOLKIT_EXTENSION_ID, 'studio', personalContext())
    expect(view).toMatchObject({ kind: 'web', extensionId: OS_TOOLKIT_EXTENSION_ID, viewId: 'studio' })
    expect(view.webView?.entry).toBe('ui/index.html')
    expect(view.rows).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses to load the web view before activation', async () => {
    await state.setActivation(OS_TOOLKIT_EXTENSION_ID, personalContext(), false)
    await expect(broker.loadView(OS_TOOLKIT_EXTENSION_ID, 'studio', personalContext())).rejects.toThrow(/Activate/)
    expect(calls).toEqual([])
  })

  it('routes every studio action to its declared host method', async () => {
    for (const action of ['status', 'probe', 'schedule-get', 'schedule-save', 'apply']) {
      const result = await invoke({ contributionId: `studio:${action}`, input: { action } })
      expect(result, action).toMatchObject({ ok: true })
    }
    expect(calls).toEqual([...HOST_METHODS])
  })

  it('never executes a web view without a named action', async () => {
    const result = await invoke({ contributionId: 'studio', input: {} })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(calls).toEqual([])
  })

  it('runs the launcher commands through the broker', async () => {
    for (const command of ['open', 'light-now', 'dark-now', 'toggle']) {
      const result = await invoke({ contributionId: command, contributionKind: 'command', input: {} })
      expect(result, command).toMatchObject({ ok: true })
    }
    // `open` reads status; the three manual commands all map to theme.apply.
    expect(calls).toEqual([
      'ostoolkit.theme.status',
      'ostoolkit.theme.apply',
      'ostoolkit.theme.apply',
      'ostoolkit.theme.apply',
    ])
  })

  it('lets a supervised agent read without a prompt but always asks before changing the theme', async () => {
    // credentialBacked means the run's capabilities were already authorized when
    // it started. Non-sensitive methods ride them; sensitive ones never do.
    const read = await invoke(
      { contributionId: 'studio:status', caller: 'agent', input: { action: 'status' } },
      { credentialBacked: true },
    )
    expect(read).toMatchObject({ ok: true })
    expect(calls).toEqual(['ostoolkit.theme.status'])

    const apply = await invoke(
      { contributionId: 'studio:apply', caller: 'agent', input: { action: 'apply', mode: 'dark' } },
      { credentialBacked: true },
    )
    expect(apply).toMatchObject({ ok: false, error: { code: 'approval-required' } })
    // Nothing may touch the desktop before the user says yes.
    expect(calls).toEqual(['ostoolkit.theme.status'])

    const approvalId = (apply.value as { approvalId: string }).approvalId
    // Approving is what causes execution: nothing has run yet.
    expect(calls).toEqual(['ostoolkit.theme.status'])
    await broker.approve(approvalId, true)
    // approve() re-invokes the pending action, so the grant itself is what makes
    // the theme change happen rather than a later call slipping through.
    expect(calls).toEqual(['ostoolkit.theme.status', 'ostoolkit.theme.apply'])

    // A remembered grant covers the next identical call with no second prompt.
    const repeated = await invoke(
      { contributionId: 'studio:apply', caller: 'agent', input: { action: 'apply', mode: 'dark' } },
      { credentialBacked: true },
    )
    expect(repeated).toMatchObject({ ok: true })
    expect(calls).toEqual(['ostoolkit.theme.status', 'ostoolkit.theme.apply', 'ostoolkit.theme.apply'])
  })

  it('asks for every agent call when the run is not credential backed', async () => {
    const result = await invoke({ contributionId: 'studio:status', caller: 'agent', input: { action: 'status' } })
    expect(result).toMatchObject({ ok: false, error: { code: 'approval-required' } })
    expect(calls).toEqual([])
  })

  it('denies a call from a context the package never declared', async () => {
    const companyContext = { kind: 'company' as const, companyId: 'c1' }
    const result = await invoke({ contributionId: 'studio:status', context: companyContext, input: { action: 'status' } })
    expect(result.ok).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('OS Toolkit apply target resolution', () => {
  it('takes the intent from the launcher command id because a command has no payload', () => {
    expect(osToolkitApplyTarget(OS_TOOLKIT_EXTENSION_ID, 'light-now', undefined)).toBe('light')
    expect(osToolkitApplyTarget(OS_TOOLKIT_EXTENSION_ID, 'dark-now', undefined)).toBe('dark')
    expect(osToolkitApplyTarget(OS_TOOLKIT_EXTENSION_ID, 'toggle', undefined)).toBe('toggle')
  })

  it('takes the mode from the input for the studio view action', () => {
    expect(osToolkitApplyTarget(OS_TOOLKIT_EXTENSION_ID, 'studio:apply', 'light')).toBe('light')
    expect(osToolkitApplyTarget(OS_TOOLKIT_EXTENSION_ID, 'studio:apply', 'dark')).toBe('dark')
    expect(osToolkitApplyTarget(OS_TOOLKIT_EXTENSION_ID, 'studio:apply', 'toggle')).toBe('toggle')
  })

  it('refuses rather than guessing, because a wrong guess changes the desktop', () => {
    expect(() => osToolkitApplyTarget(OS_TOOLKIT_EXTENSION_ID, 'studio:apply', undefined)).toThrow(/light, dark, or toggle/)
    expect(() => osToolkitApplyTarget(OS_TOOLKIT_EXTENSION_ID, 'studio:apply', 'sepia')).toThrow(/light, dark, or toggle/)
    expect(() => osToolkitApplyTarget(OS_TOOLKIT_EXTENSION_ID, 'studio:apply', 'LIGHT')).toThrow(/light, dark, or toggle/)
    expect(() => osToolkitApplyTarget('nd.some-other-package', 'dark-now', undefined)).toThrow(/Only OS Toolkit/)
  })
})
