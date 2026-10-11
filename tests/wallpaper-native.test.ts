import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  getActiveWallpaperState,
  listWallpapersInFolder,
  normalizeWallpaperPath,
  setActiveWallpaperState,
  setDesktopWallpaper,
  wallpaperCommands,
} from '../src/main/os/wallpaper.js'

describe('desktop wallpaper adapter', () => {
  it('has no Windows shell command at all, because the sidecar owns that call', () => {
    const path = 'C:\\Users\\ND User\\Pictures\\quote " dangerous.png'

    // The previous implementation spawned powershell.exe and recompiled an inline
    // C# type per change (~900 ms). There is now no command to build, so there is
    // also no program text a path could be interpolated into.
    expect(() => wallpaperCommands('win32', path, { SystemRoot: 'C:\\Windows' })).toThrow(/sidecar/)
  })

  it('routes the Windows change through the sidecar applier and not a child process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nd-wp-win-'))
    try {
      const target = join(dir, "nd user's wallpaper.png")
      await writeFile(target, 'fake-image')
      const apply = vi.fn(async () => undefined)

      await setDesktopWallpaper(target, 'win32', apply)

      expect(apply).toHaveBeenCalledTimes(1)
      // The exact path is handed over intact; nothing is quoted or escaped.
      expect(apply).toHaveBeenCalledWith(target)
      expect(getActiveWallpaperState().path).toBe(target)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails closed on Windows when the sidecar applier is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nd-wp-nocore-'))
    try {
      const target = join(dir, 'a.png')
      await writeFile(target, 'fake-image')

      await expect(setDesktopWallpaper(target, 'win32')).rejects.toThrow(/nd-core sidecar is required/)
      // A refused change must not be recorded as the active wallpaper.
      expect(getActiveWallpaperState().path).not.toBe(target)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('surfaces a sidecar failure as a wallpaper error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nd-wp-fail-'))
    try {
      const target = join(dir, 'a.png')
      await writeFile(target, 'fake-image')
      const apply = vi.fn(async () => {
        throw new Error('SystemParametersInfoW rejected the wallpaper')
      })

      await expect(setDesktopWallpaper(target, 'win32', apply)).rejects.toThrow(
        /Could not change desktop wallpaper: SystemParametersInfoW/,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('passes the macOS path through the environment instead of AppleScript text', () => {
    const path = '/Users/nd/Pictures/a "quoted" image.png'
    const [command] = wallpaperCommands('darwin', path, {})

    expect(command?.file).toBe('/usr/bin/osascript')
    expect(command?.env?.ND_WALLPAPER_PATH).toBe(path)
    expect(command?.args.join(' ')).not.toContain(path)
  })

  it('uses execFile arguments and file URIs for the GNOME adapter', () => {
    const path = '/home/nd/My Wallpapers/one.png'
    const commands = wallpaperCommands('linux', path, {})

    expect(commands).toHaveLength(2)
    expect(commands[0]?.file).toBe('gsettings')
    expect(commands[0]?.args.at(-1)).toBe('file:///home/nd/My%20Wallpapers/one.png')
    expect(commands[1]?.optional).toBe(true)
  })

  it('fails closed on unsupported platforms', () => {
    expect(() => wallpaperCommands('aix', '/tmp/a.png')).toThrow(/not supported/)
  })

  it('lists only supported image formats in a folder and sorts them naturally', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nd-wp-'))
    try {
      await writeFile(join(dir, 'wall-2.jpg'), 'fake-image-2')
      await writeFile(join(dir, 'wall-1.png'), 'fake-image-1')
      await writeFile(join(dir, 'notes.txt'), 'not-an-image')
      await writeFile(join(dir, 'wall-10.webp'), 'fake-image-10')

      const items = await listWallpapersInFolder(dir)
      expect(items.map((item) => item.filename)).toEqual(['wall-1.png', 'wall-2.jpg', 'wall-10.webp'])
      expect(items[0]?.size).toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('scans direct subfolders when the root folder has no direct images', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nd-wp-sub-'))
    try {
      const sub = join(dir, 'Wallpapers_4K')
      await mkdir(sub)
      await writeFile(join(sub, '01_nature.jpg'), 'fake-1')
      await writeFile(join(sub, '02_mountain.png'), 'fake-2')
      const items = await listWallpapersInFolder(dir)
      expect(items.map((i) => i.filename)).toEqual(['01_nature.jpg', '02_mountain.png'])
      expect(items[0]?.path).toBe(join(sub, '01_nature.jpg'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('normalizes quoted and messy folder paths correctly', async () => {
    expect(normalizeWallpaperPath('"C:\\Users\\Pictures"')).toBe('C:\\Users\\Pictures')
    expect(normalizeWallpaperPath("'C:\\Users\\Pictures'")).toBe('C:\\Users\\Pictures')
    expect(normalizeWallpaperPath('  "D:\\wallpapers"  ')).toBe('D:\\wallpapers')
    expect(normalizeWallpaperPath(undefined)).toBe('')

    const dir = await mkdtemp(join(tmpdir(), 'nd-wp-quoted-'))
    try {
      await writeFile(join(dir, 'photo.jpg'), 'fake')
      const items = await listWallpapersInFolder(`"${dir}"`)
      expect(items).toHaveLength(1)
      expect(items[0]?.filename).toBe('photo.jpg')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('manages wallpaper active state safely', () => {
    setActiveWallpaperState('/tmp/test-wallpaper.png', '/tmp')
    expect(getActiveWallpaperState()).toEqual({
      path: '/tmp/test-wallpaper.png',
      folder: '/tmp',
    })
  })
})
