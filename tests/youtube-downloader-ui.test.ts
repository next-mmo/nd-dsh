import { describe, expect, it } from 'vitest'
import {
  filenameForDisplay,
  formatBytes,
  formatEta,
  formatHeight,
  formatSpeed,
  isActiveJob,
  modeLabel,
  nextPollDelay,
  progressRatio,
  stateLabel,
} from '../extensions/youtube-downloader/ui/media-core.js'

describe('YouTube Downloader UI helpers', () => {
  it('formats byte counts, speeds, durations, and heights', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(15 * 1024)).toBe('15 KB')
    expect(formatBytes(60_797_583)).toBe('61 MB')
    expect(formatBytes(-1)).toBe('—')
    expect(formatSpeed(2048)).toBe('2.0 KB/s')
    expect(formatSpeed(0)).toBe('—')
    expect(formatEta(4.2)).toBe('5s')
    expect(formatEta(125)).toBe('2m 5s')
    expect(formatEta(null)).toBe('—')
    expect(formatHeight(720)).toBe('720p')
    expect(formatHeight(null)).toBe('')
  })

  it('computes a bounded progress ratio', () => {
    expect(progressRatio({ receivedBytes: 50, totalBytes: 100 })).toBe(0.5)
    expect(progressRatio({ receivedBytes: 500, totalBytes: 100 })).toBe(1)
    expect(progressRatio({ receivedBytes: 50, totalBytes: null })).toBeNull()
  })

  it('polls faster while setup or a download is active', () => {
    expect(nextPollDelay(null)).toBe(10000)
    expect(nextPollDelay({ setup: { state: 'downloading' }, jobs: [] })).toBe(2000)
    expect(nextPollDelay({ setup: { state: 'ready' }, jobs: [], activeJobId: null })).toBe(10000)
    expect(nextPollDelay({
      setup: { state: 'ready' },
      jobs: [{ id: 'a', state: 'downloading' } as never],
      activeJobId: 'a',
    })).toBe(3000)
    expect(nextPollDelay({
      setup: { state: 'ready' },
      jobs: [{ id: 'a', state: 'processing' } as never],
      activeJobId: 'a',
    })).toBe(2000)
  })

  it('labels jobs and identifies active states', () => {
    expect(isActiveJob({ state: 'downloading' })).toBe(true)
    expect(isActiveJob({ state: 'completed' })).toBe(false)
    expect(stateLabel('completed')).toBe('Saved')
    expect(stateLabel('processing')).toBe('Finalizing')
    expect(modeLabel('audio')).toBe('M4A audio')
    expect(filenameForDisplay({ id: 'a', fileName: 'video.mp4', title: 'Title' } as never)).toBe('video.mp4')
    expect(filenameForDisplay({ id: 'a', fileName: null, title: 'Title' } as never)).toBe('Title')
  })
})
