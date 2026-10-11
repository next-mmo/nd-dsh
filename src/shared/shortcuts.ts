/**
 * Model for ND's user-rebindable global shortcuts.
 *
 * Shared by the main process (which owns Electron's `globalShortcut`) and the
 * renderer (which records a chord from raw keyboard events), so both sides
 * reject exactly the same combinations. This module is deliberately free of
 * Electron imports: the rules here are the ones unit tests assert against.
 *
 * A global shortcut fires from *any* application, so the risk is not that ND
 * breaks — it is that ND silently steals a key the operating system or every
 * other app depends on. `findShortcutConflict` is the gate that prevents it.
 */

export type GlobalShortcutId = 'quickLauncher' | 'areaCapture' | 'fullCapture' | 'delayedCapture'

export const GLOBAL_SHORTCUT_IDS: readonly GlobalShortcutId[] = [
  'quickLauncher',
  'areaCapture',
  'fullCapture',
  'delayedCapture',
]

export function isGlobalShortcutId(value: unknown): value is GlobalShortcutId {
  return typeof value === 'string' && (GLOBAL_SHORTCUT_IDS as readonly string[]).includes(value)
}

/** The binding ND ships with, and the target of "Reset to default". */
export const DEFAULT_GLOBAL_SHORTCUTS: Readonly<Record<GlobalShortcutId, string>> = {
  quickLauncher: 'CommandOrControl+Shift+Space',
  areaCapture: 'CommandOrControl+Alt+A',
  fullCapture: 'CommandOrControl+Alt+C',
  delayedCapture: 'CommandOrControl+Alt+Shift+C',
}

/** One source of truth for action names, reused by Settings and conflict messages. */
export const GLOBAL_SHORTCUT_LABELS: Readonly<Record<GlobalShortcutId, string>> = {
  quickLauncher: 'Quick launcher',
  areaCapture: 'Capture area',
  fullCapture: 'Capture full screen',
  delayedCapture: 'Capture full screen after a delay',
}

/** Snipping-tool-style countdown before a timed full-screen capture. */
export type CaptureDelaySeconds = 3 | 5 | 10

export const CAPTURE_DELAY_SECONDS: readonly CaptureDelaySeconds[] = [3, 5, 10]
export const DEFAULT_CAPTURE_DELAY_SECONDS: CaptureDelaySeconds = 3

export function isCaptureDelaySeconds(value: unknown): value is CaptureDelaySeconds {
  return typeof value === 'number' && (CAPTURE_DELAY_SECONDS as readonly number[]).includes(value)
}

export type ShortcutPlatform = 'darwin' | 'win32' | 'linux'

/** Anything that is not macOS or Windows is treated as a freedesktop environment. */
export function asShortcutPlatform(value: unknown): ShortcutPlatform {
  if (value === 'darwin' || value === 'win32') return value
  return 'linux'
}

export interface ShortcutChord {
  /** Cmd on macOS, Ctrl everywhere else: Electron's cross-platform primary modifier. */
  commandOrControl: boolean
  /** Explicit Control. On macOS this is distinct from Cmd; elsewhere it never appears alone. */
  control: boolean
  alt: boolean
  shift: boolean
  /** The Win/Super key. Only reachable on Windows and Linux, where Meta is not Cmd. */
  super: boolean
  /** Canonical accelerator key token, e.g. `Space`, `A`, `F5`, `Up`. */
  key: string
}

const MODIFIER_TOKENS: ReadonlyArray<[keyof Omit<ShortcutChord, 'key'>, string]> = [
  ['commandOrControl', 'CommandOrControl'],
  ['control', 'Control'],
  ['alt', 'Alt'],
  ['shift', 'Shift'],
  ['super', 'Super'],
]

/** Aliases accepted when parsing, mapped onto the canonical token above. */
const MODIFIER_ALIASES: Readonly<Record<string, keyof Omit<ShortcutChord, 'key'>>> = {
  commandorcontrol: 'commandOrControl',
  cmdorctrl: 'commandOrControl',
  command: 'commandOrControl',
  cmd: 'commandOrControl',
  control: 'control',
  ctrl: 'control',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  super: 'super',
  meta: 'super',
}

