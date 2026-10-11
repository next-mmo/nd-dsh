import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { HarnessService } from '../src/main/harness/harness-service.js'

vi.mock('electron', () => ({ app: { getPath: () => '/nd-test-data' } }))
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: () => true, promises: { ...actual.promises, mkdir: vi.fn(), cp: vi.fn() } }
})
vi.mock('../src/main/app-paths.js', () => ({
  bundledResourceRoot: () => '/nd-test-resources',
  dshPatchPath: () => '/nd-test-patch.mjs',
  harnessCliBinPath: () => '/nd-test-runtime.mjs',
  harnessNodeBinPath: () => '/nd-test-node',
  harnessRoot: () => '/nd-test-runtime',
  presetSourceDir: () => '/nd-test-presets',
}))
vi.mock('../src/main/harness/profile-plugin-links.js', () => ({ ensureProfilePluginLinks: vi.fn() }))
vi.mock('../src/main/dsh/gateway-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/dsh/gateway-client.js')>()
  return { ...actual, pickFreePort: async () => 4124 }
})

describe('HarnessService background process launch', () => {
  it('hides the console while keeping piped runtime I/O and workspace-scoped configuration', async () => {
    // Stop at the OS boundary: this exercises the real startup path without
    // starting a runtime, changing local files, or connecting to a provider.
    const launchBoundary = new Error('test launch boundary')
    vi.mocked(spawn).mockImplementationOnce(() => { throw launchBoundary })
    const service = Object.create(HarnessService.prototype) as {
      runtimeGeneration: number
      stopping: boolean
      workspace: unknown
      browser: unknown
      providers: unknown
      tokenSaverEnabled(): boolean
      updateStatus: ReturnType<typeof vi.fn>
      start(): Promise<unknown>
    }
    service.runtimeGeneration = 0
    service.stopping = false
    service.workspace = {
      assertUsable: vi.fn(),
      state: () => ({ root: '/nd-test-workspace', name: 'ND test', usable: true }),
    }
    service.browser = {
      ensureAgentReady: vi.fn(),
      assertAgentConfigReady: vi.fn(),
      agentBrowserEnvironment: () => ({ ND_DSH_AGENT_BROWSER_SESSION: 'test-session' }),
    }
    service.providers = { revision: () => 1, runtimeConfig: () => ({ environment: {}, profiles: [] }), list: () => [] }
    service.tokenSaverEnabled = () => true
    service.updateStatus = vi.fn()

    await expect(service.start()).rejects.toBe(launchBoundary)
    expect(spawn).toHaveBeenCalledExactlyOnceWith('/nd-test-node', [
      '/nd-test-runtime.mjs', '--profile', 'web', '--patch', '/nd-test-patch.mjs', '--no-open', '--port', '4124',
    ], expect.objectContaining({
      cwd: '/nd-test-runtime',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: expect.objectContaining({
        DSH_CWD: '/nd-test-workspace', ND_DSH_AGENT_BROWSER_SESSION: 'test-session',
        ...(process.platform === 'win32' ? { NODE_OPTIONS: expect.stringContaining('nd-background-process.cjs') } : {}),
      }),
    }))
  })
})
