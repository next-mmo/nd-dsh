#!/usr/bin/env node
/**
 * Build the vendored Harness runtime ND ships.
 *
 * Upstream's `pnpm run build` cannot finish inside this repository. Its client
 * aggregate (`tsc -b tsconfig.client.json`) is a typecheck-only program over
 * upstream's own tests, and those tests mix two React type instances here
 * (`React.ReactNode` against `@types/react@18.3.31`), so the build aborts before
 * any client artifact exists. The runtime then cannot boot: the `web` profile
 * loads client plugins — `@deepseek-ai/dsh-client-ui-trajectory` is the first —
 * whose `lib/index.js` only that pass produces.
 *
 * ND consumes the runtime, not its test typecheck, so this script runs the two
 * passes the runtime needs and asserts the entry points the profile loader
 * imports. Upstream is not patched: the host pass is upstream's own script, and
 * the client pass is upstream's own bundler with its own env switch.
 */
import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessRoot = join(root, 'vendor', 'deepseek-harness')
const flags = new Set(process.argv.slice(2))

if (flags.has('--help')) {
  console.log(`Usage: node scripts/build-harness.mjs [options]\n\n` +
    `  --skip-install    Reuse the existing Harness node_modules\n\n` +
    `Builds the vendored Harness host and client runtime faces, then verifies\n` +
    `that every client package the web profile loads has its emitted entry.\n`)
  process.exit(0)
}

if (!existsSync(join(harnessRoot, 'package.json'))) {
  throw new Error('The Harness submodule is not initialized. Run: corepack pnpm bootstrap')
}

// Upstream's lefthook postinstall refuses submodule worktrees (core.worktree
// lives in the common git config); CI=true is its supported opt-out, and git
// hooks inside the vendored checkout are unwanted regardless.
const harnessEnv = { CI: 'true' }

if (!flags.has('--skip-install')) {
  console.log('\nInstalling the Harness dependency graph...')
  await run('corepack', ['pnpm', '--dir', harnessRoot, 'install', '--frozen-lockfile'], harnessRoot, harnessEnv)
}

// Updating the submodule leaves ignored output for packages upstream removed.
// tsdown's workspace glob can still bundle those obsolete lib/types entries
// against the new API. Use upstream's boundary-checked cleaner before building
// either face; it preserves source and refuses unknown files in orphan folders.
console.log('\nCleaning the Harness generated runtime output...')
await run('corepack', ['pnpm', '--dir', harnessRoot, 'run', 'clean'], harnessRoot, harnessEnv)

const nativeSystemScript = join(harnessRoot, 'native', 'system', 'scripts', 'build.ts')
if (existsSync(nativeSystemScript)) {
  console.log('\nBuilding the Harness native system addons...')
  await run('corepack', ['pnpm', '--dir', harnessRoot, 'run', 'build:native-system'], harnessRoot, harnessEnv)
}

console.log('\nBuilding the Harness host face...')
await run('corepack', ['pnpm', '--dir', harnessRoot, 'run', 'build:lib:host'], harnessRoot, harnessEnv)

console.log('\nEmitting the Harness client package graph (without the aggregate client test program)...')
await emitClientProjectGraph()

console.log('\nBuilding the Harness client face (bundler pass)...')
await run(process.execPath, [await tsdownEntry(), '--env.DSH_BUILD_FACE', 'client'], harnessRoot, harnessEnv)

console.log('\nBuilding the Harness web frontend...')
await run('corepack', ['pnpm', '--dir', harnessRoot, 'run', 'build:web'], harnessRoot, harnessEnv)

const missing = await unbuiltClientEntries()
if (missing.length > 0) {
  throw new Error(
    `The Harness client face is incomplete: ${missing.length} package(s) declare \`lib/index.js\` but emit none, ` +
    `starting with ${missing[0]}. The web profile cannot boot without them.\n  ${missing.join('\n  ')}`,
  )
}
for (const artifact of ['apps/web/dist/index.html', 'apps/web/dist/assets']) {
  if (!existsSync(join(harnessRoot, artifact))) {
    throw new Error(`The Harness web frontend is incomplete: ${artifact} is missing after build:web.`)
  }
}