const NAMED_KEY_TOKENS: Readonly<Record<string, string>> = {
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PrintScreen: 'PrintScreen',
  Minus: 'Minus',
  Equal: 'Equal',
  Comma: 'Comma',
  Period: 'Period',
  Slash: 'Slash',
  Backslash: 'Backslash',
  Backquote: 'Backquote',
  Semicolon: 'Semicolon',
  Quote: 'Quote',
  MediaPlayPause: 'MediaPlayPause',
  MediaStop: 'MediaStop',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
  AudioVolumeUp: 'VolumeUp',
  AudioVolumeDown: 'VolumeDown',
  AudioVolumeMute: 'VolumeMute',
}

/**
 * `KeyboardEvent.code` to accelerator token. `code` is layout-independent, so a
 * French user pressing the physical Q key records `A` — the same key Electron
 * matches on. Anything absent here is rejected rather than guessed at, because
 * an unknown token would make `globalShortcut.register` throw.
 */
const KEY_TOKENS: ReadonlyMap<string, string> = new Map<string, string>([
  ...Array.from({ length: 26 }, (_, index): [string, string] => {
    const letter = String.fromCharCode(65 + index)
    return [`Key${letter}`, letter]
  }),
  ...Array.from({ length: 10 }, (_, index): [string, string] => [`Digit${index}`, String(index)]),
  ...Array.from({ length: 24 }, (_, index): [string, string] => [`F${index + 1}`, `F${index + 1}`]),
  ...Object.entries(NAMED_KEY_TOKENS),
])

const VALID_KEY_TOKENS: ReadonlySet<string> = new Set(KEY_TOKENS.values())

const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/
const MEDIA_KEYS: ReadonlySet<string> = new Set([
  'MediaPlayPause',
  'MediaStop',
  'MediaNextTrack',
  'MediaPreviousTrack',
  'VolumeUp',
  'VolumeDown',
  'VolumeMute',
])

