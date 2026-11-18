#!/usr/bin/env node
/**
 * Read-only PASS/FAIL gate for the DeepSeek Harness runtime ND actually boots.
 * Mirrors src/main/app-paths.ts harnessRoot() resolution and readHarnessVersion().
 * Usage: node .agents/skills/update-deepseek/scripts/check-runtime.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = process.cwd()
const vendored = join(root, 'vendor', 'deepseek-harness')
const userData = join(process.env.APPDATA ?? join(process.env.HOME ?? '', 'AppData', 'Roaming'), 'nd-dsh')

const version = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')).version } catch { return undefined }
}
const hasBin = (r) => existsSync(join(r, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))

const candidates = [
  process.env.ND_DSH_HARNESS_ROOT && resolve(process.env.ND_DSH_HARNESS_ROOT),
  resolve(process.env.ND_DSH_MANAGED_RUNTIME_ROOT ?? join(userData, 'runtimes', 'dsh')),
  join(root, '.nd-dsh', 'runtime', 'dsh'),
].filter(Boolean)

const managed = candidates.find(hasBin)
const resolvedRoot = process.env.ND_DSH_HARNESS_ROOT
  ? resolve(process.env.ND_DSH_HARNESS_ROOT)
  : managed ?? vendored
const resolvedVersion =
  version(join(resolvedRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')) ??
  version(join(resolvedRoot, 'package.json'))
const vendoredVersion = version(join(vendored, 'package.json'))
const pin = (() => { try { return JSON.parse(readFileSync(join(root, 'vendor', 'deepseek-harness.json'), 'utf8')) } catch { return {} } })()

const lines = []
lines.push(`resolved root : ${resolvedRoot}${managed ? ' (managed/published)' : ' (vendored)'}`)
lines.push(`runtime ver   : ${resolvedVersion ?? 'unknown'}`)
lines.push(`vendored ver  : ${vendoredVersion ?? 'unknown'}  pin=${pin.lastSyncedRelease ?? '?'}`)

const artifacts = ['apps/cli/lib/bin.js', 'apps/web/dist/index.html']
  .filter((p) => !existsSync(join(vendored, p)))
if (artifacts.length) lines.push(`vendored boot artifacts missing: ${artifacts.join(', ')} -> run pnpm dsh:build`)

// A synced-but-unrebuilt tree leaves new client packages without lib/index.js and
// stale exports maps (ERR_MODULE_NOT_FOUND / ERR_PACKAGE_PATH_NOT_EXPORTED at boot).
const manifest = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return undefined } }
const clientRoot = join(vendored, 'packages', 'client')
const unbuilt = []
if (existsSync(clientRoot)) {
  for (const e of readdirSync(clientRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const dir = join(clientRoot, e.name)
    if (manifest(join(dir, 'package.json'))?.main === 'lib/index.js' && !existsSync(join(dir, 'lib', 'index.js'))) unbuilt.push(e.name)
  }
}
if (unbuilt.length) lines.push(`vendored client face incomplete (${unbuilt.length}): ${unbuilt.slice(0, 6).join(', ')} -> run pnpm dsh:build`)

// Stale agent-browser daemon pid sidecars cause 10s bind timeouts on next launch.
const runDir = join(userData, 'agent-browser-runtime', 'namespaces', 'nd-dsh', 'run')
const stale = []
if (existsSync(runDir)) {
  for (const f of readdirSync(runDir).filter((n) => n.endsWith('.pid'))) {
    const pid = Number(readFileSync(join(runDir, f), 'utf8').trim())
    if (!Number.isFinite(pid)) continue
    try { process.kill(pid, 0) } catch { stale.push(`${f}=${pid}`) }
  }
}
if (stale.length) lines.push(`WARN stale agent-browser daemon pid(s): ${stale.join(', ')} -> clear before launch`)

const ok = !artifacts.length && !unbuilt.length && resolvedVersion === vendoredVersion
lines.push(ok
  ? `PASS: runtime serves vendored latest (${vendoredVersion}), client face complete.`
  : `FAIL: skew or unbuilt vendored tree. runtime=${resolvedVersion ?? 'unknown'} vendored=${vendoredVersion ?? 'unknown'} unbuiltClient=${unbuilt.length}.`)
if (!ok && managed) {
  lines.push(`shadow: ${managed} pins ${resolvedVersion}; move it aside or clean-reinstall at ${vendoredVersion}.`)
}
console.log(lines.join('\n'))
process.exit(ok ? 0 : 1)