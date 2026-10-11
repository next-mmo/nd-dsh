# On-demand ND / ChatGPT benchmark extension

Status: first live evaluation completed; awaiting user review, 2026-10-02.

The unchanged, independently generated outputs are available in
`extensions/nd-project-brief/` and `extensions/gpt-project-brief/`.
See the [measured comparison and findings](../../benchmarks/project-brief-live/README.md).
Both scored 95/100 (20/21 checks); artifact delivery took ND 7m 18s and GPT CLI
9m 9s. Both registration templates failed a packaging check. ND returned a brief
on the current repository; GPT rejected its registered-worktree Git metadata.
No ND application/core improvements or operator repairs were applied.

## Current evaluation scope (supersedes the earlier implementation proposal)

The user requested real, independently built extensions and one measured
comparison table before any improvements to ND. Run ND with its saved default
engine/provider/model and GPT through the installed Codex CLI with its configured
default model/reasoning settings where supported. The live ND preflight selected `nd-harness`
and `ag/gemini-3.8-flash-medium`; Codex CLI 0.155.0 is configured for
`gpt-6.1-sol` with high reasoning effort. The authenticated CLI rejected that
model before coding; its supported catalog default `gpt-6-astra` was used for
the scored invocation with high reasoning, without changing saved settings.
These are different models and native
tool systems, so results compare the installed products with their defaults.

Do not change ND source, core, engine adapters, schemas, provider routes, or
model settings to improve this evaluation. Keep defects and delivered outputs
as evidence and wait for the user's review before fixing ND. Use the existing
MCP extension interface instead of the proposed new benchmark host API below.
Deliver `nd-project-brief` and `gpt-project-brief` separately, with actual
package-install and executable-transport checks. The first evaluation is one
first-attempt build pair; repeated/subagent/batch trials remain future work.

Freeze identical requirements and score weights before dispatch: packaging/ND
install 15, MCP protocol 15, Git correctness 20, task behavior 20, workspace
safety/read-only behavior 15, Markdown export 10, setup documentation 5.
Total score is 100; time and observable token/tool usage are separate columns.
Report unavailable metrics as unavailable, and failed runs as failed. Do not
claim a successful speed winner without verified completion on both sides.

The useful delivered capability reads actual Git changes and an explicitly
configured `.project-brief/tasks.json` source in the bound workspace, offers
task filters and evidence-derived next actions, and returns a Markdown export.
The task-source format is a documented extension input, not an integration with
ND's organization task database. Tests use clearly identified fixture inputs;
the coding runs themselves use real authenticated model execution.

Benchmark drivers, private copied profile data, fixture workspaces, and raw
receipts stay in the already ignored `scratch/project-brief-benchmark/` directory.
Only extension source and the redacted evaluation report are delivery artifacts.
The isolated profile must preserve Chromium `Local State` alongside encrypted
provider secrets so authentication preflight reflects the real saved defaults.
Keep setup failures visible and separate from scored model execution.

## Earlier proposal (future work; no ND host/core changes authorized now)

Build a small ND extension named **Agent Benchmark** that runs useful project
work on demand and records how long it takes to produce a verified result.
The user chooses the runner with `-nd` or `-gpt`. Keep the extension available
for ordinary work after the initial comparison.

## User experience

Enable Agent Benchmark for a project from ND Extensions. Opening its launcher
command shows recent runs and comparisons. In the project's chat composer:

```text
-nd Build the Project Brief extension from the benchmark requirements.
-gpt Build the Project Brief extension from the benchmark requirements.
```

The first command creates a benchmark case. The second offers the matching
case as a comparison and reuses its saved starting state, requirements, and
acceptance checks. Pairing is explicit; similar wording alone is insufficient.
Arbitrary project requests can also be recorded as standalone runs.

Each runner produces a distinct, usable extension. Agent Benchmark is the
on-demand runner and results extension; the two Project Brief packages are its
delivered products, both retained and installable together.

| Runner | Package ID and folder | Visible name |
| --- | --- | --- |
| `-nd` | `nd-project-brief` / `extensions/nd-project-brief/` | ND Project Brief |
| `-gpt` | `gpt-project-brief` / `extensions/gpt-project-brief/` | GPT Project Brief |

