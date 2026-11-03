import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { NativeHostRegistry } from '../src/main/extensions/native-host.js'
import { InvocationBroker, type NdOrganizationPort } from '../src/main/extensions/invocation-broker.js'
import { manifestPermissionIssues, validateNdExtensionManifest, type NdExtensionManifest } from '../src/shared/extension-package.js'
import { personalContext } from '../src/shared/nd-context.js'
import { formatDeviceInfo, formatTimestamp, parseDeviceList } from '../extensions/nd-emulator/ui/emulator-core.js'
import { EmulatorService, parseDisplaySize } from '../src/main/extensions/emulator-service.js'

const packagePath = fileURLToPath(new URL('../extensions/nd-emulator/', import.meta.url))
const manifestPath = new URL('../extensions/nd-emulator/nd-extension.json', import.meta.url)

async function loadManifest(): Promise<NdExtensionManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const result = validateNdExtensionManifest(parsed)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  return result.manifest
}

const organization: NdOrganizationPort = {
  state: async () => ({
    companies: [{ id: 'c1' } as never],
    projects: [{ id: 'p1', companyId: 'c1' } as never],
    memory: [],
  }),
}

describe('ND Emulator extension package', () => {
  it('validates as a Personal-only web-view package with emulator permissions', async () => {
    const manifest = await loadManifest()
    expect(manifest.id).toBe('nd.emulator')
    expect(manifest.contexts).toEqual(['personal'])
    expect(manifest.permissions).toContain('emulator.read')
    expect(manifest.permissions).toContain('emulator.write')
    expect(manifest.executable).toBeUndefined()
    expect(manifestPermissionIssues(manifest)).toEqual([])

    const [view] = manifest.contributions.views
    expect(view?.kind).toBe('web')
    expect(view?.entry).toBe('ui/index.html')
    expect(view?.host).toBeUndefined()
    expect(view?.actions.map((action) => [action.id, action.host])).toEqual([
      ['devices-list', 'emulator.devices.list'],
      ['devices-connect', 'emulator.devices.connect'],
      ['adb-exec', 'emulator.adb.exec'],
      ['screenshot', 'emulator.screenshot.capture'],
      ['apk-install', 'emulator.apk.install'],
      ['scrcpy-start', 'emulator.scrcpy.start'],
      ['scrcpy-stop', 'emulator.scrcpy.stop'],
      ['logcat-read', 'emulator.logcat.read'],
      ['input-tap', 'emulator.input.tap'],
      ['input-swipe', 'emulator.input.swipe'],
      ['mirror-resume', 'emulator.mirror.resume'],
    ])
    expect(manifest.contributions.commands[0]?.openViewId).toBe('main')
    expect(manifest.contributions.commands[0]?.host).toBe('emulator.devices.list')
  })

  it('installs the shipped UI assets, activates, and uninstalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-emulator-'))
    try {
      const packages = new ExtensionPackageStore(root)
      const installed = await packages.installFromDirectory(packagePath, { expectId: 'nd.emulator' })
      expect(installed.id).toBe('nd.emulator')
      for (const asset of ['ui/index.html', 'ui/app.js', 'ui/emulator-core.js', 'ui/emulator-core.d.ts']) {
        expect(await packages.snapshotFileFor('nd.emulator', installed.version, asset)).not.toBeNull()
      }

      const state = new InvocationStateStore(root)
      expect(await state.activation('nd.emulator', personalContext())).toBeUndefined()
      await state.setActivation('nd.emulator', personalContext(), true)
      expect((await state.activation('nd.emulator', personalContext()))?.enabled).toBe(true)

      await packages.uninstall('nd.emulator')
      expect(await packages.activeManifest('nd.emulator')).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('ND Emulator pure logic helpers', () => {
  it('parses device list correctly', () => {
    const raw = {
      devices: [
        { serial: 'emulator-5554', type: 'device', model: 'sdk_gphone64_arm64', product: 'sdk_gphone64', transportId: '1' },
        { serial: '192.168.1.100:5555', type: 'device', model: 'Pixel 7 Pro', product: 'husky', transportId: '2' },
      ],
    }
    const parsed = parseDeviceList(raw)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]?.serial).toBe('emulator-5554')
    expect(parsed[1]?.model).toBe('Pixel 7 Pro')
  })

  it('formats device info correctly', () => {
    const infoUsb = formatDeviceInfo({ serial: '12345', type: 'device', model: 'Galaxy S24', product: 'e1q' })
    expect(infoUsb).toContain('12345')
    expect(infoUsb).toContain('USB')

    const infoWifi = formatDeviceInfo({ serial: '192.168.1.10:5555', type: 'device', model: 'Pixel 7', product: 'panther' })
    expect(infoWifi).toContain('Wireless')
  })

  it('formats timestamp as HH:MM:SS', () => {
    const ts = formatTimestamp()
    expect(ts).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })
})

