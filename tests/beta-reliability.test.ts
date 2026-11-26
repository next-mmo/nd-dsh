import { execFile } from 'node:child_process'
import { access, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { CODEX_CLI_ENGINE_ID, ND_HARNESS_ENGINE_ID } from '../src/shared/coding-engines.js'
import { isRetryableExecutionFailure } from '../src/main/organization/execution-reliability.js'
import { OrganizationOrchestrator } from '../src/main/organization/orchestrator.js'
import { OrganizationStore } from '../src/main/organization/store.js'
import { TaskWorktreeManager } from '../src/main/organization/task-worktree.js'
import { runVerification } from '../src/main/organization/verification-evidence.js'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

async function gitWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nd-dsh-beta-git-'))
  await git(root, ['init'])
  await writeFile(join(root, 'README.md'), '# beta\n')
  await git(root, ['add', 'README.md'])
  await git(root, ['-c', 'user.name=ND-DSH Test', '-c', 'user.email=test@local', 'commit', '-m', 'base'])
  return root
}

class FakeHarness {
  async createSession(): Promise<string> { return 'harness-session' }
  async run(_prompt: string, options?: { sessionId?: string }): Promise<{ sessionId: string }> { return { sessionId: options?.sessionId ?? 'harness-session' } }
  async close(): Promise<void> {}
  consumeCanceledSession(): boolean { return false }
  status(): { provider: string; model: string } { return { provider: 'provider-primary', model: 'model-primary' } }
  async gatewayRpc(method: string): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }> {
    if (method === 'session.models') {
      return {
        ok: true,
        value: {
          groups: [
            { id: 'provider-primary', models: [{ id: 'model-primary' }] },
            { id: 'provider-fallback', models: [{ id: 'model-fallback' }] },
            { id: 'provider-last', models: [{ id: 'model-last' }] },
          ],
        },
      }
    }
    return { ok: true, value: {} }
  }
}

class FakeWorkspace {
  constructor(private root: string) {}
  state(): { root: string } { return { root: this.root } }
  async setRoot(path: string): Promise<{ root: string; name: string }> { this.root = path; return { root: path, name: path.split('/').at(-1) ?? path } }
}

interface EngineRunOptions {
  sessionId?: string
  provider?: string
  model?: string
}

class FakeEngineRuns {
  protected runCount = 0
  private count = 0
  private readonly workspaceBySession = new Map<string, string | undefined>()
  stopped: string[] = []
  created: string[] = []
  runOptions: EngineRunOptions[] = []

  constructor(private readonly failFirst = false, private readonly failureMessage = 'Provider returned 502 Bad Gateway') {}

  async createSession(engineId: string, cwd?: string): Promise<{ sessionId: string; engineId: string }> {
    this.count += 1
    const sessionId = `worker-${this.count}`
    this.created.push(engineId)
    this.workspaceBySession.set(sessionId, cwd)
    return { engineId, sessionId }
  }

  async run(_prompt: string, options?: EngineRunOptions): Promise<{ sessionId: string }> {
    this.runCount += 1
    this.runOptions.push({ ...(options ?? {}) })
    const sessionId = options?.sessionId ?? 'worker'
    if (this.failFirst && this.runCount === 1) {
      const cwd = this.workspaceBySession.get(sessionId)
      if (cwd) await writeFile(join(cwd, 'partial-provider-write.txt'), 'partial\n')
      throw new Error(this.failureMessage)
    }
    return { sessionId }
  }

  async stopSession(sessionId: string): Promise<void> { this.stopped.push(sessionId) }
}

class AuthFailEngineRuns extends FakeEngineRuns {
  override async run(_prompt: string, options?: EngineRunOptions): Promise<{ sessionId: string }> {
    this.runCount += 1
    this.runOptions.push({ ...(options ?? {}) })
    throw new Error('401 unauthorized: invalid api key')
  }
}

async function organizationFixture(testCommand?: string, assignedEngine = ND_HARNESS_ENGINE_ID, engineRuns = new FakeEngineRuns(), harness = new FakeHarness()) {
  const root = await gitWorkspace()
  const stateDir = await mkdtemp(join(tmpdir(), 'nd-dsh-beta-state-'))
  const store = new OrganizationStore(join(stateDir, 'organization.json'))
  let state = await store.mutate({ type: 'company.create', name: 'Beta Co', mission: 'Ship safely' })
  const company = state.companies[0]!
  state = await store.mutate({ type: 'project.create', companyId: company.id, name: 'Beta App', objective: 'Pass QA', workspacePath: root, ...(testCommand ? { testCommand } : {}) })
  const project = state.projects[0]!
  await store.applyPlan(project.id, {
    goal: { title: 'Beta', description: 'Reach beta' },
    milestones: [{ title: 'Build', description: 'Build safely', tasks: [{ title: 'Feature', description: 'Implement feature' }] }],
  })
  const task = (await store.state()).tasks[0]!
  const engines = {
    assignedEngine: async () => assignedEngine,
    assertAvailable: (id: string) => ({ id, name: id === CODEX_CLI_ENGINE_ID ? 'Codex CLI' : 'ND Harness' }),
  }
  const orchestrator = new OrganizationOrchestrator(
    store,
    harness as never,
    new FakeWorkspace(root) as never,
    engines as never,
    engineRuns as never,
  )
  return { root, store, company, project, task, engineRuns, orchestrator }
}

