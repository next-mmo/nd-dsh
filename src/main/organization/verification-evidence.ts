import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { WorktreeGitRunner } from './task-worktree.js'

const execFileAsync = promisify(execFile)
const MAX_CAPTURE_CHARS = 32_000
const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1_000
const MAX_GIT_OUTPUT = 4 * 1024 * 1024
const MAX_ARTIFACT_COUNT = 1_000

export interface VerificationEvidence {
  status: 'passed' | 'failed' | 'skipped'
  command?: string
  cwd?: string
  startedAt: number
  completedAt: number
  durationMs: number
  exitCode?: number
  stdout?: string
  stderr?: string
  reason?: string
  artifacts?: Array<{ path: string; kind: 'file' | 'directory'; size: number; sha256: string }>
}

export interface VerificationProcessRuntime {
  spawnProcess: typeof spawn
  stopProcess(child: ChildProcess): Promise<void>
  /** Git for the checkpoint capture/restore around the command; nd-core `git.exec` in desktop production. */
  runGit?: WorktreeGitRunner
}

/** Artifact hashing is nd-core `workspace.fingerprint-artifacts` in desktop production. */
export type ArtifactFingerprintRunner = (
  root: string,
  paths: readonly string[],
) => Promise<NonNullable<VerificationEvidence['artifacts']>>

/**
 * Run the deterministic project check owned by ND. The reviewer may add
 * semantic judgment later, but it cannot turn a red machine check green.
 *
 * When verification runs inside an ND-owned task worktree, preserve the exact
 * checkpoint around the command. Test/build tools often create coverage,
 * caches, generated files, or other artifacts; none of those are allowed to
 * leak into review or the next retry attempt.
 */
export async function runVerification(command: string | undefined, cwd: string | undefined, runtime?: VerificationProcessRuntime): Promise<VerificationEvidence> {
  const startedAt = Date.now()
  const cleaned = command?.trim()
  if (!cleaned) return finish({ status: 'skipped', startedAt, reason: 'Project has no configured test command.' })
  if (!cwd) return finish({ status: 'failed', command: cleaned, startedAt, reason: 'Configured verification command has no project workspace.' })

  const runGit = runtime?.runGit ?? git
  let managedBaseline: string | undefined
  if (isManagedTaskWorktree(cwd)) {
    try {
      managedBaseline = await captureManagedBaseline(cwd, runGit)
    } catch (error) {
      return finish({ status: 'failed', command: cleaned, cwd, startedAt, reason: `Verification preflight failed: ${errorMessage(error)}` })
    }
  }

  const timeoutMs = verificationTimeoutMs()
  return new Promise<VerificationEvidence>((resolveEvidence) => {
    const invocation = verificationShell(cleaned)
    const spawnProcess = runtime?.spawnProcess ?? spawn
    const stopProcess = runtime?.stopProcess ?? stopVerificationProcess
    const child = spawnProcess(invocation.command, invocation.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
      windowsVerbatimArguments: process.platform === 'win32',
      detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const capture = (current: string, chunk: Buffer | string): string => `${current}${String(chunk)}`.slice(-MAX_CAPTURE_CHARS)
    const outputFields = (): Pick<VerificationEvidence, 'stdout' | 'stderr'> => {
      const cleanStdout = cleanOutput(stdout)
      const cleanStderr = cleanOutput(stderr)
      return {
        ...(cleanStdout ? { stdout: cleanStdout } : {}),
        ...(cleanStderr ? { stderr: cleanStderr } : {}),
      }
    }
    child.stdout?.on('data', (chunk) => { stdout = capture(stdout, chunk) })
    child.stderr?.on('data', (chunk) => { stderr = capture(stderr, chunk) })

    let timer: NodeJS.Timeout
    // Teardown of a timed-out process produces its own exit event, which would
    // otherwise win the race against the timeout branch and report the kill's
    // exit code as the reason the check failed.
    let timedOut = false
    const done = async (value: Omit<VerificationEvidence, 'completedAt' | 'durationMs'>): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let result = value
      if (managedBaseline) {
        try {
          await restoreManagedBaseline(cwd, managedBaseline, runGit)
        } catch (error) {
          result = {
            ...value,
            status: 'failed',
            reason: [value.reason, `Verification cleanup failed: ${errorMessage(error)}`].filter(Boolean).join(' '),
          }
        }
      }
      resolveEvidence(finish(result))
    }

    child.once('error', (error) => { void done({
      status: 'failed', command: cleaned, cwd, startedAt,
      ...outputFields(), reason: error.message,
    }) })
    child.once('exit', (code, signal) => { void done({
      status: code === 0 && !timedOut ? 'passed' : 'failed', command: cleaned, cwd, startedAt,
      ...(typeof code === 'number' ? { exitCode: code } : {}),
      ...outputFields(),
      ...(code === 0 && !timedOut ? {} : { reason: timedOut ? `Verification timed out after ${timeoutMs}ms.` : `Verification command exited ${signal ?? String(code ?? 'without a code')}.` }),
    }) })

    timer = setTimeout(() => {
      timedOut = true
      void stopProcess(child)
        .catch(() => undefined)
        .then(() => done({
          status: 'failed', command: cleaned, cwd, startedAt,
          ...outputFields(), reason: `Verification timed out after ${timeoutMs}ms.`,
        }))
    }, timeoutMs)
    timer.unref()
  })
}

