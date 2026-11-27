import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import process from 'node:process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electron = require('electron')
const workspace = await mkdtemp(join(tmpdir(), 'nd-dsh-browser-bench-workspace-'))
const userData = await mkdtemp(join(tmpdir(), 'nd-dsh-browser-bench-user-data-'))
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const output = resolve(process.env.ND_DSH_BROWSER_PLATFORM_BENCH_OUTPUT
  || join(root, 'benchmark-results', stamp + '-unified-browser', 'unified-browser-platform.json'))

try {
  const child = spawn(electron, [root], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...safeEnvironment(),
      ND_DSH_WORKSPACE: workspace,
      ND_DSH_USER_DATA_DIR: userData,
      ND_DSH_TEST_DRIVER_PID: String(process.pid),
      ND_DSH_BROWSER_URL: 'about:blank',
      ND_DSH_BROWSER_PLATFORM_BENCH_OUTPUT: output,
    },
  })
  const code = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      reject(new Error('unified browser benchmark timed out'))
    }, 180_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (value) => { clearTimeout(timer); resolvePromise(value) })
  })
  if (code !== 0) throw new Error('ND browser benchmark exited with code ' + String(code))
  const result = JSON.parse(await readFile(output, 'utf8'))
  const correctness = result.builtIn?.correctness
  if (correctness && (correctness.passwordRedacted === false || correctness.staleRefRejected === false)) {
    throw new Error('ND browser benchmark correctness failure: ' + JSON.stringify(correctness))
  }
  process.stdout.write(JSON.stringify({
    status: 'pass',
    output,
    builtIn: {
      snapshotMs: result.builtIn?.snapshotMs,
      clickMs: result.builtIn?.clickMs,
      navigateMs: result.builtIn?.navigateMs,
      screenshotMs: result.builtIn?.screenshotMs,
      siteToolDiscoveryMs: result.builtIn?.siteToolDiscoveryMs,
      siteToolCallMs: result.builtIn?.siteToolCallMs,
    },
    companion: result.companion,
  }, null, 2) + '\n')
} finally {
  await rm(workspace, { recursive: true, force: true })
  await rm(userData, { recursive: true, force: true })
}

function safeEnvironment() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string' || /(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)/i.test(key)) continue
    env[key] = value
  }
  return env
}
