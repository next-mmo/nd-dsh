import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { NativeHostRegistry } from '../src/main/extensions/native-host.js'
import { InvocationBroker, type NdOrganizationPort } from '../src/main/extensions/invocation-broker.js'
import { TicTacToeStatsStore, asTicTacToeOutcome } from '../src/main/extensions/tic-tac-toe-store.js'
import { manifestPermissionIssues, validateNdExtensionManifest, type NdExtensionManifest } from '../src/shared/extension-package.js'
import { personalContext } from '../src/shared/nd-context.js'

const packagePath = fileURLToPath(new URL('../extensions/tic-tac-toe/', import.meta.url))
const manifestPath = new URL('../extensions/tic-tac-toe/nd-extension.json', import.meta.url)

async function loadManifest(): Promise<NdExtensionManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const result = validateNdExtensionManifest(parsed)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  return result.manifest
}

describe('3D Tic-Tac-Toe ND extension package', () => {
  it('validates as a Personal-only web-view package with no missing permissions', async () => {
    const manifest = await loadManifest()
    expect(manifest.id).toBe('nd.tic-tac-toe')
    expect(manifest.contexts).toEqual(['personal'])
    expect(manifest.permissions).toEqual(['tictactoe.read', 'tictactoe.write'])
    expect(manifest.executable).toBeUndefined()
    expect(manifestPermissionIssues(manifest)).toEqual([])

    const [view] = manifest.contributions.views
    expect(view?.kind).toBe('web')
    expect(view?.entry).toBe('ui/index.html')
    expect(view?.host).toBeUndefined()
    expect(view?.actions.map((action) => [action.id, action.host])).toEqual([
      ['get', 'tictactoe.stats.get'],
      ['record', 'tictactoe.stats.record'],
      ['reset', 'tictactoe.stats.reset'],
    ])
    expect(manifest.contributions.commands[0]?.openViewId).toBe('board')
  })

  it('rejects web views with traversal entries or missing entry paths', () => {
    const base = {
      protocol: 'nd.extension/1' as const,
      id: 'nd.test.webview',
      name: 'Test',
      description: 'Test package',
      version: '1.0.0',
      apiVersion: 1,
      contexts: ['personal' as const],
      permissions: [],
      settings: [],
      contributions: {
        tools: [],
        skills: [],
        commands: [],
        workflows: [],
        views: [{
          id: 'web',
          title: 'Web',
          kind: 'web' as const,
          contexts: ['personal' as const],
          actions: [],
        }],
      },
    }
    const missing = validateNdExtensionManifest(structuredClone(base))
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.issues.some((issue) => issue.path === 'contributions.views[0].entry')).toBe(true)

    const traversal = validateNdExtensionManifest({
      ...structuredClone(base),
      contributions: { ...base.contributions, views: [{ ...base.contributions.views[0], entry: 'ui/../../app.asar' }] },
    })
    expect(traversal.ok).toBe(false)

    const notHtml = validateNdExtensionManifest({
      ...structuredClone(base),
      contributions: { ...base.contributions, views: [{ ...base.contributions.views[0], entry: 'ui/index.htm' }] },
    })
    expect(notHtml.ok).toBe(false)
  })

  it('installs from its folder including the shipped UI assets, activates, and uninstalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-tic-tac-toe-'))
    try {
      const packages = new ExtensionPackageStore(root)
      const installed = await packages.installFromDirectory(packagePath, { expectId: 'nd.tic-tac-toe' })
      expect(installed.id).toBe('nd.tic-tac-toe')

      // The snapshot carries the whole ui/ tree, vendor files included.
      for (const asset of ['ui/index.html', 'ui/game.js', 'ui/game-core.js', 'ui/vendor/three.module.js', 'ui/vendor/three.core.js']) {
        expect(await packages.snapshotFileFor('nd.tic-tac-toe', installed.version, asset)).not.toBeNull()
      }

      const state = new InvocationStateStore(root)
      expect(await state.activation('nd.tic-tac-toe', personalContext())).toBeUndefined()
      await state.setActivation('nd.tic-tac-toe', personalContext(), true)
      expect((await state.activation('nd.tic-tac-toe', personalContext()))?.enabled).toBe(true)

      await packages.uninstall('nd.tic-tac-toe')
      expect(await packages.activeManifest('nd.tic-tac-toe')).toBeUndefined()
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

describe('3D Tic-Tac-Toe broker gating', () => {
  let root: string
  let packages: ExtensionPackageStore
  let state: InvocationStateStore
  let host: NativeHostRegistry
  let broker: InvocationBroker
  let calls: string[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nd-tic-tac-toe-broker-'))
    packages = new ExtensionPackageStore(join(root, 'packages'))
    state = new InvocationStateStore(join(root, 'state'))
    host = new NativeHostRegistry()
    calls = []
    for (const method of ['tictactoe.stats.get', 'tictactoe.stats.record', 'tictactoe.stats.reset'] as const) {
      host.register(method, async (input) => {
        calls.push(method)
        return { ok: true, method, outcome: input.outcome ?? null }
      })
    }
    await packages.registerBuiltin(await loadManifest())
    broker = new InvocationBroker({ packages, state, host, organization })
    await state.setActivation('nd.tic-tac-toe', personalContext(), true)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const invoke = (overrides: Partial<Parameters<InvocationBroker['invoke']>[0]>) =>
    broker.invoke({
      extensionId: 'nd.tic-tac-toe',
      contributionId: 'board',
      contributionKind: 'view',
      context: personalContext(),
      caller: 'user',
      input: {},
      ...overrides,
    })

  it('loads the web view with its entry and without running any host method', async () => {
    const view = await broker.loadView('nd.tic-tac-toe', 'board', personalContext())
    expect(view).toMatchObject({ kind: 'web', extensionId: 'nd.tic-tac-toe', viewId: 'board' })
    expect(view.webView?.entry).toBe('ui/index.html')
    expect(view.rows).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses to load the web view before activation', async () => {
    await state.setActivation('nd.tic-tac-toe', personalContext(), false)
    await expect(broker.loadView('nd.tic-tac-toe', 'board', personalContext())).rejects.toThrow(/Activate/)
    expect(calls).toEqual([])
  })

  it('routes record and reset actions to their declared hosts', async () => {
    const record = await invoke({ input: { action: 'record', outcome: 'win' } })
    expect(record).toMatchObject({ ok: true })
    const reset = await invoke({ input: { action: 'reset' } })
    expect(reset).toMatchObject({ ok: true })
    expect(calls).toEqual(['tictactoe.stats.record', 'tictactoe.stats.reset'])
  })

  it('never executes a web view without a named action', async () => {
    const result = await invoke({})
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(calls).toEqual([])
  })

  it('relays bridge input through to the host untouched; the host validates outcomes', async () => {
    // The broker deliberately does not coerce contribution input: outcome
    // checking is the host handler's job (asTicTacToeOutcome, exercised in its
    // own test), so the broker test pins the relay behavior instead.
    const result = await invoke({ input: { action: 'record', outcome: 'sometimes' } })
    expect(result).toMatchObject({ ok: true, value: { method: 'tictactoe.stats.record', outcome: 'sometimes' } })
  })

  it('requires an explicit grant before an agent may record results', async () => {
    const result = await invoke({ caller: 'agent', input: { action: 'record', outcome: 'win' } })
    expect(result).toMatchObject({ ok: false, error: { code: 'approval-required' } })
    expect(calls).toEqual([])
    const approvalId = (result.value as { approvalId: string }).approvalId
    await broker.approve(approvalId, true)
    const granted = await invoke({ caller: 'agent', input: { action: 'record', outcome: 'win' } })
    expect(granted).toMatchObject({ ok: true })
  })
})

describe('TicTacToeStatsStore', () => {
  it('validates outcomes at the host boundary and accepts only the three results', () => {
    expect(asTicTacToeOutcome('win')).toBe('win')
    expect(asTicTacToeOutcome('loss')).toBe('loss')
    expect(asTicTacToeOutcome('draw')).toBe('draw')
    expect(() => asTicTacToeOutcome('sometimes')).toThrow(/Outcome/)
    expect(() => asTicTacToeOutcome(undefined)).toThrow(/Outcome/)
    expect(() => asTicTacToeOutcome(1)).toThrow(/Outcome/)
  })

  it('records wins, losses, and draws with a win streak', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-tic-tac-toe-store-'))
    try {
      const store = new TicTacToeStatsStore(join(root, 'stats.json'))
      await store.record('win')
      await store.record('win')
      const afterLoss = await store.record('loss')
      expect(afterLoss).toMatchObject({ wins: 2, losses: 1, draws: 0, streak: 0, bestStreak: 2 })
      const afterDraw = await store.record('draw')
      expect(afterDraw).toMatchObject({ draws: 1, streak: 0, bestStreak: 2 })

      // A fresh instance reads the same file back.
      const reloaded = await new TicTacToeStatsStore(join(root, 'stats.json')).get()
      expect(reloaded).toMatchObject({ wins: 2, losses: 1, draws: 1, bestStreak: 2 })

      await store.reset()
      expect(await store.get()).toMatchObject({ wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to defaults when the file is corrupt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-tic-tac-toe-store-'))
    try {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(root, 'stats.json'), '{not json at all', 'utf8')
      const store = new TicTacToeStatsStore(join(root, 'stats.json'))
      expect(await store.get()).toMatchObject({ wins: 0, losses: 0, draws: 0 })
      const recorded = await store.record('win')
      expect(recorded).toMatchObject({ wins: 1 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
