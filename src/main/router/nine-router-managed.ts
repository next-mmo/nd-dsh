import { app, safeStorage } from 'electron'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import type { CoreClient } from '../core/core-client.js'
import { verifyApprovedRelease, type ReleasePolicy } from '../security/verified-release.js'
import type { NineRouterState } from '../../shared/nine-router.js'

const PACKAGE_ID = 'nd.9router-runtime'
const REPOSITORY = 'https://github.com/next-mmo/9router-nd-dsh'

/**
 * Pinned keys must ship in a signed ND desktop release. Never accept the
 * signing key from the package being installed or a remote model gateway.
 * Until our first security-reviewed artifact is signed, production install
 * is deliberately unavailable.
 */
const APPROVED_PUBLISHER_KEYS: Readonly<Record<string, string>> = {}

function publisherPolicy(): ReleasePolicy {
  const devPem = !app.isPackaged ? process.env.ND_SECURITY_DEV_PUBLIC_KEY_PEM?.trim() : undefined
  return {
    trustedKeys: devPem ? { 'nd-dev-test-key': devPem } : APPROVED_PUBLISHER_KEYS,
    allowedRepositories: [REPOSITORY],
    allowedPackages: [PACKAGE_ID],
  }
}

interface RuntimeSecrets {
  jwt: string
  api: string
  salt: string
  initialPassword: string
}

interface InstalledRuntime {
  version: string
  directory: string
}

interface ReleaseManifest {
  version: string
  runtimeEntry: string
  serverEntry: string
}

async function jsonFile<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as T }
  catch { return undefined }
}

