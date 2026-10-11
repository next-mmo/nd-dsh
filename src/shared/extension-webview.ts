/**
 * The `nd.webview/1` bridge between a package-shipped web view (rendered in a
 * sandboxed iframe) and its ND host. The frame has an opaque origin, no Node,
 * and no network: every privileged operation is a host-method invocation that
 * the parent forwards through the exact same broker path as any other
 * contribution call, so permissions, contexts, and audit never depend on the
 * frame's own claims.
 */

import type { NdContext } from './nd-context.js'

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

/** Host → frame, exactly once after the frame announces readiness. */
export interface NdWebViewHelloMessage {
  kind: 'nd-webview:hello'
  protocol: typeof ND_WEBVIEW_BRIDGE_PROTOCOL
  extensionId: string
  viewId: string
  context: NdContext
}

/** Frame → host, once the UI script is alive. */
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

export type NdWebViewBridgeMessage =
  | NdWebViewHelloMessage
  | NdWebViewReadyMessage
  | NdWebViewInvokeRequestMessage
  | NdWebViewInvokeResultMessage

export function isNdWebViewBridgeMessage(value: unknown): value is NdWebViewBridgeMessage {
  if (!value || typeof value !== 'object') return false
  const record = value as { kind?: unknown; protocol?: unknown; requestId?: unknown; ok?: unknown }
  if (record.kind === 'nd-webview:ready') return true
  if (record.kind === 'nd-webview:hello') {
    return record.protocol === ND_WEBVIEW_BRIDGE_PROTOCOL
      && typeof (value as { extensionId?: unknown }).extensionId === 'string'
      && typeof (value as { viewId?: unknown }).viewId === 'string'
  }
  if (record.kind === 'nd-webview:invoke') {
    const input = (value as { input?: unknown }).input
    return typeof record.requestId === 'string' && record.requestId.length <= 128
      && Boolean(input) && typeof input === 'object' && !Array.isArray(input)
  }
  if (record.kind === 'nd-webview:result') {
    return typeof record.requestId === 'string' && record.requestId.length <= 128 && typeof record.ok === 'boolean'
  }
  return false
}

/** Build the token-scoped asset URL for one package file. */
export function webviewAssetUrl(token: string, packageId: string, packagePath: string): string {
  const path = packagePath.split('/').map(encodeURIComponent).join('/')
  return `${ND_WEBVIEW_URL_SCHEME}://${token}/${packageId}/${path}`
}
