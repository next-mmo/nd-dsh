import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeBrowserExtensionManifest } from '../src/main/browser/browser-extension-compatibility.js'

describe('browser extension compatibility analyzer', () => {
  it('marks the documented Electron subset compatible', () => {
    const result = analyzeBrowserExtensionManifest({
      manifest_version: 3,
      name: 'Supported',
      version: '1.0.0',
      permissions: ['storage', 'scripting', 'tabs', 'webRequest'],
      host_permissions: ['https://example.com/*'],
      content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }],
    })
    expect(result.status).toBe('compatible')
    expect(result.notes).toEqual([])
  })

  it('keeps an ND-hosted action popup compatible while explaining the host boundary', () => {
    const result = analyzeBrowserExtensionManifest({
      manifest_version: 3,
      name: 'Popup',
      version: '1.0.0',
      permissions: ['storage'],
      action: {
        default_title: 'Popup',
        default_popup: 'popup.html',
      },
    })
    expect(result.status).toBe('compatible')
    expect(result.notes).toContain(
      'Action popup is hosted by ND inside the built-in browser; chrome.action itself is not claimed as a supported Electron API.',
    )
  })


  it('marks click-only browser actions limited until ND hosts action.onClicked', () => {
    const result = analyzeBrowserExtensionManifest({
      manifest_version: 3,
      name: 'Click action',
      version: '1.0.0',
      action: {
        default_title: 'Run',
      },
    })
    expect(result.status).toBe('limited')
    expect(result.notes.join(' ')).toContain('chrome.action.onClicked')
  })

  it('marks undocumented permission APIs limited', () => {
    const result = analyzeBrowserExtensionManifest({
      manifest_version: 3,
      name: 'Identity extension',
      version: '1.0.0',
      permissions: ['storage', 'identity', 'notifications'],
    })
    expect(result.status).toBe('limited')
    expect(result.notes.join(' ')).toContain('identity')
    expect(result.notes.join(' ')).toContain('notifications')
  })

  it('marks functional manifest features outside the documented subset limited', () => {
    const result = analyzeBrowserExtensionManifest({
      manifest_version: 3,
      name: 'Side panel',
      version: '1.0.0',
      side_panel: { default_path: 'side.html' },
    })
    expect(result.status).toBe('limited')
    expect(result.notes.join(' ')).toContain('side_panel')
  })

  it('discloses tab URL visibility without changing status when the tabs permission is absent', () => {
    const result = analyzeBrowserExtensionManifest({
      manifest_version: 3,
      name: 'Storage only',
      version: '1.0.0',
      permissions: ['storage'],
    })
    expect(result.status).toBe('compatible')
    expect(result.notes.join(' ')).toContain('cannot hide open tab URLs and titles')
  })

  it('accepts MV3 service workers, which the built-in runtime probe exercises', () => {
    const result = analyzeBrowserExtensionManifest({
      manifest_version: 3,
      name: 'Worker',
      version: '1.0.0',
      background: { service_worker: 'worker.js' },
    })
    // tests/fixtures/browser-runtime-spike/extensions/mv3-service-worker records
    // runtime messaging working on this Electron build, so a worker alone no
    // longer downgrades an extension to limited.
    expect(result.status).toBe('compatible')
    expect(result.notes.join(' ')).not.toContain('provisional')
  })

  it('accepts declarative rules, which the built-in runtime applies', () => {
    const result = analyzeBrowserExtensionManifest({
      manifest_version: 3,
      name: 'Blocklist',
      version: '1.0.0',
      permissions: ['declarativeNetRequest', 'storage', 'tabs'],
      declarative_net_request: {
        rule_resources: [{ id: 'ads', enabled: true, path: 'rules/ads.json' }],
      },
    })
    expect(result.status).toBe('compatible')
    expect(result.notes.join(' ')).not.toContain('declarativeNetRequest')
    expect(result.notes.join(' ')).not.toContain('declarative_net_request')
  })
})


describe('bundled ND browser extension', () => {
  it('keeps the first-party Method 2 extension inside the supported subset', () => {
    const path = resolve(process.cwd(), 'resources/browser-extensions/nd-browser-tools/manifest.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const result = analyzeBrowserExtensionManifest(manifest)
    expect(result.status).toBe('compatible')
    expect(result.notes.join(' ')).toContain('Action popup is hosted by ND')
  })
})