export interface ShortcutKeyEvent {
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * Build a chord from a recorded keypress. Returns null for keys ND refuses to
 * bind — which includes every modifier key pressed on its own, so a recorder
 * can keep listening until the user lands on a real key.
 */
export function chordFromKeyboardEvent(event: ShortcutKeyEvent, platform: ShortcutPlatform): ShortcutChord | null {
  const key = KEY_TOKENS.get(event.code)
  if (!key) return null
  const darwin = platform === 'darwin'
  return {
    // On macOS Meta is Cmd; on Windows and Linux it is the Win/Super key.
    commandOrControl: darwin ? event.metaKey : event.ctrlKey,
    control: darwin ? event.ctrlKey : false,
    alt: event.altKey,
    shift: event.shiftKey,
    super: darwin ? false : event.metaKey,
    key,
  }
}

export function serializeChord(chord: ShortcutChord): string {
  const parts = MODIFIER_TOKENS.filter(([field]) => chord[field]).map(([, token]) => token)
  parts.push(chord.key)
  return parts.join('+')
}

/** Parse a persisted or hand-written accelerator. Returns null if ND cannot bind it safely. */
export function parseAccelerator(accelerator: string): ShortcutChord | null {
  const text = accelerator.trim()
  if (!text) return null
  const chord: ShortcutChord = { commandOrControl: false, control: false, alt: false, shift: false, super: false, key: '' }
  let key: string | undefined
  for (const raw of text.split('+')) {
    const part = raw.trim()
    if (!part) return null
    const modifier = MODIFIER_ALIASES[part.toLowerCase()]
    if (modifier) {
      chord[modifier] = true
      continue
    }
    const canonical = KEY_TOKENS.get(part) ?? (VALID_KEY_TOKENS.has(part) ? part : undefined)
    if (!canonical || key) return null
    key = canonical
  }
  if (!key) return null
  chord.key = key
  return chord
}

export function modifierCount(chord: ShortcutChord): number {
  return MODIFIER_TOKENS.filter(([field]) => chord[field]).length
}

/** Keys that are safe to hold globally without a modifier, because nothing types them. */
function isSelfSufficientKey(key: string): boolean {
  return FUNCTION_KEY.test(key) || MEDIA_KEYS.has(key)
}

export type ShortcutConflictCode = 'unsupported' | 'insufficient-modifiers' | 'os-reserved' | 'nd-reserved' | 'duplicate'

export interface ShortcutConflict {
  code: ShortcutConflictCode
  /** Human-readable reason naming the owner of the key, shown verbatim in Settings. */
  message: string
}

export interface ShortcutBindingState {
  accelerator: string
  isDefault: boolean
  registered: boolean
  /** Present only when the OS or another app is holding the key instead of ND. */
  unavailable?: string
}

/** What the Settings surface renders; `platform` lets it run the same rules locally. */
export interface GlobalShortcutState {
  platform: ShortcutPlatform
  bindings: Record<GlobalShortcutId, ShortcutBindingState>
}

interface ReservedChord {
  chord: ShortcutChord
  owner: string
}

function reserved(modifiers: Array<keyof Omit<ShortcutChord, 'key'>>, key: string, owner: string): ReservedChord {
  return {
    chord: {
      commandOrControl: modifiers.includes('commandOrControl'),
      control: modifiers.includes('control'),
      alt: modifiers.includes('alt'),
      shift: modifiers.includes('shift'),
      super: modifiers.includes('super'),
      key,
    },
    owner,
  }
}

/**
 * Exact combinations each OS claims for itself. Modifier-only rules (anything
 * using the Win/Super key) live in `findOsReserved` because they are families,
 * not single chords.
 */
const DARWIN_RESERVED: readonly ReservedChord[] = [
  reserved(['commandOrControl'], 'Space', 'Spotlight'),
  reserved(['commandOrControl'], 'Tab', 'the app switcher'),
  reserved(['commandOrControl', 'shift'], 'Tab', 'the reverse app switcher'),
  reserved(['commandOrControl', 'alt'], 'Space', 'the Finder search window'),
  reserved(['commandOrControl', 'shift'], '3', 'full-screen capture'),
  reserved(['commandOrControl', 'shift'], '4', 'selection capture'),
  reserved(['commandOrControl', 'shift'], '5', 'the screenshot toolbar'),
  reserved(['commandOrControl', 'alt'], 'Escape', 'Force Quit Applications'),
  reserved(['commandOrControl', 'control'], 'Q', 'screen lock'),
  reserved(['commandOrControl', 'alt'], 'D', 'showing and hiding the Dock'),
  reserved(['control'], 'Up', 'Mission Control'),
  reserved(['control'], 'Down', 'Application Windows'),
  reserved(['control'], 'Left', 'the space on the left'),
  reserved(['control'], 'Right', 'the space on the right'),
]

const WIN32_RESERVED: readonly ReservedChord[] = [
  reserved(['commandOrControl', 'alt'], 'Delete', 'the Windows secure sign-in screen'),
  reserved(['commandOrControl', 'shift'], 'Escape', 'Task Manager'),
  reserved(['alt'], 'F4', 'closing the foreground window'),
  reserved([], 'PrintScreen', 'the Windows screenshot key'),
  reserved(['alt'], 'PrintScreen', 'copying the active window to the clipboard'),
]

const LINUX_RESERVED: readonly ReservedChord[] = [
  reserved(['commandOrControl', 'alt'], 'T', 'opening a terminal'),
  reserved(['commandOrControl', 'alt'], 'Delete', 'the session logout prompt'),
  reserved(['commandOrControl', 'alt'], 'Up', 'workspace switching'),
  reserved(['commandOrControl', 'alt'], 'Down', 'workspace switching'),
  reserved(['commandOrControl', 'alt'], 'Left', 'workspace switching'),
  reserved(['commandOrControl', 'alt'], 'Right', 'workspace switching'),
  reserved([], 'PrintScreen', 'the desktop screenshot action'),
  reserved(['alt'], 'PrintScreen', 'the window screenshot action'),
  reserved(['shift'], 'PrintScreen', 'the region screenshot action'),
]

function findOsReserved(chord: ShortcutChord, platform: ShortcutPlatform): string | null {
  // The shell owns its own modifier key outright, and on Windows it wins the
  // race even when RegisterHotKey appears to succeed — so Win+anything is refused.
  if (chord.super && platform !== 'darwin') {
    return platform === 'win32'
      ? 'Windows reserves Win+key combinations for the shell (Win+L locks, Win+D shows the desktop, Win+Shift+S captures the screen).'
      : 'Your desktop shell reserves Super+key combinations (Super locks the screen, Super opens the overview).'
  }
  if (platform === 'linux' && chord.commandOrControl && chord.alt && !chord.shift && !chord.super && /^F([1-9]|1[0-2])$/.test(chord.key)) {
    return 'Ctrl+Alt+F1…F12 switches virtual consoles.'
  }
  const table = platform === 'darwin' ? DARWIN_RESERVED : platform === 'win32' ? WIN32_RESERVED : LINUX_RESERVED
  const accelerator = serializeChord(chord)
  const match = table.find((entry) => serializeChord(entry.chord) === accelerator)
  return match ? `The operating system reserves this key for ${match.owner}.` : null
}

/**
 * Accelerators ND's own renderer already listens for (see App.tsx). Area and
 * full capture are global actions themselves, so their keys are fair game to
 * rebind; only keys whose action stays renderer-only are protected here, since
 * a global grab would consume the press before ND's window ever sees it.
 */
function findNdReserved(chord: ShortcutChord): string | null {
  const primary = chord.commandOrControl || chord.control
  if (!primary) return null
  if (chord.alt && !chord.shift && chord.key === 'E') {
    return 'ND already uses this key for element inspect, which only runs while ND is focused.'
  }
  if (chord.key === 'K' && !chord.alt && !chord.shift) return 'ND already uses this key to open its in-app launcher.'
  return null
}

/**
 * Decide whether a chord may become a global shortcut. Returns null when the
 * binding is acceptable, otherwise the reason to show the user.
 *
 * `taken` maps every *other* action to its current accelerator, so two actions
 * can never end up claiming the same key.
 */
export function findShortcutConflict(
  chord: ShortcutChord,
  platform: ShortcutPlatform,
  taken?: Readonly<Partial<Record<GlobalShortcutId, string>>>,
): ShortcutConflict | null {
  if (!VALID_KEY_TOKENS.has(chord.key)) {
    return { code: 'unsupported', message: 'ND cannot bind that key.' }
  }
  const osReserved = findOsReserved(chord, platform)
  if (osReserved) return { code: 'os-reserved', message: osReserved }
  const ndReserved = findNdReserved(chord)
  if (ndReserved) return { code: 'nd-reserved', message: ndReserved }
  if (!isSelfSufficientKey(chord.key) && modifierCount(chord) < 2) {
    return {
      code: 'insufficient-modifiers',
      message: 'A global key needs at least two modifiers. With fewer, ND would swallow keystrokes in every other app.',
    }
  }
  if (taken) {
    const accelerator = serializeChord(chord)
    const owner = GLOBAL_SHORTCUT_IDS.find((id) => taken[id] === accelerator)
    if (owner) return { code: 'duplicate', message: `ND already uses this key for ${GLOBAL_SHORTCUT_LABELS[owner]}.` }
  }
  return null
}

const DISPLAY_KEY_LABELS: Readonly<Record<string, string>> = {
  Escape: 'Esc',
  Delete: 'Del',
  Insert: 'Ins',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
  Semicolon: ';',
  Quote: "'",
  PrintScreen: 'PrtScn',
  MediaPlayPause: 'Media Play',
  MediaStop: 'Media Stop',
  MediaNextTrack: 'Media Next',
  MediaPreviousTrack: 'Media Previous',
  VolumeUp: 'Volume Up',
  VolumeDown: 'Volume Down',
  VolumeMute: 'Volume Mute',
}

/** Render a chord the way the user's own OS writes it, for the recorder readout. */
export function describeChord(chord: ShortcutChord, platform: ShortcutPlatform): string {
  if (platform === 'darwin') {
    const modifiers = [
      chord.control ? '⌃' : '',
      chord.alt ? '⌥' : '',
      chord.shift ? '⇧' : '',
      chord.commandOrControl ? '⌘' : '',
    ].filter(Boolean)
    const key = chord.key === 'Enter' ? 'Return' : DISPLAY_KEY_LABELS[chord.key] ?? chord.key
    return `${modifiers.join('')}${modifiers.length > 0 ? ' ' : ''}${key}`
  }
  const modifiers = [
    chord.control || chord.commandOrControl ? 'Ctrl' : '',
    chord.alt ? 'Alt' : '',
    chord.shift ? 'Shift' : '',
    chord.super ? 'Win' : '',
  ].filter(Boolean)
  return [...modifiers, DISPLAY_KEY_LABELS[chord.key] ?? chord.key].join('+')
}

export function describeAccelerator(accelerator: string, platform: ShortcutPlatform): string {
  const chord = parseAccelerator(accelerator)
  return chord ? describeChord(chord, platform) : accelerator
}
