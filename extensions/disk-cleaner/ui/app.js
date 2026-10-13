/**
 * ND Disk Cleaner — package-shipped web view UI.
 *
 * Runs inside ND's sandboxed iframe: opaque origin, no Node, no network. Every
 * privileged operation goes through the nd.webview/1 bridge (postMessage →
 * parent → broker → host methods), so this script holds no authority of its
 * own. The sunburst is plain canvas 2D drawn only on state changes — there is
 * no animation loop to leave running while the view is idle or hidden.
 */
import {
  absolutePath,
  childRows,
  formatBytes,
  hitTestArc,
  isActionable,
  layoutArcs,
  nodeAtPath,
  otherCount,
  removeNodeAt,
} from './sunburst.js'

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

  // `ready` means "the UI can accept input": the host unhides the frame on
  // this message, and a click that lands while this script is still setting
  // up is silently swallowed. Call `start()` only after every control is
  // bound. It announces until the host answers — a fast burst first, then a
  // slow retry forever, so a host that mounts late still connects instead of
  // leaving the dialog stuck on its loading state.
  let attempts = 0
  let slow = false
  let retry = null
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
        }, 10_000)
      })
    },
  }
}

const bridge = createBridge()

// --- DOM ---------------------------------------------------------------------

const els = {
  volume: document.getElementById('volume'),
  path: document.getElementById('path'),
  scan: document.getElementById('scan'),
  cancel: document.getElementById('cancel'),
  progressFill: document.getElementById('progress-fill'),
  progressText: document.getElementById('progress-text'),
  breadcrumb: document.getElementById('breadcrumb'),
  canvas: document.getElementById('sunburst'),
  rows: document.getElementById('rows'),
  status: document.getElementById('status'),
  toasts: document.getElementById('toasts'),
}

const state = {
  volumes: [],
  root: '',
  result: null,
  focusNames: [],
  selected: null,
  scanId: null,
  scanning: false,
  hover: null,
}

// --- canvas sunburst (draws on state changes only) ----------------------------

const PALETTE = {
  dir: ['#0ea5e9', '#38bdf8'],
  file: ['#06b6d4', '#22d3ee'],
  other: ['#475569', '#64748b'],
  ring2Dir: ['#0284c7', '#0ea5e9'],
  ring2File: ['#0e7490', '#06b6d4'],
  hover: '#fbbf24',
  text: '#e7e9ee',
  faint: '#9aa3b2',
}

function colorFor(segment, hovered) {
  if (hovered) return PALETTE.hover
  const kind = segment.node.k === 2 ? 'other' : segment.node.k === 1 ? 'file' : 'dir'
  if (segment.depth === 0) return PALETTE[kind]
  return kind === 'dir' ? PALETTE.ring2Dir : kind === 'file' ? PALETTE.ring2File : PALETTE.other
}

