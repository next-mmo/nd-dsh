import type { BrowserChromePopupAction, BrowserChromePopupModel } from '../../../shared/browser-chrome-popup'
import { BrowserProfileAvatar } from './BrowserProfileAvatar'
import { CheckIcon, PuzzleIcon } from './Icons'
import { SettingsSwitch } from './settings-primitives'
import { cn } from '../lib/utils'

/**
 * Browser toolbar menu bodies. They are pure views over a popup model so the
 * same markup renders in the native popup surface (above the live page) and
 * in the DOM popover fallback used outside the desktop shell.
 */

type Dispatch = (action: BrowserChromePopupAction) => void

const footerButton = 'rounded border border-border bg-secondary px-2 py-1 text-[8px] font-semibold text-soft hover:bg-accent'

export function BrowserExtensionsMenu({ model, onAction }: {
  model: Extract<BrowserChromePopupModel, { kind: 'extensions' }>
  onAction: Dispatch
}) {
  return (
    <>
      <div className="border-b border-border-soft px-3 py-2.5">
        <strong className="block text-[11px] font-semibold text-strong">Extensions</strong>
        <span className="text-[9px] text-faint">Runs inside ND's built-in Chromium browser</span>
      </div>
      <div className="max-h-[300px] min-h-0 space-y-1 overflow-auto p-2">
        {model.extensions.length === 0 ? (
          <div className="rounded-md px-2 py-4 text-center text-[9px] text-faint">
            No built-in browser extensions installed.
          </div>
        ) : model.extensions.map((extension) => (
          <div key={extension.id} className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent/70">
            <div className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-secondary text-soft">
              <PuzzleIcon className="size-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <strong className="block truncate text-[10px] font-semibold text-strong">{extension.title}</strong>
              <span className="block truncate text-[8px] text-faint">{extension.subtitle}</span>
            </div>
            {extension.canOpen ? (
              <button
                type="button"
                className="shrink-0 rounded border border-border bg-secondary px-2 py-1 text-[8px] font-semibold text-soft hover:bg-accent"
                onClick={() => onAction({ type: 'extension-open', id: extension.id })}
              >
                Open
              </button>
            ) : null}
            <SettingsSwitch
              label={`Enable ${extension.title}`}
              checked={extension.enabled}
              onCheckedChange={(enabled) => onAction({ type: 'extension-toggle', id: extension.id, enabled })}
            />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border-soft px-3 py-2">
        <span className="min-w-0 truncate text-[8px] text-faint">{model.developerMode ? 'Developer mode on' : ''}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          {model.developerMode ? (
            <button type="button" className={footerButton} onClick={() => onAction({ type: 'extension-load-unpacked' })}>
              Load unpacked
            </button>
          ) : null}
          {model.canManage ? (
            <button type="button" className={footerButton} onClick={() => onAction({ type: 'open-settings' })}>
              Manage in Settings
            </button>
          ) : null}
        </div>
      </div>
    </>
  )
}

export function BrowserProfilesMenu({ model, onAction }: {
  model: Extract<BrowserChromePopupModel, { kind: 'profiles' }>
  onAction: Dispatch
}) {
  return (
    <>
      <div className="border-b border-border-soft px-3 py-2.5">
        <strong className="block text-[11px] font-semibold text-strong">Browser profiles</strong>
        <span className="text-[9px] text-faint">Each profile keeps its own cookies and sign-ins</span>
      </div>
      <div className="max-h-[300px] min-h-0 space-y-0.5 overflow-auto p-2">
        {model.profiles.length === 0 ? (
          <div className="rounded-md px-2 py-4 text-center text-[9px] text-faint">Profiles are loading…</div>
        ) : model.profiles.map((profile) => (
          <button
            key={profile.id}
            type="button"
            aria-pressed={profile.active}
            onClick={() => onAction({ type: 'profile-select', id: profile.id })}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/70',
              profile.active && 'bg-accent/50',
            )}
          >
            <BrowserProfileAvatar name={profile.name} color={profile.color} size={20} />
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-[10px] font-semibold text-strong">{profile.name}</strong>
              <span className="block text-[8px] text-faint">
                {profile.tabCount} tab{profile.tabCount === 1 ? '' : 's'}
                {profile.isDefault ? ' · Default' : ''}
              </span>
            </span>
            {profile.active ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border-soft px-3 py-2">
        <button type="button" className={footerButton} onClick={() => onAction({ type: 'profile-create' })}>
          New profile
        </button>
        {model.canManage ? (
          <button type="button" className={footerButton} onClick={() => onAction({ type: 'open-settings' })}>
            Manage in Settings
          </button>
        ) : null}
      </div>
    </>
  )
}

export function BrowserChromeMenu({ model, onAction }: { model: BrowserChromePopupModel; onAction: Dispatch }) {
  return model.kind === 'extensions'
    ? <BrowserExtensionsMenu model={model} onAction={onAction} />
    : <BrowserProfilesMenu model={model} onAction={onAction} />
}
