/**
 * ND Mini Browser — package-shipped web view UI.
 *
 * Runs inside ND's sandboxed iframe: opaque origin, no Node, no network. The
 * chrome itself is only a dashboard — every navigation effects a REAL tab of
 * the ND built-in browser through the nd.webview/1 bridge (postMessage →
 * parent → broker → host methods). This view holds no authority of its own,
 * and it keep-alives: closing the dialog or navigating the app never unmounts
 * the session.
 */
import { addressBadge, chromeSession, describeAddress, fallbackTabTitle } from './chrome-core.js'

// --- nd.webview/1 bridge client ---------------------------------------------

function createBridge() {
  let hello = null
  const pending = new Map()
  const connectQueue = []

  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.kind === 'nd-webview:hello' && data.protocol === 'nd.webview/1') {
      hello = data
      while (connectQueue.length > 0) connectQueue.shift()()
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

  // Announce readiness until the host answers: a fast burst first, then a
  // slow retry forever, so a host that mounts late still connects instead of
  // leaving the dialog stuck on its loading state.
  let attempts = 0
  let slow = false
  const announce = () => window.parent.postMessage({ kind: 'nd-webview:ready' }, '*')
  announce()
  const retry = setInterval(() => {
    if (hello) {
      clearInterval(retry)
      return
    }
    attempts += 1
    if (!slow && attempts > 40) {
      slow = true
      clearInterval(retry)
      setInterval(function slower() {
        if (!hello) announce()
        else clearInterval(slower)
      }, 2_000)
      return
    }
    announce()
  }, 250)

  return {
    get connected() {
      return Boolean(hello)
    },
    /** Run fn once the host handshake has landed (immediately if it has). */
    whenConnected(fn) {
      if (hello) fn()
      else connectQueue.push(fn)
    },
    /** input {action} routes through the parent to the view's declared host methods. */
    invoke(input) {
      if (!hello) {
        return Promise.resolve({ ok: false, error: { code: 'unavailable', message: 'Not connected to ND' } })
      }
      const requestId = crypto.randomUUID()
      return new Promise((resolve) => {
        pending.set(requestId, resolve)
        window.parent.postMessage({ kind: 'nd-webview:invoke', requestId, input }, '*')
        setTimeout(() => {
          if (pending.has(requestId)) {
            pending.delete(requestId)
            resolve({ ok: false, error: { code: 'timeout', message: 'ND did not answer in time' } })
          }
        }, 15_000)
      })
    },
  }
}

const bridge = createBridge()

// --- DOM ---------------------------------------------------------------------

const addressEl = document.getElementById('address')
const openEl = document.getElementById('open')
const statusEl = document.getElementById('status')
const tabsEl = document.getElementById('tabs')
const linksEl = document.getElementById('links')

let lastSession = { tabs: [], links: [] }
let busy = false

function setStatus(message, isError = false) {
  statusEl.textContent = message ?? ''
  statusEl.classList.toggle('error', isError)
}

function tabRow(tab) {
  const li = document.createElement('li')
  li.className = tab.active ? 'row active' : (tab.alive ? 'row' : 'row sleeping')
  if (!tab.alive) {
    const tag = document.createElement('span')
    tag.className = 'sleep-tag'
    tag.textContent = 'sleeping'
    li.append(tag)
  }
  const badge = document.createElement('span')
  badge.className = 'badge'
  badge.textContent = addressBadge(tab.url)
  const meta = document.createElement('span')
  meta.className = 'meta'
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = tab.title || fallbackTabTitle(tab.url)
  const addr = document.createElement('span')
  addr.className = 'addr'
  addr.textContent = describeAddress(tab.url)
  meta.append(name, addr)

  const focus = document.createElement('button')
  focus.type = 'button'
  focus.className = 'pill'
  focus.textContent = 'Focus'
  focus.setAttribute('aria-label', `Switch to tab ${tab.title || tab.url}`)

  const drop = document.createElement('button')
  drop.type = 'button'
  drop.className = 'drop'
  drop.textContent = '✕'
  drop.setAttribute('aria-label', `Close tab ${tab.title || tab.url}`)

  focus.disabled = busy
  drop.disabled = busy

  focus.addEventListener('click', async () => {
    busy = true
    render()
    setStatus(`Switching to ${tab.title || tab.url}…`)
    const result = await bridge.invoke({ action: 'activate', id: tab.id })
    busy = false
    if (result.ok) {
      lastSession = chromeSession(result.value?.session)
      setStatus(`Switched to ${tab.title || tab.url} in the ND browser.`)
    } else {
      setStatus(result.error?.message ?? 'Switching failed.', true)
    }
    render()
  })

  drop.addEventListener('click', async () => {
    busy = true
    render()
    const result = await bridge.invoke({ action: 'close', id: tab.id })
    busy = false
    if (result.ok) {
      lastSession = chromeSession(result.value?.session)
      setStatus(`Closed ${tab.title || tab.url}.`)
    } else {
      setStatus(result.error?.message ?? 'Closing failed.', true)
    }
    render()
  })

  li.append(badge, meta, focus, drop)
  return li
}

