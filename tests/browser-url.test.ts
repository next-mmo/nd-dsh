import { describe, expect, it } from 'vitest'
import { DEFAULT_BROWSER_URL, isNavigationAbortedError, normalizeBrowserUrl, sanitizeBrowserUserAgent } from '../src/main/browser/browser-url.js'

describe('normalizeBrowserUrl', () => {
  it('uses the local development URL for blank input', () => {
    expect(normalizeBrowserUrl('   ')).toBe(DEFAULT_BROWSER_URL)
  })

  it('uses HTTP for loopback hosts without an explicit scheme', () => {
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173/')
    expect(normalizeBrowserUrl('127.0.0.1:4173/app')).toBe('http://127.0.0.1:4173/app')
    expect(normalizeBrowserUrl('localhost:5173?view=browser')).toBe('http://localhost:5173/?view=browser')
    expect(normalizeBrowserUrl('127.0.0.1:4173#ready')).toBe('http://127.0.0.1:4173/#ready')
  })

  it('uses HTTPS for ordinary hosts and host-port pairs', () => {
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com/')
    expect(normalizeBrowserUrl('example.com:8443/app')).toBe('https://example.com:8443/app')
    expect(normalizeBrowserUrl('example.com:8443?mode=test')).toBe('https://example.com:8443/?mode=test')
  })

  it('preserves explicitly allowed protocols', () => {
    expect(normalizeBrowserUrl('https://example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeBrowserUrl('about:blank')).toBe('about:blank')
  })

  it('rejects unsupported explicit protocols', () => {
    expect(() => normalizeBrowserUrl('file:///tmp/secret')).toThrow(/Unsupported browser protocol/)
    expect(() => normalizeBrowserUrl('javascript:alert(1)')).toThrow(/Unsupported browser protocol/)
    expect(() => normalizeBrowserUrl('about:downloads')).toThrow(/Unsupported browser protocol/)
  })
})

describe('sanitizeBrowserUserAgent', () => {
  it('removes only the Electron runtime token', () => {
    expect(sanitizeBrowserUserAgent('Mozilla/5.0 Chrome/134.0.0.0 Safari/537.36 Electron/43.4.0')).toBe('Mozilla/5.0 Chrome/134.0.0.0 Safari/537.36')
    expect(sanitizeBrowserUserAgent('Mozilla/5.0 Chrome/134.0.0.0 Safari/537.36')).toBe('Mozilla/5.0 Chrome/134.0.0.0 Safari/537.36')
  })
})

describe('isNavigationAbortedError', () => {
  it('recognizes Electron ERR_ABORTED (-3) loadURL rejections', () => {
    const byCode = Object.assign(new Error("ERR_ABORTED (-3) loading 'https://www.youtube.com/?themeRefresh=1'"), {
      errno: -3,
      code: 'ERR_ABORTED',
    })
    expect(isNavigationAbortedError(byCode)).toBe(true)
    expect(isNavigationAbortedError(new Error("ERR_ABORTED (-3) loading 'https://www.youtube.com/?themeRefresh=1'"))).toBe(true)
  })

  it('does not swallow genuine network or navigation errors', () => {
    const dnsError = Object.assign(new Error("ERR_NAME_NOT_RESOLVED (-105) loading 'https://invalid.example/'"), {
      errno: -105,
      code: 'ERR_NAME_NOT_RESOLVED',
    })
    expect(isNavigationAbortedError(dnsError)).toBe(false)
    expect(isNavigationAbortedError(new Error('Unsupported browser protocol: file:'))).toBe(false)
    expect(isNavigationAbortedError(null)).toBe(false)
  })
})
