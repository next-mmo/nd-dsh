import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrganizationStore } from '../src/main/organization/store.js'

async function storeFixture(): Promise<OrganizationStore> {
  const dir = await mkdtemp(join(tmpdir(), 'nd-dsh-org-'))
  return new OrganizationStore(join(dir, 'organization.json'))
}

describe('OrganizationStore', () => {
  it('persists trusted verification metadata independently and rejects writes outside active execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nd-trusted-verification-'))
    const path = join(directory, 'organization.json')
    const store = new OrganizationStore(path)
    const company = (await store.mutate({ type: 'company.create', name: 'Verification', mission: 'Check exact evidence' })).companies[0]!
    const project = (await store.mutate({ type: 'project.create', companyId: company.id, name: 'Package', objective: 'Ship' })).projects[0]!
    const task = (await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Manifest', description: 'Create manifest' })).tasks[0]!
    const run = await store.beginRun('task-execution', company.id, project.id, 'worker', task.id)
    const evidence = { status: 'passed' as const, completedAt: 123, command: 'node --test', cwd: '/task', checkpointCommit: 'checkpoint', exitCode: 0 }
    await store.recordRunVerification(run.id, evidence)
    evidence.command = 'mutated after recording'
    await store.completeRun(run.id, 'Untrusted prose '.repeat(5_000))
    const restored = new OrganizationStore(path)
    expect((await restored.state()).runs.find((item) => item.id === run.id)?.verification).toMatchObject({ command: 'node --test', checkpointCommit: 'checkpoint', status: 'passed' })
    await expect(restored.recordRunVerification(run.id, evidence)).rejects.toThrow('active task execution')
    const review = await restored.beginRun('task-review', company.id, project.id, 'reviewer', task.id)
    await expect(restored.recordRunVerification(review.id, evidence)).rejects.toThrow('active task execution')
  })
  it('persists delivery scope and queue order, keeps dependencies authoritative, and waits at milestone completion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nd-delivery-scope-'))
    const path = join(dir, 'organization.json')
    const store = new OrganizationStore(path)
    const company = (await store.mutate({ type: 'company.create', name: 'Delivery', mission: 'Ship a useful slice' })).companies[0]!
    const project = (await store.mutate({ type: 'project.create', companyId: company.id, name: 'Desk', objective: 'Create a ticket' })).projects[0]!
    await store.applyPlan(project.id, { goal: { title: 'MVP', description: 'Persist a ticket' }, milestones: [
      { title: 'First ticket', description: 'Create and reload', tasks: [
        { title: 'Form', description: 'Build form', priority: 'high' },
        { title: 'Storage', description: 'Persist', priority: 'low' },
        { title: 'Reload test', description: 'Verify reload', dependsOn: ['Storage'], priority: 'critical' },
      ] },
      { title: 'Search', description: 'Find tickets', tasks: [{ title: 'Search box', description: 'Search', priority: 'critical' }] },
    ] })
    let state = await store.state()
    const milestone = state.milestones[0]!
    const form = state.tasks.find((task) => task.title === 'Form')!
    const storage = state.tasks.find((task) => task.title === 'Storage')!
    const reload = state.tasks.find((task) => task.title === 'Reload test')!
    expect(state.projects[0]?.deliveryMilestoneId).toBe(milestone.id)
    expect((await store.readyTasks(project.id)).map((task) => task.title)).toEqual(['Form', 'Storage'])
    await store.mutate({ type: 'task.reorder', projectId: project.id, milestoneId: milestone.id, taskIds: [reload.id, storage.id, form.id] })
    expect((await store.readyTasks(project.id)).map((task) => task.title)).toEqual(['Storage', 'Form'])
    const restored = new OrganizationStore(path)
    expect((await restored.state()).projects[0]?.deliveryMilestoneId).toBe(milestone.id)
    expect((await restored.readyTasks(project.id)).map((task) => task.title)).toEqual(['Storage', 'Form'])
    for (const task of [storage, reload, form]) {
      await restored.markExecution(task.id, `session-${task.id}`)
      await restored.markForReview(task.id, 'Actual delivery')
      await restored.completeReview(task.id, true, 'Verified')
    }
    state = await restored.state()
    expect(state.milestones[0]?.status).toBe('completed')
    expect(state.projects[0]?.deliveryMilestoneId).toBe(milestone.id)
    expect(await restored.nextReadyTask(project.id)).toBeUndefined()
    await restored.mutate({ type: 'project.update', id: project.id, patch: { deliveryMilestoneId: state.milestones[1]!.id } })
    expect((await restored.nextReadyTask(project.id))?.title).toBe('Search box')
    await restored.mutate({ type: 'project.update', id: project.id, patch: { deliveryMilestoneId: '' } })
    expect((await restored.state()).projects[0]?.deliveryMilestoneId).toBeUndefined()
  })

  it('rejects foreign milestones and invalid reorder lists without partially changing the queue', async () => {
    const store = await storeFixture()
    const company = (await store.mutate({ type: 'company.create', name: 'Scoped', mission: 'Keep work scoped' })).companies[0]!
    const first = (await store.mutate({ type: 'project.create', companyId: company.id, name: 'First', objective: 'Build' })).projects[0]!
    const second = (await store.mutate({ type: 'project.create', companyId: company.id, name: 'Second', objective: 'Build' })).projects[1]!
    const milestone = (await store.mutate({ type: 'milestone.create', projectId: first.id, title: 'MVP', description: 'Save one record' })).milestones[0]!
    const state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: first.id, milestoneId: milestone.id, title: 'Save', description: 'Implement' })
    const task = state.tasks[0]!
    expect(task.goalId).toBe(milestone.goalId)
    await expect(store.mutate({ type: 'project.update', id: second.id, patch: { deliveryMilestoneId: milestone.id } })).rejects.toThrow(/milestone.*project/i)
    await expect(store.mutate({ type: 'task.create', companyId: company.id, projectId: second.id, milestoneId: milestone.id, title: 'Leak', description: 'Invalid' })).rejects.toThrow(/milestone.*project/i)
    await expect(store.mutate({ type: 'task.reorder', projectId: first.id, milestoneId: milestone.id, taskIds: [task.id, task.id] })).rejects.toThrow(/exactly once/i)
    await expect(store.mutate({ type: 'task.reorder', projectId: first.id, milestoneId: milestone.id, taskIds: [] })).rejects.toThrow(/exactly once/i)
    await expect(store.mutate({ type: 'task.reorder', projectId: second.id, milestoneId: milestone.id, taskIds: [task.id] })).rejects.toThrow(/milestone.*project/i)
    expect((await store.state()).tasks[0]?.queueOrder).toBeUndefined()
    await store.markExecution(task.id, 'running')
    await expect(store.mutate({ type: 'task.update', id: task.id, patch: { milestoneId: '' } })).rejects.toThrow(/in progress/i)
  })

  it('keeps older projects without delivery scope dispatching all ready work and clears rank when moving a task', async () => {
    const store = await storeFixture()
    const company = (await store.mutate({ type: 'company.create', name: 'Legacy', mission: 'Keep compatibility' })).companies[0]!
    const project = (await store.mutate({ type: 'project.create', companyId: company.id, name: 'Existing', objective: 'Build' })).projects[0]!
    const unassigned = (await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Existing task', description: 'Build' })).tasks[0]!
    expect((await store.nextReadyTask(project.id))?.id).toBe(unassigned.id)
    const milestone = (await store.mutate({ type: 'milestone.create', projectId: project.id, title: 'MVP', description: 'Use it' })).milestones[0]!
    expect(await store.nextReadyTask(project.id)).toBeUndefined()
    await store.mutate({ type: 'task.reorder', projectId: project.id, taskIds: [unassigned.id] })
    const state = await store.mutate({ type: 'task.update', id: unassigned.id, patch: { milestoneId: milestone.id } })
    expect(state.tasks[0]?.queueOrder).toBeUndefined()
    expect(state.tasks[0]?.goalId).toBe(milestone.goalId)
    expect((await store.nextReadyTask(project.id))?.id).toBe(unassigned.id)
  })

  it('seeds an isolated AI company with workforce, skills, workflow, and safe policies', async () => {
    const store = await storeFixture()
    const a = await store.mutate({ type: 'company.create', name: 'Company A', mission: 'Build A' })
    const companyA = a.companies[0]!
    expect(a.roles.filter((item) => item.companyId === companyA.id).map((item) => item.name)).toEqual(expect.arrayContaining(['Product Manager', 'Software Engineer', 'Reviewer', 'Researcher']))
    expect(a.teams.filter((item) => item.companyId === companyA.id)).toHaveLength(3)
    expect(a.agents.filter((item) => item.companyId === companyA.id)).toHaveLength(4)
    expect(a.skills.filter((item) => item.scope === 'builtin').length).toBeGreaterThanOrEqual(8)
    expect(a.workflows.find((item) => item.companyId === companyA.id)?.steps.map((item) => item.kind)).toEqual(['plan', 'execute', 'review'])
    expect(a.policies.find((item) => item.companyId === companyA.id && item.action === 'data.destructive')?.effect).toBe('deny')

    const b = await store.mutate({ type: 'company.create', name: 'Company B', mission: 'Build B' })
    const companyB = b.companies.find((item) => item.id !== companyA.id)!
    const withProject = await store.mutate({ type: 'project.create', companyId: companyB.id, name: 'B project', objective: 'Only B' })
    const projectB = withProject.projects.find((item) => item.companyId === companyB.id)!
    await expect(store.mutate({ type: 'skill.create', scope: 'project', companyId: companyA.id, projectId: projectB.id, name: 'Leak', description: 'bad', instructions: 'bad' })).rejects.toThrow(/company boundary/i)
  })

  it('materializes PM plans into dependency-aware assigned work and tracks milestones, review memory, and project progress', async () => {
    const store = await storeFixture()
    let state = await store.mutate({ type: 'company.create', name: 'Acme', mission: 'Ship software' })
    const company = state.companies[0]!
    const builder = state.agents.find((item) => item.companyId === company.id && item.name === 'Builder')!
    state = await store.mutate({ type: 'project.create', companyId: company.id, name: 'Product', objective: 'Launch v1' })
    const project = state.projects[0]!
    await store.applyPlan(project.id, {
      goal: { title: 'Launch', description: 'Launch v1 safely' },
      milestones: [{ title: 'Build', description: 'Build it', tasks: [
        { title: 'Foundation', description: 'Create foundation' },
        { title: 'Finish', description: 'Complete feature', dependsOn: ['Foundation'] },
      ] }],
    })
    state = await store.state()
    const first = state.tasks.find((item) => item.title === 'Foundation')!
    const second = state.tasks.find((item) => item.title === 'Finish')!
    expect(first.status).toBe('ready')
    expect(second.status).toBe('backlog')
    expect(second.dependsOn).toEqual([first.id])
    expect(first.assignedAgentId).toBe(builder.id)
    expect(second.assignedAgentId).toBe(builder.id)
    expect(state.projects[0]?.teamIds).toContain(builder.teamId)
    expect(state.milestones[0]?.status).toBe('active')

    await store.markExecution(first.id, 'worker-session')
    await store.markForReview(first.id, 'Implemented and tested')
    await store.markReviewStarted(first.id, 'review-session')
    await store.completeReview(first.id, true, 'Verified', [{ title: 'Lesson', content: 'Keep the contract stable', tags: ['review'] }])
    state = await store.state()
    expect(state.tasks.find((item) => item.id === first.id)?.status).toBe('completed')
    expect(state.tasks.find((item) => item.id === second.id)?.status).toBe('ready')
    expect(state.memory.some((item) => item.title === 'Lesson')).toBe(true)
    expect(state.memory.some((item) => item.title === 'Review: Foundation')).toBe(true)
    expect(state.projects[0]?.progress).toBe(50)
    expect(state.projects[0]?.status).toBe('active')
    expect(state.goals[0]?.progress).toBe(50)
    expect(state.milestones[0]?.status).toBe('active')
  })

  it('uses project workflows as the active execution policy', async () => {
    const store = await storeFixture()
    let state = await store.mutate({ type: 'company.create', name: 'Workflow Co', mission: 'Ship with explicit workflows' })
    const company = state.companies[0]!
    state = await store.mutate({ type: 'project.create', companyId: company.id, name: 'No review project', objective: 'Ship internal prototype' })
    const project = state.projects[0]!
    await store.mutate({ type: 'workflow.create', companyId: company.id, projectId: project.id, name: 'Execute only', steps: [{ id: 'execute', name: 'Execute', kind: 'execute' }] })
    const workflow = await store.workflowForProject(project.id)
    expect(workflow?.name).toBe('Execute only')
    expect(workflow?.steps.map((item) => item.kind)).toEqual(['execute'])
  })

  it('persists policies and organization state atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nd-dsh-org-persist-'))
    const path = join(dir, 'organization.json')
    const store = new OrganizationStore(path)
    let state = await store.mutate({ type: 'company.create', name: 'Persisted', mission: 'Remember everything' })
    const company = state.companies[0]!
    await store.mutate({ type: 'policy.set', companyId: company.id, action: 'production.deploy', effect: 'deny', description: 'No autonomous production deploys' })
    await store.mutate({ type: 'memory.add', companyId: company.id, title: 'Rule', content: 'Always review releases', tags: ['release'] })
    const reloaded = new OrganizationStore(path)
    state = await reloaded.state()
    expect(state.policies.find((item) => item.action === 'production.deploy')?.effect).toBe('deny')
    expect(state.memory.find((item) => item.title === 'Rule')?.content).toContain('review releases')
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1)
  })

  it('coalesces concurrent saves while keeping every awaited mutation durable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nd-dsh-org-coalesce-'))
    const path = join(dir, 'organization.json')
    const store = new OrganizationStore(path)
    const company = (await store.mutate({ type: 'company.create', name: 'Burst', mission: 'Save once' })).companies[0]!
    const snapshots: number[] = []
    store.setOnChanged((state) => snapshots.push(state.memory.length))

    const baseline = (await store.state()).memory.length
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      store.mutate({ type: 'memory.add', companyId: company.id, title: `Note ${index}`, content: 'burst' })))

    expect(snapshots.length).toBeLessThan(8)
    expect(snapshots.at(-1)).toBe(baseline + 8)
    const persisted = new OrganizationStore(path)
    expect((await persisted.state()).memory.filter((item) => item.content === 'burst')).toHaveLength(8)
  })

  it('stores project runtime fields and clears blank or invalid ones instead of persisting them', async () => {
    const store = await storeFixture()
    let state = await store.mutate({ type: 'company.create', name: 'Runtime Co', mission: 'Run the app under development' })
    const company = state.companies[0]!
    state = await store.mutate({
      type: 'project.create',
      companyId: company.id,
      name: 'Todo Beta',
      objective: 'Ship Todo',
      workspacePath: '/workspace/todo',
      startCommand: 'npm run dev',
      targetPort: 3000,
    })
    const project = state.projects[0]!
    expect(project.startCommand).toBe('npm run dev')
    expect(project.targetPort).toBe(3000)

    state = await store.mutate({
      type: 'project.update',
      id: project.id,
      patch: { startCommand: '   ', targetPort: 0, targetUrl: 'http://localhost:3000', healthCheckPath: '/healthz' },
    })
    const updated = state.projects.find((item) => item.id === project.id)!
    expect(updated.startCommand).toBeUndefined()
    expect(updated.targetPort).toBeUndefined()
    expect(updated.targetUrl).toBe('http://localhost:3000')
    expect(updated.healthCheckPath).toBe('/healthz')
  })

  it('rejects escaped or relative workspace paths before they can strand a project', async () => {
    const store = await storeFixture()
    const company = (await store.mutate({ type: 'company.create', name: 'Workspace Co', mission: 'Keep workspaces valid' })).companies[0]!

    await expect(store.mutate({
      type: 'project.create',
      companyId: company.id,
      name: 'Broken path',
      objective: 'Should not persist',
      workspacePath: 'C:Users\tbroken',
    })).rejects.toThrow(/control characters/i)

    await expect(store.mutate({
      type: 'project.create',
      companyId: company.id,
      name: 'Relative path',
      objective: 'Should not persist',
      workspacePath: 'examples/todo',
    })).rejects.toThrow(/must be absolute/i)
  })

  it('distributes independent same-role tasks by least-open-work without moving active work', async () => {
    const store = await storeFixture()
    let state = await store.mutate({ type: 'company.create', name: 'Parallel Co', mission: 'Distribute work fairly' })
    const company = state.companies[0]!
    const engineerRole = state.roles.find((item) => item.companyId === company.id && item.name === 'Software Engineer')!
    const builder = state.agents.find((item) => item.companyId === company.id && item.roleId === engineerRole.id)!
    await store.mutate({
      type: 'agent.create',
      companyId: company.id,
      name: 'Builder 2',
      roleId: engineerRole.id,
      ...(builder.teamId ? { teamId: builder.teamId } : {}),
    })
    state = await store.mutate({ type: 'project.create', companyId: company.id, name: 'Parallel app', objective: 'Ship parallel work' })
    const project = state.projects[0]!

    const planned = Array.from({ length: 7 }, (_, index) => ({
      title: `Independent ${index + 1}`,
      description: `Build independent slice ${index + 1}`,
      role: 'Software Engineer',
    }))
    await store.applyPlan(project.id, {
      goal: { title: 'Parallel goal', description: 'Balance independent work' },
      milestones: [{ title: 'Build', description: 'Build slices', tasks: planned }],
    })

    state = await store.state()
    const engineers = state.agents.filter((item) => item.companyId === company.id && item.roleId === engineerRole.id)
    const counts = engineers.map((agent) => state.tasks.filter((task) => task.assignedAgentId === agent.id).length)
    expect(engineers).toHaveLength(2)
    expect(Math.max(...counts)).toBeLessThanOrEqual(Math.ceil(planned.length / 2))
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)

    const active = state.tasks[0]!
    await store.markExecution(active.id, 'active-session')
    await expect(store.mutate({ type: 'task.update', id: active.id, patch: { assignedAgentId: engineers[1]!.id } }))
      .rejects.toThrow(/cannot reassign/i)
  })

  it('rotates idle reviewers after completed reviews', async () => {
    const store = await storeFixture()
    let state = await store.mutate({ type: 'company.create', name: 'Review Co', mission: 'Rotate independent reviews' })
    const company = state.companies[0]!
    const reviewerRole = state.roles.find((item) => item.companyId === company.id && item.name === 'Reviewer')!
    const firstReviewer = state.agents.find((item) => item.companyId === company.id && item.roleId === reviewerRole.id)!
    await store.mutate({ type: 'agent.update', id: firstReviewer.id, patch: { providerId: 'review-a', modelId: 'model-a' } })
    await store.mutate({
      type: 'agent.create', companyId: company.id, name: 'Reviewer 2', roleId: reviewerRole.id,
      providerId: 'review-b', modelId: 'model-b',
      ...(firstReviewer.teamId ? { teamId: firstReviewer.teamId } : {}),
    })
    state = await store.mutate({ type: 'project.create', companyId: company.id, name: 'Review app', objective: 'Review twice' })
    const project = state.projects[0]!
    await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Task 1', description: 'First' })
    await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Task 2', description: 'Second' })
    state = await store.state()
    const [task1, task2] = state.tasks

    const first = await store.reviewerForTask(task1!.id)
    expect(first.agent?.id).toBe(firstReviewer.id)
    await store.markReviewStarted(task1!.id, 'review-1', first.agent?.id)
    await store.completeReview(task1!.id, true, 'passed')

    const second = await store.reviewerForTask(task2!.id)
    expect(second.agent?.id).not.toBe(first.agent?.id)
  })

  it('releases one reviewer that settled two concurrent reviews out of order', async () => {
    const store = await storeFixture()
    let state = await store.mutate({ type: 'company.create', name: 'Concurrent Review Co', mission: 'Review several tasks at once' })
    const company = state.companies[0]!
    const reviewerRole = state.roles.find((item) => item.companyId === company.id && item.name === 'Reviewer')!
    const reviewer = state.agents.find((item) => item.companyId === company.id && item.roleId === reviewerRole.id)!
    state = await store.mutate({ type: 'project.create', companyId: company.id, name: 'Concurrent app', objective: 'Review in parallel' })
    const project = state.projects[0]!
    await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Task A', description: 'First' })
    await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Task B', description: 'Second' })
    state = await store.state()
    const [taskA, taskB] = state.tasks

    // A company with one Reviewer agent reaches this as soon as two tasks are in
    // review together: the same reviewer owns both runs at once.
    await store.markReviewStarted(taskA!.id, 'review-a', reviewer.id)
    await store.markReviewStarted(taskB!.id, 'review-b', reviewer.id)

    await store.completeReview(taskA!.id, true, 'passed')
    await store.completeReview(taskB!.id, true, 'passed')

    state = await store.state()
    // A reviewer left 'reviewing' is permanently deprioritised by pickReviewer,
    // so with one reviewer agent the company stops reviewing altogether.
    expect(state.agents.find((item) => item.id === reviewer.id)?.status).toBe('idle')
  })

  it('clears the review session of the reviewer that actually owns the task', async () => {
    const store = await storeFixture()
    let state = await store.mutate({ type: 'company.create', name: 'Retry Review Co', mission: 'Let a failed review retry' })
    const company = state.companies[0]!
    const reviewerRole = state.roles.find((item) => item.companyId === company.id && item.name === 'Reviewer')!
    const reviewer = state.agents.find((item) => item.companyId === company.id && item.roleId === reviewerRole.id)!
    state = await store.mutate({ type: 'project.create', companyId: company.id, name: 'Retry app', objective: 'Retry reviews' })
    const project = state.projects[0]!
    await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Task A', description: 'First' })
    await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Task B', description: 'Second' })
    state = await store.state()
    const [taskA, taskB] = state.tasks

    await store.markReviewStarted(taskA!.id, 'review-a', reviewer.id)
    await store.markReviewStarted(taskB!.id, 'review-b', reviewer.id)

    // Task A's review run failed; clearing it must free the reviewer so the
    // Review action can retry, even though the agent now points at task B.
    await store.clearReviewSession(taskA!.id)
    state = await store.state()
    expect(state.tasks.find((item) => item.id === taskA!.id)?.reviewSessionId).toBeUndefined()
    expect(state.agents.find((item) => item.id === reviewer.id)?.status).toBe('idle')
  })

  it('prefers a healthy reviewer route different from the worker route', async () => {
    const store = await storeFixture()
    let state = await store.mutate({ type: 'company.create', name: 'Route Co', mission: 'Keep review independent' })
    const company = state.companies[0]!
    const engineerRole = state.roles.find((item) => item.companyId === company.id && item.name === 'Software Engineer')!
    const reviewerRole = state.roles.find((item) => item.companyId === company.id && item.name === 'Reviewer')!
    const builder = state.agents.find((item) => item.companyId === company.id && item.roleId === engineerRole.id)!
    const firstReviewer = state.agents.find((item) => item.companyId === company.id && item.roleId === reviewerRole.id)!
    await store.mutate({ type: 'agent.update', id: builder.id, patch: { providerId: 'route-a', modelId: 'model-a' } })
    await store.mutate({ type: 'agent.update', id: firstReviewer.id, patch: { providerId: 'route-a', modelId: 'model-a' } })
    await store.mutate({
      type: 'agent.create', companyId: company.id, name: 'Independent Reviewer', roleId: reviewerRole.id,
      providerId: 'route-b', modelId: 'model-b',
      ...(firstReviewer.teamId ? { teamId: firstReviewer.teamId } : {}),
    })
    state = await store.mutate({ type: 'project.create', companyId: company.id, name: 'Route app', objective: 'Independent route' })
    const project = state.projects[0]!
    state = await store.mutate({
      type: 'task.create', companyId: company.id, projectId: project.id,
      title: 'Review route task', description: 'Needs route diversity', assignedAgentId: builder.id,
    })
    const task = state.tasks[0]!
    const reviewer = await store.reviewerForTask(task.id)
    expect(reviewer.agent?.providerId).toBe('route-b')
    expect(reviewer.agent?.modelId).toBe('model-b')
  })

})
