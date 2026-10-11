import { describe, expect, it, vi } from 'vitest'
import { ShortcutRegistry, type GlobalShortcutGate } from '../src/main/shortcut-registry.js'
import { DEFAULT_GLOBAL_SHORTCUTS, type GlobalShortcutId } from '../src/shared/shortcuts.js'

vi.mock('electron', () => ({
  globalShortcut: { register: () => true, unregister: () => {}, unregisterAll: () => {} },
}))

const DEFAULT = DEFAULT_GLOBAL_SHORTCUTS.quickLauncher
const CUSTOM = 'CommandOrControl+Alt+Space'

function fakeGate(taken: string[] = []) {
  const held = new Set<string>()
  const gate: GlobalShortcutGate = {
    register(accelerator) {
      if (taken.includes(accelerator) || held.has(accelerator)) return false
      held.add(accelerator)
      return true
    },
    unregister: (accelerator) => { held.delete(accelerator) },
    unregisterAll: () => held.clear(),
  }
  return { gate, held }
}

function fakeStore() {
  const bindings: Record<GlobalShortcutId, string> = { ...DEFAULT_GLOBAL_SHORTCUTS }
  return {
    bindings,
    globalShortcuts: () => ({ ...bindings }),
    setGlobalShortcut: (id: GlobalShortcutId, accelerator: string) => {
      bindings[id] = accelerator
      return { ...bindings }
    },
  }
}

function build(taken: string[] = []) {
  const { gate, held } = fakeGate(taken)
  const store = fakeStore()
  const fired: string[] = []
  const registry = new ShortcutRegistry({
    store,
    handlers: {
      quickLauncher: () => fired.push('quickLauncher'),
      areaCapture: () => fired.push('areaCapture'),
      fullCapture: () => fired.push('fullCapture'),
      delayedCapture: () => fired.push('delayedCapture'),
    },
    platform: 'win32',
    gate,
  })
  return { registry, store, held, fired }
}

describe('shortcut registry', () => {
  it('registers the stored binding at startup and reports it active', () => {
    const { registry, held } = build()
    const state = registry.sync()
    expect(held.size).toBe(4)
    expect(held.has(DEFAULT)).toBe(true)
    expect(state.bindings.quickLauncher).toMatchObject({ accelerator: DEFAULT, isDefault: true, registered: true })
    expect(state.platform).toBe('win32')
  })

  it('syncs twice without dropping what it already holds', () => {
    const { registry, held } = build()
    registry.sync()
    registry.sync()
    expect(held.size).toBe(4)
    expect(registry.state().bindings.quickLauncher.registered).toBe(true)
  })

  it('swaps the OS registration when the user rebinds', () => {
    const { registry, store, held } = build()
    registry.sync()
    const state = registry.rebind('quickLauncher', CUSTOM)
    expect(held.has(CUSTOM)).toBe(true)
    expect(held.has(DEFAULT)).toBe(false)
    expect(store.bindings.quickLauncher).toBe(CUSTOM)
    expect(state.bindings.quickLauncher).toMatchObject({ accelerator: CUSTOM, isDefault: false, registered: true })
  })

  it('refuses an operating-system key and leaves the working binding alone', () => {
    const { registry, store, held } = build()
    registry.sync()
    expect(() => registry.rebind('quickLauncher', 'CommandOrControl+Alt+Delete')).toThrow(/secure sign-in screen/)
    expect(held.has(DEFAULT)).toBe(true)
    expect(store.bindings.quickLauncher).toBe(DEFAULT)
  })

  it('refuses a key another action already holds', () => {
    const { registry, store } = build()
    registry.sync()
    expect(() => registry.rebind('quickLauncher', DEFAULT_GLOBAL_SHORTCUTS.areaCapture)).toThrow(/Capture area/)
    expect(store.bindings.quickLauncher).toBe(DEFAULT)
  })

  it('rolls back when another application already owns the key', () => {
    const { registry, store, held } = build([CUSTOM])
    registry.sync()
    expect(() => registry.rebind('quickLauncher', CUSTOM)).toThrow(/Another application is already using this key/)
    // The previous binding is live again, so ND is never left with no launcher key.
    expect(held.has(DEFAULT)).toBe(true)
    expect(held.has(CUSTOM)).toBe(false)
    expect(store.bindings.quickLauncher).toBe(DEFAULT)
    expect(registry.state().bindings.quickLauncher.registered).toBe(true)
  })

  it('restores the shipped default when handed null', () => {
    const { registry, store, held } = build()
    registry.sync()
    registry.rebind('quickLauncher', CUSTOM)
    const state = registry.rebind('quickLauncher', null)
    expect(held.has(DEFAULT)).toBe(true)
    expect(held.has(CUSTOM)).toBe(false)
    expect(store.bindings.quickLauncher).toBe(DEFAULT)
    expect(state.bindings.quickLauncher.isDefault).toBe(true)
  })

  it('surfaces a binding it could not take at startup', () => {
    const { registry, held } = build([DEFAULT])
    registry.sync()
    // The other three actions still register; only the contested one is missing.
    expect(held.size).toBe(3)
    expect(registry.state().bindings.quickLauncher).toMatchObject({ registered: false })
    expect(registry.state().bindings.quickLauncher.unavailable).toContain('Another application')
  })

  it('rejects a malformed accelerator without touching the OS', () => {
    const { registry, store, held } = build()
    registry.sync()
    expect(() => registry.rebind('quickLauncher', 'CommandOrControl+Shift+Nonsense')).toThrow(/Unsupported shortcut key/)
    expect(() => registry.rebind('nope', CUSTOM)).toThrow(/Unknown global shortcut/)
    expect(held.has(DEFAULT)).toBe(true)
    expect(store.bindings.quickLauncher).toBe(DEFAULT)
  })

  it('retries a binding the OS refused once the key frees up', async () => {
    const taken = [DEFAULT]
    const { gate, held } = fakeGate(taken)
    const registry = new ShortcutRegistry({
      store: fakeStore(),
      handlers: {
        quickLauncher: () => {},
        areaCapture: () => {},
        fullCapture: () => {},
        delayedCapture: () => {},
      },
      platform: 'win32',
      gate,
      retryDelayMs: 10,
    })
    registry.sync()
    expect(registry.state().bindings.quickLauncher.registered).toBe(false)
    // The competing instance quits; the next retry takes the key.
    taken.length = 0
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(held.has(DEFAULT)).toBe(true)
    expect(registry.state().bindings.quickLauncher.registered).toBe(true)
    registry.dispose()
  })

  it('releases every key on dispose', () => {
    const { registry, held } = build()
    registry.sync()
    registry.dispose()
    expect(held.size).toBe(0)
  })
})
