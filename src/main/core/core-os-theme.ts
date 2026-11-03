import type { OsThemeMode } from '../../shared/os-toolkit-schedule.js'
import type { CoreClient } from './core-client.js'
import type { NdCoreHealth } from './core-protocol.js'

/**
 * The `os.theme-get` / `os.theme-set` wire shape owned by `nd_runtime::os_theme`.
 *
 * Windows theme changes live in the sidecar for the same reason wallpaper changes
 * do: `src/main/os/wallpaper.ts` deliberately refuses to run a shell command on
 * Windows, and a `reg.exe` spawn per change would pay process startup for what is
 * a two-DWORD write plus a broadcast.
 */
export type OsThemeState =
  | { available: true; appsTheme: OsThemeMode; systemTheme: OsThemeMode; platform: string }
  | { available: false; reason: string; platform: string }

export interface OsThemeSetParams {
  theme: OsThemeMode
  apps?: boolean
  system?: boolean
}

export interface CoreOsTheme {
  state(): Promise<OsThemeState>
  /** Throws on failure so the caller can turn it into an actionable message. */
  set(params: OsThemeSetParams): Promise<OsThemeState>
  /**
   * True when the *running* sidecar declared the `os-theme` capability.
   *
   * `health.binaryVersion` is `env!("CARGO_PKG_VERSION")` and never changes, so it
   * cannot distinguish a fresh build from a stale one. The capability list can,
   * which is what makes "rebuild nd-core" a precise instruction instead of a guess.
   */
  supported(): boolean
}

export function validateOsThemeSetParams(value: unknown): OsThemeSetParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid theme update')
  const params = value as Record<string, unknown>
  if (
    Object.keys(params).some((key) => key !== 'theme' && key !== 'apps' && key !== 'system') ||
    (params.theme !== 'light' && params.theme !== 'dark') ||
    (params.apps !== undefined && typeof params.apps !== 'boolean') ||
    (params.system !== undefined && typeof params.system !== 'boolean')
  ) {
    throw new Error('Invalid theme update')
  }
  // Targeting neither DWORD would be a silent no-op, which is worse than an error.
  if (params.apps === false && params.system === false) {
    throw new Error('A theme update must target apps or system')
  }
  // Rebuilt rather than cast, so an unknown key can never ride along and the
  // optional properties stay genuinely absent instead of present-and-undefined.
  return {
    theme: params.theme,
    ...(typeof params.apps === 'boolean' ? { apps: params.apps } : {}),
    ...(typeof params.system === 'boolean' ? { system: params.system } : {}),
  }
}

function unavailable(reason: string): OsThemeState {
  return { available: false, reason, platform: 'unknown' }
}

export function createCoreOsTheme(
  core: Pick<CoreClient, 'request'> & Partial<Pick<CoreClient, 'health'>>,
): CoreOsTheme {
  return {
    supported: () => Boolean(core.health?.capabilities?.includes('os-theme')),
    async state() {
      // A read never throws: callers render `available: false` as an honest state
      // rather than an error, so a stopped sidecar degrades instead of failing.
      if (!this.supported()) {
        return unavailable('This nd-core build does not support theme changes. Rebuild it with pnpm core:build:dev.')
      }
      try {
        return await core.request<OsThemeState>('os.theme-get', {}, 3_000)
      } catch {
        return unavailable('The nd-core sidecar is not answering, so the Windows theme could not be read.')
      }
    },
    async set(params) {
      if (!this.supported()) {
        throw new Error('unknown nd-core method: os.theme-set')
      }
      return await core.request<OsThemeState>('os.theme-set', validateOsThemeSetParams(params), 5_000)
    },
  }
}

export type { NdCoreHealth }
