import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'kwallet',
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (value: Buffer) => Buffer.from(value).toString().replace(/^enc:/, ''),
  },
}))

import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { NativeHostRegistry } from '../src/main/extensions/native-host.js'
import { manifestPermissionIssues, validateNdExtensionManifest, type NdExtensionManifest } from '../src/shared/extension-package.js'
import { NineRouterManagedRuntime } from '../src/main/router/nine-router-managed.js'

const packagePath = fileURLToPath(new URL('../extensions/9router/', import.meta.url))
const manifestPath = new URL('../extensions/9router/nd-extension.json', import.meta.url)

async function loadManifest(): Promise<NdExtensionManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const result = validateNdExtensionManifest(parsed)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  return result.manifest
}

describe('9Router ND extension package', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    vi.unstubAllGlobals()
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  })

  it('validates with no missing permissions and exposes router permissions', async () => {
    const manifest = await loadManifest()
    expect(manifest.id).toBe('nd.9router')
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.contexts).toEqual(['personal', 'company', 'project'])
    expect(manifest.permissions).toEqual(['ninerouter.read', 'ninerouter.write'])
    expect(manifestPermissionIssues(manifest)).toEqual([])
    expect(manifest.executable).toBeUndefined()
  })

  it('contributes start, stop, and status commands and an overview detail view', async () => {
    const manifest = await loadManifest()
    const commandIds = manifest.contributions.commands.map((cmd) => cmd.id)
    expect(commandIds).toEqual(['open-9router', 'start-9router', 'stop-9router'])
    expect(manifest.contributions.commands[0]?.openViewId).toBe('overview')
    expect(manifest.contributions.commands[1]?.host).toBe('ninerouter.start')
    expect(manifest.contributions.commands[2]?.host).toBe('ninerouter.stop')

    const [view] = manifest.contributions.views
    expect(view?.id).toBe('overview')
    expect(view?.kind).toBe('detail')
    expect(view?.host).toBe('ninerouter.status')
    expect(view?.actions.map((action) => [action.id, action.host])).toEqual([
      ['start', 'ninerouter.start'],
      ['stop', 'ninerouter.stop'],
      ['refresh', 'ninerouter.status'],
    ])
  })

  it('installs on demand via ExtensionPackageStore and integrates with NineRouterManagedRuntime', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'nd-ext-store-'))
    const dataDir = await mkdtemp(join(tmpdir(), 'nd-router-data-'))
    cleanups.push(async () => {
      await rm(rootDir, { recursive: true, force: true })
      await rm(dataDir, { recursive: true, force: true })
    })

    const packageStore = new ExtensionPackageStore(rootDir)
    await packageStore.initialize()

    const core = {
      onEvent: vi.fn(() => () => undefined),
      request: vi.fn(async () => ({})),
    }
    const runtime = new NineRouterManagedRuntime(core as never, dataDir, rootDir)
    runtime.setPackageStore(packageStore)
    await runtime.initialize()

    // Before installation: runtime reports not installed
    const initialState = await runtime.state()
    expect(initialState.installed).toBe(false)
    expect(initialState.running).toBe(false)

    // Install the 9router extension
    const installed = await packageStore.installFromDirectory(packagePath, { expectId: 'nd.9router' })
    expect(installed.id).toBe('nd.9router')
    expect(installed.version).toBe('1.0.0')

    // After installation: runtime detects installed package
    const postInstallState = await runtime.state()
    expect(postInstallState.installed).toBe(true)
    expect(postInstallState.version).toBe('1.0.0')
    expect(postInstallState.trusted).toBe(true)

    // Mock fetch for the startup health check
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    // Start runtime
    const started = await runtime.start()
    expect(started.running).toBe(true)
    expect(started.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)

    // Stop runtime
    const stopped = await runtime.stop()
    expect(stopped.running).toBe(false)

    // Uninstall package
    await packageStore.uninstall('nd.9router')
    const postUninstallState = await runtime.state()
    expect(postUninstallState.installed).toBe(false)
  })

  it('registers native host handlers for ninerouter status, start, and stop', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'nd-router-data-'))
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }))

    const core = {
      onEvent: vi.fn(() => () => undefined),
      request: vi.fn(async () => ({})),
    }
    const runtime = new NineRouterManagedRuntime(core as never, dataDir)
    await runtime.initialize()

    const host = new NativeHostRegistry()
    host.register('ninerouter.status', async () => {
      const state = await runtime.state()
      return {
        title: state.running ? `9Router running (${state.endpoint})` : state.installed ? '9Router installed' : '9Router not installed',
        detail: 'status detail',
        state,
      }
    })
    host.register('ninerouter.start', async () => runtime.start())
    host.register('ninerouter.stop', async () => runtime.stop())

    const statusResult = await host.call('ninerouter.status', {}, {
      extensionId: 'nd.9router',
      contributionId: 'status',
      host: 'ninerouter.status',
      context: { kind: 'personal' },
      caller: 'user',
      settings: {},
    }) as { title: string; state: { installed: boolean } }

    expect(statusResult.title).toBe('9Router not installed')
    expect(statusResult.state.installed).toBe(false)
  })
})
