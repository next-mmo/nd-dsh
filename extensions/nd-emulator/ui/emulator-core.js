/**
 * ND Emulator — pure logic module (no DOM, no bridge).
 *
 * Exported helpers are used by the web view and can be tested independently.
 */

/**
 * Parse the device list response into a normalized array.
 * @param {unknown} value — raw host method response
 * @returns {{ serial: string; type: string; model: string; product: string; transportId: string }[]}
 */
export function parseDeviceList(value) {
  if (!value || typeof value !== 'object') return []
  const valObj = /** @type {Record<string, unknown>} */ (value)
  const list = Array.isArray(valObj) ? valObj : Array.isArray(valObj.devices) ? valObj.devices : []
  return list.map((item) => {
    const obj = item && typeof item === 'object' ? item : {}
    return {
      serial: String(obj.serial ?? obj.id ?? ''),
      type: String(obj.type ?? obj.state ?? 'unknown'),
      model: String(obj.model ?? obj.name ?? ''),
      product: String(obj.product ?? ''),
      transportId: String(obj.transportId ?? ''),
    }
  }).filter((d) => d.serial.length > 0)
}

/**
 * Build a human-readable device info line.
 * @param {{ serial: string; type: string; model: string; product: string }} device
 * @returns {string}
 */
export function formatDeviceInfo(device) {
  const parts = []
  if (device.serial) parts.push(device.serial)
  if (device.product) parts.push(device.product)
  if (device.serial.includes(':')) parts.push('Wireless')
  else if (device.type === 'device') parts.push('USB')
  else if (device.type) parts.push(device.type)
  return parts.join(' · ')
}

/**
 * Format current time as HH:MM:SS for logs.
 * @returns {string}
 */
export function formatTimestamp() {
  const now = new Date()
  return now.toLocaleTimeString('en-US', { hour12: false })
}
