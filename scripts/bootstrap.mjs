#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessRoot = join(root, 'vendor', 'deepseek-harness')
const harnessPin = JSON.parse(await fs.readFile(join(root, 'vendor', 'deepseek-harness.json'), 'utf8'))
const harnessRepository = requireString(harnessPin.repository, 'vendor/deepseek-harness.json repository')
// Harness tracks upstream latest during beta.
const harnessBranch = typeof harnessPin.branch === 'string' && harnessPin.branch.trim()
  ? harnessPin.branch.trim()
  : 'master'
const flags = new Set(process.argv.slice(2))

if (flags.has('--help')) {
  console.log(`Usage: node scripts/bootstrap.mjs [options]\n\n` +
    `  --check                Verify prerequisites and upstream sources only\n` +
    `  --skip-root-install    Skip the ND-DSH pnpm install\n` +
    `  --skip-dsh-build       Skip install/build inside DeepSeek Harness\n`)
  process.exit(0)
}

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
if (nodeMajor < 24) {
  throw new Error(`Node.js 24 or newer is required by agent-browser. Current: ${process.version}`)
}

await ensureSource({
  name: 'Harness',
  root: harnessRoot,
  marker: 'package.json',
  submodulePath: 'vendor/deepseek-harness',
  repository: harnessRepository,
  branch: harnessBranch,
})
await syncTrackedSource('Harness', harnessRoot, harnessBranch)

if (flags.has('--check')) {
  console.log('Bootstrap check passed for DeepSeek Harness.')
  process.exit(0)
}

if (!flags.has('--skip-root-install')) {
  await run('corepack', ['pnpm', 'install'], root)
}

if (!flags.has('--skip-dsh-build')) {
  // Upstream's lefthook postinstall refuses submodule worktrees (core.worktree
  // lives in the common git config); CI=true is its supported opt-out. Git hooks
  // inside the vendored checkout are unwanted regardless.
  const harnessEnv = { CI: 'true' }
  await run('corepack', ['pnpm', 'install', '--frozen-lockfile'], harnessRoot, { env: harnessEnv })
  // ND's own build script rather than upstream's aggregate: upstream's client
  // typecheck aborts on its own test files here and leaves the runtime without
  // the client artifacts the web profile loads. See scripts/build-harness.mjs.
  await run(process.execPath, ['scripts/build-harness.mjs', '--skip-install'], root, { env: harnessEnv })
}

await run('corepack', ['pnpm', 'verify'], root)
console.log('\nND-DSH bootstrap complete. Configure a model provider in Settings (or use DEEPSEEK_API_KEY for the compatibility route), then run:')
console.log('  corepack pnpm dev')
console.log('Codex CLI is available as an optional coding engine when native Codex authentication is configured.')

async function ensureSource({ name, root: sourceRoot, marker, submodulePath, repository, commit, branch }) {
  if (existsSync(join(sourceRoot, marker))) return

  await fs.mkdir(dirname(sourceRoot), { recursive: true })
  if (existsSync(join(root, '.git'))) {
    console.log(`Initializing ${name} submodule...`)
    await run('git', ['submodule', 'sync', '--', submodulePath], root)
    await run('git', ['submodule', 'update', '--init', '--recursive', '--', submodulePath], root)
  } else if (branch) {
    console.log(`Source archive detected; cloning the latest ${name} ${branch} checkout...`)
    await run('git', ['clone', '--depth=1', '--branch', branch, repository, sourceRoot], root)
    await run('git', ['submodule', 'update', '--init', '--recursive'], sourceRoot)
  } else {
    console.log(`Source archive detected; cloning the pinned ${name} checkout...`)
    await run('git', ['clone', '--filter=blob:none', '--no-checkout', repository, sourceRoot], root)
    await run('git', ['fetch', '--depth=1', 'origin', commit], sourceRoot)
    await run('git', ['checkout', '--detach', commit], sourceRoot)
    await run('git', ['submodule', 'update', '--init', '--recursive'], sourceRoot)
  }

  if (!existsSync(join(sourceRoot, marker))) throw new Error(`${name} source was not initialized correctly.`)
}

/**
 * Harness tracks upstream latest: move an initialized checkout to the head of
 * the tracked branch instead of enforcing a frozen pin.
 */
async function syncTrackedSource(name, sourceRoot, branch) {
  const status = await capture('git', ['status', '--porcelain'], sourceRoot)
  if (status.trim()) throw new Error(`${name} submodule has local changes. Clean it before bootstrapping.`)

  await run('git', ['fetch', '--depth=1', 'origin', branch], sourceRoot)
  await run('git', ['checkout', '--detach', 'FETCH_HEAD'], sourceRoot)
  await run('git', ['submodule', 'update', '--init', '--recursive'], sourceRoot)
  const current = (await capture('git', ['rev-parse', 'HEAD'], sourceRoot)).trim().toLowerCase()
  console.log(`${name} synced to upstream ${branch} latest at ${current.slice(0, 12)}.`)
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is invalid`)
  return value.trim()
}

function run(command, args, cwd, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(platformExecutable(command), args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ...options.env },
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with code ${String(code)}`))
    })
  })
}

function capture(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(platformExecutable(command), args, {
      cwd,
      env: process.env,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolvePromise(stdout)
      else reject(new Error(stderr.trim() || `${command} exited with code ${String(code)}`))
    })
  })
}

function platformExecutable(command) {
  return process.platform === 'win32' && command === 'corepack' ? 'corepack.cmd' : command
}
