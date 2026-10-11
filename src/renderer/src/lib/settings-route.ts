export type SettingsTab = 'general' | 'appearance' | 'models' | 'capabilities' | 'extensions' | 'plugins' | 'engines' | 'presets'
export type GeneralSubTab = 'runtime' | 'workspace' | 'browser' | 'shortcuts' | 'about'
export type CapabilitySubTab = 'engine' | 'memory' | 'context' | 'lifecycle'
export type EnginesSubTab = 'engines' | 'gateway' | 'tokens'

export interface LocationLike {
  hash: string
  search: string
}

const TAB_QUERY: Record<SettingsTab, string> = {
  general: 'general',
  appearance: 'appearance',
  models: 'model',
  capabilities: 'capabilities',
  extensions: 'extensions',
  plugins: 'plugins',
  engines: 'engines',
  presets: 'presets',
}

const QUERY_TAB = new Map<string, SettingsTab>([
  ['general', 'general'],
  ['appearance', 'appearance'],
  ['model', 'models'],
  ['models', 'models'],
  ['capability', 'capabilities'],
  ['capabilities', 'capabilities'],
  ['plugin', 'plugins'],
  ['plugins', 'plugins'],
  ['extension', 'extensions'],
  ['extensions', 'extensions'],
  ['engine', 'engines'],
  ['engines', 'engines'],
  ['preset', 'presets'],
  ['presets', 'presets'],
  ['workspace', 'general'],
  ['runtime', 'general'],
  ['browser', 'general'],
  ['shortcuts', 'general'],
  ['about', 'general'],
])

const QUERY_SUBTAB = new Map<string, GeneralSubTab>([
  ['workspace', 'workspace'],
  ['runtime', 'runtime'],
  ['browser', 'browser'],
  ['shortcuts', 'shortcuts'],
  ['about', 'about'],
])

const QUERY_CAPABILITY_SUBTAB = new Map<string, CapabilitySubTab>([
  ['engine', 'engine'],
  ['engines', 'engine'],
  ['memory', 'memory'],
  ['context', 'context'],
  ['lifecycle', 'lifecycle'],
])

const QUERY_ENGINES_SUBTAB = new Map<string, EnginesSubTab>([
  ['engines', 'engines'],
  ['gateway', 'gateway'],
  ['tokens', 'tokens'],
  ['token', 'tokens'],
])

export function settingsHash(tab: SettingsTab, subtab?: GeneralSubTab | CapabilitySubTab | EnginesSubTab): string {
  if (tab === 'general' && subtab && subtab !== 'runtime') {
    return `#/settings?tab=general&subtab=${subtab}`
  }
  if (tab === 'capabilities' && subtab && subtab !== 'engine') {
    return `#/settings?tab=capabilities&subtab=${subtab}`
  }
  if (tab === 'engines' && subtab && subtab !== 'engines') {
    return `#/settings?tab=engines&subtab=${subtab}`
  }
  return `#/settings?tab=${TAB_QUERY[tab]}`
}

function getGlobalLocation(): LocationLike {
  const g = globalThis as { location?: LocationLike }
  return g.location ?? { hash: '', search: '' }
}

export function settingsTabFromLocation(location?: LocationLike): SettingsTab {
  const loc = location ?? getGlobalLocation()
  const hashQuery = loc.hash.includes('?') ? loc.hash.slice(loc.hash.indexOf('?') + 1) : ''
  const value = new URLSearchParams(hashQuery).get('tab')
    ?? new URLSearchParams(loc.search).get('tab')
  return QUERY_TAB.get(value?.trim().toLowerCase() ?? '') ?? 'general'
}

export function generalSubTabFromLocation(location?: LocationLike): GeneralSubTab {
  const loc = location ?? getGlobalLocation()
  const hashQuery = loc.hash.includes('?') ? loc.hash.slice(loc.hash.indexOf('?') + 1) : ''
  const subtabValue = new URLSearchParams(hashQuery).get('subtab')
    ?? new URLSearchParams(loc.search).get('subtab')
  if (subtabValue) {
    const match = QUERY_SUBTAB.get(subtabValue.trim().toLowerCase())
    if (match) return match
  }
  const tabValue = new URLSearchParams(hashQuery).get('tab')
    ?? new URLSearchParams(loc.search).get('tab')
  if (tabValue) {
    const match = QUERY_SUBTAB.get(tabValue.trim().toLowerCase())
    if (match) return match
  }
  return 'runtime'
}

export function capabilitySubTabFromLocation(location?: LocationLike): CapabilitySubTab {
  const loc = location ?? getGlobalLocation()
  const hashQuery = loc.hash.includes('?') ? loc.hash.slice(loc.hash.indexOf('?') + 1) : ''
  const subtabValue = new URLSearchParams(hashQuery).get('subtab')
    ?? new URLSearchParams(loc.search).get('subtab')
  if (subtabValue) {
    const match = QUERY_CAPABILITY_SUBTAB.get(subtabValue.trim().toLowerCase())
    if (match) return match
  }
  return 'engine'
}

export function enginesSubTabFromLocation(location?: LocationLike): EnginesSubTab {
  const loc = location ?? getGlobalLocation()
  const hashQuery = loc.hash.includes('?') ? loc.hash.slice(loc.hash.indexOf('?') + 1) : ''
  const subtabValue = new URLSearchParams(hashQuery).get('subtab')
    ?? new URLSearchParams(loc.search).get('subtab')
  if (subtabValue) {
    const match = QUERY_ENGINES_SUBTAB.get(subtabValue.trim().toLowerCase())
    if (match) return match
  }
  return 'engines'
}
