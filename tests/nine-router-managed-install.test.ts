import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'kwallet',
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (value: Buffer) => Buffer.from(value).toString().replace(/^enc:/, ''),
  },
}))

import { NineRouterManagedRuntime } from '../src/main/router/nine-router-managed.js'

interface Fixture {
  root: string
  publicKeyPem: string
}

const cleanups: Array<() => Promise<void>> = []
const originalKey = process.env.ND_SECURITY_DEV_PUBLIC_KEY_PEM

async function signedReleaseFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'nd-9router-signed-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const files = [
    { path: 'runtime/node', value: 'test runtime placeholder; never executed' },
    { path: 'server.js', value: '/* test server placeholder */' },
    { path: 'security-attestation.json', value: JSON.stringify({ schemaVersion: 1, checks: { dependency: 'pass', malware: 'pass', static: 'pass', license: 'pass' } }) },
    { path: 'sbom.json', value: '{}' },
  ]
  for (const file of files) {
    await mkdir(dirname(join(root, file.path)), { recursive: true })
    await writeFile(join(root, file.path), file.value)
  }
  const manifest = {
    schemaVersion: 1,
    packageId: 'nd.9router-runtime',
    repository: 'https://github.com/next-mmo/9router-nd-dsh',
    revision: 'f'.repeat(40),
    version: '0.1.0-test',
    platform: process.platform,
    arch: process.arch,
    publisherKeyId: 'nd-dev-test-key',
    runtimeEntry: 'runtime/node',
    serverEntry: 'server.js',
    files: files.map(file => ({
      path: file.path,
      bytes: Buffer.byteLength(file.value),
      sha256: createHash('sha256').update(file.value).digest('hex'),
    })),
  }
  const bytes = Buffer.from(JSON.stringify(manifest))
  await writeFile(join(root, 'release-manifest.json'), bytes)
  await writeFile(join(root, 'release-manifest.sig'), sign(null, bytes, privateKey).toString('base64'))
  return { root, publicKeyPem }
}

async function packageFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nd-9router-package-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'app', 'node_modules', 'dep'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '9router', version: '0.5.75-test' }))
  await writeFile(join(root, 'app', 'server.js'), '/* standalone server placeholder */')
  await writeFile(join(root, 'app', 'custom-server.js'), '/* custom server placeholder */')
  await writeFile(join(root, 'app', 'node_modules', 'dep', 'index.js'), 'module.exports = 1')
  return root
}

async function unsignedManifestFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nd-9router-unsigned-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'runtime'), { recursive: true })
  await writeFile(join(root, 'runtime', 'node'), 'test runtime placeholder; never executed')
  await writeFile(join(root, 'server.js'), '/* test server placeholder */')
  await writeFile(join(root, 'release-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    version: '0.2.0-local',
    runtimeEntry: 'runtime/node',
    serverEntry: 'server.js',
  }))
  return root
}

async function managedRuntime(dataDir: string): Promise<NineRouterManagedRuntime> {
  const core = {
    onEvent: vi.fn(() => () => undefined),
    request: vi.fn(async () => ({})),
  }
  const runtime = new NineRouterManagedRuntime(core as never, dataDir)
  await runtime.initialize()
  return runtime
}