Give the packages separate launcher entries, activation records, settings,
permissions/grants, and any persisted extension-owned state. Users can enable,
open, refresh, and disable either one independently in the same project. Both
read the same authorized underlying Git/workflow sources. Neither overwrites
the other package's code or stored state. Export filenames include the package
prefix so users can keep both outputs.

Inject the respective package identity into otherwise identical requirements.
Treat this identity difference as required packaging, not a behavioral difference.
Verify the same behaviors after substituting the expected identity. Preserve
each delivered implementation; do not manufacture a second package by renaming
the first runner's output. Initial builds land in isolated run workspaces; offer
installation of each verified package into ND, with its source diff available.

The leading prefix is consumed by ND and is not sent as part of the task.
Only a complete leading token followed by whitespace or end of input matches.
Reject an empty task. When the extension is disabled, tell the user how to
enable it; do not silently send a benchmark prefix to the current model.
Messages without a prefix keep their existing behavior.

Each benchmark starts a new session. A prefixed message in an existing chat
creates a linked run instead of changing that session's engine. Display the
runner, engine, observable model, execution mode, status, elapsed time,
verification result, and artifact link. Include Cancel, Repeat, Compare,
and Export actions. Run only when requested; no scheduled work.

## Runner selection and current limitations

| Prefix | Planned route | Conditions |
| --- | --- | --- |
| `-nd` | Explicit ND engine setting, initially `nd-harness` for coding | Record provider/model and check required capabilities. Allow `nd-native` only for cases its tools support. |
| `-gpt` | Existing `chatgpt-web` adapter | Use the signed-in ChatGPT project in ND's visible browser and record the observable model, or `unknown`. |

`-gpt` means ChatGPT web in this plan. If the intended target is Codex, bind it
explicitly to `codex-cli` and label the runner Codex; do not combine its samples
with ChatGPT web samples. Never silently substitute an engine or model.

Current repository evidence:

- `src/shared/coding-engines.ts` describes ChatGPT web without direct workspace,
  filesystem, shell, MCP, or streaming capabilities. Organization workers require
  workspace capability, so this adapter cannot simply be assigned as a worker.
- `src/main/engines/chatgpt-web/chatgpt-web-engine.ts` allows only one active
  ChatGPT turn across ND's visible browser pane. Its code transport uses a
  session-owned remote Git branch. A readable answer is not proof of delivered code.
- `src/main/metrics/task-metrics.ts` already records production task wall time,
  tool calls, model calls, tokens, and verification. Completion requires passing
  machine verification. Its samples are organization-run scoped; interactive
  ChatGPT runs need separate receipts with equivalent outer timing boundaries.
- `src/shared/extension-package.ts` provides allowlisted native commands and
  list/detail views. It currently has no benchmark execution or results host API.

Check login, project binding, Git transport, engine availability, and verifier
readiness before dispatch. ChatGPT requests queue through the existing visible
browser. Missing remote code delivery produces a blocked or unverified result.
The extension must not fabricate local tool or subagent activity for ChatGPT.

## First useful workload: Project Brief extension

Project Brief answers "What changed, what is blocked, and what should I do next?"
when a user returns to a project. It provides a useful daily capability after the
benchmark. Both runners receive the same small project and these requirements:

1. Create an installable extension with a valid manifest and launcher entry.
   The ND runner delivers `nd-project-brief`; the GPT runner delivers
   `gpt-project-brief`. They must be usable side by side.
2. Show changed files with added, modified, deleted, and untracked status.
3. Show open and blocked tasks from ND's existing read-only project workflow
   snapshot, with links back to their source and the snapshot's freshness.
4. Provide an on-demand Refresh action and filters for Changes, Open tasks, and
   Blocked tasks. Missing workflow configuration appears as a setup state.
5. Deliver actual source artifacts plus brief installation instructions.

Use native list/detail views and the existing workflow reader. Supply a narrow,
read-only Git-status host projection and the supported scaffold identically to
both runners before timing starts; the current extension host allowlist does not
expose Git status. Keep file paths, statuses, and task evidence project scoped.
Filtering can initially use separate launcher commands and native list views.
No polling is required while the extension is closed.

