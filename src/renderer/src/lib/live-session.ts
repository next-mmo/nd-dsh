import { downsampleFloat32, type LiveOpenResult } from '../../../shared/live-session'
import type { NdWebViewLiveStatus } from '../../../shared/extension-webview'

export interface LiveTranscriptEvent {
  role: 'user' | 'teacher'
  text: string
  final: boolean
}

export interface LiveToolCallEvent {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface LiveSessionCallbacks {
  onState(status: NdWebViewLiveStatus, extra?: { model?: string; providerName?: string; reason?: string }): void
  onTranscript(event: LiveTranscriptEvent): void
  onLevel(level: number): void
  onToolCall(call: LiveToolCallEvent): void
}

const INPUT_SAMPLE_RATE = 16_000
const DEFAULT_OUTPUT_SAMPLE_RATE = 24_000
const SETUP_TIMEOUT_MS = 15_000

/**
 * Manages one realtime voice + text session in the trusted ND renderer:
 * opens the loopback ND Router WebSocket, captures microphone PCM16 at 16 kHz,
 * plays 24 kHz model audio with barge-in interruption, and emits transcripts
 * and tool calls for the sandboxed extension UI.
 */
export class LiveSessionClient {
  private ws: WebSocket | null = null
  private mediaStream: MediaStream | null = null
  private captureContext: AudioContext | null = null
  private workletNode: AudioWorkletNode | null = null
  private fallbackProcessor: ScriptProcessorNode | null = null
  private playbackContext: AudioContext | null = null
  private activeSources = new Set<AudioBufferSourceNode>()
  private nextPlaybackTime = 0
  private muted = false
  private stopped = false
  private setupComplete = false
  private model = ''
  private providerName = ''

  constructor(private readonly callbacks: LiveSessionCallbacks) {}

