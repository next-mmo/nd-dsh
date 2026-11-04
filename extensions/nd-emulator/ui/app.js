/**
 * ND Emulator — package-shipped web view controller.
 *
 * Runs inside ND's sandboxed iframe with no Node and no network.
 * Every operation flows through the nd.webview/1 bridge to declared view actions.
 */
import {
  formatDeviceInfo,
  formatTimestamp,
  parseDeviceList,
  EMULATOR_PROVIDERS,
  filterProviders,
  detectProvider,
} from './emulator-core.js'

/* ── Bridge Implementation ── */
function createBridge() {
  let hello = null
  let retry = null
  let attempts = 0
  let slow = false
  const pending = new Map()
  const connectQueue = []

  const applyTheme = (theme) => {
    const effective = theme === 'light' ? 'light' : 'dark'
    document.documentElement.dataset.theme = effective
    const meta = document.querySelector('meta[name="color-scheme"]')
    if (meta) meta.setAttribute('content', effective)
  }

  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || typeof data !== 'object') return

    // ── Mirror capture frames from parent renderer ──
    if (data.kind === 'nd-webview:mirror-frame' && data.bitmap instanceof ImageBitmap) {
      if (!mirrorCanvas || !mirrorCtx || activeMode !== 'embedded' || mirrorFallback) return
      const cw = mirrorCanvas.width
      const ch = mirrorCanvas.height
      if (cw !== data.width || ch !== data.height) {
        mirrorCanvas.width = data.width
        mirrorCanvas.height = data.height
      }
      mirrorCtx.drawImage(data.bitmap, 0, 0)
      data.bitmap.close()
      return
    }
    if (data.kind === 'nd-webview:mirror-error') {
      if (activeMode === 'embedded' && !mirrorFallback) {
        mirrorFallback = true
        fallbackToMjpeg()
      }
      console.warn('Mirror capture error:', data.error)
      return
    }

    if (data.kind === 'nd-webview:hello' && data.protocol === 'nd.webview/1') {
      if (data.theme) applyTheme(data.theme)
      hello = data
      while (connectQueue.length > 0) {
        const fn = connectQueue.shift()
        if (fn) fn()
      }
      return
    }
    if (data.kind === 'nd-webview:theme' && data.protocol === 'nd.webview/1') {
      if (data.theme) applyTheme(data.theme)
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
        const slowInterval = setInterval(() => {
          if (!hello) announce()
          else clearInterval(slowInterval)
        }, 2000)
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
    invoke(input, timeoutMs = 25000) {
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

/* ── DOM Elements ── */
const statusText = document.getElementById('status-text')
const statusBar = document.getElementById('status-bar')
const deviceCount = document.getElementById('device-count')
const tabBadgeDevices = document.getElementById('tab-badge-devices')
const deviceGrid = document.getElementById('device-grid')
const mirrorDevice = document.getElementById('mirror-device')
const shellDevice = document.getElementById('shell-device')
const termOutput = document.getElementById('term-output')
const termInput = document.getElementById('term-input')
const activityLog = document.getElementById('activity-log')
const mirrorImg = document.getElementById('mirror-img')
const mirrorStream = document.getElementById('mirror-stream')
const mirrorCanvas = document.getElementById('mirror-canvas')
const mirrorCtx = mirrorCanvas?.getContext('2d') ?? null
const mirrorModeEl = document.getElementById('mirror-mode')
const mirrorPlaceholder = document.getElementById('mirror-placeholder')
const mirrorStats = document.getElementById('mirror-stats')
const btnMirrorStart = document.getElementById('btn-mirror-start')
const btnMirrorStop = document.getElementById('btn-mirror-stop')
const btnMirrorSnap = document.getElementById('btn-mirror-snap')
const adbStatusPill = document.getElementById('adb-status-pill')
const adbStatusText = document.getElementById('adb-status-text')
const wirelessBar = document.getElementById('wireless-bar')
const providerGrid = document.getElementById('provider-grid')
const hubSearchInput = document.getElementById('hub-search')
const toastContainer = document.getElementById('toast-container')

let busy = false
let devices = []
let activeMirror = null
let activeMode = null
let mirrorMode = 'embedded'
let snapshotTimer = null
let tapStart = null
let mirrorFallback = false
let currentCategory = 'all'
let currentSearch = ''
let commandHistory = []
let historyIndex = -1

/* ── Toast Notifications ── */
function showToast(message, duration = 3000) {
  if (!toastContainer) return
  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.textContent = message
  toastContainer.appendChild(toast)
  setTimeout(() => {
    toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease'
    toast.style.opacity = '0'
    toast.style.transform = 'translateY(10px)'
    setTimeout(() => toast.remove(), 200)
  }, duration)
}

/* ── Copy Helper ── */
async function copyToClipboard(text, label = 'Command') {
  try {
    await navigator.clipboard.writeText(text)
    showToast(`✓ Copied ${label} to clipboard!`)
    return true
  } catch {
    const el = document.createElement('textarea')
    el.value = text
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    el.remove()
    if (ok) showToast(`✓ Copied ${label} to clipboard!`)
    return ok
  }
}

/* ── External Link Opener ── */
async function openExternalUrl(url) {
  if (!url) return
  addLog(`Opening link: ${url}`, 'info')
  try {
    const res = await bridge.invoke({ action: 'open-external', url }, 8000)
    if (!res.ok) {
      window.open(url, '_blank')
    }
  } catch {
    window.open(url, '_blank')
  }
}

/* ── Status & Log Helpers ── */
function setStatus(message, isError = false) {
  if (statusText) statusText.textContent = message
  if (statusBar) statusBar.classList.toggle('error', isError)
}

function setBusy(value) {
  busy = value
  document.querySelectorAll('button:not(.tab-btn):not(.filter-chip)').forEach((btn) => {
    if (!btn.dataset.alwaysEnabled) btn.disabled = value
  })
  syncModeButtons()
  syncMirrorButtons()
}

function syncModeButtons() {
  if (!mirrorModeEl) return
  mirrorModeEl.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.disabled = busy || Boolean(activeMirror)
    btn.classList.toggle('active', btn.dataset.mode === mirrorMode)
  })
}

