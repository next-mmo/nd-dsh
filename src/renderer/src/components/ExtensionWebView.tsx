import { useEffect, useRef, useState } from 'react'
import {
  isNdWebViewBridgeMessage,
  ND_WEBVIEW_BRIDGE_PROTOCOL,
  ND_WEBVIEW_MAX_MESSAGE_CHARS,
  type NdWebViewHelloMessage,
} from '../../../shared/extension-webview'
import type { NdViewData } from '../../../shared/nd-invocations'
import { cn } from '../lib/utils'

/**
 * Generic host for `kind: 'web'` extension views: renders the package's own
 * static UI in a sandboxed iframe and forwards its bridge requests through
 * the standard extension invoke path, so the broker keeps enforcing
 * permissions, contexts, and audit regardless of what the frame asks for.
 *
 * Tokens are deliberately NOT revoked on unmount or effect re-runs: React
 * StrictMode double-mounts effects in dev, and revoking on cleanup would pull
 * the token out from under the frame's own asset loads. Exposure is bounded
 * instead by the 30-minute TTL and the live-token cap in main. The frame's
 * origin is its token-scoped asset URL (unique per dialog load, distinct from
 * the app's origin and from every other package view), which keeps same-origin
 * policy enforcement intact; popups are denied by Electron and the frame has
 * no Node and no network.
 */
export function ExtensionWebView({ data, onError }: { data: NdViewData; onError?: (message: string) => void }): React.ReactNode {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [ready, setReady] = useState(false)
  const webView = data.webView
  // Keep the callback out of the listener effect's dependencies: parents tend
  // to pass inline handlers, and a new identity would tear the bridge down on
  // every render.
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    if (!webView?.url) return
    const frame = frameRef.current
    if (!frame) return
    // The token in the asset URL is an unguessable per-dialog capability, so
    // origin equality is a strong sender check. Comparing event.source to
    // frame.contentWindow is not reliable across the cross-origin boundary.
    const expectedOrigin = new URL(webView.url).origin
    const hello: NdWebViewHelloMessage = {
      kind: 'nd-webview:hello',
      protocol: ND_WEBVIEW_BRIDGE_PROTOCOL,
      extensionId: data.extensionId,
      viewId: data.viewId,
      context: data.context,
    }
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== expectedOrigin) return
      if (!event.data || typeof event.data !== 'object') return
      // Drop oversized frames before parsing them at all.
      if (JSON.stringify(event.data).length > ND_WEBVIEW_MAX_MESSAGE_CHARS) return
      if (!isNdWebViewBridgeMessage(event.data)) return
      const message = event.data
      if (message.kind === 'nd-webview:ready') {
        frame.contentWindow?.postMessage(hello, expectedOrigin)
        setReady(true)
        return
      }
      if (message.kind !== 'nd-webview:invoke') return
      void window.ndDsh.ndExtensions.invoke({
        extensionId: data.extensionId,
        contributionId: data.viewId,
        contributionKind: 'view',
        context: data.context,
        caller: 'user',
        input: message.input,
      })
        .then((result) => {
          frame.contentWindow?.postMessage({
            kind: 'nd-webview:result',
            requestId: message.requestId,
            ok: result.ok,
            ...(result.ok ? { value: result.value } : { error: result.error ?? { code: 'failed', message: 'The action could not run.' } }),
          }, expectedOrigin)
          if (!result.ok && result.error && result.error.code !== 'denied') onErrorRef.current?.(result.error.message)
        })
        .catch((cause) => onErrorRef.current?.(cause instanceof Error ? cause.message : String(cause)))
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
    }
  }, [webView?.url, webView?.token, data.extensionId, data.viewId, data.context])

  if (!webView?.url) return null
  return (
    <div className="relative">
      {!ready ? <p className="text-xs text-faint" role="status">Loading 3D view…</p> : null}
      <iframe
        ref={frameRef}
        src={webView.url}
        title={data.title}
        referrerPolicy="no-referrer"
        className={cn('h-[480px] w-full rounded-md border border-border-soft bg-black sm:h-[540px]', ready ? 'block' : 'hidden')}
      />
    </div>
  )
}
