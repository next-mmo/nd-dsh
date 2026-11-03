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
} from './emulator-core.js'

/* ── Bridge Implementation ── */
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
      hello = data
      while (connectQueue.length > 0) {
        const fn = connectQueue.shift()
        if (fn) fn()
      }
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
    invoke(input, timeoutMs = 20000) {
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

let busy = false
let devices = []
let activeMirror = null
let activeMode = null
let mirrorMode = 'embedded'
let snapshotTimer = null
let tapStart = null
let mirrorFallback = false

/* ── Status & Log Helpers ── */
function setStatus(message, isError = false) {
  if (statusText) statusText.textContent = message
  if (statusBar) statusBar.classList.toggle('error', isError)
}

function setBusy(value) {
  busy = value
  document.querySelectorAll('button:not(.tab-btn)').forEach((btn) => {
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
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'))
    btn.classList.add('active')
    const target = document.getElementById(`tab-${btn.dataset.tab}`)
    if (target) target.classList.add('active')
  })
})

/* ── Render Devices ── */
function renderDevices(deviceList) {
  devices = deviceList
  const count = deviceList.length
  if (deviceCount) deviceCount.textContent = `${count} device${count !== 1 ? 's' : ''} connected`

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
      opt.textContent = `${d.model || d.serial} (${d.type})`
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
      <div class="empty-state">
        <div class="icon">📱</div>
        <h3>No devices found</h3>
        <p>Connect an Android device via USB or enter an IP address for wireless ADB.</p>
        <button id="btn-scan-empty" class="primary" style="margin-top: 8px;">🔍 Scan for devices</button>
      </div>`
    document.getElementById('btn-scan-empty')?.addEventListener('click', () => void scanDevices())
    return
  }

  deviceGrid.innerHTML = ''
  for (const device of deviceList) {
    const info = formatDeviceInfo(device)
    const isConn = device.type === 'device'
    const statusClass = isConn ? 'badge-success' : device.type === 'offline' ? 'badge-danger' : 'badge-warning'
    const statusLabel = isConn ? 'Connected' : device.type === 'offline' ? 'Offline' : device.type
    const card = document.createElement('article')
    card.className = 'device-card'
    card.innerHTML = `
      <div class="device-header">
        <div class="device-icon">📱</div>
        <div style="flex:1;min-width:0">
          <div class="device-name">${device.model || device.serial}</div>
          <span class="badge ${statusClass}">${statusLabel}</span>
        </div>
      </div>
      <div class="device-info">${info}</div>
      <div class="device-actions">
        <button class="small primary" data-serial="${device.serial}" data-cmd="mirror">🪞 Mirror</button>
        <button class="small" data-serial="${device.serial}" data-cmd="screenshot">📷 Screenshot</button>
        <button class="small" data-serial="${device.serial}" data-cmd="shell">⚡ Shell</button>
        <button class="small danger" data-serial="${device.serial}" data-cmd="disconnect">❌ Disconnect</button>
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
        document.querySelector('[data-tab="mirror"]')?.click()
      } else if (cmd === 'shell') {
        if (shellDevice) shellDevice.value = serial
        document.querySelector('[data-tab="shell"]')?.click()
      } else if (cmd === 'screenshot') {
        void captureScreenshot(serial)
      } else if (cmd === 'disconnect') {
        void execAdb(serial, 'disconnect')
      }
    })
  })
}

