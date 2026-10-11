import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT = 24 * 1024 * 1024
const CHECKPOINT_EXCLUDED_PATHS = [
  ':(exclude,glob)**/node_modules/**',
  ':(exclude,glob)**/.pnpm-store/**',
  ':(exclude,glob)**/.npm-cache/**',
  ':(exclude,glob)**/dist/**',
  ':(exclude,glob)**/build/**',
  ':(exclude,glob)**/.next/**',
  ':(exclude,glob)**/.turbo/**',
  ':(exclude,glob)**/.cache/**',
  ':(exclude,glob)**/coverage/**',
]
const DISPOSABLE_DIRECTORY_NAMES = new Set([
  'node_modules', '.pnpm-store', '.npm-cache', 'dist', 'build', '.next',
  '.turbo', '.cache', 'coverage',
])

export interface TaskWorktree {
  root: string
  repoRoot: string
  branch: string
  taskId: string
}

export type WorktreeGitRunner = (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

export class TaskIntegrationConflictError extends Error {
  readonly code = 'task-integration-conflict'
}

export class TaskWorktreeManager {
  /**
   * Task worktrees ND created or recovered in this session. The engine router
   * uses this to tell ND's own isolated task checkouts apart from a foreign
   * project folder; nothing else is admitted by that check.
   */
  private readonly knownRoots = new Set<string>()

  constructor(private readonly runGit: WorktreeGitRunner = git) {}

  /** Whether ND owns this task worktree path for the current session. */
  ownsRoot(path: string): boolean {
    if (!path?.trim()) return false
    return this.knownRoots.has(normalizeRoot(path))
  }

  /**
   * Create or recover a deterministic worktree for a task. A new worktree is
   * created only from a clean base workspace so the branch cannot silently omit
   * local human changes. Existing task branches/worktrees remain recoverable
   * after restart even when the base later becomes dirty.
   *
   * A truly empty project directory is safe to bootstrap as a local Git repo.
   * This gives brand-new "idea -> app" projects a stable HEAD and exact review
   * evidence before the first worker writes source. Non-empty non-Git folders
   * are never initialized implicitly.
   */
  async ensure(projectWorkspace: string | undefined, taskId: string): Promise<TaskWorktree | undefined> {
    if (!projectWorkspace) return undefined
    const repoRoot = await repositoryRoot(projectWorkspace, this.runGit).catch(() => bootstrapEmptyRepository(projectWorkspace, this.runGit))
    if (!repoRoot) return undefined
    const descriptor = describe(repoRoot, taskId)
    if (await isAttachedWorktree(descriptor.root, this.runGit)) {
      this.knownRoots.add(normalizeRoot(descriptor.root))
      return descriptor
    }

    await fs.mkdir(dirname(descriptor.root), { recursive: true })
    if (await pathExists(descriptor.root)) {
      throw new Error(`ND task worktree path already exists but is not a Git worktree: ${descriptor.root}`)
    }

    await this.runGit(repoRoot, ['worktree', 'prune'])
    if (await branchExists(repoRoot, descriptor.branch, this.runGit)) {
      await this.runGit(repoRoot, ['worktree', 'add', descriptor.root, descriptor.branch])
      this.knownRoots.add(normalizeRoot(descriptor.root))
      return descriptor
    }

    const status = await this.runGit(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
    if (status.stdout.trim()) return undefined
    await this.runGit(repoRoot, ['worktree', 'add', '-b', descriptor.branch, descriptor.root, 'HEAD'])
    this.knownRoots.add(normalizeRoot(descriptor.root))
    return descriptor
  }

  async existing(projectWorkspace: string | undefined, taskId: string): Promise<TaskWorktree | undefined> {
    if (!projectWorkspace) return undefined
    const repoRoot = await repositoryRoot(projectWorkspace, this.runGit).catch(() => undefined)
    if (!repoRoot) return undefined
    const descriptor = describe(repoRoot, taskId)
    if (!await isAttachedWorktree(descriptor.root, this.runGit)) return undefined
    this.knownRoots.add(normalizeRoot(descriptor.root))
    return descriptor
  }

  /**
   * Record the exact clean HEAD before one execution attempt. Retry/failover is
   * allowed only from this boundary, never on top of unknown partial writes.
   */
  async baseline(worktree: TaskWorktree): Promise<string> {
    await removeDisposableArtifacts(worktree.root)
    const status = await this.runGit(worktree.root, ['status', '--porcelain=v1', '--untracked-files=all'])
    if (status.stdout.trim()) {
      throw new Error('Task worktree is dirty before execution attempt; refusing to create an unsafe retry boundary')
    }
    return (await this.runGit(worktree.root, ['rev-parse', 'HEAD'])).stdout.trim()
  }

  /** Restore only the ND-owned task worktree to its pre-attempt boundary. */
  async rollback(worktree: TaskWorktree, expectedHead: string): Promise<void> {
    await this.runGit(worktree.root, ['reset', '--hard', expectedHead])
    await this.runGit(worktree.root, ['clean', '-fd', '--'])
    const [head, status] = await Promise.all([
      this.runGit(worktree.root, ['rev-parse', 'HEAD']),
      this.runGit(worktree.root, ['status', '--porcelain=v1', '--untracked-files=all']),
    ])
    if (head.stdout.trim() !== expectedHead || status.stdout.trim()) {
      throw new Error('Task worktree could not be restored to its execution-attempt baseline')
    }
  }

  /** Freeze the worker result into the task branch before independent review. */
  async checkpoint(worktree: TaskWorktree, title: string): Promise<string> {
    const status = await this.runGit(worktree.root, ['status', '--porcelain=v1', '--untracked-files=all'])
    if (status.stdout.trim()) {
      // A failed earlier add/commit may have left a partial index behind.
      // The task worktree is ND-owned, so restage the current files from the
      // working tree instead of carrying stale cache entries into a retry.
      await this.runGit(worktree.root, ['reset', '--'])
      await this.runGit(worktree.root, ['add', '-A', '--', '.', ...CHECKPOINT_EXCLUDED_PATHS])
      const staged = await this.runGit(worktree.root, ['diff', '--cached', '--name-only'])
      if (staged.stdout.trim()) {
        await this.runGit(worktree.root, [
          '-c', 'user.name=ND-DSH',
          '-c', 'user.email=nd-dsh@local',
          'commit', '-m', `nd-dsh: ${title.slice(0, 120)}`,
        ])
      }
    }
    await removeDisposableArtifacts(worktree.root)
    return (await this.runGit(worktree.root, ['rev-parse', 'HEAD'])).stdout.trim()
  }

  async assertUnchanged(worktree: TaskWorktree, expectedHead: string): Promise<void> {
    await removeDisposableArtifacts(worktree.root)
    const [status, head] = await Promise.all([
      this.runGit(worktree.root, ['status', '--porcelain=v1', '--untracked-files=all']),
      this.runGit(worktree.root, ['rev-parse', 'HEAD']),
    ])
    if (status.stdout.trim()) throw new Error('Reviewer/tooling changed the task worktree after the review checkpoint')
    if (head.stdout.trim() !== expectedHead) throw new Error('Task worktree HEAD changed after independent review started')
  }

  /**
   * Merge a verified task branch into the project's real checkout. Never
   * auto-resolve conflicts and never merge over human/uncommitted base changes.
   */
  async integrate(projectWorkspace: string | undefined, taskId: string): Promise<{ merged: boolean; head: string }> {
    if (!projectWorkspace) throw new Error('Task integration requires a project workspace')
    const repoRoot = await repositoryRoot(projectWorkspace, this.runGit)
    const descriptor = describe(repoRoot, taskId)
    if (!(await branchExists(repoRoot, descriptor.branch, this.runGit))) {
      throw new Error(`Task branch ${descriptor.branch} is missing; cannot integrate verified work`)
    }
    const taskStatus = await this.runGit(descriptor.root, ['status', '--porcelain=v1', '--untracked-files=all']).catch(() => undefined)
    if (!taskStatus || taskStatus.stdout.trim()) throw new Error('Task worktree changed after its review checkpoint; re-run review before integration')

    const baseStatus = await this.runGit(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
    if (baseStatus.stdout.trim()) throw new Error('Project workspace has uncommitted human/local changes; integration is paused instead of overwriting them')

    const alreadyMerged = await isAncestor(repoRoot, descriptor.branch, 'HEAD', this.runGit)
    if (alreadyMerged) return { merged: false, head: (await this.runGit(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim() }

    try {
      await this.runGit(repoRoot, [
        '-c', 'user.name=ND-DSH',
        '-c', 'user.email=nd-dsh@local',
        'merge', '--no-ff', '--no-edit', descriptor.branch,
      ])
    } catch (error) {
      await this.runGit(repoRoot, ['merge', '--abort']).catch(() => undefined)
      throw new TaskIntegrationConflictError(`Task integration conflict for ${taskId}; ND left the task branch intact. Rebase or re-plan this task against the current base before another execution attempt. ${errorMessage(error)}`)
    }
    return { merged: true, head: (await this.runGit(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim() }
  }

  path(projectWorkspace: string, taskId: string): Promise<string | undefined> {
    return repositoryRoot(projectWorkspace, this.runGit)
      .then((repoRoot) => describe(repoRoot, taskId).root)
      .catch(() => undefined)
  }
}

/**
 * Dependency managers and build tools commonly write caches into the project
 * directory. They are never part of a task checkpoint and must not make an
 * otherwise clean ND-owned worktree look modified during review or rework.
 */
async function removeDisposableArtifacts(root: string): Promise<void> {
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === '.git' || entry.isSymbolicLink()) continue
      const candidate = join(directory, entry.name)
      if (entry.isDirectory() && DISPOSABLE_DIRECTORY_NAMES.has(entry.name)) {
        await fs.rm(candidate, { recursive: true, force: true })
        continue
      }
      if (entry.isDirectory()) await visit(candidate)
    }
  }
  await visit(root)
}

function describe(repoRoot: string, taskId: string): TaskWorktree {
  const repoKey = createHash('sha256').update(resolve(repoRoot)).digest('hex').slice(0, 12)
  const taskKey = safeTaskKey(taskId)
  return {
    repoRoot,
    taskId,
    branch: `nd-dsh/task-${taskKey}`,
    root: join(dirname(repoRoot), '.nd-dsh-worktrees', repoKey, taskKey),
  }
}

function safeTaskKey(taskId: string): string {
  const readable = taskId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'task'
  const digest = createHash('sha256').update(taskId).digest('hex').slice(0, 8)
  return `${readable}-${digest}`
}

/** Worktree paths are compared case-insensitively on Windows, like the filesystem. */
function normalizeRoot(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function repositoryRoot(cwd: string, runGit: WorktreeGitRunner = git): Promise<string> {
  return resolve((await runGit(resolve(cwd), ['rev-parse', '--show-toplevel'])).stdout.trim())
}

async function bootstrapEmptyRepository(cwd: string, runGit: WorktreeGitRunner = git): Promise<string | undefined> {
  const root = resolve(cwd)
  try {
    const entries = await fs.readdir(root)
    if (entries.length !== 0) return undefined
    await runGit(root, ['init'])
    await runGit(root, [
      '-c', 'user.name=ND-DSH',
      '-c', 'user.email=nd-dsh@local',
      'commit', '--allow-empty', '-m', 'nd-dsh: initialize project workspace',
    ])
    return repositoryRoot(root, runGit)
  } catch {
    return undefined
  }
}

async function isAttachedWorktree(path: string, runGit: WorktreeGitRunner = git): Promise<boolean> {
  if (!(await pathExists(path))) return false
  try {
    const root = resolve((await runGit(path, ['rev-parse', '--show-toplevel'])).stdout.trim())
    return root === resolve(path)
  } catch {
    return false
  }
}

async function branchExists(repoRoot: string, branch: string, runGit: WorktreeGitRunner = git): Promise<boolean> {
  try {
    await runGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

async function isAncestor(repoRoot: string, ancestor: string, descendant: string, runGit: WorktreeGitRunner = git): Promise<boolean> {
  try {
    await runGit(repoRoot, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await fs.stat(path); return true } catch { return false }
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT, windowsHide: true })
  return { stdout: result.stdout, stderr: result.stderr }
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const stderr = (error as { stderr?: unknown }).stderr
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim()
  }
  return error instanceof Error ? error.message : String(error)
}
