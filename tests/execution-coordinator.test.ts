import { describe, expect, it } from 'vitest'
import { ExecutionCoordinator, RuntimeCapacityError, type CapacityReleaseEvent } from '../src/main/organization/execution-coordinator.js'

describe('ExecutionCoordinator', () => {
  it('drains 26 independent queued tasks within four permits and preserves each async owner', async () => {
    const coordinator = new ExecutionCoordinator()
    let active = 0
    let peak = 0
    const completed: string[] = []
    await Promise.all(Array.from({ length: 26 }, async (_, index) => {
      const taskId = `task-${index}`
      const permit = await coordinator.acquireWhenAvailable({
        kind: 'execution', projectId: 'nd-translate', taskId,
        pools: [{ key: 'project:nd-translate:execution', limit: 4 }],
      }, 5_000)
      try {
        await coordinator.runWithPermit(permit, async () => {
          active += 1
          peak = Math.max(peak, active)
          await Promise.resolve()
          expect(coordinator.currentPermit()?.input.taskId).toBe(taskId)
          completed.push(taskId)
          active -= 1
        })
      } finally {
        await coordinator.release(permit)
      }
    }))
    expect(peak).toBe(4)
    expect(new Set(completed).size).toBe(26)
    expect(coordinator.currentPermit()).toBeUndefined()
    expect(coordinator.snapshot().activePermits).toBe(0)
    await coordinator.close()
  })

  it('rejects fresh and queued dispatch after shutdown starts', async () => {
    const coordinator = new ExecutionCoordinator()
    const input = { kind: 'execution' as const, pools: [{ key: 'project:p:execution', limit: 1 }] }
    await coordinator.acquire(input)
    const waiting = coordinator.acquireWhenAvailable(input, 1_000)
    const rejected = expect(waiting).rejects.toThrow(/closed/i)
    await coordinator.close()
    await rejected
    await expect(coordinator.acquire(input)).rejects.toThrow(/closed/i)
    await expect(coordinator.availability(input.pools)).resolves.toMatchObject({ granted: false, reason: expect.stringMatching(/closed/i) })
    expect(coordinator.snapshot().activePermits).toBe(0)
  })

  it('releases a core permit granted while shutdown was in progress', async () => {
    let grant!: (value: unknown) => void
    const released: unknown[] = []
    const core = {
      request: async (method: string, params: unknown) => {
        if (method === 'scheduler.acquire') return new Promise((resolve) => { grant = resolve })
        if (method === 'scheduler.release') released.push(params)
        return {}
      },
      onEvent: () => () => undefined,
    }
    const coordinator = new ExecutionCoordinator(core as never)
    const acquiring = coordinator.acquire({ kind: 'execution', pools: [{ key: 'project:p:execution', limit: 1 }] })
    const rejected = expect(acquiring).rejects.toThrow(/closed/i)
    await Promise.resolve()
    await Promise.resolve()
    await coordinator.close()
    grant({ granted: true, permit: { id: 'native-permit' } })
    await rejected
    expect(released).toHaveLength(1)
    expect(coordinator.snapshot().activePermits).toBe(0)
  })

  it('does not retain a session binding completed after its permit was released', async () => {
    let finishBind!: () => void
    let signalBind!: () => void
    const bindingStarted = new Promise<void>((resolve) => { signalBind = resolve })
    const core = {
      request: async (method: string) => {
        if (method === 'scheduler.acquire') return { granted: true, permit: { id: 'native-permit' } }
        if (method === 'scheduler.bind') {
          signalBind()
          await new Promise<void>((resolve) => { finishBind = resolve })
        }
        return {}
      },
      onEvent: () => () => undefined,
    }
    const coordinator = new ExecutionCoordinator(core as never)
    const permit = await coordinator.acquire({ kind: 'execution', pools: [{ key: 'project:p:execution', limit: 1 }] })
    const binding = coordinator.bindSession(permit, 'session-after-close')
    const rejected = expect(binding).rejects.toThrow(/closed|no longer active/i)
    await bindingStarted
    const closing = coordinator.close()
    finishBind()
    await rejected
    await closing
    expect(coordinator.snapshot()).toMatchObject({ activePermits: 0, sessions: 0 })
  })

  it('acquires all required pools atomically and exposes the active permit to engine spawns', async () => {
    const coordinator = new ExecutionCoordinator()
    const first = await coordinator.acquire({
      companyId: 'company-1',
      projectId: 'project-1',
      taskId: 'task-1',
      agentId: 'agent-1',
      kind: 'execution',
      pools: [
        { key: 'project:project-1:execution', limit: 1 },
        { key: 'project:project-1:role:engineer', limit: 1 },
      ],
    })

    await coordinator.runWithPermit(first, async () => {
      expect(coordinator.currentPermitId()).toBe(first.id)
    })

    await expect(coordinator.acquire({
      companyId: 'company-1',
      projectId: 'project-1',
      taskId: 'task-2',
      agentId: 'agent-2',
      kind: 'execution',
      pools: [
        { key: 'project:project-1:team:engineering', limit: 1 },
        { key: 'project:project-1:execution', limit: 1 },
      ],
    })).rejects.toThrow(/runtime capacity reached/i)

    // The failed multi-pool acquire must not reserve its earlier team claim.
    const independent = await coordinator.acquire({
      kind: 'execution',
      pools: [{ key: 'project:project-1:team:engineering', limit: 1 }],
    })

    await coordinator.bindSession(first, 'session-1', 'run-1')
    expect(coordinator.snapshot()).toMatchObject({ activePermits: 2, sessions: 1, local: true })
    await coordinator.releaseSession('session-1')
    await coordinator.release(independent)
    expect(coordinator.snapshot()).toEqual({ activePermits: 0, sessions: 0, local: true })
    await coordinator.close()
  })

  it('invalidates permits on core exit and blocks dispatch until durable reconciliation resumes it', async () => {
    const listeners = new Map<string, Set<(frame: never) => void>>()
    const core = {
      request: async () => ({ granted: true, permit: { id: 'native-permit' } }),
      onEvent: (event: string, listener: (frame: never) => void) => {
        let set = listeners.get(event)
        if (!set) { set = new Set(); listeners.set(event, set) }
        set.add(listener)
        return () => set?.delete(listener)
      },
    }
    const coordinator = new ExecutionCoordinator(core as never)
    const permit = await coordinator.acquire({ kind: 'execution', pools: [{ key: 'project:p:execution', limit: 1 }] })
    expect(coordinator.snapshot().activePermits).toBe(1)

    for (const listener of listeners.get('core.exit') ?? []) listener({} as never)
    expect(coordinator.snapshot().activePermits).toBe(0)
    expect(coordinator.recoveryRequired()).toBe(true)
    await expect(coordinator.acquire({ kind: 'execution', pools: [{ key: 'project:p:execution', limit: 1 }] }))
      .rejects.toThrow(/must be reconciled/i)

    coordinator.resumeAfterReconciliation()
    expect(coordinator.recoveryRequired()).toBe(false)
    await coordinator.close()
    expect(permit.id).toBeTruthy()
  })

  it('keeps review and execution pools independent', async () => {
    const coordinator = new ExecutionCoordinator()
    const execution = await coordinator.acquire({
      kind: 'execution',
      pools: [{ key: 'project:p:execution', limit: 1 }],
    })
    const review = await coordinator.acquire({
      kind: 'review',
      pools: [{ key: 'project:p:review', limit: 1 }],
    })

    expect(coordinator.snapshot().activePermits).toBe(2)
    await coordinator.release(execution)
    await coordinator.release(review)
    await coordinator.close()
  })

  it('answers availability per pool without reserving, and names the pool that refuses', async () => {
    const coordinator = new ExecutionCoordinator()
    const pools = [
      { key: 'project:p:execution', limit: 2 },
      { key: 'project:p:role:engineer', limit: 1 },
    ]

    await expect(coordinator.availability(pools)).resolves.toEqual({ granted: true })

    const permit = await coordinator.acquire({ kind: 'execution', projectId: 'p', pools })
    await expect(coordinator.availability(pools)).resolves.toEqual({
      granted: false,
      reason: 'Runtime pool project:p:role:engineer is full (1/1).',
      blockedPool: 'project:p:role:engineer',
    })
    // The probe is not a reservation: it never consumed the project's second slot.
    await expect(coordinator.availability([{ key: 'project:p:execution', limit: 2 }])).resolves.toEqual({ granted: true })
    // A different role's pool is independent of the saturated one.
    await expect(coordinator.availability([{ key: 'project:p:role:reviewer', limit: 1 }])).resolves.toEqual({ granted: true })

    await coordinator.release(permit)
    await expect(coordinator.availability(pools)).resolves.toEqual({ granted: true })
    await coordinator.close()
  })

  it('refuses an over-capacity acquire with a typed error rather than a message to match', async () => {
    const coordinator = new ExecutionCoordinator()
    const pools = [{ key: 'project:p:execution', limit: 1 }]
    await coordinator.acquire({ kind: 'execution', projectId: 'p', pools })

    await expect(coordinator.acquire({ kind: 'execution', projectId: 'p', pools }))
      .rejects.toBeInstanceOf(RuntimeCapacityError)
    await coordinator.close()
  })

  it('waits out a full pool instead of refusing an explicit dispatch', async () => {
    const coordinator = new ExecutionCoordinator()
    const pools = [{ key: 'project:p:execution', limit: 1 }]
    const holding = await coordinator.acquire({ kind: 'execution', projectId: 'p', pools })

    const waiting = coordinator.acquireWhenAvailable({ kind: 'execution', projectId: 'p', taskId: 'task-2', pools }, 5_000)
    await new Promise((resolve) => setTimeout(resolve, 60))
    // The waiter must not have reserved the slot it is waiting for.
    expect(coordinator.snapshot().activePermits).toBe(1)

    await coordinator.release(holding)
    const queued = await waiting
    expect(queued.input.taskId).toBe('task-2')
    expect(coordinator.snapshot().activePermits).toBe(1)

    await coordinator.release(queued)
    await coordinator.close()
  })

  it('reports the pool as full once the wait deadline passes', async () => {
    const coordinator = new ExecutionCoordinator()
    const pools = [{ key: 'project:p:execution', limit: 1 }]
    const holding = await coordinator.acquire({ kind: 'execution', projectId: 'p', pools })

    await expect(coordinator.acquireWhenAvailable({ kind: 'execution', projectId: 'p', pools }, 300))
      .rejects.toBeInstanceOf(RuntimeCapacityError)
    // Giving up must not have disturbed the permit that is legitimately running.
    expect(coordinator.snapshot().activePermits).toBe(1)

    await coordinator.release(holding)
    await coordinator.close()
  })

  it('does not spend the deadline waiting on a state that waiting cannot fix', async () => {
    const coordinator = new ExecutionCoordinator()
    // A blocked coordinator needs durable-run reconciliation. Retrying the same
    // acquire until the deadline would only delay an error the caller must see.
    coordinator.invalidateForCoreRestart('ND Core restarted while organization work was active. Durable runs must be reconciled before new dispatch.')
    const started = Date.now()
    await expect(coordinator.acquireWhenAvailable({ kind: 'execution', pools: [{ key: 'project:p:execution', limit: 1 }] }, 5_000))
      .rejects.toThrow(/must be reconciled/i)
    expect(Date.now() - started).toBeLessThan(1_000)
    await coordinator.close()
  })

  it('announces capacity releases for resume, and stays silent while closing', async () => {
    const coordinator = new ExecutionCoordinator()
    const events: CapacityReleaseEvent[] = []
    const stop = coordinator.onCapacityReleased((event) => events.push(event))

    const execution = await coordinator.acquire({ kind: 'execution', projectId: 'p', pools: [{ key: 'project:p:execution', limit: 1 }] })
    await coordinator.release(execution)
    expect(events).toEqual([{ kind: 'execution', projectId: 'p' }])

    stop()
    const review = await coordinator.acquire({ kind: 'review', projectId: 'p', pools: [{ key: 'project:p:review', limit: 1 }] })
    await coordinator.release(review)
    expect(events).toHaveLength(1)

    // Closing the app releases its permits too; none of those may start work.
    const duringClose: CapacityReleaseEvent[] = []
    coordinator.onCapacityReleased((event) => duringClose.push(event))
    const last = await coordinator.acquire({ kind: 'execution', projectId: 'p', pools: [{ key: 'project:p:execution', limit: 1 }] })
    await coordinator.close()
    expect(duringClose).toEqual([])
    expect(last.id).toBeTruthy()
  })
})
