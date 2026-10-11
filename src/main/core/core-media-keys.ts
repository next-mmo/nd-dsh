import type { NdMediaKeyKind } from '../../shared/media-session.js'
import type { CoreClient } from './core-client.js'

/**
 * OS media transport keys synthesized by the nd-core sidecar. The quick
 * launcher transport row only reaches for these when the playing page offers
 * no button of its own to press, or when the media lives outside ND.
 */
export interface CoreMediaKeys {
  sendKey(key: NdMediaKeyKind): Promise<boolean>
}

const MEDIA_KEY_TIMEOUT_MS = 3_000

export function createCoreMediaKeys(core: Pick<CoreClient, 'request'>): CoreMediaKeys {
  return {
    async sendKey(key) {
      try {
        const result = await core.request<{ sent?: boolean }>('media.key', { key }, MEDIA_KEY_TIMEOUT_MS)
        return result?.sent === true
      } catch {
        // A missing sidecar or a non-Windows host degrades to a no-op; the
        // transport row stays responsive either way.
        return false
      }
    },
  }
}
