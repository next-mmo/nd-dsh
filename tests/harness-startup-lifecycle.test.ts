import { describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { DshEventFrame } from '../src/shared/contracts.js'
import type { GatewayClient } from '../src/main/dsh/gateway-client.js'
import { dshWebUrl, HarnessService } from '../src/main/harness/harness-service.js'

interface HarnessStartupSeam {
  gateway?: unknown
  startPromise?: Promise<unknown>
  startPromiseGeneration?: number | undefined
  stopping: boolean
  runtimeGeneration: number
  expectedChildExits: WeakSet<ChildProcess>
  tokenSaverEnabled(): boolean
  start(): Promise<unknown>
  close(): Promise<void>
  updateStatus(state: string, error?: string): void
  ensureStarted(): Promise<unknown>
}

describe('HarnessService startup lifecycle', () => {
  it('extracts only the authenticated URL for the assigned loopback origin', () => {
    const output = [
      'noise',
      'dsh web: http://127.0.0.1:4123/?token=wrong-port',
      'dsh web: http://127.0.0.1:4124/?token=right-token (LAN: http://10.0.0.2:4124/?token=right-token)',
    ].join('\n')

    expect(dshWebUrl(output, 'http://127.0.0.1:4124')).toBe('http://127.0.0.1:4124/?token=right-token')
  })

  it('cleans up a partial launch and leaves starting state on failure', async () => {
    const service = Object.create(HarnessService.prototype) as HarnessStartupSeam
    const failure = new Error('Runtime gateway did not become ready within the timeout')

    service.stopping = false
    service.tokenSaverEnabled = () => true
    service.start = vi.fn().mockRejectedValue(failure)
    service.close = vi.fn(async () => {
      service.stopping = true
      service.updateStatus('stopped')
    })
    service.updateStatus = vi.fn()

    await expect(service.ensureStarted()).rejects.toBe(failure)

    expect(service.close).toHaveBeenCalledOnce()
    expect(service.updateStatus).toHaveBeenLastCalledWith('error', failure.message)
    expect(service.startPromise).toBeUndefined()
  })

  it('does not turn an intentional shutdown into a startup error', async () => {
    const service = Object.create(HarnessService.prototype) as HarnessStartupSeam

    service.stopping = true
    service.tokenSaverEnabled = () => true
    service.start = vi.fn().mockRejectedValue(new Error('Runtime exited'))
    service.close = vi.fn(async () => {
      service.updateStatus('stopped')
    })
    service.updateStatus = vi.fn()

    await expect(service.ensureStarted()).rejects.toThrow('Runtime exited')

    expect(service.updateStatus).toHaveBeenCalledTimes(1)
    expect(service.updateStatus).toHaveBeenCalledWith('stopped')
  })
})

interface HarnessExitSeam {
  child: ChildProcess | undefined
  gateway: GatewayClient | undefined
  baseUrl: string | undefined
  activeSessionId: string | undefined
  stopping: boolean
  runtimeGeneration: number
  expectedChildExits: WeakSet<ChildProcess>
  runningSessions: Set<string>
  canceledSessions: Set<string>
  eventHub: { detach(): void }
  onEvent?: (frame: DshEventFrame) => void
  updateStatus(state: string, error?: string): void
  handleChildExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null, detail: string): void
  handleGatewayEvent(child: ChildProcess, gateway: GatewayClient, frame: DshEventFrame): void
  close(): Promise<void>
}

function exitFixture() {
  const service = Object.create(HarnessService.prototype) as HarnessExitSeam
  const child = {} as ChildProcess
  const gateway = { close: vi.fn() } as unknown as GatewayClient
  service.child = child
  service.gateway = gateway
  service.baseUrl = 'http://127.0.0.1:4000'
  service.activeSessionId = 'pm'
  service.stopping = false
  service.runtimeGeneration = 0
  service.expectedChildExits = new WeakSet()
  service.runningSessions = new Set(['pm', 'worker'])
  service.canceledSessions = new Set(['canceled'])
  service.eventHub = { detach: vi.fn() }
  service.updateStatus = vi.fn()
  service.onEvent = vi.fn()
  return { service, child, gateway }
}

