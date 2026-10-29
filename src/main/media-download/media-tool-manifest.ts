import type { MediaToolId } from '../../shared/youtube-download.js'

/**
 * Reviewed media-tool artifacts. Bump the version, URL, byte counts, and both
 * digests together; never resolve "latest" at runtime.
 *
 * The archive digest is checked before anything is extracted. The executable
 * digest is checked after extraction and again before every download, so a
 * swapped or corrupted tool cannot run.
 */
export interface PinnedMediaTool {
  id: MediaToolId
  name: string
  version: string
  url: string
  /** Download bytes of the release artifact. */
  bytes: number
  /** SHA-256 of the release artifact, lowercase hex. */
  sha256: string
  license: string
  archive: 'exe' | 'zip'
  exeName: string
  exeBytes: number
  exeSha256: string
}

export const MEDIA_TOOL_MANIFEST: readonly PinnedMediaTool[] = [
  {
    id: 'yt-dlp',
    name: 'yt-dlp',
    version: '2026.10.21',
    url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.21/yt-dlp.exe',
    bytes: 17_880_111,
    sha256: '33121d192d706e62f684a06f80918e3f3a8ba52ac3a65213b6951c39c7d9f555',
    license: 'Unlicense',
    archive: 'exe',
    exeName: 'yt-dlp.exe',
    exeBytes: 17_880_111,
    exeSha256: '33121d192d706e62f684a06f80918e3f3a8ba52ac3a65213b6951c39c7d9f555',
  },
  {
    id: 'deno',
    name: 'Deno',
    version: '2.9.8',
    url: 'https://github.com/denoland/deno/releases/download/v2.9.8/deno-x86_64-pc-windows-msvc.zip',
    bytes: 42_917_472,
    sha256: 'cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf',
    license: 'MIT',
    archive: 'zip',
    exeName: 'deno.exe',
    exeBytes: 98_081_568,
    exeSha256: '924397800533d3eb0ed0c889b20ad70e18b970d93acd8135bc043f425e528266',
  },
]

export const MEDIA_DOWNLOAD_SETUP_BYTES = MEDIA_TOOL_MANIFEST.reduce((total, tool) => total + tool.bytes, 0)

/** The pinned executables are Windows x64 builds; other platforms fail closed. */
export const MEDIA_DOWNLOAD_PLATFORM = 'win32'

export const MEDIA_DOWNLOAD_ROOT_NAME = 'media-downloader'
