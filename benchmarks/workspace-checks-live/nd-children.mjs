import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const base = resolve('scratch/workspace-checks-benchmark')
const trace = JSON.parse(await readFile(`${base}/nd-trace.json`, 'utf8'))
const children = trace.events.filter(event => event.type === 'subagent/catalog').map(event => event.data)
const calls = new Map(trace.events.filter(e => e.type === 'tool/call').map(e => [e.data.callId, e.data.name]))
const snapshots = trace.events.filter(e => e.type === 'tool/result' && calls.get(e.data.message?.source?.callId) === 'list_agents').map(e => {
  const text = e.data.message.content.flatMap(part => part.content ?? []).map(part => part.text ?? '').join('\n')
  return { time: e.time, states: children.map(child => ({ label: child.label, state: text.match(new RegExp(child.childId + ' \\[([^\\]]+)\\]'))?.[1] ?? 'unknown' })) }
})
const result = {
  children: children.map(child => ({ label: child.label, createdAt: child.childCreatedAt })),
  statusSnapshots: snapshots,
  bothRunningObserved: snapshots.some(snapshot => snapshot.states.length === 2 && snapshot.states.every(state => state.state === 'running')),
  pollCalls: snapshots.length,
  exactChildExecutionIntervals: null,
  limitation: 'Durable child history was unavailable through the current ND session.history bridge; parent catalog and list_agents snapshots establish actual children and sampled simultaneous running, but not exact durations.'
}
await writeFile(`${base}/nd-children.json`, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ ...result, statusSnapshots: undefined }))
