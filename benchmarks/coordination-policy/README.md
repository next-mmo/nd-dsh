# ND coordination policy results

Five planned matched Workspace Checks pairs were attempted, alternating baseline/candidate order, on the unchanged ND default route. 12 fresh performance sessions used isolated workspaces and benchmark-only presets, including retained interrupted attempts. 3 pairs completed both arms. Default behavior remains unchanged. The candidate adds foreground-v1 instructions and keeps the existing tool catalog, provider/model and concurrency limits.

| Pair | Policy | Outcome | End-to-end seconds | Frozen score /100 | Parent model messages | Status polls | Observed child peak |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | baseline | completed | 502.88 | 85 (recovery) | 64 | 12 | 2 |
| 1 | candidate | completed | 584.06 | 90 | 42 | 0 | 2 |
| 2 | candidate | completed | 406.76 | 90 | 43 | 0 | 2 |
| 2 | baseline | blocked | 261.24 | unavailable | 32 | 10 | unavailable |
| 3 | baseline | completed | 693.33 | 85 | 78 | 15 | 2 |
| 3 | candidate | completed | 960.88 | 90 | 47 | 0 | 2 |
| 4 | candidate | completed | 700.47 | 85 | 44 | 0 | 2 |
| 4 | baseline | completed | 479.71 | 85 | 69 | 16 | 2 |
| 5 | baseline | completed | 546.16 | 90 | 71 | 12 | 2 |
| 5 | candidate | blocked | 300.72 | unavailable | 15 | 0 | 2 |

Acceptance: **inconclusive**. Eligible fully verified pairs: 0/5. Default promotion remains disabled. Frozen symlink checks that cannot execute are unverified, never passed. Descriptive durations and parent counters do not establish a verified speed improvement.

Across four completed runs per arm (different pair subsets), baseline/candidate descriptive medians were 524.52s / 642.26s, 70 / 43.5 parent message events, and 13.5 / 0 status polls. These are unverified observations, not a paired speed ranking.

Timing starts before workspace setup and ends after verification. Blocked-arm times end at the observer error and are not completion times. Integration timing uses the last foreground result through parent termination and includes review/tests; background integration boundaries remain unavailable. Child overlap comes from parent- and workspace-attributed durable turn/start and turn/end journal events, rather than tool dispatch assumptions. Missing child data is unavailable. Parent message events do not expose hidden provider retries. Model cache state is unavailable, and shared-host load is uncontrolled. 3 completed samples lack pre-run input snapshot hashes; their post-run input equality is recorded without claiming stronger evidence. Fixture preflight: unavailable (symlink). Individual verifier errors are retained.

Failure exercise: 7 observed child terminal events reached max-tokens; 1 ended aborted/canceled. Scoped cancellation was requested for blocked turns; an unfinished background journal cannot establish clean cancellation. The separate ownership/common-verification fixture outcome is **failed**. Shared file preserved: true; separate-file label assertion: false; common verification invoked: true; failure honestly reported: true. Its raw failure is retained and it is excluded from performance. A fresh v2 fixture clarified the exact A/B label requirement without changing the failed common verifier; retest outcome: **passed**. Both the original failure and retest receipts are retained. This is behavioral evidence only, excluded from timing. Receipt tests and real worktree tests also exercise cancellation, conflicting integration and unsuccessful verification accounting.

Repository check exit codes: verify 0, typecheck 0, test 0, build 0. Full suite: 1179 passed tests and 9 skipped. No upstream source was patched.

The scorer checks and weights are unchanged; only its fixture/artifact root is adapted. The first verifier failed to write its receipt because its requirements companion was missing. A later rerun restored that companion without altering generated output; both the original failure and recovery are recorded, with recovery outside the timing window. Every trial, failure, outcome and check is retained in results.json. Raw traces and generated outputs remain in ignored scratch/coordination-policy for inspection. The benchmark observer performed no output repair.

See [policy and usage](../../docs/plan/nd-coordination-policy.md), [receipts](results.json), and [frozen contract](contract.json). Required repository checks are recorded in the completion report. No commit or publication is automatic.
