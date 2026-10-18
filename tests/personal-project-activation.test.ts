import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { OrganizationStore } from '../src/main/organization/store.js'
import { ProjectWorkspaceCoordinator } from '../src/main/workspace/project-workspace-coordinator.js'
import { PERSONAL_PROJECT_ID } from '../src/shared/organization.js'
import type { WorkspaceService } from '../src/main/workspace/workspace-service.js'
import type { HarnessService } from '../src/main/harness/harness-service.js'

describe('Personal Project Activation', () => {
  it('activates Personal project in store and protects it from removal', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'nd-personal-proj-test-'))
    const filePath = join(tempDir, 'org.json')
    try {
      const store = new OrganizationStore(filePath)

      const company = await store.mutate({ type: 'company.create', name: 'Acme', mission: 'Build things' })
      const companyId = company.companies[0]!.id

      const project = await store.mutate({ type: 'project.create', companyId, name: 'Project 1', objective: 'Objective' })
      const projectId = project.projects[0]!.id

      expect(project.activeProjectId).toBe(projectId)

      // Activate Personal
      const afterPersonal = await store.mutate({ type: 'project.activate', id: PERSONAL_PROJECT_ID })
      expect(afterPersonal.activeProjectId).toBe(PERSONAL_PROJECT_ID)

      // Attempting to remove Personal is rejected
      await expect(store.mutate({ type: 'project.remove', id: PERSONAL_PROJECT_ID })).rejects.toThrow(
        'Cannot remove the built-in Personal project'
      )

      // Activating company project again works
      const afterCompanyProject = await store.mutate({ type: 'project.activate', id: projectId })
      expect(afterCompanyProject.activeProjectId).toBe(projectId)
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('allows activating Personal project without pausing or disrupting active runs in other projects', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'nd-personal-coord-test-'))
    const filePath = join(tempDir, 'org.json')
    try {
      const store = new OrganizationStore(filePath)

      const company = await store.mutate({ type: 'company.create', name: 'Acme', mission: 'Build things' })
      const companyId = company.companies[0]!.id
      const project = await store.mutate({ type: 'project.create', companyId, name: 'Project 1', objective: 'Objective' })
      const projectId = project.projects[0]!.id

      // Inject a running run in Project 1
      const snapshot = await store.state()
      snapshot.runs.push({
        id: 'run-1',
        companyId,
        projectId,
        taskId: 'task-1',
        sessionId: 'session-1',
        kind: 'task-execution',
        status: 'running',
        startedAt: Date.now(),
      })

      let harnessClosed = false
      const mockHarness = {
        close: async () => { harnessClosed = true },
      } as unknown as HarnessService

      const mockWorkspace = {
        state: () => ({ binding: 'project', projectId, root: '/test/workspace' }),
        setContext: (ctx: unknown) => ctx,
      } as unknown as WorkspaceService

      const coordinator = new ProjectWorkspaceCoordinator(store, mockWorkspace, mockHarness)

      // Switching to Personal MUST NOT throw despite the active run in Project 1
      await expect(coordinator.assertCanMutate({ type: 'project.activate', id: PERSONAL_PROJECT_ID })).resolves.toBeUndefined()

      // afterOrganizationMutation MUST NOT close the harness or pause the run
      await coordinator.afterOrganizationMutation({ type: 'project.activate', id: PERSONAL_PROJECT_ID }, snapshot)
      expect(harnessClosed).toBe(false)
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('allows NdSkillService to collect catalog when Personal project is active', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'nd-personal-skills-test-'))
    const filePath = join(tempDir, 'org.json')
    try {
      const store = new OrganizationStore(filePath)
      await store.mutate({ type: 'project.activate', id: PERSONAL_PROJECT_ID })

      const { NdSkillService } = await import('../src/main/skills/nd-skill-service.js')
      const skillService = new NdSkillService({
        organization: store,
        workspace: { state: () => ({ root: tempDir }) },
        bundledRoot: tempDir,
      })

      const catalog = await skillService.catalog(PERSONAL_PROJECT_ID)
      expect(catalog).toBeDefined()
      expect(Array.isArray(catalog.skills)).toBe(true)
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
