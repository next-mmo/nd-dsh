import type { WebBrowserModeSettings, WebBrowserTransport } from '../../shared/browser-modes.js'

/** Where a web-chat turn was when it stopped. */
export type WebTurnPhase = 'open' | 'observe' | 'attach' | 'compose' | 'submit' | 'confirm' | 'wait' | 'read'

/**
 * Whether the provider may have received the prompt. `none` is the only state
 * in which retrying (or switching transport) cannot duplicate the message.
 */
export type WebSubmissionState = 'none' | 'uncertain' | 'confirmed'

export type WebTurnErrorCode =
  | 'cancelled'
  | 'login-required'
  | 'challenge'
  | 'rate-limited'
  | 'page-busy'
  | 'wrong-page'
  | 'transport-unavailable'
  | 'transport-error'
  | 'layout-changed'
  | 'attachment-unavailable'
  | 'attachment-rejected'
  | 'not-submitted'
  | 'submission-uncertain'
  | 'timeout'
  | 'empty-reply'

/** Conditions owned by the user or provider; no transport may work around them. */
const STOP_CONDITIONS = new Set<WebTurnErrorCode>(['cancelled', 'login-required', 'challenge', 'rate-limited', 'page-busy', 'wrong-page'])

/** Failures that are specific to how ND drove the page, not to the provider. */
const TRANSPORT_FAILURES = new Set<WebTurnErrorCode>([
  'transport-unavailable',
  'transport-error',
  'layout-changed',
  'attachment-unavailable',
  'not-submitted',
])

export class WebTurnError extends Error {
  readonly code: WebTurnErrorCode
  readonly phase: WebTurnPhase
  readonly submission: WebSubmissionState
  readonly transport: WebBrowserTransport | undefined

  constructor(input: {
    code: WebTurnErrorCode
    message: string
    phase: WebTurnPhase
    submission?: WebSubmissionState
    transport?: WebBrowserTransport
    cause?: unknown
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = 'WebTurnError'
    this.code = input.code
    this.phase = input.phase
    this.submission = input.submission ?? 'none'
    this.transport = input.transport
  }

  get isStopCondition(): boolean {
    return STOP_CONDITIONS.has(this.code)
  }
}

/**
 * Mutable per-attempt record of how far a turn got. Errors are classified
 * against it so an unexpected exception after the Send click is never treated
 * as "nothing was sent".
 */
export class WebTurnProgress {
  phase: WebTurnPhase = 'open'
  submission: WebSubmissionState = 'none'

  constructor(readonly transport: WebBrowserTransport) {}

  enter(phase: WebTurnPhase): void {
    this.phase = phase
  }

  fail(code: WebTurnErrorCode, message: string, cause?: unknown): WebTurnError {
    return new WebTurnError({
      code,
      message,
      phase: this.phase,
      submission: this.submission,
      transport: this.transport,
      ...(cause === undefined ? {} : { cause }),
    })
  }

  /** Attach phase/submission context to any error thrown by an attempt. */
  classify(error: unknown): WebTurnError {
    if (error instanceof WebTurnError) {
      // A lower layer may not know the submit already happened; never let it
      // downgrade the attempt's submission state.
      if (rank(error.submission) >= rank(this.submission) && error.transport) return error
      return new WebTurnError({
        code: error.code,
        message: error.message,
        phase: error.phase,
        submission: rank(error.submission) >= rank(this.submission) ? error.submission : this.submission,
        transport: error.transport ?? this.transport,
        cause: error,
      })
    }
    const message = error instanceof Error ? error.message : String(error)
    if (this.submission !== 'none') {
      return this.fail('submission-uncertain', uncertainMessage(message), error)
    }
    return this.fail('transport-error', message, error)
  }
}

function rank(state: WebSubmissionState): number {
  return state === 'none' ? 0 : state === 'uncertain' ? 1 : 2
}

function uncertainMessage(detail: string): string {
  return `${detail} The message may already have been sent — check ND's Browser pane before resending; ND will not resend it automatically.`
}

/** Auto may only switch transport when nothing could have been sent. */
export function canSwitchTransport(error: unknown): boolean {
  return error instanceof WebTurnError
    && error.submission === 'none'
    && !error.isStopCondition
    && TRANSPORT_FAILURES.has(error.code)
}

export interface WebTransportAvailability {
  extension: boolean
  cdp: boolean
  browserAgent: boolean
}

export interface WebTransportPlanInput {
  settings: WebBrowserModeSettings
  hasImages: boolean
  available: WebTransportAvailability
}

export interface WebTransportPlan {
  transports: WebBrowserTransport[]
  skipped: Array<{ transport: WebBrowserTransport; reason: string }>
}

const AVAILABILITY_KEY: Record<WebBrowserTransport, keyof WebTransportAvailability> = {
  extension: 'extension',
  cdp: 'cdp',
  'browser-agent': 'browserAgent',
}

/**
 * Ordered transports for one turn. An explicit mode is exactly one transport
 * (no silent fallback); Auto prefers Extension, then CDP, then — only when the
 * user opted in — Browser Agent. Image turns lead with CDP because its upload
 * path (`DOM.setFileInputFiles`) is the one validated against Gemini.
 */
export function planWebTransports(input: WebTransportPlanInput): WebTransportPlan {
  const skipped: WebTransportPlan['skipped'] = []
  const usable = (transport: WebBrowserTransport): boolean => {
    if (input.available[AVAILABILITY_KEY[transport]]) return true
    skipped.push({ transport, reason: 'unavailable' })
    return false
  }
  const { mode, agentFallback } = input.settings
  if (mode !== 'auto') return { transports: usable(mode) ? [mode] : [], skipped }

  const order: WebBrowserTransport[] = input.hasImages ? ['cdp', 'extension'] : ['extension', 'cdp']
  if (agentFallback) order.push('browser-agent')
  else skipped.push({ transport: 'browser-agent', reason: 'agent fallback disabled' })
  return { transports: order.filter(usable), skipped }
}
