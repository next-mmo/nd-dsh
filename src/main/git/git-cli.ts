/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  Derived from microsoft/vscode extensions/git (MIT), pinned in vendor/vscode-git.json.
 *  Adapted for ND-DSH: VS Code API dependencies removed, ND house style applied.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process'
import process from 'node:process'
import type { CoreClient } from '../core/core-client.js'
import { isNdCoreDeadlineError } from '../core/core-protocol.js'

export const GitErrorCodes = {
  DeadlineExceeded: 'DeadlineExceeded',
  BadConfigFile: 'BadConfigFile',
  AuthenticationFailed: 'AuthenticationFailed',
  NotAGitRepository: 'NotAGitRepository',
  CantCreatePipe: 'CantCreatePipe',
  RepositoryNotFound: 'RepositoryNotFound',
  CantAccessRemote: 'CantAccessRemote',
  BranchNotFullyMerged: 'BranchNotFullyMerged',
  NoRemoteReference: 'NoRemoteReference',
  BranchAlreadyExists: 'BranchAlreadyExists',
  InvalidBranchName: 'InvalidBranchName',
  DirtyWorkTree: 'DirtyWorkTree',
  NotASafeGitRepository: 'NotASafeGitRepository',
  WorktreeContainsChanges: 'WorktreeContainsChanges',
  WorktreeAlreadyExists: 'WorktreeAlreadyExists',
  WorktreeBranchAlreadyUsed: 'WorktreeBranchAlreadyUsed',
  RepositoryIsLocked: 'RepositoryIsLocked',
  NoStagedChanges: 'NoStagedChanges',
  NoUnstagedChanges: 'NoUnstagedChanges',
} as const

export interface IGitErrorData {
  error?: Error | undefined
  message?: string | undefined
  stdout?: string | undefined
  stderr?: string | undefined
  exitCode?: number | undefined
  gitErrorCode?: string | undefined
  gitCommand?: string | undefined
  gitArgs?: string[] | undefined
}

export class GitError extends Error {
  error: Error | undefined
  stdout: string | undefined
  stderr: string | undefined
  exitCode: number | undefined
  gitErrorCode: string | undefined
  gitCommand: string | undefined
  gitArgs: string[] | undefined

  constructor(data: IGitErrorData) {
    super(data.error?.message || data.message || 'Git error')

    this.error = data.error
    this.stdout = data.stdout
    this.stderr = data.stderr
    this.exitCode = data.exitCode
    this.gitErrorCode = data.gitErrorCode
    this.gitCommand = data.gitCommand
    this.gitArgs = data.gitArgs
  }

  override toString(): string {
    let result = this.message + ' ' + JSON.stringify({
      exitCode: this.exitCode,
      gitErrorCode: this.gitErrorCode,
      gitCommand: this.gitCommand,
      stdout: this.stdout,
      stderr: this.stderr,
    }, null, 2)

    if (this.error?.stack) {
      result += this.error.stack
    }

    return result
  }
}

export function getGitErrorCode(stderr: string): string | undefined {
  if (/Another git process seems to be running in this repository|If no other git process is currently running/.test(stderr)) {
    return GitErrorCodes.RepositoryIsLocked
  } else if (/Authentication failed/i.test(stderr)) {
    return GitErrorCodes.AuthenticationFailed
  } else if (/Not a git repository/i.test(stderr)) {
    return GitErrorCodes.NotAGitRepository
  } else if (/bad config file/.test(stderr)) {
    return GitErrorCodes.BadConfigFile
  } else if (/cannot make pipe for command substitution|cannot create standard input pipe/.test(stderr)) {
    return GitErrorCodes.CantCreatePipe
  } else if (/Repository not found/.test(stderr)) {
    return GitErrorCodes.RepositoryNotFound
  } else if (/unable to access/.test(stderr)) {
    return GitErrorCodes.CantAccessRemote
  } else if (/branch '.+' is not fully merged/.test(stderr)) {
    return GitErrorCodes.BranchNotFullyMerged
  } else if (/Couldn\'t find remote ref/.test(stderr)) {
    return GitErrorCodes.NoRemoteReference
  } else if (/A branch named '.+' already exists/.test(stderr)) {
    return GitErrorCodes.BranchAlreadyExists
  } else if (/'.+' is not a valid branch name/.test(stderr)) {
    return GitErrorCodes.InvalidBranchName
  } else if (/Please,? commit your changes or stash them/.test(stderr)) {
    return GitErrorCodes.DirtyWorkTree
  } else if (/detected dubious ownership in repository at/.test(stderr)) {
    return GitErrorCodes.NotASafeGitRepository
  } else if (/contains modified or untracked files|use --force to delete it/.test(stderr)) {
    return GitErrorCodes.WorktreeContainsChanges
  } else if (/fatal: '[^']+' already exists/.test(stderr)) {
    return GitErrorCodes.WorktreeAlreadyExists
  } else if (/is already used by worktree at/.test(stderr)) {
    return GitErrorCodes.WorktreeBranchAlreadyUsed
  }
  return undefined
}

