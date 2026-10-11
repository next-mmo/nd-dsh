#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeRoot = resolve(
  process.env.ND_DSH_MANAGED_RUNTIME_ROOT ?? join(projectRoot, '.nd-dsh', 'runtime', 'dsh'),
)
const packageName = '@deepseek-ai/dsh'
const packageSpec = `${packageName}@latest`
const requiredPeerSpec = '@deepseek-ai/cordis-plugin-group@latest'
/** ND's official DSH engine adapter; pinned to the same release as `dsh`. */
const codexAdapterName = 'dsh-subagent-codex'

await installRuntime()

async function installRuntime() {
  assertSafeRuntimeRoot(runtimeRoot)
  const installedManifestPath = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const installedBinPath = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const requiredPeerPath = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'cordis-plugin-group', 'lib', 'index.js')
  const codexAdapterRoot = join(runtimeRoot, 'node_modules', '@deepseek-ai', codexAdapterName)
  const codexAdapterPath = join(codexAdapterRoot, 'lib', 'index.js')
  const installedVersion = await readVersion(installedManifestPath)

  console.log(`Checking ${packageSpec} against installed version ${installedVersion ?? '(not installed)'}...`)
  const npm = resolveNpmInvocation(['view', packageSpec, 'version', '--json', '--fetch-retries=0', '--fetch-timeout=30000'])
  const latestVersion = JSON.parse(await run(npm.command, npm.args, projectRoot, true))
  if (typeof latestVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(latestVersion)) {
    throw new Error('The npm registry returned invalid DSH version metadata. No packages were installed.')
  }
  console.log(`Latest published DSH version: ${latestVersion}.`)

  const audit = await auditManagedRuntime(runtimeRoot)
  if (audit.mixed.length > 0) {
    console.log(`Managed runtime holds sibling packages from ${audit.mixed.length} different releases (${summarize(audit.mixed)}), so an earlier install left hoisted packages behind.`)
  }
  if (audit.duplicated.length > 0) {
    console.log(`Managed runtime loads duplicate copies of ${audit.duplicated.length} package(s) (${summarize(audit.duplicated)}), which forks module-private state.`)
  }
  if (audit.mixed.length > 0 || audit.duplicated.length > 0) {
    console.log('Reinstalling a clean tree so exactly one copy of each DSH package is present.')
  }

  if (installedVersion === latestVersion
    && existsSync(installedBinPath)
    && existsSync(requiredPeerPath)
    && existsSync(codexAdapterPath)
    && await readVersion(join(codexAdapterRoot, 'package.json')) === latestVersion
    && audit.mixed.length === 0
    && audit.duplicated.length === 0) {
    console.log(`DSH package already up to date at version ${latestVersion}. Skipping install; no restart required.`)
    return
  }

  await fs.mkdir(runtimeRoot, { recursive: true })
  // Rewrite the manifest every time. npm --save-exact records the installed
  // packages here, so reusing a previous manifest would carry an earlier
  // release's pins into the new install, and a stale adapter pin makes the
  // adapter step fail with ERESOLVE against the new release's peers.
  const runtimeManifestPath = join(runtimeRoot, 'package.json')
  await fs.writeFile(runtimeManifestPath, `${JSON.stringify({
    name: 'nd-dsh-managed-runtime',
    private: true,
    description: 'ND-managed published DeepSeek Harness runtime.',
  }, null, 2)}\n`, 'utf8')

  const targetSpec = `${packageName}@${latestVersion}`
  // The managed runtime holds exactly one published release. An in-place npm
  // install leaves the previous release's hoisted packages behind, and a
  // leftover duplicate of a package that carries module-private state silently
  // changes behavior: @deepseek-ai/dsh-scope keys a scoped context by a private
  // Symbol, so a second loaded copy makes scopeOf() return undefined and every
  // session.create fails with "refusing to compose an unscoped context".
  // Replace the tree instead of merging into it.
  await clearInstalledTree(runtimeRoot)
  console.log(`Installing ${targetSpec} from the official npm registry...`)
  await runNpmInstall(targetSpec, requiredPeerSpec)
  if (!existsSync(installedBinPath) || !existsSync(requiredPeerPath)) {
    throw new Error('The published DSH package installed without its launcher. Remove the managed runtime and retry.')
  }
  const version = await readVersion(installedManifestPath)
  if (version !== latestVersion) throw new Error('The installed DSH version does not match the requested release.')

  const codexAdapterSpec = `@deepseek-ai/${codexAdapterName}@${version}`
  console.log(`Installing ND's official DSH engine adapter ${codexAdapterSpec}...`)
  await runNpmInstall(codexAdapterSpec)
  if (!existsSync(codexAdapterPath) || await readVersion(join(codexAdapterRoot, 'package.json')) !== version) {
    throw new Error('The official DSH Codex adapter is incomplete or has a mismatched version.')
  }

  console.log(`DSH package installed at version ${version}.`)
  console.log('Restart ND-DSH to launch the updated published runtime.')
}

