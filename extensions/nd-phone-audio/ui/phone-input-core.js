/**
 * Pure formatting helpers for the Phone Keyboard UI.
 * DOM-free so the sandboxed extension frame and repository unit tests can
 * import and validate them directly.
 */

export const SESSION_STATE_META = {
  stopped: { label: 'Stopped', tone: 'idle' },
  starting: { label: 'Starting', tone: 'accent' },
  waiting: { label: 'Waiting for phone', tone: 'accent' },
  connected: { label: 'Connected', tone: 'ok' },
  error: { label: 'Error', tone: 'bad' },
}

export function describeSessionState(state) {
  return SESSION_STATE_META[state] ?? SESSION_STATE_META.stopped
}

export function formatTransportKind(kind) {
  if (kind === 'usb') return 'USB Tethering'
  if (kind === 'wifi') return 'Wi-Fi'
  if (kind === 'ethernet') return 'Ethernet / LAN'
  return 'Local Network'
}

export function summarizeUserAgent(ua) {
  if (typeof ua !== 'string' || !ua.trim()) return 'Phone browser'
  const iosMatch = /(?:iPhone|iPad|iPod).*?OS\s+([0-9_]+)/.exec(ua)
  const androidMatch = /Android\s+([0-9.]+)/.exec(ua)
  const chromeMatch = /Chrome\/([0-9.]+)/.exec(ua)
  const criosMatch = /CriOS\/([0-9.]+)/.exec(ua)
  const firefoxMatch = /FxiOS\/([0-9.]+)/.exec(ua)
  const safariMatch = /Version\/([0-9.]+)/.exec(ua)
  const bits = []
  if (iosMatch) bits.push(`iOS ${iosMatch[1].replaceAll('_', '.')}`)
  else if (androidMatch) bits.push(`Android ${androidMatch[1]}`)
  if (criosMatch) bits.push(`Chrome ${criosMatch[1].split('.')[0]}`)
  else if (firefoxMatch) bits.push(`Firefox ${firefoxMatch[1].split('.')[0]}`)
  else if (chromeMatch && !iosMatch) bits.push(`Chrome ${chromeMatch[1].split('.')[0]}`)
  else if (safariMatch && (iosMatch || /Macintosh/.test(ua))) bits.push(`Safari ${safariMatch[1].split('.')[0]}`)
  return bits.length > 0 ? bits.join(' · ') : 'Mobile Browser'
}

export function formatInjectionSummary(snapshot) {
  const chars = typeof snapshot?.injectedChars === 'number' ? snapshot.injectedChars : 0
  const keys = typeof snapshot?.injectedKeys === 'number' ? snapshot.injectedKeys : 0
  return `${chars} chars · ${keys} keys sent`
}