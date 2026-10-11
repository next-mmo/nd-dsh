# ND Task Results

ND Task Results reads saved ND task benchmark receipts and returns verified outcomes, timing, counters and observed execution overlap. It recomputes results from individual `task-execution` samples; stored summary claims are ignored. Planning and review runs are excluded from execution totals.

## Installation

You can install this directory as a native package from ND **Extensions** to register its metadata and contributed skill. Installing a native package does not register its server in the MCP catalog. The current ND native extension bridge does not execute executable package tools, so native installation alone does not make these tools callable.

To use the tools, open **Settings > Agent capabilities > MCP Servers** and register the supplied `nd-extension.example.json` as a separate stdio MCP server. Keep `enabled: false` while configuring it. Replace the example `serverPath` and first `args` entry with the absolute path to this directory's `mcp-server.mjs`, then set the `--workspace` argument to the absolute project root. Review the executable command, grant trust as requested by the app, and enable the server. Use an agent engine that consumes the configured MCP server catalog.

The runtime needs Node.js and has no npm dependencies. The workspace is fixed once at process startup. Standalone MCP clients must set their subprocess working directory to the project root, or supply `--workspace` once at startup:

```sh
node /absolute/path/to/nd-task-results/mcp-server.mjs --workspace /absolute/path/to/project
```

No tool argument can change that workspace. The server reads JSON on demand, performs no writes, makes no network requests, and starts no polling or background jobs.

## Tools

| Tool | Result |
| --- | --- |
| `task_results` | JSON containing verified completions, failed/canceled/interrupted/unverified/unfinished counts, duration statistics, counters and interval overlap, including per-pass results. |
| `task_results_export` | Markdown report returned as text. It does not save a file. |

Both accept only an optional `resultsPath`, relative to the bound workspace. The default is `benchmarks/baselines/agent-task-normal-loop.json`. For a newly recorded run, point to that run's receipt instead:

```json
{"name":"task_results","arguments":{"resultsPath":"benchmark-results/my-run/agent-task-metrics.json"}}
```

Ask ND Agent: “Read our saved task results and compare sequential-4x with parallel-4x. Include verified completions and observed overlap.” For sharing: “Export these task results as Markdown.”

## Evidence and limits

A completion requires all four recorded gates: completed outcome, passed machine verification, `completedTask: true`, and `finished: true`. Failed and unfinished attempts remain in the report. Timestamp ties apply an interval end before a new start; zero-duration or unfinished intervals cannot establish overlap.

The committed default receipt is an **offline fixture** with timing that **excludes model latency**. Its overlap measures task execution overhead. It does not prove live AI speedup or child subagent execution. Run the product's task benchmark separately to capture new evidence; this extension only reads existing receipts. `overlapFactor` is the sum of finished interval lengths divided by their total span, not a matched sequential-versus-parallel speedup claim.

Files are limited to 8 MiB. Absolute paths, traversal and symlink/junction escapes are rejected. Reports contain aggregate allowlisted fields rather than raw prompts, session identifiers, workspace paths or arbitrary pass names. Missing, malformed or unsupported receipts produce explicit errors.

Each recorded execution sample must contain all required counters. A per-verified-completion counter is `null` when there are no verified completions, because that denominator has no measured result.

## Validation

From the repository root:

```sh
node node_modules/vitest/vitest.mjs run tests/nd-task-results.test.mjs
```

Tests exercise saved receipt accounting, adversarial completion gates and intervals, workspace containment, the file limit, safe output, and a real MCP child process through initialize, tools/list and tools/call. Their runtime is local reporting overhead, not a model or desktop task execution benchmark.
