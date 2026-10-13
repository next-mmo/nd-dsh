/**
 * Shared contracts for the ND Quick Launcher global shortcut and popup window.
 * Consumed by the main process (shortcut routing, popup window), the preload
 * bridge, and the renderer (settings surface), so every side agrees on the
 * persisted mode names and handoff targets.
 */

import type { NdContext } from './nd-context.js'

export type QuickLauncherShortcutMode = 'popup' | 'window-launcher' | 'window'

export const QUICK_LAUNCHER_SHORTCUT_MODES: readonly QuickLauncherShortcutMode[] = [
  'popup',
  'window-launcher',
  'window',
]

/** Raycast-style: the shortcut floats a launcher card over the current app. */
export const DEFAULT_QUICK_LAUNCHER_SHORTCUT_MODE: QuickLauncherShortcutMode = 'popup'

export function isQuickLauncherShortcutMode(value: unknown): value is QuickLauncherShortcutMode {
  return typeof value === 'string' && (QUICK_LAUNCHER_SHORTCUT_MODES as readonly string[]).includes(value)
}

/**
 * What one press of the global shortcut does for a mode. Every mode is a
 * toggle: the same press that shows the surface must dismiss it again.
 */
export type QuickLauncherShortcutAction =
  | { kind: 'toggle-popup' }
  | { kind: 'toggle-window-launcher' }
  | { kind: 'toggle-window' }

export function resolveShortcutBehavior(mode: QuickLauncherShortcutMode): QuickLauncherShortcutAction {
  switch (mode) {
    case 'popup':
      return { kind: 'toggle-popup' }
    case 'window-launcher':
      return { kind: 'toggle-window-launcher' }
    case 'window':
      return { kind: 'toggle-window' }
  }
}

/**
 * Popup-surface actions that cannot complete inside the popup (chat state,
 * the embedded browser, and capture flows live in the full app window), so
 * the popup hands off: main hides the popup, focuses the main window, and
 * forwards the target for the main-window renderer to execute.
 */
export type LauncherHandoffTarget =
  | 'launcher'
  | 'home'
  | 'kanban'
  | 'agent'
  | 'browser'
  | 'capture-screen'
  | 'capture-tools'
  | 'capture-clipboard'
  | 'extension-view'

export const LAUNCHER_HANDOFF_TARGETS: readonly LauncherHandoffTarget[] = [
  'launcher',
  'home',
  'kanban',
  'agent',
  'browser',
  'capture-screen',
  'capture-tools',
  'capture-clipboard',
  'extension-view',
]

export function isLauncherHandoffTarget(value: unknown): value is LauncherHandoffTarget {
  return typeof value === 'string' && (LAUNCHER_HANDOFF_TARGETS as readonly string[]).includes(value)
}

// Use the established browser target so a hot-reloaded renderer can hand off
// to a main process that started before existing-tab navigation was added.
const BROWSER_TAB_PAYLOAD_PREFIX = 'nd-browser-tab:'

export function launcherBrowserTabPayload(tabId: string): string {
  return `${BROWSER_TAB_PAYLOAD_PREFIX}${encodeURIComponent(tabId)}`
}

export function launcherBrowserTabId(text?: string): string | null {
  if (!text?.startsWith(BROWSER_TAB_PAYLOAD_PREFIX)) return null
  try {
    return decodeURIComponent(text.slice(BROWSER_TAB_PAYLOAD_PREFIX.length)) || null
  } catch {
    return null
  }
}

/**
 * A handoff may carry the context the popup was showing, so work started from
 * Personal stays personal even when the main window has a project selected.
 */
export interface LauncherHandoff {
  target: LauncherHandoffTarget
  text?: string
  context?: NdContext
}
