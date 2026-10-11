import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The manager resolves bundled packages through app.getAppPath(), so the test
// controls that root per case.
const host = vi.hoisted(() => ({ appPath: process.cwd() }))

vi.mock('electron', () => ({
  app: { getAppPath: () => host.appPath },
}))

import { BrowserExtensionManager } from '../src/main/browser/browser-extension-manager.js'

const dirs: string[] = []

afterEach(async () => {
  host.appPath = process.cwd()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function fakeSession(options: { loadable?: boolean } = {}) {
  const loaded = new Map<string, { id: string; name: string; version: string }>()
  const loadExtension = vi.fn(async (extensionPath: string) => {
    if (!options.loadable) throw new Error('not loaded in unit tests')
    const record = { id: `loaded-${loaded.size + 1}`, name: 'Bundled extension', version: '1.0.0', path: extensionPath }
    loaded.set(record.id, record)
    return record
  })
  const session = {
    extensions: {
      getExtension: (id: string) => loaded.get(id) ?? null,
      removeExtension: (id: string) => { loaded.delete(id) },
      loadExtension,
    },
  } as unknown as ConstructorParameters<typeof BrowserExtensionManager>[0]
  return { session, loadExtension }
}

async function writeExtension(path: string, name: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'manifest.json'), JSON.stringify({ manifest_version: 3, name, version: '1.0.0' }), 'utf8')
}

async function writeBundledAdBlock(appPath: string): Promise<string> {
  const path = join(appPath, 'resources', 'browser-extensions', 'nd-ad-block')
  await writeExtension(path, 'ND Ad Block')
  return path
}

/** Where the manager keeps the writable per-profile copy of a bundled package. */
const installedCopy = (root: string, catalogId: string) => join(root, 'browser-extensions', catalogId)

describe('BrowserExtensionManager', () => {
  it('keeps distinct ids for disabled extensions that share a long path prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-browser-extension-manager-'))
    dirs.push(root)
    // Point the bundled-package root at an empty tree so this case only sees
    // the two extensions it sets up.
    host.appPath = join(root, 'app')
    const parent = join(root, 'a-deliberately-long-shared-parent-directory-for-extensions')
    const first = join(parent, 'first')
    const second = join(parent, 'second')
    await writeExtension(first, 'First')
    await writeExtension(second, 'Second')
    const statePath = join(root, 'extensions.json')
    await writeFile(statePath, JSON.stringify({
      version: 1,
      extensions: [
        { path: first, enabled: false, installedAt: 1 },
        { path: second, enabled: false, installedAt: 2 },
      ],
    }), 'utf8')

    const manager = new BrowserExtensionManager(fakeSession().session, statePath, () => undefined)
    await manager.initialize()

    const records = manager.list()
    expect(records.map((record) => record.name)).toEqual(['First', 'Second'])
    expect(new Set(records.map((record) => record.id)).size).toBe(2)
  })
})

