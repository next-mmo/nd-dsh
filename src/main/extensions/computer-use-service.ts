import { createHash } from 'node:crypto'
import type {
  CoreComputer,
  CoreComputerAppState,
  CoreComputerApps,
} from '../core/core-computer.js'

/** Matches ND_WEBVIEW_MAX_MESSAGE_CHARS; the frame receives one bounded payload. */
const BRIDGE_MAX_CHARS = 262_144
const READ_WINDOW_MS = 10_000
const READ_WINDOW_LIMIT = 4
const MINUTE_WINDOW_MS = 60_000
const MINUTE_LIMIT = 20

export interface ComputerUseCallContext {
  extensionId: string
  contextKey: string
  caller: 'user' | 'agent'
}

export interface ComputerUseStateInput {
  app?: unknown
  windowId?: unknown
  includeScreenshot?: unknown
  includeText?: unknown
  disableDiff?: unknown
}

interface SessionUsage {
  inFlight: boolean
  reads: number[]
}

/**
 * Owns the extension-facing policy that must not live in the native side:
 * per-context identity, read rate limits, agent title redaction, and the
 * web-view payload budget. The Rust side owns enumeration, UIA, capture, and
 * the actual tree diff cache.
 */
export class ComputerUseService {
  private readonly sessions = new Map<string, SessionUsage>()

  constructor(private readonly core: CoreComputer) {}

  async listApps(context: ComputerUseCallContext): Promise<CoreComputerApps> {
    this.noteRead(this.sessionId(context.extensionId, context.contextKey))
    const result = await this.core.listApps()
    if (context.caller === 'agent') {
      return {
        ...result,
        apps: result.apps.map((app) => ({
          ...app,
          windows: app.windows.map(({ title: _title, ...window }) => window),
        })),
      }
    }
    return result
  }

  async appState(
    input: ComputerUseStateInput,
    context: ComputerUseCallContext,
  ): Promise<CoreComputerAppState> {
    const sessionId = this.sessionId(context.extensionId, context.contextKey)
    this.noteRead(sessionId)
    const usage = this.sessions.get(sessionId)!
    if (usage.inFlight) throw new Error('A Computer Use read is already in progress for this extension')
    usage.inFlight = true
    try {
      const app = requiredText(input.app, 'App', 256)
      const windowId = optionalText(input.windowId, 'Window id', 128)
      const includeScreenshot = optionalBoolean(input.includeScreenshot)
      const includeText = optionalBoolean(input.includeText)
      const disableDiff = optionalBoolean(input.disableDiff)
      const result = await this.core.appState({
        app,
        ...(windowId ? { windowId } : {}),
        sessionId,
        ...(includeScreenshot === undefined ? {} : { includeScreenshot }),
        ...(includeText === undefined ? {} : { includeText }),
        ...(disableDiff === undefined ? {} : { disableDiff }),
      })
      return fitBridge(result)
    } finally {
      usage.inFlight = false
    }
  }

  async reset(extensionId: string, contextKey: string): Promise<boolean> {
    const sessionId = this.sessionId(extensionId, contextKey)
    this.sessions.delete(sessionId)
    const result = await this.core.resetSession(sessionId)
    return result.reset
  }

  sessionId(extensionId: string, contextKey: string): string {
    return createHash('sha256')
      .update(`${extensionId}\0${contextKey}`)
      .digest('hex')
      .slice(0, 32)
  }

  private noteRead(sessionId: string): void {
    const now = Date.now()
    const usage = this.sessions.get(sessionId) ?? { inFlight: false, reads: [] }
    usage.reads = usage.reads.filter((at) => now - at < MINUTE_WINDOW_MS)
    const inTenSeconds = usage.reads.filter((at) => now - at < READ_WINDOW_MS).length
    if (inTenSeconds >= READ_WINDOW_LIMIT || usage.reads.length >= MINUTE_LIMIT) {
      this.sessions.set(sessionId, usage)
      throw new Error('Computer Use reads are happening too quickly; wait a moment and try again')
    }
    usage.reads.push(now)
    this.sessions.set(sessionId, usage)
  }
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  const text = value.trim()
  if (text.length > max) throw new Error(`${label} must be under ${max} characters`)
  return text
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  const text = value.trim()
  if (text.length > max) throw new Error(`${label} must be under ${max} characters`)
  return text
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error('Computer Use options must be booleans')
  return value
}

function fitBridge(state: CoreComputerAppState): CoreComputerAppState {
  let result = state
  if (result.screenshots.length > 0 && JSON.stringify(result).length > BRIDGE_MAX_CHARS) {
    result = { ...result, screenshots: [], screenshotUnavailable: 'bridge-budget' }
  }
  if (result.accessibility && JSON.stringify(result).length > BRIDGE_MAX_CHARS) {
    const overflow = JSON.stringify(result).length - BRIDGE_MAX_CHARS
    const tree = result.accessibility.tree.slice(0, Math.max(0, result.accessibility.tree.length - overflow - 64))
    result = {
      ...result,
      accessibility: { ...result.accessibility, tree },
      stats: { ...result.stats, truncated: true },
    }
  }
  if (JSON.stringify(result).length > BRIDGE_MAX_CHARS) {
    throw new Error('This window state is too large to display; choose a smaller window')
  }
  return result
}