function drawSunburst() {
  const canvas = els.canvas
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (!width || !height) return
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const cx = width / 2
  const cy = height / 2
  const outer = Math.min(width, height) / 2 - 8
  const inner = outer * 0.32
  const ringWidth = (outer - inner) / 2

  const focus = focusNode()
  if (!focus) return
  const segments = layoutArcs(focus, state.focusNames)
  for (const segment of segments) {
    const hovered = sameNames(segment.names, state.hover)
    const radius = inner + segment.depth * ringWidth
    const color = colorFor(segment, hovered)
    ctx.beginPath()
    ctx.arc(cx, cy, radius + ringWidth - 1, segment.startAngle, segment.endAngle)
    ctx.arc(cx, cy, radius + 1, segment.endAngle, segment.startAngle, true)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.globalAlpha = hovered ? 1 : segment.depth === 0 ? 0.9 : 0.65
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.strokeStyle = '#131519'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  // Center: the focus label and its exact delivered total.
  ctx.beginPath()
  ctx.arc(cx, cy, inner, 0, Math.PI * 2)
  ctx.fillStyle = '#1b1e25'
  ctx.fill()
  ctx.fillStyle = PALETTE.text
  ctx.font = '600 13px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const name = state.focusNames.length > 0 ? state.focusNames[state.focusNames.length - 1] : focus.n
  ctx.fillText(truncateLabel(name, 18), cx, cy - 10)
  ctx.fillStyle = PALETTE.faint
  ctx.font = '12px system-ui, sans-serif'
  ctx.fillText(formatBytes(focus.s), cx, cy + 10)
}

function truncateLabel(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function sameNames(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((name, index) => name === right[index])
}

function angleFromPointer(event) {
  const rect = els.canvas.getBoundingClientRect()
  const x = event.clientX - rect.left - rect.width / 2
  const y = event.clientY - rect.top - rect.height / 2
  return Math.atan2(y, x)
}

function depthFromPointer(event) {
  const rect = els.canvas.getBoundingClientRect()
  const x = event.clientX - rect.left - rect.width / 2
  const y = event.clientY - rect.top - rect.height / 2
  const distance = Math.sqrt(x * x + y * y)
  const outer = Math.min(rect.width, rect.height) / 2 - 8
  const inner = outer * 0.32
  const ringWidth = (outer - inner) / 2
  if (distance < inner || distance > outer) return -1
  return distance < inner + ringWidth ? 0 : 1
}

// --- tree helpers -------------------------------------------------------------

function focusNode() {
  return state.result ? nodeAtPath(state.result.tree, state.focusNames) : null
}

function nodeNameOf(names) {
  return names.length > 0 ? names[names.length - 1] : ''
}

function showToast(text, kind = 'info', ttl = 2400) {
  const node = document.createElement('div')
  node.className = kind === 'info' ? 'toast' : `toast ${kind}`
  node.textContent = text
  els.toasts.appendChild(node)
  while (els.toasts.children.length > 3) els.toasts.firstChild.remove()
  setTimeout(() => {
    node.classList.add('leaving')
    setTimeout(() => node.remove(), 260)
  }, ttl)
}

function setStatus(text) {
  els.status.textContent = text
}

// --- rendering ----------------------------------------------------------------

function renderBreadcrumb() {
  els.breadcrumb.textContent = ''
  const rootLabel = document.createElement('button')
  rootLabel.type = 'button'
  rootLabel.className = 'crumb'
  rootLabel.textContent = state.result ? state.result.name : '…'
  rootLabel.addEventListener('click', () => setFocus([]))
  els.breadcrumb.appendChild(rootLabel)
  state.focusNames.forEach((name, index) => {
    const separator = document.createElement('span')
    separator.className = 'crumb-sep'
    separator.textContent = '/'
    els.breadcrumb.appendChild(separator)
    const crumb = document.createElement('button')
    crumb.type = 'button'
    crumb.className = 'crumb'
    crumb.textContent = name
    crumb.addEventListener('click', () => setFocus(state.focusNames.slice(0, index + 1)))
    els.breadcrumb.appendChild(crumb)
  })
}

function renderRows() {
  els.rows.textContent = ''
  const focus = focusNode()
  if (!focus) return
  const total = Math.max(1, focus.s)
  for (const row of childRows(focus, state.result.root, state.focusNames)) {
    const item = document.createElement('div')
    item.className = 'row'
    item.dataset.name = row.name
    item.dataset.kind = row.kind

    const label = document.createElement('span')
    label.className = `row-name ${row.kind}`
    label.textContent = row.kind === 'other' ? `${row.name} · ${row.count} items` : row.name
    item.appendChild(label)

    const bar = document.createElement('div')
    bar.className = 'row-bar'
    const fill = document.createElement('div')
    fill.className = 'row-bar-fill'
    fill.style.width = `${Math.min(100, Math.round((row.size / total) * 100))}%`
    bar.appendChild(fill)
    item.appendChild(bar)

    const size = document.createElement('span')
    size.className = 'row-size'
    size.textContent = formatBytes(row.size)
    item.appendChild(size)

    if (row.kind !== 'other') {
      const reveal = document.createElement('button')
      reveal.type = 'button'
      reveal.className = 'row-action reveal'
      reveal.textContent = 'Reveal'
      reveal.addEventListener('click', (event) => {
        event.stopPropagation()
        void revealPath(row.path)
      })
      item.appendChild(reveal)

      const trash = document.createElement('button')
      trash.type = 'button'
      trash.className = 'row-action trash'
      trash.textContent = 'Trash'
      trash.addEventListener('click', (event) => {
        event.stopPropagation()
        void trashPath(row.path)
      })
      item.appendChild(trash)
    }

    item.addEventListener('click', () => {
      if (row.kind === 'dir') setFocus([...state.focusNames, row.name])
      else if (row.kind === 'other') showToast(`${row.name} holds ${row.count} entries that did not fit the chart — scan a narrower folder to see them`, 'info', 3200)
      else showToast(`${row.name} · ${formatBytes(row.size)}`)
    })
    els.rows.appendChild(item)
  }
}

function renderAll() {
  renderBreadcrumb()
  renderRows()
  drawSunburst()
}

function setFocus(names) {
  const focus = state.result ? nodeAtPath(state.result.tree, names) : null
  if (!focus) return
  state.focusNames = names
  state.hover = null
  renderAll()
  setStatus(nodeNameOf(names) ? `Inside ${nodeNameOf(names)}` : 'Ready')
}

// --- scan flow ----------------------------------------------------------------

function setScanning(scanning, scanId = null) {
  state.scanning = scanning
  state.scanId = scanId
  // Scan is live only with a connected bridge: clicking it earlier would ask
  // ND for work the frame cannot even request yet.
  els.scan.disabled = scanning || !bridge.connected
  els.cancel.disabled = !scanning
  if (!scanning) {
    els.progressFill.style.width = '0%'
  }
}

async function startScan() {
  const root = els.path.value.trim()
  if (!root) {
    setStatus('Choose a folder or volume to scan first')
    return
  }
  const result = await bridge.invoke({ action: 'scan-start', root })
  if (!result.ok) {
    setStatus(result.error?.message ?? 'The scan could not start')
    showToast(result.error?.message ?? 'The scan could not start', 'error')
    return
  }
  const job = result.value
  setScanning(true, job.scanId)
  setStatus(`Scanning ${root}…`)
  els.progressText.textContent = 'Starting…'
  pollScan()
}

async function pollScan() {
  if (!state.scanId || document.hidden) return
  const result = await bridge.invoke({ action: 'scan-status', scanId: state.scanId })
  if (!result.ok) {
    setScanning(false)
    setStatus(result.error?.message ?? 'The scan status is unavailable')
    return
  }
  const job = result.value
  if (job.state === 'running') {
    els.progressText.textContent = `${job.entries.toLocaleString()} entries · ${formatBytes(job.bytes)}`
    // Awaiting a full-size tree is the long part; the bar breathes on entries.
    els.progressFill.style.width = '100%'
    els.progressFill.classList.add('busy')
    setTimeout(() => { void pollScan() }, 600)
    return
  }
  els.progressFill.classList.remove('busy')
  setScanning(false)
  if (job.state === 'done' && job.result) {
    state.result = job.result
    setFocus([])
    const summary = `${job.result.name}: ${formatBytes(job.result.bytes)} in ${job.result.fileCount.toLocaleString()} files`
    setStatus(summary)
    els.progressText.textContent = summary
    showToast(summary, 'ok')
    return
  }
  els.progressText.textContent = ''
  if (job.state === 'canceled') {
    setStatus('Scan canceled')
    showToast('Scan canceled')
  } else {
    setStatus(job.error ?? 'The scan failed')
    showToast(job.error ?? 'The scan failed', 'error')
  }
}

async function cancelScan() {
  if (!state.scanId) return
  const result = await bridge.invoke({ action: 'scan-cancel', scanId: state.scanId })
  if (result.ok && result.value?.canceled) setStatus('Stopping the scan…')
}

// --- actions ------------------------------------------------------------------

async function revealPath(path) {
  if (!path) return
  const result = await bridge.invoke({ action: 'reveal', path })
  if (!result.ok) showToast(result.error?.message ?? 'Could not reveal that item', 'error')
}

async function trashPath(path) {
  if (!path) return
  const result = await bridge.invoke({ action: 'trash', path })
  if (!result.ok) {
    showToast(result.error?.message ?? 'Could not move that item to the trash', 'error')
    return
  }
  if (!result.value?.trashed) return
  const names = namesForPath(path)
  if (names && state.result) {
    removeNodeAt(state.result.tree, names)
    // If the removed item contained the current focus, step back out of it.
    if (names.length <= state.focusNames.length && sameNames(names, state.focusNames.slice(0, names.length))) {
      state.focusNames = names.slice(0, -1)
    }
    renderAll()
  }
  showToast('Moved to the trash', 'ok')
  setStatus(`Moved ${nodeNameOf(names ?? [])} to the trash`)
}

function namesForPath(path) {
  if (!state.result) return null
  const prefix = state.result.root.replace(/[/\\]+$/, '')
  if (!path.startsWith(`${prefix}/`)) return null
  return path.slice(prefix.length + 1).split('/')
}

// --- controls -----------------------------------------------------------------

els.scan.addEventListener('click', () => { void startScan() })
els.cancel.addEventListener('click', () => { void cancelScan() })
els.path.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void startScan()
})
els.volume.addEventListener('change', () => {
  const selected = state.volumes.find((volume) => volume.path === els.volume.value)
  if (selected) els.path.value = selected.path
})

