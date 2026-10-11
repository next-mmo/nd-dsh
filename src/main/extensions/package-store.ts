import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import {
  ND_EXTENSION_MANIFEST_FILENAME,
  compareVersions,
  manifestPermissionIssues,
  validateNdExtensionManifest,
  type NdExtensionManifest,
} from '../../shared/extension-package.js'
import type {
  NdContributionCounts,
  NdInstalledPackageView,
  NdPackageSourceView,
} from '../../shared/nd-invocations.js'
import { quarantineFile } from '../logging/log-file.js'
import { rawGitExecRunner, type GitExecRunner } from '../git/git-cli.js'
import { ND_WEBVIEW_MAX_ASSET_FILE_BYTES, ND_WEBVIEW_MAX_ASSET_TOTAL_BYTES } from '../../shared/extension-webview.js'

interface NdPackageRecord {
  manifest: NdExtensionManifest
  source: NdPackageSourceView
  installedAt: number
  updatedAt: number
  previousVersion?: string
  versions: string[]
}

interface PackageIndexSnapshot {
  version: 1
  packages: NdPackageRecord[]
}

const GIT_REVISION_TIMEOUT_MS = 3_000
const MAX_PACKAGE_FILES = 5_000

/**
 * Durable ND-managed package store. Installation validates and snapshots
 * package content into ND storage but never activates a package and never runs
 * dependency installation or build scripts: developers supply built
 * dependencies before installation. Update switches the active version only
 * after the new snapshot validates, so a failed or declined update leaves the
 * previous version usable.
 */
export class ExtensionPackageStore {
  private loaded = false
  private loadPromise: Promise<void> | undefined
  private saveChain: Promise<void> = Promise.resolve()
  private value: PackageIndexSnapshot = { version: 1, packages: [] }

  constructor(private readonly rootDir: string, private readonly git: GitExecRunner = rawGitExecRunner) {}

  async list(): Promise<NdInstalledPackageView[]> {
    await this.load()
    return this.value.packages.map((record) => this.toView(record))
  }

  async record(extensionId: string): Promise<NdPackageRecord | undefined> {
    await this.load()
    return this.value.packages.find((item) => item.manifest.id === extensionId)
  }

  /** The manifest of the active version, or undefined when the package is unknown. */
  async activeManifest(extensionId: string): Promise<NdExtensionManifest | undefined> {
    const record = await this.record(extensionId)
    return record ? structuredClone(record.manifest) : undefined
  }

  /** Manifest content for one installed version, read back from its snapshot. */
  async manifestForVersion(extensionId: string, version: string): Promise<NdExtensionManifest> {
    const file = join(this.rootDir, 'packages', extensionId, version, ND_EXTENSION_MANIFEST_FILENAME)
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
    const validated = validateNdExtensionManifest(parsed)
    if (!validated.ok) throw new Error(`Installed package ${extensionId}@${version} failed re-validation`)
    const permissionIssues = manifestPermissionIssues(validated.manifest)
    if (permissionIssues.length > 0) {
      throw new Error(`Installed package ${extensionId}@${version} failed permission re-validation`)
    }
    return validated.manifest
  }

  /**
   * Snapshot one ND-maintained package. Built-ins ship with ND and are
   * registered at startup; they follow the same validation and snapshot path
   * as third-party packages so every proving package exercises one contract.
   */
  async registerBuiltin(manifest: NdExtensionManifest): Promise<void> {
    await this.load()
    const validated = validateNdExtensionManifest(manifest)
    if (!validated.ok) {
      const summary = validated.issues.slice(0, 5).map((issue) => `${issue.path || 'manifest'}: ${issue.message}`).join('; ')
      throw new Error(`Invalid built-in extension package: ${summary}`)
    }
    const normalized = validated.manifest
    const permissionIssues = manifestPermissionIssues(normalized)
    if (permissionIssues.length > 0) {
      throw new Error(`Invalid built-in extension package: ${permissionIssues.map((issue) => issue.message).join('; ')}`)
    }
    const existing = this.value.packages.find((item) => item.manifest.id === normalized.id)
    const snapshotDir = this.snapshotDir(normalized.id, normalized.version)
    await fs.mkdir(snapshotDir, { recursive: true })
    await fs.writeFile(
      join(snapshotDir, ND_EXTENSION_MANIFEST_FILENAME),
      `${JSON.stringify(normalized, null, 2)}\n`,
      'utf8',
    )
    if (existing) {
      const previousVersion = existing.manifest.version === normalized.version ? existing.previousVersion : existing.manifest.version
      existing.manifest = normalized
      existing.source = { kind: 'builtin', location: 'nd' }
      existing.updatedAt = Date.now()
      if (previousVersion === undefined) delete existing.previousVersion
      else existing.previousVersion = previousVersion
      if (!existing.versions.includes(normalized.version)) existing.versions.push(normalized.version)
    } else {
      this.value.packages.push({
        manifest: normalized,
        source: { kind: 'builtin', location: 'nd' },
        installedAt: Date.now(),
        updatedAt: Date.now(),
        versions: [normalized.version],
      })
    }
    await this.persist()
  }

