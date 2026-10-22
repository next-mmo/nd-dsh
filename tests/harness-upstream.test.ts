import { describe, expect, it, vi } from 'vitest'
import { HarnessUpstreamChecker, compareHarnessVersions } from '../src/main/harness/harness-upstream.js'

describe('compareHarnessVersions', () => {
  it('orders release and prerelease versions', () => {
    expect(compareHarnessVersions('0.2.1-rc.2', '0.2.1-rc.2')).toBe(0)
    expect(compareHarnessVersions('0.2.1-rc.3', '0.2.1-rc.2')).toBeGreaterThan(0)
    expect(compareHarnessVersions('0.2.1', '0.2.1-rc.2')).toBeGreaterThan(0)
    expect(compareHarnessVersions('0.2.2-rc.1', '0.2.1')).toBeGreaterThan(0)
    expect(compareHarnessVersions('0.2.1-rc.2', '0.2.2')).toBeLessThan(0)
  })

  it('compares prerelease identifiers numerically and then lexically', () => {
    expect(compareHarnessVersions('0.2.1-alpha.10', '0.2.1-alpha.9')).toBeGreaterThan(0)
    expect(compareHarnessVersions('0.2.1-alpha.beta', '0.2.1-alpha.2')).toBeGreaterThan(0)
    expect(compareHarnessVersions('0.2.1-alpha', '0.2.1-alpha.1')).toBeLessThan(0)
    expect(compareHarnessVersions('0.2.1-beta', '0.2.1-alpha')).toBeGreaterThan(0)
  })
})

describe('HarnessUpstreamChecker', () => {
  it('reports an update when upstream publishes a newer release', async () => {
    const checker = new HarnessUpstreamChecker(async () => '0.2.1-rc.3')
    await expect(checker.check('0.2.1-rc.2')).resolves.toEqual({
      currentVersion: '0.2.1-rc.2',
      latestVersion: '0.2.1-rc.3',
      updateAvailable: true,
    })
  })

  it('does not report an update when the runtime is current or ahead', async () => {
    const current = new HarnessUpstreamChecker(async () => '0.2.1-rc.2')
    await expect(current.check('0.2.1-rc.2')).resolves.toMatchObject({ updateAvailable: false })

    const ahead = new HarnessUpstreamChecker(async () => '0.2.1-rc.2')
    await expect(ahead.check('0.2.2-rc.1')).resolves.toMatchObject({ updateAvailable: false })
  })

  it('skips the registry when the runtime version is unknown', async () => {
    const fetchLatestVersion = vi.fn(async () => '0.2.1-rc.3')
    const checker = new HarnessUpstreamChecker(fetchLatestVersion)
    await expect(checker.check(undefined)).resolves.toEqual({ updateAvailable: false })
    expect(fetchLatestVersion).not.toHaveBeenCalled()
  })

  it('shares one registry request between concurrent checks', async () => {
    let release!: (version: string) => void
    const fetchLatestVersion = vi.fn(() => new Promise<string>((resolve) => {
      release = resolve
    }))
    const checker = new HarnessUpstreamChecker(fetchLatestVersion)
    const first = checker.check('0.2.0')
    const second = checker.check('0.2.0')
    release('0.2.1')
    await expect(Promise.all([first, second])).resolves.toEqual([
      { currentVersion: '0.2.0', latestVersion: '0.2.1', updateAvailable: true },
      { currentVersion: '0.2.0', latestVersion: '0.2.1', updateAvailable: true },
    ])
    expect(fetchLatestVersion).toHaveBeenCalledOnce()
  })

  it('caches the release and retries after a failed check', async () => {
    const fetchLatestVersion = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('0.2.1')
    const checker = new HarnessUpstreamChecker(fetchLatestVersion)

    await expect(checker.check('0.2.0')).rejects.toThrow('offline')
    await expect(checker.check('0.2.0')).resolves.toMatchObject({ updateAvailable: true })
    await expect(checker.check('0.2.0')).resolves.toMatchObject({ updateAvailable: true })
    expect(fetchLatestVersion).toHaveBeenCalledTimes(2)
  })
})
