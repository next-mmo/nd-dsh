import { globalShortcut } from 'electron'
import process from 'node:process'
import {
  asShortcutPlatform,
  DEFAULT_GLOBAL_SHORTCUTS,
  findShortcutConflict,
  GLOBAL_SHORTCUT_IDS,
  isGlobalShortcutId,
  parseAccelerator,
  serializeChord,
  type GlobalShortcutId,
  type GlobalShortcutState,
  type ShortcutBindingState,
  type ShortcutPlatform,
} from '../shared/shortcuts.js'

/** Injectable so the rebind and rollback paths are testable without Electron. */
export interface GlobalShortcutGate {
  register(accelerator: string, handler: () => void): boolean
  unregister(accelerator: string): void
  unregisterAll(): void
}

/** The persisted half of a binding, owned by ThemeService. */
export interface ShortcutBindingStore {
  globalShortcuts(): Record<GlobalShortcutId, string>
  setGlobalShortcut(id: GlobalShortcutId, accelerator: string): Record<GlobalShortcutId, string>
}

/**
 * Sole owner of ND's OS-wide hotkeys.
 *
 * Registration is best-effort by nature: `globalShortcut.register` returns false
 * when another process already claimed the accelerator and throws when Electron
 * cannot parse it. A rebind therefore swaps atomically and rolls the previous
 * binding back on failure, so a rejected key never leaves the user with no way
 * to reach the launcher.
 */
export class ShortcutRegistry {
  private readonly gate: GlobalShortcutGate
  private readonly store: ShortcutBindingStore
  private readonly handlers: Record<GlobalShortcutId, () => void>
  private readonly platform: ShortcutPlatform
  private readonly retryDelayMs: number
  private readonly live = new Map<GlobalShortcutId, string>()
  private readonly failures = new Map<GlobalShortcutId, string>()
  private readonly pending = new Set<GlobalShortcutId>()
  private retryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: {
    store: ShortcutBindingStore
    handlers: Record<GlobalShortcutId, () => void>
    platform?: string
    gate?: GlobalShortcutGate
    /** How often a binding the OS refused at startup is retried. */
    retryDelayMs?: number
  }) {
    this.gate = options.gate ?? globalShortcut
    this.store = options.store
    this.handlers = options.handlers
    this.platform = asShortcutPlatform(options.platform ?? process.platform)
    this.retryDelayMs = options.retryDelayMs ?? 10_000
  }

  /** Take every persisted binding. Idempotent: createWindow may run more than once. */
  sync(): GlobalShortcutState {
    const bindings = this.store.globalShortcuts()
    for (const id of GLOBAL_SHORTCUT_IDS) {
      if (this.live.get(id) === bindings[id]) continue
      this.acquire(id, bindings[id])
    }
    return this.state()
  }

  state(): GlobalShortcutState {
    const bindings = this.store.globalShortcuts()
    const result = {} as Record<GlobalShortcutId, ShortcutBindingState>
    for (const id of GLOBAL_SHORTCUT_IDS) {
      const accelerator = bindings[id]
      const registered = this.live.get(id) === accelerator
      result[id] = registered
        ? { accelerator, isDefault: accelerator === DEFAULT_GLOBAL_SHORTCUTS[id], registered: true }
        : {
          accelerator,
          isDefault: accelerator === DEFAULT_GLOBAL_SHORTCUTS[id],
          registered: false,
          unavailable: this.failures.get(id) ?? 'This key could not be registered.',
        }
    }
    return { platform: this.platform, bindings: result }
  }

  /**
   * Rebind one action; `null` restores the shipped default. Throws with the
   * user-facing reason when the chord is refused or unavailable, leaving the
   * previous binding live and the store untouched.
   */
  rebind(id: unknown, accelerator: unknown): GlobalShortcutState {
    if (!isGlobalShortcutId(id)) throw new Error(`Unknown global shortcut: ${String(id)}`)
    const requested = accelerator === null || accelerator === undefined ? DEFAULT_GLOBAL_SHORTCUTS[id] : accelerator
    if (typeof requested !== 'string') throw new Error('A shortcut must be a key combination, or null to reset it')
    const chord = parseAccelerator(requested)
    if (!chord) throw new Error(`Unsupported shortcut key combination: ${requested}`)
    const bindings = this.store.globalShortcuts()
    const taken = {} as Record<GlobalShortcutId, string>
    for (const other of GLOBAL_SHORTCUT_IDS) {
      if (other !== id) taken[other] = bindings[other]
    }
    const conflict = findShortcutConflict(chord, this.platform, taken)
    if (conflict) throw new Error(conflict.message)

    const target = serializeChord(chord)
    const previous = this.live.get(id)
    if (previous === target) {
      this.store.setGlobalShortcut(id, target)
      this.failures.delete(id)
      return this.state()
    }

    this.release(id)
    const failure = this.bind(id, target)
    if (failure !== null) {
      // Roll back: ND keeps working rather than being left with no launcher key.
      if (previous) this.acquire(id, previous)
      throw new Error(failure)
    }
    this.store.setGlobalShortcut(id, target)
    return this.state()
  }

  dispose(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.pending.clear()
    this.gate.unregisterAll()
    this.live.clear()
    this.failures.clear()
  }

  /**
   * A key refused at startup may free up later — typically a second ND instance
   * quitting. Keep retrying so the binding heals without a restart.
   */
  private scheduleRetry(): void {
    if (this.retryTimer !== undefined || this.pending.size === 0) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      for (const id of [...this.pending]) {
        const target = this.store.globalShortcuts()[id]
        if (this.live.get(id) === target) {
          this.pending.delete(id)
          continue
        }
        if (this.bind(id, target) === null) {
          this.pending.delete(id)
          console.log(`ND global shortcut for ${id} is registered now (${target})`)
        }
      }
      this.scheduleRetry()
    }, this.retryDelayMs)
    // A pending hotkey retry must never keep the process alive.
    this.retryTimer.unref?.()
  }

  /** Register and record the outcome. Returns null on success, else the reason. */
  private bind(id: GlobalShortcutId, accelerator: string): string | null {
    const failure = this.register(id, accelerator)
    if (failure === null) {
      this.live.set(id, accelerator)
      this.failures.delete(id)
      this.pending.delete(id)
      return null
    }
    this.live.delete(id)
    this.failures.set(id, failure)
    return failure
  }

  private acquire(id: GlobalShortcutId, accelerator: string): void {
    const failure = this.bind(id, accelerator)
    if (failure === null) return
    this.pending.add(id)
    this.scheduleRetry()
    console.warn(`ND global shortcut for ${id} is unavailable (${accelerator}): ${failure}`)
  }

  private release(id: GlobalShortcutId): void {
    const accelerator = this.live.get(id)
    if (!accelerator) return
    this.gate.unregister(accelerator)
    this.live.delete(id)
  }

  /** Returns null on success, otherwise the reason the OS refused the accelerator. */
  private register(id: GlobalShortcutId, accelerator: string): string | null {
    try {
      if (this.gate.register(accelerator, this.handlers[id])) return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    return 'Another application is already using this key.'
  }
}
