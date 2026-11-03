/**
 * Windows light/dark theme backends for the OS Toolkit extension.
 *
 * Windows 11 has no user-facing custom schedule for the system theme, and
 * PowerToys Light Switch does not close the gap from here: its CLI cannot set
 * times (`schedule enable --mode` reuses whatever is already saved in PowerToys
 * Settings) and it exits 3 unless Light Switch is enabled. So ND owns the
 * schedule and this module owns only the apply step, with two interchangeable
 * backends:
 *
 * - `native` — the nd-core sidecar writes the HKCU `Personalize` DWORDs. No
 *   third-party software, which is the case PowerToys cannot serve.
 * - `powertoys` — delegates to `PowerToys.LightSwitch.CLI.exe` so Light Switch's
 *   own "Apply dark mode to" targets and Power Display monitor profiles are
 *   honored for people who already configured them.
 *
 * The CLI is confined to that one binary, following the ADB precedent in
 * `src/main/extensions/emulator-service.ts`: `execFile` only, never a shell,
 * never a caller-supplied path, arguments always from literal arrays.
 */

import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import type { OsThemeMode, OsToolkitBackendChoice, ThemeApplyTarget } from '../../shared/os-toolkit-schedule.js'
import type { CoreOsTheme, OsThemeState } from '../core/core-os-theme.js'

const execFileAsync = promisify(execFile)

/** The only executable this module is ever allowed to run. */
export const LIGHT_SWITCH_CLI = 'PowerToys.LightSwitch.CLI.exe'

const CLI_EXEC_OPTIONS = {
  windowsHide: true,
  timeout: 8_000,
  maxBuffer: 64 * 1024,
} as const

export type OsThemeBackend = 'native' | 'powertoys'
/**
 * What the UI can do about a failure. Every one of these maps to a control the
 * studio renders, so a message is never a dead end.
 */
export type ThemeActionable =
  | 'enable-light-switch'
  | 'switch-backend-native'
  | 'install-powertoys'
  | 'rebuild-core'

export interface LightSwitchStatus {
  installed: boolean
  /** True only when the service answered, which is what exit code 3 denies. */
  enabled: boolean
  /** Absolute path when discovered in a known install root; null means bare PATH. */
  path: string | null
  systemTheme?: OsThemeMode
  appsTheme?: OsThemeMode
  scheduleMode?: string
  manualOverride?: boolean
  changeSystem?: boolean
  changeApps?: boolean
  exitCode?: number
  message: string
  actionable?: ThemeActionable
}

export interface BackendResolution {
  backend: OsThemeBackend
  /** Why this backend was chosen, in words the studio can show. */
  reason: string
  lightSwitch: LightSwitchStatus
  nativeAvailable: boolean
}

export interface ThemeBackendDeps {
  core?: CoreOsTheme
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  onLog?: (line: string) => void
}

export interface ApplyOsThemeOptions extends ThemeBackendDeps {
  backend: OsThemeBackend
  apps: boolean
  system: boolean
}

export interface ApplyOsThemeResult {
  ok: boolean
  backend: OsThemeBackend
  message: string
  actionable?: ThemeActionable
  state?: OsThemeState
}

/**
 * Fixed install roots, tried before bare PATH. PowerToys documents that it puts
 * its own folder on PATH, so the bare name is the fallback rather than the plan —
 * and nothing here ever accepts a path from a caller.
 */
export function lightSwitchCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(
    (root): root is string => typeof root === 'string' && root.trim().length > 0,
  )
  return roots.flatMap((root) => [
    join(root, 'PowerToys', LIGHT_SWITCH_CLI),
    join(root, 'PowerToys', 'bin', LIGHT_SWITCH_CLI),
  ])
}

async function discoverLightSwitch(env: NodeJS.ProcessEnv): Promise<{ command: string; path: string | null }> {
  for (const candidate of lightSwitchCandidates(env)) {
    try {
      await access(candidate)
      return { command: candidate, path: candidate }
    } catch {
      // Not in this root; try the next one.
    }
  }
  return { command: LIGHT_SWITCH_CLI, path: null }
}

function exitCodeOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' ? code : null
}

function errorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Translate a Light Switch exit code into an instruction.
 *
 * Exit codes are documented by Microsoft as 0 ok, 1 the change failed, 2 invalid
 * arguments, 3 the service is unavailable, 4 timed out. Raw stderr is never
 * surfaced: the maintainer rule is actionable errors, not IPC codes.
 */
export function lightSwitchMessage(outcome: {
  exitCode?: number | null
  code?: string | undefined
}): { message: string; actionable?: ThemeActionable } {
  if (outcome.code === 'ENOENT' || outcome.code === 'EACCES') {
    return {
      message: 'PowerToys Light Switch is not installed. OS Toolkit will use the Native backend.',
      actionable: 'install-powertoys',
    }
  }
  if (outcome.code === 'ETIMEDOUT') {
    return {
      message: 'Light Switch did not answer in time. The theme may already have changed.',
    }
  }
  switch (outcome.exitCode) {
    case 0:
      return { message: 'PowerToys Light Switch applied the change.' }
    case 1:
      return {
        message: 'Light Switch refused the change. Check its "Apply dark mode to" targets in PowerToys Settings.',
      }
    case 2:
      return {
        message: 'Light Switch rejected the command. PowerToys may need an update.',
      }
    case 3:
      return {
        message: 'Light Switch is turned off in PowerToys. Enable it there, or switch OS Toolkit to the Native backend.',
        actionable: 'switch-backend-native',
      }
    case 4:
      return {
        message: 'Light Switch timed out. The status was re-read, because the change may still have been applied.',
      }
    default:
      return {
        message: 'PowerToys Light Switch could not be reached. Switch OS Toolkit to the Native backend to keep scheduling.',
        actionable: 'switch-backend-native',
      }
  }
}

/**
 * Parse `status --json`. The documented success shape is
 * `{"version":1,"success":true,"state":{...}}`; anything else degrades to null so
 * the caller reports "installed but unreadable" instead of guessing.
 */
export function parseLightSwitchStatus(stdout: string): Omit<LightSwitchStatus, 'installed' | 'enabled' | 'path' | 'message'> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const envelope = parsed as Record<string, unknown>
  if (envelope.success === false) return null
  const raw = envelope.state
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const state = raw as Record<string, unknown>

  const theme = (value: unknown): OsThemeMode | undefined =>
    value === 'dark' ? 'dark' : value === 'light' ? 'light' : undefined
  const flag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value : undefined

  const systemTheme = theme(state.systemTheme)
  const appsTheme = theme(state.appsTheme)
  const scheduleMode = text(state.scheduleMode)
  const manualOverride = flag(state.manualOverride)
  const changeSystem = flag(state.changeSystem)
  const changeApps = flag(state.changeApps)
  // A payload with nothing recognizable in it is not a status.
  if (
    systemTheme === undefined &&
    appsTheme === undefined &&
    scheduleMode === undefined &&
    manualOverride === undefined
  ) {
    return null
  }
  return {
    ...(systemTheme === undefined ? {} : { systemTheme }),
    ...(appsTheme === undefined ? {} : { appsTheme }),
    ...(scheduleMode === undefined ? {} : { scheduleMode }),
    ...(manualOverride === undefined ? {} : { manualOverride }),
    ...(changeSystem === undefined ? {} : { changeSystem }),
    ...(changeApps === undefined ? {} : { changeApps }),
  }
}

/** Ask the running Light Switch service what it thinks, without changing anything. */
export async function probeLightSwitch(deps: ThemeBackendDeps = {}): Promise<LightSwitchStatus> {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  if (platform !== 'win32') {
    return {
      installed: false,
      enabled: false,
      path: null,
      message: 'PowerToys Light Switch is a Windows utility. OS Toolkit uses the native path on this platform.',
    }
  }

  const { command, path } = await discoverLightSwitch(env)
  try {
    const { stdout } = await execFileAsync(command, ['status', '--json'], CLI_EXEC_OPTIONS)
    const state = parseLightSwitchStatus(stdout)
    if (!state) {
      return {
        installed: true,
        enabled: false,
        path,
        exitCode: 0,
        message: 'Light Switch answered but its status was not readable. OS Toolkit will use the Native backend.',
        actionable: 'switch-backend-native',
      }
    }
    return { installed: true, enabled: true, path, exitCode: 0, message: 'PowerToys Light Switch is running.', ...state }
  } catch (error) {
    const exitCode = exitCodeOf(error)
    const code = errorCodeOf(error)
    deps.onLog?.(`[os-toolkit] Light Switch status failed: code=${code ?? 'none'} exit=${exitCode ?? 'none'}`)
    const { message, actionable } = lightSwitchMessage({ exitCode, code })
    return {
      installed: code !== 'ENOENT',
      enabled: false,
      path,
      ...(exitCode === null ? {} : { exitCode }),
      message,
      ...(actionable === undefined ? {} : { actionable }),
    }
  }
}

