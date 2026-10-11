import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CAPTURE_DELAY_SECONDS,
  chordFromKeyboardEvent,
  describeAccelerator,
  describeChord,
  findShortcutConflict,
  GLOBAL_SHORTCUT_IDS,
  GLOBAL_SHORTCUT_LABELS,
  serializeChord,
  type CaptureDelaySeconds,
  type GlobalShortcutId,
  type GlobalShortcutState,
  type ShortcutChord,
  type ShortcutPlatform,
} from '../../../shared/shortcuts'
import { errorMessage } from '../lib/qa'
import { cn } from '../lib/utils'
import { QuickLauncherShortcutSettings } from './QuickLauncherShortcutSettings'
import {
  SettingsButton,
  SettingsNote,
  SettingsRow,
  SettingsSection,
  StatusChip,
  rowDesc,
  rowStack,
  rowTitle,
} from './settings-primitives'

/** Titles come from GLOBAL_SHORTCUT_LABELS so conflict messages match the rows. */
const ACTION_DESCRIPTIONS: Readonly<Record<GlobalShortcutId, string>> = {
  quickLauncher: 'Opens ND from any application, even while another app has focus.',
  areaCapture: 'Snip a rectangle of the screen, like the Windows Snipping Tool.',
  fullCapture: 'Capture the whole screen at once, with no countdown.',
  delayedCapture: 'Count down first, so you can open a menu or dropdown before the shot.',
}

/**
 * The policy, stated where the user reads it before recording: ND refuses keys
 * the operating system owns rather than warning after it has stolen one.
 */
const GUARD_NOTE = 'ND refuses keys your operating system owns — Win and ⌘ system combinations, Ctrl+Alt+Del, screenshot and console-switching hotkeys — and anything with fewer than two modifiers, because those are typed in ordinary apps. If another application already holds the key you pick, ND keeps your previous binding and tells you why.'

const warningText = 'text-[10px]/[1.45] text-warning'

interface ShortcutRecorderProps {
  id: GlobalShortcutId
  accelerator: string
  isDefault: boolean
  platform: ShortcutPlatform
  busy: boolean
  /** Current bindings of the other actions, so duplicates are refused locally. */
  taken: Readonly<Partial<Record<GlobalShortcutId, string>>>
  /** Applies the binding; resolves to null on success or the reason it was refused. */
  onCommit(id: GlobalShortcutId, accelerator: string | null): Promise<string | null>
  /** Reports why a key was refused, or null to clear the message. */
  onProblem(id: GlobalShortcutId, message: string | null): void
}

function ShortcutRecorder({ id, accelerator, isDefault, platform, busy, taken, onCommit, onProblem }: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false)
  const [draft, setDraft] = useState<ShortcutChord | null>(null)

  const stop = useCallback((problem: string | null): void => {
    setRecording(false)
    setDraft(null)
    onProblem(id, problem)
  }, [id, onProblem])

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (event: KeyboardEvent): void => {
      // Captured at window, so this runs before ND's own bubble-phase
      // accelerators: recording a combination must never trigger it.
      event.preventDefault()
      event.stopPropagation()
      if (event.code === 'Escape') {
        stop(null)
        return
      }
      const chord = chordFromKeyboardEvent(event, platform)
      // A modifier pressed on its own is not a binding yet; keep listening.
      if (!chord) return
      setDraft(chord)
      const conflict = findShortcutConflict(chord, platform, taken)
      if (conflict) {
        onProblem(id, conflict.message)
        return
      }
      const recorded = serializeChord(chord)
      stop(null)
      void onCommit(id, recorded).then((failure) => {
        if (failure) onProblem(id, failure)
      })
    }
    const swallow = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    const onBlur = (): void => stop(null)
    // Losing focus mid-record must not leave ND swallowing every keystroke.
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', swallow, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', swallow, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [recording, platform, id, taken, onCommit, onProblem, stop])

  const readout = recording
    ? draft
      ? describeChord(draft, platform)
      : 'Press keys…'
    : describeAccelerator(accelerator, platform)

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <kbd
        role="status"
        aria-label={`${GLOBAL_SHORTCUT_LABELS[id]} key`}
        className={cn(
          'min-w-[128px] rounded-md border px-2.5 py-1.5 text-center font-mono text-[10px]',
          recording ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-secondary text-soft',
        )}
      >
        {readout}
      </kbd>
      <SettingsButton
        active={recording}
        aria-pressed={recording}
        aria-label={`${recording ? 'Stop listening for' : 'Record'} a new key for ${GLOBAL_SHORTCUT_LABELS[id]}`}
        disabled={busy}
        onClick={() => {
          if (recording) stop(null)
          else {
            onProblem(id, null)
            setDraft(null)
            setRecording(true)
          }
        }}
      >
        {recording ? 'Cancel' : 'Record'}
      </SettingsButton>
      <SettingsButton
        aria-label={`Reset the ${GLOBAL_SHORTCUT_LABELS[id]} key to the ND default`}
        disabled={busy || recording || isDefault}
        onClick={() => {
          onProblem(id, null)
          void onCommit(id, null).then((failure) => {
            if (failure) onProblem(id, failure)
          })
        }}
      >
        Reset
      </SettingsButton>
    </div>
  )
}

