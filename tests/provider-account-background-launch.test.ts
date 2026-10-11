import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderAccountService } from '../src/main/token-saver/provider-account-service.js'

const { spawnMock, binMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), binMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('../src/main/app-paths.js', () => ({ codexBinPath: binMock, bundledResourceRoot: () => process.cwd() }))
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false }, shell: { openExternal: vi.fn() } }))

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('provider account background CLI', () => {
  it.each(['codex.js', 'codex.exe'])('runs %s without opening another Electron GUI or console', async (bin) => {
    const directory = await mkdtemp(join(tmpdir(), 'nd-account-launch-'))
    directories.push(directory)
    binMock.mockReturnValue(bin)
    vi.stubEnv('ELECTRON_RUN_AS_NODE', 'inherited-test-value')
    vi.stubEnv('NODE_OPTIONS', '--no-warnings')
    spawnMock.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
      queueMicrotask(() => child.emit('exit', 0))
      return child
    })
    // Logout exercises the real launch contract without any browser or account request.
    await new ProviderAccountService(directory).disconnect('codex')
    const [command, args, options] = spawnMock.mock.calls[0]!
    const preload = join(process.cwd(), 'scripts', 'nd-background-process.cjs')
    expect(options).toMatchObject({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    if (bin.endsWith('.js')) {
      expect(command).toBe(process.execPath)
      expect(args).toEqual([...(process.platform === 'win32' ? ['--require', preload] : []), bin, 'logout'])
      expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1')
    } else {
      expect(command).toBe(bin)
      expect(args).toEqual(['logout'])
      expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    }
    expect(options.env.NODE_OPTIONS).toContain('--no-warnings')
    if (process.platform === 'win32') expect(options.env.NODE_OPTIONS).toContain(`--require ${JSON.stringify(preload)}`)
  })
})
