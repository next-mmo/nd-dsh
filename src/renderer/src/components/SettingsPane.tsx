import { useState } from 'react'
import type { BrowserState, HarnessStatus, ThemeMode, ThemeState, WorkspaceState } from '../../../shared/contracts'
import {
  BlocksIcon,
  BoxIcon,
  BrainIcon,
  PlugIcon,
  PuzzleIcon,
  SettingsIcon,
  SparkIcon,
  SunIcon,
} from './Icons'
import { AboutSettings } from './AboutSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { BrowserSettings } from './BrowserSettings'
import { CapabilitySettings } from './CapabilitySettings'
import { EngineSettings } from './EngineSettings'
import { ExtensionSettings } from './ExtensionSettings'
import { ModelSettings } from './ModelSettings'
import { PresetSettings } from './PresetSettings'
import { RuntimeSettings } from './RuntimeSettings'
import { ShortcutSettings } from './ShortcutSettings'
import { WorkspaceSettings } from './WorkspaceSettings'
import { searchSettings, type SettingsSearchEntry } from '../lib/settings-search'
import { cn } from '../lib/utils'
import {
  enginesSubTabFromLocation,
  generalSubTabFromLocation,
  type CapabilitySubTab,
  type EnginesSubTab,
  type GeneralSubTab,
  type SettingsTab,
} from '../lib/settings-route'

interface SettingsPaneProps {
  theme: ThemeState | null
  onSelectTheme(mode: ThemeMode): void
  workspace: WorkspaceState | null
  onWorkspaceChanged(workspace: WorkspaceState): void
  harness: HarnessStatus | null
  browser: BrowserState | null
  onError(message: string): void
  onOpenBrowser(): void
  tab: SettingsTab
  onSelectTab(tab: SettingsTab): void
  subTab?: GeneralSubTab
  onSelectSubTab?: (subTab: GeneralSubTab) => void
  capabilitySubTab?: CapabilitySubTab
  onSelectCapabilitySubTab?: (subTab: CapabilitySubTab) => void
  enginesSubTab?: EnginesSubTab
  onSelectEnginesSubTab?: (subTab: EnginesSubTab) => void
  /** Opens an existing chat session in the Agent workbench. */
  onOpenSession?(sessionId: string): void
  /** ND extension packages management, rendered above the agent-capability catalog. */
  extensionsExtra?: React.ReactNode
}

const TABS: { id: SettingsTab; label: string; Icon: typeof SettingsIcon }[] = [
  { id: 'general', label: 'General', Icon: SettingsIcon },
  { id: 'appearance', label: 'Appearance', Icon: SunIcon },
  { id: 'models', label: 'Models', Icon: BrainIcon },
  { id: 'capabilities', label: 'Capabilities', Icon: BoxIcon },
  { id: 'extensions', label: 'Extensions', Icon: PuzzleIcon },
  { id: 'plugins', label: 'Plugins', Icon: BlocksIcon },
  { id: 'engines', label: 'Coding engines', Icon: PlugIcon },
  { id: 'presets', label: 'Agent presets', Icon: SparkIcon },
]

const GENERAL_SUB_TABS: { id: GeneralSubTab; label: string }[] = [
  { id: 'runtime', label: 'Runtime' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'browser', label: 'Browser' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'about', label: 'About' },
]

