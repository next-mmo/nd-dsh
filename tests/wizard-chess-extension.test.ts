import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { NativeHostRegistry } from '../src/main/extensions/native-host.js'
import { InvocationBroker, type NdOrganizationPort } from '../src/main/extensions/invocation-broker.js'
import { WizardChessStatsStore, asWizardChessOutcome } from '../src/main/extensions/wizard-chess-store.js'
import { manifestPermissionIssues, validateNdExtensionManifest, type NdExtensionManifest } from '../src/shared/extension-package.js'
import { personalContext } from '../src/shared/nd-context.js'

import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const externalDir = fileURLToPath(new URL('../../next-mmo/wizard-chess-3d/', import.meta.url))
const internalDir = fileURLToPath(new URL('../extensions/wizard-chess-3d/', import.meta.url))
const packagePath = existsSync(internalDir) ? internalDir : externalDir
const manifestPath = pathToFileURL(join(packagePath, 'nd-extension.json'))

async function loadManifest(): Promise<NdExtensionManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const result = validateNdExtensionManifest(parsed)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  return result.manifest
}

describe('ND Wizard Chess 3D extension package', () => {
  it('validates as a Personal-only web-view package with no missing permissions', async () => {
    const manifest = await loadManifest()
    expect(manifest.id).toBe('nd.wizard-chess-3d')
    expect(manifest.contexts).toEqual(['personal'])
    expect(manifest.permissions).toEqual(['wizardchess.read', 'wizardchess.write'])
    expect(manifest.executable).toBeUndefined()
    expect(manifestPermissionIssues(manifest)).toEqual([])

    const [view] = manifest.contributions.views
    expect(view?.kind).toBe('web')
    expect(view?.entry).toBe('ui/index.html')
    expect(view?.host).toBeUndefined()
    expect(view?.actions.map((action) => [action.id, action.host])).toEqual([
      ['get', 'wizardchess.stats.get'],
      ['record', 'wizardchess.stats.record'],
      ['reset', 'wizardchess.stats.reset'],
    ])
    expect(manifest.contributions.commands[0]?.openViewId).toBe('board')
  })

  it('installs from its folder including shipped UI assets, activates, and uninstalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-wizard-chess-'))
    try {
      const packages = new ExtensionPackageStore(root)
      const installed = await packages.installFromDirectory(packagePath, { expectId: 'nd.wizard-chess-3d' })
      expect(installed.id).toBe('nd.wizard-chess-3d')

      // Snapshot carries the ui/ tree, vendor, and assets.
      const jsFiles = [
        'ui/game.js',
        'ui/engine.js',
        'ui/game-core.js',
        'ui/vendor/three.module.js',
        'ui/vendor/OrbitControls.js',
        'ui/vendor/GLTFLoader.js',
        'ui/vendor/SkeletonUtils.js',
        'ui/assets/index.js',
        'ui/assets/cathedral.js',
        'ui/assets/cathedral-part1.js',
        'ui/assets/cathedral-part2.js',
        'ui/assets/king.js',
        'ui/assets/queen.js',
        'ui/assets/rook.js',
        'ui/assets/bishop.js',
        'ui/assets/knight.js',
        'ui/assets/pawn.js',
      ]
      for (const asset of ['ui/index.html', 'ui/styles.css', ...jsFiles]) {
        expect(await packages.snapshotFileFor('nd.wizard-chess-3d', installed.version, asset)).not.toBeNull()
      }

      // Every static ES module import in ui/**/*.js must resolve to a real snapshot file
      // so the webview module graph never 404s and hangs on "Loading extension view…".
      for (const relJs of jsFiles) {
        const absJs = await packages.snapshotFileFor('nd.wizard-chess-3d', installed.version, relJs)
        expect(absJs).not.toBeNull()
        const src = await readFile(absJs!, 'utf8')
        const dir = relJs.split('/').slice(0, -1)
        for (const match of src.matchAll(/(?:^|\n)\s*import\s+[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/g)) {
          const spec = match[1]!
          const parts = [...dir]
          for (const seg of spec.split('/')) {
            if (!seg || seg === '.') continue
            if (seg === '..') parts.pop()
            else parts.push(seg)
          }
          const targetRel = parts.join('/')
          const resolved = await packages.snapshotFileFor('nd.wizard-chess-3d', installed.version, targetRel)
          expect(resolved, `${relJs} imports ${spec} -> ${targetRel}`).not.toBeNull()
        }
      }

      // GLTFLoader must use TextureLoader (<img> under img-src blob:) rather than ImageBitmapLoader (fetch under connect-src 'none')
      const gltfLoaderPath = await packages.snapshotFileFor('nd.wizard-chess-3d', installed.version, 'ui/vendor/GLTFLoader.js')
      const gltfLoaderSrc = await readFile(gltfLoaderPath!, 'utf8')
      expect(gltfLoaderSrc).not.toContain('new ImageBitmapLoader(')

      // game.js must announce bridge readiness immediately so the host unhides the iframe while 3D models decompress
      const gameJsPath = await packages.snapshotFileFor('nd.wizard-chess-3d', installed.version, 'ui/game.js')
      const gameJsSrc = await readFile(gameJsPath!, 'utf8')
      expect(gameJsSrc.indexOf('bridge.start()')).toBeLessThan(gameJsSrc.indexOf('initWizardChess('))

      const state = new InvocationStateStore(root)
      expect(await state.activation('nd.wizard-chess-3d', personalContext())).toBeUndefined()
      await state.setActivation('nd.wizard-chess-3d', personalContext(), true)
      expect((await state.activation('nd.wizard-chess-3d', personalContext()))?.enabled).toBe(true)

      await packages.uninstall('nd.wizard-chess-3d')
      expect(await packages.activeManifest('nd.wizard-chess-3d')).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Wizard Chess 3D broker gating', () => {
  let root: string
  let packages: ExtensionPackageStore
  let state: InvocationStateStore
  let host: NativeHostRegistry
  let broker: InvocationBroker
  let calls: string[]

  const organization: NdOrganizationPort = {
    state: async () => ({
      companies: [{ id: 'c1' } as never],
      projects: [{ id: 'p1', companyId: 'c1' } as never],
      memory: [],
    }),
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nd-wizard-chess-broker-'))
    packages = new ExtensionPackageStore(join(root, 'packages'))
    state = new InvocationStateStore(join(root, 'state'))
    host = new NativeHostRegistry()
    calls = []

    for (const method of ['wizardchess.stats.get', 'wizardchess.stats.record', 'wizardchess.stats.reset'] as const) {
      host.register(method, async (input) => {
        calls.push(method)
        return { ok: true, method, outcome: (input as { outcome?: unknown })?.outcome ?? null }
      })
    }

    await packages.installFromDirectory(packagePath, { expectId: 'nd.wizard-chess-3d' })
    await state.setActivation('nd.wizard-chess-3d', personalContext(), true)

    broker = new InvocationBroker({
      packages,
      state,
      host,
      organization,
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const invoke = (overrides: Partial<Parameters<InvocationBroker['invoke']>[0]>) =>
    broker.invoke({
      extensionId: 'nd.wizard-chess-3d',
      contributionId: 'board',
      contributionKind: 'view',
      context: personalContext(),
      caller: 'user',
      input: {},
      ...overrides,
    })

  it('delivers kind: "web" view descriptors without executing a host method', async () => {
    const view = await broker.loadView('nd.wizard-chess-3d', 'board', personalContext())
    expect(view).toMatchObject({ kind: 'web', extensionId: 'nd.wizard-chess-3d', viewId: 'board' })
    expect(view.webView?.entry).toBe('ui/index.html')
    expect(view.rows).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses view loads when the package is not activated for that context', async () => {
    await state.setActivation('nd.wizard-chess-3d', personalContext(), false)
    await expect(broker.loadView('nd.wizard-chess-3d', 'board', personalContext())).rejects.toThrow(/Activate/)
    expect(calls).toEqual([])
  })

  it('routes record and reset actions to their declared hosts', async () => {
    const record = await invoke({ input: { action: 'record', outcome: 'win' } })
    expect(record).toMatchObject({ ok: true })
    const reset = await invoke({ input: { action: 'reset' } })
    expect(reset).toMatchObject({ ok: true })
    expect(calls).toEqual(['wizardchess.stats.record', 'wizardchess.stats.reset'])
  })
})

describe('WizardChessStatsStore', () => {
  it('records wins, losses, draws, streak, and best streak', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-wizard-chess-store-'))
    try {
      const store = new WizardChessStatsStore(join(root, 'stats.json'))
      expect(await store.get()).toMatchObject({ wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0 })

      await store.record('win')
      await store.record('win')
      expect(await store.get()).toMatchObject({ wins: 2, losses: 0, streak: 2, bestStreak: 2 })

      await store.record('loss')
      expect(await store.get()).toMatchObject({ wins: 2, losses: 1, streak: 0, bestStreak: 2 })

      await store.record('win')
      expect(await store.get()).toMatchObject({ wins: 3, losses: 1, streak: 1, bestStreak: 2 })

      await store.reset()
      expect(await store.get()).toMatchObject({ wins: 0, losses: 0, streak: 0, bestStreak: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('validates outcome shape', () => {
    expect(asWizardChessOutcome('win')).toBe('win')
    expect(asWizardChessOutcome('loss')).toBe('loss')
    expect(asWizardChessOutcome('draw')).toBe('draw')
    expect(() => asWizardChessOutcome('invalid')).toThrow(/win, loss, or draw/)
  })
})
