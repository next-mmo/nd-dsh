import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  isNdWebViewBridgeMessage,
  ND_WEBVIEW_BRIDGE_PROTOCOL,
  ND_WEBVIEW_MAX_MESSAGE_CHARS,
  type NdWebViewHelloMessage,
  type NdWebViewLiveMuteMessage,
  type NdWebViewLiveSendTextMessage,
  type NdWebViewLiveStartMessage,
  type NdWebViewLiveStatus,
  type NdWebViewLiveToolResultMessage,
  type NdWebViewTheme,
  type NdWebViewThemeMessage,
  type NdWebViewMirrorStartMessage,
  type NdWebViewMirrorStopMessage,
} from '../../../shared/extension-webview'
import type { NdContext } from '../../../shared/nd-context'
import { contextKey } from '../../../shared/nd-context'
import type { NdViewData } from '../../../shared/nd-invocations'
import { LiveSessionClient } from '../lib/live-session'
import { cn } from '../lib/utils'

const liveViewStatuses = new Map<string, NdWebViewLiveStatus>()
const liveStatusListeners = new Set<() => void>()

function liveStatusKey(extensionId: string, viewId: string, context: NdContext): string {
  return `${extensionId}:${viewId}:${contextKey(context)}`
}

function setLiveViewStatus(key: string, status: NdWebViewLiveStatus | undefined): void {
  if (!status || status === 'ended' || status === 'error') {
    if (!liveViewStatuses.has(key)) return
    liveViewStatuses.delete(key)
  } else {
    if (liveViewStatuses.get(key) === status) return
    liveViewStatuses.set(key, status)
  }
  for (const listener of liveStatusListeners) listener()
}

