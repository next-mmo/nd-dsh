import {
  WEB_BROWSER_MODES,
  WEB_BROWSER_MODE_DESCRIPTIONS,
  WEB_BROWSER_MODE_LABELS,
  type WebBrowserMode,
} from '../../../shared/browser-modes'

export function BrowserModeSelector({ mode, onSelect }: { mode: WebBrowserMode; onSelect: (mode: WebBrowserMode) => void }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-[7px] border border-border-soft bg-surface-1 px-2.5 py-1 text-[10px]">
      <div className="flex items-center gap-1.5 text-soft">
        <span className="font-medium">Browser Mode:</span>
        <span className="text-[9px] text-faint hidden sm:inline">
          {WEB_BROWSER_MODE_DESCRIPTIONS[mode]}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1 rounded bg-accent/60 p-0.5">
        {WEB_BROWSER_MODES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={mode === candidate}
            onClick={() => onSelect(candidate)}
            className={`rounded px-2 py-0.5 text-[9px] font-medium transition-colors ${
              mode === candidate
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'text-soft hover:text-foreground'
            }`}
            title={WEB_BROWSER_MODE_DESCRIPTIONS[candidate]}
          >
            {WEB_BROWSER_MODE_LABELS[candidate]}
          </button>
        ))}
      </div>
    </div>
  )
}
