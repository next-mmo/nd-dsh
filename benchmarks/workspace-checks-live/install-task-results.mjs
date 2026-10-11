import { connectNd } from '../project-brief-live/nd-cdp.mjs'
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = resolve('.')
const directory = join(root, 'extensions/nd-task-results')
const config = {
  id: 'nd-task-results', name: 'ND Task Results', description: 'Read verified task outcomes and observed overlap from saved metrics.',
  surface: 'mcp', version: '1.0.0', enabled: true,
  instructions: 'Use task_results for actual saved receipt outcomes and interval overlap; task_results_export returns Markdown. For the latest measured run use resultsPath scratch/task-results-runtime-retry/agent-task-metrics.json. Offline fixture timings exclude model latency and do not prove AI speedup.',
  runtime: { kind: 'mcp-stdio', command: process.execPath, args: [join(directory, 'mcp-server.mjs'), '--workspace', root], env: {} },
  engineRoutes: [], providerRoutes: [],
}
const c = await connectNd()
try {
  await c.evaluate(`window.ndDsh.ndExtensions.installFromPath(${JSON.stringify(directory)})`)
  const saved = await c.evaluate(`window.ndDshExtensions.save(${JSON.stringify(config)})`)
  if (!saved.some(entry => entry.id === config.id && entry.enabled)) throw new Error('Registration did not persist')
} finally { c.close() }
const env = { ...process.env, ND_EXTENSION_CATALOG: resolve('scratch/project-brief-benchmark/private-nd-profile/agent-extensions.json'), ND_EXTENSION_STATE: resolve('scratch/workspace-checks-benchmark/task-results-state.json') }
const result = spawnSync(process.execPath, ['scripts/nd-extension-runtime.mjs', 'call', config.id, 'task_results', JSON.stringify({ resultsPath: 'scratch/task-results-runtime-retry/agent-task-metrics.json' }), 'nd-harness'], { env, cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000 })
if (result.status !== 0) throw new Error('Registered gateway call failed: ' + result.stderr)
const call = JSON.parse(result.stdout)
if (call.isError || !call.content?.[0]?.text) throw new Error('Registered tool returned an error')
const summary = JSON.parse(call.content[0].text)
const receipt = { id: config.id, nativeInstalled: true, legacyMcpRegistered: true, gatewayCallPassed: true, totals: summary.totals, checkedAt: new Date().toISOString(), profile: 'existing isolated ND profile from previous benchmark', workspaceBound: root }
await writeFile('benchmarks/workspace-checks-live/task-results-registration.json', JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify(receipt))
