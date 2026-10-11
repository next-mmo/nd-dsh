import type { CoreClient } from './core-client.js'

/**
 * The content-free `clipboard.changed` event from nd-core. It deliberately
 * carries no clipboard content: a watcher event proves that something was
 * copied, never what.
 */
export interface CoreClipboardChangedEvent {
  watchId: string
  seq: number
  /** Sorted clipboard format ids present at change time. */
  signature: number[]
  contentType: 'text' | 'image' | 'files' | 'other'
  timestamp: number
  /** Events the sidecar dropped since the previous delivered event. */
  droppedSinceLast?: number
}

/**
 * Clipboard content read out of the sidecar through the trusted
 * `clipboard.read` path. This is the only route history recording and note
 * capture take; the event path never carries any of it.
 */
export interface CoreClipboardContent {
  kind: 'text' | 'image' | 'files' | 'none'
  text?: string
  truncated?: boolean
  /** Base64-encoded PNG re-encode of the clipboard bitmap. */
  pngBase64?: string
  /** Hash over decoded pixels plus dimensions; stable across re-encodes. */
  fingerprint?: string
  width?: number
  height?: number
  fileName?: string
  /** The image was real but beyond the storage bound; metadata only. */
  tooLarge?: boolean
  names?: string[]
}

/**
 * The sidecar's clipboard surface: read, write, and the push-event watcher.
 * One process owning all three is what makes ND's own write-back echo a
 * reliable in-process suppression instead of a cross-process guess.
 */
export interface CoreClipboard {
  /**
   * Start one watcher. Resolves with the resource id or rejects — never a
   * silent success. The result's `mode` reports push versus poll delivery.
   */
  watch(): Promise<{ watchId: string; mode: 'push' | 'poll' }>
  unwatch(watchId: string): Promise<boolean>
  read(): Promise<CoreClipboardContent>
  writeText(text: string): Promise<void>
  /** Subscribe to content-free change events. */
  onChanged(listener: (event: CoreClipboardChangedEvent) => void): () => void
  /** The sidecar is back after (re)start; watchers must be re-established. */
  onReady(listener: () => void): () => void
  /** The sidecar exited; every watcher it hosted is gone. */
  onExit(listener: () => void): () => void
}

const CLIPBOARD_CALL_TIMEOUT_MS = 15_000
const CLIPBOARD_WATCH_TIMEOUT_MS = 20_000

export function createCoreClipboard(
  core: Pick<CoreClient, 'request' | 'onEvent'>,
): CoreClipboard {
  return {
    async watch() {
      const result = await core.request<{ watchId: string; mode: 'push' | 'poll' }>(
        'clipboard.watch',
        {},
        CLIPBOARD_WATCH_TIMEOUT_MS,
      )
      if (!result || typeof result.watchId !== 'string' || !result.watchId) {
        throw new Error('nd-core returned no clipboard watcher id')
      }
      return result
    },
    async unwatch(watchId) {
      const result = await core.request<{ removed: boolean }>(
        'clipboard.unwatch',
        { watchId },
        CLIPBOARD_CALL_TIMEOUT_MS,
      )
      return result?.removed === true
    },
    async read() {
      const result = await core.request<CoreClipboardContent>(
        'clipboard.read',
        {},
        CLIPBOARD_CALL_TIMEOUT_MS,
      )
      return result ?? { kind: 'none' }
    },
    async writeText(text) {
      await core.request('clipboard.write', { text }, CLIPBOARD_CALL_TIMEOUT_MS)
    },
    onChanged(listener) {
      // The wire frame wraps the payload; unwrap it for consumers.
      return core.onEvent<CoreClipboardChangedEvent>('clipboard.changed', (frame) => listener(frame.data))
    },
    onReady(listener) {
      return core.onEvent('core.ready', listener)
    },
    onExit(listener) {
      return core.onEvent('core.exit', listener)
    },
  }
}
