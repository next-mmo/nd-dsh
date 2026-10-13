import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { CoreDiskScan, CoreDiskScanResult } from '../core/core-disk.js'
import { isNdCoreCanceledError } from '../core/core-protocol.js'

export type DiskScanJobState = 'running' | 'done' | 'canceled' | 'error'

export interface DiskScanJob {
  scanId: string
  root: string
  startedAt: number
  state: DiskScanJobState
  /** Entries visited so far while running; the final count when settled. */
  entries: number
  bytes: number
  /** The pruned result tree; present only once `state` is `done`. */
  result: CoreDiskScanResult | null
  error: string | null
  finishedAt: number | null
}

export interface DiskScanServiceOptions {
  /** Test seam; production uses `fs.stat`. */
  stat?(path: string): Promise<{ isDirectory(): boolean }>
}

/** Finished scans are kept briefly so a reopened view can still show the last result. */
const MAX_FINISHED_JOBS = 4
const SCAN_ID_PREFIX = 'nd-disk-scan-'

/**
 * Job records for nd-core disk scans. One scan runs at a time — package
 * authors must bound their work, and overlapping whole-tree walks are exactly
 * the unbounded behavior that rule exists for. The caller-supplied scan id
 * doubles as the sidecar request id, so canceling is `core.cancel` and the
 * in-flight request settles as `canceled`.
 */
export class DiskScanService {
  private readonly jobs = new Map<string, DiskScanJob>()
  private readonly unsubscribe: () => void
  private readonly stat: (path: string) => Promise<{ isDirectory(): boolean }>

  constructor(private readonly core: CoreDiskScan, options: DiskScanServiceOptions = {}) {
    this.stat = options.stat ?? ((path) => fs.stat(path))
    this.unsubscribe = core.onScanProgress(({ resourceId, data }) => {
      const job = resourceId ? this.jobs.get(resourceId) : undefined
      if (!job || job.state !== 'running') return
      job.entries = data.entries
      job.bytes = data.bytes
    })
  }

  async start(root: string): Promise<DiskScanJob> {
    const trimmed = root.trim()
    if (!trimmed || trimmed.length > 4096 || !isAbsolute(trimmed)) {
      throw new Error('Scan root must be an absolute path')
    }
    const stat = await this.stat(trimmed).catch(() => null)
    if (!stat?.isDirectory()) throw new Error('Scan root must be an existing folder')
    if (this.runningJob()) {
      throw new Error('A disk scan is already running; cancel it or wait for it to finish')
    }
    const scanId = `${SCAN_ID_PREFIX}${randomUUID()}`
    const job: DiskScanJob = {
      scanId,
      root: trimmed,
      startedAt: Date.now(),
      state: 'running',
      entries: 0,
      bytes: 0,
      result: null,
      error: null,
      finishedAt: null,
    }
    this.jobs.set(scanId, job)
    void this.core.scan(trimmed, scanId).then(
      (result) => {
        job.state = 'done'
        job.result = result
        job.entries = result.entries
        job.bytes = result.bytes
        job.finishedAt = Date.now()
        this.trimFinished()
      },
      (error: unknown) => {
        job.state = isNdCoreCanceledError(error) ? 'canceled' : 'error'
        job.error = error instanceof Error ? error.message : String(error)
        job.finishedAt = Date.now()
        this.trimFinished()
      },
    )
    return { ...job }
  }

  status(scanId: string): DiskScanJob | null {
    const job = this.jobs.get(scanId)
    return job ? { ...job } : null
  }

  async cancel(scanId: string): Promise<{ canceled: boolean }> {
    const job = this.jobs.get(scanId)
    if (!job || job.state !== 'running') return { canceled: false }
    // The request rejects with the `canceled` code and settles the job; there
    // is no second path that marks it canceled optimistically.
    return { canceled: await this.core.cancel(scanId) }
  }

  dispose(): void {
    this.unsubscribe()
  }

  private runningJob(): DiskScanJob | null {
    for (const job of this.jobs.values()) {
      if (job.state === 'running') return job
    }
    return null
  }

  private trimFinished(): void {
    const finished = [...this.jobs.values()].filter((job) => job.state !== 'running')
    const excess = finished.length - MAX_FINISHED_JOBS
    for (const job of finished.slice(0, Math.max(0, excess))) {
      this.jobs.delete(job.scanId)
    }
  }
}
