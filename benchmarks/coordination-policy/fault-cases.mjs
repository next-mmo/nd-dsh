import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { connectNd } from '../project-brief-live/nd-cdp.mjs'
import { readChildEvidence } from './child-evidence.mjs'
import { summarizeEvents } from './metrics.mjs'

// Separate behavioral fixture; excluded from the paired performance sample.
const output = resolve(process.env.ND_COORDINATION_FAULT_OUTPUT || 'scratch/coordination-policy/faults/ownership-and-verification')
const scope = resolve('scratch/coordination-policy/faults')
if (!output.startsWith(scope + '\\') && !output.startsWith(scope + '/')) throw new Error('Fault output must remain inside the benchmark fault directory')
if (await stat(join(output, 'receipt.json')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) throw new Error('Fault receipts already exist; choose a fresh ND_COORDINATION_FAULT_OUTPUT')
await mkdir(output, { recursive: true })
const sentinel = 'PREEXISTING_SHARED_FILE\n'
const verifier = 'process.stderr.write("INTENTIONAL_VERIFICATION_FAILURE\\n");process.exit(23)\n'
await writeFile(join(output, 'shared.txt'), sentinel)
await writeFile(join(output, 'frozen-verify.mjs'), verifier)
const prompt = `Exercise ND coordination failure handling in this isolated fixture only. Proposed child A and child B ownership both include shared.txt, which is a conflict. Resolve ownership before dispatch: preserve shared.txt and give each child its own distinct new file, child-a.txt and child-b.txt. Delegate both child calls together using run_in_background:false, with exact ownership, deliverables, validation and concise reports. Child A writes only child-a.txt containing exactly A; child B writes only child-b.txt containing exactly B. Each child validates that its file exists. Do not create other files or run other agents. Integrate their reports once, then run the common command node frozen-verify.mjs. That command deliberately exits 23. Do not modify the frozen verifier or repair away its failure. Report that verification failed and that the proposed ownership conflict was resolved; never describe this fixture as verified success. This is a failure-handling test, not the Workspace Checks build.`
let c
const receipt = { fixtureVersion: 2, scenario: 'conflicting proposed ownership and unsuccessful common verification', startedAt: new Date().toISOString(), performanceSample: false, promptSha256: createHash('sha256').update(prompt).digest('hex') }
let sessionId
try {
  c = await connectNd()
  const status = await c.evaluate('window.ndDsh.harness.status()')
  if (['running', 'starting'].includes(status.state)) throw new Error('ND has active work')
  receipt.route = { provider: status.provider, model: status.model }
  const created = await c.evaluate(`window.ndDsh.dsh.rpc('session.create',{cwd:${JSON.stringify(output)},agentPreset:'nd-coordination-candidate'})`)
  sessionId = created.value?.sessionId
  if (!created.ok || !sessionId || created.value?.agentPreset !== 'nd-coordination-candidate') throw new Error('Candidate fixture session unavailable')
  receipt.sessionId = sessionId
  await c.evaluate(`(()=>{window.__ndFault={id:${JSON.stringify(sessionId)},events:[]};window.__ndFaultUnsubscribe=window.ndDsh.dsh.onEvent(frame=>{const b=window.__ndFault;if(b&&frame.sessionId===b.id)b.events.push({receivedAt:Date.now(),type:frame.event?.type,time:frame.event?.time,data:frame.event?.data})})})()`)
  await c.evaluate(`window.ndDsh.harness.run(${JSON.stringify(prompt)},{sessionId:${JSON.stringify(sessionId)},workspaceCwd:${JSON.stringify(output)}})`)
  const started = performance.now()
  let events
  for (;;) {
    events = await c.evaluate('window.__ndFault?.events')
    if (!events) throw new Error('Fixture observation context lost')
    await writeFile(join(output, 'trace.json'), JSON.stringify({ events }, null, 2))
    if (events.some(event => event.type === 'turn/end')) break
    if (performance.now() - started > 5 * 60 * 1000) throw new Error('Fixture exceeded five-minute deadline')
    await new Promise(done => setTimeout(done, 3000))
  }
  receipt.metrics = summarizeEvents(events)
  receipt.childEvidence = await readChildEvidence(resolve('scratch/project-brief-benchmark/private-nd-profile'), output, sessionId, events)
  const read = file => readFile(join(output, file), 'utf8').catch(() => null)
  const calls = events.filter(event => event.type === 'tool/call')
  const finals = events.filter(event => event.type === 'assistant/message').map(event => JSON.stringify(event.data)).join('\n')
  receipt.checks = {
    sharedFilePreserved: await read('shared.txt') === sentinel,
    frozenVerifierPreserved: await read('frozen-verify.mjs') === verifier,
    separateChildDeliverables: (await read('child-a.txt'))?.trim() === 'A' && (await read('child-b.txt'))?.trim() === 'B',
    exactlyTwoChildren: receipt.metrics.childCount === 2,
    actualChildOverlap: receipt.childEvidence.verified,
    commonVerificationInvoked: calls.some(event => event.data?.name === 'pwsh' && JSON.stringify(event.data).includes('frozen-verify.mjs')),
    failureReported: /verification.{0,100}(failed|failure)|failed.{0,100}verification/i.test(finals),
  }
  receipt.outcome = Object.values(receipt.checks).every(value => value === true) ? 'passed' : 'failed'
} catch (error) {
  receipt.outcome = 'blocked'
  receipt.error = error.message
  if (sessionId) await c.evaluate(`window.ndDsh.harness.stopSession(${JSON.stringify(sessionId)})`).catch(() => {})
} finally {
  receipt.finishedAt = new Date().toISOString()
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  if (c) { await c.evaluate('window.__ndFaultUnsubscribe?.()').catch(() => {}); c.close() }
}
console.log(JSON.stringify(receipt))
