import type { BrowserExtensionRecord } from '../../shared/browser-platform.js'

const DOCUMENTED_PERMISSION_APIS = new Set([
  'management',
  'scripting',
  'storage',
  'tabs',
  'webRequest',
  'webRequestBlocking',
])

// Not in Electron's documented subset, but measured working in ND's own browser
// runtime: declarative rules load, enable, and block requests.
const RUNTIME_VERIFIED_PERMISSION_APIS = new Set([
  'declarativeNetRequest',
])

const DOCUMENTED_MANIFEST_KEYS = new Set([
  'name',
  'version',
  'author',
  'permissions',
  'content_scripts',
  'default_locale',
  'devtools_page',
  'short_name',
  'host_permissions',
  'manifest_version',
  'background',
  'minimum_chrome_version',
])

const RUNTIME_VERIFIED_MANIFEST_KEYS = new Set([
  'declarative_net_request',
])

// Metadata does not itself require a Chrome extension API implementation.
const PASSIVE_METADATA_KEYS = new Set([
  'description',
  'icons',
  'homepage_url',
  'update_url',
  'key',
])

// ND supplies the browser-chrome host for these even though Electron does not
// advertise chrome.action/browserAction as a supported API.
const ND_HOSTED_ACTION_KEYS = new Set([
  'action',
  'browser_action',
  'page_action',
])

export interface BrowserExtensionCompatibility {
  status: BrowserExtensionRecord['status']
  notes: string[]
}

export function analyzeBrowserExtensionManifest(manifest: Record<string, unknown>): BrowserExtensionCompatibility {
  const notes: string[] = []
  const manifestVersion = typeof manifest.manifest_version === 'number'
    ? manifest.manifest_version
    : undefined

  if (manifestVersion !== 2 && manifestVersion !== 3) {
    notes.push('Manifest version is not MV2 or MV3.')
  }

  const permissions = stringArray(manifest.permissions)
  const unknownPermissions = permissions
    .filter((permission) => !isHostPattern(permission))
    .filter((permission) => !DOCUMENTED_PERMISSION_APIS.has(permission))
    .filter((permission) => !RUNTIME_VERIFIED_PERMISSION_APIS.has(permission))
  if (unknownPermissions.length > 0) {
    notes.push(`Electron does not document support for permission APIs: ${unique(unknownPermissions).join(', ')}.`)
  }

  const functionalKeys = Object.keys(manifest)
    .filter((key) => !DOCUMENTED_MANIFEST_KEYS.has(key))
    .filter((key) => !RUNTIME_VERIFIED_MANIFEST_KEYS.has(key))
    .filter((key) => !PASSIVE_METADATA_KEYS.has(key))
    .filter((key) => !ND_HOSTED_ACTION_KEYS.has(key))

  if (functionalKeys.length > 0) {
    notes.push(`Manifest features outside Electron's documented extension subset: ${unique(functionalKeys).join(', ')}.`)
  }

  if (!permissions.includes('tabs')) {
    notes.push('ND cannot hide open tab URLs and titles from this extension: Electron returns them from chrome.tabs.query without the tabs permission.')
  }

  const action = objectValue(manifest.action)
    ?? objectValue(manifest.browser_action)
    ?? objectValue(manifest.page_action)
  if (action && typeof action.default_popup === 'string' && action.default_popup.trim()) {
    notes.push('Action popup is hosted by ND inside the built-in browser; chrome.action itself is not claimed as a supported Electron API.')
  } else if (action) {
    notes.push('Extension action has no default popup; chrome.action.onClicked is not hosted by ND yet.')
  }

  return {
    status: notes.some((note) =>
      note.startsWith('Electron does not document support')
      || note.startsWith('Manifest features outside')
      || note.startsWith('Manifest version is not')
      || note.startsWith('MV3 background service workers are treated as provisional')
      || note.startsWith('Extension action has no default popup'))
      ? 'limited'
      : 'compatible',
    notes,
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isHostPattern(value: string): boolean {
  return value === '<all_urls>'
    || value.includes('://')
    || value.startsWith('*://')
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
}
