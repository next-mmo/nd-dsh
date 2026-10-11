import { relative, sep } from 'node:path'

import type { CoreMedia } from '../core/core-media.js'
import { CORE_MEDIA_MAX_THUMBNAILS_PER_BATCH } from '../core/core-media.js'

export interface ThumbnailSource {
  /** Absolute path to the image on disk. */
  path: string
  size: number
  modifiedAt: number
}

export interface CachedThumbnail {
  path: string
  dataUrl: string
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
}

/**
 * How many thumbnails stay resident. A 4K library renders one screenful at a
 * time, so this is generous for a single folder while still bounding memory for
 * a user who browses many of them.
 */
const DEFAULT_MAX_ENTRIES = 600

function cacheKey(source: ThumbnailSource, width: number): string {
  // Size and mtime make the key self-invalidating: editing or replacing a file
  // at the same path produces a different key rather than a stale thumbnail.
  // Width is part of it because the same source is cached at grid and at
  // preview size, and those must not be confused for one another.
  return `${source.path}\u0000${source.size}\u0000${Math.floor(source.modifiedAt)}\u0000${width}`
}

/** The sidecar addresses images relative to a root; it never accepts absolute paths. */
function toRootRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

/**
 * In-memory thumbnail cache in front of nd-core's `media.thumbnails`.
 *
 * Decoding belongs in the sidecar because doing it in the desktop main process
 * froze every window in the app — a 4K library cost seconds of blocked UI per
 * view open. This layer adds the part the sidecar cannot know: that the same
 * image was already decoded a moment ago, so reopening a view costs nothing.
 */
export class WallpaperThumbnailCache {
  private readonly entries = new Map<string, CachedThumbnail>()
  private readonly maxEntries: number

  constructor(
    private readonly media: Pick<CoreMedia, 'renderThumbnails'>,
    maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {
    this.maxEntries = maxEntries
  }

  /**
   * Resolve thumbnails for the given sources, decoding only the misses.
   *
   * A source the sidecar cannot read is omitted from the result rather than
   * failing the batch, so one corrupt file cannot blank the whole grid.
   */
  async get(
    root: string,
    sources: readonly ThumbnailSource[],
    width: number,
  ): Promise<Map<string, CachedThumbnail>> {
    const resolved = new Map<string, CachedThumbnail>()
    const misses: ThumbnailSource[] = []
    for (const source of sources) {
      const key = cacheKey(source, width)
      const hit = this.entries.get(key)
      if (hit) {
        // Re-insert so the entry counts as recently used.
        this.entries.delete(key)
        this.entries.set(key, hit)
        resolved.set(source.path, hit)
        continue
      }
      misses.push(source)
    }
    if (misses.length === 0) return resolved

    for (let start = 0; start < misses.length; start += CORE_MEDIA_MAX_THUMBNAILS_PER_BATCH) {
      const batch = misses.slice(start, start + CORE_MEDIA_MAX_THUMBNAILS_PER_BATCH)
      const byRelative = new Map(batch.map((source) => [toRootRelative(root, source.path), source]))
      const result = await this.media.renderThumbnails(root, [...byRelative.keys()], width)
      for (const thumbnail of result.thumbnails) {
        const source = byRelative.get(thumbnail.path)
        if (!source) continue
        const entry: CachedThumbnail = {
          path: source.path,
          dataUrl: `data:image/${thumbnail.format};base64,${thumbnail.data}`,
          width: thumbnail.width,
          height: thumbnail.height,
          sourceWidth: thumbnail.sourceWidth,
          sourceHeight: thumbnail.sourceHeight,
        }
        this.remember(cacheKey(source, width), entry)
        resolved.set(source.path, entry)
      }
    }
    return resolved
  }

  private remember(key: string, entry: CachedThumbnail): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  /** Number of resident thumbnails; exposed for diagnostics and tests. */
  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}
