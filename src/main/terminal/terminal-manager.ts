import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import type { TerminalCreateInput, TerminalExitEvent, TerminalOutputEvent, TerminalPaneLayout, TerminalSessionState, TerminalSnapshot, TerminalStateEvent } from '../../shared/terminal.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import { quarantineFile } from '../logging/log-file.js'

const MAX_BUFFER = 512 * 1024
const MAX_INPUT = 64 * 1024
const PERSIST_DELAY_MS = 120
const RESTORE_MARKER = '\r\n\x1b[2m[ND] Restored terminal after desktop restart; the previous shell process ended with the app.\x1b[0m\r\n'

type StoredSession = TerminalSessionState
interface StoreFile { version: 1; sessions: StoredSession[] }
export interface PtyProcessLike {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
  /**
   * Replace the shell behind this terminal while keeping the terminal identity.
   * Only a runtime that names its terminals (nd-core) can do this; without it a
   * restart falls back to spawning a fresh shell.
   */
  restart?(cols: number, rows: number): Promise<number>
  /**
   * What the runtime that owns this shell reports about it. Used to tell a shell
   * that is still alive from one whose owner has since restarted.
   */
  shellState?(): Promise<{ running: boolean; generation?: number; restartCount?: number; exitCode?: number } | undefined>
  /** Bounded replay tail owned by the native runtime. */
  tailState?(): Promise<{ seq: number; buffer: string } | undefined>
  /** Add a desktop-only notice to native scrollback without emitting shell output. */
  appendHistory?(data: string): Promise<void>
}
export interface PtySpawnOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
  terminalId?: string
  initialBuffer?: string
  initialOutputSeq?: number
}
export type PtySpawner = (file: string, args: string[], options: PtySpawnOptions) => PtyProcessLike | Promise<PtyProcessLike>
interface Runtime {
  process: PtyProcessLike
  data: { dispose(): void }
  exit: { dispose(): void }
  /**
   * ConPTY's startup cursor-position handshake for this shell. `answered` keeps
   * the reply to one per shell; `payloadSeen` closes the window in which a reply
   * from this layer is more accurate than none.
   */
  handshake: { answered: boolean; payloadSeen: boolean }
}

export interface TerminalManagerOptions {
  storePath: string
  workspace: Pick<WorkspaceService, 'state'>
  spawn: PtySpawner
  onOutput?: (event: TerminalOutputEvent) => void
  onExit?: (event: TerminalExitEvent) => void
  onState?: (event: TerminalStateEvent) => void
}

export class TerminalManager {
  private readonly sessions = new Map<string, StoredSession>()
  private readonly runtimes = new Map<string, Map<string, Runtime>>()
  private readonly spawnPty: PtySpawner
  private initialized = false
  private closing = false
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private persistDueAt = 0
  private persistChain: Promise<void> = Promise.resolve()
  private stateEventChain: Promise<void> = Promise.resolve()