  /**
   * Install (or update to) the package found in a local directory. Installation
   * is inert: it validates, snapshots, and records provenance, and nothing
   * executes until an authorized context activates and invokes it.
   */
  async installFromDirectory(sourceDirectory: string, options?: { expectId?: string }): Promise<NdInstalledPackageView> {
    await this.load()
    const sourceDir = resolve(sourceDirectory)
    const stat = await fs.stat(sourceDir).catch(() => undefined)
    if (!stat?.isDirectory()) throw new Error('Choose a directory that contains an nd-extension.json package')
    const manifestFile = join(sourceDir, ND_EXTENSION_MANIFEST_FILENAME)
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
    } catch (error) {
      throw new Error(`Could not read ${ND_EXTENSION_MANIFEST_FILENAME}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const validated = validateNdExtensionManifest(parsed)
    if (!validated.ok) {
      const summary = validated.issues.slice(0, 5).map((issue) => `${issue.path || 'manifest'}: ${issue.message}`).join('; ')
      throw new Error(`Invalid extension package: ${summary}`)
    }
    const manifest = validated.manifest
    const permissionIssues = manifestPermissionIssues(manifest)
    if (permissionIssues.length > 0) {
      throw new Error(`Invalid extension package: ${permissionIssues.map((issue) => issue.message).join('; ')}`)
    }
    if (options?.expectId && manifest.id !== options.expectId) {
      throw new Error(`This package is ${manifest.id}, not ${options.expectId}`)
    }
    await assertContainedPackage(sourceDir)

    const revision = await gitRevision(sourceDir, this.git)
    const source: NdPackageSourceView = {
      kind: sourceDir.includes(`${sep}.git${sep}`) || revision ? 'git' : 'local',
      location: sourceDir,
      ...(revision ? { revision } : {}),
    }

    const snapshotDir = this.snapshotDir(manifest.id, manifest.version)
    await fs.rm(snapshotDir, { recursive: true, force: true })
    await fs.mkdir(dirname(snapshotDir), { recursive: true })
    await fs.cp(sourceDir, snapshotDir, {
      recursive: true,
      dereference: false,
      filter: (source) => !source.split(sep).includes('.git'),
    })

    const existing = this.value.packages.find((item) => item.manifest.id === manifest.id)
    if (existing) {
      const activeVersion = existing.manifest.version
      existing.manifest = manifest
      existing.source = source
      existing.updatedAt = Date.now()
      const previousVersion = activeVersion === manifest.version ? existing.previousVersion : activeVersion
      if (previousVersion === undefined) delete existing.previousVersion
      else existing.previousVersion = previousVersion
      if (!existing.versions.includes(manifest.version)) existing.versions.push(manifest.version)
    } else {
      this.value.packages.push({
        manifest,
        source,
        installedAt: Date.now(),
        updatedAt: Date.now(),
        versions: [manifest.version],
      })
    }
    await this.persist()
    return this.toView(this.value.packages.find((item) => item.manifest.id === manifest.id)!)
  }

  /**
   * Switch back to the previous installed version. Settings survive because
   * settings live with activation records, not with the package snapshot.
   */
  async rollback(extensionId: string): Promise<NdInstalledPackageView> {
    await this.load()
    const record = this.value.packages.find((item) => item.manifest.id === extensionId)
    if (!record) throw new Error(`Unknown extension package: ${extensionId}`)
    const target = record.previousVersion
    if (!target) throw new Error('This package has no previous version to roll back to')
    const targetManifest = await this.manifestForVersion(extensionId, target)
    const from = record.manifest.version
    record.manifest = targetManifest
    record.previousVersion = from
    record.updatedAt = Date.now()
    await this.persist()
    return this.toView(record)
  }

  async uninstall(extensionId: string): Promise<void> {
    await this.load()
    const record = this.value.packages.find((item) => item.manifest.id === extensionId)
    if (!record) return
    if (record.source.kind === 'builtin') throw new Error('ND-maintained packages cannot be uninstalled; disable them in the target context instead')
    this.value.packages = this.value.packages.filter((item) => item.manifest.id !== extensionId)
    await fs.rm(join(this.rootDir, 'packages', extensionId), { recursive: true, force: true }).catch(() => undefined)
    await this.persist()
  }

  /** Reject symlinks and paths escaping the package root before any copy happens. */
  async snapshotFileFor(extensionId: string, version: string, relativePath: string): Promise<string | null> {
    const root = this.snapshotDir(extensionId, version)
    const candidate = resolve(root, relativePath)
    const inside = candidate === root || candidate.startsWith(`${root}${sep}`)
    if (!inside) return null
    return fs.access(candidate).then(() => candidate, () => null)
  }

  private snapshotDir(extensionId: string, version: string): string {
    return join(this.rootDir, 'packages', extensionId, version)
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = this.loadFromDisk().finally(() => { this.loadPromise = undefined })
    return this.loadPromise
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexPath(), 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object') throw new Error('package index is not an object')
      const record = parsed as Record<string, unknown>
      if (record.version !== 1 || !Array.isArray(record.packages)) throw new Error('package index has an unsupported schema')
      const packages: NdPackageRecord[] = []
      for (const item of record.packages) {
        const candidate = item as Record<string, unknown>
        const validated = validateNdExtensionManifest(candidate.manifest)
        if (!validated.ok || manifestPermissionIssues(validated.manifest).length > 0) continue
        const source = candidate.source as NdPackageSourceView | undefined
        if (!source || typeof source.location !== 'string' || typeof source.kind !== 'string') continue
        packages.push({
          manifest: validated.manifest,
          source,
          installedAt: Number(candidate.installedAt) || Date.now(),
          updatedAt: Number(candidate.updatedAt) || Date.now(),
          ...(typeof candidate.previousVersion === 'string' ? { previousVersion: candidate.previousVersion } : {}),
          versions: Array.isArray(candidate.versions) ? candidate.versions.filter((version): version is string => typeof version === 'string') : [validated.manifest.version],
        })
      }
      this.value = { version: 1, packages }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await quarantineFile(this.indexPath(), error)
      }
      this.value = { version: 1, packages: [] }
    }
    this.loaded = true
  }

  private indexPath(): string {
    return join(this.rootDir, 'nd-extensions.json')
  }

  private async persist(): Promise<void> {
    const serialized = `${JSON.stringify(this.value, null, 2)}\n`
    const target = this.indexPath()
    const write = this.saveChain.catch(() => undefined).then(async () => {
      await fs.mkdir(dirname(target), { recursive: true })
      const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temp, serialized, 'utf8')
        await fs.rename(temp, target)
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
    })
    this.saveChain = write
    return write
  }

  private toView(record: NdPackageRecord): NdInstalledPackageView {
    const counts: NdContributionCounts = {
      tools: record.manifest.contributions.tools.length,
      skills: record.manifest.contributions.skills.length,
      commands: record.manifest.contributions.commands.length,
      views: record.manifest.contributions.views.length,
      workflows: record.manifest.contributions.workflows.length,
    }
    return {
      id: record.manifest.id,
      name: record.manifest.name,
      description: record.manifest.description,
      version: record.manifest.version,
      protocol: record.manifest.protocol,
      apiVersion: record.manifest.apiVersion,
      source: record.source,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      contexts: [...record.manifest.contexts],
      permissions: [...record.manifest.permissions],
      settings: structuredClone(record.manifest.settings),
      contributions: counts,
      views: record.manifest.contributions.views.map((view) => ({
        id: view.id,
        title: view.title,
        ...(view.description ? { description: view.description } : {}),
      })),
      commands: record.manifest.contributions.commands.map((command) => ({
        id: command.id,
        title: command.title,
        ...(command.description ? { description: command.description } : {}),
      })),
      hasExecutable: record.manifest.executable !== undefined,
      ...(record.previousVersion ? { previousVersion: record.previousVersion } : {}),
    }
  }
}

/** Newest-first ordering for the management surface. */
export function sortPackageViews(views: NdInstalledPackageView[]): NdInstalledPackageView[] {
  return [...views].sort((left, right) => right.updatedAt - left.updatedAt || compareVersions(right.version, left.version))
}

/**
 * Walk the package tree and reject symlinks outright. A symlink could point
 * outside the package root, and following it during the snapshot copy would
 * import content the manifest never declared. File sizes are capped so a web
 * view package cannot smuggle unbounded assets past the installer.
 */
async function assertContainedPackage(root: string): Promise<void> {
  let visited = 0
  let totalBytes = 0
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      visited += 1
      if (visited > MAX_PACKAGE_FILES) throw new Error(`Package contains more than ${MAX_PACKAGE_FILES} files`)
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const absolute = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Package contains a symbolic link (${relative(root, absolute)}); links are not allowed in packages`)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      const size = (await fs.stat(absolute)).size
      if (size > ND_WEBVIEW_MAX_ASSET_FILE_BYTES) {
        throw new Error(`Package file ${relative(root, absolute)} exceeds the ${ND_WEBVIEW_MAX_ASSET_FILE_BYTES / (1024 * 1024)} MB per-file cap`)
      }
      totalBytes += size
      if (totalBytes > ND_WEBVIEW_MAX_ASSET_TOTAL_BYTES) {
        throw new Error(`Package exceeds the ${ND_WEBVIEW_MAX_ASSET_TOTAL_BYTES / (1024 * 1024)} MB total asset cap`)
      }
    }
  }
  await walk(root)
}

async function gitRevision(directory: string, runGit: GitExecRunner): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(directory, ['rev-parse', 'HEAD'], { timeoutMs: GIT_REVISION_TIMEOUT_MS })
    const revision = stdout.trim()
    return /^[0-9a-f]{7,64}$/.test(revision) ? revision : undefined
  } catch {
    return undefined
  }
}
