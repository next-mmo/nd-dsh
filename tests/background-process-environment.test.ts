import { describe, expect, it, vi } from 'vitest'
import { backgroundProcessEnvironment } from '../src/main/core/background-process-environment.js'
import { createCoreSpawn } from '../src/main/core/core-child-process.js'
import type { CoreClient } from '../src/main/core/core-client.js'

describe('ND background process environment', () => {
  const preload = 'C:\\ND Team\\resources\\scripts\\nd-background-process.cjs'

  it('preserves runtime options and quotes the trusted preload exactly once', () => {
    const environment = { NODE_OPTIONS: '--trace-warnings', PATH: 'test-path', ND_DSH_AGENT_BROWSER_SESSION: 'test-session' }
    const result = backgroundProcessEnvironment(environment, preload, 'win32')
    expect(result).toEqual({ ...environment, NODE_OPTIONS: `--trace-warnings --require ${JSON.stringify(preload)}` })
    expect(backgroundProcessEnvironment(result, preload, 'win32')).toEqual(result)
    expect(environment.NODE_OPTIONS).toBe('--trace-warnings')
    expect(backgroundProcessEnvironment(environment, preload, 'linux')).toBe(environment)
  })

  it.skipIf(process.platform !== 'win32')('injects the policy at the Rust coding-engine boundary with scoped environment intact', async () => {
    const request = vi.fn().mockResolvedValue({ processId: 'test', pid: 123, startedAt: 1 })
    const core = { request, onEvent: () => () => {} } as unknown as CoreClient
    const spawn = createCoreSpawn(core, { currentPermitId: () => 'permit-test' }, preload)
    const child = spawn('node', ['cli.js'], { cwd: 'C:\\workspace', env: { PATH: 'test-path' } })
    await Promise.resolve()
    expect(request).toHaveBeenCalledWith('process.spawn', expect.objectContaining({
      command: 'node', args: ['cli.js'], cwd: 'C:\\workspace', permitId: 'permit-test', inheritEnv: false,
      env: { PATH: 'test-path', NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
    }), 30_000)
    child.kill()
    await Promise.resolve()
  })
})
