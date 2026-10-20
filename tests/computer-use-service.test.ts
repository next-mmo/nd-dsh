import { describe, expect, it, vi } from 'vitest'
import type {
  CoreComputer,
  CoreComputerAppState,
  CoreComputerApps,
} from '../src/main/core/core-computer.js'
import { ComputerUseService, type ComputerUseCallContext } from '../src/main/extensions/computer-use-service.js'

const userContext: ComputerUseCallContext = {
  extensionId: 'nd.computer-use',
  contextKey: 'personal',
  caller: 'user',
}

function apps(): CoreComputerApps {
  return {
    apps: [{
      id: 'win32:notepad',
      displayName: 'notepad',
      isRunning: true,
      windows: [{ id: 'win32:1:2', title: 'Untitled - Notepad', width: 800, height: 600, focused: true, minimized: false }],
    }],
    truncated: false,
  }
}

function state(overrides: Partial<CoreComputerAppState> = {}): CoreComputerAppState {
  return {
    app: { id: 'win32:notepad', displayName: 'notepad' },
    window: { id: 'win32:1:2', title: 'Untitled - Notepad' },
    screenshots: [],
    accessibility: { tree: '[0] Window "Untitled - Notepad"' },
    textMode: 'full',
    stateId: 'abc123',
    stats: { nodes: 1, truncated: false, elapsedMs: 4 },
    limits: { maxNodes: 1500, maxDepth: 24, maxTextChars: 48_000, maxScreenshotBytes: 131_072 },
    ...overrides,
  }
}

function fakeCore(overrides: Partial<CoreComputer> = {}): CoreComputer {
  return {
    listApps: vi.fn(async () => apps()),
    appState: vi.fn(async () => state()),
    resetSession: vi.fn(async () => ({ reset: true })),
    ...overrides,
  }
}

describe('ComputerUseService', () => {
  it('derives a stable per-package, per-context session id', () => {
    const service = new ComputerUseService(fakeCore())
    const first = service.sessionId('nd.computer-use', 'personal')
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(service.sessionId('nd.computer-use', 'personal')).toBe(first)
    expect(service.sessionId('nd.computer-use', 'other')).not.toBe(first)
    expect(service.sessionId('other.package', 'personal')).not.toBe(first)
  })

  it('strips window titles for agent callers only', async () => {
    const core = fakeCore()
    const service = new ComputerUseService(core)

    const user = await service.listApps(userContext)
    expect(user.apps[0]?.windows[0]?.title).toBe('Untitled - Notepad')

    const agent = await service.listApps({ ...userContext, caller: 'agent' })
    expect(agent.apps[0]?.windows[0]).not.toHaveProperty('title')
    expect(agent.apps[0]?.windows[0]?.id).toBe('win32:1:2')
  })

  it('derives the session id and forwards only validated options', async () => {
    const appState = vi.fn(async () => state())
    const service = new ComputerUseService(fakeCore({ appState }))
    await service.appState({ app: ' notepad ', windowId: 'win32:1:2', includeText: true }, userContext)
    expect(appState).toHaveBeenCalledWith({
      app: 'notepad',
      windowId: 'win32:1:2',
      sessionId: service.sessionId('nd.computer-use', 'personal'),
      includeText: true,
    })
  })

  it('rejects missing and malformed input', async () => {
    const service = new ComputerUseService(fakeCore())
    await expect(service.appState({}, userContext)).rejects.toThrow(/App is required/)
    await expect(service.appState({ app: 'notepad', windowId: 'x'.repeat(129) }, userContext)).rejects.toThrow(/Window id/)
    await expect(service.appState({ app: 'notepad', includeText: 'yes' }, userContext)).rejects.toThrow(/booleans/)
  })

  it('allows one in-flight read per session', async () => {
    let release: (value: CoreComputerAppState) => void = () => undefined
    const pending = new Promise<CoreComputerAppState>((resolve) => { release = resolve })
    const appState = vi.fn(async () => await pending)
    const service = new ComputerUseService(fakeCore({ appState }))
    const active = service.appState({ app: 'notepad' }, userContext)
    await expect(service.appState({ app: 'notepad' }, userContext)).rejects.toThrow(/already in progress/)
    release(state())
    await expect(active).resolves.toMatchObject({ stateId: 'abc123' })
  })

  it('rate-limits reads per session', async () => {
    const service = new ComputerUseService(fakeCore())
    for (let index = 0; index < 4; index += 1) await service.listApps(userContext)
    await expect(service.listApps(userContext)).rejects.toThrow(/too quickly/)
  })

  it('drops an oversized screenshot and reports why', async () => {
    const service = new ComputerUseService(fakeCore({
      appState: async () => state({
        screenshots: [{
          id: 'shot-1',
          zIndex: 0,
          url: `data:image/jpeg;base64,${'A'.repeat(300_000)}`,
        }],
      }),
    }))
    const result = await service.appState({ app: 'notepad' }, userContext)
    expect(result.screenshots).toEqual([])
    expect(result.screenshotUnavailable).toBe('bridge-budget')
  })

  it('truncates an oversized tree to the web-view budget', async () => {
    const service = new ComputerUseService(fakeCore({
      appState: async () => state({
        accessibility: { tree: 'x'.repeat(300_000) },
      }),
    }))
    const result = await service.appState({ app: 'notepad' }, userContext)
    expect(result.accessibility?.tree.length).toBeLessThan(300_000)
    expect(result.stats.truncated).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(262_144)
  })

  it('resets the same derived session on deactivation', async () => {
    const resetSession = vi.fn(async () => ({ reset: true }))
    const service = new ComputerUseService(fakeCore({ resetSession }))
    await expect(service.reset('nd.computer-use', 'personal')).resolves.toBe(true)
    expect(resetSession).toHaveBeenCalledWith(service.sessionId('nd.computer-use', 'personal'))
  })
})