describe('HarnessService child-exit interruption', () => {
  it('notifies every known running session once after retiring the unexpected child and before recovery', () => {
    const { service, child, gateway } = exitFixture()
    const frames: DshEventFrame[] = []
    service.onEvent = (frame) => {
      expect(service.child).toBeUndefined()
      expect(service.gateway).toBeUndefined()
      expect(service.activeSessionId).toBeUndefined()
      expect(service.runningSessions.size).toBe(0)
      frames.push(frame)
    }
    service.handleChildExit(child, null, 'SIGTERM', '')
    expect(gateway.close).toHaveBeenCalledOnce()
    expect(service.eventHub.detach).toHaveBeenCalledOnce()
    expect(service.updateStatus).toHaveBeenLastCalledWith('error', 'Runtime exited (SIGTERM):')
    expect(frames.map((frame) => frame.sessionId)).toEqual(['pm', 'worker'])
    for (const frame of frames) {
      expect(frame.kind).toBe('session-event')
      expect(frame.event).toMatchObject({ type: 'turn/end', seq: 0, data: { reason: { kind: 'interrupted', message: 'Runtime exited (SIGTERM):' } } })
      expect(Number.isSafeInteger(frame.event?.seq)).toBe(true)
      expect(frame.meta).toEqual({ source: 'nd-harness-adapter' })
    }
    service.handleChildExit(child, null, 'SIGTERM', '')
    expect(frames).toHaveLength(2)
    expect(service.canceledSessions.has('canceled')).toBe(true)
  })

  it('keeps expected shutdown quiet and clears retired session state', () => {
    const { service, child } = exitFixture()
    service.stopping = true
    service.expectedChildExits.add(child)
    service.handleChildExit(child, 0, null, '')
    expect(service.onEvent).not.toHaveBeenCalled()
    expect(service.runningSessions.size).toBe(0)
    expect(service.activeSessionId).toBeUndefined()
    expect(service.updateStatus).toHaveBeenCalledWith('stopped', undefined)
    expect(service.canceledSessions.has('canceled')).toBe(true)
  })

  it('ignores a stale old child exit without touching replacement tracking or gateway', () => {
    const { service, child, gateway } = exitFixture()
    const replacement = {} as ChildProcess
    service.child = replacement
    service.handleChildExit(child, null, 'SIGTERM', 'old failure')
    expect(service.child).toBe(replacement)
    expect(service.gateway).toBe(gateway)
    expect(service.runningSessions).toEqual(new Set(['pm', 'worker']))
    expect(gateway.close).not.toHaveBeenCalled()
    expect(service.eventHub.detach).not.toHaveBeenCalled()
    expect(service.onEvent).not.toHaveBeenCalled()
    expect(service.updateStatus).not.toHaveBeenCalled()
  })

  it('does not inherit a prior global stopping flag for an unmarked current runtime', () => {
    const { service, child } = exitFixture()
    service.stopping = true
    service.handleChildExit(child, null, 'SIGTERM', '')
    expect(service.updateStatus).toHaveBeenCalledWith('error', 'Runtime exited (SIGTERM):')
    expect(service.onEvent).toHaveBeenCalledTimes(2)
  })

  it('rejects stale status callbacks after exit and after replacement', () => {
    const { service, child, gateway } = exitFixture()
    service.handleChildExit(child, 1, null, '')
    service.handleGatewayEvent(child, gateway, { kind: 'session-status', sessionId: 'pm', running: true })
    expect(service.runningSessions.size).toBe(0)
    const replacement = {} as ChildProcess
    const replacementGateway = { close: vi.fn() } as unknown as GatewayClient
    service.child = replacement
    service.gateway = replacementGateway
    service.handleGatewayEvent(child, gateway, { kind: 'session-status', sessionId: 'pm', running: true })
    service.handleGatewayEvent(replacement, replacementGateway, { kind: 'session-status', sessionId: 'replacement-session', running: true })
    expect(service.runningSessions).toEqual(new Set(['replacement-session']))
  })

  it('does not interrupt sessions already reported completed or canceled', () => {
    const { service, child, gateway } = exitFixture()
    service.handleGatewayEvent(child, gateway, { kind: 'session-status', sessionId: 'worker', running: false })
    service.runningSessions.delete('canceled')
    service.handleChildExit(child, 1, null, '')
    expect(service.onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'session-event', sessionId: 'pm' }))
    expect(vi.mocked(service.onEvent!).mock.calls.filter(([frame]) => frame.kind === 'session-event')).toHaveLength(1)
  })

  it('does not overwrite state created by a reentrant recovery listener', () => {
    const { service, child } = exitFixture()
    const replacement = {} as ChildProcess
    const replacementGateway = { close: vi.fn() } as unknown as GatewayClient
    let calls = 0
    service.onEvent = () => {
      if (calls++ === 0) {
        service.child = replacement
        service.gateway = replacementGateway
        service.runningSessions.add('new-session')
      }
    }
    service.handleChildExit(child, 1, null, '')
    expect(calls).toBe(2)
    expect(service.child).toBe(replacement)
    expect(service.gateway).toBe(replacementGateway)
    expect(service.runningSessions).toEqual(new Set(['new-session']))
  })

  it('keeps cancellation intent for an interrupted session and still notifies others if a listener throws', () => {
    const { service, child } = exitFixture()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    service.canceledSessions.add('pm')
    const frames: DshEventFrame[] = []
    service.onEvent = (frame) => {
      frames.push(frame)
      if (frame.sessionId === 'pm') throw new Error('notification failed')
    }
    try {
      expect(() => service.handleChildExit(child, 1, null, '')).not.toThrow()
      expect(frames.map((frame) => frame.sessionId)).toEqual(['pm', 'worker'])
      expect(service.canceledSessions.has('pm')).toBe(true)
      expect(error).toHaveBeenCalledOnce()
    } finally { error.mockRestore() }
  })
})