  constructor(private readonly options: TerminalManagerOptions) {
    this.spawnPty = options.spawn
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    try {
      const parsed = JSON.parse(await fs.readFile(this.options.storePath, 'utf8')) as StoreFile
      if (parsed.version === 1 && Array.isArray(parsed.sessions)) {
        for (const session of parsed.sessions) {
          const normalized = normalizeSession(session)
          normalized.sessionId = asId(normalized.sessionId, 'Session id')
          const terminalIds = new Set(normalized.terminals.map((terminal) => asId(terminal.id, 'Terminal id')))
          validateLayout(normalized.layout, terminalIds)
          this.normalize(normalized)
          this.sessions.set(normalized.sessionId, normalized)
        }
      }
    } catch (error) {
      this.sessions.clear()
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                // Starting empty and then persisting that snapshot is how a user loses
        // data: the unreadable file is the only copy of what they had. Keep it
        // aside for recovery and name it for support.
        await quarantineFile(this.options.storePath, error)
      }
    }
    this.initialized = true
  }

  async state(sessionId: string): Promise<TerminalSessionState> {
    const id = asId(sessionId, 'Session id')
    await this.ensureReady()
    const session = this.getSession(id)
    await this.restoreRunning(session)
    return await this.snapshotSession(session)
  }

  async create(input: TerminalCreateInput): Promise<TerminalSessionState> {
    const sessionId = asId(input.sessionId, 'Session id')
    await this.ensureReady()
    if (this.closing) throw new Error('Terminal service is shutting down')
    const session = this.getSession(sessionId)
    await this.restoreRunning(session)
    const cwd = await this.resolveCwd(input.cwd)
    const now = Date.now()
    const terminal: TerminalSnapshot = {
      id: randomUUID(), sessionId,
      title: cleanTitle(input.title) ?? `Terminal ${session.terminals.length + 1}`,
      cwd, shell: '', status: 'starting',
      cols: clamp(input.cols, 100, 2, 1000), rows: clamp(input.rows, 28, 1, 500),
      createdAt: now, updatedAt: now, buffer: '', outputSeq: 0,
    }
    session.terminals.push(terminal)
    if (!session.layout) {
      const paneId = randomUUID()
      session.layout = { type: 'leaf', paneId, terminalId: terminal.id }
      session.activePaneId = paneId
    }
    session.activeTerminalId = terminal.id
    await this.spawn(terminal, input.shell, false)
    this.normalize(session)
    this.changed(sessionId)
    return await this.snapshotSession(session)
  }

  async write(sessionId: string, terminalId: string, data: string): Promise<void> {
    const terminal = await this.owned(sessionId, terminalId)
    if (typeof data !== 'string' || data.length === 0) return
    if (data.length > MAX_INPUT) throw new Error('Terminal input is too large')
    const runtime = this.runtime(terminal.sessionId, terminal.id)
    if (!runtime || terminal.status !== 'running') throw new Error('Terminal is not running')
    runtime.process.write(data)
  }

  async resize(sessionId: string, terminalId: string, cols: number, rows: number): Promise<void> {
    const terminal = await this.owned(sessionId, terminalId)
    terminal.cols = clamp(cols, terminal.cols, 2, 1000)
    terminal.rows = clamp(rows, terminal.rows, 1, 500)
    terminal.updatedAt = Date.now()
    this.runtime(terminal.sessionId, terminal.id)?.process.resize(terminal.cols, terminal.rows)
    this.schedulePersist()
  }

  async close(sessionId: string, terminalId: string): Promise<TerminalSessionState> {
    const terminal = await this.owned(sessionId, terminalId)
    const session = this.sessions.get(terminal.sessionId)!
    this.detach(terminal.sessionId, terminal.id, true)
    session.terminals = session.terminals.filter((item) => item.id !== terminal.id)
    session.layout = removeFromLayout(session.layout, terminal.id)
    this.normalize(session)
    await this.persist()
    this.emit(session.sessionId)
    return await this.snapshotSession(session)
  }

  async restart(sessionId: string, terminalId: string): Promise<TerminalSessionState> {
    const terminal = await this.owned(sessionId, terminalId)
    const runtime = this.runtime(terminal.sessionId, terminal.id)
    terminal.status = 'starting'; terminal.updatedAt = Date.now(); delete terminal.exitCode; delete terminal.error
    const restartMarker = '\r\n\x1b[2m[ND] Restarted terminal.\x1b[0m\r\n'
    if (runtime?.process.restart) {
      if (runtime.process.appendHistory) await runtime.process.appendHistory(restartMarker)
      else append(terminal, restartMarker)
      // The runtime keeps the terminal's identity across the restart, so its output
      // sequence and its listeners continue rather than starting a new terminal.
      try {
        // The shell that comes back is a new console host: it asks the startup
        // cursor-position question again, so the answering window reopens.
        runtime.handshake.answered = false
        runtime.handshake.payloadSeen = false
        const pid = await runtime.process.restart(terminal.cols, terminal.rows)
        terminal.status = 'running'; terminal.pid = pid; delete terminal.recovered
        this.changed(terminal.sessionId)
        return await this.snapshotSession(this.sessions.get(terminal.sessionId)!)
      } catch (error) {
        // A failed in-place restart can leave the previous native shell/tail as
        // the only copy newer than the last disk snapshot. Materialize it before
        // closing the resource so restart failure never erases scrollback.
        const tail = await this.replayTail(terminal, runtime)
        terminal.buffer = tail.buffer.slice(-MAX_BUFFER)
        terminal.outputSeq = Math.max(terminal.outputSeq, tail.seq)
        this.detach(terminal.sessionId, terminal.id, true)
        terminal.status = 'error'
        terminal.error = `Failed to restart shell: ${error instanceof Error ? error.message : String(error)}`
        delete terminal.pid
        this.changed(terminal.sessionId)
        throw new Error(terminal.error)
      }
    }
    append(terminal, restartMarker)
    this.detach(terminal.sessionId, terminal.id, true)
    delete terminal.pid
    await this.spawn(terminal, terminal.shell || undefined, false)
    this.changed(terminal.sessionId)
    return await this.snapshotSession(this.sessions.get(terminal.sessionId)!)
  }

  /**
   * Re-check every live shell against the runtime that owns it and mark the ones
   * that are gone. This is what keeps a session honest after the sidecar restarted:
   * without it a terminal whose shell died with the old sidecar would keep showing
   * as running.
   */
  async reconcileShells(): Promise<number> {
    if (!this.initialized || this.closing) return 0
    let reconciled = 0
    for (const [sessionId, runtimes] of [...this.runtimes]) {
      for (const [terminalId, runtime] of [...runtimes]) {
        if (!runtime.process.shellState) continue
        const terminal = this.sessions.get(sessionId)?.terminals.find((item) => item.id === terminalId)
        if (!terminal || terminal.status !== 'running') continue
        let state: Awaited<ReturnType<NonNullable<PtyProcessLike['shellState']>>> | undefined
        try {
          state = await runtime.process.shellState()
        } catch {
          state = undefined
        }
        if (state?.running && this.runtime(sessionId, terminalId) === runtime) continue
        const tail = await this.replayTail(terminal, runtime)
        terminal.buffer = tail.buffer.slice(-MAX_BUFFER)
        terminal.outputSeq = Math.max(terminal.outputSeq, tail.seq)
        this.detach(sessionId, terminalId, true)
        terminal.status = 'exited'
        terminal.exitCode = state?.exitCode ?? terminal.exitCode ?? 1
        terminal.updatedAt = Date.now()
        delete terminal.pid
        reconciled += 1
        this.options.onExit?.({
          sessionId,
          terminalId,
          exitCode: terminal.exitCode,
        })
        this.changed(sessionId)
      }
    }
    return reconciled
  }

  async rename(sessionId: string, terminalId: string, title: string): Promise<TerminalSessionState> {
    const terminal = await this.owned(sessionId, terminalId)
    const next = cleanTitle(title)
    if (!next) throw new Error('Terminal title cannot be empty')
    terminal.title = next; terminal.updatedAt = Date.now()
    this.changed(terminal.sessionId)
    return await this.snapshotSession(this.sessions.get(terminal.sessionId)!)
  }

  async setLayout(sessionId: string, layout: TerminalPaneLayout | null, activePaneId: string | null, activeTerminalId: string | null): Promise<TerminalSessionState> {
    const id = asId(sessionId, 'Session id')
    await this.ensureReady()
    const session = this.getSession(id)
    await this.restoreRunning(session)
    const terminalIds = new Set(session.terminals.map((terminal) => terminal.id))
    validateLayout(layout, terminalIds)
    const paneIds = collectPanes(layout)
    if (activePaneId !== null && !paneIds.has(activePaneId)) throw new Error('Active pane is outside this session layout')
    if (activeTerminalId !== null && !terminalIds.has(activeTerminalId)) throw new Error('Active terminal does not belong to this session')
    session.layout = cloneLayout(layout); session.activePaneId = activePaneId; session.activeTerminalId = activeTerminalId
    this.normalize(session); this.changed(id)
    return await this.snapshotSession(session)
  }

  async shutdown(): Promise<void> {
    if (!this.initialized || this.closing) return
    this.closing = true
    if (this.persistTimer) clearTimeout(this.persistTimer)
    await this.persist()
    for (const [sessionId, runtimes] of this.runtimes) for (const terminalId of [...runtimes.keys()]) this.detach(sessionId, terminalId, true)
    await this.persistChain
    await this.stateEventChain.catch(() => undefined)
  }

  private async restoreRunning(session: StoredSession): Promise<void> {
    if (this.closing) return
    for (const terminal of session.terminals) {
      if (!['running', 'starting'].includes(terminal.status) || this.runtime(session.sessionId, terminal.id)) continue
      terminal.status = 'starting'; terminal.recovered = true; delete terminal.pid; delete terminal.exitCode; delete terminal.error
      append(terminal, RESTORE_MARKER)
      try { await this.spawn(terminal, terminal.shell || undefined, true) } catch { /* snapshot records error */ }
    }
  }

  private async spawn(terminal: TerminalSnapshot, requestedShell: string | undefined, recovered: boolean): Promise<void> {
    let lastError: unknown
    for (const attempt of shellAttempts(requestedShell)) {
      try {
        const pty = await this.spawnPty(attempt.file, attempt.args, {
          name: 'xterm-256color', cols: terminal.cols, rows: terminal.rows, cwd: terminal.cwd,
          env: terminalEnv(terminal.sessionId, terminal.id),
          terminalId: terminal.id,
          initialBuffer: terminal.buffer,
          initialOutputSeq: terminal.outputSeq,
        })
        terminal.shell = attempt.file; terminal.status = 'running'; terminal.pid = pty.pid; terminal.updatedAt = Date.now()
        if (recovered) terminal.recovered = true; else delete terminal.recovered
        const runtime: Runtime = { process: pty, data: { dispose() {} }, exit: { dispose() {} }, handshake: { answered: false, payloadSeen: false } }
        let group = this.runtimes.get(terminal.sessionId)
        if (!group) { group = new Map(); this.runtimes.set(terminal.sessionId, group) }
        group.set(terminal.id, runtime)
        runtime.data = pty.onData((data) => {
          if (this.runtime(terminal.sessionId, terminal.id) !== runtime) return
          answerStartupCursorQuery(pty, runtime.handshake, data)
          terminal.outputSeq += 1; terminal.updatedAt = Date.now()
          if (!pty.tailState) append(terminal, data)
          this.options.onOutput?.({ sessionId: terminal.sessionId, terminalId: terminal.id, seq: terminal.outputSeq, data })
        })
        runtime.exit = pty.onExit((event) => {
          void this.handleRuntimeExit(terminal, runtime, event)
        })
        // nd-core owns hot scrollback; this field is only a persistence/recovery
        // slot for native PTYs. Test/fallback PTYs keep the legacy JS buffer.
        if (pty.tailState) {
          // ConPTY can ask before terminal.create returns and listeners attach.
          // Its retained tail recovers that query. Ignore seeded recovery history
          // when deciding whether this new shell has produced payload yet.
          const seededBuffer = terminal.buffer
          terminal.buffer = ''
          const tail = await pty.tailState().catch(() => undefined)
          if (tail && this.runtime(terminal.sessionId, terminal.id) === runtime) {
            answerStartupCursorQuery(pty, runtime.handshake, tail.buffer.startsWith(seededBuffer) ? tail.buffer.slice(seededBuffer.length) : tail.buffer)
          }
        }
        return
      } catch (error) { lastError = error }
    }
    terminal.status = 'error'; terminal.updatedAt = Date.now(); terminal.error = `Failed to start shell: ${lastError instanceof Error ? lastError.message : String(lastError)}`; delete terminal.pid
    this.schedulePersist(); throw new Error(terminal.error)
  }

  private async handleRuntimeExit(
    terminal: TerminalSnapshot,
    runtime: Runtime,
    event: { exitCode: number; signal?: number },
  ): Promise<void> {
    if (this.runtime(terminal.sessionId, terminal.id) !== runtime) return
    if (runtime.process.tailState) {
      const tail = await runtime.process.tailState().catch(() => undefined)
      if (this.runtime(terminal.sessionId, terminal.id) !== runtime) return
      if (tail) {
        terminal.buffer = tail.buffer.slice(-MAX_BUFFER)
        terminal.outputSeq = Math.max(terminal.outputSeq, tail.seq)
      }
    }
    // nd-core retains an exited shell just long enough for this final replay.
    // Closing the resource here prevents an exited terminal from accumulating
    // in Rust; its cold persisted copy now lives in the session snapshot.
    this.detach(terminal.sessionId, terminal.id, Boolean(runtime.process.tailState))
    terminal.status = 'exited'
    terminal.exitCode = event.exitCode
    terminal.updatedAt = Date.now()
    delete terminal.pid
    this.options.onExit?.({
      sessionId: terminal.sessionId,
      terminalId: terminal.id,
      exitCode: event.exitCode,
      ...(event.signal === undefined ? {} : { signal: event.signal }),
    })
    this.changed(terminal.sessionId)
  }

  private async owned(sessionId: string, terminalId: string): Promise<TerminalSnapshot> {
    const owner = asId(sessionId, 'Session id'); const id = asId(terminalId, 'Terminal id')
    await this.ensureReady(); const session = this.getSession(owner); await this.restoreRunning(session)
    const terminal = session.terminals.find((item) => item.id === id)
    if (!terminal) throw new Error('Terminal does not belong to this session')
    return terminal
  }

  private getSession(sessionId: string): StoredSession {
    let session = this.sessions.get(sessionId)
    if (!session) { session = { sessionId, terminals: [], layout: null, activePaneId: null, activeTerminalId: null }; this.sessions.set(sessionId, session) }
    return session
  }

  private async resolveCwd(value: string | undefined): Promise<string> {
    const root = resolve(this.options.workspace.state().root)
    const candidate = value?.trim() ? resolve(value.trim()) : root
    if (!isAbsolute(candidate)) throw new Error('Terminal cwd must be absolute')
    const stats = await fs.stat(candidate); if (!stats.isDirectory()) throw new Error('Terminal cwd is not a directory')
    return fs.realpath(candidate)
  }

  private normalize(session: StoredSession): void {
    const terminalIds = new Set(session.terminals.map((terminal) => terminal.id))
    session.layout = pruneLayout(session.layout, terminalIds)
    if (!session.layout && session.terminals[0]) { const paneId = randomUUID(); session.layout = { type: 'leaf', paneId, terminalId: session.terminals[0].id }; session.activePaneId = paneId }
    const paneIds = collectPanes(session.layout)
    if (!session.activePaneId || !paneIds.has(session.activePaneId)) session.activePaneId = firstPane(session.layout)
    const visible = terminalForPane(session.layout, session.activePaneId)
    if (!session.activeTerminalId || !terminalIds.has(session.activeTerminalId)) session.activeTerminalId = visible ?? session.terminals[0]?.id ?? null
  }

  private async snapshotSession(session: StoredSession): Promise<StoredSession> {
    const snapshot = cloneSession(session)
    await Promise.all(snapshot.terminals.map(async (copy) => {
      const original = session.terminals.find((terminal) => terminal.id === copy.id)
      if (!original) return
      const tail = await this.replayTail(original, this.runtime(session.sessionId, original.id))
      copy.buffer = tail.buffer.slice(-MAX_BUFFER)
      copy.outputSeq = Math.max(copy.outputSeq, tail.seq)
    }))
    return snapshot
  }

  private async replayTail(terminal: TerminalSnapshot, runtime: Runtime | undefined): Promise<{ buffer: string; seq: number }> {
    if (!runtime?.process.tailState) {
      return { buffer: terminal.buffer, seq: terminal.outputSeq }
    }
    const native = await runtime.process.tailState().catch(() => undefined)
    if (native) return { buffer: native.buffer, seq: native.seq }

    // The sidecar may have restarted between the last output event and this
    // state/persistence read. The last durable snapshot is safer than replacing
    // scrollback with an empty native tail from a new sidecar generation.
    return await this.persistedTail(terminal.sessionId, terminal.id)
      ?? { buffer: terminal.buffer, seq: terminal.outputSeq }
  }

  private async persistedTail(sessionId: string, terminalId: string): Promise<{ buffer: string; seq: number } | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.options.storePath, 'utf8')) as StoreFile
      const terminal = parsed.sessions
        ?.find((session) => session.sessionId === sessionId)
        ?.terminals?.find((item) => item.id === terminalId)
      if (!terminal) return undefined
      return {
        buffer: String(terminal.buffer ?? '').slice(-MAX_BUFFER),
        seq: Math.max(0, Math.floor(terminal.outputSeq ?? 0)),
      }
    } catch {
      return undefined
    }
  }

  private runtime(sessionId: string, terminalId: string): Runtime | undefined { return this.runtimes.get(sessionId)?.get(terminalId) }
  private detach(sessionId: string, terminalId: string, kill: boolean): void {
    const group = this.runtimes.get(sessionId); const runtime = group?.get(terminalId); if (!runtime) return
    group!.delete(terminalId); if (group!.size === 0) this.runtimes.delete(sessionId)
    runtime.data.dispose(); runtime.exit.dispose(); if (kill) try { runtime.process.kill() } catch { /* already exited */ }
  }
  private changed(sessionId: string): void { this.schedulePersist(); this.emit(sessionId) }
  private emit(sessionId: string): void {
    this.stateEventChain = this.stateEventChain.catch(() => undefined).then(async () => {
      const state = await this.snapshotSession(this.getSession(sessionId))
      this.options.onState?.({ sessionId, state })
    })
  }
  /**
   * A pending persist is only ever pulled earlier, never pushed later, so
   * sustained output still reaches disk once per window instead of starving it.
   */
  private schedulePersist(delayMs = PERSIST_DELAY_MS): void {
    if (this.closing) return
    const dueAt = Date.now() + delayMs
    if (this.persistTimer) {
      if (this.persistDueAt <= dueAt) return
      clearTimeout(this.persistTimer)
    }
    this.persistDueAt = dueAt
    this.persistTimer = setTimeout(() => { this.persistTimer = undefined; void this.persist().catch((error) => console.error('[terminal] persist failed:', error)) }, delayMs)
  }
  private async persist(): Promise<void> {
    const sessions = await Promise.all([...this.sessions.values()].map((session) => this.snapshotSession(session)))
    const payload: StoreFile = { version: 1, sessions }
    this.persistChain = this.persistChain.catch(() => undefined).then(async () => {
      await fs.mkdir(dirname(this.options.storePath), { recursive: true })
      const temp = `${this.options.storePath}.tmp`
      await fs.writeFile(temp, `${JSON.stringify(payload)}\n`, 'utf8')
      await fs.rename(temp, this.options.storePath)
    })
    return this.persistChain
  }
  private async ensureReady(): Promise<void> { if (!this.initialized) await this.initialize() }
}

