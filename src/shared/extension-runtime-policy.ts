/** Profile-owned runtime controls; package manifests cannot opt themselves in. */
export interface ExtensionRuntimePolicy {
  backgroundExtensionIds: string[]
  maxBackgroundViews: number
  idleTimeoutMinutes: number
}

export const DEFAULT_EXTENSION_RUNTIME_POLICY: ExtensionRuntimePolicy = {
  backgroundExtensionIds: [],
  maxBackgroundViews: 4,
  idleTimeoutMinutes: 5,
}

export function normalizeExtensionRuntimePolicy(value: unknown): ExtensionRuntimePolicy {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const bounded = (key: string, fallback: number, min: number, max: number): number => {
    const input = raw[key]
    return typeof input === 'number' && Number.isFinite(input) ? Math.max(min, Math.min(max, Math.floor(input))) : fallback
  }
  return {
    backgroundExtensionIds: [...new Set(Array.isArray(raw.backgroundExtensionIds)
      ? raw.backgroundExtensionIds.filter((id): id is string => typeof id === 'string' && /^[a-z][a-z0-9.-]{1,159}$/.test(id)).slice(0, 1_000) : [])],
    maxBackgroundViews: bounded('maxBackgroundViews', 4, 0, 16),
    idleTimeoutMinutes: bounded('idleTimeoutMinutes', 5, 1, 20),
  }
}