Freeze the checks before starting: manifest validation; exact Git statuses for
added/modified/deleted/untracked files; correct open and blocked task filtering;
source links; refresh after changes; clean-project and unconfigured-workflow
states; stale snapshot labeling; isolation between two project contexts; and a
visible ND install/open demonstration. The fixture includes filenames with spaces
and Unicode. Behavior checks are independent of the runner's implementation and
cannot be edited by the runner. An ND-side verifier applies the same checks to
both delivered artifacts.

Additionally install both packages together and verify distinct launcher entries,
independent activation/settings/state, successful refresh of both, and continued
operation of one after disabling the other. Retain separate source and artifact
links in the comparison receipt so users can try the actual outputs.

A second task adds a concise "Next actions" brief and Markdown export for
standups or handoff. Derive recorded blockers from actual task evidence and label
inferred next steps as suggestions. The initial version can use deterministic
ordering (blocked, in progress, then open) rather than requiring another model
call. It must not invent test outcomes or blockers. This provides a natural
follow-up benchmark with useful product behavior.

Start with one exploratory run per runner. Then repeat five paired trials with
fresh sessions and identical starting snapshots, alternating runner order.
Report the sample count; five pairs provide an initial comparison, not a broad
claim about all workloads.

## Comparison rules

Use **time to verified completion** as the primary result. Start a monotonic
clock when ND accepts the requested run; finish after the output is delivered
and the common verification passes. Record queue, setup, execution, Git/artifact
delivery, and verification time separately. Keep approval waits in the end-to-end
time and also report them separately. Record user interventions and repair attempts.

Measure first visible output only when observable. The ChatGPT adapter does not
currently emit streaming events; show unavailable until actual timing is added.
Unknown token counts, costs, tool counts, and model identities remain unknown.
Never interpret missing telemetry as zero.

Preserve identical task content, input snapshot hash, verifier version, timeout,
and acceptance criteria. Record engine/runtime versions, provider/model settings,
session freshness, cache/warm-up state, concurrency, and transport differences.
Declare whether the comparison measures whole products with their native tools
or equal tools and models; the first release measures whole product delivery.
Separate shared output-only cases from code-delivery cases that include Git sync.

Show pass rate, median verified duration, duration range, and paired speed ratio.
For successful matched pairs, `GPT duration / ND duration` greater than 1 means ND
was faster. Report paired successes and every failure alongside the ratio. If a
runner fails verification, the successful runner is the only verified finisher;
there is no successful speed ratio for that pair. Never rank timeouts, cancellation,
blocked transport, or early failures as speed wins.

For user-defined tasks without fixed machine checks, retain useful timings and
mark completion unverified or manually reviewed; exclude them from the verified
speed ranking. Record repairs as part of the original run's elapsed time.

## Single-task, subagent, and multitask stages

| Stage | Workload | What it answers |
| --- | --- | --- |
| 1: Single task | Build Project Brief with one runner session | Which route delivers the same verified artifact sooner? |
| 2: Subagent | One parent task with implementation, tests, and review child work | Does ND delegation improve verified delivery time versus its single-agent baseline? |
| 3: Multitask | Independently implement changed-file reporting, task/blocker reporting, and brief export against the same scaffold | How long does each route take to finish the same batch, and how many pass? |

For stage 2, keep the task and route fixed, then compare ND with delegation off
and with delegation enabled. Instrument actual parent/child session events,
child time overlap, handoff wait, integration/review time, and child failures.
Reuse existing ND organization/session orchestration; do not simulate children.
Keep policy changes run scoped; do not change the company's delegation setting
just to run a benchmark. Only label a run delegated when actual children are observed.

ChatGPT subagent internals are not exposed by the current adapter. Mark that
comparison unsupported unless a route provides real observable child execution.
Whole-task ChatGPT completion remains comparable as a separate product result.

