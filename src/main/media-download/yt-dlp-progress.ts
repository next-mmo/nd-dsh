const PROGRESS_MARKER = 'NDPROG|'
const MAX_LINE_CHARS = 65_536

export interface YtDlpProgressUpdate {
  status: string
  downloadedBytes: number
  totalBytes: number | null
  speedBps: number | null
  etaSeconds: number | null
  videoId: string | null
  height: number | null
  extension: string | null
}

/**
 * Parse one `--progress-template` line. The template is:
 *
 *   download:NDPROG|status|downloaded|total|estimate|speed|eta|id|height|ext
 *
 * yt-dlp may prefix the template with `[download] `; search for the marker
 * instead of requiring the line to start with it.
 */
export function parseYtDlpProgress(line: string): YtDlpProgressUpdate | null {
  const marker = line.indexOf(PROGRESS_MARKER)
  if (marker < 0) return null
  const fields = line.slice(marker + PROGRESS_MARKER.length).trim().split('|')
  if (fields.length < 6) return null

  const status = (fields[0] ?? '').trim()
  if (!status) return null
  const downloaded = toNumber(fields[1])
  if (downloaded === null || downloaded < 0) return null
  const total = toPositive(fields[2])
  const estimate = toPositive(fields[3])
  const speed = toPositive(fields[4])
  const eta = toPositive(fields[5])
  const rawId = (fields[6] ?? '').trim()
  const videoId = /^[A-Za-z0-9_-]{11}$/.test(rawId) ? rawId : null
  const height = toPositive(fields[7])
  const rawExtension = (fields[8] ?? '').trim().toLowerCase()
  const extension = /^[a-z0-9]{1,8}$/.test(rawExtension) ? rawExtension : null

  return {
    status,
    downloadedBytes: Math.floor(downloaded),
    totalBytes: total ?? estimate,
    speedBps: speed,
    etaSeconds: eta === null ? null : Math.floor(eta),
    videoId,
    height: height === null ? null : Math.floor(height),
    extension,
  }
}

function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const value = raw.trim()
  if (!value || value === 'NA' || value === 'None' || value === 'null') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toPositive(raw: string | undefined): number | null {
  const value = toNumber(raw)
  return value !== null && value > 0 ? value : null
}

/**
 * Split stdout into lines without unbounded growth. Handles CR, LF, and CRLF,
 * including a CRLF split across chunks.
 */
export class ProgressLineBuffer {
  private buffer = ''

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxChars = MAX_LINE_CHARS,
  ) {}

  push(chunk: string | Buffer): void {
    this.buffer += chunk.toString()
    if (this.buffer.length > this.maxChars) {
      this.buffer = this.buffer.slice(-this.maxChars)
    }
    for (;;) {
      const newline = this.buffer.search(/[\r\n]/)
      if (newline < 0) return
      const line = this.buffer.slice(0, newline)
      const width = this.buffer[newline] === '\r' && this.buffer[newline + 1] === '\n' ? 2 : 1
      this.buffer = this.buffer.slice(newline + width)
      if (line) this.onLine(line)
    }
  }

  flush(): void {
    const line = this.buffer
    this.buffer = ''
    if (line) this.onLine(line)
  }
}
