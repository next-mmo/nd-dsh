import { app, nativeTheme, type BrowserWindow, type TitleBarOverlay } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import type { DshSurface, EffectiveTheme, ThemeMode, ThemeState } from '../shared/contracts.js'
import { DEFAULT_QUICK_LAUNCHER_SHORTCUT_MODE, isQuickLauncherShortcutMode, type QuickLauncherShortcutMode } from '../shared/quick-launcher.js'
import {
  asShortcutPlatform,
  DEFAULT_CAPTURE_DELAY_SECONDS,
  DEFAULT_GLOBAL_SHORTCUTS,
  findShortcutConflict,
  GLOBAL_SHORTCUT_IDS,
  isCaptureDelaySeconds,
  isGlobalShortcutId,
  parseAccelerator,
  serializeChord,
  type CaptureDelaySeconds,
  type GlobalShortcutId,
} from '../shared/shortcuts.js'
import { DEFAULT_WORKSPACE_PROFILE, isWorkspaceProfile, type WorkspaceProfile } from '../shared/workspace-profile.js'

const SETTINGS_FILE = 'settings.json'
const DEFAULT_PERMISSION_MODE = 'workspace-write'

interface PersistedSettings {
  theme?: ThemeMode
  surface?: DshSurface
  permissionMode?: string
  quickLauncherMode?: QuickLauncherShortcutMode
  workspaceProfile?: WorkspaceProfile
  shortcuts?: Partial<Record<GlobalShortcutId, string>>
  captureDelaySeconds?: number
}

export type GlobalShortcutBindings = Record<GlobalShortcutId, string>

export const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const

interface WindowPalette {
  backgroundColor: string
  titleBar: TitleBarOverlay
}

const WINDOW_PALETTES: Record<EffectiveTheme, WindowPalette> = {
  light: {
    backgroundColor: '#f4f5f7',
    titleBar: { color: '#eef0f3', symbolColor: '#1a2027', height: 38 },
  },
  dark: {
    backgroundColor: '#0b0d10',
    titleBar: { color: '#101319', symbolColor: '#c5cad3', height: 38 },
  },
}

const BROWSER_VIEW_BACKGROUND: Record<EffectiveTheme, string> = {
  light: '#e9ebee',
  dark: '#080a0d',
}

const VALID_MODES: readonly ThemeMode[] = ['system', 'light', 'dark']
const VALID_SURFACES: readonly DshSurface[] = ['dsh', 'workbench']

/**
 * Owns the user's persisted preferences (settings.json): the theme and the
 * active UI surface. The renderer reads the effective theme (resolved against
 * the OS when in `system` mode) and applies it as a `data-theme` attribute;
 * this service keeps the native window chrome and the embedded views in sync
 * and persists the choices across restarts.
 */
export class ThemeService {
  private readonly settingsPath: string
  private mode: ThemeMode
  private surfaceValue: DshSurface
  private permissionModeValue: string
  private quickLauncherModeValue: QuickLauncherShortcutMode
  private workspaceProfileValue: WorkspaceProfile
  private shortcutsValue: GlobalShortcutBindings
  private captureDelayValue: CaptureDelaySeconds
  private window: BrowserWindow | undefined
  private setViewBackground: ((color: string) => void) | undefined
  private onChanged: ((state: ThemeState) => void) | undefined
  private onSurfaceChanged: ((surface: DshSurface) => void) | undefined

  constructor() {
    this.settingsPath = join(app.getPath('userData'), SETTINGS_FILE)
    this.mode = this.readMode()
    this.surfaceValue = this.readSurface()
    this.permissionModeValue = process.env.ND_DSH_PERMISSION_MODE?.trim() || this.readPermissionMode()
    this.quickLauncherModeValue = this.readQuickLauncherMode()
    this.workspaceProfileValue = this.readWorkspaceProfile()
    this.shortcutsValue = this.readShortcuts()
    this.captureDelayValue = this.readCaptureDelay()
    if (this.workspaceProfileValue === 'general' && this.surfaceValue === 'dsh') this.surfaceValue = 'workbench'
    nativeTheme.themeSource = this.mode
    nativeTheme.on('updated', () => this.emit())
  }

