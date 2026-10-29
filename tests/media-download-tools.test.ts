import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MediaToolInstaller,
  mediaToolRoot,
  type MediaToolFetch,
} from '../src/main/media-download/media-tool-installer.js'
import type { PinnedMediaTool } from '../src/main/media-download/media-tool-manifest.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function streamOf(bytes: Uint8Array, chunkSize = 7): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      const end = Math.min(bytes.length, offset + chunkSize)
      controller.enqueue(bytes.slice(offset, end))
      offset = end
    },
  })
}

function fetcherFor(files: Map<string, Uint8Array>, finalUrlFor?: (url: string) => string): MediaToolFetch {
  return async (url) => {
    const bytes = files.get(url)
    const finalUrl = finalUrlFor?.(url) ?? url
    if (!bytes) return { ok: false, status: 404, url: finalUrl, body: null }
    return { ok: true, status: 200, url: finalUrl, body: streamOf(bytes) }
  }
}

function directTool(url: string, bytes: Uint8Array): PinnedMediaTool {
  return {
    id: 'yt-dlp',
    name: 'yt-dlp',
    version: '1.0.0',
    url,
    bytes: bytes.length,
    sha256: sha256(bytes),
    license: 'Unlicense',
    archive: 'exe',
    exeName: 'yt-dlp.exe',
    exeBytes: bytes.length,
    exeSha256: sha256(bytes),
  }
}

function zipTool(url: string, zip: Uint8Array, exe: Uint8Array): PinnedMediaTool {
  return {
    id: 'deno',
    name: 'Deno',
    version: '2.0.0',
    url,
    bytes: zip.length,
    sha256: sha256(zip),
    license: 'MIT',
    archive: 'zip',
    exeName: 'deno.exe',
    exeBytes: exe.length,
    exeSha256: sha256(exe),
  }
}

async function tempRoot(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'nd-media-tools-test-'))
  roots.push(parent)
  return mediaToolRoot(parent)
}

const YT_URL = 'https://github.com/yt-dlp/yt-dlp/releases/download/1.0.0/yt-dlp.exe'
const DENO_URL = 'https://github.com/denoland/deno/releases/download/v2.0.0/deno.zip'

