import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, promises as fs } from 'node:fs'
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path'

interface RunResult {
  stdout: string
  stderr: string
  json?: unknown
}

export interface AgentBrowserStatus {
  state: 'binding' | 'ready' | 'unavailable'
  error?: string
}

const COMMAND_TIMEOUT_MS = 120_000
const MAX_CAPTURE_CHARS = 2_000_000
const BIND_COMMAND_TIMEOUT_MS = 10_000
const BIND_RETRY_DELAY_MS = 2_500
const SMOKE_TEST_TIMEOUT_MS = 15_000
// Shutdown must fit inside the app's own 5 s quit budget, and the CLI close is
// only best effort: the identity sweep below is what actually guarantees the
// daemon is gone. A long close here made the app exceed that budget and force
// exit with the daemon still running.
const SHUTDOWN_TIMEOUT_MS = 1_200
const DAEMON_EXIT_GRACE_MS = 1_000
/**
 * Namespace that isolates this product's daemon sockets and restore state from
 * any other agent-browser use on the machine. Pinned in the config file because
 * a consumer that reads only that file — the Harness browser MCP — otherwise
 * starts its daemon in the CLI's unnamespaced global state directory, where
 * shutdown cannot find it.
 */
export const AGENT_BROWSER_DAEMON_NAMESPACE = 'nd-dsh'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const DEFAULT_AGENT_BROWSER_SESSION = 'nd-visible'

export class AgentBrowserClient {
  readonly cdpPort: number
  readonly sessionName: string
  readonly configPath: string
  readonly socketDir: string
  readonly binary: string
  readonly entryPath: string
  private readonly electronNodeMode: boolean
  private statusValue: AgentBrowserStatus = { state: 'binding' }
  private sessionTouched = false
  private closing: Promise<void> | undefined

  constructor(cdpPort: number, projectRoot: string, sessionName?: string) {
    this.cdpPort = cdpPort
    this.sessionName = sessionName?.trim()
      || process.env.ND_DSH_AGENT_BROWSER_SESSION?.trim()
      || process.env.AGENT_BROWSER_SESSION?.trim()
      || DEFAULT_AGENT_BROWSER_SESSION
    this.configPath = appBrowserConfigPath()
    this.socketDir = appBrowserSocketDir()
    this.binary = this.resolveBinary(projectRoot)
    this.entryPath = resolve(
      process.env.ND_DSH_AGENT_BROWSER_ENTRY
        ?? (process.platform === 'win32'
          ? join(app.isPackaged ? process.resourcesPath : projectRoot, 'scripts', 'nd-agent-browser-cli.mjs')
          : join(
            app.isPackaged ? process.resourcesPath : projectRoot,
            'node_modules',
            'agent-browser',
            'bin',
            'agent-browser.js',
          )),
    )
    this.electronNodeMode = (app.isPackaged || process.platform === 'win32') && !process.env.ND_DSH_AGENT_BROWSER_BIN?.trim()
  }

  status(): AgentBrowserStatus {
    return { ...this.statusValue }
  }

  resetBinding(): void {
    this.statusValue = { state: 'binding' }
  }

