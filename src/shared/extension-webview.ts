/**
 * The `nd.webview/1` bridge between a package-shipped web view (rendered in a
 * sandboxed iframe) and its ND host. The frame has an opaque origin, no Node,
 * and no network: every privileged operation is a host-method invocation that
 * the parent forwards through the exact same broker path as any other
 * contribution call, so permissions, contexts, and audit never depend on the
 * frame's own claims.
 */

import type { NdContext } from './nd-context.js'
import type { LiveToolDeclaration } from './live-session.js'

export const ND_WEBVIEW_BRIDGE_PROTOCOL = 'nd.webview/1'
export const ND_WEBVIEW_URL_SCHEME = 'nd-extension-ui'

/** Per-file cap for package UI assets, enforced at install and serve time. */
export const ND_WEBVIEW_MAX_ASSET_FILE_BYTES = 8 * 1024 * 1024
/** Total cap for one package's UI assets, enforced at install time. */
export const ND_WEBVIEW_MAX_ASSET_TOTAL_BYTES = 24 * 1024 * 1024
/** One bridge message in either direction; larger frames are dropped unread. */
export const ND_WEBVIEW_MAX_MESSAGE_CHARS = 262_144

/** Privileges for the asset scheme: standard parsing, secure context, no fetch, no CORS. */
export const ND_WEBVIEW_SCHEME_PRIVILEGES = {
  scheme: ND_WEBVIEW_URL_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
} as const

export type NdWebViewTheme = 'light' | 'dark'

/** Host → frame, exactly once after the frame announces readiness. */
export interface NdWebViewHelloMessage {
  kind: 'nd-webview:hello'
  protocol: typeof ND_WEBVIEW_BRIDGE_PROTOCOL
  extensionId: string
  viewId: string
  context: NdContext
  theme: NdWebViewTheme
}

/** Host → frame, whenever ND's effective theme changes while the view lives. */
export interface NdWebViewThemeMessage {
  kind: 'nd-webview:theme'
  protocol: typeof ND_WEBVIEW_BRIDGE_PROTOCOL
  theme: NdWebViewTheme
}

/**
 * Frame → host, once the UI can accept input. The host unhides the frame on
 * this message, so a package must send it only after its controls are bound —
 * announcing earlier lets interactions land on a UI that cannot handle them
 * yet (they are silently dropped).
 */
export interface NdWebViewReadyMessage {
  kind: 'nd-webview:ready'
}

/** Frame → host; the parent routes it as a view invocation for this extension. */
export interface NdWebViewInvokeRequestMessage {
  kind: 'nd-webview:invoke'
  requestId: string
  input: Record<string, unknown>
}

/** Host → frame, the correlated invoke outcome. */
export interface NdWebViewInvokeResultMessage {
  kind: 'nd-webview:result'
  requestId: string
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}

export type NdWebViewLiveStatus = 'connecting' | 'live' | 'muted' | 'ended' | 'error'

/** Frame -> host: start a live voice/text session for this view. */
export interface NdWebViewLiveStartMessage {
  kind: 'nd-webview:live-start'
  lessonContext: string
  language?: 'en' | 'km'
  model?: string
  voice?: string
  tools?: LiveToolDeclaration[]
}

/** Frame -> host: end the active live session and release the microphone. */
export interface NdWebViewLiveStopMessage {
  kind: 'nd-webview:live-stop'
}

/** Frame -> host: send a typed turn or scratchpad snippet into the live session. */
export interface NdWebViewLiveSendTextMessage {
  kind: 'nd-webview:live-send-text'
  text: string
}

/** Frame -> host: mute or unmute microphone capture. */
export interface NdWebViewLiveMuteMessage {
  kind: 'nd-webview:live-mute'
  muted: boolean
}

/** Frame -> host: return the result of a live tool call back to the model. */
export interface NdWebViewLiveToolResultMessage {
  kind: 'nd-webview:live-tool-result'
  id: string
  name: string
  response: Record<string, unknown>
}

/** Host -> frame: lifecycle & status update for the live session. */
export interface NdWebViewLiveStateMessage {
  kind: 'nd-webview:live-state'
  status: NdWebViewLiveStatus
  model?: string
  providerName?: string
  reason?: string
}

/** Host -> frame: user or model transcript delta/final entry. */
export interface NdWebViewLiveTranscriptMessage {
  kind: 'nd-webview:live-transcript'
  role: 'user' | 'teacher'
  text: string
  final: boolean
}

/** Host -> frame: normalized microphone audio input level (0..1). */
export interface NdWebViewLiveLevelMessage {
  kind: 'nd-webview:live-level'
  level: number
}

/** Host -> frame: live function call requested by the teacher model. */
export interface NdWebViewLiveToolCallMessage {
  kind: 'nd-webview:live-tool-call'
  id: string
  name: string
  args: Record<string, unknown>
}

/** Parent -> frame: push live Phone Audio snapshot into the sandboxed extension UI. */
export interface NdWebViewPhoneAudioStateMessage {
  kind: 'nd-webview:phone-audio-state'
  state: unknown
}

export type NdWebViewBridgeMessage =
  | NdWebViewHelloMessage
  | NdWebViewThemeMessage
  | NdWebViewReadyMessage
  | NdWebViewInvokeRequestMessage
  | NdWebViewInvokeResultMessage
  | NdWebViewLiveStartMessage
  | NdWebViewLiveStopMessage
  | NdWebViewLiveSendTextMessage
  | NdWebViewLiveMuteMessage
  | NdWebViewLiveToolResultMessage
  | NdWebViewLiveStateMessage
  | NdWebViewLiveTranscriptMessage
  | NdWebViewLiveLevelMessage
  | NdWebViewLiveToolCallMessage
  | NdWebViewPhoneAudioStateMessage

