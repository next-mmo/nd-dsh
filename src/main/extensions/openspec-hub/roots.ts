import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { HttpError } from './types.js'

export interface RegisteredRoot {
  path: string
  name: string
}

const MAX_ROOTS = 64

function canonical(dir: string): string {
  const resolved = path.resolve(dir)
  return existsSync(resolved) ? realpathSync(resolved) : resolved
}

/**
 * Hub-owned list of user-registered project directories (dataDir/roots.json).
 * Kept outside watched repositories and outside ND settings so the view can
 * manage it through declared actions; pinned workspaces and extraRoots remain
 * separate sources merged at config-build time.
 */
export class RootsStore {
  private readonly file: string

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'roots.json')
  }

  list(): RegisteredRoot[] {
    if (!existsSync(this.file)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (entry): entry is RegisteredRoot =>
          Boolean(entry) && typeof entry === 'object' && typeof (entry as RegisteredRoot).path === 'string' && typeof (entry as RegisteredRoot).name === 'string',
      )
    } catch {
      return []
    }
  }

  add(rawPath: unknown, rawName?: unknown): RegisteredRoot {
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      throw new HttpError(400, 'invalid-root', 'path must be a non-empty absolute directory path')
    }
    const trimmed = rawPath.trim()
    if (!path.isAbsolute(trimmed)) {
      throw new HttpError(400, 'invalid-root', 'path must be absolute')
    }
    const dir = canonical(trimmed)
    let stat
    try {
      stat = statSync(dir)
    } catch {
      throw new HttpError(404, 'root-missing', 'directory does not exist')
    }
    if (!stat.isDirectory()) throw new HttpError(400, 'invalid-root', 'path is not a directory')
    if (!existsSync(path.join(dir, 'openspec')) || !statSync(path.join(dir, 'openspec')).isDirectory()) {
      throw new HttpError(400, 'root-not-openspec', 'directory has no openspec/ folder; run `openspec init` there first')
    }
    const roots = this.list()
    if (roots.some((root) => root.path === dir)) {
      throw new HttpError(409, 'duplicate-root', 'this directory is already registered')
    }
    if (roots.length >= MAX_ROOTS) {
      throw new HttpError(409, 'too-many-roots', `at most ${MAX_ROOTS} registered projects`)
    }
    const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, 120) : path.basename(dir)
    const root = { path: dir, name }
    this.persist([...roots, root])
    return root
  }

  remove(rawPath: unknown): void {
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      throw new HttpError(400, 'invalid-root', 'path must be a non-empty string')
    }
    const dir = canonical(rawPath.trim())
    const roots = this.list()
    const next = roots.filter((root) => root.path !== dir)
    if (next.length === roots.length) throw new HttpError(404, 'unknown-root', 'directory is not registered')
    this.persist(next)
  }

  private persist(roots: RegisteredRoot[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(roots, null, 2))
    renameSync(tmp, this.file)
  }
}