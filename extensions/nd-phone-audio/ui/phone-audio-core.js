/**
 * Pure formatting and diagnostic helpers for Phone Audio UI.
 * Kept DOM-free so both the sandboxed extension frame and repository unit tests
 * can import and validate it directly.
 */

export const STREAM_STATE_META = {
  stopped: { label: 'Stopped', tone: 'idle' },
  starting: { label: 'Starting', tone: 'accent' },
  waiting: { label: 'Waiting for Android', tone: 'accent' },
  connecting: { label: 'Connecting', tone: 'accent' },
  connected: { label: 'Connected', tone: 'ok' },
  reconnecting: { label: 'Reconnecting', tone: 'warn' },
  error: { label: 'Error', tone: 'bad' },
}

export function describeStreamState(state) {
  return STREAM_STATE_META[state] ?? STREAM_STATE_META.stopped
}

export function formatTransportKind(kind) {
  if (kind === 'usb') return 'USB Tethering'
  if (kind === 'wifi') return 'Wi-Fi'
  if (kind === 'ethernet') return 'Ethernet / LAN'
  return 'Local Network'
}

export function formatLatencySummary(stats, client) {
  const rtt = typeof stats?.rttMs === 'number'
    ? stats.rttMs
    : typeof client?.latencyMs === 'number'
      ? client.latencyMs
      : null
  const jitter = typeof stats?.jitterMs === 'number'
    ? stats.jitterMs
    : typeof client?.jitterMs === 'number'
      ? client.jitterMs
      : null
  if (rtt === null && jitter === null) return 'Not measured yet'
  const parts = []
  if (rtt !== null) parts.push(`${rtt} ms RTT`)
  if (jitter !== null) parts.push(`${jitter} ms jitter`)
  return parts.join(' · ')
}

export function summarizeUserAgent(ua) {
  if (typeof ua !== 'string' || !ua.trim()) return 'Android Chrome'
  const chromeMatch = /Chrome\/([0-9.]+)/.exec(ua)
  const androidMatch = /Android\s+([0-9.]+)/.exec(ua)
  const bits = []
  if (androidMatch) bits.push(`Android ${androidMatch[1]}`)
  if (chromeMatch) bits.push(`Chrome ${chromeMatch[1].split('.')[0]}`)
  return bits.length > 0 ? bits.join(' · ') : 'Mobile Browser'
}

export function detectOutputDiagnostics(snapshot) {
  const devices = Array.isArray(snapshot?.outputDevices) ? snapshot.outputDevices : []
  const volume = snapshot?.systemVolume
  if (devices.length === 0 && volume && volume.available === false) {
    return {
      ok: false,
      message: 'No active Windows playback device detected. Plug in speakers, headphones, or a display audio monitor.',
    }
  }
  if (volume?.available && volume.muted) {
    return {
      ok: true,
      warning: 'Windows system output is muted. Some audio drivers produce silent loopback while muted; unmute Windows or enable "Mute PC speakers while streaming" instead.',
    }
  }
  return { ok: true }
}