  state(): ThemeState {
    return { mode: this.mode, effective: this.effective() }
  }

  set(mode: ThemeMode): ThemeState {
    if (!VALID_MODES.includes(mode)) throw new Error(`Unknown theme mode: ${mode}`)
    this.mode = mode
    nativeTheme.themeSource = mode
    this.persist()
    this.applyWindowChrome()
    this.emit()
    return this.state()
  }

  surface(): DshSurface {
    return this.surfaceValue
  }

  setSurface(surface: DshSurface): DshSurface {
    if (!VALID_SURFACES.includes(surface)) throw new Error(`Unknown surface: ${surface}`)
    if (this.workspaceProfileValue === 'general' && surface === 'dsh') throw new Error('DSH coding surface requires the Coding workspace profile')
    this.surfaceValue = surface
    this.persist()
    this.onSurfaceChanged?.(surface)
    return surface
  }

  permissionMode(): string {
    return this.permissionModeValue
  }

  setPermissionMode(mode: string): string {
    if (!PERMISSION_MODES.includes(mode as (typeof PERMISSION_MODES)[number])) {
      throw new Error(`Unknown permission mode: ${mode}`)
    }
    this.permissionModeValue = mode
    this.persist()
    return mode
  }

  workspaceProfile(): WorkspaceProfile {
    return this.workspaceProfileValue
  }

  setWorkspaceProfile(profile: WorkspaceProfile): WorkspaceProfile {
    if (!isWorkspaceProfile(profile)) throw new Error(`Unknown workspace profile: ${String(profile)}`)
    this.workspaceProfileValue = profile
    if (profile === 'general' && this.surfaceValue === 'dsh') {
      this.surfaceValue = 'workbench'
      this.onSurfaceChanged?.(this.surfaceValue)
    }
    this.persist()
    return profile
  }

  quickLauncherMode(): QuickLauncherShortcutMode {
    return this.quickLauncherModeValue
  }

  setQuickLauncherMode(mode: QuickLauncherShortcutMode): QuickLauncherShortcutMode {
    if (!isQuickLauncherShortcutMode(mode)) throw new Error(`Unknown quick launcher mode: ${String(mode)}`)
    this.quickLauncherModeValue = mode
    this.persist()
    return mode
  }

  globalShortcuts(): GlobalShortcutBindings {
    return { ...this.shortcutsValue }
  }

  /**
   * Store-only write: shape validation lives here, while the OS-reserved and
   * registration checks belong to the shortcut registry that owns globalShortcut.
   */
  setGlobalShortcut(id: GlobalShortcutId, accelerator: string): GlobalShortcutBindings {
    if (!isGlobalShortcutId(id)) throw new Error(`Unknown global shortcut: ${String(id)}`)
    const chord = parseAccelerator(accelerator)
    if (!chord) throw new Error(`Unsupported shortcut key combination: ${accelerator}`)
    this.shortcutsValue[id] = serializeChord(chord)
    this.persist()
    return this.globalShortcuts()
  }

  captureDelay(): CaptureDelaySeconds {
    return this.captureDelayValue
  }

  setCaptureDelay(seconds: CaptureDelaySeconds): CaptureDelaySeconds {
    if (!isCaptureDelaySeconds(seconds)) throw new Error(`Unknown capture delay: ${String(seconds)}`)
    this.captureDelayValue = seconds
    this.persist()
    return seconds
  }

  windowBackgroundColor(): string {
    return WINDOW_PALETTES[this.effective()].backgroundColor
  }

  titleBarOverlay(): TitleBarOverlay {
    return WINDOW_PALETTES[this.effective()].titleBar
  }

  /** Attach the live window so theme changes re-paint native chrome. */
  attach(window: BrowserWindow, setViewBackground: (color: string) => void): void {
    this.window = window
    this.setViewBackground = setViewBackground
    this.applyWindowChrome()
  }

  setOnChanged(listener: (state: ThemeState) => void): void {
    this.onChanged = listener
  }

  setOnSurfaceChanged(listener: (surface: DshSurface) => void): void {
    this.onSurfaceChanged = listener
  }

  private effective(): EffectiveTheme {
    if (this.mode !== 'system') return this.mode
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }

