import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  MediaDownloadSetupView,
  MediaDownloadStatusView,
} from '../src/shared/youtube-download.js'
import type { ResolvedMediaTools } from '../src/main/media-download/media-tool-installer.js'
import {
  MediaDownloadService,
  type MediaSpawnProcess,
  type MediaToolProvider,
} from '../src/main/media-download/media-download-service.js'

const ID = 'dQw4w9WgXcQ'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kill = vi.fn(() => {
    this.killedFlag = true
    queueMicrotask(() => this.emit('close', 1, null))
    return true
  })
  killedFlag = false
}

interface Harness {
  service: MediaDownloadService
  root: string
  downloads: string
  userData: string
  spawns: { command: string; args: string[]; options: SpawnOptions }[]
  child: () => FakeChild
  provider: MediaToolProvider
  reveal: ReturnType<typeof vi.fn>
}

async function harness(overrides: Partial<MediaToolProvider> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'nd-media-service-test-'))
  roots.push(root)
  const userData = join(root, 'userData')
  const downloads = join(root, 'Downloads')
  const setup: MediaDownloadSetupView = {
    state: 'ready',
    progress: 100,
    message: 'Downloader tools are ready.',
    error: null,
    tools: [],
  }
  const tools: ResolvedMediaTools = {
    ytDlpPath: join(root, 'tools', 'yt-dlp.exe'),
    denoPath: join(root, 'tools', 'deno.exe'),
    denoDir: join(root, 'tools', 'deno'),
    cacheDir: join(root, 'cache'),
  }
  const provider: MediaToolProvider = {
    view: () => structuredClone(setup),
    inspect: async () => structuredClone(setup),
    prepare: async () => structuredClone(setup),
    verifyForRun: async () => tools,
    invalidate: (message) => ({ ...structuredClone(setup), state: 'failed' as const, error: message }),
    dispose: () => undefined,
    ...overrides,
  }
  const spawns: Harness['spawns'] = []
  let lastChild: FakeChild | undefined
  const spawnProcess: MediaSpawnProcess = (command, args, options) => {
    lastChild = new FakeChild()
    spawns.push({ command, args: [...args], options })
    return lastChild as unknown as ChildProcess
  }
  const reveal = vi.fn()
  const service = new MediaDownloadService({
    userDataDir: userData,
    downloadsDir: downloads,
    tools: provider,
    spawnProcess,
    revealFile: reveal,
    newJobId: () => 'job-1',
  })
  return {
    service,
    root,
    downloads,
    userData,
    spawns,
    child: () => {
      if (!lastChild) throw new Error('No child spawned yet')
      return lastChild
    },
    provider,
    reveal,
  }
}

