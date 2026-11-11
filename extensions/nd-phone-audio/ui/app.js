import { createBridge } from './bridge.js'
import {
  describeStreamState,
  detectOutputDiagnostics,
  formatLatencySummary,
  formatTransportKind,
  summarizeUserAgent,
} from './phone-audio-core.js'

const el = (id) => document.getElementById(id)

const nodes = {
  statePill: el('state-pill'),
  stateLabel: el('state-label'),
  toggleBtn: el('toggle-btn'),
  errorBanner: el('error-banner'),
  warningBanner: el('warning-banner'),
  ifaceSelect: el('iface-select'),
  usbHint: el('usb-hint'),
  quickStart: el('quick-start'),
  qrImg: el('qr-img'),
  qrPlaceholder: el('qr-placeholder'),
  ipPort: el('ip-port'),
  pairingCode: el('pairing-code'),
  connUrl: el('conn-url'),
  copyUrlBtn: el('copy-url-btn'),
  rotateBtn: el('rotate-btn'),
  firewallNote: el('firewall-note'),
  clientEmpty: el('client-empty'),
  clientDetails: el('client-details'),
  clientUa: el('client-ua'),
  clientTransport: el('client-transport'),
  clientIp: el('client-ip'),
  clientPlayback: el('client-playback'),
  clientLatency: el('client-latency'),
  clientCodec: el('client-codec'),
  disconnectBtn: el('disconnect-btn'),
  meterText: el('meter-text'),
  meterFill: el('meter-fill'),
  captureStatus: el('capture-status'),
  captureFormat: el('capture-format'),
  captureModeSelect: el('capture-mode-select'),
  fallbackDeviceRow: el('fallback-device-row'),
  inputDeviceSelect: el('input-device-select'),
  mutePcCheckbox: el('mute-pc-checkbox'),
  sysVolume: el('sys-volume'),
  outputDeviceList: el('output-device-list'),
  refreshBtn: el('refresh-btn'),
}

let snapshot = null
let busy = false

const bridge = createBridge({
  onPhoneAudioState: (next) => {
    snapshot = next
    render()
  },
})

function setBusy(nextBusy) {
  busy = nextBusy
  render()
}

function showBanner(node, message) {
  if (!message) {
    node.hidden = true
    node.textContent = ''
    return
  }
  node.hidden = false
  node.textContent = message
}

