/**
 * Shared contracts for ND Phone Audio (`nd.phone-audio`): PC-to-Android
 * low-latency system audio streaming over local Wi-Fi or USB tethering via
 * Electron loopback capture, local HTTP/WebSocket signaling, and WebRTC.
 */

export const PHONE_AUDIO_EXTENSION_ID = 'nd.phone-audio'

export const PHONE_AUDIO_TOKEN_TTL_MS = 30 * 60 * 1000

export type PhoneAudioStreamState =
  | 'stopped'
  | 'starting'
  | 'waiting'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'

export type PhoneAudioCaptureMode = 'loopback' | 'device'

export type PhoneAudioTransportKind = 'wifi' | 'usb' | 'ethernet'

export interface PhoneAudioInterfaceInfo {
  id: string
  name: string
  address: string
  netmask: string
  cidr: string
  kind: PhoneAudioTransportKind
  label: string
  url: string
  qrSvg: string
}

export interface PhoneAudioOutputDevice {
  deviceId: string
  label: string
  groupId: string
  isDefault: boolean
}

export interface PhoneAudioInputDevice {
  deviceId: string
  label: string
  groupId: string
}

export interface PhoneAudioCaptureInfo {
  active: boolean
  mode: PhoneAudioCaptureMode
  loopbackSupported: boolean
  muteLocalPlayback: boolean
  sampleRate?: number
  channelCount?: number
  trackLabel?: string
  silentWarning?: string
  error?: string
}

export interface PhoneAudioClientInfo {
  id: string
  remoteAddress: string
  transport: PhoneAudioTransportKind | 'unknown'
  userAgent: string
  connectedAt: number
  paused: boolean
  volume: number
  audioLevel?: number
  latencyMs?: number
  jitterMs?: number
}

export interface PhoneAudioStats {
  codec?: string
  clockRate?: number
  channels?: number
  rttMs?: number
  jitterMs?: number
  bitrateKbps?: number
  packetsSent?: number
  bytesSent?: number
}

export interface PhoneAudioSystemVolume {
  available: boolean
  level?: number
  muted?: boolean
  reason?: string
}

export interface PhoneAudioOptions {
  captureMode: PhoneAudioCaptureMode
  muteLocalPlayback: boolean
  inputDeviceId?: string
  preferredInterfaceId?: string
}

export interface PhoneAudioSnapshot {
  streamState: PhoneAudioStreamState
  serverRunning: boolean
  port: number | null
  pairingCode: string | null
  tokenExpiresAt: number | null
  selectedInterfaceId: string | null
  selectedUrl: string | null
  interfaces: PhoneAudioInterfaceInfo[]
  options: PhoneAudioOptions
  capture: PhoneAudioCaptureInfo
  audioLevel: number
  outputDevices: PhoneAudioOutputDevice[]
  inputDevices: PhoneAudioInputDevice[]
  systemVolume: PhoneAudioSystemVolume
  client: PhoneAudioClientInfo | null
  stats: PhoneAudioStats
  lastError: string | null
  firewallHint: string
}

export type PhoneAudioCommand =
  | {
      kind: 'start'
      sessionId: string
      captureMode: PhoneAudioCaptureMode
      muteLocalPlayback: boolean
      inputDeviceId?: string
    }
  | {
      kind: 'stop'
      reason?: string
    }
  | {
      kind: 'client-ready'
      clientId: string
    }
  | {
      kind: 'client-disconnected'
      clientId: string
    }

export type PhoneAudioSignalToRenderer =
  | {
      kind: 'sdp-answer'
      clientId: string
      sdp: string
    }
  | {
      kind: 'ice-candidate'
      clientId: string
      candidate: {
        candidate: string
        sdpMid?: string | null
        sdpMLineIndex?: number | null
      }
    }

export type PhoneAudioSignalFromRenderer =
  | {
      kind: 'sdp-offer'
      clientId: string
      sdp: string
    }
  | {
      kind: 'ice-candidate'
      clientId: string
      candidate: {
        candidate: string
        sdpMid?: string | null
        sdpMLineIndex?: number | null
      }
    }
  | {
      kind: 'peer-state'
      clientId: string
      state: 'connecting' | 'connected' | 'reconnecting' | 'error'
      error?: string
    }

export interface PhoneAudioRendererReport {
  sessionId?: string
  captureActive?: boolean
  captureError?: string
  sampleRate?: number
  channelCount?: number
  trackLabel?: string
  silentWarning?: string
  audioLevel?: number
  stats?: PhoneAudioStats
  outputDevices?: PhoneAudioOutputDevice[]
  inputDevices?: PhoneAudioInputDevice[]
}

export const PHONE_AUDIO_IPC = {
  state: 'phone-audio:state',
  signal: 'phone-audio:signal',
  reportRenderer: 'phone-audio:report-renderer',
  stateEvent: 'phone-audio:state-event',
  commandEvent: 'phone-audio:command-event',
  signalEvent: 'phone-audio:signal-event',
} as const

export interface PhoneAudioDesktopApi {
  state(): Promise<PhoneAudioSnapshot>
  sendSignal(signal: PhoneAudioSignalFromRenderer): Promise<void>
  reportRenderer(report: PhoneAudioRendererReport): Promise<void>
  onState(listener: (snapshot: PhoneAudioSnapshot) => void): () => void
  onCommand(listener: (command: PhoneAudioCommand) => void): () => void
  onSignal(listener: (signal: PhoneAudioSignalToRenderer) => void): () => void
}

/**
 * Prefer stereo Opus with low packetization time and in-band FEC on local
 * WebRTC SDP offers without dropping existing format parameters.
 */
export function preferLowLatencyOpusSdp(sdp: string): string {
  const lines = sdp.split(/\r?\n/)
  let opusPayload: string | null = null
  for (const line of lines) {
    const match = /^a=rtpmap:(\d+)\s+opus\/48000(?:\/2)?/i.exec(line)
    if (match) {
      opusPayload = match[1] ?? null
      break
    }
  }
  if (!opusPayload) return sdp

  const desired: Record<string, string> = {
    stereo: '1',
    'sprop-stereo': '1',
    maxaveragebitrate: '128000',
    ptime: '10',
    minptime: '10',
    useinbandfec: '1',
  }

  let updatedFmtp = false
  const out = lines.map((line) => {
    const prefix = `a=fmtp:${opusPayload} `
    if (!line.startsWith(prefix)) return line
    updatedFmtp = true
    const params = new Map<string, string>()
    for (const part of line.slice(prefix.length).split(';')) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const eq = trimmed.indexOf('=')
      if (eq > 0) params.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim())
      else params.set(trimmed, '')
    }
    for (const [k, v] of Object.entries(desired)) {
      params.set(k, v)
    }
    const serialized = [...params.entries()]
      .map(([k, v]) => (v ? `${k}=${v}` : k))
      .join(';')
    return `${prefix}${serialized}`
  })

  if (!updatedFmtp) {
    const serialized = Object.entries(desired)
      .map(([k, v]) => `${k}=${v}`)
      .join(';')
    const rtpmapIndex = out.findIndex((line) => line.startsWith(`a=rtpmap:${opusPayload} `))
    if (rtpmapIndex >= 0) {
      out.splice(rtpmapIndex + 1, 0, `a=fmtp:${opusPayload} ${serialized}`)
    }
  }

  return out.join('\r\n')
}
