import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import type { UsageSessionUsage, UsageTokenTotals } from '../../shared/usage.js'
import { addUsageTotals, emptyUsageTotals } from '../../shared/usage.js'

/**
 * ND's durable token accounting, written from the runtime's own event stream.
 *
 * The pinned runtime already logs one `assistant/message` event per model call
 * with that call's usage (a session-projection read only ever shows a running
 * total), so this ledger folds those events into per-session totals and
 * appends one line each. Nothing else in ND persists usage: the context popover
 * reads live projections and the organization budget tracks turns only, which
 * is why cross-session cost questions — which project, which task, which
 * project-wide share was a cache hit — had no answer before.
 *
 * The log is append-only JSONL. Crossing the size cap compacts it into one
 * rollup line per session, which preserves every total and the replay guard
 * while dropping per-call detail; that detail exists only for future per-call
 * reads and is not part of today's contract.
 */
const MAX_LOG_BYTES = 16 * 1024 * 1024
/** Sessions kept in memory; the least recently active are dropped first. */
const MAX_SESSIONS = 20_000

export interface UsageLedgerOptions {
  /** Compaction threshold; overridable so tests can reach it without 16 MiB. */
  maxLogBytes?: number
}

/** The event envelope fields the ledger reads; unknown shapes are ignored. */
export interface LedgerEvent {
  type?: unknown
  seq?: unknown
  time?: unknown
  data?: unknown
}

/** One model call's accounting, exactly as the runtime logged it. */
export interface UsageStepLine {
  v: 1
  kind: 'step'
  sessionId: string
  seq: number
  time: number
  turn?: number
  step?: number
  /** Route that served the call; a fallback route shows up here. */
  provider?: string
  model?: string
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** Compaction survivor: one session's whole accounting, without per-call rows. */
interface UsageModelLevel {
  provider?: string
  model?: string
  totals: UsageTokenTotals
}

interface UsageSessionLine {
  v: 1
  kind: 'session'
  sessionId: string
  highSeq: number
  firstAt: number
  lastAt: number
  totals: UsageTokenTotals
  models: UsageModelLevel[]
}

type LedgerLine = UsageStepLine | UsageSessionLine

/** One session's folded accounting plus the replay guard. */
interface SessionState {
  totals: UsageTokenTotals
  firstAt: number
  lastAt: number
  highSeq: number
  models: Map<string, UsageModelLevel>
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Read one `assistant/message` event as a usage row.
 *
 * Returns undefined for every other event type and for a call whose adapter
 * reported no accounting at all, so an unaccounted call never enters the
 * ledger as a zero-token step.
 */
export function usageStepLine(sessionId: string, event: LedgerEvent): UsageStepLine | undefined {
  if (!sessionId || event.type !== 'assistant/message') return undefined
  const seq = integer(event.seq)
  const data = record(event.data)
  const usage = record(data?.usage)
  if (seq === undefined || data === undefined || usage === undefined) return undefined
  const uncached = integer(usage.inputTokens)
  const output = integer(usage.outputTokens)
  if (uncached === undefined || output === undefined) return undefined
  // A tool-call turn is one call; the route rides on the committed message.
  const source = record(record(data.message)?.source)
  const provider = text(source?.provider)
  const model = text(source?.model)
  const turn = integer(data.turn)
  const step = integer(data.step)
  return {
    v: 1,
    kind: 'step',
    sessionId,
    seq,
    time: integer(event.time) ?? Date.now(),
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    uncachedInputTokens: uncached,
    cacheReadTokens: integer(usage.cacheReadTokens) ?? 0,
    cacheWriteTokens: integer(usage.cacheWriteTokens) ?? 0,
    outputTokens: output,
  }
}

function parseTotals(value: unknown): UsageTokenTotals | undefined {
  const source = record(value)
  if (source === undefined) return undefined
  const steps = integer(source.steps)
  const uncachedInputTokens = integer(source.uncachedInputTokens)
  const cacheReadTokens = integer(source.cacheReadTokens)
  const cacheWriteTokens = integer(source.cacheWriteTokens)
  const outputTokens = integer(source.outputTokens)
  if (steps === undefined || uncachedInputTokens === undefined || cacheReadTokens === undefined
    || cacheWriteTokens === undefined || outputTokens === undefined) return undefined
  return { steps, uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }
}

/** Parse one persisted line; a line this build cannot read is skipped, not fatal. */
export function parseLedgerLine(raw: string): LedgerLine | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const line = record(parsed)
  if (line?.v !== 1) return undefined
  const sessionId = text(line.sessionId)
  if (sessionId === undefined) return undefined
  if (line.kind === 'session') {
    const totals = parseTotals(line.totals)
    const highSeq = integer(line.highSeq)
    const firstAt = integer(line.firstAt)
    const lastAt = integer(line.lastAt)
    if (totals === undefined || highSeq === undefined || firstAt === undefined || lastAt === undefined) return undefined
    const models: UsageModelLevel[] = []
    if (Array.isArray(line.models)) {
      for (const entry of line.models) {
        const row = record(entry)
        const rowTotals = parseTotals(row?.totals)
        if (rowTotals === undefined) continue
        const provider = text(row?.provider)
        const model = text(row?.model)
        models.push({ ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }), totals: rowTotals })
      }
    }
    return { v: 1, kind: 'session', sessionId, highSeq, firstAt, lastAt, totals, models }
  }
  if (line.kind !== 'step') return undefined
  const seq = integer(line.seq)
  const time = integer(line.time)
  const uncachedInputTokens = integer(line.uncachedInputTokens)
  const cacheReadTokens = integer(line.cacheReadTokens)
  const cacheWriteTokens = integer(line.cacheWriteTokens)
  const outputTokens = integer(line.outputTokens)
  if (seq === undefined || time === undefined || uncachedInputTokens === undefined || cacheReadTokens === undefined
    || cacheWriteTokens === undefined || outputTokens === undefined) return undefined
  const provider = text(line.provider)
  const model = text(line.model)
  const turn = integer(line.turn)
  const step = integer(line.step)
  return {
    v: 1,
    kind: 'step',
    sessionId,
    seq,
    time,
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
  }
}

