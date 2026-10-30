import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const MANIFEST = 'release-manifest.json'
const SKIPPED_DIRECTORIES = new Set(['.git'])
const MAX_FILES = 25_000
const MAX_TOTAL_BYTES = 1_500_000_000
const MAX_FILE_BYTES = 600_000_000

export interface LocalReleaseEntries {
  version: string
  /** `bundled` ships its own runtime; `system-node` runs the package with Node. */
  runtimeMode: 'bundled' | 'system-node'
  runtimeEntry?: string
  serverEntry: string
  workingDirectory: string
  /** Absolute Node executable for `system-node` imports. */
  nodePath?: string
}

export interface LocalReleaseFile {
  path: string
  bytes: number
  sha256: string
}

export interface LocalReleaseInventory {
  files: LocalReleaseFile[]
  totalBytes: number
  digest: string
}

export class LocalReleaseError extends Error {
  constructor(message: string) {
    super(`Unverified import refused: ${message}`)
    this.name = 'LocalReleaseError'
  }
}

/** Relative, portable path with no traversal, drive letters or separators. */
function safeRelativePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > 1024) return undefined
  if (value === '.') return '.'
  if (value.startsWith('/') || value.includes('\\') || value.includes(':') || /[\u0000-\u001f]/.test(value)) return undefined
  const segments = value.split('/')
  // Win32 strips trailing dots/spaces; ".. " must never become a traversal.
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'
    || segment === '.git' || /[ .]$/.test(segment))) return undefined
  return value
}

async function fileExists(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined)
  return Boolean(info?.isFile())
}

async function directoryExists(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined)
  return Boolean(info?.isDirectory())
}

async function readManifest(root: string): Promise<Record<string, unknown> | undefined> {
  const path = join(root, MANIFEST)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new LocalReleaseError('release-manifest.json is not an object')
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof LocalReleaseError) throw error
    throw new LocalReleaseError('release-manifest.json is unreadable')
  }
}

async function readPackageVersion(root: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
    if (parsed?.name !== '9router') return undefined
    return typeof parsed.version === 'string' && parsed.version.length <= 64 ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/**
 * An installed Node for package imports. ND never borrows its own Electron
 * runtime: an imported 9Router package needs a real Node (native modules and
 * the standalone server are built against the Node ABI).
 */
export function resolveSystemNodeRuntime(): string | undefined {
  const explicit = process.env.ND_9ROUTER_NODE?.trim()
  if (explicit && existsSync(explicit)) return explicit
  const candidates = process.platform === 'win32'
    ? [
        process.env.ProgramFiles ? join(process.env.ProgramFiles, 'nodejs', 'node.exe') : '',
        process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)']!, 'nodejs', 'node.exe') : '',
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe') : '',
      ]
    : ['/usr/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node']
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  // Tests and dev tools run inside a real Node process; Electron does not.
  if (!process.versions.electron) return process.execPath
  return undefined
}

/**
 * Recognise a local 9Router folder without trusting anything it says about
 * itself. A release manifest supplies the entry points; otherwise the npm
 * package layout (`app/server.js`) is detected and run with local Node.
 */