describe('MediaToolInstaller', () => {
  it('downloads, verifies, and atomically installs both tools without executing them', async () => {
    const ytBytes = new Uint8Array(80).fill(7)
    const denoExe = new Uint8Array(120).fill(9)
    const denoZip = zipSync({ 'deno.exe': denoExe, 'README.txt': strToU8('extra') })
    const yt = directTool(YT_URL, ytBytes)
    const deno = zipTool(DENO_URL, denoZip, denoExe)
    const root = await tempRoot()
    const installer = new MediaToolInstaller({
      rootDir: root,
      platform: 'win32',
      manifest: [yt, deno],
      fetch: fetcherFor(new Map([[YT_URL, ytBytes], [DENO_URL, denoZip]])),
    })

    expect((await installer.inspect()).state).toBe('missing')
    const prepared = await installer.prepare()
    expect(prepared.state).toBe('ready')
    expect(prepared.progress).toBe(100)
    expect(prepared.tools.every((tool) => tool.installed)).toBe(true)
    expect((await installer.inspect()).state).toBe('ready')

    const ytPath = join(root, 'yt-dlp', '1.0.0', 'yt-dlp.exe')
    const denoPath = join(root, 'deno', '2.0.0', 'deno.exe')
    expect(await readFile(ytPath)).toEqual(Buffer.from(ytBytes))
    expect(await readFile(denoPath)).toEqual(Buffer.from(denoExe))
    expect(await readdir(join(root, 'deno', '2.0.0'))).toEqual(['deno.exe'])

    const resolved = await installer.verifyForRun()
    expect(resolved.ytDlpPath).toBe(ytPath)
    expect(resolved.denoPath).toBe(denoPath)
    expect(resolved.denoDir).toBe(join(root, 'deno', '2.0.0'))
    expect(resolved.cacheDir).toBe(join(root, 'cache'))
  })

  it('discards a download whose digest does not match and never installs it', async () => {
    const ytBytes = new Uint8Array(40).fill(3)
    const denoExe = new Uint8Array(20).fill(4)
    const denoZip = zipSync({ 'deno.exe': denoExe })
    const yt = { ...directTool(YT_URL, ytBytes), sha256: '0'.repeat(64) }
    const deno = zipTool(DENO_URL, denoZip, denoExe)
    const root = await tempRoot()
    const installer = new MediaToolInstaller({
      rootDir: root,
      platform: 'win32',
      manifest: [yt, deno],
      fetch: fetcherFor(new Map([[YT_URL, ytBytes], [DENO_URL, denoZip]])),
    })

    await expect(installer.prepare()).rejects.toThrow(/integrity/i)
    expect(installer.view().state).toBe('failed')
    await expect(stat(join(root, 'yt-dlp', '1.0.0', 'yt-dlp.exe'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(installer.verifyForRun()).rejects.toThrow(/verification|missing/i)
  })

  it('rejects a redirect outside GitHub', async () => {
    const ytBytes = new Uint8Array(30).fill(1)
    const denoExe = new Uint8Array(10).fill(2)
    const denoZip = zipSync({ 'deno.exe': denoExe })
    const root = await tempRoot()
    const installer = new MediaToolInstaller({
      rootDir: root,
      platform: 'win32',
      manifest: [directTool(YT_URL, ytBytes), zipTool(DENO_URL, denoZip, denoExe)],
      fetch: fetcherFor(new Map([[YT_URL, ytBytes], [DENO_URL, denoZip]]), () => 'https://evil.example/asset'),
    })

    await expect(installer.prepare()).rejects.toThrow(/redirected outside GitHub/i)
    expect(installer.view().state).toBe('failed')
  })

  it('accepts GitHub release-asset redirects and rejects oversized downloads', async () => {
    const ytBytes = new Uint8Array(30).fill(1)
    const denoExe = new Uint8Array(10).fill(2)
    const denoZip = zipSync({ 'deno.exe': denoExe })
    const root = await tempRoot()
    const redirected = new MediaToolInstaller({
      rootDir: root,
      platform: 'win32',
      manifest: [directTool(YT_URL, ytBytes), zipTool(DENO_URL, denoZip, denoExe)],
      fetch: fetcherFor(
        new Map([[YT_URL, ytBytes], [DENO_URL, denoZip]]),
        (url) => url === YT_URL ? 'https://release-assets.githubusercontent.com/yt-dlp.exe' : url,
      ),
    })
    expect((await redirected.prepare()).state).toBe('ready')

    const otherRoot = await tempRoot()
    const oversized = new MediaToolInstaller({
      rootDir: otherRoot,
      platform: 'win32',
      manifest: [{ ...directTool(YT_URL, ytBytes), bytes: 5 }, zipTool(DENO_URL, denoZip, denoExe)],
      fetch: fetcherFor(new Map([[YT_URL, ytBytes], [DENO_URL, denoZip]])),
    })
    await expect(oversized.prepare()).rejects.toThrow(/exceeded its pinned size/i)
  })

  it('extracts only a root-level deno.exe and fails when the archive layout changes', async () => {
    const ytBytes = new Uint8Array(12).fill(1)
    const denoExe = new Uint8Array(18).fill(2)
    const nested = zipSync({ 'nested/deno.exe': denoExe, 'evil.exe': denoExe })
    const root = await tempRoot()
    const installer = new MediaToolInstaller({
      rootDir: root,
      platform: 'win32',
      manifest: [directTool(YT_URL, ytBytes), zipTool(DENO_URL, nested, denoExe)],
      fetch: fetcherFor(new Map([[YT_URL, ytBytes], [DENO_URL, nested]])),
    })

    await expect(installer.prepare()).rejects.toThrow(/did not contain deno\.exe/i)
    expect(installer.view().state).toBe('failed')
    expect((await readdir(join(root, 'deno', '2.0.0'))).length).toBe(0)
  })

  it('fails closed on unsupported platforms', async () => {
    const root = await tempRoot()
    const installer = new MediaToolInstaller({
      rootDir: root,
      platform: 'darwin',
      manifest: [directTool(YT_URL, new Uint8Array([1])), zipTool(DENO_URL, new Uint8Array([2]), new Uint8Array([3]))],
      fetch: fetcherFor(new Map()),
    })
    expect(installer.view().state).toBe('unsupported')
    expect((await installer.prepare()).state).toBe('unsupported')
    await expect(installer.verifyForRun()).rejects.toThrow(/Windows only/i)
  })
})
