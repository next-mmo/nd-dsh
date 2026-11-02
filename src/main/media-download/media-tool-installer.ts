import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { unzipSync } from 'fflate'
import type {
  MediaDownloadSetupView,
  MediaToolView,
} from '../../shared/youtube-download.js'
import {
  MEDIA_DOWNLOAD_PLATFORM,
  MEDIA_DOWNLOAD_ROOT_NAME,
  MEDIA_TOOL_MANIFEST,
  type PinnedMediaTool,
} from './media-tool-manifest.js'

const DOWNLOAD_TIMEOUT_MS = 180_000
const MAX_ARCHIVE_ENTRIES = 1_000
const MAX_EXE_BYTES = 256 * 1024 * 1024
const PROGRESS_THROTTLE_MS = 250

export interface MediaToolFetchResponse {
  ok: boolean
  status: number
  /** Final URL after redirects; checked against the GitHub asset hosts. */
  url: string
  body: ReadableStream<Uint8Array> | null
}

export type MediaToolFetch = (
  url: string,
  init: { redirect: 'follow'; signal: AbortSignal },
) => Promise<MediaToolFetchResponse>

export interface ResolvedMediaTools {
  ytDlpPath: string
  denoPath: string
  denoDir: string
  cacheDir: string
}

export interface MediaToolInstallerOptions {
  rootDir: string
  platform?: NodeJS.Platform
  fetch?: MediaToolFetch
  manifest?: readonly PinnedMediaTool[]
  now?: () => number
  downloadTimeoutMs?: number
}

type ProgressListener = (view: MediaDownloadSetupView) => void

/**
 * Acquire and verify the pinned downloader tools.
 *
 * Nothing here executes a downloaded binary: setup only downloads, hashes,
 * extracts, and atomically installs. The first execution is a user-started
 * download, which is the explicit trust moment.
 */
export class MediaToolInstaller {
  private readonly platform: NodeJS.Platform
  private readonly manifest: readonly PinnedMediaTool[]
  private readonly fetcher: MediaToolFetch
  private readonly now: () => number
  private readonly downloadTimeoutMs: number
  private readonly rootDir: string
  private state: MediaDownloadSetupView
  private setup: Promise<MediaDownloadSetupView> | undefined
  private controller: AbortController | undefined
  private disposed = false
  private lastReportAt = 0

  constructor(options: MediaToolInstallerOptions) {
    this.rootDir = options.rootDir
    this.platform = options.platform ?? process.platform
    this.manifest = options.manifest ?? MEDIA_TOOL_MANIFEST
    this.fetcher = options.fetch ?? (globalThis.fetch as unknown as MediaToolFetch)
    this.now = options.now ?? Date.now
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS
    this.state = {
      state: this.platform === MEDIA_DOWNLOAD_PLATFORM ? 'missing' : 'unsupported',
      progress: 0,
      message: this.platform === MEDIA_DOWNLOAD_PLATFORM
        ? 'Downloader setup is required.'
        : 'The media downloader supports Windows only.',
      error: null,
      tools: this.manifest.map((tool) => toolView(tool, false)),
    }
  }

  view(): MediaDownloadSetupView {
    return structuredClone(this.state)
  }

  /** A pre-run verification failure must make the setup card actionable again. */
  invalidate(message: string): MediaDownloadSetupView {
    this.state = {
      state: 'failed',
      progress: 0,
      message: 'Downloader setup failed.',
      error: message,
      tools: this.manifest.map((tool) => toolView(tool, false)),
    }
    return this.view()
  }

