import { PageGuardError } from './page-driver.js'

/** Semantic element as reported by BrowserController's built-in driver or Companion. */
export interface SemanticElement {
  ref: string
  tag?: string | undefined
  role?: string | undefined
  name?: string | undefined
  text?: string | undefined
  type?: string | undefined
  disabled?: boolean | undefined
  href?: string | undefined
  sensitive?: boolean | undefined
  editable?: boolean | undefined
}

export interface SemanticSnapshot {
  revision: number
  url: string
  title?: string | undefined
  viewport?: { width: number; height: number; scrollX: number; scrollY: number } | undefined
  elements: SemanticElement[]
}

/** Narrow port satisfied by BrowserController (and BrowserTarget adapters). */
export interface BrowserAgentPort {
  semanticSnapshot(tabId?: string): Promise<unknown>
  click(tabId: string, ref: string, revision: number): Promise<unknown>
  fill(tabId: string, ref: string, revision: number, text: string): Promise<unknown>
  press(tabId: string, ref: string, revision: number, key: string): Promise<unknown>
  scroll(tabId: string, deltaX: number, deltaY: number): Promise<unknown>
  screenshot?(tabId?: string): Promise<{ dataUrl: string }>
}

export type BrowserAgentAction =
  | { kind: 'click'; ref: string; reason?: string | undefined }
  | { kind: 'fill'; ref: string; text: string; reason?: string | undefined }
  | { kind: 'press'; ref: string; key: string; reason?: string | undefined }
  | { kind: 'scroll'; deltaX: number; deltaY: number; reason?: string | undefined }
  | { kind: 'wait'; ms?: number | undefined; reason?: string | undefined }

export interface BrowserAgentObservation {
  snapshot: SemanticSnapshot
  screenshotDataUrl?: string | undefined
}

export interface BrowserAgentStepSpec {
  /** Human-readable step name for diagnostics and receipts. */
  name: string
  /** Select the next action from the current semantic observation, or `null` when nothing matches yet. */
  plan(observation: BrowserAgentObservation, attempt: number): Promise<BrowserAgentAction | null> | BrowserAgentAction | null
  /**
   * Confirm that the action achieved its goal on the post-action snapshot.
   * When omitted, any non-throwing action counts as verified.
   */
  verify?(after: SemanticSnapshot, before: SemanticSnapshot, action: BrowserAgentAction): Promise<boolean> | boolean
  /** Maximum Observe → Act → Verify cycles for this step (default: 6). */
  maxAttempts?: number | undefined
  /** Delay between attempts in ms (default: 200). */
  pollMs?: number | undefined
  /** If true, scrolling down slightly is tried once before giving up when `plan` finds no target. */
  scrollRecovery?: boolean | undefined
}

export interface BrowserAgentStepReceipt {
  step: string
  attempts: number
  action: BrowserAgentAction
  revisionBefore: number
  revisionAfter: number
  url: string
  recoveryScreenshot?: string | undefined
}

export interface BrowserAgentRunnerOptions {
  port: BrowserAgentPort
  tabId: string
  allowedOrigins?: readonly string[] | undefined
  signal?: AbortSignal | undefined
  /** Capture a screenshot when a step has to recover from a failed attempt. */
  visualRecovery?: boolean | undefined
  log?: ((line: string) => void) | undefined
}

/**
 * Structured Observe → Act → Verify runner over ND's existing semantic browser
 * driver. It operates on the already-open tab in ND's visible Browser pane,
 * re-observes automatically on `STALE_BROWSER_REFERENCE`, enforces origin
 * bounds before every action, and optionally captures a screenshot when
 * visual recovery is needed.
 */
export class BrowserAgentRunner {
  private readonly allowedOrigins: readonly string[]
  private readonly visualRecovery: boolean

  constructor(private readonly options: BrowserAgentRunnerOptions) {
    this.allowedOrigins = options.allowedOrigins ?? []
    this.visualRecovery = options.visualRecovery ?? true
  }

