# Project Brief live benchmark

Measured on 2026-10-02 (Asia/Phnom_Penh). Both implementations were generated independently by real authenticated coding runs. ND application/core source and saved model/provider settings were unchanged. The copied extension sources match the delivered artifact hashes in results.json.

| Runner / model | Score | Build time | Check time | Passed checks | Reported tokens | Current repository |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| ND default: ag/gemini-3.8-flash-medium | 95/100 | 7m 18s | 4.0s | 20/21 | 2,807,168 | Brief returned |
| GPT / Codex CLI: gpt-6-astra (high) | 95/100 | 9m 9s | 2.8s | 20/21 | 280,343 | Git metadata rejected |

Quality scores are tied at 95/100 under the fixed rubric. ND default produced its submitted artifact sooner. Build speed is reported separately from full verification: ND's 95/100 submission has a failed packaging check, so there is no successful time-to-verified-completion comparison for the original pair. Both executables passed the fixture runtime behavior checks. In the additional real-repository gateway check, ND returned a brief and GPT returned an explicit error: "External/shared Git metadata is not supported within a bound workspace." This repository has registered worktrees under .git/worktrees, whose commondir metadata is rejected by GPT's recursive check. That additional compatibility finding does not change the fixed score. ND was faster and usable on this repository in this one trial.

## Delivered extensions

- [ND Project Brief](../../extensions/nd-project-brief/README.md): unchanged ND-generated source.
- [GPT Project Brief](../../extensions/gpt-project-brief/README.md): unchanged GPT-generated source.

Downloadable source packages: [nd-project-brief.zip](../../artifacts/project-brief-benchmark/nd-project-brief.zip) and [gpt-project-brief.zip](../../artifacts/project-brief-benchmark/gpt-project-brief.zip).

These are on-demand MCP tools with native ND package manifests, rather than a new native dashboard. Each package contributes project_brief, project_brief_export, and a skill. Use separate IDs to register both. In current ND, native package installation and registration in Settings > Agent capabilities > MCP Servers are separate. Both were installed and registered in the isolated benchmark ND profile; the user's original profile was not changed.

For each MCP entry, set Command to node and Arguments to the absolute path of that package's mcp-server.mjs, followed by --workspace and your absolute project folder, one argument per line. Keep environment references empty. Enable each entry, then ask ND Agent to use nd-project-brief or gpt-project-brief explicitly. The existing ND gateway selects the extension by its ID, so their identical tool names can coexist. The source is .project-brief/tasks.json, an explicitly configured extension input; this release does not read ND's organization task database automatically. Missing input is reported honestly.

## Preserved findings

ND's nd-extension.example.json and its README example use runtime as a string, put transport fields at the top level, and use objects for engineRoutes/providerRoutes. ND expects runtime: {kind: 'mcp-stdio', command, args, env} and route arrays. The native manifest and runtime tools work, but the legacy template fails the frozen packaging check. The as-delivered files remain unchanged. Manual catalog configuration through the existing ND API made the executable usable; that workaround remains visible in the results and was excluded from build time.

- GPT finding: Real executable, documentation, and MCP registration template: Invalid MCP registration template

GPT's legacy template also uses a string for runtime instead of the required transport object. Both source templates remain unchanged; both catalogs were configured manually with valid transport fields in the isolated ND profile. GPT also embeds its original build-workspace absolute path in the native manifest; moving that package requires the documented path configuration. Its code rejects linked worktrees and primary repositories containing registered worktree commondir metadata (mcp-server.mjs:118).

ND made 36 observed model calls and 35 tool calls; no subagent tool call was observed. CLI commands/model messages are recorded separately in results.json because its event granularity differs. Token totals are provider-reported and include reported cache usage; billing and cost are unavailable.

## Method and limits

One build per runner, ND first and GPT second, identical requirements/reference files except package identity. Weights were fixed before dispatch: packaging/install 15, protocol 15, Git 20, tasks 20, safety/read-only 15, export 10, documentation 5. The v1 executable scorer was hashed before original grading. It reported ND 95 and GPT 80, but three GPT failures were evaluator false positives: valid Markdown punctuation escaping in two export checks, and whitespace wrapping in one documentation check. v1.1 normalizes those representations identically for both artifacts, with no weight or source changes, and reports 95 for each. Both original result files and the v1 source are retained for audit alongside v1.1. It validates actual Git changes (including rename/Unicode), task filtering, source errors, refresh, workspace confinement, an escaping junction, read-only operation, export, real package install, and documentation. Fixture data is labeled test input; no fixture substitutes for a model run.

ND kept its saved default nd-harness route and ag/gemini-3.8-flash-medium model. GPT CLI 0.155.0 rejected the locally configured gpt-6.1-sol model before it began coding; the authenticated catalog reported gpt-6-astra as default, so that model was selected for the actual build, retaining configured high reasoning. No saved CLI settings changed. The initial ND profile lacked Chromium encryption metadata; preserving the original Local State resolved that benchmark setup failure before the scored run. Both setup failures remain in results.json and the private raw receipts.

Build time includes native runner startup/dispatch, model/tool work, and self-tests through completion. External check duration is separate. Setup, operator idle between stages, and manual registration are excluded. ND completion has up to about two seconds of polling overhead. These different models and native stacks support a conclusion about this workload on these installations. Repeated, subagent, and batch benchmarks have not run.

## Evidence and reproduction

[Installation screenshot](extensions-installed.png) shows both native packages in the actual isolated ND benchmark profile. Their native project activation still requires an active ND company/project; the measured MCP gateway checks used separately registered catalog entries bound to the repository.

Review [results.json](results.json), [ND checks](nd-checks.json), [GPT checks](gpt-checks.json), and [frozen requirements](requirements.txt). Live driver files, private profile/credentials, raw traces, and test workspaces remain gitignored in scratch/project-brief-benchmark. score.mjs is the v1.1 semantic-corrected scorer; score-v1.mjs and the *-checks-v1.json files retain the original evaluator and results. Both are retained for review. It expects that original scratch layout and a running ND benchmark renderer at loopback port 9222; it creates fresh test workspaces and installs the selected package in that profile. It does not run coding agents or fix output.

The structured-trace and deterministic-check approach follows [OpenAI's evaluation guidance](https://developers.openai.com/blog/eval-skills). No ND improvement is applied before the user's review.