describe('HarnessService canceled asynchronous launch', () => {
  function launchFixture(stage: 'browser' | 'config') {
    const { service } = exitFixture()
    service.child = undefined
    service.gateway = undefined
    let resume!: () => void
    const pending = new Promise<void>((resolve) => { resume = resolve })
    const startup = service as HarnessExitSeam & HarnessStartupSeam & {
      workspace: { assertUsable(): void }
      browser: { ensureAgentReady(): Promise<void>; assertAgentConfigReady(): Promise<void> }
    }
    startup.workspace = { assertUsable: vi.fn() }
    startup.browser = {
      ensureAgentReady: vi.fn().mockReturnValue(stage === 'browser' ? pending : Promise.resolve()),
      assertAgentConfigReady: vi.fn().mockReturnValue(stage === 'config' ? pending : Promise.resolve()),
    }
    startup.tokenSaverEnabled = () => true
    return { startup, resume }
  }

  it.each(['browser', 'config'] as const)('aborts a late launch after close during %s preparation', async (stage) => {
    const { startup, resume } = launchFixture(stage)
    const launch = startup.start()
    await Promise.resolve()
    await startup.close()
    resume()
    await expect(launch).rejects.toThrow('startup was canceled')
    expect(startup.child).toBeUndefined()
    expect(startup.gateway).toBeUndefined()
    expect(startup.updateStatus).toHaveBeenLastCalledWith('stopped')
    if (stage === 'browser') expect(startup.browser.assertAgentConfigReady).not.toHaveBeenCalled()
  })

  it('a new-generation request waits for the canceled boot then launches once instead of inheriting its rejection', async () => {
    const { startup, resume } = launchFixture('browser')
    const firstStart = startup.start.bind(startup)
    const replacement = { rpc: vi.fn() }
    let calls = 0
    startup.start = vi.fn(() => {
      if (calls++ === 0) return firstStart()
      startup.stopping = false
      startup.gateway = replacement as unknown as GatewayClient
      return Promise.resolve(replacement)
    })
    const oldRequest = startup.ensureStarted()
    // Observe the expected rejection promptly, before releasing its deferred preparation.
    const oldResult = expect(oldRequest).rejects.toThrow('startup was canceled')
    await startup.close()
    const newGeneration = startup.runtimeGeneration
    const newRequest = startup.ensureStarted()
    const concurrentRequest = startup.ensureStarted()
    resume()
    await oldResult
    expect(startup.runtimeGeneration).toBe(newGeneration)
    await expect(newRequest).resolves.toBe(replacement)
    await expect(concurrentRequest).resolves.toBe(replacement)
    expect(startup.start).toHaveBeenCalledTimes(2)
  })

  it('rejects a waiting request superseded by another close and admits only the latest generation', async () => {
    const { startup, resume } = launchFixture('browser')
    const firstStart = startup.start.bind(startup)
    const replacement = { rpc: vi.fn() }
    let calls = 0
    startup.start = vi.fn(() => {
      if (calls++ === 0) return firstStart()
      startup.stopping = false
      startup.gateway = replacement as unknown as GatewayClient
      return Promise.resolve(replacement)
    })
    const oldRequest = startup.ensureStarted()
    const oldResult = expect(oldRequest).rejects.toThrow('startup was canceled')
    await startup.close()
    const waitingRequest = startup.ensureStarted()
    const waitingResult = expect(waitingRequest).rejects.toThrow('startup was canceled')
    await startup.close()
    const latestGeneration = startup.runtimeGeneration
    const latestRequest = startup.ensureStarted()
    resume()
    await oldResult
    await waitingResult
    await expect(latestRequest).resolves.toBe(replacement)
    expect(startup.runtimeGeneration).toBe(latestGeneration)
    expect(startup.start).toHaveBeenCalledTimes(2)
  })

  it('marks only the captured child as expected before an intentional close', async () => {
    const { service, child } = exitFixture()
    Object.assign(child, { exitCode: 0, signalCode: null })
    await service.close()
    expect(service.expectedChildExits.has(child)).toBe(true)
    expect(service.expectedChildExits.has({} as ChildProcess)).toBe(false)
    service.handleChildExit(child, 0, null, '')
    expect(service.onEvent).not.toHaveBeenCalled()
  })

  it('does not clear replacement session tracking when an old close finishes late', async () => {
    const { service } = exitFixture()
    const oldChild = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn() }) as unknown as ChildProcess
    service.child = oldChild
    const closing = service.close()
    expect(oldChild.kill).toHaveBeenCalledOnce()
    const replacement = {} as ChildProcess
    const replacementGateway = { close: vi.fn() } as unknown as GatewayClient
    service.child = replacement
    service.gateway = replacementGateway
    service.activeSessionId = 'replacement-session'
    service.runningSessions.add('replacement-session')
    service.updateStatus('running')
    oldChild.emit('exit', 0, null)
    await closing
    expect(service.child).toBe(replacement)
    expect(service.gateway).toBe(replacementGateway)
    expect(service.activeSessionId).toBe('replacement-session')
    expect(service.runningSessions).toEqual(new Set(['replacement-session']))
    expect(service.updateStatus).toHaveBeenLastCalledWith('running')
    expect(replacementGateway.close).not.toHaveBeenCalled()
  })
})