async function waitFor(predicate: () => boolean, label = 'condition', timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function waitForMissing(path: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      await stat(path)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${path} to be removed`)
}

function jobStatus(service: MediaDownloadService): MediaDownloadStatusView {
  return service.status('ext')
}

async function completeJob(h: Harness, extension: 'mp4' | 'm4a', bytes = 'media-bytes'): Promise<void> {
  const cwd = String(h.spawns[0]?.options.cwd)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, `media.${extension}`), Buffer.from(bytes))
  h.child().stdout.write(
    `NDPROG|finished|100|100|NA|NA|0|${ID}|720|${extension}\n`,
  )
  await new Promise((resolve) => setTimeout(resolve, 5))
  h.child().emit('close', 0, null)
  await waitFor(() => jobStatus(h.service).jobs[0]?.state === 'completed', 'completed job')
}

describe('MediaDownloadService', () => {
  it('spawns the fixed yt-dlp argv with a minimal environment and canonical URL', async () => {
    const h = await harness()
    const started = await h.service.start('ext', {
      url: `https://youtu.be/${ID}?si=tracking`,
      mode: 'video',
      title: 'Test Video',
    })
    expect(started.state).toBe('starting')

    const spawn = h.spawns[0]
    expect(spawn).toBeDefined()
    expect(spawn?.command).toBe(join(h.root, 'tools', 'yt-dlp.exe'))
    const args = spawn?.args ?? []
    expect(args.at(-1)).toBe(`https://www.youtube.com/watch?v=${ID}`)
    for (const flag of [
      '--ignore-config',
      '--no-playlist',
      '--no-exec',
      '--js-runtimes',
      '--progress-template',
      '--windows-filenames',
      '--cache-dir',
      '--output',
      '--format',
    ]) {
      expect(args).toContain(flag)
    }
    expect(args).not.toContain('--max-downloads')
    expect(args).not.toContain('--ffmpeg-location')
    expect(args).not.toContain('--cookies')
    expect(args).not.toContain('--exec')
    expect(args).toContain('deno')
    expect(args).toContain('best[ext=mp4][height<=720][vcodec!=none][acodec^=mp4a]')
    expect(args[args.indexOf('--output') + 1]).toBe('media.%(ext)s')

    const env = spawn?.options.env ?? {}
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(String(env.PATH)).toContain(join(h.root, 'tools', 'deno'))
    expect(env.TEMP).toBe(join(String(spawn?.options.cwd), 'tmp'))
    expect(env.TMP).toBe(env.TEMP)
    expect(env.DENO_DIR).toBe(join(h.userData, 'media-downloads', 'deno-cache'))
    expect(env.DENO_NO_UPDATE_CHECK).toBe('1')

    await completeJob(h, 'mp4')
    expect(jobStatus(h.service).jobs[0]?.state).toBe('completed')
    expect(jobStatus(h.service).jobs[0]?.path).toBe(join(h.downloads, 'Test Video.mp4'))
    await waitFor(() => h.reveal.mock.calls.length === 1, 'reveal')
    expect(h.reveal).toHaveBeenCalledWith(join(h.downloads, 'Test Video.mp4'))
  })

  it('updates progress from yt-dlp output and saves one verified file', async () => {
    const h = await harness()
    await h.service.start('ext', { url: `https://www.youtube.com/watch?v=${ID}`, mode: 'video', title: 'Progress Video' })
    h.child().stdout.write(`NDPROG|downloading|50|100|NA|100|1|${ID}|720|mp4\n`)
    await waitFor(() => jobStatus(h.service).jobs[0]?.receivedBytes === 50, 'progress')
    const view = jobStatus(h.service).jobs[0]
    expect(view?.totalBytes).toBe(100)
    expect(view?.height).toBe(720)
    expect(view?.speedBps).toBe(100)
    expect(view?.etaSeconds).toBe(1)

    const cwd = String(h.spawns[0]?.options.cwd)
    await writeFile(join(cwd, 'media.mp4'), Buffer.from('bytes'))
    h.child().emit('close', 0, null)
    await waitFor(() => jobStatus(h.service).jobs[0]?.state === 'completed', 'completion')
    expect((await stat(join(h.downloads, 'Progress Video.mp4'))).size).toBeGreaterThan(0)
  })

  it('never overwrites an existing download and supports audio', async () => {
    const h = await harness()
    await mkdir(h.downloads, { recursive: true })
    await writeFile(join(h.downloads, 'Audio Video.m4a'), 'existing')
    await h.service.start('ext', { url: `https://www.youtube.com/shorts/${ID}`, mode: 'audio', title: 'Audio Video' })
    expect(h.spawns[0]?.args).toContain('bestaudio[ext=m4a]')
    await completeJob(h, 'm4a')
    const job = jobStatus(h.service).jobs[0]
    expect(job?.state).toBe('completed')
    expect(job?.fileName).toBe('Audio Video (2).m4a')
  })

  it('rejects a second start while one is running', async () => {
    const h = await harness()
    await h.service.start('ext', { url: `https://youtu.be/${ID}`, mode: 'video' })
    await expect(h.service.start('ext', { url: `https://youtu.be/${ID}`, mode: 'audio' }))
      .rejects.toThrow(/already running/i)
    await completeJob(h, 'mp4')
  })

  it('cancels a job, kills the child, and removes staging', async () => {
    const h = await harness()
    await h.service.start('ext', { url: `https://youtu.be/${ID}`, mode: 'video' })
    const cwd = String(h.spawns[0]?.options.cwd)
    expect(h.service.cancel('ext', 'job-1')).toBe(true)
    await waitFor(() => jobStatus(h.service).jobs[0]?.state === 'canceled', 'canceled job')
    expect(h.child().killedFlag).toBe(true)
    await waitForMissing(cwd)
  })

  it('maps stderr failures to friendly codes and cleans staging', async () => {
    const h = await harness()
    await h.service.start('ext', { url: `https://youtu.be/${ID}`, mode: 'video' })
    h.child().stderr.write('ERROR: Sign in to confirm you’re not a bot\n')
    await new Promise((resolve) => setTimeout(resolve, 5))
    h.child().emit('close', 1, null)
    await waitFor(() => jobStatus(h.service).jobs[0]?.state === 'failed', 'failed job')
    const job = jobStatus(h.service).jobs[0]
    expect(job?.errorCode).toBe('bot-check')
    expect(job?.error).toMatch(/bot check/i)
    await waitForMissing(String(h.spawns[0]?.options.cwd))
  })

  it('stops when yt-dlp reports a different format or video', async () => {
    const h = await harness()
    await h.service.start('ext', { url: `https://youtu.be/${ID}`, mode: 'video' })
    h.child().stdout.write('NDPROG|downloading|5|10|NA|NA|NA|dQw4w9WgXcQ|720|webm\n')
    await waitFor(() => jobStatus(h.service).jobs[0]?.state === 'failed', 'format mismatch')
    expect(jobStatus(h.service).jobs[0]?.errorCode).toBe('format-mismatch')
  })

  it('invalidates setup when tool verification fails', async () => {
    const invalidate = vi.fn((message: string) => ({
      state: 'failed' as const,
      progress: 0,
      message: 'Downloader setup failed.',
      error: message,
      tools: [],
    }))
    const h = await harness({
      verifyForRun: async () => {
        throw new Error('yt-dlp is missing or failed verification. Run setup again.')
      },
      invalidate,
    })
    await expect(h.service.start('ext', { url: `https://youtu.be/${ID}`, mode: 'video' }))
      .rejects.toThrow(/missing or failed verification/i)
    expect(invalidate).toHaveBeenCalled()
    expect(h.spawns).toHaveLength(0)
  })

  it('releases extension jobs and drops their records', async () => {
    const h = await harness()
    await h.service.start('ext', { url: `https://youtu.be/${ID}`, mode: 'video' })
    h.service.releaseExtension('ext')
    await waitFor(() => jobStatus(h.service).jobs.length === 0, 'released jobs')
    expect(h.child().killedFlag).toBe(true)
  })

  it('starts tool setup without blocking the bridge call', async () => {
    const prepare = vi.fn(async () => ({
      state: 'downloading' as const,
      progress: 5,
      message: 'Downloading…',
      error: null,
      tools: [],
    }))
    const h = await harness({ prepare })
    const status = h.service.prepare('ext')
    expect(status.setup.state).toBe('ready')
    expect(prepare).toHaveBeenCalledTimes(1)
  })
})
