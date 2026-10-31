import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BrowserSafeModeConfig } from '../../shared/browser-platform.js'

interface PersistedSafeMode {
  version: 1
  enabled: boolean
}

export interface PrivacyHeaderInput {
  requestHeaders: Record<string, string>
  initiatorUrl?: string
  targetUrl: string
}

export interface TrackerBlockInput {
  url: string
  initiatorUrl?: string
  resourceType: string
}

const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'net.uk', 'sch.uk',
  'co.jp', 'ne.jp', 'or.jp', 'go.jp', 'ac.jp',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in',
  'co.za', 'org.za', 'web.za',
  'com.br', 'net.br', 'org.br',
  'com.mx', 'org.mx', 'gob.mx',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.hk', 'org.hk', 'net.hk', 'gov.hk', 'edu.hk',
  'com.sg', 'net.sg', 'org.sg', 'gov.sg', 'edu.sg',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr',
  'com.tw', 'org.tw', 'gov.tw', 'edu.tw',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr',
  'com.ar', 'net.ar', 'org.ar',
  'com.co', 'net.co', 'nom.co',
])

// A deliberately conservative third-party tracker set. Safe Mode is opt-in and
// experimental, so false positives matter more than exhaustive coverage.
const TRACKER_DOMAINS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'googletagmanager.com', 'adservice.google.com', 'analytics.google.com', 'googleoptimize.com',
  'facebook.net', 'an.facebook.com', 'connect.facebook.net',
  'scorecardresearch.com', 'quantserve.com', 'quantcount.com',
  'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'zemanta.com',
  'hotjar.com', 'hotjar.io', 'fullstory.com', 'mouseflow.com', 'crazyegg.com', 'clicktale.net',
  'mixpanel.com', 'amplitude.com', 'segment.com', 'segment.io', 'segmentcdn.com',
  'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'casalemedia.com',
  '33across.com', 'sharethrough.com', 'indexww.com', 'mediamath.com', 'mathtag.com',
  'amazon-adsystem.com', 'adsrvr.org', 'bidswitch.net', 'teads.tv', 'smartadserver.com',
  'spotxchange.com', 'spotx.tv', 'moatads.com', 'chartbeat.com', 'parsely.com',
  'appsflyer.com', 'adjust.com', 'singular.net', 'kochava.com',
  'mc.yandex.com', 'mc.yandex.ru', 'yandex.ru/metrika', 'bat.bing.com', 'analytics.tiktok.com',
]

const GPU_PROFILES = [
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
] as const

/**
 * Durable, default-off setting for ND's built-in browser.
 *
 * The file stores only a boolean; fingerprint material is derived per profile
 * and never persisted, so deleting a profile also removes its noise identity.
 */
export class BrowserSafeModeStore {
  private enabledValue = false

  constructor(private readonly filePath: string, private readonly log: (line: string) => void = () => undefined) {
    this.load()
  }

  enabled(): boolean {
    return this.enabledValue
  }

  setEnabled(enabled: boolean): void {
    if (this.enabledValue === enabled) return
    this.enabledValue = enabled
    this.persist()
  }

  configForProfile(profileId: string): BrowserSafeModeConfig {
    const seed = seedForProfile(profileId)
    const gpu = GPU_PROFILES[seed % GPU_PROFILES.length] ?? GPU_PROFILES[0]!
    return {
      enabled: this.enabledValue,
      seed,
      gpuVendor: gpu.vendor,
      gpuRenderer: gpu.renderer,
    }
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PersistedSafeMode>
      this.enabledValue = parsed.version === 1 && parsed.enabled === true
    } catch (error) {
      this.log(`[browser-safe-mode] ignoring unreadable setting: ${error instanceof Error ? error.message : String(error)}`)
      this.enabledValue = false
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
      const payload: PersistedSafeMode = { version: 1, enabled: this.enabledValue }
      try {
        writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        renameSync(tmp, this.filePath)
      } finally {
        if (existsSync(tmp)) rmSync(tmp, { force: true })
      }
      if (process.platform !== 'win32') {
        try {
          chmodSync(this.filePath, 0o600)
        } catch {
          // Filesystem may already enforce the requested mode.
        }
      }
    } catch (error) {
      this.log(`[browser-safe-mode] could not persist setting: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export function seedForProfile(profileId: string): number {
  const digest = createHash('sha256').update(`nd-browser-safe-mode-v1:${profileId}`).digest()
  return digest.readUInt32LE(0) || 1
}

export function registrableSite(value: string | undefined): string | undefined {
  if (!value) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return host
  const labels = host.split('.').filter(Boolean)
  if (labels.length <= 2) return host
  const lastTwo = labels.slice(-2).join('.')
  if (MULTI_PART_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join('.')
  return lastTwo
}

export function requestOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin.toLowerCase()
  } catch {
    return undefined
  }
}

export function isThirdPartyRequest(initiatorUrl: string | undefined, targetUrl: string): boolean {
  const initiator = registrableSite(initiatorUrl)
  const target = registrableSite(targetUrl)
  return Boolean(initiator && target && initiator !== target)
}

export function isTrackerUrl(value: string): boolean {
  const site = registrableSite(value)
  if (!site) return false
  let host: string
  try {
    host = new URL(value).hostname.toLowerCase()
  } catch {
    return false
  }
  return TRACKER_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`) || value.includes(`/${domain}/`))
}

export function shouldBlockTrackerRequest(input: TrackerBlockInput): boolean {
  if (input.resourceType === 'mainFrame') return false
  if (!isThirdPartyRequest(input.initiatorUrl, input.url)) return false
  return isTrackerUrl(input.url)
}

export function privacyRequestHeaders(input: PrivacyHeaderInput): Record<string, string> {
  const headers: Record<string, string> = { ...input.requestHeaders }
  const lowerKey = (name: string): string => Object.keys(headers).find((key) => key.toLowerCase() === name) ?? name
  const thirdParty = isThirdPartyRequest(input.initiatorUrl, input.targetUrl)
  const crossOrigin = requestOrigin(input.initiatorUrl) !== undefined
    && requestOrigin(input.initiatorUrl) !== requestOrigin(input.targetUrl)
  if (thirdParty) {
    for (const key of ['cookie', 'referer']) {
      const actual = lowerKey(key)
      delete headers[actual]
    }
  } else if (crossOrigin) {
    delete headers[lowerKey('referer')]
  }
  headers.DNT = '1'
  headers['Sec-GPC'] = '1'
  return headers
}
