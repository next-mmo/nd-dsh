import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
const base = resolve('scratch/workspace-checks-benchmark')
for (const side of ['nd', 'gpt']) {
  const receipt = JSON.parse(await readFile(`${base}/${side}-receipt.json`, 'utf8'))
  const files = await readdir(`${base}/${side}-workspace/extension`).catch(() => [])
  const result = { side, outcome: receipt.outcome ?? 'running', seconds: Math.round((receipt.executionWallMs ?? Date.now() - Date.parse(receipt.startedAt)) / 1000), files }
  if (side === 'nd') {
    const trace = JSON.parse(await readFile(`${base}/nd-trace.json`, 'utf8').catch(() => '{"events":[]}'))
    result.events = trace.events.length
    result.toolNames = trace.events.filter(e => e.type === 'tool/call').map(e => e.data?.name)
    result.childEvents = trace.events.filter(e => /child|subagent|delegate/.test(e.type ?? '')).map(e => ({ type: e.type, keys: Object.keys(e.data ?? {}) }))
  }
  console.log(JSON.stringify(result))
}