/** Reactive live-mic status for an extension view dialog header. */
export function useExtensionViewLiveStatus(
  target: { extensionId: string; viewId: string; context: NdContext } | null,
): NdWebViewLiveStatus | undefined {
  const key = target ? liveStatusKey(target.extensionId, target.viewId, target.context) : null
  return useSyncExternalStore(
    (listener) => {
      liveStatusListeners.add(listener)
      return () => { liveStatusListeners.delete(listener) }
    },
    () => (key ? liveViewStatuses.get(key) : undefined),
    () => undefined,
  )
}

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
export function ExtensionWebView({ data, theme, docked = true, onError }: {
  data: NdViewData
  theme: NdWebViewTheme
  docked?: boolean
  onError?: (message: string) => void
}): React.ReactNode {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [ready, setReady] = useState(false)
  const webView = data.webView
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const liveClientRef = useRef<LiveSessionClient | null>(null)
  const viewKey = liveStatusKey(data.extensionId, data.viewId, data.context)

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

  // ── Live voice/text teacher bridge (permission-gated in main via live.voice) ──
  useEffect(() => {
    if (!docked && liveClientRef.current) {
      liveClientRef.current.stop('Dialog closed')
      liveClientRef.current = null
      setLiveViewStatus(viewKey, undefined)
    }
  }, [docked, viewKey])

  useEffect(() => {
    if (!webView?.url) return
    const frame = frameRef.current
    if (!frame) return
    const expectedOrigin = new URL(webView.url).origin
    let disposed = false
    let starting = false

    const postToFrame = (payload: unknown): void => {
      if (disposed) return
      frame.contentWindow?.postMessage(payload, expectedOrigin)
    }

    const stopActiveLive = (reason?: string): void => {
      if (liveClientRef.current) {
        liveClientRef.current.stop(reason)
        liveClientRef.current = null
      }
      setLiveViewStatus(viewKey, undefined)
    }

    const startLive = async (msg: NdWebViewLiveStartMessage): Promise<void> => {
      if (starting || disposed) return
      starting = true
      stopActiveLive()
      setLiveViewStatus(viewKey, 'connecting')
      postToFrame({ kind: 'nd-webview:live-state', status: 'connecting' })

      try {
        if (!window.ndDsh.live?.open) {
          throw new Error('Live sessions are unavailable in this host.')
        }
        const open = await window.ndDsh.live.open({
          extensionId: data.extensionId,
          viewId: data.viewId,
          context: data.context,
          lessonContext: msg.lessonContext,
          ...(msg.language ? { language: msg.language } : {}),
          ...(msg.model ? { model: msg.model } : {}),
          ...(msg.voice ? { voice: msg.voice } : {}),
          ...(msg.tools ? { tools: msg.tools } : {}),
        })
        if (disposed) return

        const client = new LiveSessionClient({
          onState: (status, extra) => {
            if (status === 'ended' || status === 'error') {
              if (liveClientRef.current === client) liveClientRef.current = null
              setLiveViewStatus(viewKey, undefined)
            } else {
              setLiveViewStatus(viewKey, status)
            }
            postToFrame({
              kind: 'nd-webview:live-state',
              status,
              ...(extra?.model ? { model: extra.model } : {}),
              ...(extra?.providerName ? { providerName: extra.providerName } : {}),
              ...(extra?.reason ? { reason: extra.reason } : {}),
            })
            if (status === 'error' && extra?.reason) {
              onErrorRef.current?.(extra.reason)
            }
          },
          onTranscript: (tx) => {
            postToFrame({ kind: 'nd-webview:live-transcript', ...tx })
          },
          onLevel: (level) => {
            postToFrame({ kind: 'nd-webview:live-level', level })
          },
          onToolCall: (call) => {
            postToFrame({ kind: 'nd-webview:live-tool-call', ...call })
          },
        })
        liveClientRef.current = client
        await client.start(open)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        setLiveViewStatus(viewKey, undefined)
        postToFrame({ kind: 'nd-webview:live-state', status: 'error', reason })
        onErrorRef.current?.(reason)
      } finally {
        starting = false
      }
    }

    const onLiveMessage = (event: MessageEvent): void => {
      if (event.origin !== expectedOrigin) return
      if (!event.data || typeof event.data !== 'object') return
      if (JSON.stringify(event.data).length > ND_WEBVIEW_MAX_MESSAGE_CHARS) return
      if (!isNdWebViewBridgeMessage(event.data)) return
      const message = event.data
      if (message.kind === 'nd-webview:live-start') {
        void startLive(message)
        return
      }
      if (message.kind === 'nd-webview:live-stop') {
        stopActiveLive('Ended by user')
        return
      }
      if (message.kind === 'nd-webview:live-send-text') {
        const textMsg = message as NdWebViewLiveSendTextMessage
        liveClientRef.current?.sendText(textMsg.text)
        return
      }
      if (message.kind === 'nd-webview:live-mute') {
        const muteMsg = message as NdWebViewLiveMuteMessage
        liveClientRef.current?.setMuted(muteMsg.muted)
        return
      }
      if (message.kind === 'nd-webview:live-tool-result') {
        const toolMsg = message as NdWebViewLiveToolResultMessage
        liveClientRef.current?.sendToolResult(toolMsg.id, toolMsg.name, toolMsg.response)
      }
    }

    window.addEventListener('message', onLiveMessage)
    return () => {
      disposed = true
      window.removeEventListener('message', onLiveMessage)
      stopActiveLive('View closed')
    }
  }, [webView?.url, webView?.token, data.extensionId, data.viewId, data.context, viewKey])

  // ── Phone Audio live state push (nd.phone-audio only) ──
  useEffect(() => {
    if (data.extensionId !== 'nd.phone-audio') return
    const frame = frameRef.current
    const api = window.ndDsh?.phoneAudio
    if (!frame || !webView?.url || !api) return
    const expectedOrigin = new URL(webView.url).origin
    const pushState = (snapshot: unknown): void => {
      frame.contentWindow?.postMessage({ kind: 'nd-webview:phone-audio-state', state: snapshot }, expectedOrigin)
    }
    const unsubscribe = api.onState(pushState)
    if (ready) {
      void api.state().then(pushState).catch(() => undefined)
    }
    return () => unsubscribe()
  }, [data.extensionId, webView?.url, ready])

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