  async start(open: LiveOpenResult): Promise<void> {
    this.stopped = false
    this.setupComplete = false
    this.model = open.model
    this.providerName = open.providerName
    this.callbacks.onState('connecting', { model: open.model, providerName: open.providerName })

    try {
      await this.connectSocket(open)
      if (this.stopped) return
      await this.startMicrophone()
      if (this.stopped) return
      this.callbacks.onState(this.muted ? 'muted' : 'live', {
        model: this.model,
        providerName: this.providerName,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.stop(reason, true)
    }
  }

  private connectSocket(open: LiveOpenResult): Promise<void> {
    const url = `${open.wsUrl}?ticket=${encodeURIComponent(open.ticket)}`
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url)
      this.ws = ws
      let settled = false
      const timer = window.setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error('Live session timed out waiting for Gemini setup'))
        }
      }, SETUP_TIMEOUT_MS)

      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        let payload: Record<string, unknown>
        try {
          payload = JSON.parse(event.data) as Record<string, unknown>
        } catch {
          return
        }

        if (!this.setupComplete && payload.setupComplete !== undefined) {
          this.setupComplete = true
          if (!settled) {
            settled = true
            window.clearTimeout(timer)
            resolve()
          }
          return
        }

        if (payload.error && typeof payload.error === 'object') {
          const msg = (payload.error as { message?: unknown }).message
          const reason = typeof msg === 'string' && msg.trim() ? msg : 'Gemini Live upstream error'
          if (!settled) {
            settled = true
            window.clearTimeout(timer)
            reject(new Error(reason))
            return
          }
          this.stop(reason, true)
          return
        }

        this.handleServerMessage(payload)
      }

      ws.onerror = () => {
        if (!settled) {
          settled = true
          window.clearTimeout(timer)
          reject(new Error('Could not connect to ND Router live socket'))
        }
      }

      ws.onclose = (event) => {
        window.clearTimeout(timer)
        const reason = event.reason?.trim() || (event.code === 1000 ? 'Session ended' : `Connection closed (${event.code})`)
        if (!settled) {
          settled = true
          reject(new Error(reason))
          return
        }
        if (!this.stopped) {
          const isErrorClose = event.code !== 1000 && event.code !== 1001
          this.stop(reason, isErrorClose)
        }
      }
    })
  }

  private async startMicrophone(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is unavailable in this environment')
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error(`Microphone permission denied or unavailable: ${msg}`)
    }
    if (this.stopped) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    this.mediaStream = stream

    const AudioCtx = window.AudioContext
    const ctx = new AudioCtx()
    this.captureContext = ctx
    if (ctx.state === 'suspended') await ctx.resume()
    const source = ctx.createMediaStreamSource(stream)

    // Keep graph alive silently so Chromium pumps audio frames
    const silentGain = ctx.createGain()
    silentGain.gain.value = 0
    silentGain.connect(ctx.destination)

    const workletUrl = new URL('./worklets/pcm-capture.worklet.js', window.location.href).href
    try {
      await ctx.audioWorklet.addModule(workletUrl)
      if (this.stopped) return
      const node = new AudioWorkletNode(ctx, 'nd-pcm-capture')
      this.workletNode = node
      node.port.postMessage({ muted: this.muted })
      node.port.onmessage = (event) => {
        if (this.stopped || this.muted) return
        const data = event.data as { pcm?: ArrayBuffer; level?: number } | undefined
        if (typeof data?.level === 'number') {
          this.callbacks.onLevel(Math.max(0, Math.min(1, data.level)))
        }
        if (data?.pcm instanceof ArrayBuffer) {
          this.sendPcmChunk(data.pcm)
        }
      }
      source.connect(node)
      node.connect(silentGain)
    } catch {
      // Fallback for packaged file:// environments that reject AudioWorklet modules
      const processor = ctx.createScriptProcessor(2048, 1, 1)
      this.fallbackProcessor = processor
      processor.onaudioprocess = (event) => {
        if (this.stopped || this.muted) return
        const input = event.inputBuffer.getChannelData(0)
        const resampled = downsampleFloat32(input, ctx.sampleRate, INPUT_SAMPLE_RATE)
        let energy = 0
        const int16 = new Int16Array(resampled.length)
        for (let i = 0; i < resampled.length; i += 1) {
          const s = Math.max(-1, Math.min(1, resampled[i] ?? 0))
          energy += s * s
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
        }
        const rms = resampled.length > 0 ? Math.sqrt(energy / resampled.length) : 0
        this.callbacks.onLevel(Math.min(1, rms * 3.2))
        this.sendPcmChunk(int16.buffer)
      }
      source.connect(processor)
      processor.connect(silentGain)
    }
  }

  private sendPcmChunk(buffer: ArrayBuffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.setupComplete) return
    const base64 = arrayBufferToBase64(buffer)
    this.ws.send(JSON.stringify({
      realtimeInput: {
        audio: {
          mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
          data: base64,
        },
      },
    }))
  }

  private handleServerMessage(payload: Record<string, unknown>): void {
    const serverContent = payload.serverContent as Record<string, unknown> | undefined
    if (serverContent && typeof serverContent === 'object') {
      if (serverContent.interrupted === true) {
        this.flushPlayback()
      }

      const inputTx = serverContent.inputTranscription as { text?: unknown; finished?: unknown } | undefined
      if (typeof inputTx?.text === 'string' && inputTx.text.length > 0) {
        this.callbacks.onTranscript({
          role: 'user',
          text: inputTx.text,
          final: inputTx.finished === true,
        })
      }

      const outputTx = serverContent.outputTranscription as { text?: unknown; finished?: unknown } | undefined
      if (typeof outputTx?.text === 'string' && outputTx.text.length > 0) {
        this.callbacks.onTranscript({
          role: 'teacher',
          text: outputTx.text,
          final: outputTx.finished === true,
        })
      }

      const modelTurn = serverContent.modelTurn as { parts?: unknown[] } | undefined
      if (Array.isArray(modelTurn?.parts)) {
        for (const rawPart of modelTurn.parts) {
          if (!rawPart || typeof rawPart !== 'object') continue
          const part = rawPart as {
            inlineData?: { mimeType?: unknown; data?: unknown }
            text?: unknown
          }
          if (typeof part.inlineData?.data === 'string' && typeof part.inlineData?.mimeType === 'string') {
            if (part.inlineData.mimeType.startsWith('audio/pcm')) {
              const rate = parseSampleRate(part.inlineData.mimeType) ?? DEFAULT_OUTPUT_SAMPLE_RATE
              this.enqueuePcmPlayback(part.inlineData.data, rate)
            }
          }
          // Avoid duplicating outputTranscription when audio is present; only emit text parts if no outputTranscription
          if (typeof part.text === 'string' && part.text.trim() && !outputTx?.text) {
            this.callbacks.onTranscript({
              role: 'teacher',
              text: part.text,
              final: serverContent.turnComplete === true,
            })
          }
        }
      }

      if (serverContent.turnComplete === true) {
        this.callbacks.onTranscript({ role: 'teacher', text: '', final: true })
      }
    }

    const toolCall = payload.toolCall as { functionCalls?: unknown[] } | undefined
    if (Array.isArray(toolCall?.functionCalls)) {
      for (const rawCall of toolCall.functionCalls) {
        if (!rawCall || typeof rawCall !== 'object') continue
        const call = rawCall as { id?: unknown; name?: unknown; args?: unknown }
        if (typeof call.id === 'string' && typeof call.name === 'string') {
          const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args)
            ? (call.args as Record<string, unknown>)
            : {}
          this.callbacks.onToolCall({ id: call.id, name: call.name, args })
        }
      }
    }
  }

  private enqueuePcmPlayback(base64Data: string, sampleRate: number): void {
    if (this.stopped) return
    if (!this.playbackContext || this.playbackContext.sampleRate !== sampleRate) {
      if (this.playbackContext) {
        void this.playbackContext.close().catch(() => undefined)
      }
      this.playbackContext = new AudioContext({ sampleRate })
      this.nextPlaybackTime = 0
    }
    const ctx = this.playbackContext
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined)
    }

    const bytes = base64ToUint8Array(base64Data)
    const sampleCount = Math.floor(bytes.byteLength / 2)
    if (sampleCount === 0) return

    const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2)
    const float32 = new Float32Array(sampleCount)
    for (let i = 0; i < sampleCount; i += 1) {
      float32[i] = view.getInt16(i * 2, true) / 32768
    }

    const audioBuffer = ctx.createBuffer(1, sampleCount, sampleRate)
    audioBuffer.copyToChannel(float32, 0)

    const source = ctx.createBufferSource()
    source.buffer = audioBuffer
    source.connect(ctx.destination)

    const startAt = Math.max(ctx.currentTime + 0.02, this.nextPlaybackTime)
    this.nextPlaybackTime = startAt + audioBuffer.duration

    this.activeSources.add(source)
    source.onended = () => {
      this.activeSources.delete(source)
    }
    source.start(startAt)
  }

  private flushPlayback(): void {
    for (const source of this.activeSources) {
      try { source.stop() } catch { /* already stopped */ }
    }
    this.activeSources.clear()
    this.nextPlaybackTime = 0
  }

  sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.setupComplete) return
    const trimmed = text.trim()
    if (!trimmed) return
    this.ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: trimmed }] }],
        turnComplete: true,
      },
    }))
  }

  sendToolResult(id: string, name: string, response: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.setupComplete) return
    this.ws.send(JSON.stringify({
      toolResponse: {
        functionResponses: [{ id, name, response }],
      },
    }))
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.workletNode?.port.postMessage({ muted })
    if (muted) this.callbacks.onLevel(0)
    if (!this.stopped && this.setupComplete) {
      this.callbacks.onState(muted ? 'muted' : 'live', {
        model: this.model,
        providerName: this.providerName,
      })
    }
  }

  stop(reason?: string, asError = false): void {
    if (this.stopped) return
    this.stopped = true

    this.flushPlayback()

    if (this.workletNode) {
      this.workletNode.disconnect()
      this.workletNode = null
    }
    if (this.fallbackProcessor) {
      this.fallbackProcessor.disconnect()
      this.fallbackProcessor = null
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) track.stop()
      this.mediaStream = null
    }
    if (this.captureContext) {
      void this.captureContext.close().catch(() => undefined)
      this.captureContext = null
    }
    if (this.playbackContext) {
      void this.playbackContext.close().catch(() => undefined)
      this.playbackContext = null
    }
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, 'Session ended')
        }
      } catch { /* ignore */ }
      this.ws = null
    }

    this.callbacks.onLevel(0)
    this.callbacks.onState(asError ? 'error' : 'ended', {
      model: this.model,
      providerName: this.providerName,
      ...(reason ? { reason } : {}),
    })
  }
}

function parseSampleRate(mimeType: string): number | undefined {
  const match = /rate=(\d+)/i.exec(mimeType)
  if (!match?.[1]) return undefined
  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) && parsed >= 8000 && parsed <= 96000 ? parsed : undefined
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}
