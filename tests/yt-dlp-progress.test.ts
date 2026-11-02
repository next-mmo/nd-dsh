import { describe, expect, it } from 'vitest'
import { ProgressLineBuffer, parseYtDlpProgress } from '../src/main/media-download/yt-dlp-progress.js'

describe('parseYtDlpProgress', () => {
  it('parses a prefixed progress line', () => {
    expect(parseYtDlpProgress(
      '[download] NDPROG|downloading|1024|2048|4096|512.5|3.2|dQw4w9WgXcQ|720|mp4',
    )).toEqual({
      status: 'downloading',
      downloadedBytes: 1024,
      totalBytes: 2048,
      speedBps: 512.5,
      etaSeconds: 3,
      videoId: 'dQw4w9WgXcQ',
      height: 720,
      extension: 'mp4',
    })
  })

  it('falls back to the estimate and treats NA as null', () => {
    expect(parseYtDlpProgress(
      'NDPROG|downloading|10|NA|99|NA|NA|NA|NA|m4a',
    )).toEqual({
      status: 'downloading',
      downloadedBytes: 10,
      totalBytes: 99,
      speedBps: null,
      etaSeconds: null,
      videoId: null,
      height: null,
      extension: 'm4a',
    })
  })

  it('keeps the finished state and rejects malformed lines', () => {
    expect(parseYtDlpProgress('NDPROG|finished|100|100|NA|NA|0|dQw4w9WgXcQ|360|mp4')?.status).toBe('finished')
    expect(parseYtDlpProgress('ordinary log output')).toBeNull()
    expect(parseYtDlpProgress('NDPROG|downloading|abc|10|NA|NA|NA|NA|NA|mp4')).toBeNull()
    expect(parseYtDlpProgress('NDPROG|downloading')).toBeNull()
  })

  it('does not treat an invalid id or extension as usable', () => {
    const update = parseYtDlpProgress('NDPROG|downloading|1|2|NA|NA|NA|short|abc|not-an-extension!')
    expect(update?.videoId).toBeNull()
    expect(update?.extension).toBeNull()
  })
})

describe('ProgressLineBuffer', () => {
  it('reassembles lines split across chunks and CRLF boundaries', () => {
    const lines: string[] = []
    const buffer = new ProgressLineBuffer((line) => lines.push(line))
    buffer.push('NDPROG|downloading|1')
    buffer.push('|2|NA|NA|NA|NA|NA|mp4\r')
    buffer.push('\nNDPROG|finished|2|2|NA|NA|0|NA|NA|mp4\n')
    buffer.push('partial')
    expect(lines).toEqual([
      'NDPROG|downloading|1|2|NA|NA|NA|NA|NA|mp4',
      'NDPROG|finished|2|2|NA|NA|0|NA|NA|mp4',
    ])
    buffer.flush()
    expect(lines.at(-1)).toBe('partial')
  })

  it('caps an unterminated line', () => {
    const lines: string[] = []
    const buffer = new ProgressLineBuffer((line) => lines.push(line), 10)
    buffer.push('x'.repeat(100))
    buffer.flush()
    expect(lines).toEqual(['x'.repeat(10)])
  })
})
