import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isPathInside,
  moveMediaIntoDownloads,
  sanitizeMediaFilename,
} from '../src/main/media-download/download-files.js'

const roots: string[] = []
const ID = 'dQw4w9WgXcQ'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nd-media-files-test-'))
  roots.push(root)
  return root
}

describe('sanitizeMediaFilename', () => {
  it('uses the title and strips the YouTube suffix', () => {
    expect(sanitizeMediaFilename('A nice video - YouTube', ID, 'mp4')).toBe('A nice video.mp4')
    expect(sanitizeMediaFilename('  spaced   title  ', ID, 'm4a')).toBe('spaced title.m4a')
  })

  it('falls back for empty, dot, and traversal titles', () => {
    expect(sanitizeMediaFilename('', ID, 'mp4')).toBe(`YouTube-${ID}.mp4`)
    expect(sanitizeMediaFilename('   ', ID, 'mp4')).toBe(`YouTube-${ID}.mp4`)
    expect(sanitizeMediaFilename('.', ID, 'mp4')).toBe(`YouTube-${ID}.mp4`)
    expect(sanitizeMediaFilename('..', ID, 'mp4')).toBe(`YouTube-${ID}.mp4`)
  })

  it('neutralizes Windows reserved device names, including extensions', () => {
    for (const reserved of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'CON.txt', 'COM1.foo']) {
      expect(sanitizeMediaFilename(reserved, ID, 'mp4')).toBe(`video-${reserved}.mp4`)
    }
  })

  it('removes path separators, illegal characters, controls, and bidi marks', () => {
    const name = sanitizeMediaFilename('a/b\\c:d*e?f"g<h>i|j\u0000\u202e', ID, 'mp4')
    expect(name).toBe('a_b_c_d_e_f_g_h_i_j.mp4')
    expect(name).not.toContain('/')
    expect(name).not.toContain('\\')
  })

  it('trims trailing dots and spaces and caps the stem', () => {
    expect(sanitizeMediaFilename('name...   ', ID, 'mp4')).toBe('name.mp4')
    const long = sanitizeMediaFilename('x'.repeat(300), ID, 'mp4')
    expect(long.endsWith('.mp4')).toBe(true)
    expect(long.length).toBeLessThanOrEqual(124)
  })
})

describe('media downloads directory containment', () => {
  it('accepts direct children of Downloads and rejects anything else', () => {
    const root = 'C:\\Users\\example\\Downloads'
    expect(isPathInside(root, 'C:\\Users\\example\\Downloads\\video.mp4')).toBe(true)
    expect(isPathInside(root, 'C:\\Users\\example\\Downloads\\sub\\video.mp4')).toBe(false)
    expect(isPathInside(root, 'C:\\Users\\example\\Downloads\\..\\escape.mp4')).toBe(false)
  })
})

describe('moveMediaIntoDownloads', () => {
  it('moves the file and never overwrites an existing download', async () => {
    const root = await tempDir()
    const downloads = join(root, 'Downloads')
    const first = join(root, 'first.mp4')
    const second = join(root, 'second.mp4')
    await writeFile(first, 'one')
    await writeFile(second, 'two')

    const movedFirst = await moveMediaIntoDownloads(first, downloads, 'My Video', ID, 'mp4')
    expect(movedFirst.fileName).toBe('My Video.mp4')
    expect(await readFile(movedFirst.path, 'utf8')).toBe('one')

    const movedSecond = await moveMediaIntoDownloads(second, downloads, 'My Video', ID, 'mp4')
    expect(movedSecond.fileName).toBe('My Video (2).mp4')
    expect(await readFile(movedSecond.path, 'utf8')).toBe('two')
  })

  it('uses the fallback name for a traversal title', async () => {
    const root = await tempDir()
    const source = join(root, 'source.m4a')
    await writeFile(source, 'audio')
    const moved = await moveMediaIntoDownloads(source, join(root, 'Downloads'), '..', ID, 'm4a')
    expect(moved.fileName).toBe(`YouTube-${ID}.m4a`)
  })
})
