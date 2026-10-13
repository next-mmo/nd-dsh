import { decode, encode } from '@msgpack/msgpack'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import process from 'node:process'
import { taskMetricsRecorder } from '../metrics/task-metrics.js'
import { assertNdCoreBinary } from './core-path.js'
import {
  ND_CORE_CLIENT_TIMEOUT_CODE,
  ND_CORE_MAX_FRAME_BYTES,
  ND_CORE_PROTOCOL_VERSION,
  NdCoreError,
  buildCoreRequestFrame,
  type NdCoreEventFrame,
  type NdCoreHealth,
  type NdCoreResponseFrame,
  resolveCoreDeadlineMs,
} from './core-protocol.js'

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  requestBytes: number
}

const DEFAULT_MAX_PENDING_REQUESTS = 1_024
const DEFAULT_MAX_OUTSTANDING_REQUEST_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_QUEUED_REQUEST_BYTES = 32 * 1024 * 1024
const RESERVED_CONTROL_REQUEST_SLOTS = 32
const RESERVED_CONTROL_REQUEST_BYTES = 8 * 1024 * 1024

export const CORE_RESTART_MAX_ATTEMPTS = 1
export const CORE_RESTART_DELAY_MS = 100
export const CORE_RESTART_STABLE_RESET_MS = 30_000

export function coreRestartPolicy(attempts: number): { restart: boolean; delayMs?: number } {
  const normalized = Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : CORE_RESTART_MAX_ATTEMPTS
  return normalized < CORE_RESTART_MAX_ATTEMPTS
    ? { restart: true, delayMs: CORE_RESTART_DELAY_MS }
    : { restart: false }
}

const CONTROL_METHODS = new Set([
  'core.cancel',
  'process.cancel',
  'process.closeStdin',
  'terminal.resize',
  'terminal.close',
  'scheduler.heartbeat',
  'scheduler.release',
])

export interface CoreRequestOptions {
  /**
   * How long nd-core may work on this request. Defaults to the client's own
   * tolerance minus the margin that makes the core stop first, so a caller that
   * waits `timeoutMs` receives a typed deadline error instead of an untagged
   * timeout while the work carries on in Rust.
   */
  deadlineMs?: number
  /**
   * Caller-chosen request id, for work that must be addressable while it runs
   * (a disk scan is canceled through `core.cancel` with this id, and progress
   * events arrive tagged with it). Defaults to a generated id.
   */
  requestId?: string
}

export interface CoreClientOptions {
  binaryPath?: string
  maxPendingRequests?: number
  maxOutstandingRequestBytes?: number
  maxQueuedRequestBytes?: number
  log?(line: string): void
  onUnexpectedExit?(code: number | null, signal: NodeJS.Signals | null): void
}

