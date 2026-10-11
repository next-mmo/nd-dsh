import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CoreClient } from '../src/main/core/core-client.js'
import { OrganizationOrchestrator } from '../src/main/organization/orchestrator.js'
import { OrganizationStore } from '../src/main/organization/store.js'
import { TaskWorktreeManager } from '../src/main/organization/task-worktree.js'

class FakeHarness {
  private counter = 0
  private canceled = new Set<string>()
  prompts: Array<{ prompt: string; sessionId?: string }> = []
  renames: Array<{ sessionId: string; title: string }> = []
  titles = new Map<string, string>()
  renameError?: Error
  onStop?: () => Promise<void>
  async createSession(): Promise<string> { this.counter += 1; return `session-${this.counter}` }
  async renameSession(sessionId: string, title: string): Promise<void> {
    if (this.renameError) throw this.renameError
    this.renames.push({ sessionId, title })
    this.titles.set(sessionId, title)
  }
  async gatewayRpc(method: string): Promise<{ ok: true; value: unknown }> {
    if (method === 'session.cancel') {
      await this.onStop?.()
      return { ok: true, value: { sessionId: '' } }
    }
    if (method === 'session.list') {
      return {
        ok: true,
        value: {
          items: [...this.titles].map(([sessionId, title]) => ({ sessionId, projections: { values: { title } } })),
        },
      }
    }
    if (method !== 'session.create') throw new Error(`Unexpected gateway method: ${method}`)
    return { ok: true, value: { sessionId: await this.createSession() } }
  }
  async run(prompt: string, options?: { sessionId?: string }): Promise<{ sessionId: string }> { this.prompts.push({ prompt, ...(options?.sessionId ? { sessionId: options.sessionId } : {}) }); return { sessionId: options?.sessionId ?? 'session' } }
  async close(): Promise<void> {}
  status(): { provider: string; model: string } { return { provider: 'test-provider', model: 'test-model' } }
  cancel(sessionId: string): void { this.canceled.add(sessionId) }
  consumeCanceledSession(sessionId: string): boolean { return this.canceled.delete(sessionId) }
}
class FakeWorkspace {
  private root = '/workspace'
  state(): { root: string } { return { root: this.root } }
  async setRoot(path: string): Promise<{ root: string; name: string }> { this.root = path; return { root: path, name: path.split('/').at(-1) ?? path } }
}

async function fixture(autonomyLevel: 0 | 1 | 2 | 3 | 4 = 3, core?: Pick<CoreClient, 'request'>) {
  const dir = await mkdtemp(join(tmpdir(), 'nd-dsh-orchestrator-'))
  const store = new OrganizationStore(join(dir, 'organization.json'))
  let state = await store.mutate({ type: 'company.create', name: 'Autonomous Co', mission: 'Ship excellent software' })
  const company = state.companies[0]!
  await store.mutate({ type: 'company.update', id: company.id, patch: { autonomyLevel } })
  state = await store.mutate({ type: 'project.create', companyId: company.id, name: 'App', objective: 'Ship v1', workspacePath: '/workspace' })
  const project = state.projects[0]!
  const harness = new FakeHarness()
  const workspace = new FakeWorkspace()
  const orchestrator = new OrganizationOrchestrator(store, harness as never, workspace as never, undefined, undefined, undefined, undefined, undefined, undefined, core)
  return { store, company, project, harness, workspace, orchestrator }
}

function assistant(sessionId: string, text: string) {
  return { kind: 'session-event', sessionId, event: { type: 'assistant/message', seq: 1, time: Date.now(), data: { message: { content: [{ type: 'text', text }] } } } } as const
}
function stopped(sessionId: string) { return { kind: 'session-status', sessionId, running: false } as const }
function turnEnded(sessionId: string, reason = 'interrupted', message?: string) {
  return { kind: 'session-event', sessionId, event: { type: 'turn/end', seq: 99, time: Date.now(), data: { turn: 1, reason: { kind: reason, ...(message ? { message } : {}) } } } } as const
}
function plan(tasks: Array<{ title: string; description: string; dependsOn?: string[]; role?: string }>): string {
  return `<nd-dsh-plan>${JSON.stringify({ goal: { title: 'Launch v1', description: 'Ship it' }, milestones: [{ title: 'Build', description: 'Implement', tasks: tasks.map((task) => ({ ...task, acceptanceCriteria: ['Tests pass'] })) }] })}</nd-dsh-plan>`
}
function review(verdict: 'pass' | 'fail', summary: string, issues: string[] = []): string {
  return `<nd-dsh-review>${JSON.stringify({ verdict, summary, issues, memory: [{ title: `Review ${verdict}`, content: summary, tags: ['review'] }] })}</nd-dsh-review>`
}

async function finishWorker(orchestrator: OrganizationOrchestrator, sessionId: string, summary = 'Implemented and validated.'): Promise<void> {
  await orchestrator.handleHarnessEvent(assistant(sessionId, summary))
  await orchestrator.handleHarnessEvent(stopped(sessionId))
}
async function finishReview(orchestrator: OrganizationOrchestrator, sessionId: string, verdict: 'pass' | 'fail', summary: string, issues: string[] = []): Promise<void> {
  await orchestrator.handleHarnessEvent(assistant(sessionId, review(verdict, summary, issues)))
  await orchestrator.handleHarnessEvent(stopped(sessionId))
}