  /** Observe the current semantic DOM tree and verify its origin. */
  async observe(includeScreenshot = false): Promise<BrowserAgentObservation> {
    this.assertActive()
    const raw = await this.options.port.semanticSnapshot(this.options.tabId)
    this.assertActive()
    const snapshot = parseSemanticSnapshot(raw)
    this.assertAllowedOrigin(snapshot.url)
    let screenshotDataUrl: string | undefined
    if (includeScreenshot && this.visualRecovery && this.options.port.screenshot) {
      try {
        screenshotDataUrl = (await this.options.port.screenshot(this.options.tabId)).dataUrl
      } catch {
        // Screenshot capture is diagnostic/recovery aid only; never fail observation on it.
      }
    }
    return {
      snapshot,
      ...(screenshotDataUrl === undefined ? {} : { screenshotDataUrl }),
    }
  }

  /** Execute one goal step through a bounded Observe → Act → Verify loop. */
  async runStep(spec: BrowserAgentStepSpec): Promise<BrowserAgentStepReceipt> {
    const maxAttempts = Math.max(1, Math.min(20, spec.maxAttempts ?? 6))
    const pollMs = Math.max(25, Math.min(5_000, spec.pollMs ?? 200))
    let recoveryScreenshot: string | undefined
    let triedScrollRecovery = false
    let lastError: unknown

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.assertActive()
      const needVisual = attempt > 1 && this.visualRecovery && recoveryScreenshot === undefined
      const observation = await this.observe(needVisual)
      if (observation.screenshotDataUrl) recoveryScreenshot = observation.screenshotDataUrl

      const before = observation.snapshot
      const planned = await spec.plan(observation, attempt)
      if (!planned) {
        if (spec.scrollRecovery && !triedScrollRecovery && attempt >= 2) {
          triedScrollRecovery = true
          try {
            await this.options.port.scroll(this.options.tabId, 0, 260)
          } catch {
            // Scroll recovery is best-effort.
          }
        }
        if (attempt < maxAttempts) await abortableSleep(pollMs, this.options.signal)
        continue
      }

      if (planned.kind === 'wait') {
        await abortableSleep(planned.ms ?? pollMs, this.options.signal)
        continue
      }

      try {
        await this.act(planned, before.revision)
      } catch (error) {
        lastError = error
        if (isStaleReferenceError(error) && attempt < maxAttempts) {
          this.options.log?.(`[browser-agent] step "${spec.name}" re-observing after stale reference (attempt ${attempt})`)
          await abortableSleep(Math.min(100, pollMs), this.options.signal)
          continue
        }
        throw error
      }

      this.assertActive()
      const after = (await this.observe(false)).snapshot
      const verified = spec.verify ? await spec.verify(after, before, planned) : true
      if (verified) {
        return {
          step: spec.name,
          attempts: attempt,
          action: planned,
          revisionBefore: before.revision,
          revisionAfter: after.revision,
          url: after.url,
          ...(recoveryScreenshot === undefined ? {} : { recoveryScreenshot }),
        }
      }
      this.options.log?.(`[browser-agent] step "${spec.name}" verification did not pass on attempt ${attempt}`)
      if (attempt < maxAttempts) await abortableSleep(pollMs, this.options.signal)
    }

    if (this.visualRecovery && recoveryScreenshot === undefined && this.options.port.screenshot) {
      try {
        recoveryScreenshot = (await this.options.port.screenshot(this.options.tabId)).dataUrl
      } catch { /* ignore */ }
    }
    const suffix = lastError instanceof Error ? `: ${lastError.message}` : ''
    const failure = new Error(`Browser Agent could not complete step "${spec.name}" after ${maxAttempts} attempts${suffix}`)
    if (recoveryScreenshot !== undefined) {
      ;(failure as Error & { recoveryScreenshot?: string }).recoveryScreenshot = recoveryScreenshot
    }
    throw failure
  }

  private async act(action: BrowserAgentAction, revision: number): Promise<void> {
    const { port, tabId } = this.options
    switch (action.kind) {
      case 'click':
        await port.click(tabId, action.ref, revision)
        return
      case 'fill':
        await port.fill(tabId, action.ref, revision, action.text)
        return
      case 'press':
        await port.press(tabId, action.ref, revision, action.key)
        return
      case 'scroll':
        await port.scroll(tabId, action.deltaX, action.deltaY)
        return
      case 'wait':
        return
    }
  }

  private assertAllowedOrigin(url: string): void {
    if (this.allowedOrigins.length === 0) return
    let origin = ''
    try { origin = new URL(url).origin } catch { origin = '' }
    if (!this.allowedOrigins.includes(origin)) {
      throw new PageGuardError('wrong-page', origin, `ND's Browser pane left the expected site (now on ${origin || url || 'another page'}).`)
    }
  }

  private assertActive(): void {
    if (this.options.signal?.aborted) throw new Error('Gemini Web turn was stopped.')
  }
}

