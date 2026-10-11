import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { OrganizationSnapshot, Project } from '../../shared/organization.js'
import {
  parseWorkflowPluginManifest,
  workflowSnapshotKeyId,
  type InstalledWorkflowPlugin,
  type ProjectWorkflowBinding,
  type WorkflowDetectionPreview,
  type WorkflowPluginInstallSource,
  type WorkflowPluginManifest,
  type WorkflowPluginsState,
  type WorkflowProjectView,
} from '../../shared/workflow-plugins.js'
import { WorkflowCliClient, WorkflowCliError } from './workflow-cli-client.js'
import { cloneWorkflowPluginSource, gitProvenance, locatePluginManifest } from './workflow-git.js'
import type { WorkflowPluginStore } from './workflow-plugin-store.js'
import type { GitExecRunner } from '../git/git-cli.js'

export interface WorkflowServiceOptions {
  store: WorkflowPluginStore
  /** Organization state is read-only here: ND owns identity, plugins only mirror repository state. */
  organization: { state(): Promise<OrganizationSnapshot> }
  cli?: WorkflowCliClient
  clock?: () => number
  /** Directory for cloned plugin sources; defaults to a `workflow-plugins` dir next to the store. */
  pluginCacheDir?: string
  /** nd-core `git.exec` in desktop production; omitted only by suites with a raw test seam. */
  git?: GitExecRunner
}

/** Install/enable/refresh pipeline for external workflow plugins (mirror mode pilot). */
export class WorkflowService {
  private readonly cli: WorkflowCliClient
  private readonly clock: () => number
  private readonly pluginCacheDir: string

  constructor(private readonly options: WorkflowServiceOptions) {
    this.cli = options.cli ?? new WorkflowCliClient()
    this.clock = options.clock ?? Date.now
    this.pluginCacheDir = options.pluginCacheDir ?? join(options.store.filePath, '..', 'workflow-plugins')
  }

  async state(): Promise<WorkflowPluginsState> {
    return this.options.store.state()
  }

  /**
   * Install a reviewed plugin package on demand. Local sources point at a
   * checked-out plugin bundle; git sources are cloned into ND's cache and
   * detached at the pinned ref so provenance is a recorded commit, not a
   * moving branch.
   */
  async install(source: WorkflowPluginInstallSource): Promise<WorkflowPluginsState> {
    if (!source || typeof source !== 'object') throw new Error('Workflow plugin install source is required')
    if (source.kind === 'local') {
      const manifestPath = await requireLocalManifest(source.path)
      const manifest = parseWorkflowPluginManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')))
      const provenance = await gitProvenance(source.path, this.options.git)
      await this.options.store.upsertPlugin(manifest, {
        kind: 'local',
        path: resolve(source.path),
        ...(provenance.remote ? { gitRemote: provenance.remote } : {}),
        ...(provenance.head ? { gitHead: provenance.head } : {}),
        ...(provenance.dirty !== undefined ? { gitDirty: provenance.dirty } : {}),
      }, this.clock())
      return this.state()
    }
    if (source.kind === 'git') {
      const url = requireGitUrl(source.url)
      const ref = source.ref === undefined ? undefined : requireGitRef(source.ref)
      const stagingDir = join(this.cacheRoot(), `.staging-${randomUUID()}`)
      const clone = await cloneWorkflowPluginSource(url, ref, stagingDir, this.options.git)
      try {
        const manifestPath = await locatePluginManifest(stagingDir)
        if (!manifestPath) throw new Error('The cloned plugin repository does not contain an nd-plugin.json manifest this ND host recognizes')
        const manifest = parseWorkflowPluginManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')))
        const finalDir = join(this.cacheRoot(), manifest.id)
        await fs.rm(finalDir, { recursive: true, force: true })
        await fs.rename(stagingDir, finalDir).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EPERM' && error.code !== 'EEXIST') throw error
          // Windows can refuse to rename a freshly used directory; fall back to copy.
          await fs.cp(stagingDir, finalDir, { recursive: true })
          await fs.rm(stagingDir, { recursive: true, force: true })
        })
        await this.options.store.upsertPlugin(manifest, {
          kind: 'git',
          url,
          ...(ref ? { ref } : {}),
          ...(clone.resolvedSha ? { resolvedSha: clone.resolvedSha } : {}),
          localPath: finalDir,
        }, this.clock())
        return this.state()
      } finally {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    throw new Error('Unsupported workflow plugin install source')
  }

  /** Uninstalling a plugin revokes its bindings and board state immediately; project files are untouched. */
  async remove(pluginId: string): Promise<WorkflowPluginsState> {
    await this.options.store.removePlugin(requireId(pluginId, 'Plugin id'))
    return this.state()
  }

