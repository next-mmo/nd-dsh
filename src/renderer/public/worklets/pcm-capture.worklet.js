/**
 * AudioWorklet processor that downsamples microphone input from the device
 * AudioContext sampleRate to 16 kHz mono Int16 PCM and reports RMS level.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.targetRate = 16000
    this.muted = false
    this.remainder = []
    this.chunkSamples = 1600 // 100ms at 16 kHz
    this.outBuffer = new Int16Array(this.chunkSamples)
    this.outIndex = 0
    this.energySum = 0

    this.port.onmessage = (event) => {
      if (event.data && typeof event.data.muted === 'boolean') {
        this.muted = event.data.muted
      }
    }
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0 || !input[0]) return true
    const channel = input[0]

    if (this.muted) {
      return true
    }

    const ratio = sampleRate / this.targetRate
    if (ratio <= 1.001 && ratio >= 0.999) {
      for (let i = 0; i < channel.length; i += 1) {
        this.pushSample(channel[i])
      }
      return true
    }

    // Concatenate leftover samples with current block for smooth resampling
    const combined = new Float32Array(this.remainder.length + channel.length)
    for (let i = 0; i < this.remainder.length; i += 1) combined[i] = this.remainder[i]
    combined.set(channel, this.remainder.length)

    let pos = 0
    while (pos + 1 < combined.length) {
      const idx = Math.floor(pos)
      const frac = pos - idx
      const sample = combined[idx] * (1 - frac) + combined[idx + 1] * frac
      this.pushSample(sample)
      pos += ratio
    }

    const consumed = Math.floor(pos)
    this.remainder = Array.from(combined.slice(consumed))
    return true
  }

  pushSample(sample) {
    const clamped = Math.max(-1, Math.min(1, sample))
    this.energySum += clamped * clamped
    this.outBuffer[this.outIndex] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
    this.outIndex += 1

    if (this.outIndex >= this.chunkSamples) {
      const rms = Math.sqrt(this.energySum / this.chunkSamples)
      const level = Math.min(1, rms * 3.2)
      const copy = this.outBuffer.slice(0)
      this.port.postMessage({ pcm: copy.buffer, level }, [copy.buffer])
      this.outIndex = 0
      this.energySum = 0
    }
  }
}

registerProcessor('nd-pcm-capture', PcmCaptureProcessor)
