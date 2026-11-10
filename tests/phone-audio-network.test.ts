import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  classifyRemoteTransport,
  discoverRawInterfaces,
  isAllowedLocalRemoteIp,
} from '../src/main/extensions/phone-audio-network.js'

function ipv4(address: string, netmask = '255.255.255.0', mac = 'aa:bb:cc:dd:ee:01', internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask,
    family: 'IPv4',
    mac,
    internal,
    cidr: `${address}/24`,
  }
}

describe('Phone Audio network interface discovery and security checks', () => {
  it('filters virtual/loopback/APIPA adapters and prioritizes USB tethering and Wi-Fi', () => {
    const sample: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      'Loopback Pseudo-Interface 1': [ipv4('127.0.0.1', '255.0.0.0', '00:00:00:00:00:00', true)],
      'vEthernet (Default Switch)': [ipv4('172.30.48.1', '255.255.240.0', '00:15:5d:6e:94:b4')],
      'vEthernet (WSL (Hyper-V firewall))': [ipv4('172.18.0.1', '255.255.240.0', '00:15:5d:01:f5:e2')],
      'VMware Network Adapter VMnet8': [ipv4('192.168.159.1', '255.255.255.0', '00:50:56:c0:00:08')],
      'Bluetooth Network Connection': [ipv4('192.168.5.1')],
      'Ethernet 3': [ipv4('169.254.12.34', '255.255.0.0')],
      'Ethernet': [ipv4('192.168.1.98')],
      'Wi-Fi': [ipv4('192.168.1.100')],
      'Remote NDIS based Internet Sharing Device': [ipv4('192.168.42.129')],
    }

    const discovered = discoverRawInterfaces(sample)
    expect(discovered.map((d) => [d.kind, d.address])).toEqual([
      ['usb', '192.168.42.129'],
      ['wifi', '192.168.1.100'],
      ['ethernet', '192.168.1.98'],
    ])
  })

  it('allows only local/private remote IPs and classifies transport by subnet', () => {
    expect(isAllowedLocalRemoteIp('127.0.0.1')).toBe(true)
    expect(isAllowedLocalRemoteIp('::ffff:192.168.1.101')).toBe(true)
    expect(isAllowedLocalRemoteIp('192.168.42.55')).toBe(true)
    expect(isAllowedLocalRemoteIp('10.0.0.42')).toBe(true)
    expect(isAllowedLocalRemoteIp('172.16.5.9')).toBe(true)
    expect(isAllowedLocalRemoteIp('8.8.8.8')).toBe(false)
    expect(isAllowedLocalRemoteIp('172.32.0.1')).toBe(false)
    expect(isAllowedLocalRemoteIp('')).toBe(false)

    const ifaces = discoverRawInterfaces({
      'Wi-Fi': [ipv4('192.168.1.100')],
      'USB RNDIS': [ipv4('192.168.42.129')],
    })
    expect(classifyRemoteTransport('::ffff:192.168.1.101', ifaces)).toBe('wifi')
    expect(classifyRemoteTransport('192.168.42.200', ifaces)).toBe('usb')
    expect(classifyRemoteTransport('10.10.10.10', ifaces)).toBe('unknown')
  })
})