export function parseSemanticSnapshot(value: unknown): SemanticSnapshot {
  if (!value || typeof value !== 'object') {
    throw new Error('Browser semantic snapshot returned no data')
  }
  const candidate = value as Partial<SemanticSnapshot>
  if (!Number.isInteger(candidate.revision) || typeof candidate.url !== 'string' || !Array.isArray(candidate.elements)) {
    throw new Error('Browser semantic snapshot has an invalid shape')
  }
  return candidate as SemanticSnapshot
}

export function isStaleReferenceError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as Error & { code?: unknown }).code
  return code === 'STALE_BROWSER_REFERENCE' || /stale|page changed after the snapshot/i.test(error.message)
}

/**
 * Semantic heuristic for the prompt composer on a chat page (Gemini / ChatGPT):
 * never picks password, file, or search inputs; prefers a contenteditable or
 * textarea with a prompt-like accessible label.
 */
export function findComposerElement(snapshot: SemanticSnapshot): SemanticElement | undefined {
  const candidates = snapshot.elements.filter((el) => {
    if (el.disabled || el.sensitive) return false
    if (el.tag === 'input') return false
    if (el.editable === true || el.tag === 'textarea') return true
    return el.role === 'textbox' && el.tag !== 'button'
  })
  if (candidates.length === 0) return undefined
  const scored = candidates.map((el) => {
    const label = `${el.name ?? ''} ${el.text ?? ''}`.toLowerCase()
    let score = 0
    if (el.editable === true) score += 4
    if (el.tag === 'textarea') score += 3
    if (el.role === 'textbox') score += 2
    if (/ask gemini|enter a prompt|prompt|message|ask anything|type a message/.test(label)) score += 5
    if (/search|filter|find|rename|title/.test(label)) score -= 6
    return { el, score }
  }).sort((a, b) => b.score - a.score)
  return scored[0]?.el
}

/** Semantic heuristic for the Send button on a chat composer. */
export function findSendButtonElement(snapshot: SemanticSnapshot): SemanticElement | undefined {
  return snapshot.elements.find((el) => {
    if (el.disabled) return false
    if (el.role !== 'button' && el.tag !== 'button') return false
    const label = (el.name || el.text || '').trim()
    if (!label || /cancel\s+send|stop|attach|upload|voice|microphone/i.test(label)) return false
    return /^(send(?:\s+message|\s+prompt)?|submit)(?:\b|$)/i.test(label)
  })
}

/** Semantic heuristic for stale attachment remove buttons on a composer. */
export function findCloseAttachmentElements(snapshot: SemanticSnapshot): SemanticElement[] {
  return snapshot.elements.filter((el) => {
    if (el.disabled) return false
    if (el.role !== 'button' && el.tag !== 'button') return false
    const label = (el.name || el.text || '').trim()
    return /^(close|remove)\s+attachment$/i.test(label)
  })
}

/** Semantic heuristic for a "New chat" control when the composer is not yet visible. */
export function findNewChatElement(snapshot: SemanticSnapshot): SemanticElement | undefined {
  return snapshot.elements.find((el) => {
    if (el.disabled) return false
    if (el.role !== 'button' && el.role !== 'link' && el.tag !== 'button' && el.tag !== 'a') return false
    const label = (el.name || el.text || '').trim()
    return /^(new chat|start a new chat|new conversation)(?:\b|$)/i.test(label)
  })
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Gemini Web turn was stopped.'))
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('Gemini Web turn was stopped.'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
