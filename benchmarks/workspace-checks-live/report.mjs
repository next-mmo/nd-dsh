import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
const directory = resolve('benchmarks/workspace-checks-live')
const base = resolve('scratch/workspace-checks-benchmark')
const read = async path => JSON.parse(await readFile(path, 'utf8'))
const nd = await read(`${base}/nd-receipt.json`)
const ndScore = await read(`${base}/nd-score.json`)
const children = await read(`${base}/nd-children.json`)
const gpt = await read(`${base}/gpt-receipt-network-blocked.json`)
const runtime = await read('scratch/task-results-runtime-retry/agent-task-metrics.json')
const trace = await read(`${base}/nd-trace.json`)
const toolCounts = {}
for (const event of trace.events.filter(event => event.type === 'tool/call')) toolCounts[event.data.name] = (toolCounts[event.data.name] ?? 0) + 1
const files = []
for (const name of ['mcp-server.mjs', 'nd-extension.json', 'nd-extension.example.json', 'README.md']) {
  const original = await readFile(`${base}/nd-workspace/extension/${name}`)
  const delivered = await readFile(`extensions/nd-workspace-checks/${name}`)
  if (!original.equals(delivered)) throw new Error('Delivered artifact differs from original')
  files.push({ path: `extensions/nd-workspace-checks/${name}`, sha256: createHash('sha256').update(original).digest('hex') })
}
const comparison = runtime.parallelComparison
const result = {
  date: '2026-10-02', timezone: 'Asia/Phnom_Penh', task: 'Workspace Checks MCP extension with requested child delegation',
  trialsPerRunner: 1, coreModified: false, producerArtifactRepairs: 0,
  nd: { model: nd.config.model, outcome: nd.outcome, buildWallMs: nd.executionWallMs, score: ndScore.score, maxScore: 100,
    checksPassed: ndScore.checks.filter(check => check.passed).length, checksTotal: ndScore.checks.length,
    fullVerificationPassed: ndScore.passed, verificationWallMs: ndScore.verificationWallMs,
    childCount: children.children.length, bothChildrenRunningObserved: children.bothRunningObserved,
    exactChildExecutionIntervals: null, parentToolCalls: trace.events.filter(event => event.type === 'tool/call').length,
    parentModelMessages: trace.events.filter(event => event.type === 'assistant/message').length,
    toolCounts, failures: ndScore.checks.filter(check => !check.passed).map(({ label, error, points }) => ({ label, error, points })), files },
  gpt: { runner: 'Codex CLI', requestedModel: gpt.config.model, outcome: 'blocked-before-model-execution',
    attemptWallMs: gpt.executionWallMs, modelExecutionObserved: false, artifactsDelivered: false, score: null,
    reason: 'Windows sandbox socket access error 10013 connecting to OpenAI; operator stopped network reconnect loop.',
    retry: 'Automatic approval review rejected network retry because workspace payload and OpenAI destination need explicit user approval.',
    childCount: null, savedConfigurationChanged: false },
  liveSpeedRatio: null, liveWinner: null,
  scope: 'Two different product routes/default model stacks, one requested delegated parent build. No matched delegation-off baseline and no verified live speed winner. CLI launch failed before model execution.',
  multitasking: { source: 'fresh runtime benchmark with deterministic offline CLI fixture', timestamp: runtime.timestamp,
    modelLatencyIncluded: false, acceptanceChecks: runtime.expectations.checked, deviations: runtime.expectations.deviations,
    sequential: comparison.sequential, parallel: comparison.parallel, overflow: comparison.overflow,
    sequentialToParallelBatchRatio: comparison.sequential.spanMs / comparison.parallel.spanMs,
    expectedVerifiedTasks: runtime.summary.completedTasks, attempts: runtime.summary.tasks,
    sandboxAttempt: 'Timed out at 180 seconds before producing a receipt; retry with Windows process access completed all scenarios.' },
  usefulExtension: { id: 'nd-task-results', tests: 30, nativeInstalled: true, legacyMcpRegistered: true,
    gatewayCallPassed: true, profile: 'existing isolated ND benchmark profile' },
  validation: { verify: 'passed', typecheck: 'passed', build: 'passed',
    test: 'Full suite: 1139 passed, 9 skipped, 6 Windows process tests failed under sandbox. All 12 tests in those two files passed on rerun with OS inventory access. Final ND Task Results suite: 30 passed.',
    nativeManifests: 'ND Task Results and ND Workspace Checks passed production manifest validation.' }
}
await writeFile(`${directory}/results.json`, JSON.stringify(result, null, 2) + '\n')
await copyFile('scratch/task-results-runtime-retry/agent-task-metrics.json', `${directory}/runtime-receipt.json`)
await writeFile(`${directory}/nd-checks.json`, JSON.stringify(ndScore, null, 2) + '\n')
await writeFile(`${directory}/nd-child-evidence.json`, JSON.stringify(children, null, 2) + '\n')
const md = `# Workspace Checks: delegated build and multitasking results

Follow-up to the Project Brief trial in “Run dev”. Measured on 2 October 2026 (Asia/Phnom_Penh). ND application/core, provider settings and prior generated extensions were left unchanged. New generated ND Workspace Checks files are copied byte-for-byte and hashed in results.json.

| Live extension build | Model | Build/attempt time | Score | Checks | Actual children | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| ND default | ${result.nd.model} | ${(nd.executionWallMs / 60000).toFixed(2)} min | ${ndScore.score}/100 | ${result.nd.checksPassed}/${result.nd.checksTotal} | 2; simultaneous running observed | Artifact delivered; verification incomplete |
| GPT / Codex CLI | ${gpt.config.model} requested | ${(gpt.executionWallMs / 60000).toFixed(2)} min stalled attempt | unavailable | unavailable | unavailable | Network blocked before model execution; no artifact |

There is **no verified live speed winner**. ND's 475.67-second build completed, but full independent verification did not pass. CLI never reached the model, so neither its failed attempt time nor the previous single-task trial establishes a delegated speed comparison. Its configured model had been rejected in the earlier trial; the same authenticated supported default was requested per invocation, with saved configuration unchanged.

ND's frozen scorer passed 17 of 19 checks. Five points were unverified because Windows refused creation of the escaping file symlink fixture (EPERM), including a rerun with OS access. Five points failed the documented setup threshold: its generated README does not name the Extensions menu. Source remains as delivered; no repair or scoring rule changes were made. Native manifest, protocol, script inventory, argument rejection, input-size limit, refresh and Markdown checks passed.

Both ND children were observed running in real parent list_agents snapshots. Their catalog creation timestamps differ by 4 ms. Exact child intervals are unavailable through the current durable-child history bridge. The parent made ${result.nd.parentToolCalls} tool calls, including ${toolCounts.list_agents} status polls, and ${result.nd.parentModelMessages} assistant/model messages. These counts cover the parent, not aggregate child tokens/cost. A matched delegation-off run is required before claiming that delegation made this workload faster.

## Fresh independent-task runtime test

| Batch | Verified | Span | Peak concurrency |
| --- | ---: | ---: | ---: |
| Four sequential tasks | 4/4 | ${(comparison.sequential.spanMs / 1000).toFixed(3)} s | 1 |
| Same four tasks in parallel | 4/4 | ${(comparison.parallel.spanMs / 1000).toFixed(3)} s | 4 |
| Five tasks through four-worker queue | 5/5 | ${(comparison.overflow.spanMs / 1000).toFixed(3)} s | 4 |

The four-task batch took **${result.multitasking.sequentialToParallelBatchRatio.toFixed(2)}× less elapsed time** in parallel in this run. This is an offline fixture measuring production orchestration/worktree/verification overhead; it excludes real model latency and is not a live ND-versus-Codex throughput result. All 136 benchmark checks passed. Across 22 attempts, 19 verified and the two deliberate failure scenarios plus cancellation were correctly recorded. The initial sandbox attempt timed out; its OS-access retry produced the saved receipt.

## Useful artifacts and validation

- [ND Task Results](../../extensions/nd-task-results/README.md): reads saved receipts, recomputes machine-verified outcomes and interval overlap, exports Markdown, and rejects workspace escapes and missing counters. Installed and legacy MCP-registered in the existing isolated ND benchmark profile; actual gateway call returned fresh results. Thirty targeted tests pass.
- [ND Workspace Checks](../../extensions/nd-workspace-checks/README.md): generated live by ND with actual child delegation; lists package scripts and available verification commands without executing them. Full automation score and limitations are above. Native package install requires separate legacy MCP executable registration for current catalog-consuming engines.
- [Task Results export](task-results.md), [machine receipts](results.json), [fresh offline runtime receipt](runtime-receipt.json), [ND independent checks](nd-checks.json), [ND child evidence](nd-child-evidence.json).

Static verification, typecheck and build passed. The full test suite had six sandbox failures in Windows process inventory/cleanup tests; all 12 tests in the affected files passed with OS access. The final new extension suite passed 30/30. No commit or publishing occurred.

## Review before improving ND

Use independent file ownership for children and integrate once. This trial shows 31 repeated parent status polls; a follow-up can compare bounded event waits against this baseline, while recording total model calls, child overlap and integration time. Keep workload/model/checks identical for delegation off/on. A live independent-job batch at concurrency 1/2/3 remains a separate gate; the successful offline batch is not a substitute.

Automatic approval review rejected a network-enabled Codex retry because it could send workspace contents to OpenAI. A retry requires explicit approval to send this benchmark's requirements, reference schemas/sample, and generated isolated-workspace files to OpenAI through the authenticated Codex CLI; generated commands remain workspace-write sandboxed. The blocked 13.13-minute attempt remains in the record.
`
await writeFile(`${directory}/README.md`, md)
console.log(JSON.stringify({ ndScore: result.nd.score, ndSeconds: result.nd.buildWallMs / 1000, ndChildren: result.nd.childCount, cli: result.gpt.outcome, runtimeBatchRatio: result.multitasking.sequentialToParallelBatchRatio }))