export class CoreClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly frameHeader = Buffer.allocUnsafe(4)
  private frameHeaderBytes = 0
  private framePayload: Buffer | undefined
  private framePayloadBytes = 0
  private pending = new Map<string, PendingRequest>()
  private outstandingRequestBytes = 0
  private queuedRequestBytes = 0
  private listeners = new Map<string, Set<(frame: NdCoreEventFrame) => void>>()
  private starting: Promise<NdCoreHealth> | undefined
  private healthValue: NdCoreHealth | undefined
  private closing = false
  private restartAttempts = 0
  private restartResetTimer: ReturnType<typeof setTimeout> | undefined
  private unavailableReason: string | undefined
  private generation = 0

  constructor(private readonly options: CoreClientOptions = {}) {}

  get health(): NdCoreHealth | undefined {
    return this.healthValue
  }

  get running(): boolean {
    return Boolean(this.child && !this.child.killed && this.healthValue)
  }

  async start(): Promise<NdCoreHealth> {
    if (this.healthValue && this.child && !this.child.killed) return this.healthValue
    if (this.unavailableReason) throw new Error(this.unavailableReason)
    if (this.starting) return this.starting
    this.starting = this.spawnAndHandshake()
    try {
      return await this.starting
    } finally {
      this.starting = undefined
    }
  }

  async request<T>(
    method: string,
    params: unknown = {},
    timeoutMs = 30_000,
    options: CoreRequestOptions = {},
  ): Promise<T> {
    await this.start()
    return await this.sendRequest<T>(method, params, timeoutMs, options)
  }

  /**
   * Ask nd-core to stop working on an in-flight request. That request fails with
   * the `canceled` code and every other request in flight is left alone.
   */
  async cancel(requestId: string, timeoutMs = 5_000): Promise<boolean> {
    const result = await this.sendRequest<{ canceled: boolean }>(
      'core.cancel',
      { requestId },
      timeoutMs,
      {},
    )
    return result.canceled === true
  }

  onEvent<T = unknown>(event: string, listener: (frame: NdCoreEventFrame<T>) => void): () => void {
    let bucket = this.listeners.get(event)
    if (!bucket) {
      bucket = new Set()
      this.listeners.set(event, bucket)
    }
    const wrapped = listener as (frame: NdCoreEventFrame) => void
    bucket.add(wrapped)
    return () => {
      bucket?.delete(wrapped)
      if (bucket?.size === 0) this.listeners.delete(event)
    }
  }

  async close(): Promise<void> {
    this.closing = true
    if (this.restartResetTimer) clearTimeout(this.restartResetTimer)
    this.restartResetTimer = undefined
    this.healthValue = undefined
    const child = this.child
    this.child = undefined
    this.queuedRequestBytes = 0
    this.resetFrameReader()
    if (!child) return

    child.stdin.end()
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* already exited */ }
        resolve()
      }, 750)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.rejectPending(new Error('ND Core is shutting down.'))
  }

  private async spawnAndHandshake(): Promise<NdCoreHealth> {
    this.closing = false
    const binary = assertNdCoreBinary(this.options.binaryPath)
    const generation = ++this.generation
    this.options.log?.('[nd-core] launch ' + binary)

    const child = spawn(binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        RUST_BACKTRACE: process.env.RUST_BACKTRACE ?? '1',
      },
    })
    this.child = child
    this.resetFrameReader()

    child.stdout.on('data', (chunk: Buffer) => this.handleStdout(generation, chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const line = chunk.trimEnd()
      if (line) this.options.log?.(line)
    })
    child.once('error', (error) => {
      if (generation !== this.generation) return
      this.rejectPending(error)
    })
    child.once('exit', (code, signal) => this.handleExit(generation, code, signal))

    const health = await this.sendRequest<NdCoreHealth>('core.health', {}, 5_000)
    if (health.protocolVersion !== ND_CORE_PROTOCOL_VERSION) {
      try { child.kill() } catch { /* best effort */ }
      throw new Error(
        'ND Core protocol mismatch: desktop=' + ND_CORE_PROTOCOL_VERSION + ', core=' + health.protocolVersion + '.',
      )
    }
    this.healthValue = health
    if (this.restartAttempts > 0) this.armStableRestartReset(generation, child)
    this.options.log?.(
      '[nd-core] ready v' + health.binaryVersion + ' protocol=' + health.protocolVersion + ' ' + health.platform + '/' + health.arch,
    )
    this.emitSyntheticEvent('core.ready', 'high', health)
    return health
  }

  private sendRequest<T>(
    method: string,
    params: unknown,
    timeoutMs: number,
    options: CoreRequestOptions = {},
  ): Promise<T> {
    const child = this.child
    if (!child || child.killed || child.stdin.destroyed) {
      return Promise.reject(new Error('ND Core is not running.'))
    }
    if (!method || method.length > 128) return Promise.reject(new Error('Invalid ND Core method.'))
    const id = options.requestId ?? randomUUID()
    if (options.requestId !== undefined) {
      if (!options.requestId || options.requestId.length > 256 || this.pending.has(options.requestId)) {
        return Promise.reject(new Error('ND Core request id must be unique, non-empty, and at most 256 characters.'))
      }
    }

    const isControl = CONTROL_METHODS.has(method)
    const configuredMaxPending = this.options.maxPendingRequests
    const maxPending = configuredMaxPending !== undefined && Number.isFinite(configuredMaxPending)
      ? Math.max(RESERVED_CONTROL_REQUEST_SLOTS + 1, Math.floor(configuredMaxPending))
      : DEFAULT_MAX_PENDING_REQUESTS
    const maxPendingForMethod = isControl ? maxPending : Math.max(1, maxPending - RESERVED_CONTROL_REQUEST_SLOTS)
    if (this.pending.size >= maxPendingForMethod) {
      return Promise.reject(new NdCoreError('runtime_busy', 'ND Core client request limit reached.'))
    }

    // Every request here is one main-process <-> nd-core crossing. Counting the
    // attempt (not the successful reply) keeps a composite core operation's
    // claim honest: failed and timed-out crossings cost the caller too.
    taskMetricsRecorder()?.noteIpcCrossing()

    const deadlineMs = resolveCoreDeadlineMs(timeoutMs, options.deadlineMs)
    const encoded = Buffer.from(encode(buildCoreRequestFrame({ id, method, params, ...(deadlineMs === undefined ? {} : { deadlineMs }) })))
    if (encoded.length > ND_CORE_MAX_FRAME_BYTES) {
      return Promise.reject(new Error('ND Core request exceeds the protocol frame limit.'))
    }
    const frameBytes = encoded.length + 4
    const configuredMaxOutstandingBytes = this.options.maxOutstandingRequestBytes
    const maxOutstandingBytes = configuredMaxOutstandingBytes !== undefined && Number.isFinite(configuredMaxOutstandingBytes)
      ? Math.max(ND_CORE_MAX_FRAME_BYTES + 4, Math.floor(configuredMaxOutstandingBytes))
      : DEFAULT_MAX_OUTSTANDING_REQUEST_BYTES
    const maxOutstandingBytesForMethod = isControl
      ? maxOutstandingBytes
      : Math.max(ND_CORE_MAX_FRAME_BYTES + 4, maxOutstandingBytes - RESERVED_CONTROL_REQUEST_BYTES)
    if (this.outstandingRequestBytes + frameBytes > maxOutstandingBytesForMethod) {
      return Promise.reject(new NdCoreError('runtime_busy', 'ND Core client in-flight request budget is full.'))
    }
    const configuredMaxQueuedBytes = this.options.maxQueuedRequestBytes
    const maxQueuedBytes = configuredMaxQueuedBytes !== undefined && Number.isFinite(configuredMaxQueuedBytes)
      ? Math.max(ND_CORE_MAX_FRAME_BYTES + 4, Math.floor(configuredMaxQueuedBytes))
      : DEFAULT_MAX_QUEUED_REQUEST_BYTES
    const maxQueuedBytesForMethod = isControl ? maxQueuedBytes : Math.max(ND_CORE_MAX_FRAME_BYTES + 4, maxQueuedBytes - RESERVED_CONTROL_REQUEST_BYTES)
    if (this.queuedRequestBytes + frameBytes > maxQueuedBytesForMethod) {
      return Promise.reject(new NdCoreError('runtime_busy', 'ND Core client outbound queue is full.'))
    }
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(encoded.length, 0)
    const frame = Buffer.concat([header, encoded])

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.takePending(id)
        // The client timer is only a backstop for a sidecar that stopped answering,
        // and it must not become the old defect of a caller giving up while the work
        // continues in Rust: the request is told to stop as well.
        void this.cancel(id).catch(() => undefined)
        reject(new NdCoreError(ND_CORE_CLIENT_TIMEOUT_CODE, 'ND Core request timed out: ' + method))
      }, Math.max(250, timeoutMs))
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        requestBytes: frameBytes,
      })
      this.outstandingRequestBytes += frameBytes
      this.queuedRequestBytes += frameBytes
      let writeAccounted = true
      const onWriteComplete = (error?: Error | null): void => {
        if (writeAccounted) {
          writeAccounted = false
          this.queuedRequestBytes = Math.max(0, this.queuedRequestBytes - frameBytes)
        }
        if (!error) return
        const pending = this.takePending(id)
        if (!pending) return
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      let accepted = false
      try {
        accepted = child.stdin.write(frame, onWriteComplete)
      } catch (error) {
        onWriteComplete(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (!accepted) this.options.log?.('[nd-core] stdin backpressure; bounded request queue is holding further writes.')
    })
  }

  private handleStdout(generation: number, chunk: Buffer): void {
    if (generation !== this.generation) return
    let offset = 0
    while (offset < chunk.length) {
      if (!this.framePayload) {
        const copied = Math.min(4 - this.frameHeaderBytes, chunk.length - offset)
        chunk.copy(this.frameHeader, this.frameHeaderBytes, offset, offset + copied)
        this.frameHeaderBytes += copied
        offset += copied
        if (this.frameHeaderBytes < 4) return

        const length = this.frameHeader.readUInt32BE(0)
        if (length <= 0 || length > ND_CORE_MAX_FRAME_BYTES) {
          this.failProtocol(new Error('Invalid ND Core frame length: ' + length))
          return
        }
        if (chunk.length - offset >= length) {
          const payload = chunk.subarray(offset, offset + length)
          offset += length
          this.frameHeaderBytes = 0
          this.handlePayload(payload)
          if (!this.child) return
          continue
        }
        this.framePayload = Buffer.allocUnsafe(length)
        this.framePayloadBytes = 0
      }

      const payload = this.framePayload
      const copied = Math.min(payload.length - this.framePayloadBytes, chunk.length - offset)
      chunk.copy(payload, this.framePayloadBytes, offset, offset + copied)
      this.framePayloadBytes += copied
      offset += copied
      if (this.framePayloadBytes < payload.length) return

      this.framePayload = undefined
      this.framePayloadBytes = 0
      this.frameHeaderBytes = 0
      this.handlePayload(payload)
      if (!this.child) return
    }
  }

  private handlePayload(payload: Buffer): void {
    let decoded: unknown
    try {
      decoded = decode(payload)
    } catch (error) {
      this.failProtocol(error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.handleFrame(decoded)
  }

  private resetFrameReader(): void {
    this.frameHeaderBytes = 0
    this.framePayload = undefined
    this.framePayloadBytes = 0
  }

  private handleFrame(value: unknown): void {
    if (!record(value) || value.version !== ND_CORE_PROTOCOL_VERSION || typeof value.kind !== 'string') {
      this.failProtocol(new Error('Malformed ND Core protocol frame.'))
      return
    }
    if (value.kind === 'response') {
      const frame = value as unknown as NdCoreResponseFrame
      if (typeof frame.id !== 'string') {
        this.failProtocol(new Error('ND Core response is missing its request id.'))
        return
      }
      const pending = this.takePending(frame.id)
      if (!pending) return
      clearTimeout(pending.timer)
      if (frame.error) pending.reject(new NdCoreError(frame.error.code, frame.error.message))
      else pending.resolve(frame.result)
      return
    }
    if (value.kind === 'event') {
      const frame = value as unknown as NdCoreEventFrame
      if (typeof frame.event !== 'string') {
        this.failProtocol(new Error('ND Core event is missing its type.'))
        return
      }
      for (const listener of this.listeners.get(frame.event) ?? []) listener(frame)
      for (const listener of this.listeners.get('*') ?? []) listener(frame)
      return
    }
    this.failProtocol(new Error('Unsupported ND Core frame kind: ' + value.kind))
  }

  private handleExit(generation: number, code: number | null, signal: NodeJS.Signals | null): void {
    if (generation !== this.generation) return
    if (this.restartResetTimer) clearTimeout(this.restartResetTimer)
    this.restartResetTimer = undefined
    this.child = undefined
    this.healthValue = undefined
    this.queuedRequestBytes = 0
    this.resetFrameReader()
    this.rejectPending(new Error('ND Core exited unexpectedly (code=' + String(code) + ', signal=' + String(signal) + ').'))
    if (this.closing) return

    this.options.onUnexpectedExit?.(code, signal)
    this.emitSyntheticEvent('core.exit', 'high', { code, signal })

    const restartPolicy = coreRestartPolicy(this.restartAttempts)
    if (!restartPolicy.restart) {
      this.unavailableReason = 'ND Core crashed again before the recovery window became stable. Restart ND-DSH to restore native services.'
      this.options.log?.('[nd-core] restart budget exhausted; native services are unavailable.')
      return
    }
    this.restartAttempts += 1
    this.options.log?.('[nd-core] unexpected exit; attempting one automatic restart.')
    setTimeout(() => {
      if (this.closing) return
      void this.start().catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        this.unavailableReason = 'ND Core automatic restart failed: ' + message
        this.options.log?.('[nd-core] restart failed: ' + message)
      })
    }, restartPolicy.delayMs ?? CORE_RESTART_DELAY_MS)
  }

  private armStableRestartReset(generation: number, child: ChildProcessWithoutNullStreams): void {
    if (this.restartResetTimer) clearTimeout(this.restartResetTimer)
    this.restartResetTimer = setTimeout(() => {
      this.restartResetTimer = undefined
      if (this.closing || generation !== this.generation || this.child !== child || !this.healthValue) return
      this.restartAttempts = 0
      this.unavailableReason = undefined
      this.options.log?.('[nd-core] recovery remained stable; automatic restart budget reset.')
    }, CORE_RESTART_STABLE_RESET_MS)
    this.restartResetTimer.unref()
  }

  private failProtocol(error: Error): void {
    this.options.log?.('[nd-core] protocol failure: ' + error.message)
    const child = this.child
    this.child = undefined
    this.healthValue = undefined
    this.queuedRequestBytes = 0
    this.resetFrameReader()
    this.rejectPending(error)
    try { child?.kill() } catch { /* best effort */ }
  }

  private emitSyntheticEvent(event: string, priority: string, data: unknown): void {
    const frame: NdCoreEventFrame = {
      version: ND_CORE_PROTOCOL_VERSION,
      kind: 'event',
      event,
      priority,
      data,
    }
    for (const listener of this.listeners.get(event) ?? []) listener(frame)
    for (const listener of this.listeners.get('*') ?? []) listener(frame)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.outstandingRequestBytes = 0
    this.queuedRequestBytes = 0
  }

  private takePending(id: string): PendingRequest | undefined {
    const pending = this.pending.get(id)
    if (!pending) return undefined
    this.pending.delete(id)
    this.outstandingRequestBytes = Math.max(0, this.outstandingRequestBytes - pending.requestBytes)
    return pending
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
