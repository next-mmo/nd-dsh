import { desktopCapturer, type DesktopCapturerSource } from 'electron'
import { randomBytes } from 'node:crypto'
import { ND_WEBVIEW_URL_SCHEME } from '../../shared/extension-webview.js'

export const MIRROR_BOUNDARY = 'nd-mirror-frame'
export const MIRROR_CONTENT_TYPE = `multipart/x-mixed-replace; boundary=${MIRROR_BOUNDARY}`

const FRAME_INTERVAL_MS = 40
const IDLE_STOP_MS = 10_000
const TOKEN_TTL_MS = 30 * 60 * 1000
const MAX_THUMBNAIL_WIDTH = 360
const MAX_THUMBNAIL_HEIGHT = 780
const JPEG_QUALITY = 65

export interface MirrorSessionOptions {
  serial: string
  model: string
  baselineIds: Set<string>
  titleHints: string[]
  deviceWidth: number
  deviceHeight: number
  paused?: boolean
  onIdle?: () => void
}

interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>
}

interface MirrorSession {
  token: string
  serial: string
  model: string
  baselineIds: Set<string>
  titleHints: string[]
  width: number
  height: number
  subscribers: Set<Subscriber>
  timer: ReturnType<typeof setInterval> | null
  captureInFlight: boolean
  expiresAt: number
  idleSince: number | null
  stopped: boolean
  onIdle?: () => void
}

/**
 * Streams a live MJPEG view of the off-screen scrcpy window into a package web
 * view. Frames are captured in main and served through the private
 * `nd-extension-ui` scheme, so the sandboxed iframe only ever loads an image;
 * no per-frame bridge calls or audit rows are created.
 */
export class EmulatorMirrorStreams {
  private readonly byToken = new Map<string, MirrorSession>()
  private readonly bySerial = new Map<string, MirrorSession>()

  createSession(options: MirrorSessionOptions): string {
    this.stopBySerial(options.serial)
    const token = randomBytes(24).toString('hex')
    const session: MirrorSession = {
      token,
      serial: options.serial,
      model: options.model,
      baselineIds: new Set(options.baselineIds),
      titleHints: [...new Set(options.titleHints.filter(Boolean))],
      width: options.deviceWidth,
      height: options.deviceHeight,
      subscribers: new Set(),
      timer: null,
      captureInFlight: false,
      expiresAt: Date.now() + TOKEN_TTL_MS,
      idleSince: Date.now(),
      stopped: false,
      ...(options.onIdle ? { onIdle: options.onIdle } : {}),
    }
    this.byToken.set(token, session)
    this.bySerial.set(options.serial, session)
    if (!options.paused) {
      session.timer = setInterval(() => {
        void this.capture(session)
      }, FRAME_INTERVAL_MS)
    }
    return token
  }

  /** Resume a paused MJPEG session (fallback path). */
  resumeBySerial(serial: string): void {
    const session = this.bySerial.get(serial)
    if (!session || session.stopped || session.timer) return
    session.timer = setInterval(() => {
      void this.capture(session)
    }, FRAME_INTERVAL_MS)
  }

