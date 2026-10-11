import { describe, expect, it } from 'vitest'
import {
  asShortcutPlatform,
  chordFromKeyboardEvent,
  DEFAULT_GLOBAL_SHORTCUTS,
  describeChord,
  findShortcutConflict,
  GLOBAL_SHORTCUT_IDS,
  parseAccelerator,
  serializeChord,
  type ShortcutChord,
  type ShortcutKeyEvent,
  type ShortcutPlatform,
} from '../src/shared/shortcuts.js'

const PLATFORMS: ShortcutPlatform[] = ['darwin', 'win32', 'linux']

function keyEvent(code: string, modifiers: Partial<Omit<ShortcutKeyEvent, 'code'>> = {}): ShortcutKeyEvent {
  return { code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers }
}

function chordOf(accelerator: string): ShortcutChord {
  const chord = parseAccelerator(accelerator)
  if (!chord) throw new Error(`Test accelerator should parse: ${accelerator}`)
  return chord
}

function conflictFor(accelerator: string, platform: ShortcutPlatform) {
  return findShortcutConflict(chordOf(accelerator), platform)
}

describe('shortcut chord model', () => {
  it('round-trips the shipped default', () => {
    expect(serializeChord(chordOf(DEFAULT_GLOBAL_SHORTCUTS.quickLauncher))).toBe('CommandOrControl+Shift+Space')
  })

  it('reads the same physical binding on Windows and macOS', () => {
    const win32 = chordFromKeyboardEvent(keyEvent('Space', { ctrlKey: true, shiftKey: true }), 'win32')
    const darwin = chordFromKeyboardEvent(keyEvent('Space', { metaKey: true, shiftKey: true }), 'darwin')
    expect(win32 && serializeChord(win32)).toBe('CommandOrControl+Shift+Space')
    expect(darwin && serializeChord(darwin)).toBe('CommandOrControl+Shift+Space')
  })

  it('keeps the Win key distinct from Ctrl on Windows and Linux', () => {
    const chord = chordFromKeyboardEvent(keyEvent('KeyL', { metaKey: true }), 'win32')
    expect(chord && serializeChord(chord)).toBe('Super+L')
  })

  it('keeps Control distinct from Command on macOS', () => {
    const chord = chordFromKeyboardEvent(keyEvent('KeyQ', { ctrlKey: true, metaKey: true }), 'darwin')
    expect(chord && serializeChord(chord)).toBe('CommandOrControl+Control+Q')
  })

  it('accepts alias spellings and canonicalizes them', () => {
    expect(serializeChord(chordOf('CmdOrCtrl+Shift+Space'))).toBe('CommandOrControl+Shift+Space')
    expect(serializeChord(chordOf('Option+Control+Up'))).toBe('Control+Alt+Up')
  })

  it('refuses keys ND cannot bind', () => {
    // Modifier-only presses, so the recorder can keep listening.
    expect(chordFromKeyboardEvent(keyEvent('ShiftLeft'), 'win32')).toBeNull()
    expect(chordFromKeyboardEvent(keyEvent('MetaLeft'), 'win32')).toBeNull()
    // Outside the allow-list entirely.
    expect(chordFromKeyboardEvent(keyEvent('Numpad7', { ctrlKey: true, altKey: true }), 'win32')).toBeNull()
    expect(parseAccelerator('CommandOrControl+Shift+Nonsense')).toBeNull()
    expect(parseAccelerator('CommandOrControl+Shift')).toBeNull()
    expect(parseAccelerator('')).toBeNull()
  })

  it('describes a chord the way the local OS writes it', () => {
    expect(describeChord(chordOf('CommandOrControl+Shift+Space'), 'darwin')).toBe('⇧⌘ Space')
    expect(describeChord(chordOf('CommandOrControl+Shift+Space'), 'win32')).toBe('Ctrl+Shift+Space')
    expect(describeChord(chordOf('Alt+Up'), 'linux')).toBe('Alt+Up')
  })

  it('treats an unknown platform as a freedesktop environment', () => {
    expect(asShortcutPlatform('freebsd')).toBe('linux')
    expect(asShortcutPlatform('darwin')).toBe('darwin')
  })
})

