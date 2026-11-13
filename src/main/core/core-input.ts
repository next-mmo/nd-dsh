import type { CoreClient } from './core-client.js'

/**
 * Keyboard injection owned by the nd-core sidecar (Windows SendInput). The
 * Phone Keyboard service calls this for text and named keys arriving from a
 * paired phone; failures throw so the service can report them to the phone
 * rather than silently dropping keystrokes.
 */
export interface CoreInput {
  typeText(text: string): Promise<void>
  sendKey(key: string): Promise<void>
}

const INPUT_TIMEOUT_MS = 5_000

export function createCoreInput(core: Pick<CoreClient, 'request'>): CoreInput {
  return {
    async typeText(text) {
      await core.request('input.text', { text }, INPUT_TIMEOUT_MS)
    },
    async sendKey(key) {
      await core.request('input.key', { key }, INPUT_TIMEOUT_MS)
    },
  }
}