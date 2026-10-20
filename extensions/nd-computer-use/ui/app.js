/**
 * ND Computer Use — package-shipped web view.
 *
 * Runs inside ND's sandboxed iframe with no Node and no network. Every read
 * goes through the nd.webview/1 bridge to the declared view actions; this
 * script only renders the bounded result and holds no native authority.
 */
import {
  describeState,
  parseSelection,
  safeScreenshotUrl,
  selectionValue,
  treeText,
  windowLabel,
} from './core.js'

function createBridge() {
  let hello = null
  let retry = null
  let attempts = 0
  let slow = false
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
      const entry = pending.get(data.requestId)
      if (!entry) return
      pending.delete(data.requestId)
      clearTimeout(entry.timer)
      entry.resolve(data)
    }
  })

  const announce = () => window.parent.postMessage({ kind: 'nd-webview:ready' }, '*')
  const start = () => {
    if (retry) return
    announce()
    retry = setInterval(() => {
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
  }

  return {
    start,
    whenConnected(fn) {
      if (hello) fn()
      else connectQueue.push(fn)
    },
    invoke(input, timeoutMs = 15_000) {
      if (!hello) {
        return Promise.resolve({ ok: false, error: { message: 'Not connected to ND' } })
      }
      const requestId = crypto.randomUUID()
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.has(requestId)) return
          pending.delete(requestId)
          resolve({ ok: false, error: { message: 'ND did not answer in time' } })
        }, timeoutMs)
        pending.set(requestId, { resolve, timer })
        window.parent.postMessage({ kind: 'nd-webview:invoke', requestId, input }, '*')
      })
    },
  }
}

const bridge = createBridge()
const appSelect = document.getElementById('app-select')
const refreshButton = document.getElementById('refresh')
const readButton = document.getElementById('read')
const fullTree = document.getElementById('full-tree')
const copyButton = document.getElementById('copy')
const statusLine = document.getElementById('status')
const shot = document.getElementById('shot')
const shotEmpty = document.getElementById('shot-empty')
const tree = document.getElementById('tree')
const treeMeta = document.getElementById('tree-meta')

let busy = false
let lastTree = ''

function setStatus(message, isError = false) {
  statusLine.textContent = message
  statusLine.classList.toggle('error', isError)
}

function setBusy(value) {
  busy = value
  refreshButton.disabled = value
  readButton.disabled = value || !appSelect.value
}

function renderApps(state) {
  const previous = appSelect.value
  appSelect.replaceChildren()
  const apps = Array.isArray(state?.apps) ? state.apps : []
  let count = 0

  for (const app of apps) {
    const windows = Array.isArray(app.windows) ? app.windows : []
    if (windows.length === 0) continue
    const group = document.createElement('optgroup')
    group.label = app.displayName || app.id
    windows.forEach((window, index) => {
      const option = document.createElement('option')
      option.value = selectionValue(app.id, window.id)
      option.textContent = `${app.displayName || app.id} — ${windowLabel(window, index)}`
      group.append(option)
      count += 1
    })
    appSelect.append(group)
  }

  if (count === 0) {
    const option = document.createElement('option')
    option.value = ''
    option.textContent = 'No running apps with windows'
    appSelect.append(option)
    readButton.disabled = true
    setStatus('No targetable windows were found. Open an app and refresh.')
    return
  }

  if (previous && [...appSelect.options].some((option) => option.value === previous)) {
    appSelect.value = previous
  } else {
    appSelect.selectedIndex = 0
  }
  readButton.disabled = false
  setStatus(`${count} window${count === 1 ? '' : 's'} across ${apps.length} app${apps.length === 1 ? '' : 's'}${state?.truncated ? ' (truncated)' : ''}.`)
}

async function refreshApps() {
  if (busy) return
  setBusy(true)
  setStatus('Listing running apps…')
  try {
    const result = await bridge.invoke({ action: 'apps' }, 15_000)
    if (!result.ok) throw new Error(result.error?.message || 'Could not list running apps')
    renderApps(result.value)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not list running apps', true)
  } finally {
    setBusy(false)
  }
}

function clearState(message) {
  lastTree = ''
  tree.textContent = message
  treeMeta.textContent = ''
  copyButton.disabled = true
  shot.classList.add('hidden')
  shot.removeAttribute('src')
  shotEmpty.classList.remove('hidden')
  shotEmpty.textContent = 'Read a window to capture its current state.'
}

function renderState(state) {
  lastTree = treeText(state)
  tree.textContent = lastTree
  treeMeta.textContent = state?.stats ? `${state.stats.nodes} nodes` : ''
  copyButton.disabled = lastTree.length === 0
  setStatus(describeState(state))

  const url = safeScreenshotUrl(state)
  if (url) {
    shot.src = url
    shot.classList.remove('hidden')
    shotEmpty.classList.add('hidden')
  } else {
    shot.classList.add('hidden')
    shot.removeAttribute('src')
    shotEmpty.classList.remove('hidden')
    shotEmpty.textContent = state?.screenshotUnavailable
      ? `Screenshot unavailable: ${state.screenshotUnavailable}.`
      : 'No screenshot was captured for this window.'
  }
}

async function readState() {
  const selection = parseSelection(appSelect.value)
  if (!selection || busy) return
  setBusy(true)
  setStatus('Reading window state…')
  try {
    const result = await bridge.invoke({
      action: 'state',
      app: selection.app,
      windowId: selection.windowId,
      includeScreenshot: true,
      includeText: true,
      disableDiff: fullTree.checked,
    }, 25_000)
    if (!result.ok) throw new Error(result.error?.message || 'Could not read this window')
    renderState(result.value)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not read this window', true)
  } finally {
    setBusy(false)
  }
}

async function copyTree() {
  if (!lastTree) return
  try {
    await navigator.clipboard.writeText(lastTree)
    setStatus('Accessibility tree copied.')
  } catch {
    const area = document.createElement('textarea')
    area.value = lastTree
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    setStatus(copied ? 'Accessibility tree copied.' : 'Could not copy the tree.', !copied)
  }
}

shot.addEventListener('error', () => {
  shot.classList.add('hidden')
  shotEmpty.classList.remove('hidden')
  shotEmpty.textContent = 'The screenshot could not be displayed.'
})

refreshButton.addEventListener('click', () => { void refreshApps() })
readButton.addEventListener('click', () => { void readState() })
copyButton.addEventListener('click', () => { void copyTree() })
appSelect.addEventListener('change', () => {
  readButton.disabled = busy || !appSelect.value
  clearState('Read the selected window to capture its current state.')
})

bridge.start()
bridge.whenConnected(() => {
  setStatus('Ready. Choose a window and read its state.')
  void refreshApps()
})