/* ── Actions ── */
async function scanDevices() {
  if (busy) return
  setBusy(true)
  setStatus('Scanning for devices via ADB…')
  try {
    const result = await bridge.invoke({ action: 'devices-list' }, 15000)
    if (!result.ok) throw new Error(result.error?.message || 'Could not list devices')
    const list = parseDeviceList(result.value)
    renderDevices(list)
    setStatus(`Found ${list.length} device${list.length !== 1 ? 's' : ''}.`)
    addLog(`Scanned ${list.length} device(s)`, 'success')
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Could not scan devices'
    setStatus(msg, true)
    addLog(msg, 'error')
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
    if (command === 'disconnect') void scanDevices()
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

async function rotateScreen(target) {
  const prepared = await execAdb(target, 'shell settings put system accelerometer_rotation 0')
  if (prepared === null) return
  await execAdb(target, 'shell settings put system user_rotation 1')
}

async function captureScreenshot(serial) {
  if (!serial) return
  setStatus('Capturing screenshot…')
  try {
    const result = await bridge.invoke({ action: 'screenshot', serial }, 20000)
    if (!result.ok) throw new Error(result.error?.message || 'Screenshot failed')
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
      document.querySelector('[data-tab="mirror"]')?.click()
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Screenshot failed'
    setStatus(msg, true)
    addLog(msg, 'error')
  }
}

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
      // Prefer continuous getUserMedia capture when the source ID is available.
      if (typeof value.windowSourceId === 'string' && mirrorCanvas) {
        mirrorCanvas.style.display = 'block'
        mirrorCanvas.width = value.device?.width || 1080
        mirrorCanvas.height = value.device?.height || 2340
        if (mirrorStream) { mirrorStream.style.display = 'none'; mirrorStream.src = '' }
        window.parent.postMessage({ kind: 'nd-webview:mirror-start', sourceId: value.windowSourceId }, '*')
        addLog(`Embedded mirror started (live capture): ${serial}`, 'success')
        setStatus(`Embedded mirror active: ${serial}`)
      } else {
        // No source ID or no canvas — fall back to MJPEG immediately.
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
      throw new Error('No active mirror process was found; try Start again.')
    }
    addLog(`Mirror stopped: ${serial}`, 'info')
    setStatus('Mirror session ended.')
    if (activeMode === 'embedded' && !mirrorFallback) {
      window.parent.postMessage({ kind: 'nd-webview:mirror-stop' }, '*')
    }
    activeMirror = null
    activeMode = null
    tapStart = null
    mirrorFallback = false
    if (btnMirrorStop) btnMirrorStop.disabled = true
    if (mirrorStats) mirrorStats.textContent = ''
    if (mirrorStream) {
      mirrorStream.onload = null
      mirrorStream.onerror = null
      mirrorStream.src = ''
      mirrorStream.style.display = 'none'
    }
    if (mirrorCanvas) {
      mirrorCanvas.style.display = 'none'
      mirrorCanvas.width = 0
      mirrorCanvas.height = 0
    }
    if (mirrorImg) {
      mirrorImg.classList.remove('snapshot-overlay')
      mirrorImg.style.display = 'none'
      mirrorImg.src = ''
    }
    if (snapshotTimer) {
      clearTimeout(snapshotTimer)
      snapshotTimer = null
    }
    if (mirrorPlaceholder) mirrorPlaceholder.style.display = ''
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not stop mirror', true)
  } finally {
    setBusy(false)
    syncModeButtons()
  }
}

/* ── Mirror fallback: switch from continuous capture to MJPEG ── */
function fallbackToMjpeg() {
  if (!activeMirror || activeMode !== 'embedded') return
  const session = activeMirror
  // Ask the host to resume the paused MJPEG session and return the stream URL.
  bridge.invoke({ action: 'mirror-resume', serial: session }, 20000)
    .then((result) => {
      if (!result.ok || !result.value?.resumed || typeof result.value.streamUrl !== 'string') {
        setStatus('Fallback stream unavailable', true)
        return
      }
      if (mirrorCanvas) mirrorCanvas.style.display = 'none'
      if (mirrorStream) {
        mirrorStream.onload = () => { setStatus(`Embedded mirror (MJPEG fallback): ${session}`) }
        mirrorStream.onerror = () => { setStatus('MJPEG fallback failed', true) }
        mirrorStream.src = result.value.streamUrl
        mirrorStream.style.display = 'block'
      }
      addLog('Switched to MJPEG fallback', 'info')
    })
    .catch(() => { setStatus('Fallback stream unavailable', true) })
}
const cmdHistory = []
let historyIndex = -1

function appendTermLine(text, cls = '') {
  if (!termOutput) return
  const span = document.createElement('span')
  span.className = cls
  span.textContent = text + '\n'
  termOutput.append(span)
  termOutput.scrollTop = termOutput.scrollHeight
}

