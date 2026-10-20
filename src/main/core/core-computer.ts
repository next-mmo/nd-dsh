import type { CoreClient } from './core-client.js'

export interface CoreComputerWindow {
  id: string
  title?: string
  width: number
  height: number
  focused: boolean
  minimized: boolean
}

export interface CoreComputerApp {
  id: string
  displayName: string
  windows: CoreComputerWindow[]
  isRunning: boolean
}

export interface CoreComputerApps {
  apps: CoreComputerApp[]
  truncated: boolean
}

export interface CoreComputerScreenshot {
  id: string
  zIndex: number
  url: string
  originX?: number
  originY?: number
  width?: number
  height?: number
}

export interface CoreComputerAccessibility {
  tree: string
  focusedElement?: string
  selectedText?: string
  selectedElements?: string[]
  documentText?: string
}

export interface CoreComputerAppStateParams {
  app: string
  windowId?: string
  sessionId: string
  includeScreenshot?: boolean
  includeText?: boolean
  disableDiff?: boolean
}

export interface CoreComputerAppState {
  app: { id: string; displayName: string }
  window: { id: string; title?: string }
  screenshots: CoreComputerScreenshot[]
  accessibility: CoreComputerAccessibility | null
  textMode: 'full' | 'diff' | 'none'
  stateId: string
  screenshotUnavailable?: string
  stats: {
    nodes: number
    truncated: boolean
    elapsedMs: number
    changed?: number
    added?: number
    removed?: number
  }
  limits: {
    maxNodes: number
    maxDepth: number
    maxTextChars: number
    maxScreenshotBytes: number
  }
}

/**
 * Read-only desktop state lives in nd-core: window enumeration, UI Automation,
 * capture, and the diff cache all run in the sidecar. This adapter only names
 * the RPC surface so host handlers never assemble raw core requests.
 */
export interface CoreComputer {
  listApps(): Promise<CoreComputerApps>
  appState(params: CoreComputerAppStateParams): Promise<CoreComputerAppState>
  resetSession(sessionId: string): Promise<{ reset: boolean }>
}

const STATE_TIMEOUT_MS = 20_000
const LIST_TIMEOUT_MS = 10_000
const RESET_TIMEOUT_MS = 5_000

export function createCoreComputer(core: Pick<CoreClient, 'request'>): CoreComputer {
  return {
    async listApps() {
      return await core.request<CoreComputerApps>('computer.apps.list', {}, LIST_TIMEOUT_MS)
    },
    async appState(params) {
      return await core.request<CoreComputerAppState>('computer.app.state', params, STATE_TIMEOUT_MS)
    },
    async resetSession(sessionId) {
      return await core.request<{ reset: boolean }>('computer.session.reset', { sessionId }, RESET_TIMEOUT_MS)
    },
  }
}