function syncMirrorButtons() {
  if (btnMirrorStart) btnMirrorStart.disabled = busy || Boolean(activeMirror) || !mirrorDevice?.value
  if (btnMirrorStop) btnMirrorStop.disabled = busy || !activeMirror
}

function addLog(message, level = 'info') {
  if (!activityLog) return
  const entry = document.createElement('div')
  entry.className = 'log-entry'
  const badgeCls = level === 'error' ? 'badge-danger' : level === 'success' ? 'badge-success' : 'badge-accent'
  entry.innerHTML = `<span class="log-time">${formatTimestamp()}</span><span class="badge ${badgeCls}">${level.toUpperCase()}</span><span>${message}</span>`
  const header = activityLog.querySelector('.log-header')
  if (header) header.after(entry)
  else activityLog.prepend(entry)
  while (activityLog.children.length > 51) activityLog.lastChild?.remove()
}

/* ── Tab Switching ── */
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId))
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tabId}`))
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
})

document.getElementById('btn-nav-emulators')?.addEventListener('click', () => switchTab('emulators'))

/* ── Render Devices ── */
function renderDevices(deviceList, adbAvailable = true) {
  devices = deviceList
  const count = deviceList.length
  if (deviceCount) deviceCount.textContent = `${count} device${count !== 1 ? 's' : ''}`
  if (tabBadgeDevices) tabBadgeDevices.textContent = String(count)

  // Update ADB status pill
  if (adbStatusPill && adbStatusText) {
    if (adbAvailable) {
      adbStatusPill.className = 'indicator-pill ready'
      adbStatusText.textContent = 'ADB Ready'
    } else {
      adbStatusPill.className = 'indicator-pill warn'
      adbStatusText.textContent = 'ADB Not Installed'
    }
  }

  for (const sel of [mirrorDevice, shellDevice]) {
    if (!sel) continue
    const prev = sel.value
    sel.replaceChildren()
    const defaultOpt = document.createElement('option')
    defaultOpt.value = ''
    defaultOpt.textContent = 'Select a device…'
    sel.append(defaultOpt)
    for (const d of deviceList) {
      const opt = document.createElement('option')
      opt.value = d.serial
      const providerId = detectProvider(d.serial)
      const providerName = providerId ? ` [${providerId.toUpperCase()}]` : ''
      opt.textContent = `${d.model || d.serial} (${d.type})${providerName}`
      sel.append(opt)
    }
    if (prev && deviceList.some((d) => d.serial === prev)) {
      sel.value = prev
    } else if (deviceList.length > 0) {
      sel.value = deviceList[0].serial
    }
  }

  syncMirrorButtons()

  if (!deviceGrid) return
  if (count === 0) {
    deviceGrid.innerHTML = `
      <div class="empty-hero" style="grid-column: 1 / -1;">
        <div class="hero-icon">📱</div>
        <h3>No Android Devices Connected</h3>
        <p>Connect a physical phone via USB with USB Debugging enabled, connect to wireless ADB, or launch a desktop Android emulator below.</p>

        <div class="quick-connect-section">
          <div class="quick-connect-title">⚡ Quick Connect Running Emulators:</div>
          <div class="quick-connect-pills">
            <button class="qc-pill" data-connect="127.0.0.1:5555"><span>⚡</span> LDPlayer / BlueStacks (5555)</button>
            <button class="qc-pill" data-connect="127.0.0.1:16384"><span>🐮</span> MuMu Player (16384)</button>
            <button class="qc-pill" data-connect="127.0.0.1:62001"><span>🔮</span> NoxPlayer (62001)</button>
            <button class="qc-pill" data-connect="127.0.0.1:58526"><span>🪟</span> WSA Windows Subsystem (58526)</button>
          </div>
        </div>

        <div style="margin-top: 18px; display: flex; gap: 8px; flex-wrap: wrap; justify-content: center;">
          <button id="btn-scan-empty" class="primary">🔍 Scan for devices</button>
          <button id="btn-open-hub-empty" class="outline">📦 Download Emulators &amp; Tools →</button>
        </div>
      </div>`

    document.getElementById('btn-scan-empty')?.addEventListener('click', () => void scanDevices())
    document.getElementById('btn-open-hub-empty')?.addEventListener('click', () => switchTab('emulators'))
    deviceGrid.querySelectorAll('[data-connect]').forEach((btn) => {
      btn.addEventListener('click', () => void connectToEmulator(btn.dataset.connect))
    })
    return
  }

  deviceGrid.innerHTML = ''
  for (const device of deviceList) {
    const info = formatDeviceInfo(device)
    const isConn = device.type === 'device'
    const statusClass = isConn ? 'badge-success' : device.type === 'offline' ? 'badge-danger' : 'badge-warning'
    const statusLabel = isConn ? 'Connected' : device.type === 'offline' ? 'Offline' : device.type
    const providerId = detectProvider(device.serial)
    const isEmulator = Boolean(providerId) || device.serial.startsWith('emulator-') || device.serial.includes(':')

    let icon = '📱'
    let providerLabel = isEmulator ? 'Android Emulator' : 'Hardware Phone'
    if (providerId === 'ldplayer') { icon = '⚡'; providerLabel = 'LDPlayer' }
    else if (providerId === 'bluestacks') { icon = '🔷'; providerLabel = 'BlueStacks' }
    else if (providerId === 'mumu') { icon = '🐮'; providerLabel = 'MuMu Player' }
    else if (providerId === 'nox') { icon = '🔮'; providerLabel = 'NoxPlayer' }
    else if (providerId === 'wsa') { icon = '🪟'; providerLabel = 'Windows Subsystem' }
    else if (providerId === 'android-studio') { icon = '🤖'; providerLabel = 'Google AVD' }

    const card = document.createElement('article')
    card.className = 'device-card'
    card.innerHTML = `
      <div class="device-header">
        <div class="device-icon">${icon}</div>
        <div style="flex:1;min-width:0">
          <div class="device-name">${device.model || device.serial}</div>
          <div class="device-sub">${providerLabel} · ${device.serial}</div>
        </div>
        <span class="badge ${statusClass}">${statusLabel}</span>
      </div>
      <div class="device-tags">
        <span class="device-tag">${device.serial.includes(':') ? 'Wireless TCP/IP' : 'Direct USB'}</span>
        ${device.product ? `<span class="device-tag">${device.product}</span>` : ''}
        ${device.transportId ? `<span class="device-tag">Transport #${device.transportId}</span>` : ''}
      </div>
      <div class="device-actions">
        <button class="small primary" data-serial="${device.serial}" data-cmd="mirror">🪞 Mirror Screen</button>
        <button class="small" data-serial="${device.serial}" data-cmd="screenshot">📷 Screenshot</button>
        <button class="small" data-serial="${device.serial}" data-cmd="shell">⚡ Shell</button>
        <button class="small outline" data-serial="${device.serial}" data-cmd="reboot">🔄 Reboot</button>
        ${device.serial.includes(':') ? `<button class="small danger" data-serial="${device.serial}" data-cmd="disconnect">❌ Disconnect</button>` : ''}
      </div>`
    deviceGrid.append(card)
  }

  deviceGrid.querySelectorAll('[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const serial = btn.dataset.serial
      const cmd = btn.dataset.cmd
      if (!serial) return
      if (cmd === 'mirror') {
        if (mirrorDevice) mirrorDevice.value = serial
        switchTab('mirror')
        void startMirror()
      } else if (cmd === 'shell') {
        if (shellDevice) shellDevice.value = serial
        switchTab('shell')
      } else if (cmd === 'screenshot') {
        void captureScreenshot(serial)
      } else if (cmd === 'reboot') {
        void execAdb(serial, 'reboot')
      } else if (cmd === 'disconnect') {
        void execAdb(serial, 'disconnect')
      }
    })
  })
}

/* ── Render Emulators & Tools Hub ── */
function renderProviders(category = 'all', query = '') {
  if (!providerGrid) return
  const filtered = filterProviders(category, query)

  if (filtered.length === 0) {
    providerGrid.innerHTML = `
      <div class="empty-hero" style="grid-column: 1 / -1; padding: 24px;">
        <div style="font-size: 32px; margin-bottom: 8px;">🔍</div>
        <h3>No matching emulators or tools found</h3>
        <p>Try searching with a different keyword or reset the category filter.</p>
        <button class="small outline" id="btn-reset-filters">Reset Filters</button>
      </div>`
    document.getElementById('btn-reset-filters')?.addEventListener('click', () => {
      currentCategory = 'all'
      currentSearch = ''
      if (hubSearchInput) hubSearchInput.value = ''
      document.querySelectorAll('.filter-chip').forEach((c) => c.classList.toggle('active', c.dataset.cat === 'all'))
      renderProviders('all', '')
    })
    return
  }

  providerGrid.innerHTML = ''
  for (const p of filtered) {
    const card = document.createElement('div')
    card.className = 'provider-card'
    card.innerHTML = `
      <div class="card-head">
        <div class="provider-icon">${p.icon}</div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
            <div class="provider-title">${p.name}</div>
            <span class="badge badge-accent">${p.badge}</span>
          </div>
          <div class="provider-meta" style="margin-top: 4px;">
            <span class="meta-item">📁 ${p.category.toUpperCase()}</span>
            ${p.defaultPort ? `<span class="meta-item">🔌 Port: <b>${p.defaultPort}</b></span>` : ''}
          </div>
        </div>
      </div>
      <div class="provider-desc">${p.description}</div>
      <div class="setup-tip"><b>💡 Setup:</b> ${p.setupGuide}</div>
      <div class="provider-actions">
        ${p.hostAddress ? `<button class="small primary" data-connect-hub="${p.hostAddress}">⚡ Connect Port (${p.defaultPort})</button>` : ''}
        <button class="small" data-url="${p.downloadUrl}">🌐 Download / Site</button>
        ${p.installCmd ? `<button class="small outline" data-copy="${p.installCmd}" title="Copy CLI install command">📋 Command</button>` : ''}
      </div>`
    providerGrid.appendChild(card)
  }

  providerGrid.querySelectorAll('[data-connect-hub]').forEach((btn) => {
    btn.addEventListener('click', () => void connectToEmulator(btn.dataset.connectHub))
  })
  providerGrid.querySelectorAll('[data-url]').forEach((btn) => {
    btn.addEventListener('click', () => void openExternalUrl(btn.dataset.url))
  })
  providerGrid.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => void copyToClipboard(btn.dataset.copy, 'CLI command'))
  })
}

/* ── Actions: Device Management ── */
async function scanDevices() {
  if (busy) return
  setBusy(true)
  setStatus('Scanning for devices via ADB…')
  const lastScanned = document.getElementById('last-scanned-text')
  try {
    const result = await bridge.invoke({ action: 'devices-list' }, 15000)
    if (!result.ok) throw new Error(result.error?.message || 'Could not list devices')
    const list = parseDeviceList(result.value)
    const adbAvailable = result.value && typeof result.value === 'object' && result.value.adbAvailable !== false
    renderDevices(list, adbAvailable)
    setStatus(`Found ${list.length} device${list.length !== 1 ? 's' : ''}.`)
    addLog(`Scanned ${list.length} device(s)`, 'success')
    if (lastScanned) lastScanned.textContent = `Scanned ${formatTimestamp()}`
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Could not scan devices'
    setStatus(msg, true)
    addLog(msg, 'error')
    renderDevices([], false)
  } finally {
    setBusy(false)
  }
}

async function connectToEmulator(address) {
  if (!address || busy) return
  setStatus(`Connecting to ${address}…`)
  addLog(`Connecting to ${address}…`, 'info')
  setBusy(true)
  try {
    const result = await bridge.invoke({ action: 'devices-connect', address }, 15000)
    if (!result.ok) throw new Error(result.error?.message || `Failed to connect to ${address}`)
    showToast(`✓ Connected to ${address}!`)
    setStatus(`Connected to ${address}`, false)
    addLog(`Connected to ${address}`, 'success')
    await scanDevices()
    switchTab('devices')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    showToast(`Connection error: ${msg}`)
    setStatus(msg, true)
    addLog(`Connect to ${address} failed: ${msg}`, 'error')
  } finally {
    setBusy(false)
  }
}

async function execAdb(serial, command) {
  if (busy) return null
  setBusy(true)
  setStatus(`Running: adb ${command}…`)
  try {
    const result = await bridge.invoke({ action: 'adb-exec', serial, command }, 30000)
    if (!result.ok) throw new Error(result.error?.message || 'ADB command failed')
    const value = result.value
    if (value && typeof value === 'object' && typeof value.exitCode === 'number' && value.exitCode !== 0) {
      const output = typeof value.output === 'string' && value.output
        ? value.output
        : `ADB command failed (exit ${value.exitCode})`
      throw new Error(output)
    }
    addLog(`adb ${command}`, 'success')
    setStatus('ADB command executed.')
    if (command === 'disconnect' || command === 'reboot') void scanDevices()
    return value
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ADB command failed'
    setStatus(msg, true)
    addLog(`adb ${command} failed: ${msg}`, 'error')
    return null
  } finally {
    setBusy(false)
  }
}

async function captureScreenshot(serial) {
  if (!serial) return
  setStatus('Capturing screenshot…')
  try {
    const result = await bridge.invoke({ action: 'screenshot', serial }, 20000)
    if (!result.ok) throw new Error(result.error?.message || 'Screenshot failed')
    showToast('✓ Screenshot captured!')
    addLog(`Screenshot captured for ${serial}`, 'success')
    setStatus('Screenshot captured successfully.')
    if (result.value && result.value.dataUrl && mirrorImg) {
      if (activeMode === 'embedded') {
        mirrorImg.src = result.value.dataUrl
        mirrorImg.classList.add('snapshot-overlay')
        mirrorImg.style.display = 'block'
        if (snapshotTimer) clearTimeout(snapshotTimer)
        snapshotTimer = setTimeout(() => {
          if (activeMode === 'embedded') {
            mirrorImg.classList.remove('snapshot-overlay')
            mirrorImg.style.display = 'none'
            mirrorImg.src = ''
          }
          snapshotTimer = null
        }, 2500)
      } else {
        mirrorImg.classList.remove('snapshot-overlay')
        mirrorImg.src = result.value.dataUrl
        mirrorImg.style.display = 'block'
        if (mirrorPlaceholder) mirrorPlaceholder.style.display = 'none'
      }
      switchTab('mirror')
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Screenshot failed'
    setStatus(msg, true)
    addLog(msg, 'error')
  }
}

/* ── Screen Mirror Controller ── */
async function startMirror() {
  const serial = mirrorDevice?.value
  if (!serial || busy) return
  setBusy(true)
  const mode = mirrorMode
  setStatus(`Starting ${mode === 'embedded' ? 'embedded mirror' : 'scrcpy window'} for ${serial}…`)
  try {
    const bitrate = parseInt(document.getElementById('set-bitrate')?.value || '8', 10)
    const maxFps = parseInt(document.getElementById('set-fps')?.value || '60', 10)
    const codec = document.getElementById('set-codec')?.value || 'h264'
    const audio = document.getElementById('set-audio')?.value === 'on'
    const maxResolution = parseInt(document.getElementById('set-resolution')?.value || '0', 10)
    const model = devices.find((device) => device.serial === serial)?.model || ''

    const result = await bridge.invoke({
      action: 'scrcpy-start',
      serial,
      bitrate,
      maxFps,
      codec,
      audio,
      maxResolution,
      mode,
      model,
    }, 30000)

    if (!result.ok) throw new Error(result.error?.message || 'Could not start mirror')
    const value = result.value || {}
    if (value.started === false) throw new Error(typeof value.error === 'string' ? value.error : 'Could not start mirror')
    const startedMode = value.mode === 'external' ? 'external' : 'embedded'
    if (startedMode === 'embedded' && typeof value.streamUrl !== 'string') {
      await bridge.invoke({ action: 'scrcpy-stop', serial }, 15000)
      throw new Error('Embedded mirror did not return a stream URL')
    }

    activeMirror = serial
    activeMode = startedMode
    mirrorFallback = false

    if (startedMode === 'embedded') {
      if (typeof value.windowSourceId === 'string' && mirrorCanvas) {
        mirrorCanvas.style.display = 'block'
        mirrorCanvas.width = value.device?.width || 1080
        mirrorCanvas.height = value.device?.height || 2340
        if (mirrorStream) { mirrorStream.style.display = 'none'; mirrorStream.src = '' }
        window.parent.postMessage({ kind: 'nd-webview:mirror-start', sourceId: value.windowSourceId }, '*')
        addLog(`Embedded mirror started (live capture): ${serial}`, 'success')
        setStatus(`Embedded mirror active: ${serial}`)
      } else {
        mirrorFallback = true
        if (mirrorStream) {
          mirrorStream.onload = () => { setStatus(`Embedded mirror active: ${serial}`) }
          mirrorStream.onerror = () => {
            setStatus('Embedded stream failed. Stop and retry.', true)
            addLog('Embedded mirror stream failed', 'error')
          }
          setStatus(`Connecting embedded mirror: ${serial}…`)
          mirrorStream.src = value.streamUrl
          mirrorStream.style.display = 'block'
        }
        if (mirrorCanvas) mirrorCanvas.style.display = 'none'
        addLog(`Embedded mirror started (MJPEG): ${serial}`, 'success')
      }
      if (mirrorPlaceholder) mirrorPlaceholder.style.display = 'none'
      if (mirrorImg) {
        mirrorImg.classList.remove('snapshot-overlay')
        mirrorImg.style.display = 'none'
        mirrorImg.src = ''
      }
    } else {
      if (mirrorStream) {
        mirrorStream.onload = null
        mirrorStream.onerror = null
        mirrorStream.src = ''
        mirrorStream.style.display = 'none'
      }
      if (mirrorCanvas) mirrorCanvas.style.display = 'none'
      if (mirrorImg) {
        mirrorImg.classList.remove('snapshot-overlay')
        mirrorImg.style.display = 'none'
        mirrorImg.src = ''
      }
      if (mirrorPlaceholder) mirrorPlaceholder.style.display = ''
      addLog(`scrcpy window started: ${serial}`, 'success')
      setStatus(`Mirroring active: ${serial}`)
    }
    if (btnMirrorStop) btnMirrorStop.disabled = false
    if (mirrorStats) mirrorStats.textContent = `${maxFps}fps · ${bitrate} Mbps · ${codec.toUpperCase()}`
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Mirror failed'
    setStatus(msg, true)
    addLog(msg, 'error')
  } finally {
    setBusy(false)
    syncModeButtons()
  }
}

async function stopMirror() {
  if (!activeMirror || busy) return
  const serial = activeMirror
  setBusy(true)
  try {
    const result = await bridge.invoke({ action: 'scrcpy-stop', serial }, 15000)
    if (!result.ok) throw new Error(result.error?.message || 'Could not stop mirror')
    if (result.value && result.value.stopped === false) {
      throw new Error('No active mirror process was found.')
    }
    addLog(`Mirror stopped: ${serial}`, 'info')
    setStatus('Mirror session ended.')
    if (activeMode === 'embedded' && !mirrorFallback) {
      window.parent.postMessage({ kind: 'nd-webview:mirror-stop' }, '*')
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Stop mirror failed'
    setStatus(msg, true)
    addLog(msg, 'error')
  } finally {
    activeMirror = null
    activeMode = null
    mirrorFallback = false
    if (snapshotTimer) {
      clearTimeout(snapshotTimer)
      snapshotTimer = null
    }
    if (mirrorStream) {
      mirrorStream.onload = null
      mirrorStream.onerror = null
      mirrorStream.src = ''
      mirrorStream.style.display = 'none'
    }
    if (mirrorCanvas) {
      mirrorCanvas.style.display = 'none'
      mirrorCtx?.clearRect(0, 0, mirrorCanvas.width, mirrorCanvas.height)
    }
    if (mirrorImg) {
      mirrorImg.classList.remove('snapshot-overlay')
      mirrorImg.style.display = 'none'
      mirrorImg.src = ''
    }
    if (mirrorPlaceholder) mirrorPlaceholder.style.display = ''
    if (mirrorStats) mirrorStats.textContent = ''
    setBusy(false)
    syncMirrorButtons()
    syncModeButtons()
  }
}

function fallbackToMjpeg() {
  const serial = activeMirror
  if (!serial) return
  void bridge.invoke({ action: 'mirror-resume', serial }).then((res) => {
    if (!res.ok || !res.value?.streamUrl) return
    if (mirrorCanvas) mirrorCanvas.style.display = 'none'
    if (mirrorStream) {
      mirrorStream.src = res.value.streamUrl
      mirrorStream.style.display = 'block'
    }
    addLog('Switched to fallback MJPEG mirror capture', 'info')
  })
}

/* ── Interactive Pointer / Tap Input ── */
function normalizedStreamPoint(event) {
  const surface = activeMode === 'embedded' && !mirrorFallback && mirrorCanvas?.style.display !== 'none'
    ? mirrorCanvas
    : mirrorStream
  if (!surface) return null
  const rect = surface.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const relX = event.clientX - rect.left
  const relY = event.clientY - rect.top
  if (relX < 0 || relX > rect.width || relY < 0 || relY > rect.height) return null
  return { x: relX / rect.width, y: relY / rect.height }
}

function addTapRipple(event) {
  const screen = document.getElementById('mirror-screen')
  if (!screen) return
  const rect = screen.getBoundingClientRect()
  const ripple = document.createElement('div')
  ripple.className = 'tap-ripple'
  ripple.style.left = `${event.clientX - rect.left}px`
  ripple.style.top = `${event.clientY - rect.top}px`
  screen.appendChild(ripple)
  setTimeout(() => ripple.remove(), 400)
}

function handleInputResult(res) {
  if (!res.ok && res.error) {
    addLog(`Touch error: ${res.error.message}`, 'error')
  }
}

function bindPointerInput(surface) {
  if (!surface) return
  surface.addEventListener('pointerdown', (event) => {
    if (activeMode !== 'embedded' || !activeMirror || busy) return
    const point = normalizedStreamPoint(event)
    if (!point) return
    event.preventDefault()
    tapStart = { x: point.x, y: point.y, at: Date.now(), pointerId: event.pointerId }
    surface.setPointerCapture(event.pointerId)
  })

  surface.addEventListener('pointerup', (event) => {
    if (!tapStart || activeMode !== 'embedded' || !activeMirror) return
    const start = tapStart
    tapStart = null
    const end = normalizedStreamPoint(event)
    if (!end) return
    event.preventDefault()
    const duration = Math.max(0, Date.now() - start.at)
    const distance = Math.hypot(end.x - start.x, end.y - start.y)
    if (distance < 0.015 && duration < 550) {
      addTapRipple(event)
      void bridge.invoke({ action: 'input-tap', serial: activeMirror, x: end.x, y: end.y }, 10000).then(handleInputResult)
    } else {
      void bridge.invoke({
        action: 'input-swipe',
        serial: activeMirror,
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        duration: Math.max(100, Math.min(1500, duration)),
      }, 10000).then(handleInputResult)
    }
  })

  surface.addEventListener('pointercancel', () => { tapStart = null })

  surface.addEventListener('wheel', (event) => {
    if (activeMode !== 'embedded' || !activeMirror || busy) return
    event.preventDefault()
    const direction = event.deltaY >= 0 ? 1 : -1
    const from = 0.55 - direction * 0.12
    const to = 0.55 + direction * 0.12
    void bridge.invoke({
      action: 'input-swipe',
      serial: activeMirror,
      x1: 0.5,
      y1: from,
      x2: 0.5,
      y2: to,
      duration: 180,
    }, 10000).then(handleInputResult)
  }, { passive: false })
}

bindPointerInput(mirrorStream)
bindPointerInput(mirrorCanvas)

/* ── Mirror Navigation Buttons ── */
const KEY_MAP = {
  back: 'shell input keyevent KEYCODE_BACK',
  home: 'shell input keyevent KEYCODE_HOME',
  recents: 'shell input keyevent KEYCODE_APP_SWITCH',
  volup: 'shell input keyevent KEYCODE_VOLUME_UP',
  voldown: 'shell input keyevent KEYCODE_VOLUME_DOWN',
  power: 'shell input keyevent KEYCODE_POWER',
}

document.querySelectorAll('#mirror-nav [data-key]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.key
    const serial = activeMirror || mirrorDevice?.value
    if (!serial) {
      setStatus('Select a device to send navigation input.', true)
      return
    }
    if (key === 'screenshot') {
      void captureScreenshot(serial)
    } else if (key === 'rotate') {
      void execAdb(serial, 'shell settings put system accelerometer_rotation 0 && adb shell settings put system user_rotation 1')
    } else if (key && KEY_MAP[key]) {
      void execAdb(serial, KEY_MAP[key])
    }
  })
})

/* ── Shell Terminal Controller ── */
function appendTermLine(text, cls = '') {
  if (!termOutput) return
  const line = document.createElement('div')
  if (cls) line.className = cls
  line.textContent = text
  termOutput.appendChild(line)
  termOutput.scrollTop = termOutput.scrollHeight
}

async function runShellCommand(cmd) {
  const serial = shellDevice?.value
  if (!serial) {
    appendTermLine('Error: No target device selected in dropdown above.', 'err')
    return
  }
  appendTermLine(`$ adb -s ${serial} ${cmd}`, 'cmd')
  const res = await execAdb(serial, cmd)
  if (res && typeof res === 'object') {
    if (res.output) appendTermLine(res.output)
    if (res.error) appendTermLine(res.error, 'err')
  }
}

if (termInput) {
  termInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const val = termInput.value.trim()
      if (!val) return
      commandHistory.push(val)
      historyIndex = commandHistory.length
      termInput.value = ''
      const cleaned = val.replace(/^adb(\s+-s\s+\S+)?\s+/, '')
      void runShellCommand(cleaned)
    } else if (event.key === 'ArrowUp') {
      if (historyIndex > 0) {
        historyIndex -= 1
        termInput.value = commandHistory[historyIndex] || ''
      }
    } else if (event.key === 'ArrowDown') {
      if (historyIndex < commandHistory.length - 1) {
        historyIndex += 1
        termInput.value = commandHistory[historyIndex] || ''
      } else {
        historyIndex = commandHistory.length
        termInput.value = ''
      }
    }
  })
}

document.getElementById('btn-clear-term')?.addEventListener('click', () => {
  if (termOutput) termOutput.innerHTML = '<span class="info">Terminal cleared.</span>'
})

document.getElementById('btn-copy-term')?.addEventListener('click', () => {
  if (termOutput) void copyToClipboard(termOutput.innerText, 'terminal text')
})

// Quick ADB command presets
const PRESET_MAP = {
  battery: 'shell dumpsys battery',
  ip: 'shell ip addr show wlan0',
  packages: 'shell pm list packages -3',
  screenshot: 'shell screencap -p /sdcard/screenshot.png',
  wake: 'shell input keyevent KEYCODE_WAKEUP',
  reboot: 'reboot',
  logcat: 'logcat -d -t 50',
  'restart-adb': 'kill-server',
}

document.querySelectorAll('.quick-btn[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const act = btn.dataset.action
    if (act && PRESET_MAP[act]) void runShellCommand(PRESET_MAP[act])
  })
})

/* ── Hub Search & Filter Events ── */
document.querySelectorAll('.filter-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('active'))
    chip.classList.add('active')
    currentCategory = chip.dataset.cat || 'all'
    renderProviders(currentCategory, currentSearch)
  })
})

if (hubSearchInput) {
  hubSearchInput.addEventListener('input', () => {
    currentSearch = hubSearchInput.value
    renderProviders(currentCategory, currentSearch)
  })
}

/* ── Wireless ADB Drawer Events ── */
document.getElementById('btn-toggle-wireless')?.addEventListener('click', () => {
  wirelessBar?.classList.toggle('active')
})
document.getElementById('btn-connect-wifi')?.addEventListener('click', () => {
  wirelessBar?.classList.add('active')
})
document.getElementById('btn-cancel-wifi')?.addEventListener('click', () => {
  wirelessBar?.classList.remove('active')
})
document.getElementById('btn-do-connect-wifi')?.addEventListener('click', () => {
  const ip = document.getElementById('wireless-ip')?.value?.trim()
  const port = document.getElementById('wireless-port')?.value?.trim() || '5555'
  if (!ip) {
    setStatus('Enter an IP address (e.g. 192.168.1.100).', true)
    return
  }
  wirelessBar?.classList.remove('active')
  void connectToEmulator(`${ip}:${port}`)
})

/* ── Mirror Controls ── */
document.getElementById('btn-scan')?.addEventListener('click', () => void scanDevices())
document.getElementById('btn-quick-scan')?.addEventListener('click', () => void scanDevices())
document.getElementById('btn-mirror-start')?.addEventListener('click', () => void startMirror())
document.getElementById('btn-mirror-stop')?.addEventListener('click', () => void stopMirror())
document.getElementById('btn-mirror-snap')?.addEventListener('click', () => {
  const serial = activeMirror || mirrorDevice?.value
  if (serial) void captureScreenshot(serial)
})

mirrorModeEl?.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (activeMirror) return
    mirrorMode = btn.dataset.mode === 'external' ? 'external' : 'embedded'
    syncModeButtons()
  })
})

mirrorDevice?.addEventListener('change', () => {
  syncMirrorButtons()
  const label = document.getElementById('term-device-label')
  if (label && mirrorDevice?.value) label.textContent = `Target: ${mirrorDevice.value}`
})

shellDevice?.addEventListener('change', () => {
  const label = document.getElementById('term-device-label')
  if (label && shellDevice?.value) label.textContent = `Target: ${shellDevice.value}`
})

/* ── Agent Tasks ── */
document.getElementById('btn-run-tests')?.addEventListener('click', () => {
  const serial = shellDevice?.value
  if (!serial) {
    setStatus('Select a target device first.', true)
    return
  }
  const runner = prompt('Enter test runner command:', 'shell am instrument -w -r ...')
  if (runner) void runShellCommand(runner)
})

document.getElementById('btn-install-test')?.addEventListener('click', () => {
  const serial = shellDevice?.value
  if (!serial) {
    setStatus('Select a target device first.', true)
    return
  }
  appendTermLine('[Agent Task] Sideload & Test sequence initiated…', 'cmd')
  void runShellCommand('shell pm list packages -3')
})

/* ── Startup ── */
renderProviders('all', '')
bridge.start()
bridge.whenConnected(() => {
  setStatus('Connected to ND. Scanning for devices…')
  void scanDevices()
})
syncModeButtons()
