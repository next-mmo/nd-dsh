import { createHash, createPublicKey, verify as verifyEd25519 } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { NdSecurityReport } from '../../shared/nd-security.js'

export interface ReleasePolicy {
  /** Public keys must be pinned by ND's signed build, NEVER fetched with an artifact. */
  trustedKeys: Readonly<Record<string, string>>
  allowedRepositories: readonly string[]
  allowedPackages: readonly string[]
  maxFiles?: number
  maxBytes?: number
  maxFileBytes?: number
}

interface ArtifactFile { path: string; bytes: number; sha256: string }
interface ReleaseManifest {
  schemaVersion: 1
  packageId: string
  version: string
  repository: string
  revision: string
  platform: string
  arch: string
  publisherKeyId: string
  runtimeEntry: string
  serverEntry: string
  files: ArtifactFile[]
}
export class ReleaseVerificationError extends Error {
  constructor(readonly reason: string) {
    super('ND Security: ' + reason)
    this.name = 'ReleaseVerificationError'
  }
}
const MANIFEST = 'release-manifest.json'
const SIGNATURE = 'release-manifest.sig'
const MAX_FILES = 25000
const MAX_BYTES = 1_500_000_000
const MAX_FILE_BYTES = 600_000_000
function fail(reason: string): never { throw new ReleaseVerificationError(reason) }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function safePath(value: string): boolean {
  return value.length <= 1024 && value.length > 0 && !value.startsWith('/')
    && !value.includes('\\') && !value.includes(':') && !/[\u0000-\u001f]/.test(value)
    && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' && segment !== '.git')
}
function parseManifest(raw: unknown, policy: ReleasePolicy): ReleaseManifest {
  if (!record(raw) || raw.schemaVersion !== 1) fail('unsupported manifest format')
  if (typeof raw.packageId !== 'string' || !policy.allowedPackages.includes(raw.packageId)) fail('unapproved package')
  if (typeof raw.repository !== 'string' || !policy.allowedRepositories.includes(raw.repository)) fail('unapproved source')
  if (typeof raw.revision !== 'string' || !/^[a-f0-9]{40}$/.test(raw.revision)) fail('invalid immutable revision')
  if (typeof raw.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(raw.version)) fail('invalid version')
  if (raw.platform !== process.platform || raw.arch !== process.arch) fail('wrong platform or architecture')
  if (typeof raw.publisherKeyId !== 'string' || !Object.hasOwn(policy.trustedKeys, raw.publisherKeyId)) fail('untrusted publisher')
  if (typeof raw.runtimeEntry !== 'string' || !safePath(raw.runtimeEntry)) fail('invalid runtime entry')
  if (typeof raw.serverEntry !== 'string' || !safePath(raw.serverEntry)) fail('invalid server entry')
  if (!Array.isArray(raw.files) || raw.files.length < 3 || raw.files.length > (policy.maxFiles ?? MAX_FILES)) fail('invalid file inventory')
  const seen = new Set<string>()
  let bytes = 0
  for (const f of raw.files) {
    if (!record(f) || typeof f.path !== 'string' || !safePath(f.path)) fail('invalid file path')
    if (f.path === MANIFEST || f.path === SIGNATURE) fail('signed inventory contains a signature file')
    const key = process.platform === 'win32' ? f.path.toLowerCase() : f.path
    if (seen.has(key)) fail('duplicate payload path')
    seen.add(key)
    if (typeof f.bytes !== 'number' || !Number.isSafeInteger(f.bytes) || f.bytes < 0
      || f.bytes > (policy.maxFileBytes ?? MAX_FILE_BYTES)) fail('invalid file size')
    if (typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)) fail('invalid digest')
    bytes += f.bytes
    if (bytes > (policy.maxBytes ?? MAX_BYTES)) fail('oversized release')
  }
  if (!seen.has(raw.runtimeEntry as string) || !seen.has(raw.serverEntry as string)
    || !seen.has('security-attestation.json') || !seen.has('sbom.json')) fail('missing mandatory release evidence')
  return raw as unknown as ReleaseManifest
}
async function ordinaryFile(path: string, maxBytes: number): Promise<import('node:fs').Stats> {
  const st = await lstat(path)
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > maxBytes) fail('unsafe file type or size')
  return st
}
async function inventory(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, item.name)
      const name = relative(root, p).split(sep).join('/')
      if (!safePath(name)) fail('unsafe directory path')
      const st = await lstat(p)
      if (st.isSymbolicLink()) fail('symlink found in payload')
      if (st.isDirectory()) await walk(p)
      else if (st.isFile() && st.nlink === 1) {
        out.push(name)
        if (out.length > MAX_FILES + 2) fail('too many payload files')
      } else fail('non-regular file in payload')
    }
  }
  await walk(root)
  return out
}
/**
 * Verifies signed exact bytes without executing any payload code.
 * This does NOT perform vulnerability scanning, OS sandboxing or publisher-key provisioning.
 * Call again after staging and immediately before runtime launch.
 */
