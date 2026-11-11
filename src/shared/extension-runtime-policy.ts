/** Profile-owned runtime controls; package manifests cannot opt themselves in. */
export interface ExtensionRuntimePolicy {
  /** Explicit user opt-ins, for extensions that are off by default. */
  backgroundExtensionIds: string[]
  /** Explicit user opt-outs, so an ND default can be turned off and stay off. */
  backgroundDisabledExtensionIds: string[]
  /** Extensions whose views open windowed instead of the full-screen default. */
  fullscreenDisabledExtensionIds: string[]
  maxBackgroundViews: number
  idleTimeoutMinutes: number
}

/**
 * ND-maintained defaults, not package declarations: these extensions stream
 * live audio, and releasing their view when the dialog closes cuts the sound
 * the user is listening to. Everything else stays off until asked for.
 */
export const DEFAULT_BACKGROUND_EXTENSION_IDS: readonly string[] = ['nd.phone-audio', 'nd.tutor']

export const DEFAULT_EXTENSION_RUNTIME_POLICY: ExtensionRuntimePolicy = {
  backgroundExtensionIds: [],
  backgroundDisabledExtensionIds: [],
  fullscreenDisabledExtensionIds: [],
  maxBackgroundViews: 4,
  idleTimeoutMinutes: 5,
}

const EXTENSION_ID = /^[a-z][a-z0-9.-]{1,159}$/

function extensionIdList(value: unknown): string[] {
  return [...new Set(Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && EXTENSION_ID.test(id)).slice(0, 1_000)
    : [])]
}

export function normalizeExtensionRuntimePolicy(value: unknown): ExtensionRuntimePolicy {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const bounded = (key: string, fallback: number, min: number, max: number): number => {
    const input = raw[key]
    return typeof input === 'number' && Number.isFinite(input) ? Math.max(min, Math.min(max, Math.floor(input))) : fallback
  }
  return {
    backgroundExtensionIds: extensionIdList(raw.backgroundExtensionIds),
    backgroundDisabledExtensionIds: extensionIdList(raw.backgroundDisabledExtensionIds),
    fullscreenDisabledExtensionIds: extensionIdList(raw.fullscreenDisabledExtensionIds),
    maxBackgroundViews: bounded('maxBackgroundViews', 4, 0, 16),
    idleTimeoutMinutes: bounded('idleTimeoutMinutes', 5, 1, 20),
  }
}

/** A user opt-out beats an ND default; an opt-in beats the default being off. */
export function extensionRunsInBackground(policy: ExtensionRuntimePolicy, extensionId: string): boolean {
  if (policy.backgroundDisabledExtensionIds.includes(extensionId)) return false
  if (policy.backgroundExtensionIds.includes(extensionId)) return true
  return DEFAULT_BACKGROUND_EXTENSION_IDS.includes(extensionId)
}

/** The two lists a toggle writes, so a choice is remembered in either direction. */
export function setBackgroundExtension(policy: ExtensionRuntimePolicy, extensionId: string, enabled: boolean): ExtensionRuntimePolicy {
  const without = (ids: string[]): string[] => ids.filter((id) => id !== extensionId)
  return {
    ...policy,
    backgroundExtensionIds: enabled ? [...new Set([...policy.backgroundExtensionIds, extensionId])] : without(policy.backgroundExtensionIds),
    backgroundDisabledExtensionIds: enabled ? without(policy.backgroundDisabledExtensionIds) : [...new Set([...policy.backgroundDisabledExtensionIds, extensionId])],
  }
}

/** Views open full screen unless the user asked for a windowed one. */
export function extensionOpensFullscreen(policy: ExtensionRuntimePolicy, extensionId: string): boolean {
  return !policy.fullscreenDisabledExtensionIds.includes(extensionId)
}

/** Remembered per extension, so a backgrounded view reopens in the mode it was left in. */
export function setExtensionFullscreen(policy: ExtensionRuntimePolicy, extensionId: string, enabled: boolean): ExtensionRuntimePolicy {
  const without = policy.fullscreenDisabledExtensionIds.filter((id) => id !== extensionId)
  return {
    ...policy,
    fullscreenDisabledExtensionIds: enabled ? without : [...new Set([...policy.fullscreenDisabledExtensionIds, extensionId])],
  }
}