export function SettingsPane({
  theme,
  onSelectTheme,
  workspace,
  onWorkspaceChanged,
  harness,
  browser,
  onError,
  onOpenBrowser,
  tab,
  onSelectTab,
  subTab: propSubTab,
  onSelectSubTab,
  capabilitySubTab,
  onSelectCapabilitySubTab,
  enginesSubTab: propEnginesSubTab,
  onSelectEnginesSubTab,
  onOpenSession,
  extensionsExtra,
}: SettingsPaneProps) {
  const [internalSubTab, setInternalSubTab] = useState<GeneralSubTab>(generalSubTabFromLocation)
  const [search, setSearch] = useState('')

  const activeSubTab = propSubTab ?? internalSubTab
  const handleSelectSubTab = (selected: GeneralSubTab): void => {
    if (onSelectSubTab) {
      onSelectSubTab(selected)
    } else {
      setInternalSubTab(selected)
    }
  }

  const results = searchSettings(search)
  const openSearchResult = (entry: SettingsSearchEntry): void => {
    onSelectTab(entry.tab)
    if (entry.subTab) handleSelectSubTab(entry.subTab)
    if (entry.capabilitySubTab && onSelectCapabilitySubTab) onSelectCapabilitySubTab(entry.capabilitySubTab)
    if (entry.enginesSubTab && onSelectEnginesSubTab) onSelectEnginesSubTab(entry.enginesSubTab)
    setSearch('')
  }

  return (
    <section
      aria-label="Settings"
      className="grid h-full w-full grid-cols-[248px_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] min-h-0 min-w-0 bg-surface-0"
    >
      <header className="col-span-2 border-b border-border-soft px-[26px] py-3.5">
        <span className="mb-[5px] block text-[8px] font-bold tracking-[0.13em] text-faint">ND-DSH · AI COMPANY OS</span>
        <h1 className="m-0 text-lg font-semibold tracking-tight text-strong">Settings</h1>
      </header>

      <aside className="flex min-h-0 flex-col gap-2 border-r border-border-soft px-2.5 py-3">
        <input
          aria-label="Search settings"
          placeholder="Search settings"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setSearch('')
            if (event.key === 'Enter' && results[0]) openSearchResult(results[0])
          }}
          spellCheck={false}
          className="h-[28px] w-full shrink-0 rounded-md border border-border bg-background px-2.5 text-[11px] text-soft outline-none focus:border-(--border-focus)"
        />
        {search.trim() ? (
          <div aria-label="Settings search results" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto">
            {results.length ? results.map((entry) => (
              <button
                key={entry.id}
                className="flex w-full flex-col items-start gap-[1px] rounded-md px-2.5 py-[7px] text-left transition-colors hover:bg-accent"
                onClick={() => openSearchResult(entry)}
              >
                <span className="text-[11px] font-semibold text-strong">{entry.title}</span>
                <span className="text-[9px] text-faint">{entry.section}</span>
              </button>
            )) : (
              <p className="px-2.5 py-2 text-[10px] text-faint">No settings match “{search.trim()}”.</p>
            )}
          </div>
        ) : (
          <nav
            role="tablist"
            aria-label="Settings sections"
            aria-orientation="vertical"
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto"
          >
            {TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={cn(
                  'flex shrink-0 items-center gap-2 rounded-md px-2.5 py-[7px] text-left text-[11px] font-semibold transition-colors [&_svg]:size-[14px] [&_svg]:shrink-0',
                  tab === id ? 'bg-primary/10 text-primary' : 'text-soft hover:bg-accent hover:text-strong',
                )}
                onClick={() => onSelectTab(id)}
              >
                <Icon />
                {label}
              </button>
            ))}
          </nav>
        )}
      </aside>

      {/* Single-row grid: gives every tab surface a definite height so its own overflow-auto scrolls. */}
      <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] overflow-hidden">
        {tab === 'models' ? (
          <ModelSettings onError={onError} />
        ) : tab === 'capabilities' ? (
          <CapabilitySettings
            onError={onError}
            {...(capabilitySubTab !== undefined ? { subTab: capabilitySubTab } : {})}
            {...(onSelectCapabilitySubTab !== undefined ? { onSelectSubTab: onSelectCapabilitySubTab } : {})}
          />
        ) : tab === 'extensions' ? (
          <div className="min-h-0 overflow-auto px-[26px] pb-[42px] pt-4">
            {extensionsExtra ?? (
              <p className="mt-6 text-[11px] text-faint">ND extension packages appear here once the extension runtime is available in this environment.</p>
            )}
          </div>
        ) : tab === 'plugins' ? (
          <ExtensionSettings onError={onError} />
        ) : tab === 'engines' ? (
          <EngineSettings
            onError={onError}
            {...(propEnginesSubTab !== undefined ? { subTab: propEnginesSubTab } : {})}
            {...(onSelectEnginesSubTab !== undefined ? { onSelectSubTab: onSelectEnginesSubTab } : {})}
          />
        ) : tab === 'presets' ? (
          <PresetSettings onError={onError} {...(onOpenSession ? { onOpenSession } : {})} />
        ) : tab === 'appearance' ? (
          <div className="min-h-0 overflow-auto px-[26px] pb-[42px] pt-1.5">
            <AppearanceSettings theme={theme} onSelectTheme={onSelectTheme} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-col">
            <div className="flex shrink-0 items-center border-b border-border-soft px-[26px] pb-2.5 pt-3">
              <nav
                role="tablist"
                aria-label="General sub-tabs"
                className="flex shrink-0 gap-0.5 rounded-lg border border-border bg-secondary p-[3px]"
              >
                {GENERAL_SUB_TABS.map(({ id, label }) => (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={activeSubTab === id}
                    className={cn(
                      'rounded-md px-3 py-1 text-[11px] font-semibold transition-colors',
                      activeSubTab === id
                        ? 'bg-primary/10 text-primary'
                        : 'text-faint hover:bg-accent hover:text-soft',
                    )}
                    onClick={() => handleSelectSubTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </nav>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-[26px] pb-[42px] pt-1.5">
              {activeSubTab === 'runtime' && <RuntimeSettings harness={harness} />}
              {activeSubTab === 'workspace' && (
                <WorkspaceSettings workspace={workspace} onWorkspaceChanged={onWorkspaceChanged} onError={onError} />
              )}
              {activeSubTab === 'browser' && (
                <BrowserSettings browser={browser} onError={onError} onOpenBrowser={onOpenBrowser} />
              )}
              {activeSubTab === 'shortcuts' && <ShortcutSettings onError={onError} />}
              {activeSubTab === 'about' && (
                <AboutSettings workspace={workspace} harness={harness} browser={browser} onError={onError} />
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
