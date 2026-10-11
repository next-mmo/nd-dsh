import { execFile } from 'node:child_process'
import { access, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface WallpaperCommand {
  file: string
  args: string[]
  env?: NodeJS.ProcessEnv
  optional?: boolean
}

/**
 * Applies a wallpaper through the nd-core sidecar. Windows is owned there
 * because the desktop implementation spawned `powershell.exe` and recompiled an
 * inline C# type on every single change, which cost ~900 ms of process startup
 * and JIT before the OS call even ran.
 */
export type WallpaperApply = (imagePath: string) => Promise<void>

/**
 * Build fixed-binary, no-shell commands for a wallpaper update.
 *
 * The user-selected path is never interpolated into AppleScript or a shell:
 * macOS receives it through a process environment variable and Linux passes a
 * file:// URI as a plain execFile argument. Windows has no command at all — it
 * goes through the sidecar's in-process `SystemParametersInfoW`.
 */
export function wallpaperCommands(
  platform: NodeJS.Platform,
  imagePath: string,
  env: NodeJS.ProcessEnv = process.env,
): WallpaperCommand[] {
  if (platform === 'win32') {
    throw new Error('The Windows desktop wallpaper is set through the nd-core sidecar, not a shell command')
  }

  if (platform === 'darwin') {
    return [{
      file: '/usr/bin/osascript',
      args: [
        '-e', 'set p to system attribute "ND_WALLPAPER_PATH"',
        '-e', 'tell application "System Events" to tell every desktop to set picture to POSIX file p',
      ],
      env: { ...env, ND_WALLPAPER_PATH: imagePath },
    }]
  }

  if (platform === 'linux') {
    const uri = gnomeFileUri(imagePath)
    return [
      {
        file: 'gsettings',
        args: ['set', 'org.gnome.desktop.background', 'picture-uri', uri],
      },
      {
        file: 'gsettings',
        args: ['set', 'org.gnome.desktop.background', 'picture-uri-dark', uri],
        optional: true,
      },
    ]
  }

  throw new Error(`Changing wallpaper is not supported on ${platform}`)
}

export async function setDesktopWallpaper(
  imagePath: string,
  platform: NodeJS.Platform = process.platform,
  apply?: WallpaperApply,
): Promise<void> {
  await access(imagePath)
  if (platform === 'win32') {
    // Fail closed rather than quietly skipping: a wallpaper command that reports
    // success without changing anything is worse than a visible error.
    if (!apply) throw new Error('The nd-core sidecar is required to change the Windows desktop wallpaper')
    try {
      await apply(imagePath)
    } catch (error) {
      throw new Error(`Could not change desktop wallpaper: ${message(error)}`)
    }
    setActiveWallpaperState(imagePath)
    return
  }

  for (const command of wallpaperCommands(platform, imagePath)) {
    try {
      await execFileAsync(command.file, command.args, {
        ...(command.env ? { env: command.env } : {}),
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 512 * 1024,
      })
    } catch (error) {
      if (command.optional) continue
      if (platform === 'linux') {
        throw new Error(`Could not change wallpaper through GNOME gsettings: ${message(error)}`)
      }
      throw new Error(`Could not change desktop wallpaper: ${message(error)}`)
    }
  }
  setActiveWallpaperState(imagePath)
}

export const SUPPORTED_WALLPAPER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp'])

export interface WallpaperEntry {
  filename: string
  path: string
  size: number
  modifiedAt: number
}

let activeWallpaperPath: string | null = null
let activeWallpaperFolder: string | null = null

export function getActiveWallpaperState(): { path: string | null; folder: string | null } {
  return { path: activeWallpaperPath, folder: activeWallpaperFolder }
}

export function setActiveWallpaperState(path: string | null, folder?: string | null): void {
  activeWallpaperPath = path
  if (folder !== undefined) activeWallpaperFolder = folder
}

export function resolveDefaultWallpaperFolder(): string {
  const home = homedir()
  return join(home, 'Pictures')
}

export function normalizeWallpaperPath(raw?: string): string {
  if (!raw) return ''
  let cleaned = raw.trim()
  while ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim()
  }
  return cleaned
}

/**
 * The folder a wallpaper library actually reads, after applying the default and
 * the "a file was supplied, use its directory" fallback.
 *
 * Exported because the sidecar addresses images relative to a root, so callers
 * need the same resolved root the listing used rather than re-deriving it.
 */
export async function resolveWallpaperFolder(folderPath?: string): Promise<string> {
  const normalized = normalizeWallpaperPath(folderPath)
  const targetFolder = normalized || resolveDefaultWallpaperFolder()
  const stats = await stat(targetFolder).catch(() => null)
  return stats && !stats.isDirectory() ? dirname(targetFolder) : targetFolder
}

