import type { CapabilitySubTab, EnginesSubTab, GeneralSubTab, SettingsTab } from './settings-route.js'

export interface SettingsSearchEntry {
  id: string
  title: string
  section: string
  tab: SettingsTab
  subTab?: GeneralSubTab
  capabilitySubTab?: CapabilitySubTab
  enginesSubTab?: EnginesSubTab
  keywords: string[]
}

/**
 * Flat registry of every settings destination so the sidebar search can jump
 * straight to the right tab. Keep entries in sync when a new settings surface
 * is added.
 */
export const SETTINGS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  { id: 'general-runtime', title: 'Runtime status', section: 'General · Runtime', tab: 'general', subTab: 'runtime', keywords: ['runtime', 'harness', 'session', 'model route', 'status', 'provider'] },
  { id: 'general-workspace', title: 'Workspace folder', section: 'General · Workspace', tab: 'general', subTab: 'workspace', keywords: ['workspace', 'folder', 'project', 'path'] },
  { id: 'general-browser', title: 'Built-in browser', section: 'General · Browser', tab: 'general', subTab: 'browser', keywords: ['browser', 'chromium', 'agent control', 'cdp', 'tabs'] },
  { id: 'general-browser-extensions', title: 'Browser extensions', section: 'General · Browser', tab: 'general', subTab: 'browser', keywords: ['extension', 'plugin', 'unpacked', 'developer mode', 'catalog', 'chrome', 'adblock'] },
  { id: 'general-browser-data', title: 'Browser data, downloads & history', section: 'General · Browser', tab: 'general', subTab: 'browser', keywords: ['downloads', 'history', 'clear data', 'cookies', 'site permissions'] },
  { id: 'general-credentials', title: 'Saved browser credentials', section: 'General · Browser', tab: 'general', subTab: 'browser', keywords: ['password', 'credentials', 'autofill', 'login'] },
  { id: 'general-companions', title: 'Browser companions (@Chrome)', section: 'General · Browser', tab: 'general', subTab: 'browser', keywords: ['companion', 'chrome', 'profile', 'leases'] },
  { id: 'general-shortcuts', title: 'Global shortcuts & key bindings', section: 'General · Shortcuts', tab: 'general', subTab: 'shortcuts', keywords: ['shortcut', 'hotkey', 'key binding', 'keyboard', 'accelerator', 'record', 'capture key', 'launcher', 'quick', 'reserved', 'conflict', 'system key'] },
  { id: 'general-shortcuts-behavior', title: 'Quick launcher key behavior', section: 'General · Shortcuts', tab: 'general', subTab: 'shortcuts', keywords: ['quick launcher', 'popup', 'window', 'behavior', 'toggle', 'raycast'] },
  { id: 'about', title: 'About & diagnostics', section: 'General · About', tab: 'general', subTab: 'about', keywords: ['version', 'diagnostics', 'about', 'bug report'] },
  { id: 'appearance', title: 'Theme', section: 'Appearance', tab: 'appearance', keywords: ['theme', 'light', 'dark', 'system', 'appearance'] },
  { id: 'models', title: 'Models & provider credentials', section: 'Models', tab: 'models', keywords: ['model', 'provider', 'api key', 'credential', 'openai', 'anthropic', 'deepseek', 'route'] },
  { id: 'capabilities-engine', title: 'Engine providers', section: 'Capabilities · Engine', tab: 'capabilities', capabilitySubTab: 'engine', keywords: ['engine', 'provider', 'setup', 'verify'] },
  { id: 'capabilities-memory', title: 'Memory providers', section: 'Capabilities · Memory', tab: 'capabilities', capabilitySubTab: 'memory', keywords: ['memory', 'openviking'] },
  { id: 'capabilities-context', title: 'Context providers', section: 'Capabilities · Context', tab: 'capabilities', capabilitySubTab: 'context', keywords: ['context'] },
  { id: 'capabilities-lifecycle', title: 'Lifecycle providers', section: 'Capabilities · Lifecycle', tab: 'capabilities', capabilitySubTab: 'lifecycle', keywords: ['lifecycle', 'approved setup'] },
  { id: 'extensions-packages', title: 'ND extension packages', section: 'Extensions', tab: 'extensions', keywords: ['extension', 'package', 'activation', 'grant', 'context', 'install'] },
  { id: 'plugins-manager', title: 'Agent plugins (MCP, skills, commands, hooks, routing)', section: 'Plugins', tab: 'plugins', keywords: ['plugin', 'mcp', 'skill', 'command', 'hook', 'subagent', 'routing', 'engine route', 'provider scope', 'adapter'] },
  { id: 'engines', title: 'Coding engines', section: 'Coding engines · Engines', tab: 'engines', enginesSubTab: 'engines', keywords: ['engine', 'codex', 'agy', 'antigravity', 'harness', 'default chat'] },
  { id: 'engines-gateway', title: 'ND Gateway', section: 'Coding engines · Gateway', tab: 'engines', enginesSubTab: 'gateway', keywords: ['gateway', 'codex', 'chatgpt', 'external apps'] },
  { id: 'engines-tokens', title: 'Token efficiency (saver & tool optimization)', section: 'Coding engines · Token efficiency', tab: 'engines', enginesSubTab: 'tokens', keywords: ['token', 'saver', 'optimization', 'tool call', 'context budget'] },
  { id: 'presets', title: 'Agent presets', section: 'Agent presets', tab: 'presets', keywords: ['preset', 'agent', 'notes', 'links'] },
]

/** Title matches rank above keyword matches; results are capped to keep the dropdown scannable. */
export function searchSettings(query: string, limit = 8): SettingsSearchEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return SETTINGS_SEARCH_ENTRIES
    .map((entry) => {
      const titleMatch = entry.title.toLowerCase().includes(q)
      const keywordMatch = `${entry.section} ${entry.keywords.join(' ')}`.toLowerCase().includes(q)
      if (!titleMatch && !keywordMatch) return null
      return { entry, score: titleMatch ? 0 : 1 }
    })
    .filter((match): match is { entry: SettingsSearchEntry; score: number } => match !== null)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((match) => match.entry)
}
