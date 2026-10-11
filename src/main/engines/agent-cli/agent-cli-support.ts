import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Shared plumbing for the direct CLI-agent engines (Claude Code, Cursor,
 * Pi). Each engine keeps its own session/protocol state; this module only
 * centralizes the pieces that must behave identically everywhere: deferred
 * turns, CLI spawn resolution for `.cmd`/`.bat` shims, result summarization,
 * and whole-tree child teardown.
 */

export const TRANSCRIPT_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'agent/reasoning', 'tool/call', 'tool/result'])
export const RESULT_SNIPPET_MAX_CHARS = 4_000

/** Minimal single-shot deferred: turns settle exactly once via notification. */
export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolveRef) => { resolve = resolveRef })
  return { promise, resolve }
}

/** The node entry a Windows `.cmd`/`.bat` shim forwards to, when it can be found. */
interface ShimTarget {
  command: string
  script: string
}

const SHIM_MAX_BYTES = 64 * 1024
const SHIM_SCRIPT_PATTERN = /"([^"\r\n]*?(?:%~dp0|%dp0%)[^"\r\n]*?\.(?:c?js|mjs))"/i

/**
 * Resolve what a Windows shim actually runs.
 *
 * npm/pnpm-style shims forward to a node script through `%dp0%`/`%~dp0`, and
 * `cmd.exe` is only ever on the path to do that forwarding. Reaching the script
 * directly removes `cmd.exe` from argument transport, which matters because
 * `cmd.exe` parses its command string line by line: a newline inside an argument
 * ends the command there, so the child receives only the first line and any
 * later text is parsed as further commands. Multi-line prompts are ND's normal
 * case, and the truncation was silent — the CLI reported success.
 *
 * Returns undefined for anything that does not look like a node shim, and the
 * caller falls back to the `cmd.exe` path.
 */
function resolveShimTarget(bin: string): ShimTarget | undefined {
  if (process.platform !== 'win32') return undefined
  let source: string
  try {
    source = readFileSync(bin, 'utf8')
  } catch {
    return undefined
  }
  if (source.length > SHIM_MAX_BYTES) return undefined
  const match = SHIM_SCRIPT_PATTERN.exec(source)
  if (!match) return undefined

  // `%~dp0` expands to the shim's own directory *including* a trailing separator.
  const dir = dirname(bin)
  const captured = match[1]
  if (!captured) return undefined
  const script = resolve(captured.replace(/%~dp0|%dp0%/i, `${dir}\\`))
  if (!existsSync(script)) return undefined

  // Mirror the shim's own interpreter choice: a node.exe shipped beside it wins,
  // otherwise a PATH `node`. `process.execPath` is Electron here and would need
  // ELECTRON_RUN_AS_NODE to behave as node, which is not what the shim does.
  const localNode = join(dir, 'node.exe')
  return { command: existsSync(localNode) ? localNode : 'node', script }
}

/**
 * Spawn a resolved CLI entry. npm-installed CLIs resolve to `.cmd`/`.bat`
 * shims on Windows, which Node refuses to spawn directly. A node shim is
 * resolved to its script and spawned without a shell. An unresolved shim may
 * use `cmd.exe /d /s /c` only for simple arguments; multi-line or shell-sensitive
 * arguments fail closed instead of being truncated or reinterpreted.
 */
export function spawnCliCommand(
  spawnProcess: typeof spawn,
  bin: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
): ChildProcess {
  // This is ND's background CLI boundary, including Windows shell shims.
  // Keep console policy here so a future caller cannot accidentally opt out.
  const backgroundOptions = { ...options, windowsHide: true }
  const shimmed = /\.(cmd|bat)$/i.test(bin)
  if (!shimmed) return spawnProcess(bin, args, backgroundOptions)
  const target = resolveShimTarget(bin)
  if (target) return spawnProcess(target.command, [target.script, ...args], backgroundOptions)
  if (args.some((part) => /[\r\n"&|<>^%!]/.test(part))) {
    throw new Error('Cannot safely pass multi-line or shell-sensitive arguments through unresolved Windows CLI shim: ' + bin)
  }
  const command = [bin, ...args].map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '""')}"` : part)).join(' ')
  return spawnProcess('cmd.exe', ['/d', '/s', '/c', command], { ...backgroundOptions, windowsVerbatimArguments: true })
}

export function summarize(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)
  const cleaned = (text ?? '').trim()
  if (cleaned.length <= RESULT_SNIPPET_MAX_CHARS) return cleaned
  return `${cleaned.slice(0, RESULT_SNIPPET_MAX_CHARS - 1)}…`
}

/** Terminate the whole child tree; SIGTERM first, then hard teardown. */
export async function killProcessTree(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { child.kill() } catch { /* Already gone. */ }
        resolve()
      }
      child.once('exit', finish)
      const timer = setTimeout(finish, 3_000)
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        killer.once('close', finish)
        killer.once('error', finish)
      } catch {
        // Already handled.
      }
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    })
    return
  }

  let groupSignalled = false
  try {
    process.kill(-pid, 'SIGTERM')
    groupSignalled = true
  } catch {
    try { child.kill('SIGTERM') } catch { return }
  }

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      try {
        if (groupSignalled) process.kill(-pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      finish()
    }, 3_000)
    child.once('exit', () => {
      if (!groupSignalled) {
        finish()
        return
      }
      try {
        process.kill(-pid, 0)
      } catch {
        finish()
      }
    })
  })
}

/**
 * Environment intentionally forwarded to user-installed coding CLIs.
 * ND control-plane variables and safeStorage provider credentials are not
 * injected here; vendor CLI auth already present in the user's OS environment
 * remains available to the CLI exactly as it was before the Rust migration.
 */
export function engineEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('ND_DSH_') || key.startsWith('DSH_')) continue
    environment[key] = value
  }
  return environment
}
