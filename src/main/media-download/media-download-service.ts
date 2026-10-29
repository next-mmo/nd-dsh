import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import {
  canonicalYouTubeUrl,
  type MediaDownloadJobView,
  type MediaDownloadMode,
  type MediaDownloadSetupView,
  type MediaDownloadStatusView,
  type YouTubeVideoRef,
} from '../../shared/youtube-download.js'
import type { ResolvedMediaTools } from './media-tool-installer.js'
import { isPathInside, moveMediaIntoDownloads, type MediaFileExtension } from './download-files.js'
import { parseYtDlpProgress, ProgressLineBuffer } from './yt-dlp-progress.js'

const MAX_RECENT_JOBS = 20
const STALL_TIMEOUT_MS = 3 * 60 * 1000
const TOTAL_TIMEOUT_MS = 2 * 60 * 60 * 1000
const STALL_CHECK_INTERVAL_MS = 15_000
const CANCEL_GRACE_MS = 6_000
const STDERR_TAIL_CHARS = 16_384
const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024
const MAX_AUDIO_BYTES = 512 * 1024 * 1024
const VIDEO_FORMAT = 'best[ext=mp4][height<=720][vcodec!=none][acodec^=mp4a]'
const AUDIO_FORMAT = 'bestaudio[ext=m4a]'
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const

export type MediaSpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

export interface MediaToolProvider {
  view(): MediaDownloadSetupView
  inspect(): Promise<MediaDownloadSetupView>
  prepare(listener?: (view: MediaDownloadSetupView) => void, signal?: AbortSignal): Promise<MediaDownloadSetupView>
  verifyForRun(): Promise<ResolvedMediaTools>
  invalidate?(message: string): MediaDownloadSetupView
  dispose(): void
}

export interface MediaDownloadServiceOptions {
  userDataDir: string
  downloadsDir: string
  tools: MediaToolProvider
  spawnProcess: MediaSpawnProcess
  stopProcess?: (child: ChildProcess, timeoutMs?: number) => Promise<void>
  revealFile?: (path: string) => void
  now?: () => number
  newJobId?: () => string
  maxVideoBytes?: number
  maxAudioBytes?: number
}

interface JobRecord {
  view: MediaDownloadJobView
  extensionId: string
  expectedExtension: MediaFileExtension
  stagingDir: string
  child?: ChildProcess
  cancelRequested: boolean
  settled: boolean
  dropAfterClose: boolean
  lastOutputAt: number
  stallTimer?: NodeJS.Timeout
  totalTimer?: NodeJS.Timeout
}

/**
 * The one native downloader capability behind the YouTube extension hosts.
 *
 * Authorization stays in the invocation broker; this service still validates
 * its own inputs, uses one fixed argv, writes only inside a per-job staging
 * directory, and moves exactly one verified file into Downloads.
 */
export class MediaDownloadService {
  private readonly jobs = new Map<string, JobRecord>()
  private readonly userDataDir: string
  private readonly downloadsDir: string
  private readonly tools: MediaToolProvider
  private readonly spawnProcess: MediaSpawnProcess
  private readonly stopProcess: MediaDownloadServiceOptions['stopProcess']
  private readonly revealFile: MediaDownloadServiceOptions['revealFile']
  private readonly now: () => number
  private readonly newJobId: () => string
  private readonly maxVideoBytes: number
  private readonly maxAudioBytes: number
  private activeJobId: string | null = null
  private starting = false
  private disposed = false

  constructor(options: MediaDownloadServiceOptions) {
    this.userDataDir = options.userDataDir
    this.downloadsDir = options.downloadsDir
    this.tools = options.tools
    this.spawnProcess = options.spawnProcess
    this.stopProcess = options.stopProcess
    this.revealFile = options.revealFile
    this.now = options.now ?? Date.now
    this.newJobId = options.newJobId ?? randomUUID
    this.maxVideoBytes = options.maxVideoBytes ?? MAX_VIDEO_BYTES
    this.maxAudioBytes = options.maxAudioBytes ?? MAX_AUDIO_BYTES
    void this.cleanupStaleStaging()
    void this.tools.inspect().catch(() => undefined)
  }