function shellAttempts(requested?: string): Array<{ file: string; args: string[] }> {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
    return unique([requested, process.env.COMSPEC, 'pwsh.exe', join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe'), join(root, 'System32/cmd.exe')]).map((file) => ({ file, args: /powershell|pwsh/i.test(file) ? ['-NoLogo'] : [] }))
  }
  return unique([requested, process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh']).map((file) => ({ file, args: ['-l'] }))
}
function terminalEnv(sessionId: string, terminalId: string): Record<string, string> {
  const env: Record<string, string> = {}; for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'ND-DSH', ND_DSH_SESSION_ID: sessionId, ND_DSH_TERMINAL_ID: terminalId }
}
function unique(values: Array<string | undefined>): string[] { return [...new Set(values.map((v) => v?.trim()).filter((v): v is string => Boolean(v)))] }
function append(terminal: TerminalSnapshot, data: string): void { terminal.buffer = `${terminal.buffer}${data}`.slice(-MAX_BUFFER) }

const CURSOR_QUERY = '\u001b[6n'
const CURSOR_REPLY = '\u001b[1;1R'

/**
 * Answer ConPTY's startup cursor-position query when nothing else will.
 *
 * The Windows console host asks the terminal for its cursor position (`ESC[6n`)
 * before it releases the child's output, and waits for the answer. A rendered
 * xterm.js pane replies on its own, which is why the terminal pane is
 * unaffected; a terminal that nothing renders — the packaged runtime smoke, an
 * e2e spec driving the preload bridge, a session whose pane is not mounted —
 * receives those four bytes and then silence, with the shell alive and its
 * output withheld.
 *
 * The reply is deliberately limited to the startup handshake: it is written
 * only while the shell has produced no payload yet, which is precisely when the
 * console host is withholding output and the cursor is still at home. A later
 * query is left to the emulator, because this layer cannot know where the
 * cursor is, and a wrong position would move the console host's cursor under
 * the user's terminal. POSIX PTYs never query, so this is a no-op there.
 */
function answerStartupCursorQuery(pty: PtyProcessLike, handshake: Runtime['handshake'], data: string): void {
  if (process.platform !== 'win32' || handshake.answered || handshake.payloadSeen) return
  const queryAt = data.indexOf(CURSOR_QUERY)
  if (queryAt === -1) {
    if (hasTerminalPayload(data)) handshake.payloadSeen = true
    return
  }
  if (hasTerminalPayload(data.slice(0, queryAt))) {
    handshake.payloadSeen = true
    return
  }
  handshake.answered = true
  try { pty.write(CURSOR_REPLY) } catch { /* the shell may already be gone; its exit event is the report */ }
}

/** True when a chunk carries anything but escape sequences and line endings. */
function hasTerminalPayload(data: string): boolean {
  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index)
    if (code === 0x1b) {
      const next = data.charCodeAt(index + 1)
      if (next === 0x5b) {
        let end = index + 2
        while (end < data.length && !(data.charCodeAt(end) >= 0x40 && data.charCodeAt(end) <= 0x7e)) end += 1
        index = end
      } else if (next === 0x5d) {
        let end = index + 2
        while (end < data.length && data.charCodeAt(end) !== 0x07 && !(data.charCodeAt(end) === 0x1b && data.charCodeAt(end + 1) === 0x5c)) end += 1
        index = data.charCodeAt(end) === 0x07 ? end : end + 1
      } else {
        index += 1
      }
      continue
    }
    if (code >= 0x20 && code !== 0x7f) return true
  }
  return false
}
function asId(value: string, label: string): string { const id = value?.trim(); if (!id || id.length > 256) throw new Error(`${label} is invalid`); return id }
function cleanTitle(value?: string): string | undefined { const title = value?.trim().replace(/\s+/g, ' '); return title ? title.slice(0, 80) : undefined }
function clamp(value: number | undefined, fallback: number, min: number, max: number): number { return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback }
function cloneLayout(layout: TerminalPaneLayout | null): TerminalPaneLayout | null { if (!layout) return null; return layout.type === 'leaf' ? { ...layout } : { ...layout, first: cloneLayout(layout.first)!, second: cloneLayout(layout.second)! } }
function cloneSession(session: StoredSession): StoredSession { return { sessionId: session.sessionId, terminals: session.terminals.map((terminal) => ({ ...terminal })), layout: cloneLayout(session.layout), activePaneId: session.activePaneId, activeTerminalId: session.activeTerminalId } }
function normalizeSession(session: StoredSession): StoredSession { const copy = cloneSession(session); copy.terminals = copy.terminals.filter((t) => t.sessionId === copy.sessionId).map((t) => ({ ...t, buffer: String(t.buffer ?? '').slice(-MAX_BUFFER), outputSeq: Math.max(0, Math.floor(t.outputSeq ?? 0)), cols: clamp(t.cols, 100, 2, 1000), rows: clamp(t.rows, 28, 1, 500) })); return copy }
export function validateLayout(layout: TerminalPaneLayout | null, terminalIds: ReadonlySet<string>): void {
  const panes = new Set<string>(); const visible = new Set<string>()
  const walk = (node: TerminalPaneLayout, depth: number): void => { if (depth > 24) throw new Error('Terminal layout is too deeply nested'); if (node.type === 'leaf') { if (!terminalIds.has(node.terminalId)) throw new Error('Terminal layout references another session'); if (panes.has(node.paneId)) throw new Error('Duplicate terminal pane'); if (visible.has(node.terminalId)) throw new Error('A terminal cannot appear in more than one pane'); panes.add(node.paneId); visible.add(node.terminalId); return } if (node.ratio !== undefined && (!Number.isFinite(node.ratio) || node.ratio < 0.1 || node.ratio > 0.9)) throw new Error('Invalid terminal split ratio'); walk(node.first, depth + 1); walk(node.second, depth + 1) }
  if (layout) walk(layout, 0)
}
function removeFromLayout(layout: TerminalPaneLayout | null, terminalId: string): TerminalPaneLayout | null { if (!layout) return null; if (layout.type === 'leaf') return layout.terminalId === terminalId ? null : { ...layout }; const first = removeFromLayout(layout.first, terminalId); const second = removeFromLayout(layout.second, terminalId); if (!first) return second; if (!second) return first; return { ...layout, first, second } }
function pruneLayout(layout: TerminalPaneLayout | null, ids: ReadonlySet<string>): TerminalPaneLayout | null { if (!layout) return null; if (layout.type === 'leaf') return ids.has(layout.terminalId) ? { ...layout } : null; const first = pruneLayout(layout.first, ids); const second = pruneLayout(layout.second, ids); if (!first) return second; if (!second) return first; return { ...layout, first, second } }
function collectPanes(layout: TerminalPaneLayout | null): Set<string> { const set = new Set<string>(); const walk = (node: TerminalPaneLayout): void => { if (node.type === 'leaf') set.add(node.paneId); else { walk(node.first); walk(node.second) } }; if (layout) walk(layout); return set }
function firstPane(layout: TerminalPaneLayout | null): string | null { return !layout ? null : layout.type === 'leaf' ? layout.paneId : firstPane(layout.first) }
function terminalForPane(layout: TerminalPaneLayout | null, paneId: string | null): string | null { if (!layout || !paneId) return null; return layout.type === 'leaf' ? layout.paneId === paneId ? layout.terminalId : null : terminalForPane(layout.first, paneId) ?? terminalForPane(layout.second, paneId) }