For stage 3, offer concurrency 1, 2, and 3 where supported. Give independent tasks
isolated workspaces. Record requested and effective concurrency. Current ChatGPT
web execution has effective concurrency 1; queue its tasks and show that limit.
Compare an equal-concurrency baseline first, then report each product's available
throughput separately. Measure batch time from acceptance to the final verified
task and show per-task results and completed tasks per minute.

## Small implementation boundary

Use `nd.extension/1` for a project-only built-in package at
`extensions/agent-benchmark/nd-extension.json`. Keep orchestration in ND's main
process, reached through the extension invocation broker. No separate daemon,
new provider SDK, or background browser is needed.

Proposed components and contracts:

- `src/shared/benchmark.ts`: prefix parser, case/run/pair records, modes, and
  typed inputs/results. Resolve runner settings separately from organization state.
- `src/main/benchmarks/benchmark-service.ts`: preflight, snapshots, route dispatch,
  queue, timing, cancellation, artifact collection, and common verification.
- `src/main/benchmarks/benchmark-store.ts`: project-scoped persistent receipts,
  restart recovery, paired results, and content-redacted exports.
- Extend `ND_EXTENSION_PERMISSIONS` and `ND_HOST_METHODS` with narrow
  `benchmark.read`, `benchmark.run`, and `benchmark.export` permissions plus
  `benchmark.start`, `benchmark.list`, `benchmark.get`, `benchmark.cancel`,
  and `benchmark.export` methods. Cancellation must address a run in the caller's
  trusted project. Broker trust/policy checks remain authoritative.
- Register these methods in `src/main/extensions/nd-ipc.ts`; update the manifest
  schema and bundled package registry with the same contracts.
- Reuse native list/detail views for history, status, and results. Launch requests
  and choose a paired case through a compact ND-owned composer integration;
  render its fields with existing components. Packages do not inject renderer code.
- Integrate the leading prefix at the trusted chat dispatch boundary, with the
  composer displaying the selected runner and case. Renderer parsing is a preview;
  main-process validation decides context, enabled state, pairing, and route.

Persist receipts before dispatch, subscribe before starting work, and close timing
exactly once. Ignore late events after cancellation and cancel actual engine/child
work, not just the timer. Recover unfinished runs as interrupted after restart.
Snapshot dirty user files explicitly without altering their checkout. Give both
runners isolated copies from that snapshot and retain the outputs for review.
Any ChatGPT remote branch preparation follows its existing scoped Git transport;
surface remote effects before dispatch and do not push to the user's main branch.

## Delivery and validation

1. Implement parsing, scoped case/run receipts, route preflight, and persistence.
2. Add the package, narrow brokered host methods, composer entry, and history views.
3. Deliver a real ND run with actual artifact verification and cancellation.
4. Wire the existing ChatGPT web route and verify delivered remote artifacts with
   the identical checks. Record unavailable prerequisites as blockers.
5. Run and export the Project Brief paired trials; display results only from real receipts.
6. Add observed ND subagent comparison, then independent-task batch comparison.

Target meaningful checks at prefix boundaries, session isolation, permission and
project ownership, snapshot equivalence, pairing, lifecycle recovery, unsupported
capabilities, cancellation races, and verification failures. Use explicit dummy
credentials or environment references in fixtures. Verify the full user flow in
the running ND app with both available routes; mocks validate lifecycle behavior
but cannot establish live speed results.

Before publishing implementation changes, run the repository-required
`pnpm verify`, `pnpm typecheck`, `pnpm test`, and `pnpm build` checks. Inspect staged
diffs before any commit. Keep benchmark reports free of account tokens and secrets.

The initial release is complete when the extension can be enabled on demand,
both prefixes create real scoped runs, matched artifacts pass the same independent
checks, `nd-project-brief` and `gpt-project-brief` can be installed and used together,
repeated results survive restart, and the UI explains measured time and capability
differences. Subagent and batch stages have separate acceptance gates.

## Evaluation reference

The approach of inspecting execution traces and then using repeatable datasets
and evaluation runs is supported by [OpenAI's agent evaluation guidance](https://developers.openai.com/api/docs/guides/agent-evals).
This plan uses ND-owned receipts and deterministic checks; it does not require
integrating the hosted OpenAI evaluation service.