function render() {
  const s = snapshot
  if (!s) return

  const meta = describeStreamState(s.streamState)
  nodes.statePill.className = `pill ${meta.tone}`
  nodes.stateLabel.textContent = meta.label

  nodes.toggleBtn.disabled = busy
  nodes.toggleBtn.textContent = s.serverRunning ? 'Stop Streaming' : 'Start Streaming'
  nodes.toggleBtn.className = s.serverRunning ? 'danger' : 'primary'

  const diag = detectOutputDiagnostics(s)
  showBanner(nodes.errorBanner, s.lastError || (!diag.ok ? diag.message : ''))
  showBanner(nodes.warningBanner, s.capture?.silentWarning || diag.warning || '')

  // Network interfaces selector
  const ifaces = Array.isArray(s.interfaces) ? s.interfaces : []
  const selectedId = s.selectedInterfaceId || (ifaces[0]?.id ?? '')
  nodes.ifaceSelect.replaceChildren()
  if (ifaces.length === 0) {
    const opt = document.createElement('option')
    opt.value = ''
    opt.textContent = 'No Wi-Fi, USB tethering, or Ethernet IPv4 adapter found'
    nodes.ifaceSelect.appendChild(opt)
    nodes.ifaceSelect.disabled = true
  } else {
    for (const iface of ifaces) {
      const opt = document.createElement('option')
      opt.value = iface.id
      opt.textContent = `${iface.label} — ${iface.address}`
      if (iface.id === selectedId) opt.selected = true
      nodes.ifaceSelect.appendChild(opt)
    }
    nodes.ifaceSelect.disabled = busy
  }

  const activeIface = ifaces.find((item) => item.id === selectedId) || ifaces[0] || null
  // Guidance adapts to what the PC can actually see: no USB adapter yet means
  // the phone is not tethering, which is the most common "USB does nothing".
  const usbIface = ifaces.find((item) => item.kind === 'usb')
  nodes.usbHint.textContent = usbIface
    ? `USB link detected (${usbIface.label}). No Wi-Fi needed — keep the cable plugged in while listening.`
    : 'No USB adapter detected yet. To use USB instead of Wi-Fi: plug in the phone, enable USB tethering (Android) or Personal Hotspot (iPhone), then press Refresh Devices & Network below. Wi-Fi needs no cable.'
  nodes.quickStart.hidden = Boolean(s.client)
  if (s.serverRunning && activeIface) {
    nodes.ipPort.textContent = `${activeIface.address}:${s.port}`
    nodes.pairingCode.textContent = s.pairingCode || '------'
    nodes.connUrl.textContent = activeIface.url
    nodes.copyUrlBtn.disabled = busy
    nodes.rotateBtn.disabled = busy
    if (activeIface.qrSvg) {
      nodes.qrImg.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(activeIface.qrSvg)}`
      nodes.qrImg.hidden = false
      nodes.qrPlaceholder.hidden = true
    } else {
      nodes.qrImg.hidden = true
      nodes.qrPlaceholder.hidden = false
    }
  } else {
    nodes.ipPort.textContent = activeIface ? `${activeIface.address} (server stopped)` : '—'
    nodes.pairingCode.textContent = '------'
    nodes.connUrl.textContent = s.serverRunning
      ? `http://127.0.0.1:${s.port}/ (connect Wi-Fi or USB tethering)`
      : 'Start streaming to generate pairing URL'
    nodes.copyUrlBtn.disabled = true
    nodes.rotateBtn.disabled = !s.serverRunning || busy
    nodes.qrImg.hidden = true
    nodes.qrPlaceholder.hidden = false
    nodes.qrPlaceholder.textContent = s.serverRunning
      ? 'Waiting for Wi-Fi or USB network adapter'
      : 'Start streaming to generate QR code'
  }
  nodes.firewallNote.textContent = s.firewallHint || ''

  // Connected client
  if (s.client) {
    nodes.clientEmpty.hidden = true
    nodes.clientDetails.hidden = false
    nodes.clientUa.textContent = summarizeUserAgent(s.client.userAgent)
    nodes.clientTransport.textContent = formatTransportKind(s.client.transport)
    nodes.clientIp.textContent = s.client.remoteAddress
    const volPct = Math.round((s.client.volume ?? 1) * 100)
    nodes.clientPlayback.textContent = s.client.paused ? `Paused (Vol ${volPct}%)` : `Playing (Vol ${volPct}%)`
    nodes.clientLatency.textContent = formatLatencySummary(s.stats, s.client)
    const codec = s.stats?.codec || 'OPUS'
    const rate = s.stats?.clockRate ? `${Math.round(s.stats.clockRate / 1000)} kHz` : '48 kHz'
    const bitrate = typeof s.stats?.bitrateKbps === 'number' ? ` · ${s.stats.bitrateKbps} kbps` : ''
    nodes.clientCodec.textContent = `${codec} ${rate}${bitrate}`
    nodes.disconnectBtn.disabled = busy
  } else {
    nodes.clientEmpty.hidden = false
    nodes.clientDetails.hidden = true
  }

  // Audio capture & level meter
  const pct = Math.round((s.audioLevel ?? 0) * 100)
  nodes.meterText.textContent = `${pct}%`
  nodes.meterFill.style.width = `${pct}%`
  nodes.captureStatus.textContent = s.capture?.active
    ? `Active (${s.capture.trackLabel || 'System Loopback'})`
    : 'Inactive'
  const fmtParts = []
  if (s.capture?.sampleRate) fmtParts.push(`${Math.round(s.capture.sampleRate / 1000)} kHz`)
  if (s.capture?.channelCount) fmtParts.push(s.capture.channelCount === 2 ? 'Stereo (2 ch)' : `${s.capture.channelCount} ch`)
  nodes.captureFormat.textContent = fmtParts.length > 0 ? fmtParts.join(' · ') : '—'

  nodes.captureModeSelect.value = s.options?.captureMode === 'device' ? 'device' : 'loopback'
  nodes.captureModeSelect.disabled = busy
  nodes.mutePcCheckbox.checked = Boolean(s.options?.muteLocalPlayback)
  nodes.mutePcCheckbox.disabled = busy || nodes.captureModeSelect.value === 'device'

  const isDeviceMode = nodes.captureModeSelect.value === 'device'
  nodes.fallbackDeviceRow.hidden = !isDeviceMode
  const inputs = Array.isArray(s.inputDevices) ? s.inputDevices : []
  nodes.inputDeviceSelect.replaceChildren()
  if (inputs.length === 0) {
    const opt = document.createElement('option')
    opt.value = ''
    opt.textContent = 'No input / virtual audio device found'
    nodes.inputDeviceSelect.appendChild(opt)
  } else {
    for (const dev of inputs) {
      const opt = document.createElement('option')
      opt.value = dev.deviceId
      opt.textContent = dev.label
      if (dev.deviceId === s.options?.inputDeviceId) opt.selected = true
      nodes.inputDeviceSelect.appendChild(opt)
    }
  }
  nodes.inputDeviceSelect.disabled = busy

  // Windows output devices
  if (s.systemVolume?.available) {
    const lvl = typeof s.systemVolume.level === 'number' ? `${Math.round(s.systemVolume.level)}%` : '—'
    nodes.sysVolume.textContent = s.systemVolume.muted ? `${lvl} (Muted)` : lvl
  } else {
    nodes.sysVolume.textContent = s.systemVolume?.reason || 'Unavailable'
  }

  const outputs = Array.isArray(s.outputDevices) ? s.outputDevices : []
  nodes.outputDeviceList.replaceChildren()
  if (outputs.length === 0) {
    const li = document.createElement('li')
    li.className = 'device-item'
    li.textContent = 'No active Windows output devices detected'
    nodes.outputDeviceList.appendChild(li)
  } else {
    for (const dev of outputs) {
      const li = document.createElement('li')
      li.className = 'device-item'
      const name = document.createElement('span')
      name.textContent = dev.label
      const tag = document.createElement('span')
      tag.className = 'note'
      tag.textContent = dev.isDefault ? 'Active' : 'Available'
      li.append(name, tag)
      nodes.outputDeviceList.appendChild(li)
    }
  }
}

