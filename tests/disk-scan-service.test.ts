import { describe, expect, it } from 'vitest'
import { DiskScanService } from '../src/main/extensions/disk-scan-service.js'
import { listDiskVolumes, type DiskVolumeSources } from '../src/main/os/disk-volumes.js'
import { NdCoreError } from '../src/main/core/core-protocol.js'
import type { CoreDiskScan, CoreDiskScanResult } from '../src/main/core/core-disk.js'

const resultFixture: CoreDiskScanResult = {
  root: '/scan',
  name: 'scan',
  entries: 4,
  bytes: 2_000,
  fileCount: 3,
  dirCount: 1,
  errors: 0,
  truncated: false,
  tree: { n: 'scan', s: 2_000, k: 0, c: [{ n: 'a.bin', s: 2_000, k: 1 }] },
}

function fakeCore() {
  type Pending = {
    resolve(result: CoreDiskScanResult): void
    reject(error: unknown): void
    scanId: string
    root: string
  }
  const pending: Pending[] = []
  const calls: string[] = []
  let progressListener: ((frame: { resourceId?: string; data: { entries: number; bytes: number } }) => void) | undefined
  const core: CoreDiskScan = {
    scan(root, scanId) {
      calls.push(`scan:${scanId}`)
      return new Promise<CoreDiskScanResult>((resolve, reject) => {
        pending.push({ resolve, reject, scanId, root })
      })
    },
    async cancel(scanId) {
      calls.push(`cancel:${scanId}`)
      return true
    },
    onScanProgress(listener) {
      progressListener = listener
      return () => calls.push('unsubscribe')
    },
  }
  return {
    core,
    calls,
    get pending() {
      return pending
    },
    emit(entries: number, bytes: number, resourceId?: string) {
      progressListener?.({
        ...(resourceId === undefined ? {} : { resourceId }),
        data: { entries, bytes },
      })
    },
  }
}

const alwaysDirectory = async () => ({ isDirectory: () => true })

describe('DiskScanService', () => {
  it('tracks a running scan through progress events and settles it done', async () => {
    const fake = fakeCore()
    const service = new DiskScanService(fake.core, { stat: alwaysDirectory })
    const started = await service.start('/scan')
    expect(started.state).toBe('running')
    expect(fake.calls).toEqual([`scan:${started.scanId}`])

    // Progress for this scan id lands in the job record; a stranger's does not.
    fake.emit(1_234, 56_789, started.scanId)
    fake.emit(9_999, 9_999, 'someone-else')
    expect(service.status(started.scanId)).toMatchObject({ state: 'running', entries: 1_234, bytes: 56_789 })

    fake.pending[0]!.resolve(resultFixture)
    await Promise.resolve()
    expect(service.status(started.scanId)).toMatchObject({
      state: 'done',
      entries: 4,
      bytes: 2_000,
      result: resultFixture,
    })
    service.dispose()
    expect(fake.calls).toContain('unsubscribe')
  })

  it('records cancellation as its own terminal state', async () => {
    const fake = fakeCore()
    const service = new DiskScanService(fake.core, { stat: alwaysDirectory })
    const started = await service.start('/scan')
    expect(await service.cancel(started.scanId)).toEqual({ canceled: true })
    expect(fake.calls).toContain(`cancel:${started.scanId}`)
    // The job settles only when the in-flight request actually rejects.
    fake.pending[0]!.reject(new NdCoreError('canceled', 'disk scan was canceled by the caller'))
    await Promise.resolve()
    expect(service.status(started.scanId)?.state).toBe('canceled')
    expect(await service.cancel('unknown')).toEqual({ canceled: false })
  })

  it('records failures distinctly from cancellation', async () => {
    const fake = fakeCore()
    const service = new DiskScanService(fake.core, { stat: alwaysDirectory })
    const started = await service.start('/scan')
    fake.pending[0]!.reject(new NdCoreError('method_failed', 'permission denied'))
    await Promise.resolve()
    const job = service.status(started.scanId)
    expect(job?.state).toBe('error')
    expect(job?.error).toContain('permission denied')
  })

  it('runs one scan at a time and validates the root first', async () => {
    const fake = fakeCore()
    const service = new DiskScanService(fake.core, {
      stat: async () => ({ isDirectory: () => true }),
    })
    await service.start('/scan')
    await expect(service.start('/scan-2')).rejects.toThrow(/already running/)

    const missing = new DiskScanService(fake.core, {
      stat: async () => ({ isDirectory: () => false }),
    })
    await expect(missing.start('/scan')).rejects.toThrow(/existing folder/)
    await expect(missing.start('relative/path')).rejects.toThrow(/absolute/)
  })

  it('keeps only the newest finished jobs', async () => {
    const fake = fakeCore()
    const service = new DiskScanService(fake.core, { stat: alwaysDirectory })
    const ids: string[] = []
    for (let round = 0; round < 5; round += 1) {
      const started = await service.start(`/scan-${round}`)
      ids.push(started.scanId)
      fake.pending[round]!.resolve(resultFixture)
      await Promise.resolve()
    }
    expect(service.status(ids[0]!)).toBeNull()
    expect(service.status(ids[1]!)).not.toBeNull()
    expect(service.status(ids[4]!)).not.toBeNull()
  })
})

describe('listDiskVolumes', () => {
  const sources = (overrides: Partial<DiskVolumeSources> & { platform: NodeJS.Platform }): DiskVolumeSources => ({
    statfs: async () => ({ bsize: 4096, blocks: 100, bavail: 25 }),
    readdir: async () => [],
    isDirectory: async () => true,
    ...overrides,
  })

  it('lists the system volume and macOS /Volumes mounts, skipping non-directories', async () => {
    const volumes = await listDiskVolumes(sources({
      platform: 'darwin',
      readdir: async (path) => (path === '/Volumes' ? ['Macintosh HD', 'Backup', 'Nope'] : []),
      isDirectory: async (path) => path !== '/Volumes/Backup',
    }))
    expect(volumes.map((volume) => volume.path)).toEqual(['/', '/Volumes/Macintosh HD', '/Volumes/Nope'])
    expect(volumes[0]).toMatchObject({ name: 'System', bytes: 409_600, available: 102_400 })
    expect(volumes[1]!.name).toBe('Macintosh HD')
  })

  it('probes drive letters on Windows and drops unmountable ones', async () => {
    const volumes = await listDiskVolumes(sources({
      platform: 'win32',
      statfs: async (path) => {
        if (path !== 'C:\\') throw new Error('ENOENT')
        return { bsize: 4096, blocks: 200, bavail: 100 }
      },
    }))
    expect(volumes).toEqual([{ path: 'C:\\', name: 'C:', bytes: 819_200, available: 409_600 }])
  })

  it('lists /media and /mnt mounts on other platforms', async () => {
    const volumes = await listDiskVolumes(sources({
      platform: 'linux',
      readdir: async (path) => (path === '/media' ? ['usb'] : []),
    }))
    expect(volumes.map((volume) => volume.path)).toEqual(['/', '/media/usb'])
  })
})