els.canvas.addEventListener('click', (event) => {
  const focus = focusNode()
  if (!focus) return
  const depth = depthFromPointer(event)
  if (depth < 0) return
  const segment = hitTestArc(layoutArcs(focus, state.focusNames), angleFromPointer(event), depth)
  if (!segment) return
  if (segment.node.k === 2) {
    showToast(`${segment.node.n} holds ${otherCount(segment.node)} entries that did not fit the chart`, 'info', 3200)
    return
  }
  if (!isActionable(segment.node)) return
  if (segment.node.k === 0) setFocus(segment.names)
  else {
    state.hover = segment.names
    drawSunburst()
    showToast(`${segment.node.n} · ${formatBytes(segment.node.s)}`)
  }
})

els.canvas.addEventListener('mousemove', (event) => {
  const focus = focusNode()
  if (!focus) return
  const depth = depthFromPointer(event)
  const segment = depth < 0 ? null : hitTestArc(layoutArcs(focus, state.focusNames), angleFromPointer(event), depth)
  const names = segment ? segment.names : null
  if (sameNames(names, state.hover)) return
  state.hover = names
  drawSunburst()
})

els.canvas.addEventListener('mouseleave', () => {
  if (state.hover) {
    state.hover = null
    drawSunburst()
  }
})

