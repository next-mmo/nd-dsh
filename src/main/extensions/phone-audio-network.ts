import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type { PhoneAudioInterfaceInfo, PhoneAudioTransportKind } from '../../shared/phone-audio.js'

const VIRTUAL_ADAPTER_PATTERN =
  /vethernet|hyper-v|\bwsl\b|default switch|vmware|vmnet|virtualbox|vboxnet|docker|tailscale|wireguard|zerotier|tap-windows|hamachi|npcap|bluetooth|teredo|isatap|loopback|km-test|miniport/i

const VIRTUAL_MAC_PREFIXES = [
  '00:15:5d:', // Microsoft Hyper-V
  '00:50:56:', // VMware
  '00:0c:29:', // VMware
  '00:05:69:', // VMware
  '08:00:27:', // VirtualBox
  '0a:00:27:', // VirtualBox Host-Only
]

const USB_ADAPTER_PATTERN =
  /rndis|remote ndis|\busb\b|android|tether|\bncm\b|\becm\b|mobile|cellular|pixel|galaxy|xiaomi|oneplus/i

const WIFI_ADAPTER_PATTERN = /wi-?fi|wlan|wireless|802\.11/i

export interface RawDiscoveredInterface {
  id: string
  name: string
  address: string
  netmask: string
  cidr: string
  kind: PhoneAudioTransportKind
  label: string
}

export function isVirtualAdapterName(name: string): boolean {
  return VIRTUAL_ADAPTER_PATTERN.test(name)
}

export function isVirtualMac(mac: string | undefined): boolean {
  if (!mac) return false
  const lower = mac.toLowerCase()
  return VIRTUAL_MAC_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

export function isUsableLocalIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  if (a === 127) return false // loopback
  if (a === 169 && b === 254) return false // APIPA link-local
  if (a === 0) return false
  // Private RFC1918 + CGNAT-style local tethering ranges
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

export function classifyTransportKind(name: string, address: string): PhoneAudioTransportKind {
  if (USB_ADAPTER_PATTERN.test(name)) return 'usb'
  // Android RNDIS tethering commonly uses 192.168.42.x; Windows USB/ICS often uses 192.168.137.x
  if (address.startsWith('192.168.42.') || address.startsWith('192.168.137.')) return 'usb'
  if (WIFI_ADAPTER_PATTERN.test(name)) return 'wifi'
  return 'ethernet'
}

function transportDisplayLabel(kind: PhoneAudioTransportKind, name: string): string {
  if (kind === 'usb') return `USB Tethering (${name})`
  if (kind === 'wifi') return `Wi-Fi (${name})`
  return `LAN / Ethernet (${name})`
}

function kindPriority(kind: PhoneAudioTransportKind): number {
  if (kind === 'usb') return 0
  if (kind === 'wifi') return 1
  return 2
}

/**
 * Enumerate usable IPv4 interfaces on Windows/desktop hosts while filtering out
 * loopback, APIPA link-local, and virtual adapters (WSL, Hyper-V, VMware, etc.).
 */
export function discoverRawInterfaces(
  map: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): RawDiscoveredInterface[] {
  const discovered: RawDiscoveredInterface[] = []
  const seenAddresses = new Set<string>()

  for (const [name, entries] of Object.entries(map)) {
    if (!entries || isVirtualAdapterName(name)) continue
    for (const entry of entries) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (isVirtualMac(entry.mac)) continue
      if (!isUsableLocalIpv4(entry.address)) continue
      if (seenAddresses.has(entry.address)) continue
      seenAddresses.add(entry.address)

      const kind = classifyTransportKind(name, entry.address)
      discovered.push({
        id: `${kind}:${entry.address}`,
        name,
        address: entry.address,
        netmask: entry.netmask || '255.255.255.0',
        cidr: entry.cidr || `${entry.address}/24`,
        kind,
        label: transportDisplayLabel(kind, name),
      })
    }
  }

  discovered.sort((a, b) => {
    const diff = kindPriority(a.kind) - kindPriority(b.kind)
    if (diff !== 0) return diff
    return a.name.localeCompare(b.name) || a.address.localeCompare(b.address)
  })

  return discovered
}

export function buildConnectionUrl(address: string, port: number, token: string): string {
  return `http://${address}:${port}/?token=${encodeURIComponent(token)}`
}

export async function discoverPhoneAudioInterfaces(
  port: number,
  token: string,
  renderQrSvg: (url: string) => Promise<string>,
  map?: NodeJS.Dict<NetworkInterfaceInfo[]>,
): Promise<PhoneAudioInterfaceInfo[]> {
  const raw = discoverRawInterfaces(map)
  const results: PhoneAudioInterfaceInfo[] = []
  for (const item of raw) {
    const url = buildConnectionUrl(item.address, port, token)
    const qrSvg = await renderQrSvg(url)
    results.push({ ...item, url, qrSvg })
  }
  return results
}

export function normalizeRemoteIp(rawIp: string | undefined): string {
  if (!rawIp) return ''
  const trimmed = rawIp.trim()
  if (trimmed.startsWith('::ffff:')) return trimmed.slice('::ffff:'.length)
  return trimmed
}

/**
 * Only permit connections coming from loopback, RFC1918 LAN, or IPv6 ULA/link-local.
 * Public routable clients are always rejected.
 */
export function isAllowedLocalRemoteIp(rawIp: string | undefined): boolean {
  const ip = normalizeRemoteIp(rawIp)
  if (!ip) return false
  if (ip === '::1') return true
  const lower = ip.toLowerCase()
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) return true

  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  if (a === 127) return true
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  const [a, b, c, d] = parts as [number, number, number, number]
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0
}

export function classifyRemoteTransport(
  rawIp: string | undefined,
  interfaces: readonly Pick<RawDiscoveredInterface, 'address' | 'netmask' | 'kind'>[],
): PhoneAudioTransportKind | 'unknown' {
  const ip = normalizeRemoteIp(rawIp)
  const ipInt = ipv4ToInt(ip)
  if (ipInt === null) return 'unknown'
  for (const iface of interfaces) {
    const ifaceInt = ipv4ToInt(iface.address)
    const maskInt = ipv4ToInt(iface.netmask)
    if (ifaceInt === null || maskInt === null) continue
    if (((ipInt & maskInt) >>> 0) === ((ifaceInt & maskInt) >>> 0)) {
      return iface.kind
    }
  }
  return 'unknown'
}