  private applyWindowChrome(): void {
    if (!this.window || this.window.isDestroyed()) return
    const palette = WINDOW_PALETTES[this.effective()]
    this.window.setBackgroundColor(palette.backgroundColor)
    if (process.platform !== 'darwin') this.window.setTitleBarOverlay(palette.titleBar)
    this.setViewBackground?.(BROWSER_VIEW_BACKGROUND[this.effective()])
  }

  private emit(): void {
    if (this.window && !this.window.isDestroyed()) this.onChanged?.(this.state())
  }

  private readMode(): ThemeMode {
    try {
      const settings = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as PersistedSettings
      if (settings.theme && VALID_MODES.includes(settings.theme)) return settings.theme
    } catch {
      // Missing or unreadable settings fall back to following the OS.
    }
    return 'system'
  }

  private readSurface(): DshSurface {
    try {
      const settings = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as PersistedSettings
      if (settings.surface && VALID_SURFACES.includes(settings.surface)) return settings.surface
    } catch {
      // Missing or unreadable settings keep ND as the primary coding surface.
    }
    return 'workbench'
  }

  private readPermissionMode(): string {
    try {
      const settings = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as PersistedSettings
      if (settings.permissionMode && PERMISSION_MODES.includes(settings.permissionMode as (typeof PERMISSION_MODES)[number])) {
        return settings.permissionMode
      }
    } catch {
      // Missing or unreadable settings fall back to workspace-write.
    }
    return DEFAULT_PERMISSION_MODE
  }

  private readWorkspaceProfile(): WorkspaceProfile {
    try {
      const settings = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as PersistedSettings
      if (isWorkspaceProfile(settings.workspaceProfile)) return settings.workspaceProfile
      if (settings.surface && VALID_SURFACES.includes(settings.surface)) return 'coding'
    } catch {
      // Missing settings means a fresh install, whose broadest audience is General.
    }
    return DEFAULT_WORKSPACE_PROFILE
  }

  private readQuickLauncherMode(): QuickLauncherShortcutMode {
    try {
      const settings = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as PersistedSettings
      if (isQuickLauncherShortcutMode(settings.quickLauncherMode)) return settings.quickLauncherMode
    } catch {
      // Missing or unreadable settings fall back to the popup shortcut.
    }
    return DEFAULT_QUICK_LAUNCHER_SHORTCUT_MODE
  }

  /**
   * A stored binding is only honoured if it is still safe on *this* OS. Settings
   * travel between machines, and a combo that was free on Linux can be a shell
   * hotkey on Windows; falling back to the default beats grabbing a system key.
   */
  private readShortcuts(): GlobalShortcutBindings {
    const platform = asShortcutPlatform(process.platform)
    const bindings: GlobalShortcutBindings = { ...DEFAULT_GLOBAL_SHORTCUTS }
    try {
      const settings = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as PersistedSettings
      const stored = settings.shortcuts
      if (!stored || typeof stored !== 'object') return bindings
      for (const id of GLOBAL_SHORTCUT_IDS) {
        const value = stored[id]
        if (typeof value !== 'string') continue
        const chord = parseAccelerator(value)
        if (!chord) continue
        if (findShortcutConflict(chord, platform)) continue
        bindings[id] = serializeChord(chord)
      }
    } catch {
      // Missing or unreadable settings keep ND's shipped shortcuts.
    }
    return bindings
  }

  private readCaptureDelay(): CaptureDelaySeconds {
    try {
      const settings = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as PersistedSettings
      if (isCaptureDelaySeconds(settings.captureDelaySeconds)) return settings.captureDelaySeconds
    } catch {
      // Missing or unreadable settings keep the default countdown.
    }
    return DEFAULT_CAPTURE_DELAY_SECONDS
  }

  private persist(): void {
    try {
      const settings: PersistedSettings = {
        theme: this.mode,
        surface: this.surfaceValue,
        permissionMode: this.permissionModeValue,
        quickLauncherMode: this.quickLauncherModeValue,
        workspaceProfile: this.workspaceProfileValue,
        shortcuts: this.shortcutsValue,
        captureDelaySeconds: this.captureDelayValue,
      }
      writeFileSync(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    } catch (error) {
      console.warn('Failed to persist settings:', error)
    }
  }
}