  /**
   * Poll desktopCapturer until the scrcpy window for `serial` appears, then
   * return its source ID for use with getUserMedia. Resolves to undefined if
   * the window never shows up within the timeout.
   */
  async resolveWindowSourceId(serial: string, model: string, timeoutMs = 3000): Promise<string | undefined> {
    const titleHints = ['ND Emulator', serial]
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false,
      })
      for (const source of sources) {
        const name = source.name.toLowerCase()
        if (!name || name.includes('ai company os')) continue
        if (/^scrcpy\s*-\s*/i.test(name) || name.includes('windows terminal')) continue
        let score = 0
        for (const hint of titleHints) {
          if (name.includes(hint.toLowerCase())) score += 100
        }
        if (model && name.includes(model.toLowerCase())) score += 20
        if (score < 100) continue
        return source.id
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return undefined
  }

  streamUrl(token: string): string {
    return `${ND_WEBVIEW_URL_SCHEME}://${token}/__nd-mirror__/stream`
  }

  attach(token: string): ReadableStream<Uint8Array> | undefined {
    const session = this.byToken.get(token)
    if (!session || session.stopped) return undefined
    session.idleSince = null
    let subscriber: Subscriber | undefined
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriber = { controller }
        session.subscribers.add(subscriber)
      },
      cancel: () => {
        if (subscriber) session.subscribers.delete(subscriber)
        session.idleSince = Date.now()
      },
    })
  }

  /** Current device dimensions for mapping normalized taps and swipes. */
  sessionSize(serial: string): { width: number; height: number } | undefined {
    const session = this.bySerial.get(serial)
    if (!session || session.stopped) return undefined
    return { width: session.width, height: session.height }
  }

  /** The stream token for a serial, if a live session exists. */
  tokenForSerial(serial: string): string | undefined {
    const session = this.bySerial.get(serial)
    if (!session || session.stopped) return undefined
    return session.token
  }

  stopBySerial(serial: string): void {
    const session = this.bySerial.get(serial)
    if (session) this.stop(session)
  }

  dispose(): void {
    for (const session of [...this.byToken.values()]) this.stop(session)
  }

  private stop(session: MirrorSession): void {
    if (session.stopped) return
    session.stopped = true
    if (session.timer) {
      clearInterval(session.timer)
      session.timer = null
    }
    for (const subscriber of [...session.subscribers]) {
      try {
        subscriber.controller.close()
      } catch {
        // The request may already be gone.
      }
    }
    session.subscribers.clear()
    if (this.byToken.get(session.token) === session) this.byToken.delete(session.token)
    if (this.bySerial.get(session.serial) === session) this.bySerial.delete(session.serial)
  }

  private async capture(session: MirrorSession): Promise<void> {
    if (session.stopped || session.captureInFlight) return
    const now = Date.now()
    if (now >= session.expiresAt) {
      this.stop(session)
      return
    }
    if (session.subscribers.size === 0) {
      session.idleSince ??= now
      if (now - session.idleSince >= IDLE_STOP_MS) {
        const onIdle = session.onIdle
        this.stop(session)
        onIdle?.()
      }
      return
    }
    session.idleSince = null
    session.captureInFlight = true
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: MAX_THUMBNAIL_WIDTH, height: MAX_THUMBNAIL_HEIGHT },
        fetchWindowIcons: false,
      })
      const source = pickMirrorSource(session, sources)
      if (!source) return
      const full = source.thumbnail.getSize()
      if (full.width <= 0 || full.height <= 0) return
      // Scrcpy keeps a normal titlebar (off-screen, but still capturable); crop
      // it so the stream is the phone screen. The titlebar scales with the
      // window width, not with the device orientation.
      const titleBar = Math.round(full.width * 0.065)
      const frameImage = titleBar > 0 && full.height - titleBar > 1
        ? source.thumbnail.crop({ x: 0, y: titleBar, width: full.width, height: full.height - titleBar })
        : source.thumbnail
      const size = frameImage.getSize()
      if (size.width <= 0 || size.height <= 0) return
      if (size.width > size.height && session.width < session.height) {
        ;[session.width, session.height] = [session.height, session.width]
      } else if (size.width < size.height && session.width > session.height) {
        ;[session.width, session.height] = [session.height, session.width]
      }
      const jpeg = frameImage.toJPEG(JPEG_QUALITY)
      if (!jpeg || jpeg.length === 0) return
      const header = Buffer.from(
        `--${MIRROR_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
      )
      const frame = new Uint8Array(Buffer.concat([header, jpeg, Buffer.from('\r\n')]))
      for (const subscriber of [...session.subscribers]) {
        try {
          if (subscriber.controller.desiredSize !== null && subscriber.controller.desiredSize <= 0) continue
          subscriber.controller.enqueue(frame)
        } catch {
          session.subscribers.delete(subscriber)
        }
      }
    } catch {
      // Transient capture failures are retried on the next tick.
    } finally {
      session.captureInFlight = false
    }
  }
}

function pickMirrorSource(session: MirrorSession, sources: DesktopCapturerSource[]): DesktopCapturerSource | undefined {
  let best: { source: DesktopCapturerSource; score: number } | undefined
  for (const source of sources) {
    if (source.thumbnail.isEmpty()) continue
    const name = source.name.toLowerCase()
    if (!name || name.includes('ai company os')) continue
    if (/^scrcpy\s*-\s*/i.test(name) || name.includes('windows terminal')) continue
    let score = 0
    for (const hint of session.titleHints) {
      if (name.includes(hint.toLowerCase())) score += 100
    }
    if (session.model && name.includes(session.model.toLowerCase())) score += 20
    if (!session.baselineIds.has(source.id)) score += 15
    if (name.includes('scrcpy')) score += 5
    if (score <= 0) continue
    if (!best || score > best.score) best = { source, score }
  }
  return best?.source
}

/** Parse the reserved stream URL: nd-extension-ui://<48-hex-token>/__nd-mirror__/stream. */
export function parseMirrorStreamUrl(rawUrl: string): string | undefined {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== `${ND_WEBVIEW_URL_SCHEME}:`) return undefined
  if (url.pathname !== '/__nd-mirror__/stream') return undefined
  const token = url.hostname.toLowerCase()
  return /^[0-9a-f]{48}$/.test(token) ? token : undefined
}

export const emulatorMirror = new EmulatorMirrorStreams()