/** General → Shortcuts: rebindable OS-wide hotkeys and what the launcher key does. */
export function ShortcutSettings({ onError }: { onError(message: string): void }) {
  const [state, setState] = useState<GlobalShortcutState | null>(null)
  const [busyId, setBusyId] = useState<GlobalShortcutId | null>(null)
  const [problem, setProblem] = useState<{ id: GlobalShortcutId; message: string } | null>(null)
  const [delay, setDelay] = useState<CaptureDelaySeconds | null>(null)
  const [delayBusy, setDelayBusy] = useState(false)
  const api = window.ndDsh.shortcuts
  const readDelay = window.ndDsh.window?.captureDelay
  const writeDelay = window.ndDsh.window?.setCaptureDelay

  useEffect(() => {
    if (!api) return
    let mounted = true
    void api.state()
      .then((next) => { if (mounted) setState(next) })
      .catch((cause) => onError(errorMessage(cause)))
    return () => {
      mounted = false
    }
  }, [api, onError])

  useEffect(() => {
    if (!readDelay) return
    let mounted = true
    void readDelay()
      .then((saved) => { if (mounted) setDelay(saved) })
      .catch((cause) => onError(errorMessage(cause)))
    return () => {
      mounted = false
    }
  }, [readDelay, onError])

  const updateDelay = async (seconds: CaptureDelaySeconds): Promise<void> => {
    if (!writeDelay || delayBusy) return
    setDelayBusy(true)
    try {
      setDelay(await writeDelay(seconds))
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setDelayBusy(false)
    }
  }

  const commit = useCallback(async (id: GlobalShortcutId, accelerator: string | null): Promise<string | null> => {
    if (!api) return 'Global shortcuts are unavailable in this environment.'
    setBusyId(id)
    try {
      setState(await api.rebind(id, accelerator))
      return null
    } catch (cause) {
      return errorMessage(cause)
    } finally {
      setBusyId(null)
    }
  }, [api])

  const reportProblem = useCallback((id: GlobalShortcutId, message: string | null): void => {
    setProblem(message === null ? null : { id, message })
  }, [])

  // Each recorder needs the other actions' bindings to refuse duplicates locally,
  // before an IPC round trip that would answer after the recorder stopped listening.
  const takenByRow = useMemo(() => {
    const map = {} as Record<GlobalShortcutId, Partial<Record<GlobalShortcutId, string>>>
    for (const id of GLOBAL_SHORTCUT_IDS) {
      const taken: Partial<Record<GlobalShortcutId, string>> = {}
      for (const other of GLOBAL_SHORTCUT_IDS) {
        if (other !== id && state) taken[other] = state.bindings[other].accelerator
      }
      map[id] = taken
    }
    return map
  }, [state])

  return (
    <>
      <SettingsSection title="Global shortcuts" className="mt-3.5">
        {!api ? (
          <SettingsNote>Global shortcuts need the ND desktop bridge, which is not available in this environment.</SettingsNote>
        ) : (
          <div className="space-y-1.5">
            {GLOBAL_SHORTCUT_IDS.map((id) => {
              const binding = state?.bindings[id]
              return (
                <SettingsRow key={id} label={GLOBAL_SHORTCUT_LABELS[id]}>
                  <div className={rowStack}>
                    <strong className={rowTitle}>{GLOBAL_SHORTCUT_LABELS[id]}</strong>
                    <span className={rowDesc}>{ACTION_DESCRIPTIONS[id]}</span>
                    {/* role=alert is reserved for a refusal the user just caused;
                        a binding that was already unavailable is a status, not an alarm. */}
                    {problem?.id === id ? (
                      <span role="alert" className={warningText}>{problem.message}</span>
                    ) : binding && !binding.registered && binding.unavailable ? (
                      <span className={warningText}>{binding.unavailable}</span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2.5">
                    <StatusChip good={binding?.registered === true} warn={binding !== undefined && !binding.registered}>
                      {binding === undefined ? 'Loading' : binding.registered ? 'Active' : 'Unavailable'}
                    </StatusChip>
                    {binding && state ? (
                      <ShortcutRecorder
                        id={id}
                        accelerator={binding.accelerator}
                        isDefault={binding.isDefault}
                        platform={state.platform}
                        busy={busyId === id}
                        taken={takenByRow[id]}
                        onCommit={commit}
                        onProblem={reportProblem}
                      />
                    ) : null}
                  </div>
                </SettingsRow>
              )
            })}
          </div>
        )}
        <SettingsNote>Captures land in the chat composer as unsent attachments, and on the clipboard. Nothing reaches the agent until you press send.</SettingsNote>
        <SettingsNote>{GUARD_NOTE}</SettingsNote>
      </SettingsSection>

      <SettingsSection title="Capture delay">
        <SettingsRow>
          <div className={rowStack}>
            <strong className={rowTitle}>Countdown before a timed capture</strong>
            <span className={rowDesc}>Time to switch apps or open a menu before “Capture full screen after a delay” fires.</span>
          </div>
          <div className="flex shrink-0 gap-1.5" role="radiogroup" aria-label="Capture delay">
            {CAPTURE_DELAY_SECONDS.map((seconds) => (
              <SettingsButton
                key={seconds}
                active={delay === seconds}
                aria-pressed={delay === seconds}
                disabled={delayBusy || delay === null}
                onClick={() => void updateDelay(seconds)}
              >
                {seconds}s
              </SettingsButton>
            ))}
          </div>
        </SettingsRow>
      </SettingsSection>

      <QuickLauncherShortcutSettings onError={onError} />
    </>
  )
}
