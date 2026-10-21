/**
 * nd.webview/1 client. The frame has an opaque origin, no Node, and no
 * network; every capability is a named view action routed by the host through
 * the extension broker. Announce until the host answers: a late-mounting host
 * must still connect.
 */
export function createBridge() {
  let hello = null
  const pending = new Map()
  const connectQueue = []
  let retry = null

  const applyTheme = (theme) => {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
  }

  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.kind === 'nd-webview:hello' && data.protocol === 'nd.webview/1') {
      applyTheme(data.theme)
      hello = data
      while (connectQueue.length > 0) connectQueue.shift()()
      return
    }
    if (data.kind === 'nd-webview:theme' && data.protocol === 'nd.webview/1') {
      applyTheme(data.theme)
      return
    }
    if (data.kind === 'nd-webview:result' && typeof data.requestId === 'string') {
      const settle = pending.get(data.requestId)
      if (settle) {
        pending.delete(data.requestId)
        settle(data)
      }
    }
  })

  const announce = () => window.parent.postMessage({ kind: 'nd-webview:ready' }, '*')

  return {
    start() {
      if (retry) return
      announce()
      let attempts = 0
      let slow = false
      retry = setInterval(() => {
        if (hello) {
          clearInterval(retry)
          retry = null
          return
        }
        attempts += 1
        if (!slow && attempts > 40) {
          slow = true
          clearInterval(retry)
          retry = setInterval(() => {
            if (hello) {
              clearInterval(retry)
              retry = null
              return
            }
            announce()
          }, 2000)
          return
        }
        announce()
      }, 250)
    },
    get connected() {
      return Boolean(hello)
    },
    whenConnected(callback) {
      if (hello) callback()
      else connectQueue.push(callback)
    },
    invoke(input, timeoutMs = 15_000) {
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
        pending.set(requestId, (message) => {
          clearTimeout(timer)
          resolve(message)
        })
        window.parent.postMessage({ kind: 'nd-webview:invoke', requestId, input }, '*')
      })
    },
  }
}
