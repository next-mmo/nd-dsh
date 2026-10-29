import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

export function payloadFiles(root) {
  const files = []
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Release payload must not contain symbolic links')
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push({ path: relative(root, path).replaceAll('\\', '/'), sha256: digest(path) })
      else throw new Error('Release payload contains an unsupported file type')
    }
  }
  visit(root)
  return files
}

// Hashing is synchronous, so all file digests safely share one bounded buffer.
const digestChunk = Buffer.allocUnsafe(1024 * 1024)
function digest(path) {
  const descriptor = openSync(path, 'r')
  try {
    const hash = createHash('sha256')
    let size
    while ((size = readSync(descriptor, digestChunk, 0, digestChunk.length, null)) !== 0) hash.update(digestChunk.subarray(0, size))
    return hash.digest('hex')
  } finally { closeSync(descriptor) }
}

/** A packaged target is explicit; never fall back to the source on a bad path. */
export function electronTargetIdentity(env = process.env) {
  const configured = env.ND_DSH_E2E_EXECUTABLE?.trim()
  if (!configured) return { kind: 'source' }
  const executable = resolve(configured)
  if (!statSync(executable).isFile()) throw new Error('E2E executable must be a file: ' + executable)
  const sha256 = digest(executable)
  if (env.ND_DSH_E2E_PACKAGE_RECEIPT?.trim()) {
    const receiptPath = resolve(env.ND_DSH_E2E_PACKAGE_RECEIPT)
    const proof = JSON.parse(readFileSync(receiptPath, 'utf8'))
    if (proof.kind !== 'nd-portable-extraction' || resolve(proof.executable) !== executable
      || resolve(proof.payloadRoot) !== dirname(executable)) throw new Error('Package extraction receipt does not match E2E executable')
    const portable = electronTargetIdentity({ ND_DSH_E2E_EXECUTABLE: proof.portable.executable })
    if (portable.artifact !== proof.portable.artifact) throw new Error('Portable artifact changed after extraction')
    for (const file of proof.files ?? []) {
      if (typeof file.path !== 'string' || isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..')) throw new Error('Invalid release payload path')
    }
    const actual = payloadFiles(proof.payloadRoot)
    if (actual.length === 0 || JSON.stringify(actual) !== JSON.stringify(proof.files)) throw new Error('Extracted release payload changed after extraction')
    const payloadSha256 = createHash('sha256').update(JSON.stringify(actual)).digest('hex')
    if (payloadSha256 !== proof.payloadSha256) throw new Error('Package extraction receipt digest mismatch')
    return { ...portable, executable, executableSha256: sha256, extraction: { receipt: receiptPath, payloadSha256 } }
  }
  return {
    kind: 'packaged', executable, sha256,
    artifact: basename(executable) + '#sha256:' + sha256,
  }
}

/** Keep every launch and restart in the disposable profile, including .env overrides. */
export function electronLaunchOptions(profileDir, cwd = process.cwd(), env = process.env) {
  const target = electronTargetIdentity(env)
  const launchEnv = Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string'))
  if (target.kind === 'packaged') {
    // A developer's .env must not substitute source runtimes for bundled bytes.
    for (const key of ['ND_DSH_NODE_BIN', 'ND_DSH_HARNESS_ROOT', 'ND_DSH_PROJECT_ROOT', 'ND_DSH_CORE_BIN',
      'ND_DSH_MANAGED_RUNTIME_ROOT', 'ND_DSH_PATCH', 'ND_DSH_PRESET_DIR', 'ND_AGENT_BINARY', 'ELECTRON_RUN_AS_NODE']) delete launchEnv[key]
  }
  return {
    ...(target.kind === 'packaged' ? { executablePath: target.executable } : {}),
    args: [...(target.kind === 'source' ? ['.'] : []), '--user-data-dir=' + profileDir],
    cwd,
    env: { ...launchEnv, ND_DSH_USER_DATA_DIR: profileDir },
  }
}
