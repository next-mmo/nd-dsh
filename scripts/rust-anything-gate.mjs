#!/usr/bin/env node
/**
 * Deterministic, fail-closed migration verification wrapper.
 * This does not port source code; rust-anything and the coding agent do that.
 * Original programs may perform side effects during record/diff/gate. Run only
 * in an isolated checkout with synthetic fixtures and NO production credentials.
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve, join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HELP = `Usage: node scripts/rust-anything-gate.mjs [--root DIR] [--all | --crate rust/UNIT ...]
       [--record] [--fuzz-seconds N] [--shadow] [--app-replay]

Runs rust-anything build, diff, bench, and gate for every selected recorded port.
--record runs the original code (dangerous side effects); default uses existing cases.
--shadow generates a drop-in only AFTER the port passes all gates.
--app-replay additionally replays the captured standalone Rust sub-application.
Requires ND_RUST_ANYTHING_SANDBOX=1, isolated test data and no production credentials.
Use rust-anything analyze . --whole-app before porting units.
`

function parse(argv) {
  const options = { root: DEFAULT_ROOT, crates: [], all: true, record: false, fuzzSeconds: 0, shadow: false, appReplay: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--root' || arg === '--crate' || arg === '--fuzz-seconds') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      if (arg === '--root') options.root = resolve(value)
      if (arg === '--crate') { options.crates.push(value); options.all = false }
      if (arg === '--fuzz-seconds') {
        if (!/^\d+$/.test(value) || Number(value) > 600) throw new Error('Fuzz seconds must be 0..600')
        options.fuzzSeconds = Number(value)
      }
    } else if (arg === '--all') {
      if (options.crates.length) throw new Error('Use --all OR --crate, not both')
      options.all = true
    } else if (arg === '--record') options.record = true
    else if (arg === '--shadow') options.shadow = true
    else if (arg === '--app-replay') options.appReplay = true
    else throw new Error(`Unexpected argument: ${arg}`)
  }
  return options
}

function confined(root, path, requireCases = true) {
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('/') || rel.startsWith('\\')) {
    throw new Error(`Port path escapes repository: ${path}`)
  }
  if (!existsSync(join(target, 'Cargo.toml'))) throw new Error(`Port crate missing Cargo.toml: ${path}`)
  const actual = realpathSync(target)
  const realRoot = realpathSync(root)
  const checked = relative(realRoot, actual)
  if (checked === '..' || checked.startsWith(`..${sep}`)) throw new Error(`Port crate symlink escapes repository: ${path}`)
  if (requireCases && !existsSync(join(target, 'cases.jsonl'))) throw new Error(`Port has no recorded cases.jsonl: ${path}`)
  return target
}

function discover(root) {
  const base = join(root, 'rust')
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'app' && existsSync(join(base, entry.name, 'Cargo.toml')))
    .map((entry) => `rust/${entry.name}`)
}

function run(bin, args, cwd, steps) {
  process.stdout.write(`\n$ ${bin} ${args.join(' ')}\n`)
  const startedAt = Date.now()
  const result = spawnSync(bin, args, { cwd, env: process.env, stdio: 'inherit', timeout: 10 * 60_000, windowsHide: true })
  const code = result.status ?? 1
  steps.push({ command: bin, args, exitCode: code, elapsedMs: Date.now() - startedAt, ...(result.error ? { error: result.error.message } : {}) })
  if (result.error) throw new Error(`${bin}: ${result.error.message}`)
  if (code !== 0) throw new Error(`${bin} ${args.join(' ')} exited ${code}`)
}

function main() {
  const options = parse(process.argv.slice(2))
  if (options.help) { process.stdout.write(HELP); return }
  if (process.env.ND_RUST_ANYTHING_SANDBOX !== '1') {
    throw new Error('Refusing to run original/port code: set ND_RUST_ANYTHING_SANDBOX=1 only inside an isolated test checkout')
  }
  if (process.env.NODE_ENV === 'production' || process.env.ND_DSH_ENV === 'production') {
    throw new Error('Production environment is not permitted for behavioral replay')
  }
  if (!existsSync(options.root)) throw new Error(`Repository root does not exist: ${options.root}`)
  const crates = options.all ? discover(options.root) : options.crates
  if (crates.length === 0) throw new Error('No Rust port crates found: no gate can be claimed passed')
  const report = { schema: 'nd.rust-migration-gate/1', status: 'failed', generatedAt: new Date().toISOString(), root: options.root, units: [] }
  const reportFile = join(options.root, 'rust', 'gate-report.json')
  const seen = new Set()
  try {
    for (const crate of crates) {
      const dir = confined(options.root, crate, !options.record)
      if (seen.has(dir)) throw new Error(`Repeated port crate: ${crate}`)
      seen.add(dir)
      const unit = { crate: relative(options.root, dir).split(sep).join('/'), status: 'failed', steps: [] }
      report.units.push(unit)
      if (options.record) {
        run('rust-anything', ['record', dir], options.root, unit.steps)
        if (!existsSync(join(dir, 'cases.jsonl'))) throw new Error(`Behavior recording did not create cases.jsonl: ${crate}`)
      }
      run('rust-anything', ['build', dir], options.root, unit.steps)
      run('rust-anything', ['diff', dir], options.root, unit.steps)
      if (options.fuzzSeconds) run('rust-anything', ['fuzz', dir, '--time', String(options.fuzzSeconds), '--keep'], options.root, unit.steps)
      run('rust-anything', ['bench', dir], options.root, unit.steps)
      run('rust-anything', ['gate', dir], options.root, unit.steps)
      if (options.shadow) run('rust-anything', ['shadow', dir], options.root, unit.steps)
      unit.status = 'passed'
    }
    if (options.appReplay) {
      if (!existsSync(join(options.root, 'rust', 'app', 'Cargo.toml'))) throw new Error('--app-replay requires rust/app/Cargo.toml')
      const steps = []
      report.appReplay = steps
      run('rust-anything', ['app', 'replay', options.root], options.root, steps)
    }
    run('rust-anything', ['map', '--write'], options.root, report.mapSteps = [])
    report.status = 'passed'
  } finally {
    mkdirSync(dirname(reportFile), { recursive: true })
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    process.stdout.write(`Gate report: ${reportFile} (${report.status})\n`)
  }
}

try { main() } catch (error) { console.error(`Rust migration gate FAILED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 }
