import { app } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CoreClient } from '../core/core-client.js'

const execFileAsync = promisify(execFile)

const DEFAULT_PORT = 8001
const DEFAULT_WS_PORT = 9226
const BIND_HOST = '127.0.0.1'
const DEFAULT_BASE_URL = `http://${BIND_HOST}:${DEFAULT_PORT}/v1`

function binaryFileName(): string {
  return process.platform === 'win32' ? 'free-gemini-api.exe' : 'free-gemini-api'
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, BIND_HOST, () => {
      server.close(() => resolve(true))
    })
  })
}

async function freeLoopbackPort(preferred?: number): Promise<number> {
  if (preferred && await isPortAvailable(preferred)) return preferred
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, BIND_HOST, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not allocate a loopback port for Free Gemini API'))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

async function isHealthy(baseUrl: string): Promise<boolean> {
  const healthUrl = `${baseUrl.replace(/\/v1\/?$/, '')}/health`
  try {
    const response = await fetch(healthUrl, {
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(1200),
    })
    if (!response.ok) return false
    const data = (await response.json()) as { status?: unknown }
    return data?.status === 'online'
  } catch {
    return false
  }
}

/**
 * Manages the local `free-gemini-api` Go sidecar process for ND Router.
 *
 * Reuses an already-running external instance on 127.0.0.1:8001 if present,
 * otherwise spawns the staged binary (or builds from `vendor/free-gemini-api`
 * in dev) on loopback with isolated working directory state.
 */
export class FreeGeminiApiRuntime {
  private readonly root: string
  private processId: string | undefined
  private port: number | undefined
  private startPromise: Promise<string> | undefined

  constructor(
    private readonly core: CoreClient,
    dataDir: string,
    private readonly log: (message: string) => void = (message) => console.warn(message),
  ) {
    this.root = join(dataDir, 'free-gemini-api')
  }

  async ensureStarted(): Promise<string> {
    if (this.port) {
      const url = `http://${BIND_HOST}:${this.port}/v1`
      if (await isHealthy(url)) return url
    }
    if (this.startPromise) return this.startPromise

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined
    })
    return this.startPromise
  }

  private async startInternal(): Promise<string> {
    if (await isHealthy(DEFAULT_BASE_URL)) {
      return DEFAULT_BASE_URL
    }

    const binary = await this.resolveOrBuildBinary()
    await fs.mkdir(this.root, { recursive: true })

    const port = await freeLoopbackPort(DEFAULT_PORT)
    const wsPort = await freeLoopbackPort(port === DEFAULT_PORT ? DEFAULT_WS_PORT : undefined)
    const processId = randomUUID()

    await this.core.request('process.spawn', {
      id: processId,
      command: binary,
      args: [],
      cwd: this.root,
      inheritEnv: false,
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        WINDIR: process.env.WINDIR ?? '',
        HOME: process.env.HOME ?? '',
        USERPROFILE: process.env.USERPROFILE ?? '',
        TEMP: process.env.TEMP ?? '',
        TMP: process.env.TMP ?? '',
        PORT: String(port),
        WS_PORT: String(wsPort),
      },
    }, 30_000)

    this.processId = processId
    this.port = port
    const baseUrl = `http://${BIND_HOST}:${port}/v1`

    for (let attempt = 0; attempt < 25 && this.processId === processId; attempt++) {
      if (await isHealthy(baseUrl)) {
        this.log(`[free-gemini-api] listening on ${baseUrl}`)
        return baseUrl
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    throw new Error(`Free Gemini API failed to become healthy on ${baseUrl}`)
  }

  private async resolveOrBuildBinary(): Promise<string> {
    const fileName = binaryFileName()
    const candidates = [
      process.resourcesPath ? join(process.resourcesPath, 'free-gemini-api', 'bin', fileName) : '',
      join(app.getAppPath(), 'resources', 'free-gemini-api', 'bin', fileName),
      join(process.cwd(), 'resources', 'free-gemini-api', 'bin', fileName),
      join(this.root, 'bin', fileName),
    ].filter(Boolean)

    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }

    const upstreamDirs = [
      join(app.getAppPath(), 'vendor', 'free-gemini-api', 'free-gemini-api'),
      join(process.cwd(), 'vendor', 'free-gemini-api', 'free-gemini-api'),
    ]
    const upstreamDir = upstreamDirs.find((dir) => existsSync(join(dir, 'main.go')))
    if (!upstreamDir) {
      throw new Error('Free Gemini API binary is not staged and vendor/free-gemini-api is missing')
    }

    const devBinDir = join(this.root, 'bin')
    const devBinary = join(devBinDir, fileName)
    await fs.mkdir(devBinDir, { recursive: true })
    this.log('[free-gemini-api] building local Go runtime from vendor/free-gemini-api...')
    await execFileAsync('go', ['build', '-o', devBinary, '.'], {
      cwd: upstreamDir,
      timeout: 120_000,
    })
    if (!existsSync(devBinary)) {
      throw new Error(`Free Gemini API Go build did not produce ${devBinary}`)
    }
    return devBinary
  }

  isManagedUrl(baseUrl: string | undefined): boolean {
    if (!baseUrl) return true
    const trimmed = baseUrl.trim().replace(/\/+$/, '')
    if (trimmed === DEFAULT_BASE_URL) return true
    return Boolean(this.port && trimmed === `http://${BIND_HOST}:${this.port}/v1`)
  }

  async dispose(): Promise<void> {
    const processId = this.processId
    this.processId = undefined
    this.port = undefined
    if (!processId) return
    await this.core.request('process.kill', { id: processId }, 10_000).catch(() => undefined)
  }
}
