import type { DshEventFrame, GatewayRpcResult } from '../../shared/contracts.js'
import type { FollowHandle, SessionStreamFrame } from '../dsh/gateway-client.js'
import {
  MemorySessionJournalStore,
  type SessionJournalEnvelope,
  type SessionJournalStore,
} from './session-journal-store.js'

/**
 * The minimal remote-capable surface the hub needs from GatewayClient
 * (structural, so tests can stub the transport).
 */
export interface FollowSource {
  /** Whether the runtime serves the SRC remote face (slash endpoints + stream mux). */
  readonly remote: boolean
  followSession(sessionId: string, onFrame: (frame: SessionStreamFrame) => void): FollowHandle
}

/** How long a fresh follow may wait for its opening snapshot. */
const SNAPSHOT_TIMEOUT_MS = 15_000

/**
 * Per-session live event bridge backed by the runtime's `session/follow`
 * streams. The large retained journal is delegated to SessionJournalStore:
 * production uses nd-core, while tests/degraded callers can use the bounded
 * in-memory fallback.
 *
 * The hub itself retains only stream handles, sequence baselines, and promises
 * for writes currently crossing the storage boundary. Live events are still
 * emitted immediately in the legacy DshEventFrame vocabulary.
 */
export class SessionEventHub {
  private source: FollowSource | undefined
  private readonly handles = new Map<string, FollowHandle>()
  private readonly baselines = new Map<string, number>()
  private readonly pendingWrites = new Map<string, Set<Promise<void>>>()
  private resetPromise: Promise<void> = Promise.resolve()

  constructor(
    private readonly emit: (frame: DshEventFrame) => void,
    private readonly store: SessionJournalStore = new MemorySessionJournalStore(),
  ) {}

  /** Whether the hub can serve reads (attached to a remote-face runtime). */
  get active(): boolean {
    return this.source?.remote === true
  }

  /** Bind to a gateway; any previous binding's streams are torn down. */
  attach(source: FollowSource): void {
    this.detach()
    this.source = source
  }

  /** Close every follow stream and reset the delegated journals. */
  detach(): void {
    for (const handle of this.handles.values()) handle.close()
    this.handles.clear()
    this.baselines.clear()
    this.pendingWrites.clear()
    this.source = undefined
    this.resetPromise = this.store.clear().catch(() => undefined)
  }

  /** Close one session's follow stream to free runtime resources when idle. */
  closeSession(sessionId: string): void {
    const handle = this.handles.get(sessionId)
    if (handle) {
      handle.close()
      this.handles.delete(sessionId)
    }
  }

  /**
   * Rebuild volatile native retention after nd-core restarts while the Harness
   * runtime is still alive. Reopening each interesting follow asks the runtime
   * for a fresh snapshot, so core failure never becomes permanent chat-history
   * loss in the desktop.
   */
  async rehydrate(): Promise<void> {
    if (!this.active) return
    const sessionIds = [...this.handles.keys()]
    for (const handle of this.handles.values()) handle.close()
    this.handles.clear()
    this.baselines.clear()
    this.pendingWrites.clear()
    this.resetPromise = this.store.clear().catch(() => undefined)
    await this.resetPromise
    await Promise.all(sessionIds.map(async (sessionId) => {
      await this.open(sessionId).catch(() => undefined)
    }))
  }

  /**
   * Adopt a session's live journal before its next prompt, so the turn's
   * events arrive as live appends instead of being swallowed by a later
   * snapshot's silent baseline adoption. Resolves once the opening snapshot
   * and its journal write have landed.
   */
  async ensure(sessionId: string): Promise<void> {
    if (!this.active || this.handles.has(sessionId)) {
      await this.flush(sessionId)
      return
    }
    await this.open(sessionId)
  }

  /**
   * Serve one history read from the delegated journal, in the legacy
   * `session.history` value shape.
   */
  async read(sessionId: string, maxMessages = 50): Promise<GatewayRpcResult> {
    await this.open(sessionId)
    await this.flush(sessionId)
    const envelopes = await this.store.tail(sessionId, maxMessages)
    return {
      ok: true,
      value: { events: envelopes.map((event) => ({ event })) },
    }
  }