function routeKey(provider: string | undefined, model: string | undefined): string {
  return `${provider ?? ''}\u0000${model ?? ''}`
}

/**
 * Fold one model call into a session's totals.
 *
 * Cache reads and writes stay separate buckets because they bill differently
 * and the hit rate is derived from them, never from a summed prompt count.
 */
export class UsageLedger {
  private loaded = false
  private loadPromise: Promise<void> | undefined
  private readonly states = new Map<string, SessionState>()
  private pending: UsageStepLine[] = []
  private logBytes = 0
  private writeChain: Promise<void> = Promise.resolve()
  private compacting: Promise<void> | undefined
  /** Set when the existing log could not be read; blocks rewriting it. */
  private loadFailed = false
  private warnedCompactionBlocked = false

  private readonly maxLogBytes: number

  constructor(private readonly filePath: string, options: UsageLedgerOptions = {}) {
    this.maxLogBytes = options.maxLogBytes ?? MAX_LOG_BYTES
  }

  /**
   * Record one runtime event. Synchronous by design: the caller is the session
   * event path and must not await a disk write.
   *
   * Replay-safe. The runtime re-sends a session's history whenever a stream
   * reopens, so a call already folded at or below this session's high-water
   * sequence is dropped instead of counted twice.
   */
  recordEvent(sessionId: string, event: LedgerEvent): void {
    const line = usageStepLine(sessionId, event)
    if (line === undefined) return
    if (!this.loaded) {
      // Persisted totals must be in memory before a live step folds into them.
      this.pending.push(line)
      void this.load().then(() => this.drainPending(), () => this.drainPending())
      return
    }
    this.accept(line)
  }

  /** Wait for the load and every queued append; used by reads, tests, and shutdown. */
  async flush(): Promise<void> {
    await this.load().catch(() => undefined)
    this.drainPending()
    await this.writeChain.catch(() => undefined)
    if (this.compacting) await this.compacting.catch(() => undefined)
  }

  /** Every session's folded accounting, newest activity first. */
  async perSession(): Promise<UsageSessionUsage[]> {
    await this.flush()
    return [...this.states.entries()]
      .map(([sessionId, state]) => ({
        sessionId,
        totals: { ...state.totals },
        firstAt: state.firstAt,
        lastAt: state.lastAt,
        models: [...state.models.values()].map((level) => ({
          ...(level.provider === undefined ? {} : { provider: level.provider }),
          ...(level.model === undefined ? {} : { model: level.model }),
          totals: { ...level.totals },
        })),
      }))
      .sort((left, right) => right.lastAt - left.lastAt)
  }

  private accept(line: UsageStepLine): void {
    if (!this.foldLine(line)) return
    this.enqueue(`${JSON.stringify(line)}\n`)
  }

  /** Fold one line into memory; false means a replay at or below the high-water mark. */
  private foldLine(line: LedgerLine): boolean {
    if (line.kind === 'session') {
      this.replaceSession(line)
      return true
    }
    const existing = this.states.get(line.sessionId)
    if (existing !== undefined && line.seq <= existing.highSeq) return false
    this.fold(line)
    return true
  }

  private drainPending(): void {
    if (this.pending.length === 0) return
    const queued = this.pending
    this.pending = []
    for (const line of queued) this.accept(line)
  }

