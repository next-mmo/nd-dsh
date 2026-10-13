import { execFile } from 'node:child_process'
import { promises as fsPromises } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeDisposableArtifacts, TaskIntegrationConflictError, TaskWorktreeManager } from '../src/main/organization/task-worktree.js'

const exec = promisify(execFile)
const temporary: string[] = []

afterEach(async () => {
  // Git/AV handles can be released slightly after child exit on Windows.
  // Retry only transient recursive-rm failures, matching the repository's other
  // Windows-heavy test teardowns instead of turning a cleanup race into a red gate.
  await Promise.all(temporary.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  })))
})

async function repoFixture(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'nd-worktree-'))
  temporary.push(parent)
  const repo = join(parent, 'repo')
  await exec('git', ['init', repo])
  await exec('git', ['config', 'user.email', 'nd@example.test'], { cwd: repo })
  await exec('git', ['config', 'user.name', 'ND Test'], { cwd: repo })
  await writeFile(join(repo, 'app.ts'), 'export const value = 1\n')
  await exec('git', ['add', 'app.ts'], { cwd: repo })
  await exec('git', ['commit', '-m', 'initial'], { cwd: repo })
  return repo
}

describe('TaskWorktreeManager', () => {
  it('isolates task edits, checkpoints them, and merges only after integration', async () => {
    const repo = await repoFixture()
    const manager = new TaskWorktreeManager()
    const worktree = await manager.ensure(repo, 'task-1')
    expect(worktree).toBeTruthy()
    if (!worktree) return

    await writeFile(join(worktree.root, 'app.ts'), 'export const value = 2\n')
    expect(await readFile(join(repo, 'app.ts'), 'utf8')).toContain('value = 1')
    await manager.checkpoint(worktree, 'Update app')
    expect((await manager.existing(repo, 'task-1'))?.root).toBe(worktree.root)

    const integrated = await manager.integrate(repo, 'task-1')
    expect(integrated.merged).toBe(true)
    expect(await readFile(join(repo, 'app.ts'), 'utf8')).toContain('value = 2')
    expect((await exec('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim()).toBe('')
  }, 15_000)

  it('bootstraps a truly empty project workspace into Git before first task isolation', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'nd-empty-workspace-'))
    temporary.push(parent)
    const workspace = join(parent, 'project')
    await mkdir(workspace)

    const manager = new TaskWorktreeManager()
    const worktree = await manager.ensure(workspace, 'first-task')
    expect(worktree).toBeTruthy()
    if (!worktree) return

    expect((await exec('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim()).toBeTruthy()
    await writeFile(join(worktree.root, 'app.ts'), 'export const ready = true\n')
    await manager.checkpoint(worktree, 'Bootstrap app')
    expect((await manager.existing(workspace, 'first-task'))?.root).toBe(worktree.root)

    await manager.integrate(workspace, 'first-task')
    expect(await readFile(join(workspace, 'app.ts'), 'utf8')).toContain('ready = true')
  })

  it('keeps five independent writable tasks rollbackable without touching peers or the base checkout', async () => {
    const repo = await repoFixture()
    const manager = new TaskWorktreeManager()
    const worktrees = []

    for (let index = 1; index <= 5; index += 1) {
      const worktree = await manager.ensure(repo, `parallel-task-${index}`)
      expect(worktree).toBeTruthy()
      if (!worktree) return
      worktrees.push(worktree)
    }

    expect(new Set(worktrees.map((item) => item.root)).size).toBe(5)
    expect(new Set(worktrees.map((item) => item.branch)).size).toBe(5)

    const baselines = await Promise.all(worktrees.map((item) => manager.baseline(item)))
    for (let index = 0; index < worktrees.length; index += 1) {
      await writeFile(join(worktrees[index]!.root, `task-${index + 1}.txt`), `task ${index + 1}\n`)
    }

    await manager.rollback(worktrees[2]!, baselines[2]!)

    await expect(readFile(join(worktrees[2]!.root, 'task-3.txt'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(worktrees[0]!.root, 'task-1.txt'), 'utf8')).toBe('task 1\n')
    expect(await readFile(join(worktrees[4]!.root, 'task-5.txt'), 'utf8')).toBe('task 5\n')
    await expect(readFile(join(repo, 'task-1.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(repo, 'task-5.txt'), 'utf8')).rejects.toThrow()
    expect((await exec('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim()).toBe('')
  })

  it('does not checkpoint dependency, build, or package-manager caches', async () => {
    const repo = await repoFixture()
    const manager = new TaskWorktreeManager()
    const worktree = await manager.ensure(repo, 'task-artifacts')
    expect(worktree).toBeTruthy()
    if (!worktree) return

    await mkdir(join(worktree.root, 'node_modules', 'demo'), { recursive: true })
    await mkdir(join(worktree.root, '.pnpm-store', 'v10'), { recursive: true })
    await mkdir(join(worktree.root, '.npm-cache', '_cacache'), { recursive: true })
    await mkdir(join(worktree.root, 'dist'), { recursive: true })
    await writeFile(join(worktree.root, 'node_modules', 'demo', 'index.js'), 'module.exports = 1\n')
    await writeFile(join(worktree.root, '.pnpm-store', 'v10', 'index.json'), '{}\n')
    await writeFile(join(worktree.root, '.npm-cache', '_cacache', 'index-v5'), 'cache\n')
    await writeFile(join(worktree.root, 'dist', 'bundle.js'), 'generated\n')
    await writeFile(join(worktree.root, 'app.ts'), 'export const value = 2\n')

    await manager.checkpoint(worktree, 'Checkpoint source only')
    const tracked = (await exec('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: worktree.root })).stdout
    const clean = (await exec('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: worktree.root })).stdout
    expect(tracked).toContain('app.ts')
    expect(tracked).not.toContain('node_modules/')
    expect(tracked).not.toContain('.pnpm-store/')
    expect(tracked).not.toContain('.npm-cache/')
    expect(tracked).not.toContain('dist/')
    expect(clean).toBe('')
  })

  it('does not create a new task branch from a dirty human workspace', async () => {
    const repo = await repoFixture()
    const manager = new TaskWorktreeManager()
    await writeFile(join(repo, 'human.txt'), 'unsaved human work\n')
    expect(await manager.ensure(repo, 'task-dirty')).toBeUndefined()
  })

  it('fails closed on integration conflict and keeps the task worktree intact', async () => {
    const repo = await repoFixture()
    const manager = new TaskWorktreeManager()
    const worktree = await manager.ensure(repo, 'task-conflict')
    expect(worktree).toBeTruthy()
    if (!worktree) return

    await writeFile(join(worktree.root, 'app.ts'), 'export const value = "task"\n')
    await manager.checkpoint(worktree, 'Task branch')

    await writeFile(join(repo, 'app.ts'), 'export const value = "human-main"\n')
    await exec('git', ['add', 'app.ts'], { cwd: repo })
    await exec('git', ['commit', '-m', 'main change'], { cwd: repo })

    await expect(manager.integrate(repo, 'task-conflict')).rejects.toBeInstanceOf(TaskIntegrationConflictError)
    expect(await readFile(join(worktree.root, 'app.ts'), 'utf8')).toContain('"task"')
    expect((await exec('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim()).toBe('')
  })

  it('preserves tracked files inside directories matching disposable names like vendor/vscode-git/build/update-emoji.js', async () => {
    const repo = await repoFixture()
    const trackedSubdir = join(repo, 'vendor', 'vscode-git', 'build')
    await mkdir(trackedSubdir, { recursive: true })
    const emojiScript = join(trackedSubdir, 'update-emoji.js')
    await writeFile(emojiScript, 'console.log("emoji")\n')
    await exec('git', ['add', 'vendor/vscode-git/build/update-emoji.js'], { cwd: repo })
    await exec('git', ['commit', '-m', 'add emoji script'], { cwd: repo })

    const manager = new TaskWorktreeManager()
    const worktree = await manager.ensure(repo, 'preserve-tracked-build')
    expect(worktree).toBeTruthy()
    if (!worktree) return

    // Create an untracked disposable directory to ensure disposable cleanup still works
    await mkdir(join(worktree.root, 'dist'), { recursive: true })
    await writeFile(join(worktree.root, 'dist', 'bundle.js'), 'bundle\n')

    // Baseline establishes retry boundary; prior to fix this deleted vendor/vscode-git/build/update-emoji.js
    const head = await manager.baseline(worktree)
    expect(head).toBeTruthy()

    // Tracked file must still exist and be intact
    expect(await readFile(join(worktree.root, 'vendor', 'vscode-git', 'build', 'update-emoji.js'), 'utf8')).toBe('console.log("emoji")\n')
    // Untracked disposable directory should be removed
    await expect(readFile(join(worktree.root, 'dist', 'bundle.js'))).rejects.toThrow()

    // Git status in worktree must remain clean
    const status = (await exec('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: worktree.root })).stdout.trim()
    expect(status).toBe('')
  })

  it('propagates failure and fails closed when git ls-files fails during cleanup', async () => {
    const repo = await repoFixture()
    const failingGit = async (_cwd: string, args: string[]) => {
      if (args[0] === 'ls-files') {
        throw new Error('git ls-files failed: simulated error')
      }
      return { stdout: '', stderr: '' }
    }

    await expect(removeDisposableArtifacts(repo, failingGit)).rejects.toThrow('git ls-files failed: simulated error')

    const manager = new TaskWorktreeManager(failingGit)
    const worktree = { root: repo, repoRoot: repo, branch: 'test-branch', taskId: 'test-task' }
    await expect(manager.baseline(worktree)).rejects.toThrow('git ls-files failed: simulated error')
  })

  it('skips nested directories with their own .git marker and preserves their contents', async () => {
    const repo = await repoFixture()
    const manager = new TaskWorktreeManager()
    const worktree = await manager.ensure(repo, 'preserve-nested-repo')
    expect(worktree).toBeTruthy()
    if (!worktree) return

    // 1. Nested repository/submodule under vendor/sub-module with its own .git file marker
    const nestedSub = join(worktree.root, 'vendor', 'sub-module')
    await mkdir(join(nestedSub, 'dist'), { recursive: true })
    await mkdir(join(nestedSub, 'build'), { recursive: true })
    await writeFile(join(nestedSub, '.git'), 'gitdir: ../../.git/modules/vendor/sub-module\n')
    await writeFile(join(nestedSub, 'dist', 'bundle.js'), 'export const subBundle = true\n')
    await writeFile(join(nestedSub, 'build', 'artifact.js'), 'export const subArtifact = true\n')

    // 2. Nested repo whose directory itself matches a disposable name (e.g. build)
    const nestedBuild = join(worktree.root, 'build')
    await mkdir(nestedBuild, { recursive: true })
    await writeFile(join(nestedBuild, '.git'), 'gitdir: ../.git/modules/build\n')
    await writeFile(join(nestedBuild, 'output.js'), 'export const buildRepo = true\n')

    // 3. Normal untracked disposable directories that should be removed
    await mkdir(join(worktree.root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(worktree.root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    await mkdir(join(worktree.root, 'dist'), { recursive: true })
    await writeFile(join(worktree.root, 'dist', 'app.js'), 'bundle\n')

    await removeDisposableArtifacts(worktree.root)

    // Nested repo and its contents must still be completely intact
    expect(await readFile(join(nestedSub, 'dist', 'bundle.js'), 'utf8')).toBe('export const subBundle = true\n')
    expect(await readFile(join(nestedSub, 'build', 'artifact.js'), 'utf8')).toBe('export const subArtifact = true\n')
    expect(await readFile(join(nestedBuild, 'output.js'), 'utf8')).toBe('export const buildRepo = true\n')

    // Untracked disposable directories outside nested repos must be removed
    await expect(readFile(join(worktree.root, 'node_modules', 'pkg', 'index.js'))).rejects.toThrow()
    await expect(readFile(join(worktree.root, 'dist', 'app.js'))).rejects.toThrow()
  })

  it('invokes fs.rm with bounded retries maxRetries 5 and retryDelay 100 for disposable directories', async () => {
    const repo = await repoFixture()
    const manager = new TaskWorktreeManager()
    const worktree = await manager.ensure(repo, 'test-rm-retries')
    expect(worktree).toBeTruthy()
    if (!worktree) return

    await mkdir(join(worktree.root, 'dist'), { recursive: true })
    await writeFile(join(worktree.root, 'dist', 'bundle.js'), 'bundle\n')

    const rmSpy = vi.spyOn(fsPromises, 'rm')
    try {
      await removeDisposableArtifacts(worktree.root)
      expect(rmSpy).toHaveBeenCalledWith(
        join(worktree.root, 'dist'),
        expect.objectContaining({
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        }),
      )
    } finally {
      rmSpy.mockRestore()
    }
  })
})