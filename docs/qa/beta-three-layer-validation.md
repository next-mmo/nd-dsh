# Beta three-layer validation — local RC handoff

> Updated: 2026-09-27  
> Branch: `feat/beta-release-stability-plan-2026-09-27`  
> Purpose: produce reviewable evidence for **Unit -> E2E -> Human** on one exact RC before a supervised beta release.

## Release rule

A beta-exposed P0/P1 feature is ready only when all three independent layers pass:

1. **Unit** — deterministic logic, boundaries, recovery, refusal and failure classification.
2. **E2E** — real Electron/Rust/Git/browser/provider integration and packaged artifact behavior.
3. **Human** — a real tester verifies usability, state truthfulness and OS/browser behavior.

The final machine gate also requires:

- 0 P0;
- 0 core P1;
- repeated scenario pass rate meeting the configured target;
- automated RC summary = PASS;
- clean-machine packaged proof = PASS;
- real Chrome Companion proof = PASS;
- a **24-hour (1440 minute) soak** = PASS;
- explicit Human GO.

An agent must not fabricate the Human layer or final GO.

## Important Private Beta limitation

Provider API keys are currently **desktop-global operator resources**. The shared Harness/gateway consumes one global ProviderStore runtime configuration; keys are not yet isolated per company/project/environment.

For the supervised Private Beta:

- use one trusted human/operator security domain per ND desktop;
- companies/projects may select different provider/model routes, but their API-key storage is not a tenant-secret boundary;
- do not claim that mutually untrusted companies can safely store independent secrets in one ND desktop;
- true company/project/env secret isolation requires a runtime/gateway boundary change and is not faked by this release plan.

All other company/project state and writable task-workspace ownership must still remain isolated.

## What this hardening branch adds

- product-level Git push secret blocking in both normal push and session-branch push;
- explicit HTTP 429 / rate-limit retry classification;
- deterministic **3 companies x 2 projects** E2E matrix with forged cross-company rejection and restart persistence;
- Settings -> About -> Copy diagnostics E2E privacy proof;
- built-in browser runtime proof promoted into the release runner (cookie set/read/clear + real download);
- one-command automated RC runner with JSON receipt;
- Windows forced-nd-core-crash cleanup in the packaged release stage;
- configurable Electron soak harness with process/memory/state samples and JSON receipt;
- final three-layer gate that rejects a soak shorter than 24 hours.
- bounded ND Core restart policy is now explicit and regression-tested (one automatic restart, then fail closed until a stable reset window);
- external-app CDP inspection now validates the **advertised debugger WebSocket** is loopback-only in both the main-process picker and packaged MCP bridge;
- browser download policy now has focused unit coverage for direct user downloads and agent pause/allow/deny/fail-closed behavior;
- provider retry configuration explicitly pins bounded retry classes including `RATE_LIMIT`, so upstream default changes cannot silently remove the beta contract;
- Models UI explicitly states that provider credentials are desktop-profile scoped for supervised Private Beta;
- the surfaces merged from `main` after this branch forked (Quick Launcher, ND Extensions + governed native host, ND Home, General/Coding workspace profiles) are now first-class beta-exposed rows, so the RC gate covers features a tester actually sees. Their existing manual gates — [quick-launcher-manual.md](quick-launcher-manual.md) (M-01…M-27) and [nd-extensions-home-manual.md](nd-extensions-home-manual.md) — supply the Human layer for those rows.

### Known limitation on the extensions row

The extensions/native-host **agent-side bridge is deferred**: run credentials, per-action approval, revocation and expiry exist and are unit-tested, but no coding engine can invoke ND native host methods in a built app yet. The `native-extensions` row therefore covers the user-initiated surface (install/activate/rollback, grants, policy enforcement, real wallpaper) only. Do not record the agent-invokes-native-host acceptance bullet as demonstrable in the Human evidence.

## Required feature evidence map

Use these rows when filling the committed evidence template. Unit/E2E references below are starting points; the Human column must be completed by a real tester on the exact RC.

