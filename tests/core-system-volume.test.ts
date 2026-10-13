import { describe, expect, it, vi } from 'vitest'
import { createCoreSystemVolume, validateSystemVolumeUpdate } from '../src/main/core/core-system-volume.js'

describe('native system volume adapter', () => {
  it('reads and writes the default output through the sidecar without a media session', async () => {
    const state = { available: true, level: 42, muted: false, canMute: true }
    const request = vi.fn().mockResolvedValue(state)
    const volume = createCoreSystemVolume({ request })
    expect(await volume.state()).toEqual(state)
    expect(await volume.set({ level: 0 })).toEqual(state)
    expect(await volume.set({ muted: true })).toEqual(state)
    expect(request.mock.calls).toEqual([
      ['media.volume-state', {}, 3_000],
      ['media.volume-set', { level: 0 }, 3_000],
      ['media.volume-set', { muted: true }, 3_000],
    ])
  })

  it('rejects malformed updates before crossing the native boundary', () => {
    for (const value of [null, [], {}, { level: NaN }, { level: Infinity }, { level: -1 }, { level: 101 }, { level: '50' }, { muted: 1 }, { command: 'mute' }, { level: 50, command: 'mute' }]) {
      expect(() => validateSystemVolumeUpdate(value)).toThrow('Invalid system volume update')
    }
    expect(validateSystemVolumeUpdate({ level: 100, muted: false })).toEqual({ level: 100, muted: false })
  })

  it('reports unavailability when the sidecar or audio device is unavailable', async () => {
    const volume = createCoreSystemVolume({ request: vi.fn().mockRejectedValue(new Error('offline')) })
    expect(await volume.state()).toEqual({ available: false, reason: 'System volume is unavailable' })
    expect(await volume.set({ level: 50 })).toEqual({ available: false, reason: 'System volume is unavailable' })
  })
})