describe('operating system shortcuts are never overridden', () => {
  it('refuses the whole Win/Super family on Windows and Linux', () => {
    for (const platform of ['win32', 'linux'] as const) {
      for (const accelerator of ['Super+L', 'Super+D', 'Super+Shift+S', 'Super+A', 'Super+Tab']) {
        expect(conflictFor(accelerator, platform)?.code, `${platform} ${accelerator}`).toBe('os-reserved')
      }
    }
  })

  it('refuses Windows system keys', () => {
    expect(conflictFor('CommandOrControl+Alt+Delete', 'win32')?.code).toBe('os-reserved')
    expect(conflictFor('CommandOrControl+Shift+Escape', 'win32')?.code).toBe('os-reserved')
    expect(conflictFor('Alt+F4', 'win32')?.code).toBe('os-reserved')
    expect(conflictFor('PrintScreen', 'win32')?.code).toBe('os-reserved')
  })

  it('refuses macOS system keys', () => {
    expect(conflictFor('CommandOrControl+Space', 'darwin')?.code).toBe('os-reserved')
    expect(conflictFor('CommandOrControl+Tab', 'darwin')?.code).toBe('os-reserved')
    expect(conflictFor('CommandOrControl+Shift+3', 'darwin')?.code).toBe('os-reserved')
    expect(conflictFor('CommandOrControl+Shift+4', 'darwin')?.code).toBe('os-reserved')
    expect(conflictFor('CommandOrControl+Shift+5', 'darwin')?.code).toBe('os-reserved')
    expect(conflictFor('CommandOrControl+Alt+Escape', 'darwin')?.code).toBe('os-reserved')
    expect(conflictFor('CommandOrControl+Control+Q', 'darwin')?.code).toBe('os-reserved')
    expect(conflictFor('Control+Up', 'darwin')?.code).toBe('os-reserved')
    expect(conflictFor('Control+Left', 'darwin')?.code).toBe('os-reserved')
  })

  it('refuses Linux desktop and console keys', () => {
    expect(conflictFor('CommandOrControl+Alt+T', 'linux')?.code).toBe('os-reserved')
    expect(conflictFor('CommandOrControl+Alt+Delete', 'linux')?.code).toBe('os-reserved')
    expect(conflictFor('CommandOrControl+Alt+F2', 'linux')?.code).toBe('os-reserved')
    expect(conflictFor('CommandOrControl+Alt+Left', 'linux')?.code).toBe('os-reserved')
    expect(conflictFor('PrintScreen', 'linux')?.code).toBe('os-reserved')
    expect(conflictFor('Shift+PrintScreen', 'linux')?.code).toBe('os-reserved')
  })

  it('names the owner in the message shown to the user', () => {
    expect(conflictFor('CommandOrControl+Shift+Escape', 'win32')?.message).toContain('Task Manager')
    expect(conflictFor('CommandOrControl+Shift+4', 'darwin')?.message).toContain('selection capture')
    expect(conflictFor('Super+L', 'win32')?.message).toContain('Windows reserves Win+key combinations')
  })
})

describe('the modifier floor', () => {
  it('refuses keys that ordinary typing depends on', () => {
    for (const platform of PLATFORMS) {
      for (const accelerator of [
        'CommandOrControl+C',
        'CommandOrControl+V',
        'CommandOrControl+A',
        'CommandOrControl+Z',
        'CommandOrControl+S',
        'CommandOrControl+T',
        'CommandOrControl+Space',
        'Alt+Tab',
        'A',
        'Space',
      ]) {
        const conflict = conflictFor(accelerator, platform)
        expect(conflict, `${platform} ${accelerator}`).not.toBeNull()
      }
    }
  })

  it('flags a one-modifier binding as insufficient rather than reserved', () => {
    expect(conflictFor('CommandOrControl+V', 'win32')?.code).toBe('insufficient-modifiers')
  })

  it('allows function keys on their own, because nothing types them', () => {
    expect(conflictFor('F13', 'win32')).toBeNull()
    expect(conflictFor('MediaPlayPause', 'darwin')).toBeNull()
  })
})

describe("ND's own accelerators stay reachable", () => {
  it('refuses the keys whose action stays renderer-only', () => {
    expect(conflictFor('CommandOrControl+Alt+E', 'win32')?.code).toBe('nd-reserved')
    expect(conflictFor('Control+Alt+E', 'darwin')?.code).toBe('nd-reserved')
    expect(conflictFor('CommandOrControl+K', 'win32')?.code).toBe('nd-reserved')
  })

  it('names the in-app action that would break', () => {
    expect(conflictFor('CommandOrControl+Alt+E', 'win32')?.message).toContain('element inspect')
  })

  it('allows the capture keys, because they are global actions themselves', () => {
    for (const platform of PLATFORMS) {
      expect(conflictFor('CommandOrControl+Alt+A', platform), `${platform} area`).toBeNull()
      expect(conflictFor('CommandOrControl+Alt+C', platform), `${platform} full`).toBeNull()
      expect(conflictFor('CommandOrControl+Alt+Shift+C', platform), `${platform} delayed`).toBeNull()
    }
  })
})

describe('two actions cannot claim one key', () => {
  const takenByOthers = () => ({
    areaCapture: DEFAULT_GLOBAL_SHORTCUTS.areaCapture,
    fullCapture: DEFAULT_GLOBAL_SHORTCUTS.fullCapture,
    delayedCapture: DEFAULT_GLOBAL_SHORTCUTS.delayedCapture,
  })

  it('refuses a key another action already holds, naming that action', () => {
    const conflict = findShortcutConflict(chordOf(DEFAULT_GLOBAL_SHORTCUTS.areaCapture), 'win32', takenByOthers())
    expect(conflict?.code).toBe('duplicate')
    expect(conflict?.message).toContain('Capture area')
  })

  it('accepts the same key when nothing else holds it', () => {
    expect(findShortcutConflict(chordOf(DEFAULT_GLOBAL_SHORTCUTS.areaCapture), 'win32')).toBeNull()
  })
})

describe('acceptable bindings', () => {
  it('accepts the shipped default on every platform', () => {
    for (const platform of PLATFORMS) {
      expect(conflictFor(DEFAULT_GLOBAL_SHORTCUTS.quickLauncher, platform), platform).toBeNull()
    }
  })

  it('accepts a two-modifier combination that belongs to nobody', () => {
    expect(conflictFor('CommandOrControl+Alt+Space', 'win32')).toBeNull()
    expect(conflictFor('Control+Alt+Space', 'darwin')).toBeNull()
    expect(conflictFor('CommandOrControl+Alt+P', 'linux')).toBeNull()
    expect(conflictFor('F13', 'linux')).toBeNull()
  })

  it('covers every declared action with a default', () => {
    for (const id of GLOBAL_SHORTCUT_IDS) {
      expect(DEFAULT_GLOBAL_SHORTCUTS[id], id).toBeTruthy()
    }
  })
})
