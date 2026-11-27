import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import process from 'node:process'

const require = createRequire(import.meta.url)
const electron = require('electron')
const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outputDir = resolve(process.env.ND_DSH_BROWSER_SPIKE_OUTPUT || join(root, 'benchmark-results', stamp + '-browser-runtime-spike'))
const output = join(outputDir, 'browser-runtime-spike.json')
await mkdir(outputDir, { recursive: true })

const child = spawn(electron, [join(root, 'benchmarks', 'browser-runtime-spike-electron.mjs'), output], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: { ...safeEnvironment(), ND_DSH_TEST_DRIVER_PID: String(process.pid) },
})

const code = await new Promise((resolvePromise, reject) => {
  child.once('error', reject)
  child.once('exit', resolvePromise)
})
if (code !== 0) throw new Error('browser runtime spike exited with code ' + String(code))

const result = JSON.parse(await readFile(output, 'utf8'))
process.stdout.write(JSON.stringify({
  status: result.status,
  decision: result.decision,
  output,
  failures: result.failures,
}, null, 2) + '\n')
if (result.status !== 'pass') process.exitCode = 1

function safeEnvironment() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string' || /(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)/i.test(key)) continue
    env[key] = value
  }
  return env
}
