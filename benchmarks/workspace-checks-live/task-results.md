# ND Task Results

Offline fixture or overhead-only timing excludes real model latency; this is not proof of live AI or child subagents.

Verified completions: 19/22. Failed: 2. Canceled: 1. Interrupted: 0. Unverified completions: 0. Unfinished: 0.

Finished task mean: 2331.36 ms. Peak observed concurrency: 4. Overlapping time: 7263 ms.

| Pass | Verified/tasks | Mean ms | Span ms | Peak concurrency | Overlap factor |
| --- | ---: | ---: | ---: | ---: | ---: |
| normal-read | 2/2 | 1272 | 3193 | 1 | 0.8 |
| fast-read | 2/2 | 1085 | 2776 | 1 | 0.78 |
| verified | 2/2 | 2140.5 | 5355 | 1 | 0.8 |
| verification-failed | 0/1 | 1435 | 1435 | 1 | 1 |
| engine-failed | 0/1 | 401 | 401 | 1 | 1 |
| canceled | 0/1 | 558 | 558 | 1 | 1 |
| sequential-4x | 4/4 | 1940.5 | 9988 | 1 | 0.78 |
| parallel-4x | 4/4 | 2262.5 | 2398 | 4 | 3.77 |
| overflow-5x | 5/5 | 4617.8 | 9948 | 4 | 2.32 |

Overlap is derived from finished, positive-duration task execution intervals. Model latency scope: excludes-model-latency.
Child subagent evidence: not recorded. Concurrency alone does not establish child agents.
