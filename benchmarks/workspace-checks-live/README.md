# Workspace Checks: delegated build and multitasking results

Follow-up to the Project Brief trial in “Run dev”. Measured on 2 October 2026 (Asia/Phnom_Penh). ND application/core, provider settings and prior generated extensions were left unchanged. New generated ND Workspace Checks files are copied byte-for-byte and hashed in results.json.

| Live extension build | Model | Build/attempt time | Score | Checks | Actual children | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| ND default | ag/gemini-3.8-flash-medium | 7.93 min | 90/100 | 17/19 | 2; simultaneous running observed | Artifact delivered; verification incomplete |
| GPT / Codex CLI | gpt-6-astra requested | 13.13 min stalled attempt | unavailable | unavailable | unavailable | Network blocked before model execution; no artifact |

There is **no verified live speed winner**. ND's 475.67-second build completed, but full independent verification did not pass. CLI never reached the model, so neither its failed attempt time nor the previous single-task trial establishes a delegated speed comparison. Its configured model had been rejected in the earlier trial; the same authenticated supported default was requested per invocation, with saved configuration unchanged.

ND's frozen scorer passed 17 of 19 checks. Five points were unverified because Windows refused creation of the escaping file symlink fixture (EPERM), including a rerun with OS access. Five points failed the documented setup threshold: its generated README does not name the Extensions menu. Source remains as delivered; no repair or scoring rule changes were made. Native manifest, protocol, script inventory, argument rejection, input-size limit, refresh and Markdown checks passed.

Both ND children were observed running in real parent list_agents snapshots. Their catalog creation timestamps differ by 4 ms. Exact child intervals are unavailable through the current durable-child history bridge. The parent made 103 tool calls, including 31 status polls, and 103 assistant/model messages. These counts cover the parent, not aggregate child tokens/cost. A matched delegation-off run is required before claiming that delegation made this workload faster.

## Fresh independent-task runtime test

| Batch | Verified | Span | Peak concurrency |
| --- | ---: | ---: | ---: |
| Four sequential tasks | 4/4 | 9.988 s | 1 |
| Same four tasks in parallel | 4/4 | 2.398 s | 4 |
| Five tasks through four-worker queue | 5/5 | 9.948 s | 4 |

The four-task batch took **4.17× less elapsed time** in parallel in this run. This is an offline fixture measuring production orchestration/worktree/verification overhead; it excludes real model latency and is not a live ND-versus-Codex throughput result. All 136 benchmark checks passed. Across 22 attempts, 19 verified and the two deliberate failure scenarios plus cancellation were correctly recorded. The initial sandbox attempt timed out; its OS-access retry produced the saved receipt.

## Useful artifacts and validation

- [ND Task Results](../../extensions/nd-task-results/README.md): reads saved receipts, recomputes machine-verified outcomes and interval overlap, exports Markdown, and rejects workspace escapes and missing counters. Installed and legacy MCP-registered in the existing isolated ND benchmark profile; actual gateway call returned fresh results. Thirty targeted tests pass.
- [ND Workspace Checks](../../extensions/nd-workspace-checks/README.md): generated live by ND with actual child delegation; lists package scripts and available verification commands without executing them. Full automation score and limitations are above. Native package install requires separate legacy MCP executable registration for current catalog-consuming engines.
- [Task Results export](task-results.md), [machine receipts](results.json), [fresh offline runtime receipt](runtime-receipt.json), [ND independent checks](nd-checks.json), [ND child evidence](nd-child-evidence.json).

Static verification, typecheck and build passed. The full test suite had six sandbox failures in Windows process inventory/cleanup tests; all 12 tests in the affected files passed with OS access. The final new extension suite passed 30/30. No commit or publishing occurred.

## Review before improving ND

Use independent file ownership for children and integrate once. This trial shows 31 repeated parent status polls; a follow-up can compare bounded event waits against this baseline, while recording total model calls, child overlap and integration time. Keep workload/model/checks identical for delegation off/on. A live independent-job batch at concurrency 1/2/3 remains a separate gate; the successful offline batch is not a substitute.

Automatic approval review rejected a network-enabled Codex retry because it could send workspace contents to OpenAI. A retry requires explicit approval to send this benchmark's requirements, reference schemas/sample, and generated isolated-workspace files to OpenAI through the authenticated Codex CLI; generated commands remain workspace-write sandboxed. The blocked 13.13-minute attempt remains in the record.