async function readVersion(path) {
  try {
    const manifest = JSON.parse(await fs.readFile(path, 'utf8'))
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : undefined
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

/**
 * Audit the installed tree for the two defects that silently break the runtime.
 *
 * A healthy managed runtime hoists exactly one copy of every package, and its
 * `@deepseek-ai/dsh*` sibling packages all come from a single release train.
 * `dsh` and the pinned codex adapter are versioned by the release ND pins, not
 * by the sibling train, so they are excluded from that uniformity check.
 *
 * - `mixed`: the top-level siblings disagree on a version, which means an
 *   in-place npm install left an earlier release's hoisted packages behind.
 * - `duplicated`: a second copy of a package nested inside another package.
 *   A duplicate forks module identity: @deepseek-ai/dsh-scope tags a scoped
 *   context with a private Symbol, so a context minted by one copy is invisible
 *   to scopeOf() in the other, and every session.create fails with
 *   "refusing to compose an unscoped context".
 *
 * A package nested inside itself is not a duplicate.
 */
async function auditManagedRuntime(runtimeRoot) {
  const topLevel = await dshPackagesIn(join(runtimeRoot, 'node_modules', '@deepseek-ai'))
  const train = topLevel.filter((pkg) => pkg.name !== 'dsh' && pkg.name !== codexAdapterName)
  const trainVersions = [...new Set(train.map((pkg) => pkg.version ?? 'unreadable'))].sort()
  const mixed = trainVersions.length > 1 ? trainVersions : []
  const duplicated = new Set()
  for (const pkg of topLevel) {
    for (const nested of await dshPackagesIn(join(pkg.directory, 'node_modules', '@deepseek-ai'))) {
      if (nested.name !== pkg.name) duplicated.add(`${nested.name} nested in ${pkg.name}`)
    }
  }
  return { mixed, duplicated: [...duplicated].sort() }
}

async function dshPackagesIn(scopeDirectory) {
  let entries
  try {
    entries = await fs.readdir(scopeDirectory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const packages = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh')) continue
    const directory = join(scopeDirectory, entry.name)
    packages.push({ name: entry.name, directory, version: await readVersion(join(directory, 'package.json')) })
  }
  return packages
}

function summarize(packages) {
  const head = packages.slice(0, 4).join(', ')
  return packages.length > 4 ? `${head}, and ${packages.length - 4} more` : head
}

async function clearInstalledTree(runtimeRoot) {
  for (const name of ['node_modules', 'package-lock.json']) {
    const target = join(runtimeRoot, name)
    try {
      // The runtime child may have exited moments before this runs, and Windows
      // releases its file handles asynchronously (antivirus can also briefly
      // lock fresh files), so give the deletion room to ride out transient locks.
      await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
    } catch (error) {
      throw new Error(
        `Could not clear the previous managed runtime at ${target} (${error.code ?? 'unknown error'}). `
        + 'Quit ND-DSH and stop any running agent runtime, then retry.',
      )
    }
  }
}

async function runNpmInstall(...packageSpecs) {
  const npm = resolveNpmInvocation([
  'install',
  '--prefix', runtimeRoot,
  '--save-exact',
  '--no-audit',
  '--no-fund',
  '--loglevel=info',
    ...packageSpecs,
  ])
  await run(npm.command, npm.args, projectRoot)
}

function assertSafeRuntimeRoot(path) {
  const parsed = parse(path)
  if (path === parsed.root || path === projectRoot) {
    throw new Error(`Refusing unsafe managed runtime path: ${path}`)
  }
}

function resolveNpmInvocation(args) {
  if (process.platform !== 'win32') return { command: 'npm', args }

  const candidates = [
    process.env.ND_DSH_NPM_CLI,
    ...(process.env.PATH ?? '').split(';').map(directory => join(directory.replace(/^"|"$/g, ''), 'node_modules/npm/bin/npm-cli.js')),
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'nodejs/node_modules/npm/bin/npm-cli.js') : undefined,
    process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'nodejs/node_modules/npm/bin/npm-cli.js') : undefined,
  ]
  const npmCli = candidates.find(candidate => candidate && existsSync(candidate))
  if (!npmCli) throw new Error('npm was not found. Install Node.js with npm, then retry from ND.')
  return { command: process.execPath, args: [npmCli, ...args] }
}

function run(command, args, cwd, captureOutput = false) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' },
      // Inherited Windows descriptors make libuv allocate a console even with
      // windowsHide. Keep this background child piped and forward its logs.
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })
    let output = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', chunk => {
      if (captureOutput) output += chunk
      else process.stdout.write(chunk)
    })
    child.stderr?.on('data', chunk => { process.stderr.write(chunk) })
    child.once('error', reject)
    child.once('close', code => code === 0
      ? resolvePromise(output)
      : reject(new Error(`npm ${captureOutput ? 'version check' : 'install'} exited with code ${String(code)}.`)))
  })
}
