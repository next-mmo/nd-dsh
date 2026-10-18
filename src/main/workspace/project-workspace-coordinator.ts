import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import type { WorkspaceRegistryView, WorkspaceState } from '../../shared/contracts.js'
import { PERSONAL_PROJECT_ID, type OrganizationMutation, type OrganizationSnapshot, type Project } from '../../shared/organization.js'
import type { HarnessService } from '../harness/harness-service.js'
import type { WorkspaceService } from './workspace-service.js'
import type { WorkspaceRegistry } from './workspace-registry.js'
import type { OrganizationStore } from '../organization/store.js'

const ACTIVE_CONTEXT_MUTATIONS = new Set<OrganizationMutation['type']>([
  'company.create',
  'company.activate',
  'project.create',
  'project.activate',
])

export class ProjectWorkspaceCoordinator {
  constructor(
    private readonly store: OrganizationStore,
    private readonly workspace: WorkspaceService,
    private readonly harness: HarnessService,
    private readonly workspaceRegistry?: WorkspaceRegistry,
    private readonly onContextChanged?: () => void,
  ) {}

  state(): WorkspaceState {
    return this.workspace.state()
  }

  async initialize(): Promise<WorkspaceState> {
    return this.syncToOrganization(await this.store.state(), false)
  }

  async assertCanMutate(mutation: OrganizationMutation): Promise<void> {
    if (mutation.type === 'project.activate' && mutation.id === PERSONAL_PROJECT_ID) {
      return
    }
    const state = await this.store.state()
    const changesActiveWorkspace = ACTIVE_CONTEXT_MUTATIONS.has(mutation.type)
      || (mutation.type === 'project.update'
        && mutation.patch.workspacePath !== undefined
        && state.activeProjectId === mutation.id)
      // Removing the project that owns the open workspace switches this window
      // to another project, so it obeys the same no-live-run rule.
      || (mutation.type === 'project.remove' && state.activeProjectId === mutation.id)
    if (!changesActiveWorkspace) return
    const active = state.runs.find((run) => run.status === 'running')
    if (active && !(mutation.type === 'project.activate' && mutation.id === active.projectId)) {
      throw new Error(`Cannot switch projects or workspaces while ${active.kind} is running. Cancel the active run first.`)
    }
  }

  async afterOrganizationMutation(mutation: OrganizationMutation, state: OrganizationSnapshot): Promise<WorkspaceState> {
    if (ACTIVE_CONTEXT_MUTATIONS.has(mutation.type)) {
      if (mutation.type === 'project.activate' && mutation.id === PERSONAL_PROJECT_ID) {
        this.onContextChanged?.()
        return this.workspace.state()
      }
      const next = await this.syncToOrganization(state, true)
      this.onContextChanged?.()
      return next
    }
    if (mutation.type === 'project.remove') {
      // The workspace context must stop naming a project that no longer exists.
      // Only the harness session bound to that project's folder is closed, so a
      // parallel run in another project keeps its gateway.
      const ownedOpenWorkspace = this.workspace.state().projectId === mutation.id
      const next = await this.syncToOrganization(state, ownedOpenWorkspace)
      this.onContextChanged?.()
      return next
    }
    if (mutation.type === 'project.update' && state.activeProjectId === mutation.id) {
      const next = await this.syncToOrganization(state, mutation.patch.workspacePath !== undefined)
      this.onContextChanged?.()
      return next
    }
    if (mutation.type === 'company.update' && state.activeCompanyId === mutation.id) {
      const next = await this.syncToOrganization(state, false)
      this.onContextChanged?.()
      return next
    }
    return this.workspace.state()
  }

  async pick(): Promise<WorkspaceState> {
    await this.assertNoRunningOrganizationRun('change workspace')
    const previous = this.workspace.state()
    await this.harness.close()
    const selected = await this.workspace.pick()
    if (selected.root === previous.root) return this.workspace.state()
    const next = await this.bindSelectedRoot(selected.root)
    this.onContextChanged?.()
    return next
  }

  async setRoot(path: string): Promise<WorkspaceState> {
    await this.assertNoRunningOrganizationRun('change workspace')
    await this.harness.close()
    const selected = await this.workspace.setRoot(path)
    const next = await this.bindSelectedRoot(selected.root)
    this.onContextChanged?.()
    return next
  }

  list(relativePath?: string) {
    return this.workspace.list(relativePath)
  }