function linkRow(link) {
  const li = document.createElement('li')
  li.className = 'row'
  const badge = document.createElement('span')
  badge.className = 'badge'
  badge.textContent = addressBadge(link.url)
  const meta = document.createElement('span')
  meta.className = 'meta'
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = link.title
  const addr = document.createElement('span')
  addr.className = 'addr'
  addr.textContent = describeAddress(link.url)
  meta.append(name, addr)

  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'pill'
  open.textContent = '▶ Open'
  open.setAttribute('aria-label', `Open ${link.title} in a new tab`)

  const drop = document.createElement('button')
  drop.type = 'button'
  drop.className = 'drop'
  drop.textContent = '✕'
  drop.setAttribute('aria-label', `Remove quick link ${link.title}`)

  open.disabled = busy
  drop.disabled = busy

  open.addEventListener('click', async () => {
    busy = true
    render()
    setStatus(`Opening ${link.title} in a new tab…`)
    const result = await bridge.invoke({ action: 'open', url: link.url })
    busy = false
    if (result.ok) {
      lastSession = chromeSession(result.value?.session)
      setStatus(`Opened ${link.title}.`)
    } else {
      setStatus(result.error?.message ?? 'Opening failed.', true)
    }
    render()
  })

  drop.addEventListener('click', async () => {
    busy = true
    render()
    const result = await bridge.invoke({ action: 'link-remove', id: link.id })
    busy = false
    if (result.ok) {
      lastSession = chromeSession(result.value?.session)
      setStatus(`Removed “${link.title}”.`)
    } else {
      setStatus(result.error?.message ?? 'Removing failed.', true)
    }
    render()
  })

  li.append(badge, meta, open, drop)
  return li
}

function emptyRow(message) {
  const li = document.createElement('li')
  li.className = 'empty'
  li.textContent = message
  return li
}

function render() {
  tabsEl.replaceChildren()
  if (lastSession.tabs.length === 0) tabsEl.append(emptyRow('No tabs yet. Type an address above and press Open tab.'))
  else for (const tab of lastSession.tabs) tabsEl.append(tabRow(tab))

  linksEl.replaceChildren()
  if (lastSession.links.length === 0) linksEl.append(emptyRow('No quick links yet. Save one with the Save quick link command.'))
  else for (const link of lastSession.links) linksEl.append(linkRow(link))
}

async function refreshSession() {
  const result = await bridge.invoke({ action: 'session' })
  if (result.ok) {
    lastSession = chromeSession(result.value)
    render()
  } else {
    setStatus(result.error?.message ?? 'The session could not load.', true)
  }
}

openEl.addEventListener('click', async () => {
  const address = addressEl.value
  if (!address.trim()) {
    setStatus('Type an http(s) address first.', true)
    return
  }
  busy = true
  openEl.disabled = true
  setStatus(`Opening ${address.trim()}…`)
  const result = await bridge.invoke({ action: 'open', url: address })
  busy = false
  openEl.disabled = false
  if (result.ok) {
    lastSession = chromeSession(result.value?.session)
    addressEl.value = ''
    setStatus('Opened in the ND browser — the chrome hides itself while you browse.')
  } else {
    setStatus(result.error?.message ?? 'That address could not open.', true)
  }
  render()
})

addressEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    openEl.click()
  }
})

// The frame must queue work until the host's hello handshake lands; an
// initial fetch always races the handshake.
bridge.whenConnected(() => {
  void refreshSession()
})
