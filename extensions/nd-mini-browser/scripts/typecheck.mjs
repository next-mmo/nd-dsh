#!/usr/bin/env node
/**
 * Typecheck for a declarative `nd.extension/1` package.
 *
 * There is no compiler to run: this package is manifest data plus the
 * verification scripts themselves. The check parses every JSON file, validates
 * `nd-extension.json` against the contract in `nd-contract.mjs`, and proves the
 * verification wiring in `package.json` stays complete — all four scripts exist,
 * `verify` chains typecheck → test → build, and every file under `scripts/` is
 * reachable from a package script so no check can silently go stale.
 *
 * Zero dependencies; safe to run in an isolated worktree.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateManifest } from './nd-contract.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const issues = []

async function readJson(relativePath) {
  let raw
  try {
    raw = await readFile(join(root, relativePath), 'utf8')
  } catch (error) {
    issues.push(`${relativePath} could not be read: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    issues.push(`${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

// 1. package.json verification wiring.
const pkg = await readJson('package.json')
if (pkg) {
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}
  for (const name of ['verify', 'typecheck', 'test', 'build']) {
    if (typeof scripts[name] !== 'string' || !scripts[name].trim()) {
      issues.push(`package.json must expose a "${name}" script`)
    }
  }
  const verify = typeof scripts.verify === 'string' ? scripts.verify : ''
  if (verify && !(verify.includes('typecheck') && verify.includes('--test') && verify.includes('build'))) {
    issues.push('package.json "verify" must chain the typecheck, test, and build scripts')
  }
  if (typeof scripts.test === 'string' && !scripts.test.includes('--test')) {
    issues.push('package.json "test" must run the smoke test with `node --test`')
  }

  // Every scripts/*.mjs file must be invoked directly or imported by a file
  // that is itself reachable from a package script.
  const scriptFiles = (await readdir(join(root, 'scripts'))).filter((name) => name.endsWith('.mjs'))
  const sources = new Map()
  for (const name of scriptFiles) {
    sources.set(name, await readFile(join(root, 'scripts', name), 'utf8'))
  }
  const invoked = Object.values(scripts).filter((value) => typeof value === 'string').join(' ')
  const reachable = new Set(scriptFiles.filter((name) => invoked.includes(name)))
  let changed = true
  while (changed) {
    changed = false
    for (const [name, source] of sources) {
      if (reachable.has(name)) continue
      for (const caller of reachable) {
        if (sources.get(caller)?.includes(name)) {
          reachable.add(name)
          changed = true
          break
        }
      }
    }
  }
  for (const name of scriptFiles) {
    if (!reachable.has(name)) {
      issues.push(`scripts/${name} is not reachable from any package.json script`)
    }
  }
}

// 2. Every JSON file in the package root must parse.
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.json')) await readJson(entry.name)
}

// 3. The manifest must satisfy the nd.extension/1 contract this package relies on.
const manifest = await readJson('nd-extension.json')
if (manifest !== undefined) {
  for (const issue of validateManifest(manifest)) issues.push(`nd-extension.json: ${issue}`)
  // Web views serve their entry file token-scoped — the file must exist in the
  // package (and under ui/, so package-root documents can never become UIs).
  for (const view of manifest.contributions.views ?? []) {
    if (view?.kind !== 'web') continue
    const entry = typeof view.entry === 'string' && view.entry.startsWith('ui/') ? view.entry : undefined
    if (entry !== undefined) {
      let present = false
      try {
        present = (await stat(join(root, entry))).isFile()
      } catch {
        present = false
      }
      if (!present) issues.push(`nd-extension.json: web view "${view.id}" entry ${entry} is missing from the package`)
    }
  }
}

if (issues.length > 0) {
  console.error('FAIL typecheck')
  for (const issue of issues) console.error(`  ${issue}`)
  process.exit(1)
}
const contributionCount = manifest.contributions.commands.length + manifest.contributions.views.length
console.log(
  `PASS typecheck — ${manifest.id}@${manifest.version} manifest contract holds, `
  + `verification wiring complete (${contributionCount} contributions declared)`,
)