  /**
   * Forget a saved workspace entry. Pruning the folder that is currently open is
   * allowed, but never while an organization run is working inside it.
   */
  async removeSavedWorkspace(id: string): Promise<WorkspaceRegistryView> {
    if (!this.workspaceRegistry) throw new Error('Workspace registry is unavailable')
    const entry = this.workspaceRegistry.get(id)
    if (!entry) throw new Error('Unknown saved workspace')
    const isOpenWorkspace = entry.root.replace(/[\\/]+$/, '') === this.workspace.state().root.replace(/[\\/]+$/, '')
    if (isOpenWorkspace) await this.assertNoRunningOrganizationRun('remove the workspace that is currently open')
    return this.workspaceRegistry.remove(id)
  }

  read(relativePath: string) {
    return this.workspace.read(relativePath)
  }

  suggest(query: string) {
    return this.workspace.suggest(query)
  }

  private async bindSelectedRoot(root: string): Promise<WorkspaceState> {
    const state = await this.store.state()
    const project = activeProject(state)
    const company = project ? state.companies.find((item) => item.id === project.companyId) : undefined
    if (!project || !company) {
      return this.workspace.setContext({ binding: 'standalone' })
    }

    const updated = await this.store.mutate({ type: 'project.update', id: project.id, patch: { workspacePath: root } })
    const updatedProject = activeProject(updated)
    const updatedCompany = updatedProject ? updated.companies.find((item) => item.id === updatedProject.companyId) : undefined
    return this.workspace.setContext({
      binding: 'project',
      ...(updatedProject ? {
        projectId: updatedProject.id,
        projectName: updatedProject.name,
        projectObjective: updatedProject.objective,
        projectStatus: updatedProject.status,
        projectWorkspacePath: root,
      } : {}),
      ...(updatedCompany ? { companyId: updatedCompany.id, companyName: updatedCompany.name, companyMission: updatedCompany.mission } : {}),
    })
  }

  private async syncToOrganization(state: OrganizationSnapshot, closeHarness: boolean): Promise<WorkspaceState> {
    const project = activeProject(state)
    const company = project ? state.companies.find((item) => item.id === project.companyId) : undefined
    if (!project || !company) return this.workspace.setContext({ binding: 'standalone' })

    const path = project.workspacePath?.trim()
    if (!path) {
      if (closeHarness) await this.harness.close()
      return this.workspace.setContext({
        binding: 'unlinked',
        companyId: company.id,
        companyName: company.name,
        companyMission: company.mission,
        projectId: project.id,
        projectName: project.name,
        projectObjective: project.objective,
        projectStatus: project.status,
        warning: `Project “${project.name}” has no workspace linked.`,
      })
    }

    let selectedPath = path
    let absolute = resolve(selectedPath)
    try {
      const stats = await fs.stat(absolute)
      if (!stats.isDirectory()) throw new Error('not a directory')
    } catch {
      const recovered = await this.workspaceRegistry?.findLegacyEscapedRoot(path)
      if (recovered) {
        absolute = resolve(recovered)
        try {
          const stats = await fs.stat(absolute)
          if (!stats.isDirectory()) throw new Error('not a directory')
          selectedPath = recovered
          // Persist only an exact match to a folder the user previously chose.
          await this.store.mutate({ type: 'project.update', id: project.id, patch: { workspacePath: recovered } })
        } catch {
          selectedPath = path
          absolute = resolve(path)
        }
      }
      if (selectedPath === path) {
        if (closeHarness) await this.harness.close()
        return this.workspace.setContext({
          binding: 'missing',
          companyId: company.id,
          companyName: company.name,
          companyMission: company.mission,
          projectId: project.id,
          projectName: project.name,
          projectObjective: project.objective,
          projectStatus: project.status,
          projectWorkspacePath: path,
          warning: `Project workspace is unavailable: ${path}`,
        })
      }
    }

    if (this.workspace.state().root !== absolute && closeHarness) await this.harness.close()
    if (this.workspace.state().root !== absolute) await this.workspace.setRoot(absolute)
    return this.workspace.setContext({
      binding: 'project',
      companyId: company.id,
      companyName: company.name,
      companyMission: company.mission,
      projectId: project.id,
      projectName: project.name,
      projectObjective: project.objective,
      projectStatus: project.status,
      projectWorkspacePath: absolute,
    })
  }

  private async assertNoRunningOrganizationRun(action: string): Promise<void> {
    const active = (await this.store.state()).runs.find((run) => run.status === 'running')
    if (active) throw new Error(`Cannot ${action} while ${active.kind} is running. Cancel the active run first.`)
  }
}

function activeProject(state: OrganizationSnapshot): Project | undefined {
  if (!state.activeProjectId) return undefined
  return state.projects.find((project) => project.id === state.activeProjectId)
}