export async function listWallpapersInFolder(folderPath?: string): Promise<WallpaperEntry[]> {
  try {
    const targetFolder = await resolveWallpaperFolder(folderPath)
    await access(targetFolder)
    const entries = await readdir(targetFolder, { withFileTypes: true })
    const results: WallpaperEntry[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const ext = extname(entry.name).toLowerCase()
      if (!SUPPORTED_WALLPAPER_EXTENSIONS.has(ext)) continue
      const fullPath = join(targetFolder, entry.name)
      try {
        const fileStat = await stat(fullPath)
        results.push({
          filename: entry.name,
          path: fullPath,
          size: fileStat.size,
          modifiedAt: fileStat.mtimeMs,
        })
      } catch {
        // Skip unreadable files
      }
    }
    if (results.length === 0) {
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const subFolder = join(targetFolder, entry.name)
        try {
          const subEntries = await readdir(subFolder, { withFileTypes: true })
          for (const sub of subEntries) {
            if (!sub.isFile()) continue
            const ext = extname(sub.name).toLowerCase()
            if (!SUPPORTED_WALLPAPER_EXTENSIONS.has(ext)) continue
            const fullPath = join(subFolder, sub.name)
            try {
              const fileStat = await stat(fullPath)
              results.push({
                filename: sub.name,
                path: fullPath,
                size: fileStat.size,
                modifiedAt: fileStat.mtimeMs,
              })
            } catch {
              // Skip unreadable files
            }
          }
        } catch {
          // Skip inaccessible subfolders
        }
      }
    }
    return results.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' }))
  } catch {
    return []
  }
}

export async function cycleWallpaper(options: {
  folder?: string | undefined
  mode?: 'next' | 'random' | 'previous' | undefined
  platform?: NodeJS.Platform | undefined
  apply?: WallpaperApply | undefined
}): Promise<{ changed: boolean; name?: string; path?: string }> {
  const items = await listWallpapersInFolder(options.folder)
  if (items.length === 0) return { changed: false }

  const mode = options.mode ?? 'next'
  let targetIndex = 0

  if (mode === 'random') {
    if (items.length === 1) {
      targetIndex = 0
    } else {
      const candidates = items
        .map((item, idx) => ({ item, idx }))
        .filter(({ item }) => item.path !== activeWallpaperPath)
      const pick = candidates[Math.floor(Math.random() * (candidates.length || 1))] ?? candidates[0]!
      targetIndex = pick.idx
    }
  } else if (mode === 'previous') {
    if (activeWallpaperPath) {
      const currentIdx = items.findIndex((item) => item.path === activeWallpaperPath)
      targetIndex = currentIdx > 0 ? currentIdx - 1 : items.length - 1
    } else {
      targetIndex = items.length - 1
    }
  } else {
    if (activeWallpaperPath) {
      const currentIdx = items.findIndex((item) => item.path === activeWallpaperPath)
      targetIndex = currentIdx >= 0 ? (currentIdx + 1) % items.length : 0
    } else {
      targetIndex = 0
    }
  }

  const chosen = items[targetIndex]!
  await setDesktopWallpaper(chosen.path, options.platform, options.apply)
  setActiveWallpaperState(chosen.path, options.folder || resolveDefaultWallpaperFolder())
  return { changed: true, name: chosen.filename, path: chosen.path }
}

export async function applyWallpaperFromFolder(
  folder: string | undefined,
  filename: string,
  platform?: NodeJS.Platform | undefined,
  apply?: WallpaperApply | undefined,
): Promise<{ changed: boolean; name: string; path: string }> {
  const targetFolder = normalizeWallpaperPath(folder) || resolveDefaultWallpaperFolder()
  let targetPath = filename
  let exists = false
  try {
    await access(filename)
    exists = true
    targetPath = filename
  } catch {
    // not directly accessible as filename
  }
  if (!exists) {
    try {
      const candidate = join(targetFolder, filename)
      await access(candidate)
      exists = true
      targetPath = candidate
    } catch {
      // try basename
    }
  }
  if (!exists) {
    targetPath = join(targetFolder, basename(filename))
    await access(targetPath)
  }
  await setDesktopWallpaper(targetPath, platform, apply)
  setActiveWallpaperState(targetPath, targetFolder)
  return { changed: true, name: basename(targetPath), path: targetPath }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** GNOME wants a POSIX file URI; build it without host-platform path semantics. */
function gnomeFileUri(path: string): string {
  const absolute = path.startsWith('/') ? path : `/${path}`
  return `file://${absolute.split('/').map(encodeURIComponent).join('/')}`
}
