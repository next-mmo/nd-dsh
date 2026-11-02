import { constants } from 'node:fs'
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const CONTROL_AND_BIDI = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const WINDOWS_ILLEGAL = /[<>:"/\\|?*]/g
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const MAX_STEM_CHARS = 120
const MAX_COLLISION_ATTEMPTS = 999

export type MediaFileExtension = 'mp4' | 'm4a'

/**
 * Build a strict Windows-safe filename from an untrusted page title.
 *
 * Reserved device names, traversal dots, trailing dots/spaces, control and
 * bidi characters, and path separators are handled before the fixed extension
 * is appended. The returned value is always a bare filename, never a path.
 */
export function sanitizeMediaFilename(title: string, videoId: string, extension: MediaFileExtension): string {
  const fallback = `YouTube-${videoId}`
  let stem = String(title || '')
    .replace(/\s*-\s*YouTube\s*$/i, '')
    .replace(CONTROL_AND_BIDI, '')
    .replace(WINDOWS_ILLEGAL, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, MAX_STEM_CHARS)
    .replace(/[. ]+$/g, '')

  if (!stem || stem === '.' || stem === '..') stem = fallback
  // Windows reserves the name before the first dot (CON, CON.txt, COM1.foo).
  if (WINDOWS_RESERVED.test(stem.split('.')[0] ?? stem)) stem = `video-${stem}`
  if (!stem) stem = fallback
  return `${stem}.${extension}`
}

export function isPathInside(directory: string, path: string): boolean {
  const root = resolve(directory)
  const target = resolve(path)
  return dirname(target) === root && basename(target).length > 0
}

export interface MovedMediaFile {
  path: string
  fileName: string
}

/**
 * Move one verified media file from ND's staging directory into Downloads.
 * Existing files are never overwritten; `(2)`, `(3)` … are tried first.
 */
export async function moveMediaIntoDownloads(
  sourcePath: string,
  downloadsDir: string,
  title: string,
  videoId: string,
  extension: MediaFileExtension,
): Promise<MovedMediaFile> {
  const targetDir = resolve(downloadsDir)
  await mkdir(targetDir, { recursive: true })
  const baseName = sanitizeMediaFilename(title, videoId, extension)
  const stem = baseName.slice(0, -(extension.length + 1))

  for (let index = 1; index <= MAX_COLLISION_ATTEMPTS; index += 1) {
    const candidateName = index === 1 ? baseName : `${stem} (${index}).${extension}`
    const candidate = join(targetDir, candidateName)
    if (!isPathInside(targetDir, candidate)) {
      throw new Error('The media filename escaped the Downloads directory.')
    }
    if (await exists(candidate)) continue
    if (await moveFile(sourcePath, candidate)) {
      return { path: candidate, fileName: basename(candidate) }
    }
  }

  const suffix = new Date().toISOString().replace(/[:.]/g, '-')
  const candidate = join(targetDir, `${stem}-${suffix}.${extension}`)
  if (!isPathInside(targetDir, candidate)) {
    throw new Error('The media filename escaped the Downloads directory.')
  }
  if (!(await moveFile(sourcePath, candidate))) {
    throw new Error('A unique filename could not be created in Downloads.')
  }
  return { path: candidate, fileName: basename(candidate) }
}

async function moveFile(sourcePath: string, targetPath: string): Promise<boolean> {
  try {
    await rename(sourcePath, targetPath)
    return true
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    if (errorCode(error) !== 'EXDEV') throw error
  }
  try {
    await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL)
    await unlink(sourcePath)
    return true
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    throw error
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined
}
