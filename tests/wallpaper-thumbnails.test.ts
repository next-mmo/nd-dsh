import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { CORE_MEDIA_MAX_THUMBNAILS_PER_BATCH } from '../src/main/core/core-media.js'
import type { CoreMedia, CoreMediaThumbnailsResult } from '../src/main/core/core-media.js'
import { WallpaperThumbnailCache, type ThumbnailSource } from '../src/main/os/wallpaper-thumbnails.js'

const ROOT = join(tmpdir(), 'nd-wallpaper-library')

interface FakeCall {
  root: string
  paths: string[]
  width: number | undefined
}

/**
 * Stands in for the sidecar. Records every batch so the tests can assert what
 * was actually requested rather than only what came back.
 */
function fakeMedia(options: { failRelative?: string[] } = {}): {
  renderThumbnails: CoreMedia['renderThumbnails']
  calls: FakeCall[]
} {
  const calls: FakeCall[] = []
  const failRelative = new Set(options.failRelative ?? [])
  const renderThumbnails = vi.fn(
    async (root: string, paths: readonly string[], width?: number): Promise<CoreMediaThumbnailsResult> => {
      calls.push({ root, paths: [...paths], width })
      return {
        thumbnails: paths
          .filter((path) => !failRelative.has(path))
          .map((path) => ({
            path,
            data: `jpeg-bytes-for-${path}`,
            format: 'jpeg',
            width: width ?? 240,
            height: Math.round((width ?? 240) / 2),
            sourceWidth: 3840,
            sourceHeight: 2160,
            byteSize: 24,
          })),
        failures: paths
          .filter((path) => failRelative.has(path))
          .map((path) => ({ path, reason: 'undecodable image' })),
        truncated: false,
        maxRequests: CORE_MEDIA_MAX_THUMBNAILS_PER_BATCH,
      }
    },
  )
  return { renderThumbnails: renderThumbnails as unknown as CoreMedia['renderThumbnails'], calls }
}

function sources(count: number, overrides: Partial<ThumbnailSource> = {}): ThumbnailSource[] {
  return Array.from({ length: count }, (_, index) => ({
    path: join(ROOT, `wallpaper-${index}.png`),
    size: 1000 + index,
    modifiedAt: 1_700_000_000_000,
    ...overrides,
  }))
}

describe('wallpaper thumbnail cache', () => {
  it('asks the sidecar for root-relative paths and returns them keyed by absolute path', async () => {
    const { renderThumbnails, calls } = fakeMedia()
    const cache = new WallpaperThumbnailCache({ renderThumbnails })
    const [first] = sources(1)

    const result = await cache.get(ROOT, [first!], 240)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.root).toBe(ROOT)
    expect(calls[0]!.paths).toEqual(['wallpaper-0.png'])
    expect(calls[0]!.width).toBe(240)
    expect(result.get(first!.path)?.dataUrl).toBe('data:image/jpeg;base64,jpeg-bytes-for-wallpaper-0.png')
    expect(result.get(first!.path)?.sourceWidth).toBe(3840)
  })

  it('serves a repeat request from cache without touching the sidecar', async () => {
    const { renderThumbnails } = fakeMedia()
    const cache = new WallpaperThumbnailCache({ renderThumbnails })
    const entries = sources(3)

    await cache.get(ROOT, entries, 240)
    const second = await cache.get(ROOT, entries, 240)

    expect(renderThumbnails).toHaveBeenCalledTimes(1)
    expect(second.size).toBe(3)
    expect(cache.size).toBe(3)
  })

  it('keeps grid and preview widths separate instead of colliding on one key', async () => {
    const { renderThumbnails, calls } = fakeMedia()
    const cache = new WallpaperThumbnailCache({ renderThumbnails })
    const [only] = sources(1)

    const grid = await cache.get(ROOT, [only!], 240)
    const preview = await cache.get(ROOT, [only!], 1920)

    expect(renderThumbnails).toHaveBeenCalledTimes(2)
    expect(calls.map((call) => call.width)).toEqual([240, 1920])
    expect(grid.get(only!.path)?.width).toBe(240)
    expect(preview.get(only!.path)?.width).toBe(1920)
  })

  it('invalidates when the file changes underneath the same path', async () => {
    const { renderThumbnails } = fakeMedia()
    const cache = new WallpaperThumbnailCache({ renderThumbnails })
    const [original] = sources(1)

    await cache.get(ROOT, [original!], 240)
    await cache.get(ROOT, [{ ...original!, modifiedAt: original!.modifiedAt + 1 }], 240)
    await cache.get(ROOT, [{ ...original!, size: original!.size + 1 }], 240)

    expect(renderThumbnails).toHaveBeenCalledTimes(3)
  })

  it('chunks a large request to respect the sidecar batch bound', async () => {
    const { renderThumbnails, calls } = fakeMedia()
    const cache = new WallpaperThumbnailCache({ renderThumbnails })
    const entries = sources(CORE_MEDIA_MAX_THUMBNAILS_PER_BATCH + 6)

    const result = await cache.get(ROOT, entries, 240)

    expect(calls).toHaveLength(2)
    expect(calls[0]!.paths).toHaveLength(CORE_MEDIA_MAX_THUMBNAILS_PER_BATCH)
    expect(calls[1]!.paths).toHaveLength(6)
    expect(result.size).toBe(entries.length)
  })

  it('omits a file the sidecar could not read without failing the batch', async () => {
    const { renderThumbnails } = fakeMedia({ failRelative: ['wallpaper-1.png'] })
    const cache = new WallpaperThumbnailCache({ renderThumbnails })
    const entries = sources(3)

    const result = await cache.get(ROOT, entries, 240)

    expect(result.size).toBe(2)
    expect(result.has(entries[0]!.path)).toBe(true)
    expect(result.has(entries[1]!.path)).toBe(false)
    expect(result.has(entries[2]!.path)).toBe(true)
    // A failure must not be cached, so a retry asks again.
    await cache.get(ROOT, [entries[1]!], 240)
    expect(renderThumbnails).toHaveBeenCalledTimes(2)
  })

  it('requests nothing at all for an empty batch', async () => {
    const { renderThumbnails } = fakeMedia()
    const cache = new WallpaperThumbnailCache({ renderThumbnails })

    const result = await cache.get(ROOT, [], 240)

    expect(result.size).toBe(0)
    expect(renderThumbnails).not.toHaveBeenCalled()
  })

  it('evicts the oldest entries once the resident bound is passed', async () => {
    const { renderThumbnails } = fakeMedia()
    const cache = new WallpaperThumbnailCache({ renderThumbnails }, 2)

    await cache.get(ROOT, sources(3), 240)

    expect(cache.size).toBe(2)
  })

  it('clears every resident thumbnail on demand', async () => {
    const { renderThumbnails } = fakeMedia()
    const cache = new WallpaperThumbnailCache({ renderThumbnails })
    await cache.get(ROOT, sources(2), 240)

    cache.clear()

    expect(cache.size).toBe(0)
    await cache.get(ROOT, sources(2), 240)
    expect(renderThumbnails).toHaveBeenCalledTimes(2)
  })
})