async function runAction(action, payload = {}) {
  setBusy(true)
  try {
    const res = await bridge.invoke({ action, ...payload })
    if (res.ok && res.value && typeof res.value === 'object' && 'streamState' in res.value) {
      snapshot = res.value
    } else if (!res.ok && res.error?.message) {
      showBanner(nodes.errorBanner, res.error.message)
    }
  } finally {
    setBusy(false)
  }
}

nodes.toggleBtn.addEventListener('click', () => {
  if (snapshot?.serverRunning) {
    void runAction('stop')
  } else {
    void runAction('start', {
      captureMode: nodes.captureModeSelect.value,
      muteLocalPlayback: nodes.mutePcCheckbox.checked,
      ...(nodes.captureModeSelect.value === 'device' && nodes.inputDeviceSelect.value
        ? { inputDeviceId: nodes.inputDeviceSelect.value }
        : {}),
      ...(nodes.ifaceSelect.value ? { preferredInterfaceId: nodes.ifaceSelect.value } : {}),
    })
  }
})

nodes.refreshBtn.addEventListener('click', () => {
  void runAction('status')
})

nodes.rotateBtn.addEventListener('click', () => {
  void runAction('rotate-token')
})

nodes.disconnectBtn.addEventListener('click', () => {
  void runAction('disconnect')
})

nodes.copyUrlBtn.addEventListener('click', async () => {
  const url = nodes.connUrl.textContent
  if (!url || !url.startsWith('http')) return
  const res = await bridge.invoke({ action: 'copy-url', text: url })
  if (res.ok) {
    const prev = nodes.copyUrlBtn.textContent
    nodes.copyUrlBtn.textContent = 'Copied!'
    setTimeout(() => {
      nodes.copyUrlBtn.textContent = prev
    }, 1500)
  }
})

nodes.ifaceSelect.addEventListener('change', () => {
  void runAction('set-options', { preferredInterfaceId: nodes.ifaceSelect.value })
})

nodes.captureModeSelect.addEventListener('change', () => {
  const mode = nodes.captureModeSelect.value
  const inputDeviceId = mode === 'device' ? nodes.inputDeviceSelect.value : undefined
  void runAction('set-options', { captureMode: mode, ...(inputDeviceId ? { inputDeviceId } : {}) })
})

nodes.inputDeviceSelect.addEventListener('change', () => {
  if (nodes.captureModeSelect.value === 'device') {
    void runAction('set-options', { inputDeviceId: nodes.inputDeviceSelect.value })
  }
})

nodes.mutePcCheckbox.addEventListener('change', () => {
  void runAction('set-options', { muteLocalPlayback: nodes.mutePcCheckbox.checked })
})

bridge.whenConnected(() => {
  void runAction('status')
})
bridge.start()
