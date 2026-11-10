import {
  preferLowLatencyOpusSdp,
  type PhoneAudioCaptureMode,
  type PhoneAudioCommand,
  type PhoneAudioDesktopApi,
  type PhoneAudioInputDevice,
  type PhoneAudioOutputDevice,
  type PhoneAudioSignalToRenderer,
  type PhoneAudioStats,
} from '../../../shared/phone-audio'

const METER_INTERVAL_MS = 80
const STATS_INTERVAL_MS = 1500
const SILENT_THRESHOLD = 0.0015
const SILENT_WARNING_AFTER_MS = 5000

export class PhoneAudioRendererHost {
  private sessionId: string | null = null
  private audioStream: MediaStream | null = null
  private audioTrack: MediaStreamTrack | null = null
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private meterTimer: number | null = null
  private statsTimer: number | null = null
  private pc: RTCPeerConnection | null = null
  private activeClientId: string | null = null
  private pendingIceCandidates: RTCIceCandidateInit[] = []
  private remoteDescriptionSet = false
  private lastSilentStart = 0
  private lastWarningState = false
  private lastReportedLevel = -1
  private lastBytesSent = 0
  private lastStatsTimestamp = 0
  private disposed = false
  private unsubscribers: Array<() => void> = []

  constructor(private readonly api: PhoneAudioDesktopApi) {}