// https://github.com/microsoft/vscode/issues/89373
// https://github.com/git-for-windows/git/issues/2478
function sanitizePath(path: string): string {
  return path.replace(/^([a-z]):\\/i, (_, letter) => `${letter.toUpperCase()}:\\`)
}

export function sanitizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/')
}

/** Longest argv length git accepts before paths must be split into chunks (upstream MAX_CLI_LENGTH). */
export const MAX_CLI_LENGTH = 30000

export function* splitInChunks(array: string[], maxChunkLength: number): IterableIterator<string[]> {
  let current: string[] = []
  let length = 0

  for (const value of array) {
    let newLength = length + value.length

    if (newLength > maxChunkLength && current.length > 0) {
      yield current
      current = []
      newLength = value.length
    }

    current.push(value)
    length = newLength
  }

  if (current.length > 0) {
    yield current
  }
}

export interface IFileStatus {
  x: string
  y: string
  path: string
  rename: string | undefined
}

export interface GitExecutionResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * The nd-core-backed Git execution surface non-GitService subsystems route
 * through, so a clone, provenance probe, or revision read is executed and
 * bounded by Rust exactly like the rest of ND's Git work.
 */
export type GitExecRunner = (
  cwd: string,
  args: string[],
  options?: GitExecOptions,
) => Promise<GitExecutionResult>

/**
 * Test-only seam. Desktop production always passes a real runner (a `GitCli`
 * bound to `git.exec`); this raw execFile runner exists solely so suites that
 * have no nd-core sidecar can exercise the pipelines that receive one. It
 * deliberately mirrors the core path's observable contract: reject on a
 * non-zero exit, and never prompt for credentials.
 */
