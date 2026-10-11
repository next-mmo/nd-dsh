import type { CoreClient } from './core-client.js'

export interface CoreMediaThumbnail {
  /** Root-relative path, matching the request entry it came from. */
  path: string
  /** Base64-encoded JPEG. */
  data: string
  format: string
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
  byteSize: number
}

export interface CoreMediaThumbnailFailure {
  path: string
  reason: string
}

export interface CoreMediaThumbnailsResult {
  thumbnails: CoreMediaThumbnail[]
  failures: CoreMediaThumbnailFailure[]
  truncated: boolean
  maxRequests: number
}

/**
 * The sidecar's own per-batch bound. Asking for more does not error — the batch
 * is clamped and reported through `truncated` — so callers chunk instead.
 */
export const CORE_MEDIA_MAX_THUMBNAILS_PER_BATCH = 64

/**
 * A batch is bounded work in a separate process, so the desktop never blocks on
 * it; the timeout only has to outlast a genuinely large photo library.
 */
const CORE_MEDIA_THUMBNAIL_TIMEOUT_MS = 30_000
const CORE_MEDIA_WALLPAPER_TIMEOUT_MS = 15_000

/**
 * Native image work as nd-core implements it. Decoding and downscaling live in
 * the sidecar because doing them in the desktop main process froze every window
 * in the app, and setting the Windows wallpaper lives there because the previous
 * implementation spawned PowerShell and recompiled an inline C# type per change.
 */
export interface CoreMedia {
  renderThumbnails(
    root: string,
    paths: readonly string[],
    width?: number,
    quality?: number,
  ): Promise<CoreMediaThumbnailsResult>
  setWallpaper(path: string): Promise<void>
}

export function createCoreMedia(core: Pick<CoreClient, 'request'>): CoreMedia {
  return {
    async renderThumbnails(root, paths, width, quality) {
      return await core.request<CoreMediaThumbnailsResult>(
        'media.thumbnails',
        {
          root,
          paths: [...paths],
          ...(width === undefined ? {} : { width }),
          ...(quality === undefined ? {} : { quality }),
        },
        CORE_MEDIA_THUMBNAIL_TIMEOUT_MS,
      )
    },
    async setWallpaper(path) {
      await core.request<{ changed: boolean; path: string; platform: string }>(
        'media.set-wallpaper',
        { path },
        CORE_MEDIA_WALLPAPER_TIMEOUT_MS,
      )
    },
  }
}
