import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { HttpError } from './types.js'

export const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
export const SAFE_STORE_ID = /^[A-Za-z0-9_-]{1,64}$/

const ALLOWED_DIRS = ['openspec', 'docs']
const ALLOWED_ROOT_FILES = ['README.md', 'AGENTS.md']
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_WALK_FILES = 5000
const MAX_WALK_DEPTH = 8

export function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new HttpError(400, 'invalid-id', `${label} is not a valid identifier`)
  }
}

function within(root: string, target: string): boolean {
  const r = process.platform === 'win32' ? root.toLowerCase() : root
  const t = process.platform === 'win32' ? target.toLowerCase() : target
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/')
}

/**
 * Resolve a project-relative path and enforce the read scope:
 * inside the canonical root, under openspec/ or docs/, or an allowed root file.
 * Symlinks may not escape the root. Never returns a path for .env* files.
 */
export function safeJoin(root: string, rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) {
    throw new HttpError(400, 'invalid-path', 'path is not valid')
  }
  const canonicalRoot = existsSync(root) ? realpathSync(root) : path.resolve(root)
  const resolved = path.resolve(canonicalRoot, rel)
  if (!within(canonicalRoot, resolved)) {
    throw new HttpError(400, 'invalid-path', 'path escapes the project root')
  }
  const relNorm = toPosix(path.relative(canonicalRoot, resolved))
  const segments = relNorm.split('/')
  if (segments.some((s) => s.startsWith('.env'))) {
    throw new HttpError(400, 'invalid-path', 'path is not readable')
  }
  const allowed =
    ALLOWED_ROOT_FILES.includes(relNorm) ||
    ALLOWED_DIRS.some((d) => relNorm === d || relNorm.startsWith(`${d}/`))
  if (!allowed) {
    throw new HttpError(400, 'invalid-path', 'path is outside the allowed read scope')
  }
  if (existsSync(resolved)) {
    const real = realpathSync(resolved)
    if (!within(canonicalRoot, real)) {
      throw new HttpError(400, 'invalid-path', 'path escapes the project root')
    }
  }
  return resolved
}

export function readProjectFile(root: string, rel: string): string {
  const abs = safeJoin(root, rel)
  let stat
  try {
    stat = statSync(abs)
  } catch {
    throw new HttpError(404, 'not-found', 'file not found')
  }
  if (!stat.isFile()) throw new HttpError(404, 'not-found', 'file not found')
  if (stat.size > MAX_FILE_BYTES) {
    throw new HttpError(413, 'too-large', 'file exceeds the read size limit')
  }
  return readFileSync(abs, 'utf8')
}

export function tryReadProjectFile(root: string, rel: string): string | null {
  try {
    return readProjectFile(root, rel)
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 404) return null
    throw err
  }
}

export function projectFileExists(root: string, rel: string): boolean {
  try {
    return statSync(safeJoin(root, rel)).isFile()
  } catch {
    return false
  }
}

/** List files (posix relative paths) under a scoped directory, bounded depth/count. */
export function walkProjectDir(root: string, relDir: string): string[] {
  const base = safeJoin(root, relDir)
  const out: string[] = []
  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || out.length >= MAX_WALK_FILES) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_WALK_FILES) return
      if (entry.name.startsWith('.env')) continue
      const abs = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        visit(abs, depth + 1)
      } else if (entry.isFile()) {
        out.push(toPosix(path.relative(base, abs)))
      }
    }
  }
  visit(base, 0)
  return out.sort()
}

export function listSubdirs(root: string, relDir: string): string[] {
  let base: string
  try {
    base = safeJoin(root, relDir)
  } catch {
    return []
  }
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && SAFE_ID.test(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}