// ── Mirror capture extension (nd.emulator internal) ──

/** Frame → parent: request the parent to start getUserMedia capture. */
export interface NdWebViewMirrorStartMessage {
  kind: 'nd-webview:mirror-start'
  sourceId: string
}

/** Frame → parent: stop the continuous capture and fall back to MJPEG. */
export interface NdWebViewMirrorStopMessage {
  kind: 'nd-webview:mirror-stop'
}

/** Parent → frame: a single frame as a transferable ImageBitmap. */
export interface NdWebViewMirrorFrameMessage {
  kind: 'nd-webview:mirror-frame'
  bitmap: ImageBitmap
  width: number
  height: number
}

/** Parent → frame: the capture stream errored; fall back to MJPEG. */
export interface NdWebViewMirrorErrorMessage {
  kind: 'nd-webview:mirror-error'
  error: string
}

export function isNdWebViewBridgeMessage(value: unknown): value is NdWebViewBridgeMessage {
  if (!value || typeof value !== 'object') return false
  const record = value as { kind?: unknown; protocol?: unknown; requestId?: unknown; ok?: unknown }
  if (record.kind === 'nd-webview:ready') return true
  if (record.kind === 'nd-webview:hello') {
    return record.protocol === ND_WEBVIEW_BRIDGE_PROTOCOL
      && typeof (value as { extensionId?: unknown }).extensionId === 'string'
      && typeof (value as { viewId?: unknown }).viewId === 'string'
      && isNdWebViewTheme((value as { theme?: unknown }).theme)
  }
  if (record.kind === 'nd-webview:theme') {
    return record.protocol === ND_WEBVIEW_BRIDGE_PROTOCOL
      && isNdWebViewTheme((value as { theme?: unknown }).theme)
  }
  if (record.kind === 'nd-webview:invoke') {
    const input = (value as { input?: unknown }).input
    return typeof record.requestId === 'string' && record.requestId.length <= 128
      && Boolean(input) && typeof input === 'object' && !Array.isArray(input)
  }
  if (record.kind === 'nd-webview:result') {
    return typeof record.requestId === 'string' && record.requestId.length <= 128 && typeof record.ok === 'boolean'
  }
  if (record.kind === 'nd-webview:live-start') {
    const raw = value as Record<string, unknown>
    return typeof raw.lessonContext === 'string' && raw.lessonContext.length <= 12_000
      && (raw.language === undefined || raw.language === 'en' || raw.language === 'km')
      && (raw.model === undefined || (typeof raw.model === 'string' && raw.model.length <= 128))
      && (raw.voice === undefined || (typeof raw.voice === 'string' && raw.voice.length <= 64))
      && (raw.tools === undefined || (Array.isArray(raw.tools) && raw.tools.length <= 8))
  }
  if (record.kind === 'nd-webview:live-stop') {
    return true
  }
  if (record.kind === 'nd-webview:live-send-text') {
    const text = (value as { text?: unknown }).text
    return typeof text === 'string' && text.length > 0 && text.length <= 16_000
  }
  if (record.kind === 'nd-webview:live-mute') {
    return typeof (value as { muted?: unknown }).muted === 'boolean'
  }
  if (record.kind === 'nd-webview:live-tool-result') {
    const raw = value as Record<string, unknown>
    return typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 128
      && typeof raw.name === 'string' && raw.name.length > 0 && raw.name.length <= 64
      && Boolean(raw.response) && typeof raw.response === 'object' && !Array.isArray(raw.response)
  }
  if (record.kind === 'nd-webview:live-state') {
    const status = (value as { status?: unknown }).status
    return status === 'connecting' || status === 'live' || status === 'muted' || status === 'ended' || status === 'error'
  }
  if (record.kind === 'nd-webview:live-transcript') {
    const raw = value as Record<string, unknown>
    return (raw.role === 'user' || raw.role === 'teacher')
      && typeof raw.text === 'string'
      && typeof raw.final === 'boolean'
  }
  if (record.kind === 'nd-webview:live-level') {
    const level = (value as { level?: unknown }).level
    return typeof level === 'number' && Number.isFinite(level) && level >= 0 && level <= 1
  }
  if (record.kind === 'nd-webview:live-tool-call') {
    const raw = value as Record<string, unknown>
    return typeof raw.id === 'string' && raw.id.length <= 128
      && typeof raw.name === 'string' && raw.name.length <= 64
      && Boolean(raw.args) && typeof raw.args === 'object' && !Array.isArray(raw.args)
  }
  if (record.kind === 'nd-webview:phone-audio-state') {
    const state = (value as { state?: unknown }).state
    return Boolean(state) && typeof state === 'object' && !Array.isArray(state)
  }
  return false
}

function isNdWebViewTheme(value: unknown): value is NdWebViewTheme {
  return value === 'light' || value === 'dark'
}

/** Build the token-scoped asset URL for one package file. */
export function webviewAssetUrl(token: string, packageId: string, packagePath: string): string {
  const path = packagePath.split('/').map(encodeURIComponent).join('/')
  return `${ND_WEBVIEW_URL_SCHEME}://${token}/${packageId}/${path}`
}
