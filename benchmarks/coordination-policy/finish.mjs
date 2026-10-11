import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join, dirname } from 'node:path'
import { readChildEvidence } from './child-evidence.mjs'
import { comparePairs, median } from './metrics.mjs'

const output = resolve(process.env.ND_COORDINATION_OUTPUT || 'scratch/coordination-policy')
const report = JSON.parse(await readFile(join(output, 'results.json'), 'utf8'))
if (report.pairs.length !== 5 || report.pairs.some(pair => pair.order.some(arm => !pair[arm]?.finishedAt))) throw new Error('Wait for all ten terminal receipts before finalizing')
const profile = resolve('scratch/project-brief-benchmark/private-nd-profile')
for (const pair of report.pairs) for (const receipt of [...pair.order.map(arm => pair[arm]), ...(pair.attempts ?? [])]) {
  const trial = receipt.trialDir ?? dirname(receipt.workspace)
  if (receipt.verification?.score === null) {
    const recovered = await readFile(join(trial, 'nd-score.json'), 'utf8').then(JSON.parse, () => null)
    if (recovered) receipt.verificationRecovery = { ...recovered, reason: 'Requirements companion restored; verifier rerun without output repair, outside original timing window. Original verification failure retained.' }
  }
  if (receipt.sessionId) {
    const trace = await readFile(join(trial, 'trace.json'), 'utf8').then(JSON.parse, () => null)
    receipt.childEvidence = trace ? await readChildEvidence(profile, receipt.workspace, receipt.sessionId, trace.events) : { children: [], verified: false, peakConcurrency: null, reason: 'Parent trace unavailable' }
    receipt.childExecutionOverlapVerified = receipt.childEvidence.verified
    receipt.exactChildExecutionIntervals = receipt.childEvidence.children.map(child => child.available ? child.intervals : null)
  }
  const snapshot = {}
  for (const file of ['AGENTS.md', 'reference/extension-package.ts', 'reference/nd-extension.schema.json', 'reference/mcp-sample.mjs', 'reference/agent-extensions.ts']) snapshot[file] = createHash('sha256').update(await readFile(join(receipt.workspace, file))).digest('hex')
  const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  receipt.inputSnapshotAfterSha256 = hash
  // First experiment started before hash collection was added; retain that fact.
  if (!receipt.inputSnapshotSha256) receipt.inputSnapshotVerification = 'post-run equality only; start hash unavailable'
  else if (receipt.inputSnapshotSha256 !== hash) { receipt.outcome = 'input-mutated'; receipt.inputSnapshotVerification = 'failed' }
  else receipt.inputSnapshotVerification = 'passed'
  await writeFile(join(trial, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
report.acceptance = comparePairs(report.pairs)
report.recovery = await readFile(join(output, 'recovery.json'), 'utf8').then(JSON.parse, () => null)
report.faultCases = await readFile(join(output, 'faults/ownership-and-verification/receipt.json'), 'utf8').then(JSON.parse, () => null)
report.faultRetest = await readFile(join(output, 'faults/ownership-and-verification-v2/receipt.json'), 'utf8').then(JSON.parse, () => null)
report.repositoryVerification = await readFile(join(output, 'repository-verification.json'), 'utf8').then(JSON.parse, () => null)
report.attemptCount = report.pairs.reduce((count, pair) => count + pair.order.length + (pair.attempts?.length ?? 0), 0)
const terminals = arm => report.pairs.map(pair => pair[arm]).filter(receipt => receipt.outcome === 'completed')
report.descriptive = Object.fromEntries(['baseline', 'candidate'].map(arm => [arm, {
  completedRuns: terminals(arm).length,
  unverifiedMedianTotalMs: median(terminals(arm).map(receipt => receipt.totalWallMs)),
  medianParentModelMessages: median(terminals(arm).map(receipt => receipt.metrics.parentModelMessages)),
  medianStatusPolls: median(terminals(arm).map(receipt => receipt.metrics.statusPolls)),
  verifiedSpeedClaim: false,
}]))
await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
await writeFile('benchmarks/coordination-policy/results.json', JSON.stringify(report, null, 2) + '\n')
await writeFile('benchmarks/coordination-policy/contract.json', await readFile(join(output, 'contract.json')))
const seconds = value => value === null || value === undefined ? 'unavailable' : (value / 1000).toFixed(2)
const lines = report.pairs.flatMap(pair => pair.order.map(arm => {
  const r = pair[arm]
  return `| ${pair.pair} | ${arm} | ${r.outcome} | ${seconds(r.totalWallMs)} | ${r.verification?.score ?? (r.verificationRecovery ? r.verificationRecovery.score + ' (recovery)' : 'unavailable')} | ${r.metrics?.parentModelMessages ?? 'unavailable'} | ${r.metrics?.statusPolls ?? 'unavailable'} | ${r.childEvidence?.peakConcurrency ?? 'unavailable'} |`
}))
const pairedCompletions = report.pairs.filter(pair => pair.baseline.outcome === 'completed' && pair.candidate.outcome === 'completed').length
const missingStartHashes = report.pairs.flatMap(pair => pair.order.map(arm => pair[arm])).filter(receipt => receipt.outcome === 'completed' && !receipt.inputSnapshotSha256).length
const observedChildOutcomes = report.pairs.flatMap(pair => pair.order.flatMap(arm => pair[arm].childEvidence?.children.flatMap(child => child.terminalOutcomes ?? []) ?? []))
const faultSummary = report.faultCases
  ? `The separate ownership/common-verification fixture outcome is **${report.faultCases.outcome}**. Shared file preserved: ${report.faultCases.checks?.sharedFilePreserved ?? 'unavailable'}; separate-file label assertion: ${report.faultCases.checks?.separateChildDeliverables ?? 'unavailable'}; common verification invoked: ${report.faultCases.checks?.commonVerificationInvoked ?? 'unavailable'}; failure honestly reported: ${report.faultCases.checks?.failureReported ?? 'unavailable'}. Its raw failure is retained and it is excluded from performance.`
  : 'Separate ownership/common-verification fixture: unavailable.'
const validationSummary = report.repositoryVerification
  ? `Repository check exit codes: verify ${report.repositoryVerification.verify.exitCode}, typecheck ${report.repositoryVerification.typecheck.exitCode}, test ${report.repositoryVerification.test.exitCode}, build ${report.repositoryVerification.build.exitCode}. Full suite: ${report.repositoryVerification.test.passed} passed tests and ${report.repositoryVerification.test.skipped} skipped. No upstream source was patched.`
  : 'Repository validation receipt: unavailable.'
const retestSummary = report.faultRetest
  ? `A fresh v2 fixture clarified the exact A/B label requirement without changing the failed common verifier; retest outcome: **${report.faultRetest.outcome}**. Both the original failure and retest receipts are retained. This is behavioral evidence only, excluded from timing.`
  : 'Clarified-label fault retest: unavailable.'
await writeFile('benchmarks/coordination-policy/README.md', `# ND coordination policy results

Five planned matched Workspace Checks pairs were attempted, alternating baseline/candidate order, on the unchanged ND default route. ${report.attemptCount} fresh performance sessions used isolated workspaces and benchmark-only presets, including retained interrupted attempts. ${pairedCompletions} pairs completed both arms. Default behavior remains unchanged. The candidate adds foreground-v1 instructions and keeps the existing tool catalog, provider/model and concurrency limits.

| Pair | Policy | Outcome | End-to-end seconds | Frozen score /100 | Parent model messages | Status polls | Observed child peak |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
${lines.join('\n')}

Acceptance: **${report.acceptance.status}**. Eligible fully verified pairs: ${report.acceptance.eligiblePairs}/5. Default promotion remains disabled. Frozen symlink checks that cannot execute are unverified, never passed. Descriptive durations and parent counters do not establish a verified speed improvement.

Across four completed runs per arm (different pair subsets), baseline/candidate descriptive medians were ${seconds(report.descriptive.baseline.unverifiedMedianTotalMs)}s / ${seconds(report.descriptive.candidate.unverifiedMedianTotalMs)}s, ${report.descriptive.baseline.medianParentModelMessages} / ${report.descriptive.candidate.medianParentModelMessages} parent message events, and ${report.descriptive.baseline.medianStatusPolls} / ${report.descriptive.candidate.medianStatusPolls} status polls. These are unverified observations, not a paired speed ranking.

Timing starts before workspace setup and ends after verification. Blocked-arm times end at the observer error and are not completion times. Integration timing uses the last foreground result through parent termination and includes review/tests; background integration boundaries remain unavailable. Child overlap comes from parent- and workspace-attributed durable turn/start and turn/end journal events, rather than tool dispatch assumptions. Missing child data is unavailable. Parent message events do not expose hidden provider retries. Model cache state is unavailable, and shared-host load is uncontrolled. ${missingStartHashes} completed samples lack pre-run input snapshot hashes; their post-run input equality is recorded without claiming stronger evidence. Fixture preflight: ${report.fixturePreflight?.symlink ?? 'unavailable'} (symlink). Individual verifier errors are retained.

Failure exercise: ${observedChildOutcomes.filter(value => value === 'max-tokens').length} observed child terminal events reached max-tokens; ${observedChildOutcomes.filter(value => value === 'aborted' || value === 'canceled').length} ended aborted/canceled. Scoped cancellation was requested for blocked turns; an unfinished background journal cannot establish clean cancellation. ${faultSummary} ${retestSummary} Receipt tests and real worktree tests also exercise cancellation, conflicting integration and unsuccessful verification accounting.

${validationSummary}

The scorer checks and weights are unchanged; only its fixture/artifact root is adapted. The first verifier failed to write its receipt because its requirements companion was missing. A later rerun restored that companion without altering generated output; both the original failure and recovery are recorded, with recovery outside the timing window. Every trial, failure, outcome and check is retained in results.json. Raw traces and generated outputs remain in ignored scratch/coordination-policy for inspection. The benchmark observer performed no output repair.

See [policy and usage](../../docs/plan/nd-coordination-policy.md), [receipts](results.json), and [frozen contract](contract.json). Required repository checks are recorded in the completion report. No commit or publication is automatic.
`)
console.log(JSON.stringify({ acceptance: report.acceptance, descriptive: report.descriptive }))
