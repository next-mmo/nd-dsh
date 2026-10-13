#!/usr/bin/env node
// Publish metadata separately from the app; every payload is read from an immutable Git tree.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
let requestedRevision
let selectedDirectories
let outputPath
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]
  if (argument === '--revision') requestedRevision = args[++index]
  else if (argument === '--packages') selectedDirectories = args[++index]?.split(',')
  else if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`)
  else if (!outputPath) outputPath = argument
  else throw new Error('Only one catalog output path is accepted')
}
const git = (args, options = {}) => execFileSync('git', args, { cwd: root, maxBuffer: 9 * 1024 * 1024, ...options })
const revision = git(['rev-parse', '--verify', `${requestedRevision || 'HEAD'}^{commit}`], { encoding: 'utf8' }).trim()
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Catalog source must resolve to an immutable Git commit')
const output = resolve(outputPath || join(root, '.release', 'nd-extension-catalog.json'))
const directories = selectedDirectories || (requestedRevision
  ? git(['ls-tree', '-d', '-z', '--name-only', `${revision}:extensions`], { encoding: 'utf8' }).split('\0').filter(Boolean)
  : await fs.readdir(join(root, 'extensions')))
if (!directories.every((name) => /^[a-z0-9-]+$/.test(name))) throw new Error('Invalid catalog package directory')
const packages = []
const scratch = await fs.mkdtemp(join(tmpdir(), 'nd-catalog-manifest-'))
try {
  for (const directory of directories) {
    const folder = join(root, 'extensions', directory)
    if (!requestedRevision) {
      if (git(['status', '--porcelain', '--untracked-files=all', '--', relative(root, folder)], { encoding: 'utf8' }).trim()) {
        throw new Error(`Commit extension ${directory} changes before generating the release catalog`)
      }
    }
    const rows = git(['ls-tree', '-r', '-z', '-l', revision, '--', `extensions/${directory}`], { encoding: 'utf8' })
      .split('\0').filter(Boolean).map((row) => {
        const match = row.match(/^(\d+) (\w+) ([a-f0-9]{40})\s+(\d+|-)\t(.+)$/s)
        if (!match) throw new Error(`Invalid Git tree entry for ${directory}`)
        return { mode: match[1], type: match[2], object: match[3], bytes: Number(match[4]), path: match[5] }
      })
    const manifestRow = rows.find((row) => row.path === `extensions/${directory}/nd-extension.json`)
    if (!manifestRow) {
      // Browser Companion is product infrastructure, not an ND package.
      if (selectedDirectories) throw new Error(`No committed ND package in ${directory}`)
      continue
    }
    if (manifestRow.bytes > 8 * 1024 * 1024) throw new Error(`Oversized manifest: ${directory}`)
    const manifest = JSON.parse(git(['cat-file', 'blob', manifestRow.object], { encoding: 'utf8' }))
    if (manifest.protocol !== 'nd.extension/1') throw new Error(`Invalid ND package protocol: ${directory}`)
    const manifestPath = join(scratch, `${directory}.json`)
    await fs.writeFile(manifestPath, JSON.stringify(manifest))
    execFileSync(process.execPath, ['scripts/validate-nd-extension.mjs', manifestPath], { cwd: root, stdio: 'pipe' })
    const files = []
    let bytes = 0
    for (const row of rows) {
      if (row.type !== 'blob' || !['100644', '100755'].includes(row.mode)) throw new Error(`Catalog packages cannot contain links or submodules: ${row.path}`)
      if (row.bytes > 8 * 1024 * 1024) throw new Error(`Oversized package file: ${row.path}`)
      const path = row.path.slice(`extensions/${directory}/`.length)
      if (path.includes('\\') || path.includes(':') || path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git' || /[\x00-\x1f]/.test(part))) {
        throw new Error(`Unsafe package path: ${path}`)
      }
      const data = git(['cat-file', 'blob', row.object])
      bytes += data.length
      files.push({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), executable: row.mode === '100755' })
    }
    if (bytes > 24 * 1024 * 1024 || files.length > 5_000) throw new Error(`Oversized package: ${directory}`)
    packages.push({ manifest, revision, directory, files })
  }
  const serialized = JSON.stringify({ version: 1, packages })
  if (packages.length > 1_000 || Buffer.byteLength(serialized) > 1024 * 1024) throw new Error('Catalog exceeds the metadata download budget')
  await fs.mkdir(dirname(output), { recursive: true })
  await fs.writeFile(output, serialized)
  console.log(`Extension catalog: ${packages.length} packages at ${revision} → ${output} (publish separately from the app)`)
} finally { await fs.rm(scratch, { recursive: true, force: true }) }
