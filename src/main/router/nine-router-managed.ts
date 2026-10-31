import { app, safeStorage } from 'electron'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { existsSync, promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import type { CoreClient } from '../core/core-client.js'
import type { ExtensionPackageStore } from '../extensions/package-store.js'
import { verifyApprovedRelease, type ReleasePolicy } from '../security/verified-release.js'
import type { NineRouterState } from '../../shared/nine-router.js'
import {
  assertInventoryDigest,
  detectLocalReleaseEntries,
  inventoryLocalRelease,
  isInsideDirectory,
  LocalReleaseError,
  resolveSystemNodeRuntime,
} from './local-release.js'

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
    allowedPackages: [PACKAGE_ID, 'nd.9router'],
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
  /** Absent on records written before unverified imports existed: those are signed. */
  verification?: 'signed' | 'unverified'
  runtimeMode?: 'bundled' | 'system-node'
  runtimeEntry?: string
  serverEntry?: string
  workingDirectory?: string
  nodePath?: string
  inventoryDigest?: string
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
  /** Last inventory result for an unverified import; start is the authoritative check. */
  private unverifiedIntegrity: NineRouterState['integrity']
  private readonly removeExitListener: () => void
  private packageStore?: ExtensionPackageStore
  private readonly packagesRoot: string

  constructor(private readonly core: CoreClient, dataDir: string, packagesRoot?: string) {
    this.packagesRoot = packagesRoot ?? join(dirname(dataDir), 'nd-extensions')
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

  setPackageStore(packageStore: ExtensionPackageStore): void {
    this.packageStore = packageStore
  }

  private async getInstalledExtension(): Promise<{ version: string; directory: string } | undefined> {
    if (this.packageStore) {
      const record = await this.packageStore.record('nd.9router')
        ?? await this.packageStore.record('nd.9router-runtime')
      if (record) {
        const snapshotDir = this.packageStore.snapshotDir(record.manifest.id, record.manifest.version)
        if (existsSync(snapshotDir)) {
          return {
            version: record.manifest.version,
            directory: snapshotDir,
          }
        }
      }
    }
    const packagesRoot = this.packagesRoot
    const indexPath = join(packagesRoot, 'installed-packages.json')
    try {
      const index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as {
        packages?: Array<{ manifest?: { id?: string; version?: string } }>
      }
      if (Array.isArray(index?.packages)) {
        const found = index.packages.find((p) => p.manifest?.id === 'nd.9router' || p.manifest?.id === 'nd.9router-runtime')
        if (found?.manifest?.id && found.manifest.version) {
          const snapshotDir = join(packagesRoot, 'packages', found.manifest.id, found.manifest.version)
          if (existsSync(snapshotDir)) {
            return {
              version: found.manifest.version,
              directory: snapshotDir,
            }
          }
        }
      }
    } catch {
      // index unreadable or not created yet
    }
    return undefined
  }

  async initialize(): Promise<void> {
    const installed = await jsonFile<InstalledRuntime>(this.installedFile)
    if (installed && typeof installed.version === 'string' && typeof installed.directory === 'string'
      && /^[a-f0-9]{64}$/.test(installed.directory.split(/[\\/]/).pop() ?? '')
      && installed.directory.startsWith(join(this.root, 'versions') + (process.platform === 'win32' ? '\\' : '/'))) {
      this.installed = installed
      // Do not hash a large local import just to answer a status poll; start()
      // re-checks the inventory before anything executes.
      if ((installed.verification ?? 'signed') === 'unverified') this.unverifiedIntegrity = 'ok'
    }
  }

  async state(): Promise<NineRouterState> {
    let record = this.installed
    let installedViaExtension = false
    if (!record) {
      const ext = await this.getInstalledExtension()
      if (ext) {
        record = {
          version: ext.version,
          directory: ext.directory,
          verification: 'signed',
        }
        installedViaExtension = true
      }
    }
    const verification = record?.verification ?? (record ? 'signed' : undefined)
    let trusted = false
    let integrity: NineRouterState['integrity']
    if (record) {
      if (installedViaExtension) {
        trusted = true
        integrity = 'ok'
      } else if (verification === 'signed') {
        trusted = await verifyApprovedRelease(record.directory, publisherPolicy()).then(
          () => true, () => false,
        )
        integrity = trusted ? 'ok' : 'changed'
      } else {
        // Unverified imports carry no publisher claim. The inventory is
        // re-checked before every start; a status poll reports the last result.
        integrity = this.unverifiedIntegrity ?? 'ok'
      }
    }
    return {
      installed: Boolean(record),
      managed: true,
      running: Boolean(this.processId),
      trusted,
      signingKeyConfigured: Object.keys(publisherPolicy().trustedKeys).length > 0 || installedViaExtension,
      ...(verification ? { verification } : {}),
      ...(integrity ? { integrity } : {}),
      ...(record?.version ? { version: record.version } : {}),
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
      const record: InstalledRuntime = { version: report.version, directory: destination, verification: 'signed' }
      await saveJsonAtomic(this.installedFile, record)
      this.installed = record
      this.unverifiedIntegrity = undefined
      this.lastError = undefined
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
    }
    return this.state()
  }

  /**
   * Import a local 9Router folder without a publisher signature. The UI asks
   * for explicit consent first. ND copies and hash-pins the files, refuses
   * symlinks and out-of-tree entries, and re-checks the inventory before every
   * start — but it cannot prove who built this folder. The runtime keeps its
   * own dashboard credentials; ND does not inject managed secrets into it.
   */
  async importUnverified(source: string): Promise<NineRouterState> {
    if (this.processId) throw new Error('Stop the managed 9Router runtime before importing another build')
    const sourceRoot = typeof source === 'string' ? source.trim() : ''
    if (!sourceRoot) throw new LocalReleaseError('choose a 9Router folder')
    if (isInsideDirectory(this.root, sourceRoot)) throw new LocalReleaseError('choose a folder outside ND\'s managed 9Router store')
    if (isInsideDirectory(sourceRoot, this.root)) throw new LocalReleaseError('the chosen folder contains ND\'s managed 9Router store')
    const entries = await detectLocalReleaseEntries(sourceRoot)
    const sourceInventory = await inventoryLocalRelease(sourceRoot)
    const stage = join(this.root, 'staging', randomUUID())
    const destination = join(this.root, 'versions', sourceInventory.digest)
    await fs.mkdir(dirname(stage), { recursive: true })
    try {
      await fs.cp(sourceRoot, stage, {
        recursive: true,
        errorOnExist: true,
        force: false,
        dereference: false,
        filter: (source) => source.split(/[\\/]/).pop() !== '.git',
      })
      const stagedInventory = await inventoryLocalRelease(stage)
      if (stagedInventory.digest !== sourceInventory.digest) {
        throw new LocalReleaseError('the folder changed while it was being copied')
      }
      await fs.mkdir(dirname(destination), { recursive: true })
      const exists = await fs.stat(destination).then(() => true, () => false)
      if (exists) await assertInventoryDigest(destination, sourceInventory.digest)
      else await fs.rename(stage, destination)
      const record: InstalledRuntime = {
        version: entries.version,
        directory: destination,
        verification: 'unverified',
        runtimeMode: entries.runtimeMode,
        serverEntry: entries.serverEntry,
        workingDirectory: entries.workingDirectory,
        inventoryDigest: sourceInventory.digest,
        ...(entries.runtimeEntry ? { runtimeEntry: entries.runtimeEntry } : {}),
        ...(entries.nodePath ? { nodePath: entries.nodePath } : {}),
      }
      await saveJsonAtomic(this.installedFile, record)
      this.installed = record
      this.unverifiedIntegrity = 'ok'
      this.lastError = undefined
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
    }
    return this.state()
  }

  async prepare(password: string): Promise<NineRouterState> {
    if (this.installed && (this.installed.verification ?? 'signed') === 'unverified') {
      throw new Error('Unverified imports keep their own dashboard credentials. Create the account in the 9Router dashboard.')
    }
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
    let record = this.installed
    let installedViaExtension = false
    if (!record) {
      const ext = await this.getInstalledExtension()
      if (ext) {
        record = {
          version: ext.version,
          directory: ext.directory,
          verification: 'signed',
        }
        installedViaExtension = true
      }
    }
    if (!record) throw new Error('No 9Router build is installed')
    const verification = record.verification ?? 'signed'
    let runtime: string
    let server: string
    let workingDirectory: string
    let secrets: RuntimeSecrets | undefined
    if (installedViaExtension) {
      const releaseManifestPath = join(record.directory, 'release-manifest.json')
      if (existsSync(releaseManifestPath)) {
        const manifest = await jsonFile<ReleaseManifest>(releaseManifestPath)
        if (!manifest?.runtimeEntry || !manifest?.serverEntry) throw new Error('Invalid 9Router extension release')
        runtime = join(record.directory, ...manifest.runtimeEntry.split('/'))
        server = join(record.directory, ...manifest.serverEntry.split('/'))
        workingDirectory = record.directory
      } else {
        const entries = await detectLocalReleaseEntries(record.directory)
        if (entries.runtimeMode === 'system-node') {
          runtime = entries.nodePath ?? resolveSystemNodeRuntime() ?? process.execPath
        } else {
          runtime = join(record.directory, ...(entries.runtimeEntry ?? 'node').split('/'))
        }
        server = join(record.directory, ...entries.serverEntry.split('/'))
        workingDirectory = join(record.directory, ...(entries.workingDirectory ?? '.').split('/'))
      }
    } else if (verification === 'signed') {
      await verifyApprovedRelease(record.directory, publisherPolicy())
      secrets = await this.loadSecrets()
      const manifest = (await jsonFile<ReleaseManifest>(join(record.directory, 'release-manifest.json')))
      if (!manifest?.runtimeEntry || !manifest?.serverEntry) throw new Error('Invalid signed 9Router release')
      runtime = join(record.directory, ...manifest.runtimeEntry.split('/'))
      server = join(record.directory, ...manifest.serverEntry.split('/'))
      workingDirectory = record.directory
    } else {
      try {
        await assertInventoryDigest(record.directory, record.inventoryDigest ?? '')
        this.unverifiedIntegrity = 'ok'
      } catch (error) {
        this.unverifiedIntegrity = 'changed'
        this.lastError = error instanceof Error ? error.message : String(error)
        throw error
      }
      if (!record.serverEntry) throw new Error('Unverified 9Router import is missing its server entry; import the folder again')
      if (record.runtimeMode === 'system-node') {
        if (!record.nodePath || !existsSync(record.nodePath)) {
          throw new Error('The Node.js runtime used for this import is no longer available. Reinstall Node.js or import a release folder with a bundled runtime.')
        }
        runtime = record.nodePath
      } else {
        if (!record.runtimeEntry) throw new Error('Unverified 9Router import is missing its runtime entry; import the folder again')
        runtime = join(record.directory, ...record.runtimeEntry.split('/'))
      }
      server = join(record.directory, ...record.serverEntry.split('/'))
      workingDirectory = join(record.directory, ...(record.workingDirectory ?? '.').split('/'))
    }
    const port = await freeLoopbackPort()
    const processId = randomUUID()
    this.lastError = undefined
    try {
      await this.core.request('process.spawn', {
        id: processId,
        command: runtime,
        args: [server, '--port', String(port), '--no-browser', '--skip-update'],
        cwd: workingDirectory,
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
          // Signed releases receive ND-generated secrets. Unverified imports
          // deliberately do not: they keep their own dashboard credentials.
          ...(secrets ? {
            JWT_SECRET: secrets.jwt,
            API_KEY_SECRET: secrets.api,
            MACHINE_ID_SALT: secrets.salt,
            INITIAL_PASSWORD: secrets.initialPassword,
            REQUIRE_API_KEY: 'true',
            ENABLE_REQUEST_LOGS: 'false',
            OBSERVABILITY_ENABLED: 'false',
          } : {}),
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
