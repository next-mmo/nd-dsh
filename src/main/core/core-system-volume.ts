import type { NdSystemVolumeState, NdSystemVolumeUpdate } from '../../shared/media-session.js'
import type { CoreClient } from './core-client.js'

export interface CoreSystemVolume {
  state(): Promise<NdSystemVolumeState>
  set(update: NdSystemVolumeUpdate): Promise<NdSystemVolumeState>
}

export function validateSystemVolumeUpdate(value: unknown): NdSystemVolumeUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid system volume update')
  const update = value as Record<string, unknown>
  if (Object.keys(update).some((key) => key !== 'level' && key !== 'muted')
    || (update.level === undefined && update.muted === undefined)
    || (update.level !== undefined && (typeof update.level !== 'number' || !Number.isFinite(update.level) || update.level < 0 || update.level > 100))
    || (update.muted !== undefined && typeof update.muted !== 'boolean')) {
    throw new Error('Invalid system volume update')
  }
  return update as NdSystemVolumeUpdate
}

export function createCoreSystemVolume(core: Pick<CoreClient, 'request'>): CoreSystemVolume {
  const request = async (method: string, params: NdSystemVolumeUpdate): Promise<NdSystemVolumeState> => {
    try {
      return await core.request<NdSystemVolumeState>(method, params, 3_000)
    } catch {
      return { available: false, reason: 'System volume is unavailable' }
    }
  }
  return {
    state: () => request('media.volume-state', {}),
    set: (update) => request('media.volume-set', validateSystemVolumeUpdate(update)),
  }
}
