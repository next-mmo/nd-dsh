/**
 * Shared types and URL rules for the YouTube downloader extension.
 *
 * This module stays free of Node and Electron imports so the broker types, the
 * main-process service, and tests can all share one contract.
 */

export type MediaDownloadMode = 'video' | 'audio'

export type MediaDownloadJobState =
  | 'starting'
  | 'downloading'
  | 'processing'
  | 'completed'
  | 'canceled'
  | 'failed'

export type MediaToolId = 'yt-dlp' | 'deno'

export type MediaToolSetupState =
  | 'unsupported'
  | 'missing'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'ready'
  | 'failed'

export interface YouTubeVideoRef {
  /** Canonical watch URL; always starts with https://www.youtube.com/watch?v=. */
  url: string
  videoId: string
}

export interface YouTubePageRef extends YouTubeVideoRef {
  title: string
}

export interface MediaDownloadStartInput {
  url: string
  mode: MediaDownloadMode
  /** Optional page title used for the saved filename; never trusted as a path. */
  title?: string
}

export interface MediaDownloadJobView {
  id: string
  mode: MediaDownloadMode
  state: MediaDownloadJobState
  url: string
  videoId: string
  title: string
  height: number | null
  receivedBytes: number
  totalBytes: number | null
  speedBps: number | null
  etaSeconds: number | null
  errorCode: string | null
  error: string | null
  fileName: string | null
  path: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface MediaToolView {
  id: MediaToolId
  name: string
  version: string
  sourceUrl: string
  license: string
  bytes: number
  sha256: string
  installed: boolean
}

export interface MediaDownloadSetupView {
  state: MediaToolSetupState
  progress: number
  message: string
  error: string | null
  tools: MediaToolView[]
}

export interface MediaDownloadStatusView {
  setup: MediaDownloadSetupView
  jobs: MediaDownloadJobView[]
  activeJobId: string | null
}

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

function pathSegments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean)
}

/**
 * Canonicalize a YouTube video URL, dropping playlist/tracking parameters.
 *
 * Only a single video is accepted. Playlists, channels, embeds, handles, extra
 * path segments, credentials, ports, and non-HTTPS URLs are rejected. The
 * returned URL is built from the validated 11-character id, so no caller text
 * ever reaches the downloader argv.
 */
export function canonicalYouTubeUrl(raw: unknown): YouTubeVideoRef | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || value.length > 2_048 || CONTROL_CHARACTERS.test(value)) return null

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password || parsed.port) return null

  const host = parsed.hostname.toLowerCase()
  if (!YOUTUBE_HOSTS.has(host)) return null

  const segments = pathSegments(parsed.pathname)
  let id: string | null = null
  if (host === 'youtu.be') {
    if (segments.length === 1) id = segments[0] ?? null
  } else if (segments.length === 1 && segments[0] === 'watch') {
    id = parsed.searchParams.get('v')
  } else if (segments.length === 2 && (segments[0] === 'shorts' || segments[0] === 'live')) {
    id = segments[1] ?? null
  }

  if (!id || !YOUTUBE_ID_PATTERN.test(id)) return null
  return { url: `https://www.youtube.com/watch?v=${id}`, videoId: id }
}