describe('beta execution reliability', () => {
  it('classifies transient provider failures without retrying auth or deterministic failures', () => {
    expect(isRetryableExecutionFailure('Provider returned 502 Bad Gateway')).toBe(true)
    expect(isRetryableExecutionFailure('gateway-unreachable: ECONNRESET')).toBe(true)
    expect(isRetryableExecutionFailure('HTTP 429 Too Many Requests')).toBe(true)
    expect(isRetryableExecutionFailure('rate_limit: quota temporarily exhausted')).toBe(true)
    expect(isRetryableExecutionFailure('401 unauthorized invalid api key')).toBe(false)
    expect(isRetryableExecutionFailure('Machine verification failed: tests red')).toBe(false)
    expect(isRetryableExecutionFailure('Project workspace has uncommitted human changes')).toBe(false)
  })

  it('records passing and failing machine verification evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'nd-dsh-beta-verify-'))
    const pass = await runVerification(`"${process.execPath}" -e "process.exit(0)"`, cwd)
    const fail = await runVerification(`"${process.execPath}" -e "process.exit(3)"`, cwd)

    expect(pass.status).toBe('passed')
    expect(pass.exitCode).toBe(0)
    expect(fail.status).toBe('failed')
    expect(fail.exitCode).toBe(3)
  })

  it('rolls an ND-owned task worktree back to the exact attempt baseline', async () => {
    const root = await gitWorkspace()
    const manager = new TaskWorktreeManager()
    const worktree = await manager.ensure(root, 'rollback-task')
    expect(worktree).toBeDefined()
    const baseline = await manager.baseline(worktree!)
    const partial = join(worktree!.root, 'partial.txt')
    await writeFile(partial, 'provider died mid-write\n')

    await manager.rollback(worktree!, baseline)

    await expect(access(partial)).rejects.toThrow()
    expect(await manager.baseline(worktree!)).toBe(baseline)
  })

  it('stops and rolls back a stalled execution without waiting for its lease', async () => {
    const { root, store, task, engineRuns, orchestrator } = await organizationFixture()
    const run = await orchestrator.runTask(task.id)
    const manager = new TaskWorktreeManager()
    const worktree = await manager.existing(root, task.id)
    expect(worktree).toBeDefined()
    const partial = join(worktree!.root, 'half-written.txt')
    await writeFile(partial, 'partial\n')

    const recovered = await orchestrator.reconcileStalledRuns(Date.now() + 11 * 60 * 1_000)

    expect(recovered).toBe(1)
    expect(engineRuns.stopped).toEqual([run.sessionId])
    await expect(access(partial)).rejects.toThrow()
    const state = await store.state()
    expect(state.runs.find((item) => item.id === run.runId)?.status).toBe('failed')
    expect(state.tasks.find((item) => item.id === task.id)?.status).toBe('blocked')
  })

  it('returns a hung review to the review queue instead of leaving it reviewing forever', async () => {
    const { store, task, orchestrator } = await organizationFixture()
    await store.markForReview(task.id, 'Worker finished.')
    const review = await orchestrator.reviewTask(task.id)
    expect((await store.state()).tasks.find((item) => item.id === task.id)?.reviewSessionId).toBe(review.sessionId)

    const recovered = await orchestrator.reconcileStalledRuns(Date.now() + 11 * 60 * 1_000)

    expect(recovered).toBe(1)
    const state = await store.state()
    expect(state.runs.find((item) => item.id === review.runId)).toMatchObject({ status: 'failed' })
    expect(state.runs.find((item) => item.id === review.runId)?.error).toMatch(/Review stalled/)
    const after = state.tasks.find((item) => item.id === task.id)!
    expect(after.status).toBe('review')
    expect(after.reviewSessionId).toBeUndefined()
  })

  it('cancels one of two isolated parallel runs without stopping the other', async () => {
    const { store, company, project, task, engineRuns, orchestrator } = await organizationFixture()
    let state = await store.mutate({
      type: 'task.create', companyId: company.id, projectId: project.id,
      title: 'Parallel feature', description: 'Independent task', priority: 'high',
      acceptanceCriteria: ['Independent task completes.'],
      ...(task.assignedAgentId ? { assignedAgentId: task.assignedAgentId } : {}),
    })
    const second = state.tasks.find((item) => item.title === 'Parallel feature')!
    await store.mutate({ type: 'task.update', id: second.id, patch: { status: 'ready' } })

    const firstRun = await orchestrator.runTask(task.id)
    const secondRun = await orchestrator.runTask(second.id)
    await orchestrator.cancelRun(firstRun.runId)

    state = await store.state()
    expect(engineRuns.stopped).toEqual([firstRun.sessionId])
    expect(state.runs.find((item) => item.id === firstRun.runId)?.status).toBe('failed')
    expect(state.runs.find((item) => item.id === secondRun.runId)?.status).toBe('running')
  })

  it('rolls back a 502 attempt and retries on the next distinct Harness provider route in Autopilot', async () => {
    const engineRuns = new FakeEngineRuns(true)
    const { root, store, company, task, orchestrator } = await organizationFixture(undefined, CODEX_CLI_ENGINE_ID, engineRuns)
    await store.mutate({ type: 'company.update', id: company.id, patch: { autonomyLevel: 4 } })

    const initial = await orchestrator.runTask(task.id)
    await vi.waitFor(() => expect(engineRuns.runOptions).toHaveLength(2), { timeout: 3_000 })
    expect((await store.state()).runs.find((run) => run.id === initial.runId)?.error).toMatch(/502/)

    expect(engineRuns.created).toEqual([CODEX_CLI_ENGINE_ID, ND_HARNESS_ENGINE_ID])
    expect(engineRuns.runOptions[1]).toMatchObject({ provider: 'provider-primary', model: 'model-primary' })
    const manager = new TaskWorktreeManager()
    const worktree = await manager.existing(root, task.id)
    expect(worktree).toBeDefined()
    await expect(access(join(worktree!.root, 'partial-provider-write.txt'))).rejects.toThrow()
    const state = await store.state()
    const taskRuns = state.runs.filter((item) => item.taskId === task.id && item.kind === 'task-execution')
    expect(taskRuns).toHaveLength(2)
    expect(taskRuns.some((item) => item.status === 'failed' && /502/.test(item.error ?? '') && /nd-dsh-execution-route/.test(item.output ?? ''))).toBe(true)
    expect(taskRuns.some((item) => item.status === 'running')).toBe(true)
  })

  it('retries a transient capacity failure on the same route when no fallback exists', async () => {
    const engineRuns = new FakeEngineRuns(true, '503 chat_admission_busy: retry shortly')
    const harness = new FakeHarness()
    harness.gatewayRpc = async (method: string) => method === 'session.models'
      ? { ok: true, value: { groups: [{ id: 'provider-primary', models: [{ id: 'model-primary' }] }] } }
      : { ok: true, value: {} }
    const { store, company, task, orchestrator } = await organizationFixture(undefined, ND_HARNESS_ENGINE_ID, engineRuns, harness)
    await store.mutate({ type: 'company.update', id: company.id, patch: { autonomyLevel: 4 } })

    await expect(orchestrator.runTask(task.id)).rejects.toThrow(/503/)

    expect(engineRuns.created).toEqual([ND_HARNESS_ENGINE_ID, ND_HARNESS_ENGINE_ID])
    expect(engineRuns.runOptions).toHaveLength(2)
    expect(engineRuns.runOptions[1]).not.toHaveProperty('provider')
    expect(engineRuns.runOptions[1]).not.toHaveProperty('model')
    const state = await store.state()
    expect(state.tasks.find((item) => item.id === task.id)?.status).toBe('in_progress')
    expect(state.runs.filter((item) => item.taskId === task.id && item.kind === 'task-execution')).toHaveLength(2)
    expect(state.runs.some((item) => item.status === 'running')).toBe(true)
  })

  it('does not fail over authentication/configuration failures', async () => {
    const engineRuns = new AuthFailEngineRuns()
    const { store, company, task, orchestrator } = await organizationFixture(undefined, CODEX_CLI_ENGINE_ID, engineRuns)
    await store.mutate({ type: 'company.update', id: company.id, patch: { autonomyLevel: 4 } })

    const initial = await orchestrator.runTask(task.id)
    await vi.waitFor(async () => expect((await store.taskContext(task.id)).task.status).toBe('blocked'))
    expect((await store.state()).runs.find((run) => run.id === initial.runId)?.error).toMatch(/unauthorized/i)

    expect(engineRuns.created).toEqual([CODEX_CLI_ENGINE_ID])
    expect(engineRuns.runOptions).toHaveLength(1)
    const state = await store.state()
    expect(state.runs.filter((item) => item.taskId === task.id && item.kind === 'task-execution')).toHaveLength(1)
    expect(state.tasks.find((item) => item.id === task.id)?.status).toBe('blocked')
  })

  it('hard-blocks completion when the configured machine verification command fails', async () => {
    const failCommand = `"${process.execPath}" -e "process.exit(7)"`
    const { store, task, orchestrator } = await organizationFixture(failCommand)
    const run = await orchestrator.runTask(task.id)

    await orchestrator.handleHarnessEvent({ kind: 'session-status', sessionId: run.sessionId, running: false })

    const state = await store.state()
    const storedRun = state.runs.find((item) => item.id === run.runId)
    expect(storedRun?.status).toBe('failed')
    expect(storedRun?.error).toMatch(/machine verification failed/i)
    expect(storedRun?.output).toContain('<nd-dsh-verification>')
    expect(storedRun?.output).toContain('<nd-dsh-execution-route>')
    expect(state.tasks.find((item) => item.id === task.id)?.status).toBe('blocked')
  })
})