export async function detectLocalReleaseEntries(root: string): Promise<LocalReleaseEntries> {
  const manifest = await readManifest(root)
  if (manifest) {
    const version = typeof manifest.version === 'string' && manifest.version.trim()
      ? manifest.version.trim().slice(0, 64)
      : '0.0.0-local'
    const runtimeEntry = safeRelativePath(manifest.runtimeEntry)
    const serverEntry = safeRelativePath(manifest.serverEntry)
    if (!runtimeEntry || !serverEntry) {
      throw new LocalReleaseError('release-manifest.json must name a runtime entry and a server entry')
    }
    if (!await fileExists(join(root, runtimeEntry))) throw new LocalReleaseError(`runtime entry "${runtimeEntry}" is missing`)
    if (!await fileExists(join(root, serverEntry))) throw new LocalReleaseError(`server entry "${serverEntry}" is missing`)
    const requestedWorkingDirectory = manifest.workingDirectory === undefined ? '.' : safeRelativePath(manifest.workingDirectory)
    if (!requestedWorkingDirectory || !await directoryExists(join(root, requestedWorkingDirectory))) {
      throw new LocalReleaseError('working directory is missing')
    }
    return { version, runtimeMode: 'bundled', runtimeEntry, serverEntry, workingDirectory: requestedWorkingDirectory }
  }

  const version = await readPackageVersion(root)
  let serverEntry: string | undefined
  for (const candidate of ['app/custom-server.js', 'app/server.js']) {
    if (await fileExists(join(root, candidate))) { serverEntry = candidate; break }
  }
  if (version && serverEntry) {
    const nodePath = resolveSystemNodeRuntime()
    if (!nodePath) {
      throw new LocalReleaseError('this package import needs Node.js on PATH (or ND_9ROUTER_NODE); choose a release folder with a bundled runtime instead')
    }
    return { version, runtimeMode: 'system-node', serverEntry, workingDirectory: 'app', nodePath }
  }

  throw new LocalReleaseError('choose a 9Router release folder (release-manifest.json) or a 9Router package folder containing app/server.js')
}

/**
 * Hash-pin every file in a local 9Router folder. This is integrity, not
 * authenticity: it proves the files have not changed since import, never who
 * built them. Symlinks and non-regular files are refused so the inventory
 * cannot point outside the copied tree.
 */
export async function inventoryLocalRelease(root: string): Promise<LocalReleaseInventory> {
  const absoluteRoot = resolve(root)
  const files: LocalReleaseFile[] = []
  let totalBytes = 0
  const pending: string[] = ['']
  while (pending.length > 0) {
    const relativeDirectory = pending.pop()!
    const directory = join(absoluteRoot, relativeDirectory)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      throw new LocalReleaseError(`cannot read ${relativeDirectory || '.'}`)
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new LocalReleaseError(`symlink "${join(relativeDirectory, entry.name)}" is not allowed`)
      const absoluteEntry = join(directory, entry.name)
      if (entry.isDirectory()) {
        // Junctions can masquerade as directories on Windows; lstat catches them.
        if ((await lstat(absoluteEntry)).isSymbolicLink()) {
          throw new LocalReleaseError(`symlink "${join(relativeDirectory, entry.name)}" is not allowed`)
        }
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        pending.push(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name)
        continue
      }
      if (!entry.isFile()) throw new LocalReleaseError(`"${join(relativeDirectory, entry.name)}" is not a regular file`)
      const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const info = await lstat(absoluteEntry)
      if (info.size > MAX_FILE_BYTES) throw new LocalReleaseError(`"${path}" exceeds the file size limit`)
      totalBytes += info.size
      if (totalBytes > MAX_TOTAL_BYTES) throw new LocalReleaseError('the folder exceeds the import size limit')
      if (files.length >= MAX_FILES) throw new LocalReleaseError('the folder exceeds the file count limit')
      files.push({ path, bytes: info.size, sha256: await hashFile(absoluteEntry) })
    }
  }
  if (files.length === 0) throw new LocalReleaseError('the folder is empty')
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { files, totalBytes, digest: inventoryDigest(files) }
}

export async function assertInventoryDigest(root: string, expected: string): Promise<void> {
  const inventory = await inventoryLocalRelease(root)
  if (inventory.digest !== expected) {
    throw new LocalReleaseError('files changed after import; import the folder again to accept the new contents')
  }
}

function inventoryDigest(files: readonly LocalReleaseFile[]): string {
  // JSON keeps path separators explicit, so a crafted file name cannot make
  // two different inventories share one digest.
  return createHash('sha256').update(JSON.stringify(files)).digest('hex')
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

/** Relative path of `child` inside `parent`, or undefined when it escapes. */
export function isInsideDirectory(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child))
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.includes(':'))
}
