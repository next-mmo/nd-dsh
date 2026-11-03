/**
 * nd.webview/1 bridge client for the OS Toolkit studio.
 *
 * Runs inside ND's sandboxed iframe: opaque origin, no Node, no network. Every
 * privileged operation goes out through postMessage and comes back as a brokered
 * result, so this script holds no authority of its own.
 *
 * The three rules below each cost a debugging session elsewhere in the repo, so
 * they are kept explicit rather than simplified:
 *
 * 1. Sender checks use `event.origin`, latched from the first valid `hello`.
 *    `event.source` is not reliable across the cross-origin boundary.
 * 2. Work is queued until `hello` lands. An initial fetch always races the
 *    handshake, so anything sent before it would be silently dropped.
 * 3. The announce loop retries forever with backoff. A host that mounts late must
 *    still connect instead of leaving the dialog stuck on its loading state.
 */

const BRIDGE_PROTOCOL = 'nd.webview/1'
const INVOKE_TIMEOUT_MS = 10_000
const FAST_ANNOUNCE_MS = 250
const SLOW_ANNOUNCE_MS = 2_000
const FAST_ANNOUNCE_ATTEMPTS = 40

export function createBridge(options = {}) {
  const onTheme = options.onTheme ?? (() => undefined)

  let hello = null
  let hostOrigin = null
  const pending = new Map()
  const connectQueue = []

  const applyTheme = (theme) => {
    const effective = theme === 'light' ? 'light' : 'dark'
    document.documentElement.dataset.theme = effective
    const meta = document.querySelector('meta[name="color-scheme"]')
    if (meta) meta.setAttribute('content', effective)
    onTheme(effective)
  }

  window.addEventListener('message', (event) => {
    // Once the host has identified itself, nothing from any other origin is a
    // bridge message. Before the first hello there is no origin to compare
    // against, so the protocol and kind checks are the only gate.
    if (hostOrigin !== null && event.origin !== hostOrigin) return
    const data = event.data
    if (!data || typeof data !== 'object') return

    if (data.kind === 'nd-webview:hello' && data.protocol === BRIDGE_PROTOCOL) {
      hostOrigin = event.origin
      if (data.theme) applyTheme(data.theme)
      hello = data
      while (connectQueue.length > 0) connectQueue.shift()()
      return
    }
    if (data.kind === 'nd-webview:theme' && data.protocol === BRIDGE_PROTOCOL) {
      if (data.theme) applyTheme(data.theme)
      return
    }
    if (data.kind === 'nd-webview:result') {
      const settle = pending.get(data.requestId)
      if (settle) {
        pending.delete(data.requestId)
        settle(data)
      }
    }
  })

  let attempts = 0
  let fastTimer = null
  let slowTimer = null

  const announce = () => window.parent.postMessage({ kind: 'nd-webview:ready' }, '*')

  const settleTimers = () => {
    if (fastTimer) {
      clearInterval(fastTimer)
      fastTimer = null
    }
    if (slowTimer) {
      clearInterval(slowTimer)
      slowTimer = null
    }
  }

  /**
   * Call only after every control is bound: `ready` means "this UI can accept
   * input", and the host unhides the frame on it.
   */
  const start = () => {
    if (fastTimer || slowTimer) return
    announce()
    fastTimer = setInterval(() => {
      if (hello) {
        settleTimers()
        return
      }
      attempts += 1
      if (attempts > FAST_ANNOUNCE_ATTEMPTS) {
        clearInterval(fastTimer)
        fastTimer = null
        slowTimer = setInterval(() => {
          if (hello) settleTimers()
          else announce()
        }, SLOW_ANNOUNCE_MS)
        return
      }
      announce()
    }, FAST_ANNOUNCE_MS)
  }

  /** Stop announcing. Never revokes anything: tokens are TTL-only, and a React
   *  StrictMode double-mount would otherwise pull the token out from under the
   *  frame's own asset loads. */
  const stop = () => settleTimers()

  return {
    start,
    stop,
    get connected() {
      return Boolean(hello)
    },
    get info() {
      return hello
    },
    /** Run fn once the handshake has landed, immediately if it already has. */
    whenConnected(fn) {
      if (hello) fn()
      else connectQueue.push(fn)
    },
    /** `input.action` must name one of the view's declared actions. */
    invoke(input) {
      if (!hello) {
        return Promise.resolve({ ok: false, error: { code: 'unavailable', message: 'Not connected to ND' } })
      }
      const requestId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `os-toolkit-${Date.now()}-${Math.random().toString(16).slice(2)}`
      return new Promise((resolve) => {
        pending.set(requestId, resolve)
        window.parent.postMessage({ kind: 'nd-webview:invoke', requestId, input }, '*')
        setTimeout(() => {
          if (pending.has(requestId)) {
            pending.delete(requestId)
            resolve({ ok: false, error: { code: 'timeout', message: 'ND did not answer in time' } })
          }
        }, INVOKE_TIMEOUT_MS)
      })
    },
  }
}

/** Human text for a bridge failure, so the studio never prints a raw code. */
export function describeBridgeFailure(response) {
  if (response && response.ok) return null
  const code = response?.error?.code
  const message = response?.error?.message
  if (code === 'timeout') return 'ND did not answer in time. Try again.'
  if (code === 'unavailable') return 'This panel is not connected to ND yet.'
  if (code === 'approval-required') return 'ND is asking you to approve this change.'
  if (typeof message === 'string' && message.trim().length > 0) return message
  return 'ND could not complete that action.'
}
