/**
 * Pure UI helpers for the YouTube Downloader view.
 *
 * Kept free of DOM and bridge code so the formatting and poll policy can be
 * unit-tested from the repository without an Electron frame.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1000) return `${Math.round(bytes)} B`
  let value = bytes
  let unit = 0
  // Download sizes follow the decimal units shown by release pages and
  // browsers, so the pinned 60,797,583 bytes reads as "61 MB".
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${UNITS[unit]}`
}

export function formatSpeed(bytesPerSecond) {
  if (typeof bytesPerSecond !== 'number' || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatEta(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${Math.ceil(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m ${rest}s`
}

export function formatHeight(height) {
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return ''
  return `${Math.round(height)}p`
}

export function progressRatio(job) {
  if (!job) return null
  const received = job.receivedBytes
  const total = job.totalBytes
  if (typeof received !== 'number' || !Number.isFinite(received) || received < 0) return null
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null
  return Math.max(0, Math.min(1, received / total))
}

export function isActiveJob(job) {
  return Boolean(job && (job.state === 'starting' || job.state === 'downloading' || job.state === 'processing'))
}

/** 2 s during setup, 3 s while bytes move, 10 s idle. */
export function nextPollDelay(status) {
  const setupState = status && status.setup ? status.setup.state : ''
  if (setupState === 'downloading' || setupState === 'verifying' || setupState === 'extracting') return 2000
  const active = status && Array.isArray(status.jobs)
    ? status.jobs.find((job) => job.id === status.activeJobId) || status.jobs.find(isActiveJob)
    : undefined
  if (!active) return 10000
  if (active.state === 'starting' || active.state === 'processing') return 2000
  if (active.state === 'downloading') return 3000
  return 10000
}

export function stateLabel(state) {
  switch (state) {
    case 'starting': return 'Starting'
    case 'downloading': return 'Downloading'
    case 'processing': return 'Finalizing'
    case 'completed': return 'Saved'
    case 'canceled': return 'Canceled'
    case 'failed': return 'Failed'
    default: return state || 'Unknown'
  }
}

export function modeLabel(mode) {
  return mode === 'audio' ? 'M4A audio' : 'MP4 video'
}

export function filenameForDisplay(job) {
  if (!job) return ''
  if (typeof job.fileName === 'string' && job.fileName) return job.fileName
  return job.title || 'YouTube video'
}
