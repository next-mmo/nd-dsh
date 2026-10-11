import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { connectNd } from '../project-brief-live/nd-cdp.mjs'

const base = resolve('scratch/workspace-checks-benchmark')
const reports = resolve('benchmarks/workspace-checks-live')
const side = process.argv[2]
const workspace = join(base, `${side}-workspace`)
const specification = await readFile(join(reports, 'requirements.txt'), 'utf8')
const hash = createHash('sha256').update(specification).digest('hex')
if (side === 'prepare') {
  await mkdir(base, { recursive: true })
  for (const runner of ['nd', 'gpt']) {
    const dir = join(base, `${runner}-workspace`)
    await mkdir(join(dir, 'reference'), { recursive: true })
    for (const [source, name] of [['src/shared/extension-package.ts', 'extension-package.ts'], ['schema/nd-extension.schema.json', 'nd-extension.schema.json'], ['examples/extension-counter/mcp-server.mjs', 'mcp-sample.mjs'], ['src/shared/extensions.ts', 'agent-extensions.ts']]) {
      await copyFile(source, join(dir, 'reference', name))
    }
    await writeFile(join(dir, 'AGENTS.md'), 'Only write inside this workspace. Do not inspect sibling workspaces or modify reference files. Use two real child agents with disjoint implementation and packaging/test ownership if supported. No secrets or core changes.\n')
    await writeFile(join(base, `${runner}-prompt.txt`), specification + `\nAssigned package ID: ${runner}-workspace-checks. Visible name: ${runner === 'nd' ? 'ND' : 'GPT'} Workspace Checks.\n`)
  }
  await writeFile(join(reports, 'contract.json'), JSON.stringify({ requirementsSha256: hash, trialsPerRunner: 1, repairsAllowed: false, coreChangesAllowed: false, execution: 'concurrent paired products, shared host', independentBatch: 'separate runtime fixture benchmark; not a live product throughput comparison' }, null, 2) + '\n')
} else if (side === 'nd' || side === 'gpt') {
  const prompt = await readFile(join(base, `${side}-prompt.txt`), 'utf8')
  const receipt = { side, requirementsSha256: hash, trial: 1, repairs: 0, startedAt: new Date().toISOString() }
  const start = performance.now()
  const save = () => writeFile(join(base, `${side}-receipt.json`), JSON.stringify(receipt, null, 2) + '\n')
  if (side === 'gpt') {
    const model = 'gpt-6.1-sol'
    receipt.config = { runner: 'Codex CLI', model, modelSource: 'explicit user instruction', savedConfigurationChanged: false, reasoning: 'medium', fallbackAllowed: false }
    await save()
    const child = spawn('codex', ['exec', '--model', model, '-c', 'model_reasoning_effort="medium"', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--json', '--output-last-message', join(base, 'gpt-final.txt'), '-'], { cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const output = createWriteStream(join(base, 'gpt-trace.jsonl'))
    const errors = createWriteStream(join(base, 'gpt-stderr.log'))
    child.stdout.pipe(output)
    child.stderr.pipe(errors)
    child.stdin.end(prompt)
    const timer = setTimeout(() => { receipt.timedOut = true; child.kill() }, 20 * 60 * 1000)
    const status = await new Promise(done => { child.once('error', error => done({ outcome: 'launch-failed', error: error.message })); child.once('close', (code, signal) => done({ outcome: code === 0 ? 'finished' : 'failed', code, signal })) })
    clearTimeout(timer)
    Object.assign(receipt, status)
    await Promise.all([output, errors].map(stream => stream.closed ? undefined : new Promise(done => stream.once('close', done))))
  } else {
    const c = await connectNd()
    try {
      receipt.config = await c.evaluate('(async()=>{const s=await window.ndDsh.harness.status();return {runner:"ND default",provider:s.provider,model:s.model,permissionMode:await window.ndDsh.harness.getPermissionMode()}})()')
      await save()
      // Subscribe before dispatch, restrict stored events to this requested session.
      const result = await c.evaluate(`(async()=>{const a=window.ndDsh;const created=await a.dsh.rpc('session.create',{cwd:${JSON.stringify(workspace)}});const sessionId=created.result?.value?.sessionId??created.value?.sessionId??created.sessionId;if(!sessionId)throw new Error('session.create returned no session ID');window.__workspaceChecksBenchmark={sessionId,events:[],startedAt:Date.now()};a.dsh.onEvent(f=>{const b=window.__workspaceChecksBenchmark;if(f.sessionId===b.sessionId)b.events.push({receivedAt:Date.now(),frame:f})});return a.harness.run(${JSON.stringify(prompt)},{sessionId,workspaceCwd:${JSON.stringify(workspace)},permissionMode:${JSON.stringify(receipt.config.permissionMode)}})})()`)
      receipt.dispatch = result
      for (;;) {
        const state = await c.evaluate(`(()=>{const b=window.__workspaceChecksBenchmark;const terminal=b.events.findLast(e=>e.frame.kind==='session-event'&&e.frame.event?.type==='turn/end');return {sessionId:b.sessionId,terminal:terminal?.frame.event.data,events:b.events.map(e=>({receivedAt:e.receivedAt,kind:e.frame.kind,type:e.frame.event?.type,time:e.frame.event?.time,data:e.frame.event?.data}))}})()`)
        await writeFile(join(base, 'nd-trace.json'), JSON.stringify(state, null, 2))
        if (state.terminal || performance.now() - start > 20 * 60 * 1000) {
          receipt.outcome = state.terminal ? 'finished' : 'timeout'
          receipt.sessionId = state.sessionId
          receipt.terminal = state.terminal
          if (!state.terminal) await c.evaluate(`window.ndDsh.harness.stopSession(${JSON.stringify(state.sessionId)})`)
          break
        }
        await new Promise(done => setTimeout(done, 2000))
      }
    } catch (error) { receipt.outcome = 'error'; receipt.error = error.message }
    finally { c.close() }
  }
  receipt.executionWallMs = performance.now() - start
  receipt.finishedAt = new Date().toISOString()
  await save()
  console.log(JSON.stringify(receipt))
} else throw new Error('Usage: node benchmarks/workspace-checks-live/run.mjs prepare|nd|gpt')
