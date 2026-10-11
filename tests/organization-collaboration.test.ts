import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrganizationStore } from '../src/main/organization/store.js'
import { hasMemberCapability, resolveMemberCapabilities } from '../src/shared/organization.js'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'nd-org-collaboration-'))
  temporary.push(dir)
  const path = join(dir, 'organization.json')
  const store = new OrganizationStore(path)
  let state = await store.mutate({ type: 'company.create', name: 'Taxi Co', mission: 'Ship with a real local team' })
  const company = state.companies[0]!
  state = await store.mutate({ type: 'project.create', companyId: company.id, name: 'Taxi App', objective: 'Ship MVP', workspacePath: dir })
  return { path, store, company, project: state.projects[0]!, owner: (state.members ?? [])[0]! }
}

describe('local team collaboration', () => {
  it('seeds a local human member and persists project/task discussion across restart', async () => {
    const { path, store, company, project, owner } = await fixture()
    let state = await store.mutate({ type: 'member.create', companyId: company.id, displayName: 'Dara', title: 'Product Lead' })
    const dara = (state.members ?? []).find((item) => item.displayName === 'Dara')!
    state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Payments', description: 'Implement payment flow' })
    const task = state.tasks[0]!

    await store.mutate({
      type: 'collaboration.message.add',
      companyId: company.id,
      projectId: project.id,
      authorMemberId: owner.id,
      body: 'Project kickoff. @Dara please review payments.',
      mentionActorIds: [dara.id],
    })
    await store.mutate({
      type: 'collaboration.message.add',
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      authorMemberId: dara.id,
      body: 'Use the existing payment callback contract.',
    })

    const reloaded = new OrganizationStore(path)
    state = await reloaded.state()
    expect((state.members ?? []).map((item) => item.displayName)).toEqual(expect.arrayContaining(['Owner', 'Dara']))
    expect(state.messages ?? []).toHaveLength(2)
    expect((state.messages ?? []).find((item) => item.taskId === task.id)?.body).toContain('payment callback')
    expect((state.messages ?? [])[0]?.mentionActorIds).toContain(dara.id)
    expect(JSON.parse(await readFile(path, 'utf8')).messages).toHaveLength(2)
  })

  it('records decisions with explicit supersession history', async () => {
    const { store, company, project, owner } = await fixture()
    let state = await store.mutate({
      type: 'decision.create',
      companyId: company.id,
      projectId: project.id,
      authorMemberId: owner.id,
      title: 'Database',
      summary: 'Use SQLite for local collaboration.',
      rationale: 'The local milestone must not require a server.',
    })
    const first = (state.decisions ?? [])[0]!
    state = await store.mutate({
      type: 'decision.supersede',
      id: first.id,
      authorMemberId: owner.id,
      title: 'Database',
      summary: 'Keep SQLite behind a repository abstraction.',
      rationale: 'This preserves a future sync/storage migration path.',
    })
    expect((state.decisions ?? []).find((item) => item.id === first.id)?.status).toBe('superseded')
    expect((state.decisions ?? []).find((item) => item.supersedesDecisionId === first.id)?.status).toBe('active')
  })

  it('never treats friendly chat as approval and binds explicit approval to the exact checkpoint', async () => {
    const { store, company, project, owner } = await fixture()
    let state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Callback', description: 'Fix callback' })
    const task = state.tasks[0]!
    const run = await store.beginRun('task-execution', company.id, project.id, 'session-1', task.id, undefined, {
      parallelTask: true,
      engineId: 'nd-native',
      workspaceKind: 'git-worktree',
      workspaceRoot: '/tmp/task',
      baselineCommit: 'base',
    })
    await store.updateRunProvenance(run.id, { checkpointCommit: 'checkpoint-a' })

    await store.mutate({
      type: 'collaboration.message.add',
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      authorMemberId: owner.id,
      body: 'looks good 👍',
    })
    expect((await store.state()).approvalRequests ?? []).toHaveLength(0)

    state = await store.mutate({
      type: 'approval.request',
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      requesterMemberId: owner.id,
      targetKind: 'task-review',
      targetId: task.id,
    })
    const request = (state.approvalRequests ?? [])[0]!
    expect(request.targetRevision).toBe('checkpoint-a')

    await store.updateRunProvenance(run.id, { checkpointCommit: 'checkpoint-b' })
    expect(((await store.state()).approvalRequests ?? [])[0]?.status).toBe('cancelled')
    await expect(store.mutate({ type: 'approval.resolve', id: request.id, actorMemberId: owner.id, verdict: 'approve' }))
      .rejects.toThrow(/no longer pending/i)
    await expect(store.mutate({
      type: 'approval.request',
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      requesterMemberId: owner.id,
      targetKind: 'task-review',
      targetId: task.id,
      targetRevision: 'checkpoint-a',
    })).rejects.toThrow(/stale/i)
  })

  it('fails closed when an integration approval is requested or resolved after merge-back', async () => {
    const { store, company, project, owner } = await fixture()
    let state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Merged task', description: 'Checkpoint then integrate' })
    const task = state.tasks[0]!
    const run = await store.beginRun('task-execution', company.id, project.id, 'session-integrated', task.id, undefined, {
      parallelTask: true,
      engineId: 'nd-native',
      workspaceKind: 'git-worktree',
      workspaceRoot: '/tmp/task-integrated',
      baselineCommit: 'base',
    })
    await store.updateRunProvenance(run.id, { checkpointCommit: 'checkpoint-integrated' })

    state = await store.mutate({
      type: 'approval.request',
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      requesterMemberId: owner.id,
      targetKind: 'integration',
      targetId: task.id,
    })
    const pending = (state.approvalRequests ?? [])[0]!
    await store.markIntegrated(task.id, 'checkpoint-integrated')
    expect(((await store.state()).approvalRequests ?? []).find((item) => item.id === pending.id)?.status).toBe('cancelled')

    await expect(store.mutate({ type: 'approval.resolve', id: pending.id, actorMemberId: owner.id, verdict: 'request_changes' }))
      .rejects.toThrow(/no longer pending/i)

    await expect(store.mutate({
      type: 'approval.request',
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      requesterMemberId: owner.id,
      targetKind: 'integration',
      targetId: task.id,
    })).rejects.toThrow(/already integrated/i)
  })

  it('rejects forged task approval targets and invented checkpoints', async () => {
    const { store, company, project, owner } = await fixture()
    let state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Uncheckpointed', description: 'No run yet' })
    const task = state.tasks[0]!

    await expect(store.mutate({
      type: 'approval.request',
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      requesterMemberId: owner.id,
      targetKind: 'task-review',
      targetId: task.id,
      targetRevision: 'invented',
    })).rejects.toThrow(/real task checkpoint/i)

    const run = await store.beginRun('task-execution', company.id, project.id, 'session-binding', task.id, undefined, {
      parallelTask: true,
      engineId: 'nd-native',
      workspaceKind: 'git-worktree',
      workspaceRoot: '/tmp/task-binding',
      baselineCommit: 'base',
    })
    await store.updateRunProvenance(run.id, { checkpointCommit: 'real-checkpoint' })
    await expect(store.mutate({
      type: 'approval.request',
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      requesterMemberId: owner.id,
      targetKind: 'integration',
      targetId: 'different-task',
    })).rejects.toThrow(/targetId must match taskId/i)
  })

  it('records explicit human verdicts independently from agent review state', async () => {
    const { store, company, project, owner } = await fixture()
    let state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'UI', description: 'Polish team view' })
    const task = state.tasks[0]!
    const run = await store.beginRun('task-execution', company.id, project.id, 'session-2', task.id, undefined, {
      parallelTask: true,
      engineId: 'nd-native',
      workspaceKind: 'git-worktree',
      workspaceRoot: '/tmp/task-ui',
      baselineCommit: 'base',
    })
    await store.updateRunProvenance(run.id, { checkpointCommit: 'ui-123' })
    state = await store.mutate({
      type: 'approval.request',
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      requesterMemberId: owner.id,
      targetKind: 'integration',
      targetId: task.id,
    })
    const request = (state.approvalRequests ?? [])[0]!
    state = await store.mutate({
      type: 'approval.resolve',
      id: request.id,
      actorMemberId: owner.id,
      verdict: 'request_changes',
      comment: 'Tighten the empty state before integration.',
    })
    expect((state.approvalRequests ?? [])[0]?.status).toBe('changes_requested')
    expect((state.approvalVerdicts ?? [])[0]).toMatchObject({ verdict: 'request_changes', actor: { kind: 'human', id: owner.id } })
    expect(state.tasks[0]?.status).toBe('ready')
  })

  it('supports member access roles, capability resolution, and scoped grants', async () => {
    const { store, company, project, owner } = await fixture()
    expect(owner.accessRole).toBe('owner')
    expect(hasMemberCapability(owner, 'company.admin')).toBe(true)
    expect(hasMemberCapability(owner, 'task.assign')).toBe(true)

    let state = await store.mutate({
      type: 'member.create',
      companyId: company.id,
      displayName: 'Alex PM',
      title: 'Project Lead',
      accessRole: 'pm',
    })
    const pm = (state.members ?? []).find((m) => m.displayName === 'Alex PM')!
    expect(pm.accessRole).toBe('pm')
    expect(hasMemberCapability(pm, 'project.manage')).toBe(true)
    expect(hasMemberCapability(pm, 'task.create')).toBe(true)
    expect(hasMemberCapability(pm, 'task.assign')).toBe(true)
    expect(hasMemberCapability(pm, 'company.admin')).toBe(false)

    state = await store.mutate({
      type: 'member.create',
      companyId: company.id,
      displayName: 'Sam Reviewer',
      accessRole: 'reviewer',
    })
    const reviewer = (state.members ?? []).find((m) => m.displayName === 'Sam Reviewer')!
    expect(reviewer.accessRole).toBe('reviewer')
    expect(hasMemberCapability(reviewer, 'review.approve')).toBe(true)
    expect(hasMemberCapability(reviewer, 'content.read')).toBe(true)
    expect(hasMemberCapability(reviewer, 'task.create')).toBe(false)

    state = await store.mutate({
      type: 'member.create',
      companyId: company.id,
      displayName: 'Pat Guest',
      accessRole: 'guest',
    })
    const guest = (state.members ?? []).find((m) => m.displayName === 'Pat Guest')!
    expect(hasMemberCapability(guest, 'content.read')).toBe(true)
    expect(hasMemberCapability(guest, 'content.write')).toBe(false)
    expect(hasMemberCapability(guest, 'task.execute')).toBe(false)

    // Custom capability grant and project grant
    state = await store.mutate({
      type: 'member.update',
      id: guest.id,
      patch: {
        capabilities: ['content.read', 'content.write'],
        projectGrants: [{ projectId: project.id, role: 'contributor' }],
      },
    })
    const updatedGuest = (state.members ?? []).find((m) => m.id === guest.id)!
    expect(hasMemberCapability(updatedGuest, 'content.write')).toBe(true)
    expect(hasMemberCapability(updatedGuest, 'task.create', project.id)).toBe(true)
  })

  it('supports mixed human + agent task assignments, task.reassign with audit handoffs', async () => {
    const { store, company, project, owner } = await fixture()
    const agent = (await store.state()).agents[0]!
    let state = await store.mutate({
      type: 'member.create',
      companyId: company.id,
      displayName: 'Maya Builder',
      accessRole: 'contributor',
    })
    const maya = (state.members ?? []).find((m) => m.displayName === 'Maya Builder')!

    state = await store.mutate({
      type: 'task.create',
      companyId: company.id,
      projectId: project.id,
      title: 'Design Checkout Flow',
      description: 'Implement responsive checkout modal',
      assigneeKind: 'agent',
      assignedAgentId: agent.id,
      accountableMemberId: owner.id,
    })
    const task = state.tasks[0]!
    expect(task.assigneeKind).toBe('agent')
    expect(task.assignedAgentId).toBe(agent.id)
    expect(task.accountableMemberId).toBe(owner.id)

    // Reassign from Agent to Human
    state = await store.mutate({
      type: 'task.reassign',
      taskId: task.id,
      assignee: { kind: 'human', id: maya.id },
      changedByMemberId: owner.id,
      reason: 'Requires bespoke UX design decisions from Maya',
    })
    const reassignedTask = state.tasks[0]!
    expect(reassignedTask.assigneeKind).toBe('human')
    expect(reassignedTask.assignedMemberId).toBe(maya.id)
    expect(reassignedTask.assignedAgentId).toBeUndefined()
    expect(reassignedTask.handoffs).toHaveLength(1)
    expect(reassignedTask.handoffs?.[0]).toMatchObject({
      fromAssignee: { kind: 'agent', id: agent.id },
      toAssignee: { kind: 'human', id: maya.id },
      changedBy: { kind: 'human', id: owner.id },
      reason: 'Requires bespoke UX design decisions from Maya',
    })

    // Reassign back from Human to Agent
    state = await store.mutate({
      type: 'task.reassign',
      taskId: task.id,
      assignee: { kind: 'agent', id: agent.id },
      changedByMemberId: maya.id,
      reason: 'UX completed, delegating automated test implementation',
    })
    const finalTask = state.tasks[0]!
    expect(finalTask.assigneeKind).toBe('agent')
    expect(finalTask.assignedAgentId).toBe(agent.id)
    expect(finalTask.assignedMemberId).toBeUndefined()
    expect(finalTask.handoffs).toHaveLength(2)
    expect(finalTask.handoffs?.[1]?.fromAssignee).toEqual({ kind: 'human', id: maya.id })
    expect(finalTask.handoffs?.[1]?.toAssignee).toEqual({ kind: 'agent', id: agent.id })
  })

  it('supports human work submission to review and approval request generation', async () => {
    const { store, company, project, owner } = await fixture()
    let state = await store.mutate({
      type: 'member.create',
      companyId: company.id,
      displayName: 'Ken Reviewer',
      accessRole: 'reviewer',
    })
    const ken = (state.members ?? []).find((m) => m.displayName === 'Ken Reviewer')!

    state = await store.mutate({
      type: 'task.create',
      companyId: company.id,
      projectId: project.id,
      title: 'Auth Flow',
      description: 'Implement JWT refresh',
      assigneeKind: 'human',
      assignedMemberId: owner.id,
      reviewerKind: 'human',
      reviewerMemberId: ken.id,
    })
    const task = state.tasks[0]!

    // Mark task in_progress
    await store.mutate({ type: 'task.update', id: task.id, patch: { status: 'in_progress' } })

    // Submit work by owner
    state = await store.mutate({
      type: 'task.submitWork',
      taskId: task.id,
      memberId: owner.id,
      summary: 'Auth tokens and refresh endpoint complete with unit tests.',
      checkpointCommit: 'git-commit-auth-123',
    })

    const submittedTask = state.tasks.find((t) => t.id === task.id)!
    expect(submittedTask.status).toBe('review')
    expect(submittedTask.resultSummary).toContain('Auth tokens')

    // Approval request automatically generated for Ken
    const pendingApproval = (state.approvalRequests ?? []).find((a) => a.taskId === task.id)
    expect(pendingApproval).toBeDefined()
    expect(pendingApproval?.status).toBe('pending')
    expect(submittedTask.humanSubmission?.checkpointCommit).toBe('git-commit-auth-123')
    expect(pendingApproval?.targetRevision).toBe(submittedTask.humanSubmission?.id)
    await expect(store.mutate({ type: 'approval.resolve', id: pendingApproval!.id, actorMemberId: owner.id, verdict: 'approve' })).rejects.toThrow(/assigned human reviewer/i)
    expect((await store.state()).approvalRequests?.find((a) => a.id === pendingApproval!.id)?.status).toBe('pending')
    state = await store.mutate({ type: 'approval.resolve', id: pendingApproval!.id, actorMemberId: ken.id, verdict: 'approve' })
    expect(state.tasks.find((t) => t.id === task.id)?.status).toBe('completed')

    // When submitted without reviewer, task completes directly
    state = await store.mutate({
      type: 'task.create',
      companyId: company.id,
      projectId: project.id,
      title: 'Self-serve Doc',
      description: 'Document endpoints',
      assigneeKind: 'human',
      assignedMemberId: owner.id,
    })
    const docTask = state.tasks.find((t) => t.title === 'Self-serve Doc')!
    await store.mutate({ type: 'task.update', id: docTask.id, patch: { status: 'in_progress' } })
    state = await store.mutate({
      type: 'task.submitWork',
      taskId: docTask.id,
      memberId: owner.id,
      summary: 'Docs published to docs/',
    })
    expect(state.tasks.find((t) => t.id === docTask.id)?.status).toBe('completed')
  })

  it('rejects active handoffs and human submissions that overwrite other work', async () => {
    const { store, company, project, owner } = await fixture()
    const agent = (await store.state()).agents[0]!
    let state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Active AI work', description: 'Keep ownership until execution stops', assignedAgentId: agent.id })
    const task = state.tasks[0]!
    await store.markExecution(task.id, 'active-worker')
    await expect(store.mutate({ type: 'task.reassign', taskId: task.id, assignee: { kind: 'human', id: owner.id }, reason: 'Handoff' })).rejects.toThrow(/cannot reassign/i)
    await expect(store.mutate({ type: 'task.update', id: task.id, patch: { assigneeKind: 'human', assignedMemberId: owner.id } })).rejects.toThrow(/cannot reassign/i)
    await expect(store.mutate({ type: 'task.submitWork', taskId: task.id, memberId: owner.id, summary: 'Override' })).rejects.toThrow(/assigned human/i)
    state = await store.state()
    expect(state.tasks[0]?.assignedAgentId).toBe(agent.id)
    expect(state.tasks[0]?.status).toBe('in_progress')
    expect(state.tasks[0]?.handoffs ?? []).toHaveLength(0)
    expect(state.agents.find((a) => a.id === agent.id)?.status).toBe('working')
  })

  it('binds non-code human review to its submission and completes after approval', async () => {
    const { store, company, project, owner } = await fixture()
    let state = await store.mutate({ type: 'member.create', companyId: company.id, displayName: 'Reviewer', accessRole: 'reviewer' })
    const reviewer = state.members!.find((m) => m.displayName === 'Reviewer')!
    state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Design delivery', description: 'Review human design work', assigneeKind: 'human', assignedMemberId: owner.id, reviewerKind: 'human', reviewerMemberId: reviewer.id })
    const task = state.tasks[0]!
    await expect(store.mutate({ type: 'task.submitWork', taskId: task.id, memberId: reviewer.id, summary: 'Not my work' })).rejects.toThrow(/assigned human/i)
    state = await store.mutate({ type: 'task.submitWork', taskId: task.id, memberId: owner.id, summary: 'First design' })
    const first = state.approvalRequests!.find((a) => a.taskId === task.id)!
    expect(first.targetRevision).toBe(state.tasks[0]?.humanSubmission?.id)
    await expect(store.mutate({ type: 'task.submitWork', taskId: task.id, memberId: owner.id, summary: 'Duplicate' })).rejects.toThrow(/ready or in progress/i)
    await store.mutate({ type: 'approval.resolve', id: first.id, actorMemberId: reviewer.id, verdict: 'request_changes' })
    state = await store.mutate({ type: 'task.submitWork', taskId: task.id, memberId: owner.id, summary: 'Revised design' })
    const next = state.approvalRequests!.find((a) => a.taskId === task.id && a.status === 'pending')!
    expect(next.targetRevision).not.toBe(first.targetRevision)
    state = await store.mutate({ type: 'approval.resolve', id: next.id, actorMemberId: reviewer.id, verdict: 'approve' })
    expect(state.tasks[0]?.status).toBe('completed')
    expect(state.projects[0]?.progress).toBe(100)
  })

  it('supports agent and human collaboration messages with typed attribution and categories', async () => {
    const { path, store, company, project, owner } = await fixture()
    const agent = (await store.state()).agents[0]!

    // Human posts a question
    await store.mutate({
      type: 'collaboration.message.add',
      companyId: company.id,
      projectId: project.id,
      authorMemberId: owner.id,
      category: 'question',
      body: 'Can we use Argon2 for password hashing?',
    })

    // Agent posts a reply
    await store.mutate({
      type: 'collaboration.message.add',
      companyId: company.id,
      projectId: project.id,
      authorAgentId: agent.id,
      category: 'reply',
      runId: 'run-pass-hash-01',
      body: 'Yes, Argon2id is standard and supported by our password hasher module.',
    })

    const reloaded = new OrganizationStore(path)
    const state = await reloaded.state()
    expect(state.messages).toHaveLength(2)

    const humanMsg = state.messages?.find((m) => m.author.id === owner.id)!
    expect(humanMsg.author.kind).toBe('human')
    expect(humanMsg.category).toBe('question')

    const agentMsg = state.messages?.find((m) => m.author.id === agent.id)!
    expect(agentMsg.author.kind).toBe('agent')
    expect(agentMsg.category).toBe('reply')
    expect(agentMsg.runId).toBe('run-pass-hash-01')
  })
})