  startListening(): void {
    this.unsubscribers.push(
      this.api.onCommand((command: PhoneAudioCommand) => {
        if (this.disposed) return
        if (command.kind === 'start') {
          void this.startCapture(command.sessionId, command.captureMode, command.inputDeviceId)
          return
        }
        if (command.kind === 'stop') {
          this.stopAll()
          return
        }
        if (command.kind === 'client-ready') {
          void this.connectPeer(command.clientId)
          return
        }
        if (command.kind === 'client-disconnected') {
          if (this.activeClientId === command.clientId) {
            this.closePeer()
          }
        }
      }),
    )

    this.unsubscribers.push(
      this.api.onSignal((signal: PhoneAudioSignalToRenderer) => {
        if (this.disposed) return
        void this.handleMainSignal(signal)
      }),
    )

    const onDeviceChange = (): void => {
      void this.syncDevices()
    }
    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
      this.unsubscribers.push(() => navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange))
    }

    void this.syncDevices()
  }

  dispose(): void {
    this.disposed = true
    for (const unsub of this.unsubscribers) unsub()
    this.unsubscribers = []
    this.stopAll()
  }

  private async syncDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const outputDevices: PhoneAudioOutputDevice[] = []
      const inputDevices: PhoneAudioInputDevice[] = []

      for (const dev of devices) {
        if (dev.kind === 'audiooutput') {
          outputDevices.push({
            deviceId: dev.deviceId,
            label: dev.label || (dev.deviceId === 'default' ? 'Default Output Device' : `Output Device (${dev.deviceId.slice(0, 6)})`),
            groupId: dev.groupId,
            isDefault: dev.deviceId === 'default',
          })
        } else if (dev.kind === 'audioinput') {
          inputDevices.push({
            deviceId: dev.deviceId,
            label: dev.label || (dev.deviceId === 'default' ? 'Default Input Device' : `Input Device (${dev.deviceId.slice(0, 6)})`),
            groupId: dev.groupId,
          })
        }
      }

      await this.api.reportRenderer({ outputDevices, inputDevices })
    } catch {
      // Ignore device enumeration errors if mediaDevices is restricted.
    }
  }

  private async startCapture(
    sessionId: string,
    captureMode: PhoneAudioCaptureMode,
    inputDeviceId?: string,
  ): Promise<void> {
    this.stopAll()
    this.sessionId = sessionId

    try {
      let rawStream: MediaStream
      if (captureMode === 'device') {
        if (!inputDeviceId) {
          throw new Error('Select a virtual audio cable input device (e.g. CABLE Output) before starting in virtual-device mode.')
        }
        rawStream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: {
            deviceId: { exact: inputDeviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
          },
        })
      } else {
        rawStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: 1 }, height: { ideal: 1 }, frameRate: { ideal: 1 } },
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
            sampleRate: 48_000,
          },
        })
      }

      if (this.disposed || this.sessionId !== sessionId) {
        for (const t of rawStream.getTracks()) t.stop()
        return
      }

      // Immediately discard video tracks so screen pixels are never encoded or sent.
      for (const vt of rawStream.getVideoTracks()) {
        vt.stop()
        rawStream.removeTrack(vt)
      }

      const audioTrack = rawStream.getAudioTracks()[0]
      if (!audioTrack) {
        for (const t of rawStream.getTracks()) t.stop()
        throw new Error(
          'Windows loopback capture returned no audio track. Verify an active playback device (e.g. Speakers or Display Audio) or switch to the VB-CABLE fallback.',
        )
      }

      if ('contentHint' in audioTrack) {
        try {
          audioTrack.contentHint = 'music'
        } catch {
          // Ignore unsupported contentHint.
        }
      }

      const cleanStream = new MediaStream([audioTrack])
      this.audioStream = cleanStream
      this.audioTrack = audioTrack

      audioTrack.onended = () => {
        if (this.sessionId !== sessionId) return
        this.closePeer()
        this.stopMeter()
        void this.api.reportRenderer({
          sessionId,
          captureError: 'System audio capture stopped unexpectedly (output device changed or disconnected).',
        })
      }

      const settings = audioTrack.getSettings()
      this.startMeter(cleanStream, sessionId)
      await this.syncDevices()

      await this.api.reportRenderer({
        sessionId,
        captureActive: true,
        ...(typeof settings.sampleRate === 'number' ? { sampleRate: settings.sampleRate } : {}),
        ...(typeof settings.channelCount === 'number' ? { channelCount: settings.channelCount } : {}),
        trackLabel: audioTrack.label || (captureMode === 'loopback' ? 'Windows System Audio Loopback' : 'Virtual Audio Device'),
      })
    } catch (error) {
      this.stopAll()
      const message = error instanceof Error ? error.message : String(error)
      await this.api.reportRenderer({
        sessionId,
        captureError: `Audio capture failed: ${message}`,
      })
    }
  }

  private startMeter(stream: MediaStream, sessionId: string): void {
    this.stopMeter()
    try {
      const ctx = new AudioContext()
      this.audioContext = ctx
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => undefined)
      }
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      // Deliberately NOT connected to ctx.destination to prevent local PC echo.
      this.analyser = analyser

      const samples = new Float32Array(analyser.fftSize)
      this.lastSilentStart = Date.now()
      this.lastWarningState = false
      this.lastReportedLevel = -1

      this.meterTimer = window.setInterval(() => {
        if (!this.analyser || this.sessionId !== sessionId) return
        this.analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (let i = 0; i < samples.length; i += 1) {
          const s = samples[i] ?? 0
          sum += s * s
        }
        const rms = Math.sqrt(sum / samples.length)
        const normalized = Math.min(1, Math.pow(rms * 3.2, 0.72))

        const now = Date.now()
        let silentWarning: string | undefined
        if (rms < SILENT_THRESHOLD) {
          if (!this.lastWarningState && now - this.lastSilentStart >= SILENT_WARNING_AFTER_MS) {
            this.lastWarningState = true
            silentWarning =
              'No audio signal detected yet. Play audio on Windows and confirm your playback device is not muted.'
          }
        } else {
          this.lastSilentStart = now
          if (this.lastWarningState) {
            this.lastWarningState = false
            silentWarning = ''
          }
        }

        if (Math.abs(normalized - this.lastReportedLevel) >= 0.02 || silentWarning !== undefined) {
          this.lastReportedLevel = normalized
          void this.api.reportRenderer({
            sessionId,
            audioLevel: Number(normalized.toFixed(3)),
            ...(silentWarning !== undefined ? { silentWarning } : {}),
          })
        }
      }, METER_INTERVAL_MS)
    } catch {
      // Non-fatal if AudioContext cannot start for metering.
    }
  }

  private stopMeter(): void {
    if (this.meterTimer !== null) {
      window.clearInterval(this.meterTimer)
      this.meterTimer = null
    }
    this.analyser = null
    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined)
      this.audioContext = null
    }
  }

  private async connectPeer(clientId: string): Promise<void> {
    this.closePeer()
    if (!this.audioStream || !this.audioTrack || this.audioTrack.readyState === 'ended') {
      await this.api.sendSignal({
        kind: 'peer-state',
        clientId,
        state: 'error',
        error: 'PC audio capture is not ready yet. Click Stop and Start Streaming again.',
      })
      return
    }

    this.activeClientId = clientId
    this.remoteDescriptionSet = false
    this.pendingIceCandidates = []

    const pc = new RTCPeerConnection({ iceServers: [] })
    this.pc = pc

    pc.onicecandidate = (event) => {
      if (!event.candidate || this.activeClientId !== clientId) return
      void this.api.sendSignal({
        kind: 'ice-candidate',
        clientId,
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        },
      })
    }

    pc.oniceconnectionstatechange = () => {
      if (this.pc !== pc || this.activeClientId !== clientId) return
      const state = pc.iceConnectionState
      if (state === 'connected' || state === 'completed') {
        void this.api.sendSignal({ kind: 'peer-state', clientId, state: 'connected' })
      } else if (state === 'disconnected') {
        void this.api.sendSignal({ kind: 'peer-state', clientId, state: 'reconnecting' })
      } else if (state === 'failed') {
        void this.api.sendSignal({
          kind: 'peer-state',
          clientId,
          state: 'error',
          error: 'WebRTC ICE failed. Check Windows Firewall or switch to USB tethering.',
        })
      }
    }

    const sender = pc.addTrack(this.audioTrack, this.audioStream)
    const transceiver = pc.getTransceivers().find((t) => t.sender === sender)
    if (transceiver && typeof transceiver.setCodecPreferences === 'function') {
      const capabilities = RTCRtpSender.getCapabilities?.('audio')
      if (capabilities?.codecs?.length) {
        const opusCodecs = capabilities.codecs.filter((c) => c.mimeType.toLowerCase() === 'audio/opus')
        const otherCodecs = capabilities.codecs.filter((c) => c.mimeType.toLowerCase() !== 'audio/opus')
        if (opusCodecs.length > 0) {
          try {
            transceiver.setCodecPreferences([...opusCodecs, ...otherCodecs])
          } catch {
            // Fallback to default SDP ordering if browser rejects explicit preference.
          }
        }
      }
    }

    const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false })
    const tunedSdp = preferLowLatencyOpusSdp(offer.sdp ?? '')
    await pc.setLocalDescription({ type: 'offer', sdp: tunedSdp })

    await this.api.sendSignal({
      kind: 'sdp-offer',
      clientId,
      sdp: tunedSdp,
    })

    this.startStatsLoop(clientId)
  }

  private async handleMainSignal(signal: PhoneAudioSignalToRenderer): Promise<void> {
    if (!this.pc || this.activeClientId !== signal.clientId) return
    if (signal.kind === 'sdp-answer') {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp })
      this.remoteDescriptionSet = true
      for (const candidate of this.pendingIceCandidates) {
        try {
          await this.pc.addIceCandidate(candidate)
        } catch {
          // Ignore individual candidate errors.
        }
      }
      this.pendingIceCandidates = []
      return
    }
    if (signal.kind === 'ice-candidate') {
      if (!this.remoteDescriptionSet) {
        this.pendingIceCandidates.push(signal.candidate)
        return
      }
      try {
        await this.pc.addIceCandidate(signal.candidate)
      } catch {
        // Ignore individual candidate errors.
      }
    }
  }

  private startStatsLoop(clientId: string): void {
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer)
    this.lastBytesSent = 0
    this.lastStatsTimestamp = Date.now()

    this.statsTimer = window.setInterval(async () => {
      if (!this.pc || this.activeClientId !== clientId || !this.sessionId) return
      try {
        const report = await this.pc.getStats()
        const stats: PhoneAudioStats = {}
        const now = Date.now()

        report.forEach((entry) => {
          if (entry.type === 'outbound-rtp' && entry.kind === 'audio') {
            if (typeof entry.packetsSent === 'number') stats.packetsSent = entry.packetsSent
            if (typeof entry.bytesSent === 'number') {
              stats.bytesSent = entry.bytesSent
              const dt = Math.max(0.2, (now - this.lastStatsTimestamp) / 1000)
              const delta = Math.max(0, entry.bytesSent - this.lastBytesSent)
              stats.bitrateKbps = Math.round((delta * 8) / dt / 1000)
              this.lastBytesSent = entry.bytesSent
              this.lastStatsTimestamp = now
            }
          }
          if (entry.type === 'candidate-pair' && entry.state === 'succeeded') {
            if (typeof entry.currentRoundTripTime === 'number') {
              stats.rttMs = Math.round(entry.currentRoundTripTime * 1000)
            }
          }
          if (entry.type === 'remote-inbound-rtp' && entry.kind === 'audio') {
            if (typeof entry.roundTripTime === 'number') {
              stats.rttMs = Math.round(entry.roundTripTime * 1000)
            }
            if (typeof entry.jitter === 'number') {
              stats.jitterMs = Math.round(entry.jitter * 10000) / 10
            }
          }
          if (entry.type === 'codec' && typeof entry.mimeType === 'string' && entry.mimeType.startsWith('audio/')) {
            stats.codec = entry.mimeType.replace('audio/', '').toUpperCase()
            if (typeof entry.clockRate === 'number') stats.clockRate = entry.clockRate
            if (typeof entry.channels === 'number') stats.channels = entry.channels
          }
        })

        await this.api.reportRenderer({ sessionId: this.sessionId, stats })
      } catch {
        // Ignore transient stats errors.
      }
    }, STATS_INTERVAL_MS)
  }

  private closePeer(): void {
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer)
      this.statsTimer = null
    }
    this.activeClientId = null
    this.remoteDescriptionSet = false
    this.pendingIceCandidates = []
    if (this.pc) {
      try {
        this.pc.onicecandidate = null
        this.pc.oniceconnectionstatechange = null
        this.pc.close()
      } catch {
        // Ignore close errors.
      }
      this.pc = null
    }
  }

  private stopAll(): void {
    this.sessionId = null
    this.closePeer()
    this.stopMeter()
    if (this.audioTrack) {
      this.audioTrack.onended = null
      try {
        this.audioTrack.stop()
      } catch {
        // Ignore track stop errors.
      }
      this.audioTrack = null
    }
    if (this.audioStream) {
      for (const track of this.audioStream.getTracks()) {
        try {
          track.stop()
        } catch {
          // Ignore track stop errors.
        }
      }
      this.audioStream = null
    }
  }
}