describe('NineRouterManagedRuntime unverified import', () => {
  afterEach(async () => {
    vi.unstubAllGlobals()
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  })

  it('imports a local 9Router package as unverified and blocks start after the files change', async () => {
    const source = await packageFixture()
    const dataDir = await mkdtemp(join(tmpdir(), 'nd-9router-data-'))
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
    const runtime = await managedRuntime(dataDir)

    const imported = await runtime.importUnverified(source)
    expect(imported).toMatchObject({
      installed: true,
      trusted: false,
      verification: 'unverified',
      integrity: 'ok',
      version: '0.5.75-test',
      signingKeyConfigured: false,
    })
    const record = JSON.parse(await readFile(join(dataDir, '9router-managed', 'installed.json'), 'utf8')) as {
      verification: string
      runtimeMode: string
      serverEntry: string
      workingDirectory: string
      inventoryDigest: string
      directory: string
    }
    expect(record.verification).toBe('unverified')
    expect(record.runtimeMode).toBe('system-node')
    expect(record.serverEntry).toBe('app/custom-server.js')
    expect(record.workingDirectory).toBe('app')
    expect(record.inventoryDigest).toMatch(/^[a-f0-9]{64}$/)

    await writeFile(join(record.directory, 'app', 'server.js'), 'tampered after import')
    await expect(runtime.start()).rejects.toThrow(/files changed/)
    expect((await runtime.state()).integrity).toBe('changed')
  })

  it('accepts an unsigned release manifest and mounts its bundled runtime', async () => {
    const source = await unsignedManifestFixture()
    const dataDir = await mkdtemp(join(tmpdir(), 'nd-9router-data-'))
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
    const runtime = await managedRuntime(dataDir)

    const imported = await runtime.importUnverified(source)
    expect(imported).toMatchObject({ verification: 'unverified', integrity: 'ok', version: '0.2.0-local' })
    const record = JSON.parse(await readFile(join(dataDir, '9router-managed', 'installed.json'), 'utf8')) as {
      runtimeMode: string
      runtimeEntry: string
      serverEntry: string
    }
    expect(record.runtimeMode).toBe('bundled')
    expect(record.runtimeEntry).toBe('runtime/node')
    expect(record.serverEntry).toBe('server.js')
  })

  it('starts an unverified import without receiving ND-managed secrets', async () => {
    const source = await packageFixture()
    const dataDir = await mkdtemp(join(tmpdir(), 'nd-9router-data-'))
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
    const core = {
      onEvent: vi.fn(() => () => undefined),
      request: vi.fn(async (_method: string, _params: Record<string, unknown>) => ({})),
    }
    const runtime = new NineRouterManagedRuntime(core as never, dataDir)
    await runtime.initialize()
    await runtime.importUnverified(source)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    const started = await runtime.start()
    expect(started.running).toBe(true)
    expect(started.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    const spawn = core.request.mock.calls.find((call) => call[0] === 'process.spawn')
    expect(spawn).toBeTruthy()
    const payload = spawn![1] as unknown as { command: string; args: string[]; cwd: string; env: Record<string, string> }
    expect(payload.command).toBe(process.execPath)
    expect(payload.args[0]).toContain(join('app', 'custom-server.js'))
    expect(payload.cwd).toContain(join('9router-managed', 'versions'))
    expect(payload.env.PORT).toMatch(/^\d+$/)
    expect(payload.env.DATA_DIR).toContain(join('9router-managed', 'data'))
    expect(payload.env.JWT_SECRET).toBeUndefined()
    expect(payload.env.INITIAL_PASSWORD).toBeUndefined()
    expect(payload.env.REQUIRE_API_KEY).toBeUndefined()

    await runtime.stop()
  })
})

describe('NineRouterManagedRuntime signed install', () => {
  beforeEach(() => {
    process.env.ND_SECURITY_DEV_PUBLIC_KEY_PEM = originalKey
  })

  afterEach(async () => {
    if (originalKey === undefined) delete process.env.ND_SECURITY_DEV_PUBLIC_KEY_PEM
    else process.env.ND_SECURITY_DEV_PUBLIC_KEY_PEM = originalKey
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  })

  it('installs a signed release, records it, and re-verifies it on state', async () => {
    const fixture = await signedReleaseFixture()
    process.env.ND_SECURITY_DEV_PUBLIC_KEY_PEM = fixture.publicKeyPem
    const dataDir = await mkdtemp(join(tmpdir(), 'nd-9router-data-'))
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
    const runtime = await managedRuntime(dataDir)

    const installed = await runtime.installFromDirectory(fixture.root)
    expect(installed).toMatchObject({
      installed: true,
      trusted: true,
      version: '0.1.0-test',
      signingKeyConfigured: true,
    })
    const record = JSON.parse(await readFile(join(dataDir, '9router-managed', 'installed.json'), 'utf8')) as { version: string; directory: string }
    expect(record.version).toBe('0.1.0-test')
    expect(record.directory).toContain(join(dataDir, '9router-managed', 'versions'))
    await expect(stat(join(record.directory, 'release-manifest.json'))).resolves.toBeTruthy()
    expect((await runtime.state()).trusted).toBe(true)

    await writeFile(join(record.directory, 'server.js'), 'tampered after install')
    expect((await runtime.state()).trusted).toBe(false)
  })

  it('rejects a tampered payload before installing anything', async () => {
    const fixture = await signedReleaseFixture()
    process.env.ND_SECURITY_DEV_PUBLIC_KEY_PEM = fixture.publicKeyPem
    await writeFile(join(fixture.root, 'server.js'), 'tampered source')
    const dataDir = await mkdtemp(join(tmpdir(), 'nd-9router-data-'))
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
    const runtime = await managedRuntime(dataDir)

    await expect(runtime.installFromDirectory(fixture.root)).rejects.toThrow(/size mismatch|hash mismatch/)
    expect((await runtime.state()).installed).toBe(false)
  })

  it('refuses to install without a published trust root', async () => {
    const fixture = await signedReleaseFixture()
    delete process.env.ND_SECURITY_DEV_PUBLIC_KEY_PEM
    const dataDir = await mkdtemp(join(tmpdir(), 'nd-9router-data-'))
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
    const runtime = await managedRuntime(dataDir)

    await expect(runtime.installFromDirectory(fixture.root)).rejects.toThrow(/trust root/)
    expect((await runtime.state()).signingKeyConfigured).toBe(false)
  })
})