function nativeUnavailableMessage(core: CoreOsTheme | undefined, platform: NodeJS.Platform): string | null {
  if (platform !== 'win32') return 'The Windows theme can only be changed on Windows.'
  if (!core) return 'The nd-core sidecar is not wired up, so the Windows theme cannot be changed.'
  if (!core.supported()) {
    return 'This nd-core build predates theme support. Rebuild it with pnpm core:build:dev, then restart ND.'
  }
  return null
}

/**
 * Decide which backend will actually be used.
 *
 * An explicit `powertoys` choice that cannot be honored falls back to native
 * rather than failing, but says so: silently doing nothing is the defect this
 * module exists to avoid, and silently ignoring the user's choice is the other
 * one. The `reason` is what the studio renders.
 */
export async function resolveBackend(
  choice: OsToolkitBackendChoice,
  deps: ThemeBackendDeps = {},
): Promise<BackendResolution> {
  const platform = deps.platform ?? process.platform
  const lightSwitch = await probeLightSwitch(deps)
  const nativeAvailable = nativeUnavailableMessage(deps.core, platform) === null

  if (choice === 'native') {
    return {
      backend: 'native',
      reason: nativeAvailable
        ? 'You chose the native path: ND writes the Windows theme directly.'
        : (nativeUnavailableMessage(deps.core, platform) ?? 'The native path is unavailable.'),
      lightSwitch,
      nativeAvailable,
    }
  }

  if (choice === 'powertoys') {
    if (lightSwitch.enabled) {
      return {
        backend: 'powertoys',
        reason: 'PowerToys Light Switch is running, so ND delegates to it and its monitor profiles apply.',
        lightSwitch,
        nativeAvailable,
      }
    }
    return {
      backend: nativeAvailable ? 'native' : 'powertoys',
      reason: nativeAvailable
        ? `You asked for PowerToys, but ${lowerFirst(lightSwitch.message)} Falling back to the native path.`
        : lightSwitch.message,
      lightSwitch,
      nativeAvailable,
    }
  }

  // auto
  if (lightSwitch.enabled) {
    return {
      backend: 'powertoys',
      reason: 'PowerToys Light Switch was detected and is enabled, so ND delegates to it.',
      lightSwitch,
      nativeAvailable,
    }
  }
  return {
    backend: 'native',
    reason: nativeAvailable
      ? 'PowerToys Light Switch is not available, so ND writes the Windows theme directly.'
      : (nativeUnavailableMessage(deps.core, platform) ?? 'No theme backend is available.'),
    lightSwitch,
    nativeAvailable,
  }
}

function lowerFirst(value: string): string {
  const head = value.charAt(0)
  return head.length === 0 ? value : head.toLowerCase() + value.slice(1)
}

/**
 * Map a native failure to an instruction. The stale-binary signal is matched
 * explicitly because `binaryVersion` is static and cannot detect it.
 */
export function describeNativeFailure(error: unknown): { message: string; actionable?: ThemeActionable } {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  if (raw.includes('unknown nd-core method')) {
    return {
      message: 'The running nd-core sidecar does not implement theme changes. Rebuild it with pnpm core:build:dev, then restart ND.',
      actionable: 'rebuild-core',
    }
  }
  if (raw.includes('ND Core is not running') || raw.includes('not answering')) {
    return { message: 'The nd-core sidecar is not running, so the Windows theme cannot be changed.' }
  }
  if (raw.includes('timed out')) {
    return { message: 'The theme change timed out. Windows may still be applying it.' }
  }
  // Rust already produces human text for the policy and type failures; anything
  // else is reported without leaking a code.
  if (raw.includes('organization policy')) {
    return { message: 'Your organization manages the Windows theme, so ND cannot change it.' }
  }
  return { message: 'Windows refused the theme change. Check whether your organization manages the theme.' }
}