  status(extensionId: string): MediaDownloadStatusView {
    const active = this.activeJobId ? this.jobs.get(this.activeJobId) : undefined
    return {
      setup: this.tools.view(),
      jobs: [...this.jobs.values()]
        .filter((record) => record.extensionId === extensionId)
        .sort((left, right) => right.view.createdAt - left.view.createdAt)
        .slice(0, MAX_RECENT_JOBS)
        .map((record) => structuredClone(record.view)),
      activeJobId: active && active.extensionId === extensionId && !active.settled ? active.view.id : null,
    }
  }

  /** Start tool setup without blocking the bridge call; the view polls status. */
  prepare(extensionId: string): MediaDownloadStatusView {
    if (this.disposed) throw new Error('The media downloader is shutting down.')
    void this.tools.prepare().catch(() => undefined)
    return this.status(extensionId)
  }

  async start(
    extensionId: string,
    input: { url: string; mode: MediaDownloadMode; title?: string },
  ): Promise<MediaDownloadJobView> {
    if (this.disposed) throw new Error('The media downloader is shutting down.')
    const ref = canonicalYouTubeUrl(input.url)
    if (!ref) throw new Error('Enter a YouTube watch, Shorts, or live video URL.')
    if (input.mode !== 'video' && input.mode !== 'audio') throw new Error('Choose video or audio.')

    const active = this.activeJobId ? this.jobs.get(this.activeJobId) : undefined
    if (this.starting || (active && !active.settled)) {
      throw new Error('A download is already running. Wait for it to finish or cancel it.')
    }

    this.starting = true
    try {
      let tools: ResolvedMediaTools
      try {
        tools = await this.tools.verifyForRun()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.tools.invalidate?.(message)
        throw new Error(message)
      }

      const record = this.createJob(extensionId, ref, input.mode, input.title)
      await this.launch(record, tools)
      return structuredClone(record.view)
    } finally {
      this.starting = false
    }
  }

  cancel(extensionId: string, id: string): boolean {
    const record = this.jobs.get(id)
    if (!record || record.extensionId !== extensionId || record.settled) return false
    if (record.view.state !== 'starting' && record.view.state !== 'downloading') return false
    record.cancelRequested = true
    this.killChild(record)
    const timer = setTimeout(() => {
      if (!record.settled) void this.settleCanceled(record)
    }, CANCEL_GRACE_MS)
    timer.unref?.()
    return true
  }

  async reveal(extensionId: string, id: string): Promise<void> {
    const record = this.jobs.get(id)
    if (!record || record.extensionId !== extensionId) throw new Error('Unknown download.')
    if (record.view.state !== 'completed' || !record.view.path) throw new Error('That download is not complete.')
    if (!isPathInside(this.downloadsDir, record.view.path)) {
      throw new Error('Refusing to reveal a file outside the Downloads folder.')
    }
    await access(record.view.path)
    this.revealFile?.(record.view.path)
  }