async function runShellCommand(command) {
  const serial = shellDevice?.value
  if (!serial) {
    appendTermLine('Error: No target device selected. Select a device first.', 'err')
    return
  }
  appendTermLine(`$ ${command}`, 'cmd')
  try {
    const result = await bridge.invoke({ action: 'adb-exec', serial, command }, 30000)
    if (!result.ok) {
      appendTermLine(result.error?.message || 'Command failed', 'err')
      addLog(`Shell: ${command} failed`, 'error')
    } else {
      const value = result.value
      const output = typeof value === 'string'
        ? value
        : (value?.output ?? JSON.stringify(value, null, 2))
      const failed = value && typeof value === 'object' && typeof value.exitCode === 'number' && value.exitCode !== 0
      appendTermLine(output, failed ? 'err' : '')
      addLog(`Shell: ${command}${failed ? ' failed' : ''}`, failed ? 'error' : 'success')
    }
  } catch (error) {
    appendTermLine(error instanceof Error ? error.message : 'Command failed', 'err')
  }
}

if (termInput) {
  termInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const cmd = termInput.value.trim()
      if (!cmd) return
      cmdHistory.unshift(cmd)
      historyIndex = -1
      termInput.value = ''
      void runShellCommand(cmd)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (historyIndex < cmdHistory.length - 1) {
        historyIndex++
        termInput.value = cmdHistory[historyIndex]
      }
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (historyIndex > 0) {
        historyIndex--
        termInput.value = cmdHistory[historyIndex]
      } else {
        historyIndex = -1
        termInput.value = ''
      }
    }
  })
}

/* ── Nav Key Event Helpers ── */
const KEY_MAP = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  recents: 'KEYCODE_APP_SWITCH',
  volup: 'KEYCODE_VOLUME_UP',
  voldown: 'KEYCODE_VOLUME_DOWN',
  power: 'KEYCODE_POWER',
}

document.querySelectorAll('#mirror-nav button[data-key]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.key
    const target = activeMirror || mirrorDevice?.value
    if (!target) {
      setStatus('Select a device first.', true)
      return
    }
    if (key === 'screenshot') {
      void captureScreenshot(target)
    } else if (key === 'rotate') {
      void rotateScreen(target)
    } else if (key && KEY_MAP[key]) {
      void execAdb(target, `shell input keyevent ${KEY_MAP[key]}`)
    }
  })
})

/* ── Quick Actions ── */
document.querySelectorAll('.quick-btn[data-action]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const serial = shellDevice?.value
    if (!serial) {
      setStatus('Select a target device first.', true)
      return
    }
    const action = btn.dataset.action
    if (action === 'screenshot') {
      void captureScreenshot(serial)
    } else if (action === 'install-apk') {
      const apk = prompt('Enter path to APK file on your computer:')
      if (apk) void execAdb(serial, `install -r "${apk}"`)
    } else if (action === 'clear-data') {
      const pkg = prompt('Enter package name to clear (e.g. com.example.app):')
      if (pkg) void execAdb(serial, `shell pm clear ${pkg}`)
    } else if (action === 'screen-record') {
      void execAdb(serial, 'shell screenrecord /sdcard/nd_recording.mp4')
      setStatus('Screen recording started on device (/sdcard/nd_recording.mp4). Press Ctrl+C or reboot to stop.')
    } else if (action === 'push-file') {
      const src = prompt('Local file path:')
      const dst = prompt('Device path (e.g. /sdcard/Download/):')
      if (src && dst) void execAdb(serial, `push "${src}" "${dst}"`)
    } else if (action === 'pull-file') {
      const src = prompt('Device file path (e.g. /sdcard/Download/file.txt):')
      const dst = prompt('Local destination directory:')
      if (src && dst) void execAdb(serial, `pull "${src}" "${dst}"`)
    } else if (action === 'reboot') {
      if (confirm(`Reboot device ${serial}?`)) void execAdb(serial, 'reboot')
    } else if (action === 'logcat') {
      void runShellCommand('logcat -d -t 100')
    }
  })
})

/* ── Top-level Controls ── */
document.getElementById('btn-scan')?.addEventListener('click', () => void scanDevices())
btnMirrorStart?.addEventListener('click', () => void startMirror())
btnMirrorStop?.addEventListener('click', () => void stopMirror())
btnMirrorSnap?.addEventListener('click', () => {
  const serial = mirrorDevice?.value
  if (serial) void captureScreenshot(serial)
})

document.getElementById('btn-clear-term')?.addEventListener('click', () => {
  if (termOutput) termOutput.innerHTML = '<span class="info">Terminal cleared.\n</span>'
})