  /** Open (or join) the session's follow stream and wait for its snapshot. */
  private async open(sessionId: string): Promise<void> {
    await this.resetPromise
    const existing = this.handles.get(sessionId)
    if (existing) {
      await existing.ready
      await this.flush(sessionId)
      return
    }
    const source = this.source
    if (!source) throw new Error('Session event hub is not attached to a runtime')
    const handle = source.followSession(sessionId, (frame) => this.ingest(sessionId, frame))
    this.handles.set(sessionId, handle)
    try {
      await withTimeout(handle.ready, SNAPSHOT_TIMEOUT_MS, 'Session event stream did not open in time')
      await this.flush(sessionId)
    } catch (cause) {
      // A failed stream keeps no handle: a later read retries cleanly.
      if (this.handles.get(sessionId) === handle) this.handles.delete(sessionId)
      handle.close()
      throw cause
    }
  }

  private ingest(sessionId: string, frame: SessionStreamFrame): void {
    if (frame.type === 'error' || frame.type === 'end') {
      // The stream is terminal (session removed, runtime shut down): drop the
      // handle but keep the journal so already-loaded threads still read.
      const handle = this.handles.get(sessionId)
      if (handle) {
        handle.close()
        this.handles.delete(sessionId)
      }
      return
    }

    let baseline = this.baselines.get(sessionId) ?? 0
    // Snapshot records wrap their event ({ type: 'event'|'chunks', event });
    // live frames carry the envelope directly.
    const events = frame.type === 'snapshot'
      ? (frame.records ?? []).map(asEnvelope)
      : [frame.event]
    const accepted: SessionJournalEnvelope[] = []

    for (const event of events) {
      if (!event || event.seq <= baseline) continue
      baseline = event.seq
      accepted.push({
        type: event.type,
        seq: event.seq,
        ...(event.time === undefined ? {} : { time: event.time }),
        ...(event.data === undefined ? {} : { data: event.data }),
        ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
      })
      if (frame.type === 'event') {
        this.emit({
          kind: 'session-event',
          sessionId,
          event: {
            type: event.type,
            seq: event.seq,
            time: event.time ?? Date.now(),
            ...(event.data === undefined ? {} : { data: event.data }),
            ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
          },
        })
      }
    }

    if (frame.type === 'snapshot' && typeof frame.cursor === 'number') baseline = Math.max(baseline, frame.cursor)
    this.baselines.set(sessionId, baseline)
    if (accepted.length > 0) this.trackWrite(sessionId, this.store.append(sessionId, accepted))
  }

  private trackWrite(sessionId: string, write: Promise<void>): void {
    let writes = this.pendingWrites.get(sessionId)
    if (!writes) {
      writes = new Set()
      this.pendingWrites.set(sessionId, writes)
    }
    writes.add(write)
    void write.finally(() => {
      writes?.delete(write)
      if (writes?.size === 0) this.pendingWrites.delete(sessionId)
    }).catch(() => undefined)
  }

  private async flush(sessionId: string): Promise<void> {
    const writes = this.pendingWrites.get(sessionId)
    if (!writes?.size) return
    await Promise.all([...writes])
  }
}

function asEnvelope(value: unknown): SessionJournalEnvelope | undefined {
  if (!value || typeof value !== 'object') return undefined
  const event = (value as { event?: unknown }).event
  if (!event || typeof event !== 'object') return undefined
  const envelope = event as Record<string, unknown>
  if (typeof envelope.type !== 'string' || typeof envelope.seq !== 'number') return undefined
  return {
    type: envelope.type,
    seq: envelope.seq,
    ...(typeof envelope.time === 'number' ? { time: envelope.time } : {}),
    ...(envelope.data === undefined ? {} : { data: envelope.data }),
    ...(envelope.surfaceOp === undefined ? {} : { surfaceOp: envelope.surfaceOp }),
  }
}

function withTimeout(promise: Promise<void>, timeoutMs: number, message: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (cause: unknown) => {
        clearTimeout(timer)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      },
    )
  })
}
