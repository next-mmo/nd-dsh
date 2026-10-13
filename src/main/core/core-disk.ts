import type { CoreClient } from './core-client.js'

export interface CoreDiskScanNode {
  /** Display name (truncated); `k` is 0 for a directory, 1 for a file. */
  n: string
  /** Aggregated size in bytes. */
  s: number
  k: 0 | 1 | 2
  c?: CoreDiskScanNode[]
  /** Only on `k: 2` aggregate buckets: how many entries were folded in. */
  count?: number
}

export interface CoreDiskScanResult {
  root: string
  name: string
  entries: number
  bytes: number
  fileCount: number
  dirCount: number
  errors: number
  truncated: boolean
  tree: CoreDiskScanNode
}

export interface CoreDiskScanProgress {
  entries: number
  bytes: number
}

/**
 * A disk scan is a long, cancellable job in the sidecar: the walk, aggregation,
 * and pruning all live in nd-core because a full-volume scan is exactly the
 * heavy native work that must stay off the desktop main thread. The caller
 * supplies the request id — it doubles as the scan identity for progress
 * events and for `core.cancel`.
 */
export interface CoreDiskScan {
  scan(root: string, scanId: string): Promise<CoreDiskScanResult>
  cancel(scanId: string): Promise<boolean>
  onScanProgress(listener: (frame: { resourceId?: string; data: CoreDiskScanProgress }) => void): () => void
}

/**
 * A scan must outlast any fixed single-purpose timeout: the core deadline is
 * the maximum nd-core accepts, and `disk.scan.cancel` is how a scan normally
 * ends early. The client timer is only the backstop for a dead sidecar.
 */
const CORE_DISK_SCAN_TIMEOUT_MS = 30 * 60 * 1000

export function createCoreDiskScan(core: Pick<CoreClient, 'request' | 'cancel' | 'onEvent'>): CoreDiskScan {
  return {
    async scan(root, scanId) {
      return await core.request<CoreDiskScanResult>(
        'disk.scan',
        { root },
        CORE_DISK_SCAN_TIMEOUT_MS,
        { requestId: scanId },
      )
    },
    async cancel(scanId) {
      return await core.cancel(scanId)
    },
    onScanProgress(listener) {
      return core.onEvent<CoreDiskScanProgress>('disk.scan.progress', (frame) => {
        listener({
          ...(frame.resourceId !== undefined ? { resourceId: frame.resourceId } : {}),
          data: frame.data,
        })
      })
    },
  }
}