document.getElementById('btn-connect-wifi')?.addEventListener('click', async () => {
  const address = prompt('Enter device IP and port for wireless ADB (e.g. 192.168.1.100:5555):')
  if (!address) return
  setBusy(true)
  try {
    const result = await bridge.invoke({ action: 'devices-connect', address }, 15000)
    if (!result.ok) throw new Error(result.error?.message || 'Connection failed')
    addLog(`Wireless ADB: ${address}`, 'success')
    void scanDevices()
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Connection failed'
    setStatus(msg, true)
    addLog(msg, 'error')
  } finally {
    setBusy(false)
  }
})

document.getElementById('btn-launch-emu')?.addEventListener('click', () => {
  setStatus('Tip: Launch an AVD via Android Studio or command line `emulator -avd <name>`, then click Scan.', false)
  addLog('AVD launch hint displayed', 'info')
})

mirrorDevice?.addEventListener('change', () => {
  syncMirrorButtons()
})

mirrorModeEl?.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (busy || activeMirror) return
    mirrorMode = btn.dataset.mode === 'external' ? 'external' : 'embedded'
    syncModeButtons()
    setStatus(
      mirrorMode === 'embedded'
        ? 'Embedded mirror selected. Click Start to stream inside ND.'
        : 'External window selected. Click Start to open scrcpy.',
    )
  })
})

function clamp01(value) {
  return Math.max(0, Math.min(1, value))
}

/** The element that currently shows the live mirror (canvas or MJPEG img). */
function mirrorSurface() {
  if (activeMode === 'embedded' && !mirrorFallback && mirrorCanvas && mirrorCanvas.style.display !== 'none') return mirrorCanvas
  if (activeMode === 'embedded' && mirrorStream && mirrorStream.style.display !== 'none') return mirrorStream
  return null
}

function mirrorNaturalSize() {
  const surface = mirrorSurface()
  if (surface === mirrorCanvas) {
    return { naturalWidth: mirrorCanvas.width || 1080, naturalHeight: mirrorCanvas.height || 2340 }
  }
  return { naturalWidth: surface?.naturalWidth || 1080, naturalHeight: surface?.naturalHeight || 2340 }
}

function normalizedStreamPoint(event) {
  const surface = mirrorSurface()
  if (!surface) return null
  const rect = surface.getBoundingClientRect()
  const { naturalWidth, naturalHeight } = mirrorNaturalSize()
  if (rect.width <= 0 || rect.height <= 0 || naturalWidth <= 0 || naturalHeight <= 0) return null
  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight)
  const width = naturalWidth * scale
  const height = naturalHeight * scale
  const left = rect.left + (rect.width - width) / 2
  const top = rect.top + (rect.height - height) / 2
  return {
    x: clamp01((event.clientX - left) / width),
    y: clamp01((event.clientY - top) / height),
  }
}

function addTapRipple(event) {
  const screen = document.getElementById('mirror-screen')
  if (!screen) return
  const rect = screen.getBoundingClientRect()
  const ripple = document.createElement('span')
  ripple.className = 'tap-ripple'
  ripple.style.left = `${event.clientX - rect.left}px`
  ripple.style.top = `${event.clientY - rect.top}px`
  screen.append(ripple)
  setTimeout(() => ripple.remove(), 400)
}

function handleInputResult(result) {
  if (!result.ok) setStatus(result.error?.message || 'Device input failed', true)
}

function bindPointerInput(surface) {
  if (!surface || surface.dataset.mirrorInputBound) return
  surface.dataset.mirrorInputBound = '1'
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

  surface.addEventListener('pointercancel', () => {
    tapStart = null
  })

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

document.getElementById('btn-run-tests')?.addEventListener('click', () => {
  const serial = shellDevice?.value
  if (!serial) {
    setStatus('Select a device first.', true)
    return
  }
  const runner = prompt('Test runner command (e.g. "shell am instrument -w ..."):', 'shell am instrument -w')
  if (runner) void runShellCommand(runner)
})

document.getElementById('btn-install-test')?.addEventListener('click', () => {
  const serial = shellDevice?.value
  if (!serial) {
    setStatus('Select a device first.', true)
    return
  }
  appendTermLine('[Agent Task] 1-Click Install & Test initiated…', 'cmd')
  void runShellCommand('devices -l')
})

/* ── Startup Handshake ── */
bridge.start()
bridge.whenConnected(() => {
  setStatus('Connected to ND. Scanning for devices…')
  void scanDevices()
})
syncModeButtons()