| Required feature id | Automated evidence to review | Human focus |
| --- | --- | --- |
| `core-agent-flow` | organization orchestrator/reliability tests, full Playwright, `e2e:prod` | idea/task -> worker -> verify -> independent review -> result |
| `company-project-isolation` | portfolio tests + `e2e:beta:matrix` | switch among 3×2 portfolio while work/state remains understandable |
| `parallel-agent-worktree` | execution coordinator, task-worktree, parallel reliability tests | concurrent tasks never overwrite/clean another task or human checkout |
| `git-worktree-secret-safety` | GitService push/branch secret-block tests + worktree tests | inspect real refusal/error and Git diff/state before any push |
| `credential-security-boundaries` | provider secret preservation, env scrub, approval/redaction tests, loopback CDP tests | OS secure storage + desktop-global provider-key limitation is clear |
| `persistence-recovery` | snapshot/recovery/effect-journal tests + restart E2E | close/crash/reopen; no false completion or corrupted ownership |
| `provider-failure-handling` | provider runtime/ping/reliability tests incl. RATE_LIMIT + live model run | network loss, provider outage, missing/bad credential wording/retry |
| `browser-platform` | browser leases/policy/download tests, runtime benchmark, Chrome companion E2E | real permission dialog, screenshot toolbar requirement, recovery |
| `mcp-skills-failure-containment` | extension runtime/router/example MCP recovery tests | break one MCP runtime and confirm the surrounding ND session remains usable |
| `budget-entitlement` | compute/usage/token-saver/tool-routing tests | budget status is understandable and unrelated work is not silently blocked |
| `terminal-filesystem` | terminal/core/path tests + packaged terminal/Git smoke | cancellation, paths, permissions and terminal recovery in the packaged app |
| `diagnostics-observability` | diagnostics/redaction tests + Settings copy-diagnostics E2E | copied report is useful but contains no secret/private project identity |
| `quick-launcher` | `tests/quick-launcher.test.ts`, `e2e/quick-launcher.spec.ts` | global hotkey over/minimized behind another app, popup toggle/focus return, external screen/area capture + annotation, clipboard/URL capture, no orphan process after quit |
| `native-extensions` | `tests/nd-extension-package.test.ts`, `tests/nd-extension-lifecycle.test.ts`, `tests/nd-invocation-broker.test.ts`, `tests/wallpaper-native.test.ts`, `pnpm ext:validate --builtins`, `e2e/nd-home-extensions.spec.ts` | user-authored package install/activate/rollback, deny-wins org policy, grant/revocation, real Windows wallpaper change. The **agent-side native-host bridge is deliberately deferred**: no coding engine can invoke ND native host methods yet, so do not record that acceptance bullet as demonstrable |
| `nd-home` | `tests/nd-extension-lifecycle.test.ts` (Home notes/captures/chats, managed folder, corrupt-record quarantine), `tests/harness-session-scope.test.ts`, `e2e/nd-home-extensions.spec.ts` | ND Home usable before any company exists; personal notes/captures/chats persist and stay out of active-workspace listings |
| `workspace-profiles` | `tests/workspace-profile.test.ts`, `e2e/smoke.spec.ts` (General ↔ Coding shell) | switching General/Coding is understandable and correctly scoped; unsupported actions refuse with clear wording |
| `nd-pencil` | In-repo schema/command/session tests, design bridge + MCP tests, `scripts/verify-design.mjs`, `e2e/design-editor.spec.ts`, `e2e/design-migration.spec.ts` | sketch/agent edit, save and reopen; legacy import preserves a backup; Build into App produces a real project source diff and passing verification |

The evidence file intentionally uses exactly these IDs. `tests/verify-beta-three-layer.test.ts` now checks that the template and final gate cannot drift apart.

For `nd-pencil`, the live `nd_design` edit depends on a bootable ND Harness. A Harness that answers HTTP 401 without publishing its authenticated URL is a Harness blocker, not a pass for the agent-editing bullet; the design bridge and MCP server can still be verified independently.

## 0. Prepare the exact RC

Do not run this from `main`.

```powershell
git fetch origin
git checkout feat/beta-release-stability-plan-2026-09-27
git pull --ff-only
git status --short
git rev-parse HEAD
corepack enable
corepack pnpm install --frozen-lockfile
```

Record the SHA returned by `git rev-parse HEAD`. Do not add feature work after validation begins. If a P0/P1 fix is required, commit it, restart validation, and use the new SHA.

Configure live E2E models from the gitignored local file:

```powershell
Copy-Item .env.e2e.example .env.e2e
# Fill E2E_MODEL_BASE_URL, E2E_MODEL_API_KEY, E2E_MODEL_1, E2E_MODEL_2, E2E_MODEL_3
```

Never commit `.env.e2e`.

## 1. Run the automated Unit + E2E + artifact gate

On the Windows RC machine:

Exact portable payload extraction uses the builder's bundled 7-Zip. The ND
launcher embeds one archive without an outer compression layer so validation
can inspect the same application bytes. Neither the release validation machine
nor the portable application requires a separate extractor installation.

```powershell
corepack pnpm beta:automated
```

This intentionally runs the expensive release set:

- repository verification;
- TypeScript typecheck;
- full Vitest suite;
- Rust fmt/clippy/tests;
- browser-host Rust tests;
- browser platform tests;
- production build;
- full Playwright desktop suite;
- explicit 3x2 beta matrix;
- live-model `e2e:prod` journey/stress;
- built-in browser cookie/storage/download runtime proof;
- ND Core contract benchmark;
- committed agent-task budget check;
- Windows portable package;
- forced nd-core crash/descendant cleanup;
- packaged core/terminal/Git smoke.