function verificationShell(command: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      command: process.env.COMSPEC?.trim() || 'cmd.exe',
      // `cmd /d /s /c` strips one outer quote pair and runs the rest as-is, so
      // the command is pre-wrapped to keep inner quotes, pipes and `&&` chains
      // intact. Inner quotes must reach cmd.exe unescaped: the caller requests
      // verbatim argument delivery.
      args: ['/d', '/s', '/c', `"${command}"`],
    }
  }
  return { command: '/bin/sh', args: ['-c', command] }
}

async function stopVerificationProcess(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  if (process.platform === 'win32') {
    await new Promise<void>((resolveStop) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { child.kill() } catch { /* already gone */ }
        resolveStop()
      }
      const timer = setTimeout(finish, 3_000)
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
        killer.once('close', finish)
        killer.once('error', finish)
      } catch {
        finish()
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
  await new Promise<void>((resolveStop) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveStop()
    }
    const timer = setTimeout(() => {
      try {
        if (groupSignalled) process.kill(-pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch { /* already gone */ }
      finish()
    }, 3_000)
    child.once('exit', finish)
    child.once('error', finish)
  })
}

/**
 * Artifact tasks are verified by their declared evidence instead of the test
 * command: every path is fingerprinted by nd-core, and an unavailable, escaped,
 * or unwired fingerprinter fails the run closed.
 */
export async function runArtifactVerification(
  paths: string[] | undefined,
  cwd: string | undefined,
  fingerprintArtifacts?: ArtifactFingerprintRunner,
): Promise<VerificationEvidence> {
  const startedAt = Date.now()
  if (!cwd) return finish({ status: 'failed', startedAt, reason: 'Artifact verification has no project workspace.' })
  const requestedSet = new Set<string>()
  for (const value of paths ?? []) {
    const path = value.trim()
    if (path) requestedSet.add(path)
    if (requestedSet.size > MAX_ARTIFACT_COUNT) {
      return finish({ status: 'failed', cwd, startedAt, reason: `Artifact task exceeds the ${MAX_ARTIFACT_COUNT}-artifact evidence bound.` })
    }
  }
  const requested = [...requestedSet]
  if (!requested.length) return finish({ status: 'failed', cwd, startedAt, reason: 'Artifact task declared no artifact paths.' })
  const root = resolve(cwd)
  try {
    if (!fingerprintArtifacts) throw new Error('artifact fingerprinting requires ND Core')
    for (const requestedPath of requested) {
      if (isAbsolute(requestedPath)) throw new Error('Artifact path must be relative: ' + requestedPath)
      const rel = relative(root, resolve(root, requestedPath))
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Artifact path escapes the task workspace: ' + requestedPath)
    }
    const artifacts = await fingerprintArtifacts(root, requested)
    return finish({ status: 'passed', cwd, startedAt, artifacts })
  } catch (error) {
    return finish({ status: 'failed', cwd, startedAt, reason: `Artifact verification failed: ${errorMessage(error)}` })
  }
}

export function formatVerificationEvidence(evidence: VerificationEvidence): string {
  return `\n\n<nd-dsh-verification>${JSON.stringify(evidence)}</nd-dsh-verification>`
}

function isManagedTaskWorktree(cwd: string): boolean {
  return resolve(cwd).split(sep).includes('.nd-dsh-worktrees')
}

async function captureManagedBaseline(cwd: string, runGit: WorktreeGitRunner): Promise<string> {
  const [head, status] = await Promise.all([
    runGit(cwd, ['rev-parse', 'HEAD']),
    runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all']),
  ])
  if (status.stdout.trim()) throw new Error('ND task worktree is dirty before machine verification')
  const baseline = head.stdout.trim()
  if (!baseline) throw new Error('ND task worktree has no Git HEAD before machine verification')
  return baseline
}

async function restoreManagedBaseline(cwd: string, baseline: string, runGit: WorktreeGitRunner): Promise<void> {
  await runGit(cwd, ['reset', '--hard', baseline])
  await runGit(cwd, ['clean', '-fd', '--'])
  const [head, status] = await Promise.all([
    runGit(cwd, ['rev-parse', 'HEAD']),
    runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all']),
  ])
  if (head.stdout.trim() !== baseline || status.stdout.trim()) throw new Error('ND task worktree did not return to its verification checkpoint')
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT, windowsHide: true })
  return { stdout: result.stdout, stderr: result.stderr }
}

function verificationTimeoutMs(value = process.env.ND_DSH_VERIFY_TIMEOUT_MS): number {
  const parsed = value ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed)) return DEFAULT_VERIFY_TIMEOUT_MS
  return Math.max(30_000, Math.min(parsed, 30 * 60 * 1_000))
}

function finish(value: Omit<VerificationEvidence, 'completedAt' | 'durationMs'>): VerificationEvidence {
  const completedAt = Date.now()
  return { ...value, completedAt, durationMs: Math.max(0, completedAt - value.startedAt) }
}

function cleanOutput(value: string): string | undefined {
  const cleaned = value.trim()
  return cleaned || undefined
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const stderr = (error as { stderr?: unknown }).stderr
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim()
  }
  return error instanceof Error ? error.message : String(error)
}