async function currentNativeTheme(core: CoreOsTheme | undefined): Promise<OsThemeState | undefined> {
  if (!core) return undefined
  const state = await core.state()
  return state.available ? state : undefined
}

/**
 * Apply a theme through the chosen backend.
 *
 * `toggle` inverts what is currently on screen: through Light Switch's own
 * `toggle` command, or natively by reading the system DWORD first.
 */
export async function applyOsTheme(
  target: ThemeApplyTarget,
  options: ApplyOsThemeOptions,
): Promise<ApplyOsThemeResult> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const { backend, apps, system } = options

  if (backend === 'native') {
    const blocked = nativeUnavailableMessage(options.core, platform)
    if (blocked) {
      return {
        ok: false,
        backend,
        message: blocked,
        ...(platform === 'win32' ? { actionable: 'rebuild-core' as ThemeActionable } : {}),
      }
    }
    const core = options.core as CoreOsTheme
    try {
      let mode: OsThemeMode
      if (target === 'toggle') {
        const current = await currentNativeTheme(core)
        if (!current || !current.available) {
          return {
            ok: false,
            backend,
            message: 'The current Windows theme could not be read, so there is nothing to toggle from.',
          }
        }
        mode = current.systemTheme === 'dark' ? 'light' : 'dark'
      } else {
        mode = target
      }
      const state = await core.set({ theme: mode, apps, system })
      if (!state.available) {
        return { ok: false, backend, message: state.reason, actionable: 'rebuild-core' }
      }
      return {
        ok: true,
        backend,
        message: `Windows is now in ${mode} mode${apps && system ? '' : apps ? ' (apps only)' : ' (system only)'}.`,
        state,
      }
    } catch (error) {
      const { message, actionable } = describeNativeFailure(error)
      return { ok: false, backend, message, ...(actionable === undefined ? {} : { actionable }) }
    }
  }

  // PowerToys backend.
  if (platform !== 'win32') {
    return { ok: false, backend, message: 'PowerToys Light Switch is only available on Windows.' }
  }
  const { command } = await discoverLightSwitch(env)
  const args = target === 'toggle' ? ['toggle'] : target === 'dark' ? ['dark'] : ['light']
  try {
    await execFileAsync(command, args, CLI_EXEC_OPTIONS)
    return {
      ok: true,
      backend,
      message: target === 'toggle'
        ? 'PowerToys Light Switch toggled the theme.'
        : `PowerToys Light Switch applied ${target} mode.`,
    }
  } catch (error) {
    const exitCode = exitCodeOf(error)
    const code = errorCodeOf(error)
    options.onLog?.(`[os-toolkit] Light Switch ${args[0]} failed: code=${code ?? 'none'} exit=${exitCode ?? 'none'}`)
    // Exit 4 is documented as ambiguous: the change may still have applied, and
    // the CLI never retries. Read the status once before reporting so ND does not
    // tell the user something false.
    if (exitCode === 4) {
      const status = await probeLightSwitch(options)
      const applied = status.systemTheme ?? status.appsTheme
      return {
        ok: applied !== undefined,
        backend,
        message: applied === undefined
          ? 'Light Switch timed out and its status could not be read, so the current theme is unknown.'
          : `Light Switch timed out, but Windows is currently in ${applied} mode.`,
      }
    }
    const { message, actionable } = lightSwitchMessage({ exitCode, code })
    return { ok: false, backend, message, ...(actionable === undefined ? {} : { actionable }) }
  }
}

/** Ask Light Switch to stop running its own schedule, so the two cannot fight. */
export async function disableLightSwitchSchedule(deps: ThemeBackendDeps = {}): Promise<{ ok: boolean; message: string }> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return { ok: false, message: 'PowerToys Light Switch is only available on Windows.' }
  const env = deps.env ?? process.env
  const { command } = await discoverLightSwitch(env)
  try {
    await execFileAsync(command, ['schedule', 'disable'], CLI_EXEC_OPTIONS)
    return { ok: true, message: "ND turned off Light Switch's own schedule so the two schedulers cannot fight." }
  } catch (error) {
    const { message } = lightSwitchMessage({ exitCode: exitCodeOf(error), code: errorCodeOf(error) })
    return { ok: false, message }
  }
}