Expected final line:

```text
Automated release status: PASS
```

The command writes:

```text
e2e-results/beta-automated-<timestamp>/beta-automated-summary.json
```

On Windows PASS, `release.artifact.identity` inside that JSON is the exact portable filename plus SHA-256 (`<file>#sha256:<64-hex>`). Copy that exact identity into the final evidence `release.artifact`; do not type a different build name manually.

If it says PARTIAL or FAIL, do not continue to GO. The runner deliberately returns non-zero when Windows package evidence, live tests, benchmarks, or any required stage is skipped.

### Fast reruns during fixing

These are useful while fixing one layer, but they do **not** replace the final `beta:automated` run:

```powershell
corepack pnpm test
corepack pnpm e2e:beta:matrix
corepack pnpm e2e:prod
corepack pnpm bench:browser-runtime
corepack pnpm release:smoke:core-crash
corepack pnpm release:smoke:packaged
```

## 2. Run the real Chrome Companion check

Use your normal installed Google Chrome profile only for the dedicated companion test:

```powershell
corepack pnpm e2e:companion:chrome
```

Chrome may show a native optional-host-permission dialog. A real human must answer it.

Verify:

- extension/native host connects;
- intended origin is granted and an ungranted origin is refused;
- snapshot/click/fill/press/scroll/navigation work;
- stale refs fail;
- second writer is refused;
- disconnect revokes leases and reconnect succeeds;
- password values are redacted;
- built-in browser remains usable;
- perform the toolbar invocation needed by Chrome for `captureVisibleTab`, then verify screenshot behavior.

Record tester, date, and receipt path in `releaseChecks.browserCompanionChrome`.

## 3. Clean-machine packaged proof

Use a **clean Windows VM or separate clean machine** with no ND source checkout and no pnpm/Cargo developer environment.

Use the exact artifact produced by the RC run.

Required manual journey:

1. launch/install the packaged RC;
2. create a company and project;
3. link a small Git workspace;
4. configure a supported provider/model;
5. assign a supported coding engine;
6. PM plan -> worker -> machine verification -> independent review -> result;
7. close ND completely;
8. reopen and verify company/project/task/assignment/evidence state;
9. cancel one task and confirm it is not falsely completed;
10. test missing credential and unavailable engine messaging;
11. confirm no source-checkout, pnpm-store, Cargo-target, or developer-only-path dependency.

Git is currently resolved from the OS/PATH in some packaged flows. If the clean machine requires Git, record that as an explicit Private Beta prerequisite until Git is bundled.

Record tester/date/evidence under `releaseChecks.packagedCleanMachine`.

## 4. Run destructive/failure drills on a disposable RC environment

Use a disposable Windows VM/test profile. Do not perform disk-pressure or permission drills on a machine containing important data.

### Network/provider interruption

1. Start a real agent task using a configured provider.
2. Disable the VM network adapter or otherwise remove network access.
3. Confirm the task does not become falsely completed.
4. Confirm the failure is classified as retryable/actionable rather than an auth/config success.
5. Restore network and retry/continue.
6. Confirm project/worktree state remains understandable and no duplicate task result appears.

### nd-core interruption during active work

1. Start a task that owns a real worker/process.
2. In the disposable VM, terminate the ND Core process while the task is active.
3. Confirm managed descendants are cleaned up rather than left as zombies.
4. Reopen/continue ND.
5. Confirm persisted running work is reconciled as interrupted/failed/retryable — never silently completed.
6. Confirm the workspace still contains only explainable task output and the human checkout was not cleaned.

The automated Windows forced-core-crash smoke covers process-tree cleanup; this Human drill covers what the user actually sees after interruption.

### Unwritable data path

1. In a disposable test profile, create a folder the current test user cannot write to (use Windows folder permissions/UI rather than modifying a production ND folder).
2. Launch a test instance with `ND_DSH_USER_DATA_DIR` pointed at that folder.
3. Confirm startup/state persistence fails clearly and does not claim successful durable writes.
4. Restore permissions/use a fresh writable path and confirm ND can start again.

### Disk-pressure / failed-write behavior

Use only a disposable VM or deliberately small test volume; do **not** fill your normal system disk.

1. Run ND user data/workspace on the constrained test volume.
2. Reduce free space until a state/log/artifact write can fail safely.
3. Confirm the previous durable organization state remains recoverable where the atomic-write/backup contract applies.
4. Confirm ND surfaces an actionable failure instead of reporting completion.
5. Free space and restart; confirm the project can be inspected/recovered without editing ND internal state manually.