  /** Cheap readiness check used when the service starts and the view opens. */
  async inspect(): Promise<MediaDownloadSetupView> {
    if (this.platform !== MEDIA_DOWNLOAD_PLATFORM || this.setup) return this.view()
    const installed = await Promise.all(this.manifest.map((tool) => exeMatches(tool, this.exePath(tool), false)))
    const ready = installed.every(Boolean)
    this.state = {
      state: ready ? 'ready' : this.state.state === 'failed' ? 'failed' : 'missing',
      progress: ready ? 100 : 0,
      message: ready ? 'Downloader tools are ready.' : this.state.state === 'failed'
        ? this.state.message
        : 'Downloader setup is required. About 61 MB from official GitHub releases.',
      error: ready ? null : this.state.error,
      tools: this.manifest.map((tool, index) => toolView(tool, installed[index] === true)),
    }
    return this.view()
  }

  /**
   * Download and install every missing tool. Concurrent callers share one run;
   * the UI polls `view()` for state and progress.
   */
  prepare(listener?: ProgressListener, externalSignal?: AbortSignal): Promise<MediaDownloadSetupView> {
    if (this.setup) return this.setup
    if (this.platform !== MEDIA_DOWNLOAD_PLATFORM) return Promise.resolve(this.view())
    if (this.disposed) return Promise.reject(new Error('The media downloader is shutting down.'))

    const controller = new AbortController()
    this.controller = controller
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason)
      else externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), { once: true })
    }
    this.setup = this.runSetup(controller.signal, listener).finally(() => {
      this.setup = undefined
      this.controller = undefined
    })
    return this.setup
  }

  /**
   * Re-hash both executables before every download. No "trusted once per
   * session" cache: a replaced tool name is not enough to run.
   */
  async verifyForRun(): Promise<ResolvedMediaTools> {
    if (this.platform !== MEDIA_DOWNLOAD_PLATFORM) {
      throw new Error('The media downloader supports Windows only.')
    }
    const byId = new Map(this.manifest.map((tool) => [tool.id, tool]))
    const ytDlp = byId.get('yt-dlp')
    const deno = byId.get('deno')
    if (!ytDlp || !deno) throw new Error('The media tool manifest is incomplete.')
    const ytDlpPath = this.exePath(ytDlp)
    const denoPath = this.exePath(deno)
    if (!(await exeMatches(ytDlp, ytDlpPath, true))) {
      throw new Error('yt-dlp is missing or failed verification. Run setup again.')
    }
    if (!(await exeMatches(deno, denoPath, true))) {
      throw new Error('Deno is missing or failed verification. Run setup again.')
    }
    return {
      ytDlpPath,
      denoPath,
      denoDir: join(this.rootDir, 'deno', deno.version),
      cacheDir: join(this.rootDir, 'cache'),
    }
  }

  dispose(): void {
    this.disposed = true
    this.controller?.abort(new Error('The media downloader is shutting down.'))
  }

  private async runSetup(signal: AbortSignal, listener?: ProgressListener): Promise<MediaDownloadSetupView> {
    try {
      // Setup/retry hashes existing executables, so a same-size corrupted file
      // is reinstalled instead of being trusted.
      const installed = await Promise.all(this.manifest.map((tool) => exeMatches(tool, this.exePath(tool), true)))
      if (installed.every(Boolean)) {
        this.state = {
          state: 'ready',
          progress: 100,
          message: 'Downloader tools are ready.',
          error: null,
          tools: this.manifest.map((tool, index) => toolView(tool, installed[index] === true)),
        }
        listener?.(this.view())
        return this.view()
      }

      this.report({
        state: 'downloading',
        progress: 2,
        message: 'Preparing the downloader tools…',
        error: null,
      }, true, listener)

      for (let index = 0; index < this.manifest.length; index += 1) {
        const tool = this.manifest[index]!
        if (installed[index]) continue
        const start = index === 0 ? 5 : 45
        const span = index === 0 ? 40 : 45
        await this.installTool(tool, signal, (fraction) => {
          this.report({
            state: 'downloading',
            progress: Math.min(95, Math.round(start + span * fraction)),
            message: `Downloading ${tool.name} ${tool.version}…`,
            error: null,
          }, false, listener)
        }, listener)
        this.state = {
          ...this.state,
          tools: this.state.tools.map((view) => view.id === tool.id ? { ...view, installed: true } : view),
        }
      }

      this.report({
        state: 'ready',
        progress: 100,
        message: 'Downloader tools are ready.',
        error: null,
      }, true, listener)
      return this.view()
    } catch (error) {
      // Only the service's own signal means cancellation. A fetch timeout also
      // surfaces as an AbortError; it is a retryable setup failure, not a cancel.
      if (signal.aborted) {
        this.state = {
          ...this.state,
          state: 'missing',
          progress: 0,
          message: 'Downloader setup was canceled. Try again when ready.',
          error: null,
        }
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      this.state = {
        ...this.state,
        state: 'failed',
        message: 'Downloader setup failed.',
        error: message,
      }
      throw error
    }
  }

  private async installTool(
    tool: PinnedMediaTool,
    signal: AbortSignal,
    onProgress: (fraction: number) => void,
    listener?: ProgressListener,
  ): Promise<void> {
    assertPinnedUrl(tool.url)
    const versionDir = join(this.rootDir, tool.id, tool.version)
    const tempDir = join(this.rootDir, '.tmp')
    await fs.mkdir(versionDir, { recursive: true })
    await fs.mkdir(tempDir, { recursive: true })

    const archivePath = join(tempDir, `${tool.id}-${randomUUID()}.download`)
    const extractedPath = join(tempDir, `${tool.id}-${randomUUID()}.exe`)
    try {
      await this.download(tool, archivePath, signal, onProgress)

      let executablePath = archivePath
      if (tool.archive === 'zip') {
        this.report({
          state: 'extracting',
          progress: Math.max(this.state.progress, 88),
          message: `Extracting ${tool.name}…`,
          error: null,
        }, true, listener)
        await extractPinnedExecutable(tool, archivePath, extractedPath)
        executablePath = extractedPath
      }

      if (!(await fileMatches(tool, executablePath))) {
        throw new Error(`${tool.name} failed its executable verification; nothing was installed.`)
      }

      const finalPath = this.exePath(tool)
      // A stale file with the wrong bytes must not block the rename on Windows.
      await fs.rm(finalPath, { force: true })
      await fs.rename(executablePath, finalPath)
      if (this.platform !== 'win32') await fs.chmod(finalPath, 0o755)
    } finally {
      await fs.rm(archivePath, { force: true }).catch(() => undefined)
      await fs.rm(extractedPath, { force: true }).catch(() => undefined)
      await fs.rmdir(tempDir).catch(() => undefined)
    }
  }

  private async download(
    tool: PinnedMediaTool,
    targetPath: string,
    signal: AbortSignal,
    onProgress: (fraction: number) => void,
  ): Promise<void> {
    const timeout = timeoutSignal(signal, this.downloadTimeoutMs)
    let received = 0
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      const response = await this.fetcher(tool.url, { redirect: 'follow', signal: timeout.signal })
      if (!response.ok) throw new Error(`${tool.name} download failed with HTTP ${String(response.status)}.`)
      assertFinalAssetUrl(response.url)
      if (!response.body) throw new Error(`${tool.name} download returned no content.`)

      const hash = createHash('sha256')
      handle = await fs.open(targetPath, 'wx')
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        received += value.byteLength
        if (received > tool.bytes) throw new Error(`${tool.name} download exceeded its pinned size; discarded.`)
        hash.update(value)
        await writeAll(handle, value)
        onProgress(Math.min(1, received / tool.bytes))
      }
      await handle.sync()
      await handle.close()
      handle = undefined

      const digest = hash.digest('hex')
      if (received !== tool.bytes || digest.toLowerCase() !== tool.sha256.toLowerCase()) {
        throw new Error(`${tool.name} failed integrity verification; the download was discarded.`)
      }
      this.report({
        state: tool.archive === 'zip' ? 'extracting' : 'verifying',
        progress: Math.max(this.state.progress, tool.archive === 'zip' ? 86 : 42),
        message: `Verifying ${tool.name}…`,
        error: null,
      }, true)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await fs.rm(targetPath, { force: true }).catch(() => undefined)
      throw error
    } finally {
      timeout.cancel()
    }
  }

  private report(
    patch: Pick<MediaDownloadSetupView, 'state' | 'progress' | 'message' | 'error'>,
    force: boolean,
    listener?: ProgressListener,
  ): void {
    const at = this.now()
    if (!force && at - this.lastReportAt < PROGRESS_THROTTLE_MS) return
    this.lastReportAt = at
    this.state = { ...this.state, ...patch }
    listener?.(this.view())
  }

  private exePath(tool: PinnedMediaTool): string {
    return join(this.rootDir, tool.id, tool.version, tool.exeName)
  }
}