  recordFailure(error: unknown): void {
    this.statusValue = {
      state: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  /**
   * Throws if the config file has not been written yet. Called by the harness
   * immediately before spawning the runtime child so the browser MCP server
   * always starts with a pinned session already on disk.
   */
  assertConfigReady(): void {
    if (!existsSync(this.configPath)) {
      throw new Error(
        `agent-browser config has not been written to ${this.configPath}. ` +
        'The browser pane must finish binding before the runtime can start.',
      )
    }
  }

  async prepareConfig(): Promise<void> {
    const artifactDirectory = join(app.getPath('userData'), 'browser-artifacts')
    await Promise.all([
      fs.mkdir(artifactDirectory, { recursive: true }),
      fs.mkdir(this.socketDir, { recursive: true }),
    ])
    const config = {
      $schema: 'https://agent-browser.dev/schema.json',
      cdp: String(this.cdpPort),
      session: this.sessionName,
      namespace: AGENT_BROWSER_DAEMON_NAMESPACE,
      pinTab: true,
      json: true,
      contentBoundaries: true,
      screenshotDir: artifactDirectory,
      idleTimeout: '30m',
    }
    await fs.writeFile(this.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  }

  async bindTarget(targetId: string): Promise<void> {
    this.statusValue = { state: 'binding' }
    try {
      await this.prepareConfig()
      if (!existsSync(this.entryPath)) {
        throw new Error(`agent-browser MCP entry is missing from this ND install at ${this.entryPath}. Reinstall ND.`)
      }
      // A brand-new pinned session may create a fresh tab before a target is
      // selected. Bind once without strict pinning, then turn strict pinning on
      // for every subsequent CLI and MCP command.
      //
      // A cold daemon's first CDP attach can fail or stall against the visible
      // pane; one transparent retry keeps that off the agent's tool path
      // instead of surfacing as an unavailable browser mid-session.
      try {
        this.sessionTouched = true
        await this.bindPinnedTab(targetId)
      } catch {
        this.statusValue = { state: 'binding' }
        await sleep(BIND_RETRY_DELAY_MS)
        await this.bindPinnedTab(targetId)
      }
      // Verify the config file landed and the session is reachable before
      // declaring success. A failed smoke-test is logged but does not mark the
      // browser unavailable — the MCP server will recover on the agent's first
      // real tool call once the daemon finishes attaching.
      try {
        await this.smokeTest()
      } catch (smokeError) {
        console.warn('[agent-browser] post-bind smoke test failed:', smokeError instanceof Error ? smokeError.message : String(smokeError))
      }
      this.statusValue = { state: 'ready' }
    } catch (error) {
      this.recordFailure(error)
      throw error
    }
  }

  private async bindPinnedTab(targetId: string): Promise<void> {
    await this.run(['tab', targetId], ['--no-pin-tab'], BIND_COMMAND_TIMEOUT_MS)
    await this.run(['get', 'url'], ['--pin-tab'], BIND_COMMAND_TIMEOUT_MS)
  }

  /**
   * Shallow health probe run after a successful bind. Calls a depth-1
   * interactive snapshot with a short timeout so binding failures surface
   * immediately rather than on the agent's first real tool call.
   *
   * A probe failure is non-fatal: the session is already pinned, so the MCP
   * server will recover on its first real command. The error is surfaced to
   * the caller for logging only.
   */
  async smokeTest(): Promise<void> {
    if (!existsSync(this.configPath)) {
      throw new Error(
        `agent-browser config was not written to ${this.configPath} after bind. ` +
        'The MCP server will start without a pinned session.',
      )
    }
    await this.run(['snapshot', '-i', '-d', '1'], ['--pin-tab'], SMOKE_TEST_TIMEOUT_MS)
  }

  async snapshot(): Promise<unknown> {
    const result = await this.run(['snapshot', '-i'])
    return result.json ?? result.stdout
  }

  async close(): Promise<void> {
    if (!this.closing) {
      this.closing = (async () => {
        // The socket directory is private to this ND app/userData, and every
        // session in it belongs to this app. Another app-owned client (for
        // example the Harness browser MCP) can start a daemon under its own
        // session name before this wrapper marks its own session as touched, so
        // ownership follows every pid sidecar in the directory as well as
        // sessionTouched — not this wrapper's session name alone.
        //
        // Capture the daemon pids *before* asking agent-browser to close the
        // sessions. agent-browser may remove a pid file as part of close even
        // when the daemon process is still alive; reading the files afterwards
        // loses the only stable ownership handle and leaks the daemon beyond
        // the Electron process, where it holds inherited pipes open until its
        // idle timeout.
        const daemonPids = await this.daemonPids()
        console.log(`[agent-browser] shutdown start: sessionTouched=${this.sessionTouched} sidecars=${daemonPids.length}`)
        if (this.sessionTouched || daemonPids.length > 0) {
          // Close the space this wrapper's environment points at, then the space a
          // config-only consumer resolves to. The namespace is pinned in the config
          // file, so the second call reaches a daemon the first cannot see.
          await this.closeSessions()
          await this.closeSessions({ withoutSocketDir: true })
          await this.ensureDaemonsStopped(daemonPids)
        }
        // Runs unconditionally: a pid sidecar can name a client that has already
        // exited while its daemon lives on, and that daemon is exactly the one
        // that would hold inherited pipes open past this process.
        await stopAgentBrowserDaemonProcesses(this.socketDir, this.configPath)
      })().finally(() => {
        this.sessionTouched = false
        this.closing = undefined
      })
    }
    return this.closing
  }

  environment(): NodeJS.ProcessEnv {
    return {
      ND_DSH_AGENT_BROWSER_BIN: this.binary,
      ND_DSH_AGENT_BROWSER_CONFIG: this.configPath,
      ND_DSH_AGENT_BROWSER_ENTRY: this.entryPath,
      ND_DSH_AGENT_BROWSER_SESSION: this.sessionName,
      AGENT_BROWSER_CONFIG: this.configPath,
      AGENT_BROWSER_SESSION: this.sessionName,
      AGENT_BROWSER_SOCKET_DIR: this.socketDir,
    }
  }

  private async closeSessions(options: { withoutSocketDir?: boolean } = {}): Promise<void> {
    try {
      // `close` ends one session; `--all` ends every session in the daemon space,
      // which is what shutdown owns.
      await this.run(['close', '--all'], [], SHUTDOWN_TIMEOUT_MS, options)
    } catch (error) {
      console.warn('[agent-browser] graceful session cleanup failed:', error instanceof Error ? error.message : String(error))
    }
  }

  /** Every daemon pid sidecar in the directories this app can own. */
  private async daemonPids(): Promise<number[]> {
    return daemonPidsFor(this.socketDir)
  }

  private async ensureDaemonsStopped(capturedPids: number[]): Promise<void> {
    // Prefer the pre-close pids because the CLI can unlink a pid file before
    // the daemon has actually exited. Fall back to a post-close read for
    // versions that leave the files in place.
    const pids = new Set<number>(capturedPids)
    for (const pid of await this.daemonPids()) pids.add(pid)
    for (const pid of pids) await forceStopDaemon(pid, DAEMON_EXIT_GRACE_MS)
  }

  private resolveBinary(projectRoot: string): string {
    const override = process.env.ND_DSH_AGENT_BROWSER_BIN?.trim()
    if (override) {
      if (isAbsolute(override) || override.includes('/') || override.includes('\\')) return resolve(override)
      return override
    }
    if (app.isPackaged || process.platform === 'win32') return process.execPath
    return join(projectRoot, 'node_modules', '.bin', 'agent-browser')
  }

  private async run(
    command: string[],
    globalArguments: string[] = [],
    timeoutMs = COMMAND_TIMEOUT_MS,
    options: { withoutSocketDir?: boolean } = {},
  ): Promise<RunResult> {
    if (this.binary.includes(sep) && !existsSync(this.binary)) {
      throw new Error(`agent-browser is missing from this ND install at ${this.binary}. Reinstall ND.`)
    }

    const args = [
      ...(this.electronNodeMode ? [this.entryPath] : []),
      '--config', this.configPath, '--json', ...globalArguments, ...command,
    ]
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.binary, args, {
        cwd: process.cwd(),
        windowsHide: true,
        shell: process.platform === 'win32' && this.binary.toLowerCase().endsWith('.cmd'),
        env: {
          ...process.env,
          PATH: process.env.PATH?.split(delimiter).filter(Boolean).join(delimiter),
          AGENT_BROWSER_CONFIG: this.configPath,
          AGENT_BROWSER_SESSION: this.sessionName,
          ...(options.withoutSocketDir ? {} : { AGENT_BROWSER_SOCKET_DIR: this.socketDir }),
          ...(this.electronNodeMode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        },
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`agent-browser command timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref()

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < MAX_CAPTURE_CHARS) stdout += chunk.slice(0, MAX_CAPTURE_CHARS - stdout.length)
      })
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < MAX_CAPTURE_CHARS) stderr += chunk.slice(0, MAX_CAPTURE_CHARS - stderr.length)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          reject(new Error(stderr.trim() || stdout.trim() || `agent-browser exited with code ${String(code)}`))
          return
        }
        const trimmed = stdout.trim()
        let json: unknown
        if (trimmed) {
          try {
            json = JSON.parse(trimmed)
          } catch {
            json = undefined
          }
        }
        resolvePromise({ stdout: trimmed, stderr: stderr.trim(), ...(json === undefined ? {} : { json }) })
      })
    })
  }
}

/** The app's private daemon socket directory. */
export function appBrowserSocketDir(): string {
  const override = process.env.AGENT_BROWSER_SOCKET_DIR?.trim() || process.env.ND_DSH_AGENT_BROWSER_SOCKET_DIR?.trim()
  if (override) return resolve(override)

  const candidate = join(app.getPath('userData'), 'agent-browser-runtime')
  if (process.platform === 'win32') return candidate

  // UNIX domain socket paths have strict limits: 104 bytes on Darwin (103 chars
  // max) and 108 bytes on Linux (107 chars max). agent-browser appends
  // `/namespaces/<namespace>/run/<session>.sock` to this directory. If the
  // userData directory produces a path that exceeds the platform limit, fall
  // back to a per-user runtime directory under /tmp.
  const maxSocketPathLength = process.platform === 'darwin' ? 103 : 107
  const maxNamespaceSuffix = `/namespaces/${AGENT_BROWSER_DAEMON_NAMESPACE}/run/${DEFAULT_AGENT_BROWSER_SESSION}.sock`.length
  if (candidate.length + maxNamespaceSuffix <= maxSocketPathLength) {
    return candidate
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : '0'
  return `/tmp/nd-dsh-${uid}/ab`
}

/** The config file every app-owned agent-browser client reads. */
export function appBrowserConfigPath(): string {
  return join(app.getPath('userData'), 'agent-browser.visible.json')
}

/**
 * Path fragment that identifies an agent-browser daemon on any install.
 *
 * Both shapes end in it: the CLI binary a development checkout runs
 * (`node_modules/.pnpm/agent-browser@x/node_modules/agent-browser/bin/agent-browser-linux-x64`)
 * and the packaged entry script the app runs under `ELECTRON_RUN_AS_NODE`
 * (`app.asar/node_modules/agent-browser/bin/agent-browser.js`). Matching the
 * containing Electron binary instead would match this app itself, and matching
 * the bare name would match an unrelated agent-browser install on the machine.
 */
const DAEMON_COMMAND_MARKER = 'agent-browser/bin/agent-browser'

export function isAgentBrowserDaemonCommand(command: string): boolean {
  return command.replace(/\\/g, '/').includes(DAEMON_COMMAND_MARKER)
}

interface ProcessRow {
  pid: number
  ppid: number
  command: string
}

/**
 * Enumerate processes with their parent and command line.
 *
 * Linux is read from `/proc` rather than by spawning `ps`: this runs inside the
 * app's own shutdown, where a `ps` that is missing, blocked, or shadowed would
 * silently no-op the sweep that has to stop the daemon. Other platforms fall
 * back to `ps`.
 */
async function listProcesses(): Promise<ProcessRow[]> {
  const fromProc = await listProcProcesses()
  return fromProc.length > 0 ? fromProc : listPsProcesses()
}

async function listProcProcesses(): Promise<ProcessRow[]> {
  if (process.platform !== 'linux') return []
  let entries: string[]
  try {
    entries = await fs.readdir('/proc')
  } catch {
    return []
  }
  const rows: ProcessRow[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      // `stat` is `pid (comm) state ppid ...`, and comm can hold spaces and
      // parentheses, so only the fields after the last ')' can be trusted.
      const stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const command = (await fs.readFile(`/proc/${entry}/cmdline`, 'utf8')).split('\0').filter(Boolean).join(' ')
      if (!command) continue
      rows.push({ pid: Number(entry), ppid: Number(fields[1]), command })
    } catch {
      continue
    }
  }
  return rows
}

async function listPsProcesses(): Promise<ProcessRow[]> {
  if (process.platform === 'win32') return []
  const listing = await new Promise<string>((resolvePromise) => {
    const child = spawn('ps', ['-eo', 'pid=,ppid=,args='], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.once('error', () => resolvePromise(''))
    child.once('close', () => resolvePromise(stdout))
  })
  const rows: ProcessRow[] = []
  for (const line of listing.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? '' })
  }
  return rows
}

function descendantPids(rows: ProcessRow[], rootPid: number): Set<number> {
  const children = new Map<number, number[]>()
  for (const row of rows) {
    const list = children.get(row.ppid)
    if (list) list.push(row.pid)
    else children.set(row.ppid, [row.pid])
  }
  const descendants = new Set<number>()
  const queue = [rootPid]
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (descendants.has(child)) continue
      descendants.add(child)
      queue.push(child)
    }
  }
  return descendants
}

/**
 * Whether a matching process is this app's daemon rather than someone else's
 * agent-browser use on the same machine.
 *
 * A daemon inherits the socket directory and config path of whoever started it,
 * so on Linux its own environment is the answer. Where that is unreadable
 * (macOS), being a descendant of this process is the next best evidence.
 */
function isAppOwnedDaemon(row: ProcessRow, descendants: Set<number>, socketDir: string, configPath: string): boolean {
  try {
    const environment = readFileSync(`/proc/${row.pid}/environ`, 'utf8')
    return environment.includes(socketDir) || environment.includes(configPath)
  } catch {
    return descendants.has(row.pid)
  }
}

/**
 * Stop agent-browser daemons that belong to this app even when no pid sidecar
 * names them.
 *
 * A sidecar records the pid of the client that asked for the daemon; when that
 * client re-execs or the daemon detaches, the recorded pid is already gone while
 * the daemon lives on. Ownership is therefore checked against the daemon's own
 * process instead of against a pid file. Returns how many daemons it stopped.
 */
export async function stopAgentBrowserDaemonProcesses(socketDir: string, configPath: string): Promise<number> {
  const rows = await listProcesses()
  const matched = rows.filter((row) => row.pid !== process.pid && isAgentBrowserDaemonCommand(row.command))
  const descendants = descendantPids(rows, process.pid)
  const owned = matched.filter((row) => isAppOwnedDaemon(row, descendants, socketDir, configPath))
  console.log(
    `[agent-browser] daemon sweep: scanned=${rows.length} matched=${matched.length} owned=${owned.length}` +
      ` pids=${owned.map((row) => row.pid).join(',') || 'none'}`,
  )
  let stopped = 0
  for (const row of owned) {
    await forceStopDaemon(row.pid, 0)
    stopped += 1
  }
  return stopped
}

/**
 * Daemon directories this app can own, most specific first.
 *
 * The namespace composes with the socket directory, so a consumer that inherits
 * AGENT_BROWSER_SOCKET_DIR and one that only reads the config file resolve the
 * same namespace under different roots. The pre-namespace root stays in the list
 * so a daemon started by an earlier build is still reapable.
 */
function daemonRootsFor(socketDir: string): string[] {
  const roots = new Set<string>()
  roots.add(join(socketDir, 'namespaces', AGENT_BROWSER_DAEMON_NAMESPACE, 'run'))
  roots.add(socketDir)
  try {
    roots.add(join(app.getPath('home'), '.agent-browser', 'namespaces', AGENT_BROWSER_DAEMON_NAMESPACE, 'run'))
  } catch {
    // Ignore when home is unavailable
  }
  try {
    const candidate = join(app.getPath('userData'), 'agent-browser-runtime')
    roots.add(join(candidate, 'namespaces', AGENT_BROWSER_DAEMON_NAMESPACE, 'run'))
    roots.add(candidate)
  } catch {
    // Ignore when userData is unavailable
  }
  return [...roots]
}

async function daemonPidsFor(socketDir: string): Promise<number[]> {
  const pids = new Set<number>()
  for (const root of daemonRootsFor(socketDir)) {
    let entries: string[]
    try {
      entries = await fs.readdir(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.pid')) continue
      const pid = await readPidFile(join(root, entry))
      if (pid !== undefined) pids.add(pid)
    }
  }
  return [...pids]
}

async function readPidFile(pidPath: string): Promise<number | undefined> {
  try {
    const raw = await fs.readFile(pidPath, 'utf8')
    const pid = Number.parseInt(raw.trim(), 10)
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return undefined
    return pid
  } catch {
    return undefined
  }
}

async function forceStopDaemon(pid: number, graceMs: number): Promise<void> {
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return
    await sleep(50)
  }

  console.warn(`[agent-browser] daemon ${pid} did not exit after close; forcing cleanup`)
  if (process.platform === 'win32') {
    await new Promise<void>((resolvePromise) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      const done = (): void => resolvePromise()
      killer.once('error', done)
      killer.once('close', done)
    })
  } else {
    try { process.kill(pid, 'SIGTERM') } catch { return }
    await sleep(250)
    if (isProcessAlive(pid)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
    }
  }
}

/**
 * Force-stop every browser daemon this app can own, with no graceful close.
 *
 * Called after the app's services have finished shutting down: an engine or the
 * Harness runtime can still start a daemon while it stops, and a daemon that
 * outlives the Electron process holds inherited pipes open until its own idle
 * timeout. Returns how many daemons it had to stop.
 */
export async function stopAppOwnedBrowserDaemons(): Promise<number> {
  const socketDir = appBrowserSocketDir()
  let stopped = 0
  for (const pid of await daemonPidsFor(socketDir)) {
    if (!isProcessAlive(pid)) continue
    await forceStopDaemon(pid, 0)
    stopped += 1
  }
  stopped += await stopAgentBrowserDaemonProcesses(socketDir, appBrowserConfigPath())
  return stopped
}