  /** Activation-off, uninstall, update, and rollback must not leave work running. */
  releaseExtension(extensionId: string): void {
    for (const record of [...this.jobs.values()]) {
      if (record.extensionId !== extensionId) continue
      if (record.settled) {
        this.jobs.delete(record.view.id)
        continue
      }
      record.dropAfterClose = true
      if (record.view.state === 'starting' || record.view.state === 'downloading') {
        record.cancelRequested = true
        this.killChild(record)
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.jobs.values()) {
      this.clearTimers(record)
      if (!record.settled) {
        record.cancelRequested = true
        this.killChild(record)
        record.settled = true
      }
    }
    this.activeJobId = null
    this.tools.dispose()
  }

  private createJob(
    extensionId: string,
    ref: YouTubeVideoRef,
    mode: MediaDownloadMode,
    rawTitle: string | undefined,
  ): JobRecord {
    const id = this.newJobId()
    const title = typeof rawTitle === 'string' && rawTitle.replace(/\s+/g, ' ').trim()
      ? rawTitle.replace(/\s+/g, ' ').trim().slice(0, 300)
      : `YouTube ${ref.videoId}`
    const view: MediaDownloadJobView = {
      id,
      mode,
      state: 'starting',
      url: ref.url,
      videoId: ref.videoId,
      title,
      height: null,
      receivedBytes: 0,
      totalBytes: null,
      speedBps: null,
      etaSeconds: null,
      errorCode: null,
      error: null,
      fileName: null,
      path: null,
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
    }
    const record: JobRecord = {
      view,
      extensionId,
      expectedExtension: mode === 'video' ? 'mp4' : 'm4a',
      stagingDir: join(this.userDataDir, 'media-downloads', 'staging', id),
      cancelRequested: false,
      settled: false,
      dropAfterClose: false,
      lastOutputAt: this.now(),
    }
    this.jobs.set(id, record)
    this.activeJobId = id
    this.pruneRecentJobs()
    return record
  }

  private async launch(record: JobRecord, tools: ResolvedMediaTools): Promise<void> {
    const tempDir = join(record.stagingDir, 'tmp')
    try {
      await mkdir(tempDir, { recursive: true })
      await mkdir(tools.cacheDir, { recursive: true })
      const args = this.argsFor(record, tools)
      const env = this.childEnvironment(record, tools)
      const child = this.spawnProcess(tools.ytDlpPath, args, {
        cwd: record.stagingDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      if (!child.stdout || !child.stderr) throw new Error('The downloader did not expose output streams.')

      record.child = child
      record.view.startedAt = this.now()
      record.lastOutputAt = this.now()
      let stderrTail = ''
      const parser = new ProgressLineBuffer((line) => this.onProgressLine(record, line))
      child.stdout.on('data', (chunk: Buffer | string) => {
        record.lastOutputAt = this.now()
        parser.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer | string) => {
        record.lastOutputAt = this.now()
        stderrTail = `${stderrTail}${chunk.toString()}`.slice(-STDERR_TAIL_CHARS)
      })
      child.once('error', (error) => {
        this.settleFailed(
          record,
          'spawn-failed',
          error instanceof Error ? error.message : 'The downloader could not start.',
        )
      })
      child.once('close', (code) => {
        parser.flush()
        void this.finish(record, code, stderrTail)
      })

      record.stallTimer = setInterval(() => {
        if (record.settled) return
        if (this.now() - record.lastOutputAt > STALL_TIMEOUT_MS) {
          this.settleFailed(record, 'network', 'The download stalled for three minutes. Check the connection and try again.')
        }
      }, STALL_CHECK_INTERVAL_MS)
      record.stallTimer.unref?.()
      record.totalTimer = setTimeout(() => {
        if (!record.settled) this.settleFailed(record, 'timeout', 'The download exceeded the two-hour limit.')
      }, TOTAL_TIMEOUT_MS)
      record.totalTimer.unref?.()
    } catch (error) {
      this.settleFailed(record, 'spawn-failed', error instanceof Error ? error.message : 'The downloader could not start.')
      throw error
    }
  }

  private argsFor(record: JobRecord, tools: ResolvedMediaTools): string[] {
    const mode = record.view.mode
    const maxSize = mode === 'video' ? '4G' : '512M'
    return [
      '--ignore-config',
      '--no-playlist',
      '--no-exec',
      '--no-colors',
      '--newline',
      '--progress',
      '--progress-template',
      'download:NDPROG|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.id)s|%(info.height)s|%(info.ext)s',
      '--js-runtimes',
      'deno',
      '--socket-timeout',
      '20',
      '--retries',
      '3',
      '--fragment-retries',
      '3',
      '--max-filesize',
      maxSize,
      '--windows-filenames',
      '--no-mtime',
      '--no-write-info-json',
      '--no-write-thumbnail',
      '--no-write-subs',
      '--no-write-auto-subs',
      '--no-embed-metadata',
      '--no-embed-thumbnail',
      '--no-embed-subs',
      '--cache-dir',
      tools.cacheDir,
      '--output',
      'media.%(ext)s',
      '--format',
      mode === 'video' ? VIDEO_FORMAT : AUDIO_FORMAT,
      record.view.url,
    ]
  }

  private childEnvironment(record: JobRecord, tools: ResolvedMediaTools): NodeJS.ProcessEnv {
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    const tempDir = join(record.stagingDir, 'tmp')
    const env: NodeJS.ProcessEnv = {
      SystemRoot: systemRoot,
      windir: process.env.windir || systemRoot,
      SystemDrive: process.env.SystemDrive || 'C:',
      TEMP: tempDir,
      TMP: tempDir,
      PATH: [tools.denoDir, join(systemRoot, 'System32'), systemRoot].join(delimiter),
      DENO_DIR: join(this.userDataDir, 'media-downloads', 'deno-cache'),
      DENO_NO_UPDATE_CHECK: '1',
      NO_COLOR: '1',
    }
    for (const key of ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA'] as const) {
      const value = process.env[key]
      if (value) env[key] = value
    }
    for (const key of PROXY_ENV_KEYS) {
      const value = process.env[key]
      if (value) env[key] = value
    }
    return env
  }

  private onProgressLine(record: JobRecord, line: string): void {
    if (record.settled) return
    const update = parseYtDlpProgress(line)
    if (!update) return
    if (update.videoId && update.videoId !== record.view.videoId) {
      this.settleFailed(record, 'video-mismatch', 'The downloader returned a different video; the download was stopped.')
      return
    }
    if (update.extension && update.extension !== record.expectedExtension) {
      this.settleFailed(record, 'format-mismatch', 'The download was not the requested media format; it was stopped.')
      return
    }
    record.view.state = update.status === 'finished' ? 'processing' : 'downloading'
    record.view.receivedBytes = Math.max(record.view.receivedBytes, update.downloadedBytes)
    if (update.totalBytes !== null) record.view.totalBytes = update.totalBytes
    record.view.speedBps = update.speedBps
    record.view.etaSeconds = update.etaSeconds
    if (update.height !== null) record.view.height = update.height
  }

  private async finish(record: JobRecord, code: number | null, stderr: string): Promise<void> {
    if (record.settled) return
    if (record.cancelRequested) {
      await this.settleCanceled(record)
      return
    }
    if (code !== 0) {
      const mapped = mapDownloadError(stderr)
      this.settleFailed(record, mapped.code, mapped.message)
      return
    }
    await this.finalize(record)
  }

  private async finalize(record: JobRecord): Promise<void> {
    try {
      const entries = await readdir(record.stagingDir, { withFileTypes: true })
      if (entries.some((entry) => entry.isFile() && entry.name.endsWith('.part'))) {
        throw new Error('The download left a partial file. Try again.')
      }
      const mediaFiles = entries.filter((entry) => entry.isFile() && entry.name.startsWith('media.'))
      const expectedName = `media.${record.expectedExtension}`
      if (mediaFiles.length !== 1 || mediaFiles[0]?.name !== expectedName) {
        throw new Error('The download did not produce one complete media file. Try again.')
      }

      const source = join(record.stagingDir, expectedName)
      const info = await stat(source)
      const cap = record.view.mode === 'video' ? this.maxVideoBytes : this.maxAudioBytes
      if (!info.isFile() || info.size <= 0) throw new Error('The downloaded file is empty.')
      if (info.size > cap) throw new Error('The downloaded file exceeded the size limit.')

      const moved = await moveMediaIntoDownloads(
        source,
        this.downloadsDir,
        record.view.title,
        record.view.videoId,
        record.expectedExtension,
      )
      record.view.state = 'completed'
      record.view.fileName = moved.fileName
      record.view.path = moved.path
      record.view.finishedAt = this.now()
      record.view.speedBps = null
      record.view.etaSeconds = null
      this.settle(record)
      await rm(record.stagingDir, { recursive: true, force: true }).catch(() => undefined)
      try {
        this.revealFile?.(moved.path)
      } catch {
        // Revealing a completed file is best-effort and must not fail the job.
      }
    } catch (error) {
      const code = errorCode(error) === 'ENOSPC' ? 'disk-full' : 'save-failed'
      this.settleFailed(record, code, error instanceof Error ? error.message : 'The download could not be saved.', true)
    }
  }

  private settle(record: JobRecord): void {
    this.clearTimers(record)
    record.settled = true
    if (this.activeJobId === record.view.id) this.activeJobId = null
    if (record.dropAfterClose) this.jobs.delete(record.view.id)
  }

  private async settleCanceled(record: JobRecord): Promise<void> {
    if (record.settled) return
    record.view.state = 'canceled'
    record.view.finishedAt = this.now()
    record.view.speedBps = null
    record.view.etaSeconds = null
    this.settle(record)
    await rm(record.stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }

  private settleFailed(record: JobRecord, code: string, message: string, keepStaging = false): void {
    if (record.settled) return
    record.view.state = 'failed'
    record.view.errorCode = code
    record.view.error = message
    record.view.finishedAt = this.now()
    record.view.speedBps = null
    record.view.etaSeconds = null
    this.killChild(record)
    this.settle(record)
    if (!keepStaging) void rm(record.stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }

  private killChild(record: JobRecord): void {
    const child = record.child
    if (!child) return
    if (this.stopProcess) {
      void this.stopProcess(child, 5_000).catch(() => undefined)
      return
    }
    try {
      child.kill()
    } catch {
      // The close handler still settles the job.
    }
  }

  private clearTimers(record: JobRecord): void {
    if (record.stallTimer) clearInterval(record.stallTimer)
    if (record.totalTimer) clearTimeout(record.totalTimer)
    delete record.stallTimer
    delete record.totalTimer
  }

  private pruneRecentJobs(): void {
    const settled = [...this.jobs.values()]
      .filter((record) => record.settled)
      .sort((left, right) => right.view.createdAt - left.view.createdAt)
    for (const record of settled.slice(MAX_RECENT_JOBS)) {
      this.jobs.delete(record.view.id)
    }
  }

  private async cleanupStaleStaging(): Promise<void> {
    const stagingRoot = join(this.userDataDir, 'media-downloads', 'staging')
    try {
      const entries = await readdir(stagingRoot, { withFileTypes: true })
      const cutoff = this.now() - 24 * 60 * 60 * 1000
      await Promise.all(entries.map(async (entry) => {
        const path = join(stagingRoot, entry.name)
        const info = await stat(path).catch(() => null)
        if (info && info.mtimeMs < cutoff) {
          await rm(path, { recursive: true, force: true }).catch(() => undefined)
        }
      }))
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') console.warn('Could not clean stale media downloads:', error)
    }
  }
}

function mapDownloadError(stderr: string): { code: string; message: string } {
  const text = stderr.toLowerCase()
  if (/not a bot|sign in to confirm|confirm you.?re not a bot/.test(text)) {
    return {
      code: 'bot-check',
      message: 'YouTube asked for a sign-in or bot check. Open the video in the browser and try again later.',
    }
  }
  if (/age-restricted|inappropriate for some users|age restricted/.test(text)) {
    return { code: 'age-restricted', message: 'This video is age-restricted and cannot be downloaded without a signed-in session.' }
  }
  if (/members-only|join this channel|members only/.test(text)) {
    return { code: 'members-only', message: 'This video is available to channel members only.' }
  }
  if (/sign in|login required|use --cookies|private video/.test(text)) {
    return { code: 'sign-in-required', message: 'This video needs a signed-in YouTube session, which the downloader does not use.' }
  }
  if (/requested format is not available|no video formats found|format is not available/.test(text)) {
    return { code: 'no-format', message: 'No single-file MP4 up to 720p is available for this video. Try Audio.' }
  }
  if (/max-filesize|larger than/.test(text)) {
    return { code: 'too-large', message: 'The download exceeded the size limit and was stopped.' }
  }
  if (/http error 429|too many requests|rate.limit/.test(text)) {
    return { code: 'rate-limited', message: 'YouTube is rate-limiting downloads. Try again later.' }
  }
  if (/javascript runtime|js runtime|deno.*(not found|missing)|no supported runtime/.test(text)) {
    return { code: 'runtime-missing', message: 'The JavaScript runtime is missing. Run downloader setup again.' }
  }
  if (/video unavailable|has been removed|this video is unavailable|not available in your country/.test(text)) {
    return { code: 'unavailable', message: 'This video is unavailable or not available in this region.' }
  }
  if (/unable to download|timed out|connection|network|http error 5\d\d/.test(text)) {
    return { code: 'network', message: 'The download lost its connection. Check the network and try again.' }
  }
  return { code: 'failed', message: 'The download failed. Check that the video plays in the browser and try again.' }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined
}