describe('bundled ad block default', () => {
  it('refreshes shipped bytes on reload and re-enable without overriding disabled state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-adblock-refresh-'))
    dirs.push(root)
    host.appPath = join(root, 'app')
    const source = await writeBundledAdBlock(host.appPath)
    await writeFile(join(source, 'background.js'), 'first')
    const { session } = fakeSession({ loadable: true })
    const manager = new BrowserExtensionManager(session, join(root, 'extensions.json'), () => undefined)
    await manager.initialize()
    await writeFile(join(source, 'background.js'), 'updated')
    await manager.reloadAll()
    expect(await readFile(join(installedCopy(root, 'nd-ad-block'), 'background.js'), 'utf8')).toBe('updated')
    const record = manager.list()[0]!
    await manager.setEnabled(record.id, false)
    await writeFile(join(source, 'background.js'), 'latest')
    await manager.reloadAll()
    const disabled = manager.list()[0]!
    expect(disabled.enabled).toBe(false)
    await manager.setEnabled(disabled.id, true)
    expect(await readFile(join(installedCopy(root, 'nd-ad-block'), 'background.js'), 'utf8')).toBe('latest')
    expect(manager.list()[0]?.enabled).toBe(true)
  })
  it('enables ND Ad Block on a profile that has never seen it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-adblock-default-'))
    dirs.push(root)
    host.appPath = join(root, 'app')
    const bundledPath = await writeBundledAdBlock(host.appPath)
    const { session, loadExtension } = fakeSession({ loadable: true })

    const manager = new BrowserExtensionManager(session, join(root, 'extensions.json'), () => undefined)
    await manager.initialize()

    const record = manager.list().find((item) => item.catalogId === 'nd-ad-block')
    expect(record).toBeDefined()
    expect(record?.enabled).toBe(true)
    expect(record?.source).toBe('bundled')
    expect(loadExtension).toHaveBeenCalledTimes(1)

    const state = JSON.parse(await readFile(join(root, 'extensions.json'), 'utf8')) as { defaultsApplied?: string[] }
    expect(state.defaultsApplied).toEqual(['nd-ad-block'])
  })

  it('loads the bundled package from a writable profile copy, not the packaged path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-adblock-copy-'))
    dirs.push(root)
    host.appPath = join(root, 'app')
    const bundledPath = await writeBundledAdBlock(host.appPath)
    // Chromium's generated index must never be copied into the profile.
    await mkdir(join(bundledPath, '_metadata'), { recursive: true })
    await writeFile(join(bundledPath, '_metadata', 'generated'), 'cache', 'utf8')
    const { session, loadExtension } = fakeSession({ loadable: true })

    const manager = new BrowserExtensionManager(session, join(root, 'extensions.json'), () => undefined)
    await manager.initialize()

    const copy = installedCopy(root, 'nd-ad-block')
    const record = manager.list().find((item) => item.catalogId === 'nd-ad-block')
    expect(record?.path).toBe(copy)
    expect(loadExtension).toHaveBeenCalledWith(copy, expect.anything())
    expect(existsSync(join(copy, 'manifest.json'))).toBe(true)
    expect(existsSync(join(copy, '_metadata'))).toBe(false)
    // The packaged source is still the build's copy, untouched by the loader.
    expect(existsSync(join(bundledPath, 'manifest.json'))).toBe(true)
  })

  it('leaves a user-disabled ad block disabled across restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-adblock-disabled-'))
    dirs.push(root)
    host.appPath = join(root, 'app')
    const bundledPath = await writeBundledAdBlock(host.appPath)
    const statePath = join(root, 'extensions.json')
    await writeFile(statePath, JSON.stringify({
      version: 1,
      extensions: [{ path: bundledPath, enabled: false, installedAt: 1, source: 'bundled', catalogId: 'nd-ad-block' }],
    }), 'utf8')
    const { session, loadExtension } = fakeSession({ loadable: true })

    const manager = new BrowserExtensionManager(session, statePath, () => undefined)
    await manager.initialize()

    expect(manager.list().find((item) => item.catalogId === 'nd-ad-block')?.enabled).toBe(false)
    expect(loadExtension).not.toHaveBeenCalled()
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { defaultsApplied?: string[] }
    expect(state.defaultsApplied).toEqual(['nd-ad-block'])
  })

  it('does not bring the ad block back after the user removes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-adblock-removed-'))
    dirs.push(root)
    host.appPath = join(root, 'app')
    await writeBundledAdBlock(host.appPath)
    const statePath = join(root, 'extensions.json')
    await writeFile(statePath, JSON.stringify({
      version: 1,
      defaultsApplied: ['nd-ad-block'],
      extensions: [],
    }), 'utf8')
    const { session, loadExtension } = fakeSession({ loadable: true })

    const manager = new BrowserExtensionManager(session, statePath, () => undefined)
    await manager.initialize()

    expect(manager.list()).toEqual([])
    expect(loadExtension).not.toHaveBeenCalled()
  })

  it('stays pending when the build has no bundled package to load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-adblock-missing-'))
    dirs.push(root)
    host.appPath = join(root, 'app')
    const { session, loadExtension } = fakeSession({ loadable: true })

    const manager = new BrowserExtensionManager(session, join(root, 'extensions.json'), () => undefined)
    await manager.initialize()

    expect(manager.list()).toEqual([])
    expect(loadExtension).not.toHaveBeenCalled()
  })
})
