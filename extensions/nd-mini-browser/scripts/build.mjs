#!/usr/bin/env node
/**
 * Build for a declarative `nd.extension/1` package.
 *
 * ND installs extension folders prebuilt and never runs `npm install`,
 * `postinstall`, or build scripts inside a package (see
 * `docs/extensions/authoring.md`, section 5), so there is nothing to compile and
 * no artifact to emit. "Build" therefore proves install readiness: the manifest
 * satisfies the contract, the files ND snapshots are present, the package
 * contains no symlinks (the installer rejects them) and no credential-shaped
 * files, and no shipped file contains a secret-shaped value.
 *
 * Zero dependencies; safe to run in an isolated worktree.
 */
import { lstat, readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findSecrets, validateManifest } from './nd-contract.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const issues = []

const REQUIRED_FILES = ['nd-extension.json', 'package.json', 'README.md']
const FORBIDDEN_FILES = ['.npmrc', '.netrc', 'id_rsa', 'id_ed25519']
const FORBIDDEN_PREFIXES = ['.env']
const FORBIDDEN_SUFFIXES = ['.pem', '.p12', '.pfx', '.key']
const SKIP_DIRECTORIES = new Set(['node_modules', '.git'])
const TEXT_SUFFIXES = new Set(['.json', '.mjs', '.md', '.js', '.ts', '.txt'])
const TEXT_NAMES = new Set(['.gitignore', '.npmrc'])

/** Walk the package tree, reporting symlinks and forbidden paths as issues. */
async function walk(dir, files = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue
    const full = join(dir, entry.name)
    const relative = full.slice(root.length + 1).replaceAll('\\', '/')
    if (entry.isSymbolicLink()) {
      issues.push(`${relative} is a symlink; the ND installer rejects symlinks inside a package`)
      continue
    }
    if (entry.isDirectory()) {
      await walk(full, files)
      continue
    }
    if (!entry.isFile()) continue
    const lower = entry.name.toLowerCase()
    if (
      FORBIDDEN_FILES.includes(lower)
      || FORBIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix))
      || FORBIDDEN_SUFFIXES.some((suffix) => lower.endsWith(suffix))
    ) {
      issues.push(`${relative} looks like a credential file and must not ship in the package`)
      continue
    }
    files.push({ relative, full, name: entry.name })
  }
  return files
}

// 1. The manifest must satisfy the contract before anything is packaged.
let manifest
try {
  manifest = JSON.parse(await readFile(join(root, 'nd-extension.json'), 'utf8'))
} catch (error) {
  issues.push(`nd-extension.json could not be read: ${error instanceof Error ? error.message : String(error)}`)
}
if (manifest !== undefined) {
  for (const issue of validateManifest(manifest)) issues.push(`nd-extension.json: ${issue}`)
}

// 2. Required package files must exist.
const files = await walk(root)
const present = new Set(files.map((file) => file.relative))
for (const required of REQUIRED_FILES) {
  if (!present.has(required)) issues.push(`missing required package file: ${required}`)
}

// 3. No shipped file may contain a secret-shaped value.
for (const file of files) {
  const isText = TEXT_SUFFIXES.has(file.name.toLowerCase()) || TEXT_NAMES.has(file.name)
  if (!isText) continue
  const text = await readFile(file.full, 'utf8')
  for (const pattern of findSecrets(text)) {
    issues.push(`${file.relative} matches a credential pattern: ${pattern}`)
  }
}

if (issues.length > 0) {
  console.error('FAIL build')
  for (const issue of issues) console.error(`  ${issue}`)
  process.exit(1)
}
const contributionCount = manifest.contributions.commands.length + manifest.contributions.views.length
console.log(
  `PASS build — ${files.length} files install-ready, no symlinks, no credential files `
  + `(${manifest.id}@${manifest.version}, ${contributionCount} contributions; `
  + 'declarative package: ND installs folders prebuilt, so no artifacts are emitted)',
)
