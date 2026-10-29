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

async function managedRuntime(dataDir: string): Promise<NineRouterManagedRuntime> {
  const core = {
    onEvent: vi.fn(() => () => undefined),
    request: vi.fn(async () => ({})),
  }
  const runtime = new NineRouterManagedRuntime(core as never, dataDir)
  await runtime.initialize()
  return runtime
}

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