import { useEffect, useRef, useState } from 'react'
import { Volume1, Volume2, VolumeX } from 'lucide-react'
import type { NdSystemVolumeState, NdSystemVolumeUpdate } from '../../../shared/media-session'

const unavailable: NdSystemVolumeState = { available: false, reason: 'System volume is unavailable' }

/** Native output volume is available without a media session or browser tab. */
export function SystemVolumeControl({ active }: { active: boolean }) {
  const [state, setState] = useState<NdSystemVolumeState | null>(null)
  const [draft, setDraft] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef<NdSystemVolumeUpdate | null>(null)
  const writing = useRef(false)
  const generation = useRef(0)
  const revision = useRef(0)

  useEffect(() => {
    if (!active) return
    const current = ++generation.current
    let reading = false
    const refresh = async () => {
      if (reading || writing.current || document.visibilityState === 'hidden') return
      reading = true
      const readRevision = revision.current
      try {
        const next = await window.ndDsh.media?.volumeState() ?? unavailable
        if (generation.current === current && revision.current === readRevision && !writing.current) setState(next)
      } catch {
        if (generation.current === current && revision.current === readRevision && !writing.current) setState(unavailable)
      } finally {
        reading = false
      }
    }
    void refresh()
    // Only poll while this launcher is open; follow keyboard volume changes
    // and default-output switches without a permanent background watcher.
    const timer = window.setInterval(() => void refresh(), 1_000)
    window.addEventListener('focus', refresh)
    return () => {
      ++generation.current
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [active])

  const update = async (next: NdSystemVolumeUpdate) => {
    ++revision.current
    // Coalesce slider movement and serialize writes so an older request can
    // never overwrite the final position when dragging quickly.
    pending.current = { ...pending.current, ...next }
    if (writing.current) return
    writing.current = true
    setBusy(true)
    const current = generation.current
    try {
      while (pending.current) {
        const change = pending.current
        pending.current = null
        const result = await window.ndDsh.media?.setVolume(change) ?? unavailable
        if (generation.current === current) setState(result)
        if (!result.available) {
          pending.current = null
          break
        }
      }
    } catch {
      pending.current = null
      if (generation.current === current) setState(unavailable)
    } finally {
      writing.current = false
      setDraft(null)
      setBusy(false)
    }
  }

  const level = draft ?? (state?.available ? Math.round(state.level) : 0)
  const muted = state?.available === true && state.muted
  const Icon = muted || level === 0 ? VolumeX : level < 50 ? Volume1 : Volume2

  return (
    <div
      role="group"
      aria-label="System volume controls"
      className="flex shrink-0 items-center gap-2 border-t border-border-soft px-3 py-2"
      onKeyDown={(event) => {
        // cmdk uses arrow keys and Enter to run commands. Keep volume keyboard
        // gestures local, while Escape still dismisses the launcher.
        if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation()
      }}
    >
      <button
        type="button"
        aria-label={muted ? 'Unmute system volume' : 'Mute system volume'}
        aria-pressed={muted}
        title={muted ? 'Unmute system volume' : 'Mute system volume'}
        disabled={!state?.available || !state.canMute || busy}
        onClick={() => void update({ muted: !muted })}
        className="rounded-md p-1.5 text-faint transition-colors hover:bg-surface-2 hover:text-strong focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40"
      >
        <Icon className="size-4" />
      </button>
      <span className="shrink-0 text-xs text-faint">System volume</span>
      {state?.available ? (
        <>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={level}
            aria-label="System volume"
            aria-valuetext={`${level}%${muted ? ', muted' : ''}`}
            onChange={(event) => {
              const value = Number(event.currentTarget.value)
              setDraft(value)
              void update({ level: value })
            }}
            className="h-4 min-w-0 flex-1 cursor-pointer accent-primary outline-none"
          />
          <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-faint">{muted ? 'Muted' : `${level}%`}</span>
        </>
      ) : (
        <span className="ml-auto truncate text-[10px] text-faint" role="status" title={state?.reason}>
          {state ? state.reason : 'Loading…'}
        </span>
      )}
    </div>
  )
}
