const BRIDGE_PROTOCOL = 'nd.webview/1'
const INVOKE_TIMEOUT_MS = 12_000
const FAST_ANNOUNCE_MS = 250
const SLOW_ANNOUNCE_MS = 2_000
const FAST_ANNOUNCE_ATTEMPTS = 40

export function createBridge(options = {}) {
  const onTheme = options.onTheme ?? (() => undefined)
  const onPhoneAudioState = options.onPhoneAudioState ?? (() => undefined)

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
    if (data.kind === 'nd-webview:phone-audio-state') {
      if (data.state && typeof data.state === 'object') {
        onPhoneAudioState(data.state)
      }
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

  return {
    start,
    stop: settleTimers,
    whenConnected(fn) {
      if (hello) fn()
      else connectQueue.push(fn)
    },
    invoke(input, timeoutMs = INVOKE_TIMEOUT_MS) {
      if (!hello) {
        return Promise.resolve({ ok: false, error: { code: 'unavailable', message: 'Not connected to ND' } })
      }
      const requestId = crypto.randomUUID()
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.has(requestId)) return
          pending.delete(requestId)
          resolve({ ok: false, error: { code: 'timeout', message: 'ND did not answer in time' } })
        }, timeoutMs)
        pending.set(requestId, (result) => {
          clearTimeout(timer)
          resolve(result)
        })
        window.parent.postMessage({ kind: 'nd-webview:invoke', requestId, input }, hostOrigin ?? '*')
      })
    },
  }
}
