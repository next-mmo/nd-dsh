/**
 * How a web-chat engine (Gemini Web today) drives ND's visible browser pane.
 * Every mode acts on the same embedded WebContentsView; none launches another
 * browser or changes the signed-in profile.
 */
export type WebBrowserMode = 'auto' | 'extension' | 'cdp' | 'browser-agent'

/** A concrete transport Auto may pick; `auto` itself is never executed. */
export type WebBrowserTransport = Exclude<WebBrowserMode, 'auto'>

export const WEB_BROWSER_MODES: readonly WebBrowserMode[] = ['auto', 'extension', 'cdp', 'browser-agent']

export const DEFAULT_WEB_BROWSER_MODE: WebBrowserMode = 'auto'

export const WEB_BROWSER_MODE_LABELS: Record<WebBrowserMode, string> = {
  auto: 'Auto',
  extension: 'Extension',
  cdp: 'CDP',
  'browser-agent': 'Browser Agent',
}

export const WEB_BROWSER_MODE_DESCRIPTIONS: Record<WebBrowserMode, string> = {
  auto: 'Pick the safest compatible method; falls back only when nothing was sent.',
  extension: 'Content-script style DOM integration inside ND\'s browser tab (no debugger socket).',
  cdp: 'Loopback Chrome DevTools Protocol against ND\'s visible tab.',
  'browser-agent': 'Observe → act → verify loop over the page\'s semantic elements.',
}

export interface WebBrowserModeSettings {
  mode: WebBrowserMode
  /** Auto may use Browser Agent as a last resort for changed layouts. Opt-in. */
  agentFallback: boolean
  /** Capture a screenshot as recovery evidence when a Browser Agent step fails. */
  visualRecovery: boolean
}

export const DEFAULT_WEB_BROWSER_MODE_SETTINGS: WebBrowserModeSettings = {
  mode: DEFAULT_WEB_BROWSER_MODE,
  agentFallback: false,
  visualRecovery: true,
}

export function isWebBrowserMode(value: unknown): value is WebBrowserMode {
  return typeof value === 'string' && (WEB_BROWSER_MODES as readonly string[]).includes(value)
}

/** Normalize untrusted (persisted or IPC) input; unknown fields fall back to defaults. */
export function normalizeWebBrowserModeSettings(value: unknown): WebBrowserModeSettings {
  const input = value && typeof value === 'object' ? value as Partial<Record<keyof WebBrowserModeSettings, unknown>> : {}
  return {
    mode: isWebBrowserMode(input.mode) ? input.mode : DEFAULT_WEB_BROWSER_MODE_SETTINGS.mode,
    agentFallback: typeof input.agentFallback === 'boolean' ? input.agentFallback : DEFAULT_WEB_BROWSER_MODE_SETTINGS.agentFallback,
    visualRecovery: typeof input.visualRecovery === 'boolean' ? input.visualRecovery : DEFAULT_WEB_BROWSER_MODE_SETTINGS.visualRecovery,
  }
}
