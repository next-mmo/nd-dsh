import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BrowserSafeModeStore,
  isThirdPartyRequest,
  privacyRequestHeaders,
  registrableSite,
  shouldBlockTrackerRequest,
} from '../src/main/browser/browser-safe-mode.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempPath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nd-browser-safe-mode-'))
  roots.push(root)
  return join(root, name)
}

describe('BrowserSafeModeStore', () => {
  it('is off by default and persists the explicit choice', async () => {
    const path = await tempPath('browser-safe-mode.json')
    const first = new BrowserSafeModeStore(path)
    expect(first.enabled()).toBe(false)

    first.setEnabled(true)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, enabled: true })
    expect(new BrowserSafeModeStore(path).enabled()).toBe(true)
  })

  it('derives a stable identity per profile without making profiles identical', () => {
    const store = new BrowserSafeModeStore('unused')
    const one = store.configForProfile('profile-one')
    const two = store.configForProfile('profile-two')
    expect(store.configForProfile('profile-one')).toEqual(one)
    expect(one.enabled).toBe(false)
    expect(one.seed).toBeGreaterThan(0)
    expect(two.seed).not.toBe(one.seed)
    expect(one.gpuVendor).toMatch(/^Google Inc\./)
    expect(one.gpuRenderer).toContain('ANGLE')
  })
})

describe('Browser Safe Mode request policy', () => {
  it('uses registrable sites rather than full hosts', () => {
    expect(registrableSite('https://app.example.co.uk/path')).toBe('example.co.uk')
    expect(registrableSite('https://cdn.example.com/path')).toBe('example.com')
    expect(isThirdPartyRequest('https://app.example.com', 'https://cdn.example.com/image.png')).toBe(false)
    expect(isThirdPartyRequest('https://app.example.com', 'https://tracker.example.org/beacon')).toBe(true)
  })

  it('blocks only third-party tracker requests and leaves top-level navigation alone', () => {
    expect(shouldBlockTrackerRequest({
      url: 'https://analytics.example.com/collect',
      initiatorUrl: 'https://site.test/',
      resourceType: 'script',
    })).toBe(false)
    expect(shouldBlockTrackerRequest({
      url: 'https://www.google-analytics.com/collect',
      initiatorUrl: 'https://site.test/',
      resourceType: 'script',
    })).toBe(true)
    expect(shouldBlockTrackerRequest({
      url: 'https://www.google-analytics.com/',
      resourceType: 'mainFrame',
    })).toBe(false)
  })

  it('strips third-party cookies and cross-site referrers while advertising GPC', () => {
    const headers = privacyRequestHeaders({
      requestHeaders: {
        Cookie: 'session=secret',
        Referer: 'https://site.test/private',
        Accept: '*/*',
      },
      initiatorUrl: 'https://site.test/page',
      targetUrl: 'https://other.test/api',
    })
    expect(headers.Cookie).toBeUndefined()
    expect(headers.cookie).toBeUndefined()
    expect(headers.Referer).toBeUndefined()
    expect(headers.referer).toBeUndefined()
    expect(headers.Accept).toBe('*/*')
    expect(headers.DNT).toBe('1')
    expect(headers['Sec-GPC']).toBe('1')
  })
})