  private fold(line: UsageStepLine): void {
    const step: UsageTokenTotals = {
      steps: 1,
      uncachedInputTokens: line.uncachedInputTokens,
      cacheReadTokens: line.cacheReadTokens,
      cacheWriteTokens: line.cacheWriteTokens,
      outputTokens: line.outputTokens,
    }
    const existing = this.states.get(line.sessionId)
    if (existing === undefined) {
      const models = new Map<string, UsageModelLevel>()
      models.set(routeKey(line.provider, line.model), {
        ...(line.provider === undefined ? {} : { provider: line.provider }),
        ...(line.model === undefined ? {} : { model: line.model }),
        totals: step,
      })
      this.states.set(line.sessionId, { totals: step, firstAt: line.time, lastAt: line.time, highSeq: line.seq, models })
      this.prune()
      return
    }
    existing.totals = addUsageTotals(existing.totals, step)
    existing.firstAt = Math.min(existing.firstAt, line.time)
    existing.lastAt = Math.max(existing.lastAt, line.time)
    existing.highSeq = Math.max(existing.highSeq, line.seq)
    const key = routeKey(line.provider, line.model)
    const level = existing.models.get(key)
    if (level === undefined) {
      existing.models.set(key, {
        ...(line.provider === undefined ? {} : { provider: line.provider }),
        ...(line.model === undefined ? {} : { model: line.model }),
        totals: step,
      })
    } else {
      level.totals = addUsageTotals(level.totals, step)
    }
  }

  private replaceSession(line: UsageSessionLine): void {
    this.states.set(line.sessionId, {
      totals: line.totals,
      firstAt: line.firstAt,
      lastAt: line.lastAt,
      highSeq: line.highSeq,
      models: new Map(line.models.map((level) => [routeKey(level.provider, level.model), level])),
    })
  }

  private prune(): void {
    while (this.states.size > MAX_SESSIONS) {
      let oldestId: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [sessionId, state] of this.states) {
        if (state.lastAt < oldestAt) {
          oldestAt = state.lastAt
          oldestId = sessionId
        }
      }
      if (oldestId === undefined) return
      this.states.delete(oldestId)
    }
  }

  private enqueue(text: string): void {
    this.logBytes += text.length
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await fs.mkdir(dirname(this.filePath), { recursive: true })
      await fs.appendFile(this.filePath, text, 'utf8')
    })
    if (this.logBytes > this.maxLogBytes) void this.compact()
  }

  /** Rewrite the log as one rollup per session; totals and replay guards survive. */
  private compact(): Promise<void> {
    if (this.compacting) return this.compacting
    if (this.loadFailed) {
      if (!this.warnedCompactionBlocked) {
        this.warnedCompactionBlocked = true
        console.warn(`Usage ledger compaction is blocked until ${this.filePath} can be read again; accounting keeps appending instead of rewriting it.`)
      }
      return Promise.resolve()
    }
    const run = this.writeChain.catch(() => undefined).then(async () => {
      const lines: string[] = []
      for (const [sessionId, state] of this.states) {
        const line: UsageSessionLine = {
          v: 1,
          kind: 'session',
          sessionId,
          highSeq: state.highSeq,
          firstAt: state.firstAt,
          lastAt: state.lastAt,
          totals: state.totals,
          models: [...state.models.values()],
        }
        lines.push(JSON.stringify(line))
      }
      const text = lines.length > 0 ? `${lines.join('\n')}\n` : ''
      const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
      await fs.mkdir(dirname(this.filePath), { recursive: true })
      try {
        await fs.writeFile(temp, text, 'utf8')
        await fs.rename(temp, this.filePath)
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
      this.logBytes = text.length
    })
    this.compacting = run.catch(() => undefined).finally(() => { this.compacting = undefined })
    this.writeChain = this.compacting
    return this.compacting
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = this.loadFromDisk().finally(() => { this.loadPromise = undefined })
    return this.loadPromise
  }

  private async loadFromDisk(): Promise<void> {
    let text: string
    try {
      text = await fs.readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Ignoring unreadable usage ledger; cost accounting restarts from this session:', error)
        // Appending is safe; rewriting from memory would drop every line this
        // read never loaded, so compaction stays blocked until a clean load.
        this.loadFailed = true
      }
      this.loaded = true
      return
    }
    let skipped = 0
    let start = 0
    while (start < text.length) {
      let end = text.indexOf('\n', start)
      if (end === -1) end = text.length
      const raw = text.slice(start, end).trim()
      start = end + 1
      if (!raw) continue
      const line = parseLedgerLine(raw)
      if (line === undefined) {
        skipped += 1
        continue
      }
      // Sequential fold: a compaction checkpoint replaces its session's state,
      // and later step rows for that session add to it.
      this.foldLine(line)
    }
    if (skipped > 0) console.warn(`Usage ledger skipped ${skipped} unreadable line(s) in ${this.filePath}`)
    // Bound memory only after the whole log is folded, so a step row later in
    // the file always lands on its session's full totals rather than a partial.
    this.prune()
    this.logBytes = text.length
    this.loaded = true
    if (this.logBytes > this.maxLogBytes) void this.compact()
  }
}