  /** Detection preview for the bound project root; never enables anything by itself. */
  async detect(companyId: string, projectId: string, pluginId?: string): Promise<WorkflowDetectionPreview[]> {
    const root = await this.requireProjectRoot(companyId, projectId)
    const candidates = await this.candidatePlugins(pluginId)
    const previews: WorkflowDetectionPreview[] = []
    for (const plugin of candidates) {
      try {
        const result = await this.cli.run(root, 'detect', plugin.manifest)
        previews.push({
          pluginId: plugin.id,
          pluginVersion: plugin.version,
          supported: result.detection?.supported === true,
          ...(result.detection?.config ? { config: result.detection.config } : {}),
          diagnostics: result.envelope.diagnostics,
        })
      } catch (error) {
        previews.push({
          pluginId: plugin.id,
          pluginVersion: plugin.version,
          supported: false,
          diagnostics: [],
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return previews
  }

  /** Enable Mirror mode for one company/project/plugin. Installation alone never activates anything. */
  async enable(companyId: string, projectId: string, pluginId: string): Promise<WorkflowPluginsState> {
    const project = await this.requireProject(companyId, projectId)
    const plugin = await this.options.store.getPlugin(requireId(pluginId, 'Plugin id'))
    if (!plugin) throw new Error('This workflow plugin is not installed; install it first')
    const root = await requireExistingRoot(project.workspacePath)
    let detection
    try {
      detection = await this.cli.run(root, 'detect', plugin.manifest)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`The workflow plugin did not detect a compatible workflow: ${reason}`)
    }
    if (detection.detection?.supported !== true) {
      throw new Error('The workflow plugin did not detect a compatible workflow in this project; run detection for details')
    }
    const provenance = await gitProvenance(root, this.options.git)
    const now = this.clock()
    const existing = await this.options.store.getBinding(companyId, projectId, plugin.id)
    const workflowContribution = plugin.manifest.contributions.find((item) => item.kind === 'workflow')
    const binding: ProjectWorkflowBinding = {
      version: 1,
      companyId,
      projectId,
      pluginId: plugin.id,
      pluginVersion: plugin.version,
      contributionId: workflowContribution?.id ?? plugin.id,
      mode: 'mirror',
      contextEnabled: false,
      root,
      source: {
        ...(provenance.remote ? { remote: provenance.remote } : {}),
        ...(provenance.branch ? { branch: provenance.branch } : {}),
        ...(provenance.head ? { head: provenance.head } : {}),
        ...(provenance.dirty !== undefined ? { dirty: provenance.dirty } : {}),
      },
      ...(detection.detection.config ? { config: detection.detection.config } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      validatedAt: now,
    }
    await this.options.store.putBinding(binding)
    return this.state()
  }

  /** Disabling revokes the binding immediately; the last snapshot is kept as history but is no longer active. */
  async disable(companyId: string, projectId: string, pluginId?: string): Promise<WorkflowPluginsState> {
    const bindings = (await this.options.store.state()).bindings
      .filter((item) => item.companyId === companyId && item.projectId === projectId && (!pluginId || item.pluginId === pluginId))
    for (const binding of bindings) {
      await this.options.store.removeBinding(companyId, projectId, binding.pluginId)
    }
    return this.state()
  }

  /**
   * Refresh reads one selected source checkout and publishes an atomic
   * snapshot. Failures keep the last valid snapshot marked stale; nothing is
   * invented and no project command is executed.
   */
  async refresh(companyId: string, projectId: string): Promise<WorkflowPluginsState> {
    const binding = await this.options.store.getBinding(companyId, projectId)
    if (!binding) throw new Error('This project has no enabled workflow integration')
    const key = { companyId, projectId, pluginId: binding.pluginId }
    const plugin = await this.options.store.getPlugin(binding.pluginId)
    const failStale = async (message: string): Promise<WorkflowPluginsState> => {
      const previous = await this.options.store.getSnapshot(companyId, projectId, binding.pluginId)
      await this.options.store.putSnapshot(key, previous
        ? { ...previous, stale: true, lastError: message }
        : {
            version: 1,
            scannedAt: new Date(this.clock()).toISOString(),
            git: { available: false, dirty: false },
            stale: true,
            lastError: message,
            tasks: [],
            prds: [],
            diagnostics: [{ severity: 'error', code: 'refresh_failed', message }],
          })
      return this.state()
    }
    const project = await this.findProject(companyId, projectId)
    if (!project) return failStale('The bound project no longer exists in this company')
    const root = await safeRealpath(project.workspacePath).catch(() => undefined)
    if (!root || root !== binding.root) return failStale('The project workspace moved; re-validate the workflow binding to continue mirroring')
    if (!plugin) return failStale('The workflow plugin for this binding is no longer installed')
    if (binding.pluginVersion !== plugin.version) return failStale(`The installed plugin version ${plugin.version} differs from the bound version ${binding.pluginVersion}; re-enable the integration to continue`)
    try {
      const result = await this.cli.run(root, 'readSnapshot', plugin.manifest)
      if (!result.snapshot) throw new WorkflowCliError('envelope-invalid', 'Workflow CLI returned no snapshot payload')
      await this.options.store.putSnapshot(key, result.snapshot)
      return this.state()
    } catch (error) {
      return failStale(error instanceof Error ? error.message : String(error))
    }
  }

  /** Resolve one project's workflow view; paths and ownership are resolved here, never in the renderer. */
  async projectView(companyId: string, projectId: string): Promise<WorkflowProjectView> {
    await this.requireProject(companyId, projectId)
    const binding = await this.options.store.getBinding(companyId, projectId)
    const state = await this.options.store.state()
    if (!binding) {
      const snapshot = state.snapshots.find((entry) => entry.key.companyId === companyId && entry.key.projectId === projectId)?.snapshot
      return snapshot ? { snapshot, disconnected: true } : {}
    }
    const snapshot = state.snapshots.find((entry) => workflowSnapshotKeyId(entry.key) === workflowSnapshotKeyId({ companyId, projectId, pluginId: binding.pluginId }))?.snapshot
    const plugin = state.plugins.find((item) => item.id === binding.pluginId)
    return {
      binding,
      ...(snapshot ? { snapshot } : {}),
      ...(plugin ? {} : { pluginMissing: true }),
    }
  }

  private async candidatePlugins(pluginId?: string): Promise<InstalledWorkflowPlugin[]> {
    const { plugins } = await this.options.store.state()
    const filtered = pluginId ? plugins.filter((item) => item.id === pluginId) : plugins
    if (pluginId && filtered.length === 0) throw new Error('This workflow plugin is not installed; install it first')
    return filtered
  }

  private async findProject(companyId: string, projectId: string): Promise<Project | undefined> {
    const state = await this.options.organization.state()
    return state.projects.find((item) => item.id === projectId && item.companyId === companyId)
  }

  private async requireProject(companyId: string, projectId: string): Promise<Project> {
    const project = await this.findProject(companyId, projectId)
    if (!project) throw new Error('Project not found in this company')
    return project
  }

  /** The renderer never supplies filesystem roots; the project record is the only source. */
  private async requireProjectRoot(companyId: string, projectId: string): Promise<string> {
    const project = await this.requireProject(companyId, projectId)
    return requireExistingRoot(project.workspacePath)
  }

  private cacheRoot(): string {
    if (isAbsolute(this.pluginCacheDir) && !this.pluginCacheDir.includes('..')) return this.pluginCacheDir
    return resolve(this.pluginCacheDir)
  }
}

async function requireLocalManifest(path: string): Promise<string> {
  if (typeof path !== 'string' || !path.trim() || path.length > 1_024) throw new Error('Plugin bundle path is required')
  if (!isAbsolute(path)) throw new Error('Plugin bundle path must be absolute')
  const stat = await fs.stat(path).catch(() => undefined)
  if (!stat?.isDirectory()) throw new Error('Plugin bundle path must be an existing directory')
  const manifestPath = await locatePluginManifest(path)
  if (!manifestPath) throw new Error('No nd-plugin.json manifest found in this plugin bundle')
  return manifestPath
}

function requireGitUrl(url: string): string {
  if (typeof url !== 'string' || !url.trim() || url.length > 512) throw new Error('Repository URL is required')
  const trimmed = url.trim()
  const https = /^https:\/\/[^\s]+$/i
  const ssh = /^git@[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+$/
  if (!https.test(trimmed) && !ssh.test(trimmed)) throw new Error('Repository URL must be an https:// or git@ URL')
  return trimmed
}

function requireGitRef(ref: string): string {
  if (typeof ref !== 'string' || !ref.trim() || ref.length > 256) throw new Error('Pinned ref must be a commit SHA or branch name')
  const trimmed = ref.trim()
  if (trimmed.startsWith('-') || trimmed.includes('..') || /\s/.test(trimmed)) throw new Error('Pinned ref contains unsupported characters')
  return trimmed
}

function requireId(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error(`${label} is required`)
  return value.trim()
}

async function requireExistingRoot(workspacePath: string | undefined): Promise<string> {
  const root = await safeRealpath(workspacePath)
  if (!root) throw new Error('This project has no linked workspace folder; link one before enabling a workflow integration')
  return root
}

async function safeRealpath(path: string | undefined): Promise<string | undefined> {
  if (!path || !isAbsolute(path)) return undefined
  try {
    return await fs.realpath(path)
  } catch {
    return undefined
  }
}
