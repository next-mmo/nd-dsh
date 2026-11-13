/**
 * Shared contracts for ND Phone Keyboard (`nd.phone-input`): a paired Android
 * phone types (English / Khmer) and dictates through its own keyboard's voice
 * input into the focused Windows app, over local Wi-Fi, USB tethering, or LAN.
 *
 * Transport descriptors reuse the Phone Audio network shapes — the interface
 * discovery, QR pairing, and LAN allowlist are the same proven code path.
 */

import type { PhoneAudioInterfaceInfo, PhoneAudioTransportKind } from './phone-audio.js'

export const PHONE_INPUT_EXTENSION_ID = 'nd.phone-input'

// A paired keyboard stays usable for a whole typing session; the token is
// LAN-scoped and PIN-gated, matching Phone Audio's trade.
export const PHONE_INPUT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000

/** One WS text message bound; the sidecar accepts a little more headroom. */
export const PHONE_INPUT_MAX_TEXT_CHARS = 2_000

export type PhoneInputTransportKind = PhoneAudioTransportKind
export type PhoneInputInterfaceInfo = PhoneAudioInterfaceInfo

export type PhoneInputSessionState = 'stopped' | 'starting' | 'waiting' | 'connected' | 'error'

/** Named keys the phone page may send; the sidecar maps each to a virtual key. */
export const PHONE_INPUT_KEYS = [
  'enter',
  'backspace',
  'tab',
  'escape',
  'delete',
  'home',
  'end',
  'left',
  'up',
  'right',
  'down',
] as const

export type PhoneInputKey = (typeof PHONE_INPUT_KEYS)[number]

export function isPhoneInputKey(value: unknown): value is PhoneInputKey {
  return typeof value === 'string' && (PHONE_INPUT_KEYS as readonly string[]).includes(value)
}

export interface PhoneInputOptions {
  preferredInterfaceId?: string
}

export interface PhoneInputClientInfo {
  id: string
  remoteAddress: string
  transport: PhoneInputTransportKind | 'unknown'
  userAgent: string
  connectedAt: number
  charsSent: number
  keysSent: number
  latencyMs?: number
}

export interface PhoneInputSnapshot {
  sessionState: PhoneInputSessionState
  serverRunning: boolean
  port: number | null
  pairingCode: string | null
  tokenExpiresAt: number | null
  selectedInterfaceId: string | null
  selectedUrl: string | null
  interfaces: PhoneInputInterfaceInfo[]
  options: PhoneInputOptions
  client: PhoneInputClientInfo | null
  injectedChars: number
  injectedKeys: number
  lastError: string | null
  firewallHint: string
}

export const PHONE_INPUT_IPC = {
  state: 'phone-input:state',
  stateEvent: 'phone-input:state-event',
} as const

export interface PhoneInputDesktopApi {
  state(): Promise<PhoneInputSnapshot>
  onState(listener: (snapshot: PhoneInputSnapshot) => void): () => void
}