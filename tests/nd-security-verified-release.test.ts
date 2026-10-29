import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync, createHash, sign } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { verifyApprovedRelease } from '../src/main/security/verified-release.js'

const tracked: string[] = []
afterEach(async () => {
  await Promise.all(tracked.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function releaseFixture() {
  const root = await mkdtemp(join(tmpdir(), 'nd-security-'))
  tracked.push(root)
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const files = [
    { path: 'runtime/node', value: 'not-an-executable: fixtures never launch it' },
    { path: 'server.js', value: '/* test-only */' },
    { path: 'security-attestation.json', value: JSON.stringify({ schemaVersion: 1, checks: { dependency: 'pass', malware: 'pass', static: 'pass', license: 'pass' } }) },
    { path: 'sbom.json', value: '{}' },
  ]
  for (const f of files) {
    await mkdir(dirname(join(root, f.path)), { recursive: true })
    await writeFile(join(root, f.path), f.value)
  }
  const manifest = {
    schemaVersion: 1,
    packageId: 'nd.9router-runtime',
    repository: 'https://github.com/next-mmo/9router-nd-dsh',
    revision: 'f'.repeat(40),
    version: '0.1.0',
    platform: process.platform,
    arch: process.arch,
    publisherKeyId: 'test-key',
    runtimeEntry: 'runtime/node',
    serverEntry: 'server.js',
    files: files.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.value), sha256: createHash('sha256').update(f.value).digest('hex') })),
  }
  const bytes = Buffer.from(JSON.stringify(manifest))
  await writeFile(join(root, 'release-manifest.json'), bytes)
  await writeFile(join(root, 'release-manifest.sig'), sign(null, bytes, privateKey).toString('base64'))
  const policy = {
    trustedKeys: { 'test-key': publicKey.export({ format: 'pem', type: 'spki' }).toString() },
    allowedPackages: ['nd.9router-runtime'],
    allowedRepositories: ['https://github.com/next-mmo/9router-nd-dsh'],
  }
  return { root, policy, manifest }
}
describe('ND Security release verification (offline, no runtime execution)', () => {
  it('accepts signed byte-exact artifact', async () => {
    const { root, policy } = await releaseFixture()
    const result = await verifyApprovedRelease(root, policy)
    expect(result.verdict).toBe('verified')
    expect(result.fileCount).toBe(4)
  })
  it('rejects a tampered signed file', async () => {
    const { root, policy } = await releaseFixture()
    await writeFile(join(root, 'server.js'), 'tampered')
    await expect(verifyApprovedRelease(root, policy)).rejects.toThrow(/size mismatch|hash mismatch/)
  })
  it('rejects an untrusted signing key', async () => {
    const { root, policy } = await releaseFixture()
    await expect(verifyApprovedRelease(root, { ...policy, trustedKeys: {} })).rejects.toThrow(/trust root/)
  })
  it('rejects a forged manifest path', async () => {
    const { root, policy, manifest } = await releaseFixture()
    manifest.files[0]!.path = '../escape'
    await writeFile(join(root, 'release-manifest.json'), JSON.stringify(manifest))
    await expect(verifyApprovedRelease(root, policy)).rejects.toThrow(/invalid file path/)
  })
})
