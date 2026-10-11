import { spawn } from 'node:child_process'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'

// Launch the visible ND desktop app using the existing isolated benchmark profile.
// This does not create an automation browser or copy production credentials.
const root = resolve('.')
const receiptPath = resolve('scratch/project-brief-benchmark/nd-process.json')
const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
const profile = resolve('scratch/project-brief-benchmark/private-nd-profile')
if (resolve(receipt.profile) !== profile || !(await stat(profile)).isDirectory()) throw new Error('Existing benchmark profile required')
const available = await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(3000) }).then(() => true, () => false)
if (available) throw new Error('Port 9222 is occupied; refusing a duplicate launch')
const env = { ...process.env, ND_DSH_USER_DATA_DIR: profile, ND_DSH_WORKSPACE: receipt.workspace,
  ND_DSH_CDP_PORT: '9222', ND_DSH_BROWSER_URL: 'about:blank', ELECTRON_RENDERER_URL: 'http://localhost:5173',
  ND_DSH_MANAGED_RUNTIME_ROOT: join(process.env.APPDATA, 'nd-dsh/runtimes') }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(createRequire(import.meta.url)('electron'), [root], { cwd: root, env, detached: true, windowsHide: true, stdio: 'ignore' })
await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject) })
child.unref()
await writeFile(receiptPath, JSON.stringify({ ...receipt, pid: child.pid, relaunchedAt: new Date().toISOString() }, null, 2) + '\n')
console.log(JSON.stringify({ outcome: 'launched', pid: child.pid, isolatedProfile: true }))
