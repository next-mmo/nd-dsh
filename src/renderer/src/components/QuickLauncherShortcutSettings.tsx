import { useEffect, useState } from 'react'
import type { QuickLauncherShortcutMode } from '../../../shared/quick-launcher'
import { errorMessage } from '../lib/qa'
import { SettingsButton, SettingsRow, SettingsSection, rowDesc, rowStack, rowTitle } from './settings-primitives'

const SHORTCUT_MODES: Array<{ id: QuickLauncherShortcutMode; label: string; description: string }> = [
  {
    id: 'popup',
    label: 'Popup only',
    description: 'Raycast-style: the launcher card floats over the current app; the full ND window stays hidden until an action needs it.',
  },
  {
    id: 'window-launcher',
    label: 'Window + launcher',
    description: 'Bring the full ND window forward with the launcher already open.',
  },
  {
    id: 'window',
    label: 'Window only',
    description: 'Bring the full ND window forward without the launcher.',
  },
]

export function QuickLauncherShortcutSettings({ onError }: { onError(message: string): void }) {
  const [mode, setMode] = useState<QuickLauncherShortcutMode | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let mounted = true
    void window.ndDsh.window?.quickLauncherMode?.()
      .then((saved) => { if (mounted) setMode(saved) })
      .catch((cause) => onError(errorMessage(cause)))
    return () => {
      mounted = false
    }
  }, [onError])

  const update = async (next: QuickLauncherShortcutMode): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const saved = await window.ndDsh.window?.setQuickLauncherMode?.(next)
      setMode(saved ?? next)
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection title="Quick launcher">
      <SettingsRow>
        <div className={rowStack}>
          <strong className={rowTitle}>What the key does</strong>
          <span className={rowDesc}>The action your quick launcher key runs from any app. The same press always toggles the surface back off.</span>
        </div>
      </SettingsRow>
      <div className="flex gap-1.5" role="radiogroup" aria-label="Quick launcher shortcut mode">
        {SHORTCUT_MODES.map((entry) => (
          <SettingsButton
            key={entry.id}
            active={mode === entry.id}
            disabled={busy}
            aria-pressed={mode === entry.id}
            onClick={() => void update(entry.id)}
          >
            {entry.label}
          </SettingsButton>
        ))}
      </div>
      <p className={rowDesc}>{SHORTCUT_MODES.find((entry) => entry.id === (mode ?? 'popup'))?.description}</p>
    </SettingsSection>
  )
}