export async function verifyApprovedRelease(source: string, policy: ReleasePolicy): Promise<NdSecurityReport> {
  if (Object.keys(policy.trustedKeys).length === 0) fail('publisher trust root not provisioned')
  const root = await realpath(resolve(source))
  await ordinaryFile(join(root, MANIFEST), 5 * 1024 * 1024)
  await ordinaryFile(join(root, SIGNATURE), 4096)
  const manifestBytes = await readFile(join(root, MANIFEST))
  const raw = JSON.parse(manifestBytes.toString('utf8')) as unknown
  const manifest = parseManifest(raw, policy)
  const signatureText = (await readFile(join(root, SIGNATURE), 'utf8')).trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureText)) fail('malformed signature')
  const signature = Buffer.from(signatureText, 'base64')
  if (signature.length !== 64) fail('invalid Ed25519 signature length')
  let signatureValid = false
  try {
    const key = createPublicKey(policy.trustedKeys[manifest.publisherKeyId]!)
    signatureValid = verifyEd25519(null, manifestBytes, key, signature)
  } catch { /* unparseable keys fail closed */ }
  if (!signatureValid) fail('publisher signature mismatch')
  const expected = new Set<string>([MANIFEST, SIGNATURE, ...manifest.files.map(f => f.path)])
  const actual = await inventory(root)
  if (actual.length !== expected.size || actual.some(x => !expected.has(x))) fail('unexpected or missing payload items')
  for (const f of manifest.files) {
    const abs = join(root, ...f.path.split('/'))
    await ordinaryFile(abs, policy.maxFileBytes ?? MAX_FILE_BYTES)
    const real = await realpath(abs)
    if (!real.startsWith(root + sep)) fail('payload escapes release root')
    const stat = await lstat(abs)
    if (stat.size !== f.bytes) fail('payload file size mismatch')
    const digest = createHash('sha256')
    for await (const block of createReadStream(abs)) digest.update(block)
    if (digest.digest('hex') !== f.sha256) fail('payload hash mismatch')
  }
  const attestation = JSON.parse(await readFile(join(root, 'security-attestation.json'), 'utf8')) as unknown
  if (!record(attestation) || attestation.schemaVersion !== 1 || !record(attestation.checks)
    || ['dependency', 'malware', 'static', 'license'].some(kind => attestation.checks && (attestation.checks as Record<string, unknown>)[kind] !== 'pass')) fail('security attestation failed')
  const digest = createHash('sha256').update(manifestBytes).digest('hex')
  return {
    verdict: 'verified',
    packageId: manifest.packageId,
    version: manifest.version,
    publisherKeyId: manifest.publisherKeyId,
    sha256: digest,
    fileCount: manifest.files.length,
    scannedAt: Date.now(),
    findings: [
      { code: 'signature', severity: 'info', description: 'Pinned publisher signature passed' },
      { code: 'inventory', severity: 'info', description: 'Signed inventory and SHA-256 checks passed' },
      { code: 'attestation', severity: 'info', description: 'Signed CI attestation metadata present' },
    ],
  }
}