// Esc cancels a running scan, then steps out of the focused folder.
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (state.scanning) {
    void cancelScan()
    return
  }
  if (state.focusNames.length > 0) setFocus(state.focusNames.slice(0, -1))
})

// Resize repaints the canvas at its new size; there is no idle redraw loop.
new ResizeObserver(() => drawSunburst()).observe(els.canvas)

// --- start -------------------------------------------------------------------

async function refreshVolumes() {
  const result = await bridge.invoke({ action: 'volumes' })
  if (!result.ok) return
  state.volumes = Array.isArray(result.value?.volumes) ? result.value.volumes : []
  els.volume.textContent = ''
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = 'Choose a volume…'
  els.volume.appendChild(placeholder)
  for (const volume of state.volumes) {
    const option = document.createElement('option')
    option.value = volume.path
    option.textContent = `${volume.name} — ${formatBytes(volume.available)} free of ${formatBytes(volume.bytes)}`
    els.volume.appendChild(option)
  }
  if (!els.path.value && state.volumes.length > 0) {
    const first = state.volumes[0]
    els.volume.value = first.path
    els.path.value = first.path
  }
}

setScanning(false)
setStatus('Choose a folder or volume to scan')
document.body.dataset.bridge = 'waiting'
// The handshake lands asynchronously; only fetch volumes once the bridge is
// actually connected, or the first read would always miss.
bridge.whenConnected(() => {
  document.body.dataset.bridge = 'connected'
  setScanning(false)
  void refreshVolumes()
})
// Ready only now: every control above is bound before the host unhides the frame.
bridge.start()
