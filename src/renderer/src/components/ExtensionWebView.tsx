import { useEffect, useRef, useState } from 'react'
import {
  isNdWebViewBridgeMessage,
  ND_WEBVIEW_BRIDGE_PROTOCOL,
  ND_WEBVIEW_MAX_MESSAGE_CHARS,
  type NdWebViewHelloMessage,
  type NdWebViewTheme,
  type NdWebViewThemeMessage,
  type NdWebViewMirrorStartMessage,
  type NdWebViewMirrorStopMessage,
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
export function ExtensionWebView({ data, theme, onError }: {
  data: NdViewData
  theme: NdWebViewTheme
  onError?: (message: string) => void
}): React.ReactNode {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [ready, setReady] = useState(false)
  const webView = data.webView
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  // ── Mirror capture state (nd.emulator only) ──
  const mirrorStateRef = useRef<{
    track: MediaStreamTrack | null
    video: HTMLVideoElement | null
    rafId: number
  }>({ track: null, video: null, rafId: 0 })

  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !webView?.url) return
    const message: NdWebViewThemeMessage = {
      kind: 'nd-webview:theme',
      protocol: ND_WEBVIEW_BRIDGE_PROTOCOL,
      theme,
    }
    frame.contentWindow?.postMessage(message, new URL(webView.url).origin)
  }, [theme, webView?.url])

  // ── Mirror capture (nd.emulator only): getUserMedia → frames → iframe ──
  useEffect(() => {
    if (data.extensionId !== 'nd.emulator') return
    const frame = frameRef.current
    if (!frame || !webView?.url) return
    const expectedOrigin = new URL(webView.url).origin
    const ms = mirrorStateRef.current

    const stopCapture = () => {
      if (ms.rafId) {
        cancelAnimationFrame(ms.rafId)
        ms.rafId = 0
      }
      if (ms.track) {
        ms.track.stop()
        ms.track = null
      }
      if (ms.video) {
        ms.video.pause()
        ms.video.srcObject = null
        ms.video.remove()
        ms.video = null
      }
    }

    const startCapture = async (sourceId: string) => {
      try {
        // Old-style Electron desktop capture constraint
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            // @ts-expect-error Electron-specific constraint
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
            },
          },
        })
        const track = stream.getVideoTracks()[0]
        if (!track) throw new Error('No video track in capture stream')
        ms.track = track

        const video = document.createElement('video')
        video.srcObject = stream
        video.muted = true
        video.playsInline = true
        await video.play()
        ms.video = video

        const onFrame = () => {
          if (!ms.video || !ms.track || ms.track.readyState === 'ended') {
            stopCapture()
            frame.contentWindow?.postMessage({ kind: 'nd-webview:mirror-error', error: 'Capture stream ended' }, expectedOrigin)
            return
          }
          createImageBitmap(ms.video, 0, Math.round(ms.video.videoWidth * 0.065), ms.video.videoWidth, ms.video.videoHeight - Math.round(ms.video.videoWidth * 0.065))
            .then((bitmap) => {
              frame.contentWindow?.postMessage({
                kind: 'nd-webview:mirror-frame',
                bitmap,
                width: bitmap.width,
                height: bitmap.height,
              }, expectedOrigin, [bitmap])
            })
            .catch(() => {
              // transient frame drop
            })
            .finally(() => {
              if (ms.video) ms.rafId = requestAnimationFrame(onFrame)
            })
        }
        ms.rafId = requestAnimationFrame(onFrame)
      } catch (err) {
        stopCapture()
        frame.contentWindow?.postMessage({
          kind: 'nd-webview:mirror-error',
          error: err instanceof Error ? err.message : String(err),
        }, expectedOrigin)
      }
    }

    const onMirrorMessage = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) return
      if (!event.data || typeof event.data !== 'object') return
      const msg = event.data as { kind?: string }
      if (msg.kind === 'nd-webview:mirror-start') {
        const startMsg = event.data as NdWebViewMirrorStartMessage
        if (typeof startMsg.sourceId === 'string' && startMsg.sourceId.length > 0) {
          void startCapture(startMsg.sourceId)
        }
        return
      }
      if (msg.kind === 'nd-webview:mirror-stop') {
        stopCapture()
        return
      }
    }

    window.addEventListener('message', onMirrorMessage)
    return () => {
      window.removeEventListener('message', onMirrorMessage)
      stopCapture()
    }
  }, [data.extensionId, webView?.url])

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
      theme,
    }
    let pendingCalls = 0
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
      if (pendingCalls >= 8) {
        frame.contentWindow?.postMessage({ kind: 'nd-webview:result', requestId: message.requestId, ok: false,
          error: { code: 'unavailable', message: 'Too many pending extension actions. Try again shortly.' } }, expectedOrigin)
        return
      }
      pendingCalls += 1
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
        .finally(() => { pendingCalls -= 1 })
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
    }
  }, [webView?.url, webView?.token, data.extensionId, data.viewId, data.context, theme])

  if (!webView?.url) return null
  return (
    <div className="relative">
      {!ready ? <p className="text-xs text-faint" role="status">Loading extension view…</p> : null}
      <iframe
        ref={frameRef}
        src={webView.url}
        title={data.title}
        referrerPolicy="no-referrer"
        className={cn('h-[480px] w-full rounded-md border border-border-soft bg-surface-0 sm:h-[540px]', ready ? 'block' : 'hidden')}
      />
    </div>
  )
}
