export function connectStudio(onReady) {
  let origin = null
  let retry
  let delay = 200
  const pending = new Map()

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light'
  }

  function onMessage(event) {
    const message = event.data
    if (event.source !== window.parent || !message || typeof message !== 'object') return
    if (origin === null && message.kind === 'nd-webview:hello' && message.protocol === 'nd.webview/1' &&
        message.extensionId === 'nd.video-gen' && message.viewId === 'studio') {
      origin = event.origin
      clearTimeout(retry)
      setTheme(message.theme)
      onReady()
      return
    }
    if (origin === null || origin !== event.origin) return
    if (message.kind === 'nd-webview:theme') setTheme(message.theme)
    if (message.kind !== 'nd-webview:result') return
    const call = pending.get(message.requestId)
    if (!call) return
    clearTimeout(call.timer)
    pending.delete(message.requestId)
    if (message.ok) call.resolve(message.value)
    else call.reject(new Error(message.error?.message || 'The ND action failed.'))
  }

  window.addEventListener('message', onMessage)
  window.addEventListener('pagehide', () => {
    clearTimeout(retry)
    window.removeEventListener('message', onMessage)
    for (const call of pending.values()) {
      clearTimeout(call.timer)
      call.reject(new Error('The studio was closed.'))
    }
    pending.clear()
  }, { once: true })

  function announce() {
    window.parent.postMessage({ kind: 'nd-webview:ready' }, '*')
    retry = setTimeout(announce, delay)
    delay = Math.min(2_000, delay * 1.5)
  }
  announce()

  return (action, input = {}, timeout = 12_000) => new Promise((resolve, reject) => {
    if (origin === null) {
      reject(new Error('ND is still connecting.'))
      return
    }
    const requestId = crypto.randomUUID()
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('ND did not respond in time.'))
    }, timeout)
    pending.set(requestId, { timer, resolve, reject })
    window.parent.postMessage({ kind: 'nd-webview:invoke', requestId, input: { ...input, action } }, origin === 'null' ? '*' : origin)
  })
}
