import { cp, mkdir, readFile, writeFile, appendFile, symlink, unlink, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { connectNd } from '../project-brief-live/nd-cdp.mjs'
import { comparePairs, summarizeEvents, POLICY_MODE, EXPECTED_PAIRS } from './metrics.mjs'
import { readChildEvidence } from './child-evidence.mjs'

const root = resolve('.')
const output = resolve(process.env.ND_COORDINATION_OUTPUT || 'scratch/coordination-policy')
if (!output.startsWith(join(root, 'scratch') + '\\') && !output.startsWith(join(root, 'scratch') + '/')) throw new Error('Output must be inside repository scratch/')
const profile = resolve('scratch/project-brief-benchmark/private-nd-profile')
const source = resolve('configs/dsh/agent-presets/nd-dsh')
const marker = "process.env.ND_DSH_COORDINATION_POLICY === 'foreground-v1'"
const sha = value => createHash('sha256').update(value).digest('hex')
const occupied = await stat(join(output, 'results.json')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
if (occupied && process.env.ND_COORDINATION_RESUME !== '1') throw new Error('Output already contains receipts; choose a fresh ND_COORDINATION_OUTPUT under scratch/ or explicitly resume')
const previous = occupied ? JSON.parse(await readFile(join(output, 'results.json'), 'utf8')) : null
if (previous && (previous.benchmark !== 'nd-coordination-policy' || previous.policy !== POLICY_MODE)) throw new Error('Mismatched experiment receipts')
const presetSource = await readFile(join(source, 'agent.cordis.yml'), 'utf8')
if (presetSource.split(marker).length !== 2) throw new Error('Expected exactly one opt-in policy branch')
const requirements = await readFile('benchmarks/workspace-checks-live/requirements.txt', 'utf8')
const frozenScorer = await readFile('benchmarks/workspace-checks-live/score.mjs', 'utf8')
const originalBase = "const base=join(repository,'scratch/workspace-checks-benchmark'),side=process.argv[2]"
if (!frozenScorer.includes(originalBase)) throw new Error('Frozen scorer routing changed')
// Only the fixture/artifact root changes. Every frozen check and weight stays byte-identical.
const scorer = frozenScorer.replace(originalBase, "const base=process.env.ND_COORDINATION_TRIAL_DIR,side=process.argv[2]")
await mkdir(output, { recursive: true })
if (previous) {
  const contract = JSON.parse(await readFile(join(output, 'contract.json'), 'utf8'))
  if (contract.presetSourceSha256 !== sha(presetSource) || contract.policySha256 !== sha(await readFile(join(source, 'coordination-policy.md'))) || contract.frozenScorerSha256 !== sha(frozenScorer) || contract.requirementsSha256 !== sha(requirements)) throw new Error('Cannot resume with changed frozen inputs')
}
await writeFile('benchmarks/coordination-policy/scorer.mjs', scorer)
await writeFile('benchmarks/coordination-policy/requirements.txt', requirements)
await writeFile(join(output, 'contract.json'), JSON.stringify({ version: 1, pairs: EXPECTED_PAIRS,
  requirementsSha256: sha(requirements), frozenScorerSha256: sha(frozenScorer), scorerSha256: sha(scorer),
  policySha256: sha(await readFile(join(source, 'coordination-policy.md'))), presetSourceSha256: sha(presetSource),
  model: 'existing ND default; fixed after preflight', threshold: 0.2, maxRoutinePolls: 4,
  sourceAdjustment: 'scorer artifact/fixture root only', defaultChanged: false }, null, 2) + '\n')

const runProcess = (args, env) => new Promise(done => {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const timer = setTimeout(() => child.kill(), 120000)
  child.once('error', error => { clearTimeout(timer); done({ code: null, error: error.message }) })
  child.once('close', code => { clearTimeout(timer); done({ code, stdout, stderr }) })
})

let c
const pairs = previous?.pairs ?? []
let fixturePreflight
const save = async () => {
  const document = { schemaVersion: 1, benchmark: 'nd-coordination-policy', policy: POLICY_MODE,
    generatedAt: new Date().toISOString(), fixturePreflight, pairs, acceptance: comparePairs(pairs), defaultChanged: false }
  await writeFile(join(output, 'results.json'), JSON.stringify(document, null, 2) + '\n')
}
try {
  c = await connectNd()
  const config = await c.evaluate('(async()=>{const s=await window.ndDsh.harness.status();return {state:s.state,provider:s.provider,model:s.model,permissionMode:await window.ndDsh.harness.getPermissionMode()}})()')
  if (config.state === 'running' || config.state === 'starting') throw new Error('ND has active work; cannot restart benchmark profile')
  // The connection targets the existing isolated benchmark ND instance, never a new browser.
  const activeProcess = JSON.parse(await readFile('scratch/project-brief-benchmark/nd-process.json', 'utf8'))
  if (resolve(activeProcess.profile) !== profile) throw new Error('Benchmark profile identity does not match')
  for (const arm of ['baseline', 'candidate']) {
    const preset = join(profile, 'dsh-home/.agent-presets', `nd-coordination-${arm}`)
    await cp(source, preset, { recursive: true, force: true })
    await writeFile(join(preset, 'agent.cordis.yml'), presetSource.replace(marker, arm === 'candidate' ? 'true' : 'false'))
    await writeFile(join(preset, 'preset.yml'), `name: ND Coordination ${arm}\ndescription: Isolated coordination benchmark ${arm}; ND default unchanged.\norder: 99\n`)
  }
  await c.evaluate('window.ndDsh.harness.stop()')
  const presets = await c.evaluate("window.ndDsh.dsh.rpc('agentPresets.list',{})")
  if (!['baseline', 'candidate'].every(arm => presets.value?.presets?.some(preset => preset.id === `nd-coordination-${arm}`))) throw new Error('Benchmark presets were not discovered')
  await writeFile(join(output, 'symlink-target.json'), '{}')
  try { await symlink(join(output, 'symlink-target.json'), join(output, 'symlink-probe.json'), 'file'); await unlink(join(output, 'symlink-probe.json')); fixturePreflight = { symlink: 'supported' } }
  catch (error) { fixturePreflight = { symlink: 'unavailable', code: error.code, limitation: 'Frozen safety check will be unverified; no verified speed ranking or default promotion.' } }
  await save()
  for (let pairIndex = 1; pairIndex <= EXPECTED_PAIRS; pairIndex++) {
    const pair = pairs.find(value => value.pair === pairIndex) ?? { pair: pairIndex, order: pairIndex % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'] }
    if (!pairs.includes(pair)) pairs.push(pair)
    for (const arm of pair.order) {
      if (pair[arm]?.finishedAt) continue
      if (pair[arm]) {
        pair.attempts ??= []
        pair.attempts.push({ ...pair[arm], outcome: 'interrupted', interruption: 'Observer/app connection lost; execution completion and total timing unavailable.', recordedAt: new Date().toISOString(), totalWallMs: null })
        if (pair[arm].sessionId) await c.evaluate(`window.ndDsh.harness.stopSession(${JSON.stringify(pair[arm].sessionId)})`).catch(() => {})
      }
      const accepted = performance.now()
      const attempt = 1 + (pair.attempts?.filter(value => value.arm === arm).length ?? 0)
      const trial = join(output, `pair-${pairIndex}-${arm}${attempt > 1 ? '-attempt-' + attempt : ''}`)
      const workspace = join(trial, 'nd-workspace')
      await mkdir(join(workspace, 'reference'), { recursive: true })
      for (const [file, name] of [['src/shared/extension-package.ts', 'extension-package.ts'], ['schema/nd-extension.schema.json', 'nd-extension.schema.json'], ['examples/extension-counter/mcp-server.mjs', 'mcp-sample.mjs'], ['src/shared/extensions.ts', 'agent-extensions.ts']]) await cp(file, join(workspace, 'reference', name))
      await cp('scratch/workspace-checks-benchmark/nd-workspace/AGENTS.md', join(workspace, 'AGENTS.md'))
      const snapshot = {}
      for (const file of ['AGENTS.md', 'reference/extension-package.ts', 'reference/nd-extension.schema.json', 'reference/mcp-sample.mjs', 'reference/agent-extensions.ts']) snapshot[file] = sha(await readFile(join(workspace, file)))
      const prompt = requirements + '\nAssigned package ID: nd-workspace-checks. Visible name: ND Workspace Checks.\n'
      const receipt = { arm, pair: pairIndex, outcome: 'starting', startedAt: new Date().toISOString(),
        route: { provider: config.provider, model: config.model }, preset: `nd-coordination-${arm}`,
        promptSha256: sha(prompt), inputSnapshotSha256: sha(JSON.stringify(snapshot)), setupWallMs: performance.now() - accepted, modelCacheState: 'unavailable',
        childExecutionOverlapVerified: false, exactChildExecutionIntervals: null, workspace, trialDir: trial, attempt }
      pair[arm] = receipt
      const saveTrial = async () => { await writeFile(join(trial, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); await save() }
      await saveTrial()
      let sessionId
      let state
      try {
        const current = await c.evaluate('window.ndDsh.harness.status()')
        if (current.provider !== config.provider || current.model !== config.model) throw new Error('ND default model/provider drifted; refusing a mismatched run')
        const created = await c.evaluate(`window.ndDsh.dsh.rpc('session.create',{cwd:${JSON.stringify(workspace)},agentPreset:${JSON.stringify(receipt.preset)}})`)
        sessionId = created.value?.sessionId
        if (!created.ok || !sessionId || created.value?.agentPreset !== receipt.preset) throw new Error('Explicit benchmark preset/session creation failed')
        receipt.sessionId = sessionId
        await c.evaluate(`(()=>{window.__ndCoordinationBenchmark={sessionId:${JSON.stringify(sessionId)},events:[]};window.__ndCoordinationUnsubscribe?.();window.__ndCoordinationUnsubscribe=window.ndDsh.dsh.onEvent(frame=>{const b=window.__ndCoordinationBenchmark;if(frame.sessionId===b.sessionId)b.events.push({receivedAt:Date.now(),kind:frame.kind,type:frame.event?.type,time:frame.event?.time,data:frame.event?.data})})})()`)
        receipt.setupWallMs = performance.now() - accepted
        const executionStart = performance.now()
        receipt.outcome = 'running'
        await saveTrial()
        await c.evaluate(`window.ndDsh.harness.run(${JSON.stringify(prompt)},{sessionId:${JSON.stringify(sessionId)},workspaceCwd:${JSON.stringify(workspace)},permissionMode:${JSON.stringify(config.permissionMode)}})`)
        for (;;) {
          state = await c.evaluate('(()=>{const b=window.__ndCoordinationBenchmark;return {events:b.events,terminal:b.events.findLast(e=>e.type==="turn/end")?.data}})()')
          await writeFile(join(trial, 'trace.json'), JSON.stringify(state, null, 2))
          receipt.executionWallMs = performance.now() - executionStart
          receipt.metrics = summarizeEvents(state.events)
          if (state.terminal) { receipt.outcome = state.terminal.reason?.kind === 'completed' ? 'completed' : state.terminal.reason?.kind ?? 'failed'; break }
          if (receipt.executionWallMs > 20 * 60 * 1000) { receipt.outcome = 'timeout'; await c.evaluate(`window.ndDsh.harness.stopSession(${JSON.stringify(sessionId)})`); break }
          await saveTrial()
          await new Promise(done => setTimeout(done, 3000))
        }
        const verificationStart = performance.now()
        receipt.childEvidence = await readChildEvidence(profile, workspace, sessionId, state.events)
        receipt.childExecutionOverlapVerified = receipt.childEvidence.verified
        receipt.exactChildExecutionIntervals = receipt.childEvidence.children.map(child => child.available ? child.intervals : null)
        const verifier = await runProcess(['benchmarks/coordination-policy/scorer.mjs', 'nd'], { ND_COORDINATION_TRIAL_DIR: trial })
        await writeFile(join(trial, 'verifier-process.json'), JSON.stringify(verifier, null, 2) + '\n')
        receipt.verificationWallMs = performance.now() - verificationStart
        try {
          const score = JSON.parse(await readFile(join(trial, 'nd-score.json'), 'utf8'))
          receipt.verification = { passed: score.passed, score: score.score, checks: score.checks.map(({ label, passed, error, points }) => ({ label, passed, error, points })) }
        } catch { receipt.verification = { passed: false, score: null, reason: `Verifier did not produce a result (exit ${verifier.code})` } }
      } catch (error) {
        receipt.outcome = 'blocked'
        receipt.error = error.message
        if (sessionId) await c.evaluate(`window.ndDsh.harness.stopSession(${JSON.stringify(sessionId)})`).catch(() => {})
      }
      receipt.totalWallMs = performance.now() - accepted
      receipt.finishedAt = new Date().toISOString()
      await saveTrial()
      console.log(JSON.stringify({ pair: pairIndex, arm, outcome: receipt.outcome, seconds: receipt.totalWallMs / 1000, score: receipt.verification?.score, polls: receipt.metrics?.statusPolls }))
    }
  }
  console.log(JSON.stringify(comparePairs(pairs)))
} catch (error) {
  const failure = { outcome: 'blocked', message: error.message, time: new Date().toISOString(), pairsDispatched: pairs.length }
  await appendFile(join(output, 'preflight-failures.jsonl'), JSON.stringify(failure) + '\n')
  await writeFile(join(output, 'preflight-failure.json'), JSON.stringify(failure, null, 2) + '\n')
  throw error
} finally {
  if (c) { await c.evaluate('window.__ndCoordinationUnsubscribe?.()').catch(() => {}); c.close() }
}