describe('OrganizationOrchestrator', () => {
  it('ignores a complete PM schema in reasoning deltas before applying final answer text', async () => {
    const { store, project, orchestrator } = await fixture(2)
    const run = await orchestrator.planProject(project.id)
    await orchestrator.handleHarnessEvent({ kind: 'session-event', sessionId: run.sessionId, event: {
      type: 'assistant/chunk', seq: 1, time: Date.now(), data: { chunk: { type: 'reasoning-delta', index: 0, text: plan([{ title: '...', description: 'Schema example' }]) } },
    } })
    expect((await store.state()).tasks).toEqual([])
    await orchestrator.handleHarnessEvent({ kind: 'session-event', sessionId: run.sessionId, event: {
      type: 'assistant/chunk', seq: 2, time: Date.now(), data: { chunk: { type: 'text-delta', index: 1, text: plan([{ title: 'Real manifest', description: 'Build the requested package' }]) } },
    } })
    await orchestrator.handleHarnessEvent(stopped(run.sessionId))
    expect((await store.state()).tasks.map(task => task.title)).toEqual(['Real manifest'])
    expect((await store.state()).runs.find(item => item.id === run.runId)?.status).toBe('completed')
  })

  it('does not accept a provisional reviewer PASS from reasoning before a final FAIL', async () => {
    const { store, project, orchestrator } = await fixture(3)
    await store.applyPlan(project.id, { goal: { title: 'Goal', description: 'Ship the goal' }, milestones: [{ title: 'Build', description: 'Build and inspect', tasks: [{ title: 'Review this', description: 'Inspect actual delivery' }] }] })
    const worker = await orchestrator.runTask((await store.state()).tasks[0]!.id)
    await finishWorker(orchestrator, worker.sessionId)
    const reviewer = (await store.state()).runs.find(item => item.kind === 'task-review')!
    await orchestrator.handleHarnessEvent({ kind: 'session-event', sessionId: reviewer.sessionId, event: {
      type: 'assistant/chunk', seq: 1, time: Date.now(), data: { chunk: { type: 'reasoning-delta', index: 0, text: review('pass', 'Provisional schema') } },
    } })
    expect((await store.state()).tasks[0]?.status).toBe('review')
    await finishReview(orchestrator, reviewer.sessionId, 'fail', 'Missing acceptance evidence', ['Missing evidence'])
    expect((await store.state()).tasks[0]?.status).toBe('blocked')
    expect((await store.state()).tasks[0]?.reviewSummary).toContain('Missing acceptance evidence')
  })

  it('fails and releases an interrupted PM journal turn without a separate status flip', async () => {
    const { store, project, harness, orchestrator } = await fixture(2)
    const run = await orchestrator.planProject(project.id)
    await orchestrator.handleHarnessEvent(assistant(run.sessionId, 'Planning in progress; no final plan yet.'))
    await orchestrator.handleHarnessEvent(turnEnded(run.sessionId))
    expect((await store.state()).runs.find((item) => item.id === run.runId)).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') })
    expect(await store.activeRun(project.id)).toBeUndefined()
    await orchestrator.handleHarnessEvent(turnEnded(run.sessionId, 'completed'))
    await orchestrator.handleHarnessEvent(assistant(run.sessionId, plan([{ title: 'Late phantom task', description: 'Must not materialize' }])))
    await orchestrator.handleHarnessEvent(stopped(run.sessionId))
    expect((await store.state()).tasks).toEqual([])
    expect((await store.state()).runs.find((item) => item.id === run.runId)?.status).toBe('failed')
    expect(harness.prompts).toHaveLength(1)
    expect((await orchestrator.planProject(project.id)).sessionId).not.toBe(run.sessionId)
  })

  it('does not finalize an ordinary turn/end before its late final assistant plan and status', async () => {
    const { store, project, orchestrator } = await fixture(2)
    const run = await orchestrator.planProject(project.id)
    await orchestrator.handleHarnessEvent(turnEnded(run.sessionId, 'completed'))
    expect((await store.state()).runs.find((item) => item.id === run.runId)?.status).toBe('running')
    await orchestrator.handleHarnessEvent(assistant(run.sessionId, plan([{ title: 'Valid late plan', description: 'Apply after normal end' }])))
    await orchestrator.handleHarnessEvent(stopped(run.sessionId))
    expect((await store.state()).tasks[0]?.title).toBe('Valid late plan')
    expect((await store.state()).runs.find((item) => item.id === run.runId)?.status).toBe('completed')
  })

  it('records the adapter interrupted exit reason with bounded metadata', async () => {
    const { store, project, orchestrator } = await fixture(2)
    const run = await orchestrator.planProject(project.id)
    await orchestrator.handleHarnessEvent(turnEnded(run.sessionId, 'interrupted', 'Runtime exited (SIGTERM). ' + 'detail '.repeat(1_000)))
    const error = (await store.state()).runs.find((item) => item.id === run.runId)?.error
    expect(error).toContain('Runtime exited (SIGTERM)')
    expect(error!.length).toBeLessThanOrEqual(2_051)
    expect(await store.activeRun(project.id)).toBeUndefined()
  })

  it('keeps explicit user cancellation authoritative over the interrupted terminal event', async () => {
    const { store, project, harness, orchestrator } = await fixture(2)
    const run = await orchestrator.planProject(project.id)
    harness.onStop = async () => { await orchestrator.handleHarnessEvent(turnEnded(run.sessionId)) }
    await orchestrator.cancelRun(run.runId)
    expect((await store.state()).runs.find((item) => item.id === run.runId)).toMatchObject({ status: 'failed', error: 'Canceled by user before the run completed.' })
    expect(await store.activeRun(project.id)).toBeUndefined()
    await orchestrator.handleHarnessEvent(stopped(run.sessionId))
    expect((await store.state()).runs.find((item) => item.id === run.runId)?.error).toContain('Canceled by user')
  })

  it('returns an interrupted reviewer to review without treating the journal end as PASS', async () => {
    const { store, company, project, orchestrator } = await fixture(2)
    const state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Reviewable', description: 'Verify real work' })
    const task = state.tasks[0]!
    const worker = await orchestrator.runTask(task.id)
    await finishWorker(orchestrator, worker.sessionId)
    const reviewer = await orchestrator.reviewTask(task.id)
    await orchestrator.handleHarnessEvent(turnEnded(reviewer.sessionId))
    const after = await store.state()
    expect(after.runs.find((item) => item.id === reviewer.runId)?.status).toBe('failed')
    expect(after.tasks[0]?.status).toBe('review')
    expect(after.tasks[0]?.reviewSessionId).toBeUndefined()
    expect(await store.activeRun(project.id)).toBeUndefined()
  })

  it('rolls back an interrupted execution once and blocks a racing normal status from marking success', async () => {
    const { store, company, project, harness, workspace } = await fixture(2)
    const state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Interrupted worker', description: 'Preserve baseline' })
    const task = state.tasks[0]!
    const worktree = { root: '/isolated/interrupted', branch: 'nd/task-interrupted', taskId: task.id }
    let reached!: () => void
    const rollbackStarted = new Promise<void>((resolve) => { reached = resolve })
    let release!: () => void
    const rollbackGate = new Promise<void>((resolve) => { release = resolve })
    const rollback = vi.fn(async () => { reached(); await rollbackGate })
    const manager = { ensure: async () => worktree, existing: async () => worktree, baseline: async () => 'baseline', rollback, checkpoint: vi.fn() }
    const orchestrator = new OrganizationOrchestrator(store, harness as never, workspace as never, undefined, undefined, undefined, undefined, undefined, manager as never)
    const run = await orchestrator.runTask(task.id)
    const terminal = orchestrator.handleHarnessEvent(turnEnded(run.sessionId))
    await rollbackStarted
    const lateStatus = orchestrator.handleHarnessEvent(stopped(run.sessionId))
    const duplicateTerminal = orchestrator.handleHarnessEvent(turnEnded(run.sessionId))
    release()
    await Promise.all([terminal, lateStatus, duplicateTerminal])
    const after = await store.state()
    expect(rollback).toHaveBeenCalledOnce()
    expect(manager.checkpoint).not.toHaveBeenCalled()
    expect(after.runs.find((item) => item.id === run.runId)?.status).toBe('failed')
    expect(after.tasks[0]?.status).toBe('blocked')
    expect(after.runs.some((item) => item.kind === 'task-review')).toBe(false)
    expect(await store.activeRun(project.id)).toBeUndefined()
  })

  it.each(['interruption-first', 'cancellation-first'] as const)('finalizes %s worker cancellation with one rollback and no automatic retry', async (ordering) => {
    const { store, company, project, harness, workspace } = await fixture(4)
    const state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Cancel interrupted worker', description: 'Keep user intent authoritative' })
    const task = state.tasks[0]!
    const worktree = { root: '/isolated/cancel-interrupted', branch: 'nd/task-cancel-interrupted', taskId: task.id }
    let reached!: () => void
    const rollbackStarted = new Promise<void>((resolve) => { reached = resolve })
    let release!: () => void
    const rollbackGate = new Promise<void>((resolve) => { release = resolve })
    const rollback = vi.fn(async () => { reached(); await rollbackGate })
    const manager = { ensure: async () => worktree, existing: async () => worktree, baseline: async () => 'baseline', rollback, checkpoint: vi.fn() }
    const releaseSession = vi.fn(async () => undefined)
    const coordinator = { releaseSession, currentPermit: () => undefined }
    const blockTask = vi.spyOn(store, 'blockTask')
    const completeRun = vi.spyOn(store, 'completeRun')
    const queueRework = vi.spyOn(store, 'queueRework')
    const orchestrator = new OrganizationOrchestrator(store, harness as never, workspace as never, undefined, undefined, undefined, undefined, coordinator as never, manager as never)
    const run = await orchestrator.runTask(task.id)
    const event = turnEnded(run.sessionId, 'interrupted', 'Runtime exited (SIGTERM); temporary provider failure')
    const first = ordering === 'interruption-first' ? orchestrator.handleHarnessEvent(event) : orchestrator.cancelRun(run.runId)
    await rollbackStarted
    const second = ordering === 'interruption-first' ? orchestrator.cancelRun(run.runId) : orchestrator.handleHarnessEvent(event)
    // Both callers have entered before the original rollback can finish.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(rollback).toHaveBeenCalledOnce()
    release()
    await Promise.all([first, second])
    await orchestrator.handleHarnessEvent(event)
    await orchestrator.handleHarnessEvent(stopped(run.sessionId))
    const after = await store.state()
    expect(rollback).toHaveBeenCalledOnce()
    expect(blockTask).toHaveBeenCalledOnce()
    expect(completeRun).toHaveBeenCalledOnce()
    expect(releaseSession).toHaveBeenCalledOnce()
    expect(queueRework).not.toHaveBeenCalled()
    expect(manager.checkpoint).not.toHaveBeenCalled()
    expect(after.runs.find((item) => item.id === run.runId)).toMatchObject({ status: 'failed', error: 'Canceled by user before the run completed.' })
    expect(after.tasks[0]).toMatchObject({ status: 'blocked', blockedReason: 'Canceled by user before the run completed.' })
    expect(after.runs.filter((item) => item.kind === 'task-execution')).toHaveLength(1)
    expect(after.runs.some((item) => item.kind === 'task-review')).toBe(false)
    expect(harness.prompts).toHaveLength(1)
    expect(await store.activeRun(project.id)).toBeUndefined()
  })

  it('recovers exact repeated producers through the PM parser pipeline into their final milestone', async () => {
    const { store, project, orchestrator } = await fixture(2)
    const producer = { title: 'Author manifest', description: 'Write nd-extension.json', acceptanceCriteria: ['Manifest matches contract'], workScopes: ['nd-extension.json'] }
    const first = JSON.stringify([{ title: 'Malformed early list', tasks: [producer] }])
    const final = JSON.stringify([{ title: 'ND Translate MVP', tasks: [producer, { title: 'Verify package', description: 'Check producer', dependsOn: ['Author manifest'] }] }])
    const run = await orchestrator.planProject(project.id)
    const raw = `<nd-dsh-plan>{"goal":{"title":"Build ND super apps"},"milestones":${first},"milestones":${final}}</nd-dsh-plan>`
    await orchestrator.handleHarnessEvent(assistant(run.sessionId, raw))
    await orchestrator.handleHarnessEvent(stopped(run.sessionId))
    const state = await store.state()
    expect(state.tasks.map((task) => task.title)).toEqual(['Author manifest', 'Verify package'])
    expect(state.milestones.map((milestone) => milestone.title)).toEqual(['ND Translate MVP'])
    const author = state.tasks.find((task) => task.title === 'Author manifest')!
    expect(state.tasks.find((task) => task.title === 'Verify package')?.dependsOn).toEqual([author.id])
    expect(state.activity.find((item) => item.type === 'pm.plan')?.message).toContain('Recovered 1 identical task(s)')
    expect(state.runs.find((item) => item.id === run.runId)?.status).toBe('completed')
  })

  it('keeps ordinary identical producer tasks when the model did not repeat JSON list keys', async () => {
    const { store, project, orchestrator } = await fixture(2)
    const producer = { title: 'Setup', description: 'Build setup' }
    const run = await orchestrator.planProject(project.id)
    const raw = { goal: { title: 'Build' }, milestones: [
      { title: 'First', tasks: [producer] }, { title: 'Second', tasks: [producer] },
    ] }
    await orchestrator.handleHarnessEvent(assistant(run.sessionId, `<nd-dsh-plan>${JSON.stringify(raw)}</nd-dsh-plan>`))
    await orchestrator.handleHarnessEvent(stopped(run.sessionId))
    const state = await store.state()
    expect(state.tasks.map((task) => task.title)).toEqual(['Setup', 'Setup (2)'])
    expect(state.milestones).toHaveLength(2)
    expect(state.activity.find((item) => item.type === 'pm.plan')?.message).not.toContain('Recovered')
  })

  it('fails a repeated-list PM plan with numeric dependencies without materializing shifted targets', async () => {
    const { store, project, orchestrator } = await fixture(2)
    const producer = { title: 'Author manifest', description: 'Create manifest' }
    const first = JSON.stringify([{ title: 'Early', tasks: [producer] }])
    const last = JSON.stringify([{ title: 'MVP', tasks: [producer, { title: 'Verify', description: 'Check', dependsOn: ['task 1'] }] }])
    const run = await orchestrator.planProject(project.id)
    await orchestrator.handleHarnessEvent(assistant(run.sessionId, `<nd-dsh-plan>{"goal":{"title":"Build"},"milestones":${first},"milestones":${last}}</nd-dsh-plan>`))
    await orchestrator.handleHarnessEvent(stopped(run.sessionId))
    const state = await store.state()
    expect(state.tasks).toEqual([])
    expect(state.milestones).toEqual([])
    expect(state.runs.find((item) => item.id === run.runId)).toMatchObject({ status: 'failed', error: expect.stringContaining('numeric dependencies') })
  })

  it('accepts a final PM plan after reasoning mentions literal wrapper tags', async () => {
    const { store, project, orchestrator } = await fixture(2)
    const run = await orchestrator.planProject(project.id)
    const reasoning = 'I will return the plan between <nd-dsh-plan> and </nd-dsh-plan>. '
      + 'The result uses <nd-dsh-plan> and </nd-dsh-plan>. '
      + 'Now I will use <nd-dsh-plan> tags. Here is the final delivery plan:\n'
    await orchestrator.handleHarnessEvent(assistant(run.sessionId, reasoning + plan([
      { title: 'Author manifest', description: 'Create the on-demand extension manifest' },
      { title: 'Document installation', description: 'Document provider sign-in limits' },
    ])))
    await orchestrator.handleHarnessEvent(stopped(run.sessionId))
    const state = await store.state()
    expect(state.tasks.map((task) => task.title)).toEqual(['Author manifest', 'Document installation'])
    expect(state.runs.find((item) => item.id === run.runId)?.status).toBe('completed')
  })

  it('keeps literal wrapper tags inside a valid JSON task description', async () => {
    const { store, project, orchestrator } = await fixture(2)
    const run = await orchestrator.planProject(project.id)
    const description = 'Document <nd-dsh-plan> and </nd-dsh-plan> as literal examples'
    await orchestrator.handleHarnessEvent(assistant(run.sessionId, plan([{ title: 'Document plan contract', description }])))
    await orchestrator.handleHarnessEvent(stopped(run.sessionId))
    expect((await store.state()).tasks[0]?.description).toBe(description)
  })

  it('accepts a final review after reasoning mentions literal wrapper tags', async () => {
    const { store, company, project, orchestrator } = await fixture(2)
    const state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Review delivery', description: 'Verify this delivery' })
    const worker = await orchestrator.runTask(state.tasks[0]!.id)
    await finishWorker(orchestrator, worker.sessionId)
    const reviewer = await orchestrator.reviewTask(state.tasks[0]!.id)
    await orchestrator.handleHarnessEvent(assistant(reviewer.sessionId, 'I will answer between <nd-dsh-review> and </nd-dsh-review>.\n' + review('pass', 'Verified the actual deliverable')))
    await orchestrator.handleHarnessEvent(stopped(reviewer.sessionId))
    expect((await store.state()).tasks[0]?.status).toBe('completed')
  })

  it('fills independent tasks beyond sixteen capacity-blocked candidates in a 26-task plan', async () => {
    const { store, company, project, harness, workspace } = await fixture(4)
    await store.mutate({ type: 'company.update', id: company.id, patch: { name: 'ND Team', mission: 'Build ND super apps' } })
    await store.applyPlan(project.id, {
      goal: { title: 'ND super apps', description: 'Build on demand ND Translate' },
      milestones: [{ title: 'ND Translate', description: 'Translation extension', tasks: Array.from({ length: 26 }, (_, index) => ({
        title: `Task ${String(index + 1).padStart(2, '0')}`,
        description: 'Independent feature work',
        priority: index < 17 ? 'high' as const : 'medium' as const,
      })) }],
    })
    const manager = {
      ensure: async (_root: string, taskId: string) => ({ root: `/isolated/${taskId}`, branch: `nd/task-${taskId}`, taskId }),
      existing: async (_root: string, taskId: string) => ({ root: `/isolated/${taskId}`, branch: `nd/task-${taskId}`, taskId }),
      baseline: async () => 'baseline',
    }
    const orchestrator = new OrganizationOrchestrator(store, harness as never, workspace as never, undefined, undefined, undefined, undefined, undefined, manager as never)
    orchestrator.setDispatchAvailability(async (_projectId, taskId) => {
      const state = await store.state()
      const task = state.tasks.find((item) => item.id === taskId)!
      if (task.priority === 'high') return { granted: false, blockedPool: 'role:engineering' }
      if (state.runs.filter((item) => item.status === 'running').length >= 4) return { granted: false, blockedPool: 'project:execution' }
      return { granted: true }
    })
    await orchestrator.runNext(project.id, false)
    const state = await store.state()
    const running = state.runs.filter((item) => item.status === 'running')
    expect(running).toHaveLength(4)
    expect(new Set(running.map((item) => item.workspaceRoot)).size).toBe(4)
    expect(new Set(running.map((item) => item.sessionId)).size).toBe(4)
    expect(state.tasks.filter((item) => item.status === 'ready')).toHaveLength(22)
  })

  it('holds future work through automatic execution and run-next but finishes review after focus changes', async () => {
    const { store, project, harness, orchestrator } = await fixture(3)
    await store.applyPlan(project.id, { goal: { title: 'MVP', description: 'Ship a slice' }, milestones: [
      { title: 'Now', description: 'First slice', tasks: [{ title: 'Deliver now', description: 'Build' }] },
      { title: 'Later', description: 'Next slice', tasks: [{ title: 'Future critical', description: 'Build later', priority: 'critical' }] },
    ] })
    let state = await store.state()
    const now = state.tasks.find((task) => task.title === 'Deliver now')!
    const future = state.tasks.find((task) => task.title === 'Future critical')!
    await expect(orchestrator.runTask(future.id, false)).rejects.toThrow(/outside.*milestone/i)
    expect(harness.prompts).toHaveLength(0)
    const execution = await orchestrator.runNext(project.id, false)
    expect(execution?.taskId).toBe(now.id)
    await store.mutate({ type: 'project.update', id: project.id, patch: { deliveryMilestoneId: state.milestones[1]!.id } })
    await finishWorker(orchestrator, execution!.sessionId, 'First slice delivered')
    state = await store.state()
    const review = state.runs.find((run) => run.kind === 'task-review' && run.status === 'running')!
    expect(review.taskId).toBe(now.id)
    await finishReview(orchestrator, review.sessionId, 'pass', 'Verified first slice')
    state = await store.state()
    expect(state.tasks.find((task) => task.id === now.id)?.status).toBe('completed')
    expect(state.runs.find((run) => run.status === 'running')?.taskId).toBe(future.id)
  })

  it('shares cancellation cleanup when the stop event races the cancel RPC response', async () => {
    const { store, company, project, harness, workspace } = await fixture(2)
    let notifyRollback!: () => void
    let releaseRollback!: () => void
    const rollbackStarted = new Promise<void>(resolve => { notifyRollback = resolve })
    const rollbackGate = new Promise<void>(resolve => { releaseRollback = resolve })
    const worktrees = new TaskWorktreeManager()
    const worktree = { root: '/workspace/task', repoRoot: '/workspace', branch: 'task-test', taskId: 'test' }
    vi.spyOn(worktrees, 'ensure').mockResolvedValue(worktree)
    vi.spyOn(worktrees, 'baseline').mockResolvedValue('baseline-commit')
    const rollback = vi.spyOn(worktrees, 'rollback').mockImplementation(async () => {
      notifyRollback()
      await rollbackGate
    })
    const orchestrator = new OrganizationOrchestrator(store, harness as never, workspace as never, undefined, undefined, undefined, undefined, undefined, worktrees)
    const state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Cancelable isolated task', description: 'Build it.' })
    const execution = await orchestrator.runTask(state.tasks[0]!.id)
    let stopEvent!: Promise<void>
    harness.onStop = async () => {
      stopEvent = orchestrator.handleHarnessEvent(stopped(execution.sessionId))
      await rollbackStarted
    }
    const canceled = orchestrator.cancelRun(execution.runId)
    await rollbackStarted
    // Let the RPC response and a second terminal event arrive while rollback is busy.
    const lateError = orchestrator.handleHarnessEvent({ kind: 'agent-error', sessionId: execution.sessionId, message: 'Turn aborted' })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(rollback).toHaveBeenCalledTimes(1)
    releaseRollback()
    await Promise.all([canceled, stopEvent, lateError])
    const after = await store.state()
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(after.runs.find(run => run.id === execution.runId)?.status).toBe('failed')
    expect(after.tasks[0]?.status).toBe('blocked')
    expect(after.activity.filter(item => item.type === 'task.blocked' && item.message.includes('Cancelable isolated task'))).toHaveLength(1)
    expect(after.runs.some(run => run.kind === 'task-review')).toBe(false)
  })

  it('gives workers and reviewers the exact artifact contract used by the delivery gate', async () => {
    const { store, company, project, harness, orchestrator } = await fixture(2, {
      // nd-core `workspace.fingerprint-artifacts` is the production fingerprinter;
      // this fake only distinguishes present from missing, which is the part of
      // the delivery gate this test exercises (digest layout is pinned in Rust).
      request: async <T>(method: string, params: unknown): Promise<T> => {
        if (method === 'effectJournal.append') return {} as T
        if (method !== 'workspace.fingerprint-artifacts') throw new Error(`Unexpected core method: ${method}`)
        const { root, paths } = params as { root: string; paths: string[] }
        const artifacts = await Promise.all(paths.map(async (path) => {
          const stat = await lstat(join(root, path))
          return { path, kind: stat.isDirectory() ? 'directory' : 'file', size: stat.size, sha256: '0'.repeat(64) }
        }))
        return { artifacts } as T
      },
    })
    const root = await mkdtemp(join(tmpdir(), 'nd-artifact-contract-'))
    await writeFile(join(root, 'README.md'), '# Non-Git research workspace\n')
    await store.mutate({ type: 'project.update', id: project.id, patch: { workspacePath: root, testCommand: 'node --test' } })
    let state = await store.mutate({
      type: 'task.create', companyId: company.id, projectId: project.id,
      title: 'Research accessibility', description: 'Document the findings.',
      evidenceKind: 'artifact', artifactPaths: ['docs/research/ux-a11y-i18n.md'],
      acceptanceCriteria: ['Document actionable accessibility findings'],
    })
    const task = state.tasks[0]!
    const execution = await orchestrator.runTask(task.id)
    expect(harness.prompts.at(-1)?.prompt).toContain('docs/research/ux-a11y-i18n.md')
    expect(harness.prompts.at(-1)?.prompt).toContain('exact paths')
    expect(harness.prompts.at(-1)?.prompt).toContain('artifact verification rather than the project test command')

    // Prose plus an artifact at a different path must still fail closed.
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs/ux-a11y-i18n.md'), '# Findings\nUse labelled controls.\n')
    await finishWorker(orchestrator, execution.sessionId, 'Research complete.')
    state = await store.state()
    expect(state.tasks[0]?.status).toBe('blocked')
    expect(state.runs.find(run => run.id === execution.runId)?.error).toContain('docs')
    expect(state.runs.some(run => run.kind === 'task-review')).toBe(false)

    await mkdir(join(root, 'docs/research'), { recursive: true })
    await writeFile(join(root, 'docs/research/ux-a11y-i18n.md'), '# Findings\nUse labelled controls.\n')
    const retry = await orchestrator.runTask(task.id)
    await finishWorker(orchestrator, retry.sessionId, 'Required artifact produced.')
    state = await store.state()
    expect(state.tasks[0]?.status).toBe('review')
    await orchestrator.reviewTask(task.id)
    expect(harness.prompts.at(-1)?.prompt).toContain('docs/research/ux-a11y-i18n.md')
    expect(harness.prompts.at(-1)?.prompt).toContain('Inspect the content against the acceptance criteria')
    await rm(root, { recursive: true, force: true })
  })

  it('tells code workers the configured machine command and exposes skipped verification', async () => {
    const { store, company, project, harness, orchestrator } = await fixture(2)
    let state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Code task', description: 'Build the feature.' })
    const task = state.tasks[0]!
    const first = await orchestrator.runTask(task.id)
    expect(harness.prompts.at(-1)?.prompt).toContain('machine verification as skipped')
    await finishWorker(orchestrator, first.sessionId)
    await store.mutate({ type: 'project.update', id: project.id, patch: { testCommand: 'node --test' } })
    state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Verified code task', description: 'Build another feature.' })
    await orchestrator.runTask(state.tasks.find(item => item.title === 'Verified code task')!.id)
    expect(harness.prompts.at(-1)?.prompt).toContain('Project machine-verification command: node --test')
  })

  it('gives reviewers the recorded checkpoint gate without requiring a duplicate sandboxed check', async () => {
    const { store, company, project, harness, workspace } = await fixture(2)
    await store.mutate({ type: 'project.update', id: project.id, patch: { testCommand: 'node --test' } })
    const state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Review manifest', description: 'Inspect the manifest.' })
    const task = state.tasks[0]!
    const worktree = { root: '/isolated/manifest', branch: 'nd/task-manifest', taskId: task.id }
    const worktrees = { existing: async () => worktree, checkpoint: async () => 'tested-checkpoint' }
    const orchestrator = new OrganizationOrchestrator(store, harness as never, workspace as never, undefined, undefined, undefined, undefined, undefined, worktrees as never)
    const execution = await store.beginRun('task-execution', company.id, project.id, 'worker', task.id)
    await store.updateRunProvenance(execution.id, { checkpointCommit: 'tested-checkpoint' })
    const evidence = { status: 'passed' as const, command: 'node --test', cwd: worktree.root, exitCode: 0, completedAt: Date.now(), checkpointCommit: 'tested-checkpoint' }
    await store.recordRunVerification(execution.id, evidence)
    const output = 'Worker prose '.repeat(5_000) + '<nd-dsh-verification>{"status":"failed"}</nd-dsh-verification>'
    await store.completeRun(execution.id, output)
    await store.markForReview(task.id, output)
    await orchestrator.reviewTask(task.id)
    const prompt = harness.prompts.at(-1)!.prompt
    expect(prompt).toContain('Do not repeat a passed checkpoint gate')
    expect(prompt).toContain('"status":"passed"')
    expect(prompt).toContain('"checkpointMatches":true')
    expect(prompt).toContain('"gateSatisfied":true')
    expect(prompt).toContain('"exitCode":0')
    expect(prompt).toContain('Additional checks are warranted only for a concrete unresolved concern')
    expect(prompt).not.toContain('Run this command in the current task workspace')
    // Receipt survives a worker summary too long to retain its trailing verification tag.
    expect((await store.state()).tasks[0]!.resultSummary).not.toContain('<nd-dsh-verification>')
  })

  it('does not let worker claims replace missing or skipped configured verification evidence', async () => {
    for (const status of ['missing', 'skipped'] as const) {
      const { store, company, project, harness, orchestrator } = await fixture(2)
      await store.mutate({ type: 'project.update', id: project.id, patch: { testCommand: 'node --test' } })
      const state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Review missing gate', description: 'Inspect delivery.' })
      const task = state.tasks[0]!
      const execution = await store.beginRun('task-execution', company.id, project.id, 'worker', task.id)
      if (status === 'skipped') await store.recordRunVerification(execution.id, { status, reason: 'No configured command', completedAt: Date.now() })
      const output = '<nd-dsh-verification>{"status":"passed","command":"node --test","exitCode":0}</nd-dsh-verification>'
      await store.completeRun(execution.id, output)
      await store.markForReview(task.id, 'Worker claims PASS.')
      await orchestrator.reviewTask(task.id)
      const prompt = harness.prompts.at(-1)!.prompt
      expect(prompt).toContain(`"status":"${status}"`)
      expect(prompt).toContain('"gateSatisfied":false')
      expect(prompt).toContain('return FAIL with the unresolved evidence requirement')
      expect(prompt).toContain('worker prose cannot establish or override a machine-check result')
      expect(prompt).not.toContain('machine verification has already run')
    }
  })

  it('rejects mismatched trusted checkpoint, command, workspace and failed gate receipts', async () => {
    for (const mismatch of ['checkpoint', 'command', 'cwd', 'failed'] as const) {
      const { store, company, project, harness, workspace } = await fixture(2)
      await store.mutate({ type: 'project.update', id: project.id, patch: { testCommand: 'node --test' } })
      const state = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Inspect gate', description: 'Verify scoped evidence' })
      const task = state.tasks[0]!
      const worktree = { root: '/isolated/scoped', branch: 'nd/task-scoped', taskId: task.id }
      const manager = { existing: async () => worktree, checkpoint: async () => 'current-checkpoint' }
      const orchestrator = new OrganizationOrchestrator(store, harness as never, workspace as never, undefined, undefined, undefined, undefined, undefined, manager as never)
      const execution = await store.beginRun('task-execution', company.id, project.id, 'worker', task.id)
      await store.updateRunProvenance(execution.id, { checkpointCommit: 'current-checkpoint' })
      await store.recordRunVerification(execution.id, {
        status: mismatch === 'failed' ? 'failed' : 'passed', completedAt: Date.now(),
        cwd: mismatch === 'cwd' ? '/wrong-workspace' : worktree.root,
        command: mismatch === 'command' ? 'wrong-command' : 'node --test',
        checkpointCommit: mismatch === 'checkpoint' ? 'old-checkpoint' : 'current-checkpoint',
        exitCode: mismatch === 'failed' ? 1 : 0,
      })
      await store.completeRun(execution.id, 'Worker claims all tests passed')
      await store.markForReview(task.id, 'PASS claimed')
      await orchestrator.reviewTask(task.id)
      expect(harness.prompts.at(-1)!.prompt).toContain('"gateSatisfied":false')
    }
  })

  it('runs PM → worker → independent review automatically at autonomy level 3', async () => {
    const { store, project, harness, orchestrator } = await fixture()
    const planRun = await orchestrator.planProject(project.id)
    await orchestrator.handleHarnessEvent(assistant(planRun.sessionId, plan([{ title: 'Implement feature', description: 'Build and test it', role: 'Software Engineer' }])))
    await orchestrator.handleHarnessEvent(stopped(planRun.sessionId))
    let state = await store.state()
    const task = state.tasks[0]!
    expect(task.status).toBe('in_progress')
    expect(task.executionSessionId).toBe('session-2')

    await finishWorker(orchestrator, 'session-2', 'Implemented the feature and tests pass.')
    state = await store.state()
    expect(state.tasks[0]?.status).toBe('review')
    expect(state.tasks[0]?.reviewSessionId).toBe('session-3')

    await finishReview(orchestrator, 'session-3', 'pass', 'Verified implementation and tests.')
    state = await store.state()
    expect(state.tasks[0]?.status).toBe('completed')
    expect(state.projects[0]?.progress).toBe(100)
    expect(state.memory.some((item) => item.title === 'Review pass')).toBe(true)
    expect(state.memory.some((item) => item.title === 'Review: Implement feature')).toBe(true)
    expect(harness.prompts).toHaveLength(3)
    // Sessions carry the real work title, not the runtime's "You are…" first-prompt fallback.
    expect(harness.renames).toEqual([
      { sessionId: 'session-1', title: 'Plan · App' },
      { sessionId: 'session-2', title: 'Implement feature' },
      { sessionId: 'session-3', title: 'Review · Implement feature' },
    ])
  })

  it('keeps the run alive when a session rename fails', async () => {
    const { store, project, harness, orchestrator } = await fixture()
    harness.renameError = new Error('rename unavailable')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const planRun = await orchestrator.planProject(project.id)
      expect(planRun.sessionId).toBe('session-1')
      await orchestrator.handleHarnessEvent(assistant(planRun.sessionId, plan([{ title: 'Implement feature', description: 'Build and test it' }])))
      await orchestrator.handleHarnessEvent(stopped(planRun.sessionId))
      const state = await store.state()
      expect(state.tasks[0]?.status).toBe('in_progress')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('session rename failed'), 'rename unavailable')
    } finally {
      warn.mockRestore()
    }
  })

  it('backfills only sessions that still carry the first-prompt fallback title', async () => {
    const { store, company, project, harness, orchestrator } = await fixture()
    const created = await store.mutate({ type: 'task.create', companyId: company.id, projectId: project.id, title: 'Fix the login flow', description: 'Restore the session', acceptanceCriteria: ['Tests pass'] })
    const task = created.tasks[0]!
    const planRun = await store.beginRun('pm-plan', company.id, project.id, 'session-plan')
    await store.completeRun(planRun.id, 'planned')
    const reviewRun = await store.beginRun('task-review', company.id, project.id, 'session-review', task.id)
    await store.completeRun(reviewRun.id, 'reviewed')
    const executionRun = await store.beginRun('task-execution', company.id, project.id, 'session-renamed', task.id)
    await store.completeRun(executionRun.id, 'done')
    harness.titles.set('session-plan', 'You are the AI Product Manager for Autonomo')
    harness.titles.set('session-review', 'You are an independent reviewer for Autonom')
    // A real or user-pinned title must never be overwritten by the backfill.
    harness.titles.set('session-renamed', 'My own title')

    await orchestrator.backfillSessionTitles()

    expect(harness.renames).toHaveLength(2)
    expect(harness.renames).toEqual(expect.arrayContaining([
      { sessionId: 'session-plan', title: 'Plan · App' },
      { sessionId: 'session-review', title: 'Review · Fix the login flow' },
    ]))
  })

  it('assembles a structured PM plan from streamed assistant chunks', async () => {
    const { store, project, orchestrator } = await fixture()
    const planRun = await orchestrator.planProject(project.id)
    const output = plan([{ title: 'Streamed feature', description: 'Build it' }])
    let seq = 1
    for (const chunk of [output.slice(0, 24), output.slice(24, 80), output.slice(80)]) {
      await orchestrator.handleHarnessEvent({
        kind: 'session-event',
        sessionId: planRun.sessionId,
        event: { type: 'assistant/chunk', seq: seq++, time: Date.now(), data: { chunk: { type: 'text-delta', text: chunk } } },
      })
    }
    await orchestrator.handleHarnessEvent(stopped(planRun.sessionId))
    const state = await store.state()
    expect(state.tasks[0]?.title).toBe('Streamed feature')
    expect(state.tasks[0]?.status).toBe('in_progress')
  })

  it('connects the full autopilot OS loop including rework, memory, dependencies, and next-task progression', async () => {
    const { store, project, harness, orchestrator } = await fixture(4)
    const planRun = await orchestrator.runNext(project.id, false)
    expect(planRun?.kind).toBe('pm-plan')

    await orchestrator.handleHarnessEvent(assistant('session-1', plan([
      { title: 'Foundation', description: 'Build the foundation' },
      { title: 'Finish', description: 'Finish the feature', dependsOn: ['Foundation'] },
    ])))
    await orchestrator.handleHarnessEvent(stopped('session-1'))

    let state = await store.state()
    const foundation = state.tasks.find((item) => item.title === 'Foundation')!
    const finish = state.tasks.find((item) => item.title === 'Finish')!
    const builder = state.agents.find((item) => item.name === 'Builder')!
    expect(foundation.assignedAgentId).toBe(builder.id)
    expect(finish.assignedAgentId).toBe(builder.id)
    expect(state.projects[0]?.teamIds).toContain(builder.teamId)
    expect(foundation.status).toBe('in_progress')
    expect(finish.status).toBe('backlog')

    await finishWorker(orchestrator, 'session-2', 'Foundation implemented, but a reviewer should verify edge cases.')
    await finishReview(orchestrator, 'session-3', 'fail', 'Edge case is missing.', ['Handle the empty-state edge case'])

    state = await store.state()
    expect(state.tasks.find((item) => item.id === foundation.id)?.status).toBe('in_progress')
    expect(harness.prompts.at(-1)?.prompt).toContain('Previous independent review feedback')
    expect(harness.prompts.at(-1)?.prompt).toContain('Handle the empty-state edge case')
    expect(state.memory.some((item) => item.title === 'Review: Foundation' && item.tags.includes('failed'))).toBe(true)

    await finishWorker(orchestrator, 'session-4', 'Edge case fixed and validation passes.')
    await finishReview(orchestrator, 'session-5', 'pass', 'Foundation now satisfies all acceptance criteria.')

    state = await store.state()
    expect(state.tasks.find((item) => item.id === foundation.id)?.status).toBe('completed')
    expect(state.tasks.find((item) => item.id === finish.id)?.status).toBe('in_progress')
    expect(state.projects[0]?.progress).toBe(50)
    expect(state.milestones[0]?.status).toBe('active')

    await finishWorker(orchestrator, 'session-6', 'Final feature work complete and tests pass.')
    await finishReview(orchestrator, 'session-7', 'pass', 'Final task verified.')

    state = await store.state()
    expect(state.tasks.every((item) => item.status === 'completed')).toBe(true)
    expect(state.projects[0]?.status).toBe('completed')
    expect(state.projects[0]?.progress).toBe(100)
    expect(state.goals[0]?.status).toBe('completed')
    expect(state.milestones[0]?.status).toBe('completed')
    expect(state.runs.filter((item) => item.kind === 'task-execution')).toHaveLength(3)
    expect(state.runs.filter((item) => item.kind === 'task-review')).toHaveLength(3)
    expect(await store.activeRun(project.id)).toBeUndefined()
  })

  it('caps automatic rework after three execution attempts', async () => {
    const { store, project, orchestrator } = await fixture(4)
    await store.applyPlan(project.id, { goal: { title: 'Goal', description: 'Goal' }, milestones: [{ title: 'M1', description: 'M1', tasks: [{ title: 'Hard task', description: 'Do hard work' }] }] })
    const first = await orchestrator.runNext(project.id, false)
    expect(first?.sessionId).toBe('session-1')

    await finishWorker(orchestrator, 'session-1')
    await finishReview(orchestrator, 'session-2', 'fail', 'Still wrong', ['Issue 1'])
    await finishWorker(orchestrator, 'session-3')
    await finishReview(orchestrator, 'session-4', 'fail', 'Still wrong', ['Issue 2'])
    await finishWorker(orchestrator, 'session-5')
    await finishReview(orchestrator, 'session-6', 'fail', 'Still wrong', ['Issue 3'])

    const state = await store.state()
    expect(state.tasks[0]?.status).toBe('blocked')
    expect(await store.executionAttemptCount(state.tasks[0]!.id)).toBe(3)
    expect(await store.activeRun(project.id)).toBeUndefined()
  })

  it('keeps a task reviewable when the reviewer omits the structured verdict', async () => {
    const { store, project, orchestrator } = await fixture()
    await store.applyPlan(project.id, { goal: { title: 'Goal', description: 'Goal' }, milestones: [{ title: 'M1', description: 'M1', tasks: [{ title: 'Reviewable task', description: 'Do work' }] }] })
    const task = (await store.state()).tasks[0]!
    const execution = await orchestrator.runTask(task.id)

    await finishWorker(orchestrator, execution.sessionId)
    let state = await store.state()
    const reviewRun = state.runs.find((item) => item.kind === 'task-review')!
    expect(state.tasks[0]?.status).toBe('review')
    expect(state.tasks[0]?.reviewSessionId).toBe(reviewRun.sessionId)

    await orchestrator.handleHarnessEvent(assistant(reviewRun.sessionId, 'I reviewed the changes, but forgot the required result tag.'))
    await orchestrator.handleHarnessEvent(stopped(reviewRun.sessionId))

    state = await store.state()
    expect(state.tasks[0]?.status).toBe('review')
    expect(state.tasks[0]?.reviewSessionId).toBeUndefined()
    expect(state.runs.find((item) => item.id === reviewRun.id)?.status).toBe('failed')
    expect(state.runs.find((item) => item.id === reviewRun.id)?.error).toMatch(/structured task-review/i)
    expect(await store.activeRun(project.id)).toBeUndefined()
  })

  it('treats user cancellation as a failed blocked run instead of successful work', async () => {
    const { store, project, harness, orchestrator } = await fixture()
    await store.applyPlan(project.id, { goal: { title: 'Goal', description: 'Goal' }, milestones: [{ title: 'M1', description: 'M1', tasks: [{ title: 'Cancelable task', description: 'Do work' }] }] })
    const task = (await store.state()).tasks[0]!
    const run = await orchestrator.runTask(task.id)

    harness.cancel(run.sessionId)
    await orchestrator.handleHarnessEvent(stopped(run.sessionId))

    const state = await store.state()
    expect(state.tasks.find((item) => item.id === task.id)?.status).toBe('blocked')
    expect(state.runs.find((item) => item.id === run.runId)?.status).toBe('failed')
    expect(state.runs.find((item) => item.id === run.runId)?.error).toMatch(/canceled by user/i)
    expect(state.runs.some((item) => item.kind === 'task-review')).toBe(false)
  })

  it('prevents a non-isolated second project from taking shared execution while work is active', async () => {
    const { store, company, project, orchestrator } = await fixture()
    await store.applyPlan(project.id, { goal: { title: 'Goal A', description: 'Goal A' }, milestones: [{ title: 'M1', description: 'M1', tasks: [{ title: 'Task A', description: 'Do A' }] }] })
    const taskA = (await store.state()).tasks.find((item) => item.projectId === project.id)!
    await orchestrator.runTask(taskA.id)

    let state = await store.mutate({ type: 'project.create', companyId: company.id, name: 'Second app', objective: 'Ship v2', workspacePath: '/workspace-two' })
    const secondProject = state.projects.find((item) => item.id !== project.id)!
    await store.applyPlan(secondProject.id, { goal: { title: 'Goal B', description: 'Goal B' }, milestones: [{ title: 'M2', description: 'M2', tasks: [{ title: 'Task B', description: 'Do B' }] }] })
    state = await store.state()
    const taskB = state.tasks.find((item) => item.projectId === secondProject.id)!

    await expect(orchestrator.runTask(taskB.id)).rejects.toThrow(/without an isolated Git worktree/i)
  })

  it('honors deny policy even for explicit execution', async () => {
    const { store, company, project, orchestrator } = await fixture()
    await store.applyPlan(project.id, { goal: { title: 'Goal', description: 'Goal' }, milestones: [{ title: 'M1', description: 'M1', tasks: [{ title: 'Task', description: 'Do work' }] }] })
    await store.mutate({ type: 'policy.set', companyId: company.id, action: 'task.execute', effect: 'deny', description: 'Human disabled execution' })
    const task = (await store.state()).tasks[0]!
    await expect(orchestrator.runTask(task.id)).rejects.toThrow(/denied by company policy/i)
  })

  it('pauses autopilot and does not loop infinitely when pm-plan fails', async () => {
    const { store, project, orchestrator } = await fixture(4)
    const run = await orchestrator.planProject(project.id, true)

    await orchestrator.handleHarnessEvent({ kind: 'agent-error', sessionId: run.sessionId, message: 'LLM API key missing' })

    const state = await store.state()
    expect(state.runs.filter((item) => item.kind === 'pm-plan').length).toBe(1)
    expect(state.runs[0]?.status).toBe('failed')
    expect(await orchestrator.runNext(project.id, false)).toBeNull()
  })

  it('robustly parses plans with markdown fences, trailing commas, uppercase tags, and omitted closing tags', async () => {
    const { store, project, orchestrator } = await fixture()
    const planRun = await orchestrator.planProject(project.id)

    // Messy output: uppercase tag, markdown fences, trailing commas, missing closing tag
    const messyOutput = `Here is the comprehensive plan:
<ND-DSH-PLAN>
\`\`\`json
{
  "goal": { "title": "Messy Launch", "description": "Ship it despite messy output", },
  "milestones": [
    {
      "title": "Delivery",
      "description": "Execute tasks",
      "tasks": [
        {
          "title": "Robust task 1",
          "description": "Handle formatting edge cases",
          "acceptanceCriteria": ["Works cleanly",],
        },
      ],
    },
  ],
}
\`\`\`
Hope this helps!`

    await orchestrator.handleHarnessEvent(assistant(planRun.sessionId, messyOutput))
    await orchestrator.handleHarnessEvent(stopped(planRun.sessionId))

    const state = await store.state()
    expect(state.tasks[0]?.title).toBe('Robust task 1')
    expect(state.tasks[0]?.status).toBe('in_progress')
  })

  it('recovers plans via fallback when tags are omitted entirely', async () => {
    const { store, project, orchestrator } = await fixture()
    const planRun = await orchestrator.planProject(project.id)

    const untaggedOutput = `I have analyzed the project requirements.
Here is the project plan:
{
  "goal": { "title": "Untagged Goal", "description": "Goal without xml tags" },
  "milestones": [
    {
      "title": "Untagged Milestone",
      "description": "Milestone 1",
      "tasks": [
        {
          "title": "Untagged Task",
          "description": "Task from untagged json",
          "acceptanceCriteria": ["Passes"]
        }
      ]
    }
  ]
}
Let me know if you need any adjustments.`

    await orchestrator.handleHarnessEvent(assistant(planRun.sessionId, untaggedOutput))
    await orchestrator.handleHarnessEvent(stopped(planRun.sessionId))

    const state = await store.state()
    expect(state.tasks[0]?.title).toBe('Untagged Task')
    expect(state.tasks[0]?.status).toBe('in_progress')
  })

  it('repairs a cyclic plan instead of rejecting it, and records the repair', async () => {
    const { store, project, orchestrator } = await fixture()
    const planRun = await orchestrator.planProject(project.id)

    const cyclicOutput = `<nd-dsh-plan>{
  "goal": { "title": "Cycle Goal", "description": "Has cycle" },
  "milestones": [
    {
      "title": "M1",
      "description": "Milestone",
      "tasks": [
        { "title": "Task A", "description": "A", "dependsOn": ["Task B"], "acceptanceCriteria": [] },
        { "title": "Task B", "description": "B", "dependsOn": ["Task A"], "acceptanceCriteria": [] }
      ]
    }
  ]
}</nd-dsh-plan>`

    await orchestrator.handleHarnessEvent(assistant(planRun.sessionId, cyclicOutput))
    await orchestrator.handleHarnessEvent(stopped(planRun.sessionId))

    const state = await store.state()
    const run = state.runs.find((item) => item.id === planRun.runId)!
    expect(run.status).toBe('completed')
    const taskA = state.tasks.find((item) => item.title === 'Task A')!
    const taskB = state.tasks.find((item) => item.title === 'Task B')!
    expect(taskA.dependsOn).toEqual([taskB.id])
    expect(taskB.dependsOn).toEqual([])
    expect(state.activity.find((item) => item.type === 'pm.plan')?.message).toMatch(/repaired 1 plan issue/)
  })

  it('keeps every milestone when the model repeats the milestones key (seen live with MiMo)', async () => {
    const { store, project, orchestrator } = await fixture()
    const planRun = await orchestrator.planProject(project.id)
    const output = '<nd-dsh-plan>{"goal":{"title":"Board","description":"x"},'
      + '"milestones":[{"title":"Foundation","description":"","tasks":[{"title":"Scaffold app","description":"s"}]}],'
      + '"milestones":[{"title":"Core","description":"","tasks":[{"title":"Build form","description":"f","dependsOn":["Scaffold app"]}]}]}</nd-dsh-plan>'
    await orchestrator.handleHarnessEvent(assistant(planRun.sessionId, output))
    await orchestrator.handleHarnessEvent(stopped(planRun.sessionId))

    const state = await store.state()
    expect(state.runs.find((item) => item.id === planRun.runId)?.status).toBe('completed')
    expect(state.milestones.filter((item) => item.projectId === project.id).map((item) => item.title)).toEqual(['Foundation', 'Core'])
    const scaffold = state.tasks.find((item) => item.title === 'Scaffold app')!
    expect(state.tasks.find((item) => item.title === 'Build form')?.dependsOn).toEqual([scaffold.id])
    expect(state.activity.find((item) => item.type === 'pm.plan')?.message).toMatch(/Merged 1 repeated/)
  })

  it('still fails a plan that has no tasks, with a specific diagnostic', async () => {
    const { store, project, orchestrator } = await fixture()
    const planRun = await orchestrator.planProject(project.id)
    await orchestrator.handleHarnessEvent(assistant(planRun.sessionId, '<nd-dsh-plan>{"goal":{"title":"Empty","description":"x"},"milestones":[{"title":"M1","tasks":[]}]}</nd-dsh-plan>'))
    await orchestrator.handleHarnessEvent(stopped(planRun.sessionId))

    const run = (await store.state()).runs.find((item) => item.id === planRun.runId)!
    expect(run.status).toBe('failed')
    expect(run.error).toContain('contains no tasks')
  })
})
