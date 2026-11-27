import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { acquireLocalWorkload, watchTestDriver } from '../scripts/local-workload.mjs'

it('asks the test app to quit once when its driver disappears', () => {
  vi.useFakeTimers()
  const probe = vi.spyOn(process, 'kill').mockReturnValue(true)
  const quit = vi.fn()
  try {
    watchTestDriver(123, quit)
    vi.advanceTimersByTime(5000)
    expect(probe).toHaveBeenCalledWith(123, 0)
    expect(quit).not.toHaveBeenCalled()
    probe.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    vi.advanceTimersByTime(15000)
    expect(quit).toHaveBeenCalledTimes(1)
  } finally {
    probe.mockRestore()
    vi.useRealTimers()
  }
})

it('checks the Go toolchain before starting the first vendor stage', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nd-vendor-preflight-'))
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'))
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/build-dev-vendors.mjs', import.meta.url))], {
      env: { ...env, HOME: home, USERPROFILE: home, PATH: home },
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('working Go toolchain on PATH')
    expect(result.stdout).not.toContain('scripts/build-harness.mjs')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it('rejects concurrent jobs and recovers after the owner terminates without cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nd-workload-test-'))
  const moduleUrl = new URL('../scripts/local-workload.mjs', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireLocalWorkload } from ${JSON.stringify(moduleUrl)}
    acquireLocalWorkload('first job', process.argv[1])
    process.send('ready')
    setInterval(() => {}, 10_000)
  `, directory], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true })
  const closed = once(child, 'close')
  try {
    await Promise.race([once(child, 'message'), closed.then(() => { throw new Error('Lock owner exited before acquiring the lock') })])
    expect(() => acquireLocalWorkload('second job', directory)).toThrow(/another ND build or test/)
    child.kill('SIGKILL')
    await closed
    const release = acquireLocalWorkload('next job', directory)
    release()
    acquireLocalWorkload('last job', directory)()
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
    await rm(directory, { recursive: true, force: true })
  }
})
