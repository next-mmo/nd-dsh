import { promises as fs } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

export interface DiskVolume {
  /** Absolute mount root; what a scan of this volume starts from. */
  path: string
  /** Short display label, e.g. "Macintosh HD" or "C:". */
  name: string
  /** Total capacity in bytes. */
  bytes: number
  /** Free space available to the current user in bytes. */
  available: number
}

export interface DiskVolumeSources {
  platform?: NodeJS.Platform
  statfs(path: string): Promise<{ bsize: number; blocks: number; bavail: number }>
  readdir(path: string): Promise<string[]>
  isDirectory(path: string): Promise<boolean>
}

const MAX_MOUNTS_PER_ROOT = 32

/**
 * Mounted volumes with capacity and free space, through statfs — metadata only,
 * never a walk. Candidate roots are platform-shaped (macOS `/Volumes`, Windows
 * drive letters, `/media` and `/mnt` elsewhere) and each is probed: a mount
 * that errors is simply not a volume, never a failure of the listing.
 */
export async function listDiskVolumes(sources: DiskVolumeSources): Promise<DiskVolume[]> {
  const platform = sources.platform ?? process.platform
  const roots = await candidateRoots(platform, sources)
  const volumes: DiskVolume[] = []
  const seen = new Set<string>()
  for (const path of roots) {
    if (seen.has(path)) continue
    seen.add(path)
    const stat = await sources.statfs(path).catch(() => null)
    if (!stat || stat.blocks <= 0 || stat.bsize <= 0) continue
    volumes.push({
      path,
      name: volumeName(path, platform),
      bytes: stat.blocks * stat.bsize,
      available: Math.max(0, stat.bavail * stat.bsize),
    })
  }
  return volumes
}

function volumeName(path: string, platform: NodeJS.Platform): string {
  if (path === '/') return 'System'
  if (platform === 'win32' && /^[A-Za-z]:[\\/]?$/.test(path)) return path.slice(0, 2)
  const base = (platform === 'win32' ? win32 : posix).basename(path.replace(/[/\\]+$/, ''))
  return base || path
}

async function candidateRoots(platform: NodeJS.Platform, sources: DiskVolumeSources): Promise<string[]> {
  if (platform === 'win32') {
    const drives: string[] = []
    for (let code = 67; code <= 90; code += 1) {
      drives.push(`${String.fromCharCode(code)}:\\`)
    }
    return drives
  }
  const roots = ['/']
  if (platform === 'darwin') {
    roots.push(...(await childDirectories('/Volumes', sources)))
    return roots
  }
  roots.push(...(await childDirectories('/media', sources)), ...(await childDirectories('/mnt', sources)))
  return roots
}

async function childDirectories(parent: string, sources: DiskVolumeSources): Promise<string[]> {
  const names = await sources.readdir(parent).catch(() => [])
  const out: string[] = []
  for (const name of names.slice(0, MAX_MOUNTS_PER_ROOT)) {
    const path = posix.join(parent, name)
    if (await sources.isDirectory(path).catch(() => false)) out.push(path)
  }
  return out
}

/** The production source wiring over node:fs. */
export function nodeDiskVolumeSources(): DiskVolumeSources {
  return {
    platform: process.platform,
    statfs: async (path) => {
      const stat = await fs.statfs(path)
      return { bsize: stat.bsize, blocks: stat.blocks, bavail: stat.bavail }
    },
    readdir: async (path) => {
      const entries = await readdir(path, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name)
    },
    isDirectory: async (path) => (await fs.stat(path)).isDirectory(),
  }
}