async function saveJsonAtomic(path: string, body: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const next = path + '.' + randomUUID() + '.tmp'
  try {
    await fs.writeFile(next, JSON.stringify(body, null, 2), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(next, path)
  } finally { await fs.rm(next, { force: true }).catch(() => undefined) }
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Could not reserve a 9Router port')); return }
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}

/** No shell invocation, no inherited secrets, core-owned process lifetime. */
export class NineRouterManagedRuntime {
  private readonly root: string
  private readonly installedFile: string
  private readonly secretsFile: string
  private processId: string | undefined
  private port: number | undefined
  private installed: InstalledRuntime | undefined
  private lastError: string | undefined
  private readonly removeExitListener: () => void

  constructor(private readonly core: CoreClient, dataDir: string) {
    this.root = join(dataDir, '9router-managed')
    this.installedFile = join(this.root, 'installed.json')
    this.secretsFile = join(this.root, 'secrets.json')
    this.removeExitListener = core.onEvent<{ processId: string; exitCode: number }>('process.exit', frame => {
      if (frame.resourceId !== this.processId) return
      this.lastError = '9Router process exited (code ' + String(frame.data?.exitCode ?? '?') + ')'
      this.processId = undefined
      this.port = undefined
    })
  }

  async initialize(): Promise<void> {
    const installed = await jsonFile<InstalledRuntime>(this.installedFile)
    if (installed && typeof installed.version === 'string' && typeof installed.directory === 'string'
      && /^[a-f0-9]{64}$/.test(installed.directory.split(/[\\/]/).pop() ?? '')
      && installed.directory.startsWith(join(this.root, 'versions') + (process.platform === 'win32' ? '\\' : '/'))) {
      this.installed = installed
    }
  }

  async state(): Promise<NineRouterState> {
    const trusted = this.installed ? await verifyApprovedRelease(this.installed.directory, publisherPolicy()).then(
      () => true, () => false,
    ) : false
    return {
      installed: Boolean(this.installed),
      managed: true,
      running: Boolean(this.processId),
      trusted,
      signingKeyConfigured: Object.keys(publisherPolicy().trustedKeys).length > 0,
      ...(this.installed?.version ? { version: this.installed.version } : {}),
      ...(this.processId && this.port ? { endpoint: 'http://127.0.0.1:' + this.port + '/v1' } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  async installFromDirectory(source: string): Promise<NineRouterState> {
    if (this.processId) throw new Error('Stop the managed 9Router runtime before installing a new version')
    const policy = publisherPolicy()
    const report = await verifyApprovedRelease(source, policy)
    if (report.verdict !== 'verified') throw new Error('ND Security refused the 9Router release')
    const stage = join(this.root, 'staging', randomUUID())
    const destination = join(this.root, 'versions', report.sha256)
    await fs.mkdir(dirname(stage), { recursive: true })
    try {
      await fs.cp(source, stage, { recursive: true, errorOnExist: true, force: false, dereference: false })
      await verifyApprovedRelease(stage, policy)
      await fs.mkdir(dirname(destination), { recursive: true })
      const exists = await fs.stat(destination).then(() => true, () => false)
      if (exists) await verifyApprovedRelease(destination, policy)
      else await fs.rename(stage, destination)
      const record = { version: report.version, directory: destination }
      await saveJsonAtomic(this.installedFile, record)
      this.installed = record
      this.lastError = undefined
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
    }
    return this.state()
  }

  async prepare(password: string): Promise<NineRouterState> {
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
      throw new Error('Choose an initial 9Router dashboard password of at least 12 characters')
    }
    if (!safeStorage.isEncryptionAvailable()
      || (process.platform === 'linux' && ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend()))) {
      throw new Error('OS-backed secure storage is required for managed 9Router')
    }
    if (await fs.stat(this.secretsFile).then(() => true, () => false)) {
      throw new Error('9Router managed credentials already exist. Use the existing dashboard password.')
    }
    const secret: RuntimeSecrets = {
      jwt: randomBytes(48).toString('base64url'),
      api: randomBytes(48).toString('base64url'),
      salt: randomBytes(32).toString('base64url'),
      initialPassword: password,
    }
    await saveJsonAtomic(this.secretsFile, {
      version: 1,
      encrypted: safeStorage.encryptString(JSON.stringify(secret)).toString('base64'),
    })
    return this.state()
  }

  private async loadSecrets(): Promise<RuntimeSecrets> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable')
    const record = await jsonFile<{ version: number; encrypted: string }>(this.secretsFile)
    if (record?.version !== 1 || !record.encrypted) throw new Error('Set an initial 9Router dashboard password before starting')
    return JSON.parse(safeStorage.decryptString(Buffer.from(record.encrypted, 'base64'))) as RuntimeSecrets
  }

  async start(): Promise<NineRouterState> {
    if (this.processId) return this.state()
    if (!this.installed) throw new Error('No signed 9Router release is installed')
    await verifyApprovedRelease(this.installed.directory, publisherPolicy())
    const secrets = await this.loadSecrets()
    const manifest = (await jsonFile<ReleaseManifest>(join(this.installed.directory, 'release-manifest.json')))
    if (!manifest?.runtimeEntry || !manifest?.serverEntry) throw new Error('Invalid signed 9Router release')
    const runtime = join(this.installed.directory, ...manifest.runtimeEntry.split('/'))
    const server = join(this.installed.directory, ...manifest.serverEntry.split('/'))
    const port = await freeLoopbackPort()
    const processId = randomUUID()
    this.lastError = undefined
    try {
      await this.core.request('process.spawn', {
        id: processId,
        command: runtime,
        args: [server, '--port', String(port), '--no-browser', '--skip-update'],
        cwd: this.installed.directory,
        inheritEnv: false,
        env: {
          PATH: process.env.PATH ?? '',
          SystemRoot: process.env.SystemRoot ?? '',
          WINDIR: process.env.WINDIR ?? '',
          HOME: process.env.HOME ?? '',
          USERPROFILE: process.env.USERPROFILE ?? '',
          TEMP: process.env.TEMP ?? '',
          TMP: process.env.TMP ?? '',
          NODE_ENV: 'production',
          HOSTNAME: '127.0.0.1',
          PORT: String(port),
          DATA_DIR: join(this.root, 'data'),
          BASE_URL: 'http://127.0.0.1:' + port,
          NEXT_PUBLIC_BASE_URL: 'http://127.0.0.1:' + port,
          JWT_SECRET: secrets.jwt,
          API_KEY_SECRET: secrets.api,
          MACHINE_ID_SALT: secrets.salt,
          INITIAL_PASSWORD: secrets.initialPassword,
          REQUIRE_API_KEY: 'true',
          ENABLE_REQUEST_LOGS: 'false',
          OBSERVABILITY_ENABLED: 'false',
        },
      }, 30_000)
      this.processId = processId
      this.port = port
      // Core spawning means the executable was started, not that the HTTP
      // service is ready. Don't report a usable gateway until /api/health answers.
      let ready = false
      for (let attempt = 0; attempt < 25 && this.processId === processId; attempt++) {
        try {
          const response = await fetch('http://127.0.0.1:' + port + '/api/health', {
            redirect: 'error', cache: 'no-store',
            signal: AbortSignal.timeout(1000),
          })
          if (response.ok && Number(response.headers.get('content-length') ?? 0) < 1024) {
            const data = await response.json() as { ok?: unknown }
            if (data?.ok === true) { ready = true; break }
          }
        } catch { /* service is not ready yet */ }
        await new Promise(resolve => setTimeout(resolve, 300))
      }
      if (!ready) throw new Error('Managed 9Router failed its startup health check')
    } catch (e) {
      await this.core.request('process.cancel', { processId }, 5_000).catch(() => undefined)
      if (this.processId === processId) { this.processId = undefined; this.port = undefined }
      this.lastError = e instanceof Error ? e.message : String(e)
      throw e
    }
    return this.state()
  }

  async stop(): Promise<NineRouterState> {
    const id = this.processId
    this.processId = undefined
    this.port = undefined
    if (id) await this.core.request('process.cancel', { processId: id }, 5_000).catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error)
    })
    return this.state()
  }

  async dispose(): Promise<void> {
    await this.stop()
    this.removeExitListener()
  }
}