export const rawGitExecRunner: GitExecRunner = async (cwd, args, options = {}) => {
  return await new Promise<GitExecutionResult>((resolve, reject) => {
    const child = execFile('git', args, {
      cwd,
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: 24 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
    }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve({ exitCode: 0, stdout: stdout.toString(), stderr: stderr.toString() })
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}

export interface ParsedGitCommit {
  hash: string
  message: string
  authorName: string
  authorEmail: string
  authorTimestamp: number
}

interface CoreGitParsedResult {
  exitCode: number
  stderr: string
  durationMs: number
  truncated: boolean
  /** Whether nd-core served this from its revision-keyed cache. */
  cached?: boolean
  /** The revision marker the response describes, when nd-core reported one. */
  revision?: string
}

export interface GitExecOptions {
  input?: string
  env?: Record<string, string>
  timeoutMs?: number
}

export interface GitCliOptions {
  /** Absolute path or binary name; defaults to ND_DSH_GIT_BINARY or `git` on PATH. */
  gitPath?: string
  env?: Record<string, string>
  /** nd-core owns Git process execution and porcelain/log parsing. */
  core: Pick<CoreClient, 'request'>
  onOutput?(output: string): void
}

export class GitCli {
  readonly path: string
  private readonly extraEnv: Record<string, string>
  private readonly core: Pick<CoreClient, 'request'>
  private readonly onOutput: ((output: string) => void) | undefined

  constructor(options: GitCliOptions) {
    this.path = options.gitPath ?? process.env.ND_DSH_GIT_BINARY ?? 'git'
    this.core = options.core
    this.onOutput = options.onOutput
    this.extraEnv = {
      LANGUAGE: 'en',
      LC_ALL: 'en_US.UTF-8',
      LANG: 'en_US.UTF-8',
      GIT_PAGER: 'cat',
      // Fail closed instead of hanging on credential prompts; upstream spawns an
      // askpass helper process, ND surfaces the authentication error instead.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
      SSH_ASKPASS: 'echo',
      ...options.env,
    }
  }

  async getRepositoryRoot(pathInsidePossibleRepository: string): Promise<string> {
    const result = await this.exec(pathInsidePossibleRepository, ['rev-parse', '--show-toplevel'])
    return result.stdout.trim()
  }

  async exec(cwd: string, args: string[], options: GitExecOptions = {}): Promise<GitExecutionResult> {
    const startedAt = Date.now()
    const buffered = await this.execCore(cwd, args, options)

    if (this.onOutput) {
      this.onOutput(`> git ${args.join(' ')} [${Date.now() - startedAt}ms]\n`)
      if (buffered.stderr.length > 0) this.onOutput(`${buffered.stderr}\n`)
    }

    if (buffered.exitCode !== 0) {
      throw new GitError({
        message: 'Failed to execute git',
        stdout: buffered.stdout,
        stderr: buffered.stderr,
        exitCode: buffered.exitCode,
        gitErrorCode: getGitErrorCode(buffered.stderr),
        gitCommand: args[0],
        gitArgs: args.slice(1),
      })
    }

    return buffered
  }

  private async execCore(cwd: string, args: string[], options: GitExecOptions): Promise<GitExecutionResult> {
    const timeoutMs = options.timeoutMs ?? 60_000
    // nd-core stops at this deadline and answers with `deadline_exceeded`; the
    // client's own tolerance is only the later backstop for a sidecar that stopped
    // answering. An expired command can no longer keep mutating the worktree in
    // Rust while the caller believes it failed.
    const result = await this.core.request<GitExecutionResult & { truncated?: boolean }>('git.exec', {
      cwd: sanitizePath(cwd),
      args,
      ...(options.input === undefined ? {} : { input: options.input }),
      env: { ...this.extraEnv, ...options.env },
      gitPath: this.path,
      maxOutputBytes: 24 * 1024 * 1024,
    }, timeoutMs).catch((error: unknown) => {
      // The core stopped this command at its deadline. Reporting it as a Git failure
      // with its own code is what lets the caller say "timed out" rather than show a
      // bare failure string, and it is also why the work is known to have stopped.
      if (isNdCoreDeadlineError(error)) {
        throw new GitError({
          message: 'Git command exceeded its deadline',
          gitErrorCode: GitErrorCodes.DeadlineExceeded,
          gitCommand: args[0],
          gitArgs: args.slice(1),
        })
      }
      throw error
    })
    if (result.truncated) throw new Error('Git output exceeded the ND Core safety bound.')
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }

  status(cwd: string): Promise<GitExecutionResult> {
    return this.exec(cwd, ['status', '-z', '-uall'], { env: { GIT_OPTIONAL_LOCKS: '0' } })
  }

  async statusEntries(cwd: string): Promise<IFileStatus[]> {
    const startedAt = Date.now()
    const result = await this.core.request<CoreGitParsedResult & { entries: IFileStatus[] }>('git.status', {
      cwd: sanitizePath(cwd),
      env: { ...this.extraEnv, GIT_OPTIONAL_LOCKS: '0' },
      gitPath: this.path,
    }, 60_000)
    this.finishParsedCoreCommand(['status', '-z', '-uall'], result, startedAt)
    return result.entries
  }

  async logEntries(cwd: string, limit: number): Promise<ParsedGitCommit[]> {
    const startedAt = Date.now()
    const result = await this.core.request<CoreGitParsedResult & { commits: ParsedGitCommit[] }>('git.log', {
      cwd: sanitizePath(cwd),
      limit,
      env: this.extraEnv,
      gitPath: this.path,
    }, 60_000)
    this.finishParsedCoreCommand(['log', `-n${limit}`], result, startedAt)
    return result.commits
  }

  private finishParsedCoreCommand(args: string[], result: CoreGitParsedResult, startedAt: number): void {
    if (this.onOutput) {
      // A served response is labelled rather than passed off as freshly computed:
      // the command log distinguishes a cache hit, and a caller reading the log can
      // see which revision the reply described.
      const served = result.cached ? ' cached' : ''
      this.onOutput(`> git ${args.join(' ')} [${Date.now() - startedAt}ms${served}]\n`)
      if (result.stderr.length > 0) this.onOutput(`${result.stderr}\n`)
    }
    if (result.truncated) throw new Error('Git output exceeded the ND Core safety bound.')
    if (result.exitCode !== 0) {
      throw new GitError({
        message: 'Failed to execute git',
        stderr: result.stderr,
        exitCode: result.exitCode,
        gitErrorCode: getGitErrorCode(result.stderr),
        gitCommand: args[0],
        gitArgs: args.slice(1),
      })
    }
  }

}