console.log('\nHarness runtime build complete: host, client, and web faces are emitted.')

/**
 * Every client package whose manifest points `main` at the emitted bundle must
 * have it. Derived from the manifests rather than a fixed list, so a package
 * upstream adds is covered without editing this script, and a package upstream
 * renames cannot leave a stale assertion behind.
 */
async function unbuiltClientEntries() {
  const clientRoot = join(harnessRoot, 'packages', 'client')
  const missing = []
  for (const entry of await fs.readdir(clientRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(clientRoot, entry.name)
    const manifest = await readJson(join(dir, 'package.json'))
    if (manifest === undefined || manifest.main !== 'lib/index.js') continue
    if (!existsSync(join(dir, 'lib', 'index.js'))) missing.push(`packages/client/${entry.name}/lib/index.js`)
  }
  return missing
}


/**
 * Upstream's root client project is intentionally noEmit and includes its test
 * aggregate. ND only needs the referenced package projects emitted to
 * lib/types before tsdown consumes them. Build those references directly so
 * TypeScript still respects their project-reference graph without compiling
 * the aggregate test program that is known to fail in this vendored layout.
 */
async function emitClientProjectGraph() {
  const typescriptModule = await import(pathToFileURL(join(harnessRoot, 'node_modules', 'typescript', 'lib', 'typescript.js')).href)
  const typescript = typescriptModule.default ?? typescriptModule
  const configPath = join(harnessRoot, 'tsconfig.client.json')
  const read = typescript.readConfigFile(configPath, typescript.sys.readFile)
  if (read.error) throw new Error('Could not read Harness tsconfig.client.json: ' + flattenTsDiagnostic(typescript, read.error))
  const references = Array.isArray(read.config?.references)
    ? read.config.references.map((entry) => entry?.path).filter((value) => typeof value === 'string' && value.trim())
    : []
  if (references.length === 0) throw new Error('Harness tsconfig.client.json declares no client project references to emit.')

  const tsc = join(harnessRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  await run(process.execPath, [tsc, '-b', ...references], harnessRoot, harnessEnv)
}

function flattenTsDiagnostic(typescript, diagnostic) {
  return typescript.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
}

/** The bundler's own entry, resolved through the dependency's manifest. */
async function tsdownEntry() {
  const manifest = await readJson(join(harnessRoot, 'node_modules', 'tsdown', 'package.json'))
  const bin = typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.tsdown
  if (typeof bin !== 'string' || !bin.trim()) throw new Error('The Harness dependency graph has no tsdown binary to run.')
  return join(harnessRoot, 'node_modules', 'tsdown', bin)
}

async function readJson(path) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

function run(command, args, cwd, env = {}) {
  // Windows needs a shell for a `.cmd` shim (corepack) and must not have one for
  // a real executable: a shell splits the unquoted "C:\Program Files\..." node
  // path. Node passes shell args through unescaped, so quote them there.
  const shimmed = platformExecutable(command) !== command
  const useShell = process.platform === 'win32' && shimmed
  const executable = platformExecutable(command)
  const finalArgs = useShell ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : args
  console.log(`\n> ${executable} ${args.join(' ')}`)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(useShell ? `"${executable}"` : executable, finalArgs, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ...env },
      shell: useShell,
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${executable} ${args.join(' ')} exited with code ${String(code)}`))
    })
  })
}

function platformExecutable(command) {
  if (command !== 'corepack' || process.platform !== 'win32') return command
  // Resolve the shim that ships with Node itself. A bare `corepack` can pick up
  // an unrelated local `.bin` shim from the current directory instead, and a
  // `.cmd` cannot be spawned without a shell.
  const globalShim = join(dirname(process.execPath), 'corepack.cmd')
  return existsSync(globalShim) ? globalShim : command
}