describe('ND Emulator broker gating', () => {
  let root: string
  let packages: ExtensionPackageStore
  let state: InvocationStateStore
  let host: NativeHostRegistry
  let broker: InvocationBroker
  let calls: { method: string; input: Record<string, unknown> }[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nd-emulator-broker-'))
    packages = new ExtensionPackageStore(join(root, 'packages'))
    state = new InvocationStateStore(join(root, 'state'))
    host = new NativeHostRegistry()
    calls = []

    const methods = [
      'emulator.devices.list',
      'emulator.devices.connect',
      'emulator.adb.exec',
      'emulator.screenshot.capture',
      'emulator.apk.install',
      'emulator.scrcpy.start',
      'emulator.scrcpy.stop',
      'emulator.logcat.read',
      'emulator.input.tap',
      'emulator.input.swipe',
      'emulator.mirror.resume',
    ] as const

    for (const method of methods) {
      host.register(method, async (input) => {
        calls.push({ method, input: { ...input } })
        if (method === 'emulator.devices.list') return { devices: [] }
        if (method === 'emulator.screenshot.capture') return { dataUrl: 'data:image/png;base64,abc' }
        if (method === 'emulator.adb.exec') return { output: 'success', exitCode: 0 }
        return { ok: true }
      })
    }

    await packages.registerBuiltin(await loadManifest())
    broker = new InvocationBroker({ packages, state, host, organization })
    await state.setActivation('nd.emulator', personalContext(), true)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const invoke = (overrides: Partial<Parameters<InvocationBroker['invoke']>[0]>) =>
    broker.invoke({
      extensionId: 'nd.emulator',
      contributionId: 'main',
      contributionKind: 'view',
      context: personalContext(),
      caller: 'user',
      input: {},
      ...overrides,
    })

  it('loads the web view without executing a host method', async () => {
    const view = await broker.loadView('nd.emulator', 'main', personalContext())
    expect(view).toMatchObject({ kind: 'web', extensionId: 'nd.emulator', viewId: 'main' })
    expect(view.webView?.entry).toBe('ui/index.html')
    expect(view.rows).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses to load before activation', async () => {
    await state.setActivation('nd.emulator', personalContext(), false)
    await expect(broker.loadView('nd.emulator', 'main', personalContext())).rejects.toThrow(/Activate/)
    expect(calls).toEqual([])
  })

  it('routes read and write actions to their hosts', async () => {
    const listRes = await invoke({ input: { action: 'devices-list' } })
    expect(listRes).toMatchObject({ ok: true })

    const execRes = await invoke({ input: { action: 'adb-exec', command: 'devices' } })
    expect(execRes).toMatchObject({ ok: true })

    expect(calls).toEqual([
      { method: 'emulator.devices.list', input: { action: 'devices-list' } },
      { method: 'emulator.adb.exec', input: { action: 'adb-exec', command: 'devices' } },
    ])
  })

  it('routes embedded input actions', async () => {
    const tapRes = await invoke({ input: { action: 'input-tap', serial: 'test-serial', x: 0.5, y: 0.5 } })
    expect(tapRes).toMatchObject({ ok: true })
    const swipeRes = await invoke({
      input: { action: 'input-swipe', serial: 'test-serial', x1: 0.2, y1: 0.2, x2: 0.8, y2: 0.8, duration: 250 },
    })
    expect(swipeRes).toMatchObject({ ok: true })
    expect(calls.map((call) => call.method)).toEqual([
      'emulator.input.tap',
      'emulator.input.swipe',
    ])
  })

  it('requires an explicit approval grant when an agent runs sensitive host actions', async () => {
    const listRes = await invoke({ input: { action: 'devices-list' } })
    expect(listRes).toMatchObject({ ok: true })

    const denied = await invoke({ caller: 'agent', input: { action: 'screenshot' } })
    expect(denied).toMatchObject({ ok: false, error: { code: 'approval-required' } })
    expect(calls.map((call) => call.method)).toEqual(['emulator.devices.list'])

    const approvalId = (denied.value as { approvalId: string }).approvalId
    await broker.approve(approvalId, true)
    const granted = await invoke({ caller: 'agent', input: { action: 'screenshot' } })
    expect(granted).toMatchObject({ ok: true })
    expect(calls.map((call) => call.method)).toEqual([
      'emulator.devices.list',
      'emulator.screenshot.capture',
      'emulator.screenshot.capture',
    ])
  })
})

describe('EmulatorService', () => {
  it('parses the rotation-aware display size', () => {
    expect(parseDisplaySize('init=1080x2340 cur=1080x2340 app=1080x2340')).toEqual({ width: 1080, height: 2340 })
    expect(parseDisplaySize('Physical size: 1080x2340')).toEqual({ width: 1080, height: 2340 })
    expect(parseDisplaySize('no size here')).toBeUndefined()
  })

  it('instantiates and handles missing binaries safely', async () => {
    const service = new EmulatorService({ adbPath: 'nonexistent-adb-bin', scrcpyPath: 'nonexistent-scrcpy-bin' })
    const listResult = await service.listDevices()
    expect(listResult.adbAvailable).toBe(false)
    expect(listResult.devices).toEqual([])
    expect(listResult.error).toContain('ADB not found')

    const scrcpyResult = await service.startScrcpy({ serial: 'test-serial' })
    expect(scrcpyResult.started).toBe(false)
    expect(scrcpyResult.error).toContain('scrcpy')

    service.dispose()
  })
})