export function mediaToolRoot(userDataDir: string): string {
  return join(userDataDir, 'runtimes', MEDIA_DOWNLOAD_ROOT_NAME)
}

function toolView(tool: PinnedMediaTool, installed: boolean): MediaToolView {
  return {
    id: tool.id,
    name: tool.name,
    version: tool.version,
    sourceUrl: tool.url,
    license: tool.license,
    bytes: tool.bytes,
    sha256: tool.sha256,
    installed,
  }
}

function assertPinnedUrl(raw: string): void {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('The pinned tool URL is invalid.')
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) {
    throw new Error('The pinned tool URL is not an approved GitHub HTTPS release.')
  }
}

function assertFinalAssetUrl(raw: string): void {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('The tool download returned an invalid final URL.')
  }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || (host !== 'github.com' && !host.endsWith('.githubusercontent.com'))) {
    throw new Error('The tool download redirected outside GitHub; the download was discarded.')
  }
}

async function writeAll(handle: Awaited<ReturnType<typeof fs.open>>, data: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < data.byteLength) {
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset)
    if (bytesWritten <= 0) throw new Error('The download could not be written to disk.')
    offset += bytesWritten
  }
}

async function extractPinnedExecutable(tool: PinnedMediaTool, archivePath: string, targetPath: string): Promise<void> {
  const archive = await fs.readFile(archivePath)
  let entries = 0
  let found = false
  const extracted = unzipSync(archive, {
    filter(file) {
      entries += 1
      if (entries > MAX_ARCHIVE_ENTRIES) throw new Error(`${tool.name} archive contains too many entries.`)
      if (file.name !== tool.exeName) return false
      if (found) throw new Error(`${tool.name} archive contains duplicate executables.`)
      found = true
      if (Number(file.originalSize) > MAX_EXE_BYTES) {
        throw new Error(`${tool.name} archive entry is unreasonably large.`)
      }
      return true
    },
  })
  const bytes = extracted[tool.exeName]
  if (!bytes) throw new Error(`${tool.name} archive did not contain ${tool.exeName}; update the pinned manifest.`)
  await fs.writeFile(targetPath, bytes, { flag: 'wx' })
  const handle = await fs.open(targetPath, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function exeMatches(tool: PinnedMediaTool, path: string, hash: boolean): Promise<boolean> {
  try {
    const info = await fs.stat(path)
    if (!info.isFile() || info.size !== tool.exeBytes) return false
    if (!hash) return true
    return (await sha256File(path)) === tool.exeSha256.toLowerCase()
  } catch {
    return false
  }
}

async function fileMatches(tool: PinnedMediaTool, path: string): Promise<boolean> {
  return exeMatches(tool, path, true)
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer)
  return digest.digest('hex')
}

function timeoutSignal(signal: AbortSignal, timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(signal.reason)
  if (signal.aborted) controller.abort(signal.reason)
  else signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('Tool download timed out.')), timeoutMs)
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    },
  }
}