Record tester/date and concise PASS/FAIL evidence under `releaseChecks.failureDrills`.

---

## 5. Run the 24-hour soak

The soak is skipped during normal `pnpm e2e`; only this dedicated command enables it.

PowerShell:

```powershell
$env:ND_DSH_SOAK_MINUTES="1440"
$env:ND_DSH_SOAK_SAMPLE_SECONDS="60"
$env:ND_DSH_SOAK_MAX_GROWTH_MB="512"
corepack pnpm e2e:beta:soak
```

It keeps one Electron lifetime alive while repeatedly switching a 3x2 company/project portfolio. It samples Electron process working set/process count and continuously asserts:

- exact company/project/task ownership;
- no duplicate entity IDs;
- active company/project correctness;
- renderer responsiveness;
- no unexplained process-count growth;
- bounded working-set growth.

Receipt:

```text
e2e-results/beta-soak/beta-soak-<timestamp>.json
```

The final release gate refuses `durationMinutes < 1440`. Review the start/mid/end memory/process samples manually as well; the numeric threshold is a guardrail, not proof that every leak is impossible.

## 6. Human real-world layer

Run [manual-beta-real-world.md](manual-beta-real-world.md) against the same RC. At minimum manually cover:

- normal idea -> implementation -> review flow;
- existing-code feature;
- bug diagnosis + regression test;
- multi-task dependency workflow;
- reviewer rejection + bounded rework;
- human interruption/manual edit/resume;
- restart/crash recovery;
- Git diff/result inspection;
- provider failure/error wording;
- company/project switching while work remains active.

The automated 3x2 matrix proves deterministic ownership. The human layer must still judge whether the UI makes that ownership and recovery understandable.

## 7. Build the final evidence record

Copy the template:

```powershell
Copy-Item docs/qa/beta-three-layer-evidence.example.json docs/qa/beta-three-layer-evidence-beta1.json
```

Fill:

- exact RC version/SHA/artifact hash or unique artifact name;
- `summary.p0Open = 0`;
- `summary.p1CoreOpen = 0`;
- Unit/E2E/Human PASS + evidence for every beta-exposed feature;
- `releaseChecks.automated.summaryPath` -> the real `beta-automated-summary.json`; the gate reads it, requires `status: pass`, requires its commit to equal `release.commit`, and requires its packaged SHA-256 artifact identity to equal `release.artifact`;
- `releaseChecks.packagedCleanMachine` -> human clean-machine result and `artifact` exactly equal to `release.artifact`; the final gate rejects evidence from another build;
- `releaseChecks.browserCompanionChrome` -> Chrome receipt/human result;
- `releaseChecks.failureDrills` -> human evidence for network loss, nd-core interruption, unwritable data path and disk-pressure behavior;
- `releaseChecks.soak24h.summaryPath` -> the real soak JSON; the gate reads it and requires `status: pass` + `requestedMinutes >= 1440`;
- repeated scenario totals;
- final human release decision.

Default repeated-scenario threshold remains 95% with at least 20 recorded runs. If you set a target of 99% or higher, the gate requires at least **100 recorded runs** so “99%” is not claimed from a tiny sample.

## 8. Run the final gate

```powershell
corepack pnpm beta:gate -- docs/qa/beta-three-layer-evidence-beta1.json
```

Expected:

```text
Beta 3-layer gate: PASS
- beta-exposed features: ... passed Unit + E2E + Human
- repeated scenario pass rate: ...
- release checks: automated + clean-machine + Chrome + 24h soak passed
- P0 open: 0; core P1 open: 0
- human release owner: ...
```

If the gate fails, either fix the release blocker and rerun from the affected layer, or remove/disable that feature from the beta surface and update the evidence matrix honestly.

## Evidence review checklist

Before changing `humanDecision.status` to `go`, verify all evidence belongs to the **same RC SHA/artifact**. Do not mix an older green test bundle with a newer executable.

Check:

- [ ] automated summary PASS;
- [ ] no required stage was skipped;
- [ ] exact packaged artifact identified;
- [ ] real Chrome PASS;
- [ ] clean-machine PASS against the exact `release.artifact`;
- [ ] network/core-kill/unwritable-data/disk-pressure failure drills PASS;
- [ ] soak >= 1440 minutes PASS;
- [ ] 0 P0;
- [ ] 0 core P1;
- [ ] scenario threshold met;
- [ ] every beta-exposed P0/P1 has Unit + E2E + Human evidence;
- [ ] provider credential global-scope limitation accepted/documented for supervised testers;
- [ ] tester-facing supported OS/provider/engine limitations documented;
- [ ] rollback/recovery instructions available.

Only the human release owner records final GO.
