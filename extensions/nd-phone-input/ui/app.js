import { createBridge } from './bridge.js'
import {
  describeSessionState,
  formatInjectionSummary,
  formatTransportKind,
  summarizeUserAgent,
} from './phone-input-core.js'

const el = (id) => document.getElementById(id)

const nodes = {
  statePill: el('state-pill'),
  stateLabel: el('state-label'),
  toggleBtn: el('toggle-btn'),
  errorBanner: el('error-banner'),
  ifaceSelect: el('iface-select'),
  usbHint: el('usb-hint'),
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
  clientInjection: el('client-injection'),
  clientLatency: el('client-latency'),
  disconnectBtn: el('disconnect-btn'),
  refreshBtn: el('refresh-btn'),
}

let snapshot = null
let busy = false

const bridge = createBridge({
  onPhoneInputState: (next) => {
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

  const meta = describeSessionState(s.sessionState)
  nodes.statePill.className = `pill ${meta.tone}`
  nodes.stateLabel.textContent = meta.label

  nodes.toggleBtn.disabled = busy
  nodes.toggleBtn.textContent = s.serverRunning ? 'Stop Keyboard' : 'Start Keyboard'
  nodes.toggleBtn.className = s.serverRunning ? 'danger' : 'primary'

  showBanner(nodes.errorBanner, s.lastError || '')

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
  const usbIface = ifaces.find((item) => item.kind === 'usb')
  nodes.usbHint.textContent = usbIface
    ? `USB link detected (${usbIface.label}). No Wi-Fi needed — keep the cable plugged in while typing.`
    : 'No USB adapter detected yet. To use USB instead of Wi-Fi: plug in the phone, enable USB tethering (Android), then press Refresh. Wi-Fi needs no cable.'

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
      : 'Start the keyboard to generate a pairing URL'
    nodes.copyUrlBtn.disabled = true
    nodes.rotateBtn.disabled = !s.serverRunning || busy
    nodes.qrImg.hidden = true
    nodes.qrPlaceholder.hidden = false
    nodes.qrPlaceholder.textContent = s.serverRunning
      ? 'Waiting for Wi-Fi or USB network adapter'
      : 'Start the keyboard to generate a QR code'
  }
  nodes.firewallNote.textContent = s.firewallHint || ''

  if (s.client) {
    nodes.clientEmpty.hidden = true
    nodes.clientDetails.hidden = false
    nodes.clientUa.textContent = summarizeUserAgent(s.client.userAgent)
    nodes.clientTransport.textContent = formatTransportKind(s.client.transport)
    nodes.clientIp.textContent = s.client.remoteAddress
    nodes.clientInjection.textContent = formatInjectionSummary(s)
    nodes.clientLatency.textContent = typeof s.client.latencyMs === 'number'
      ? `${s.client.latencyMs} ms`
      : 'Not measured yet'
    nodes.disconnectBtn.disabled = busy
  } else {
    nodes.clientEmpty.hidden = false
    nodes.clientDetails.hidden = true
  }
}

async function runAction(action, payload = {}) {
  setBusy(true)
  try {
    const res = await bridge.invoke({ action, ...payload })
    if (res.ok && res.value && typeof res.value === 'object' && 'sessionState' in res.value) {
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
      ...(nodes.ifaceSelect.value ? { preferredInterfaceId: nodes.ifaceSelect.value } : {}),
    })
  }
})

nodes.refreshBtn.addEventListener('click', () => { void runAction('status') })
nodes.rotateBtn.addEventListener('click', () => { void runAction('rotate-token') })
nodes.disconnectBtn.addEventListener('click', () => { void runAction('disconnect') })

nodes.copyUrlBtn.addEventListener('click', async () => {
  const url = nodes.connUrl.textContent
  if (!url || !url.startsWith('http')) return
  const res = await bridge.invoke({ action: 'copy-url', text: url })
  if (res.ok) {
    const prev = nodes.copyUrlBtn.textContent
    nodes.copyUrlBtn.textContent = 'Copied!'
    setTimeout(() => { nodes.copyUrlBtn.textContent = prev }, 1500)
  }
})

nodes.ifaceSelect.addEventListener('change', () => {
  void runAction('set-options', { preferredInterfaceId: nodes.ifaceSelect.value })
})

bridge.whenConnected(() => { void runAction('status') })
bridge.start()