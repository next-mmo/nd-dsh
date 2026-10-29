# Beta release readiness — execution plan

> **Current pass/fail record: [release-0.0.1-checklist.md](release-0.0.1-checklist.md) (2026-09-29, updated 2026-09-30).** This file remains the ordered plan. Its "local validation pending" note is older than that checklist.
>
> Updated: 2026-09-28 · **Freeze update: 2026-09-30**  
> Basis: current `main` plus beta-hardening changes on `feat/beta-release-stability-plan-2026-09-27` (synced with `main` at `1cc7939`). Last fully attested baseline is 2026-09-26; the new hardening changes remain **local-PC validation pending**.  
> Goal: get ND-DSH to a **Beta Stable** release candidate without requiring every planned feature to be finished. Beta-exposed features must be predictable, recoverable, scoped correctly, and diagnosable.
>
> **2026-09-30 — RC scope frozen (Phase 0 executed).** Operator direction: no new features; lock for stable. `rc/0.1.1` branch + tag `rc-0.1.1-candidate-1` cut at `d519791` (includes `b999126`, the A10 waterfall fix; live journey 19/20 on source). Evidence skeleton: [beta-three-layer-evidence-rc-0.1.1.json](../qa/beta-three-layer-evidence-rc-0.1.1.json). From here: P0/P1 fixes and release-test changes only. Current automated standing on the frozen base: typecheck + `verify` clean, **1,070 unit tests passed / 0 failed / 9 skipped**, production build green, full real-user journey pass.

## Release labels

### Private / supervised beta

May be released to a small invited group when the **Beta Stable gate** below passes. Local/manual release evidence is acceptable while GitHub Actions remains parked, as long as the exact RC commit, machine, commands, and results are recorded.

### Public beta

Requires the Private Beta gate plus signed distribution, update/rollback proof, and runner-attested Windows release evidence. GitHub Actions can remain parked until this phase.

## Current standing

The core product is already in a strong position:

- Core company/project/task/agent workflow is covered by unit + E2E tests.
- Multi-company/project isolation, task worktrees, parallel execution, persistence/recovery, terminal/filesystem boundaries, and compute-budget accounting have strong automated coverage.
- The latest gate record reports `pnpm typecheck` clean and **855 passed / 8 skipped** unit tests on the 2026-09-26 validation tree.
- The 2026-09-24 full local attestation already covered Rust `core:test`, full Playwright, real-user production E2E, portable Windows packaging, packaged runtime smoke, forced-core-crash cleanup, and benchmark budget checks.
- Real-Chrome Browser Companion smoke is recorded green.
- Laya/Rust decision-kernel live validation is recorded; Rust remains opt-in, so promoting it to default is **not** a beta blocker.
- Third-party notice generation/verification is implemented.

The remaining work is mostly **release hardening and real-artifact evidence**, not another feature round.

## Beta Stable gate

Declare the RC Beta Stable only when all are true:

1. **0 P0** — no known crash/data-loss/security/wrong-company-or-project defects.
2. **0 known P1** in the core path: create company/project → plan → worker → review → Git/result → restart/recover.
3. **Every beta-exposed feature has Unit PASS + E2E PASS + Human PASS** in the RC evidence record.
4. **≥95% repeated scenario pass rate** for the beta scenarios on the RC. Teams targeting 99% may set the evidence threshold to 0.99 once enough repeated runs exist to make that number useful.
5. All beta-exposed features are either:
   - verified and enabled, or
   - clearly marked Experimental / disabled behind a feature flag.
6. The exact packaged artifact, not only the source checkout, passes the release journey.
7. A rollback/recovery path is documented before users receive the build.
8. A human release owner explicitly records the final GO decision.

The three-layer evidence workflow is defined in [beta-three-layer-validation.md](../qa/beta-three-layer-validation.md) and machine-checked with `corepack pnpm beta:gate -- <evidence.json>`.

## Ordered execution plan

### Phase 0 — Freeze the RC scope

**Goal:** stop adding risk while validation runs. **Executed 2026-09-30.**

- [x] Create one RC branch/tag candidate from current `main`. → branch `rc/0.1.1`, tag `rc-0.1.1-candidate-1` @ `d519791`.
- [x] No new feature work on the RC; only P0/P1 fixes and release-test changes. → operator directive 2026-09-30; feature branches stay parked until after GO.
- [x] List beta-exposed features and explicitly disable unfinished/experimental surfaces. → 17-row evidence skeleton [beta-three-layer-evidence-rc-0.1.1.json](../qa/beta-three-layer-evidence-rc-0.1.1.json); workflow-template UI is internal-only and stays unadvertised (checklist row 4).
- [x] Record exact app version, commit SHA, Windows version, Node/pnpm/Rust versions, and test machine. → app `0.1.1`, commit `d519791`, machine/Node/pnpm/Rust in the [checklist header](release-0.0.1-checklist.md) and the tag message.

**Exit:** everyone tests the same immutable RC candidate. → `rc-0.1.1-candidate-1` is that candidate; the packaged artifact is still to be built from this tag (P-fixes may move the tag to candidate-2 before artifact build).

### Phase 0.5 — Create the three-layer evidence matrix

**Status 2026-09-30:** skeleton created — [beta-three-layer-evidence-rc-0.1.1.json](../qa/beta-three-layer-evidence-rc-0.1.1.json) (17 beta-exposed rows incl. built-in browser extensions; unit/e2e pre-filled only where directly evidenced; Human pending throughout).

- [ ] Copy `docs/qa/beta-three-layer-evidence.example.json` to an RC-specific evidence file.
- [ ] List every beta-exposed feature as its own row.
- [ ] Map existing Unit evidence to each row.
- [ ] Map existing E2E evidence to each row.
- [ ] Leave Human as pending until a real tester runs the scenario.
- [ ] Keep Experimental/disabled features out of beta exposure rather than marking untested behavior ready.

**Exit:** every beta-exposed feature has an explicit Unit / E2E / Human owner and evidence slot.

---

### Phase 1 — Close the security/scope blockers

These are the highest-risk gaps from the current gate.

#### 1A. Product-level pre-push secret scan

- [x] Implemented in the real `GitService.push()` and `pushBranch()` boundary.
- [x] High-confidence credential/token/private-key formats and committed sensitive credential files are blocked before network mutation.
- [x] Refusal reports filenames only; secret values are not copied into Git output/logs.
- [x] Positive/negative tests added.
- [ ] Fresh local RC execution still required.

#### 1B. Provider credential scope

- [x] Private Beta contract decided: provider API keys are **desktop-global operator resources**, not company/project tenant secrets.
- [x] The limitation is explicit in the RC handoff; one ND desktop must stay inside one trusted operator/security domain.
- [ ] True company/project/environment secret isolation remains future runtime/gateway work; the shared Harness currently consumes one global ProviderStore runtime config.
- [ ] Do not claim mutually-untrusted tenant credential isolation until that boundary changes.

#### 1C. Explicit local transport boundary tests

- [x] `pnpm verify` now fails if Electron CDP is not explicitly bound to `127.0.0.1`.
- [x] Diagnostics/redaction tests remain in place and the real Settings Copy diagnostics UI now has E2E privacy coverage.
- [ ] Fresh local RC execution still required.

**Exit:** no known secret-leak or wrong-scope credential path.

---

### Phase 2 — Prove the packaged app on a clean machine

#### 2A. Clean-machine offline runtime

On a clean Windows VM with no development tooling:

- [ ] Install/run the exact RC artifact.
- [ ] Verify ND Core, Harness/runtime, browser host, and required CLI/runtime dependencies resolve. ND Pencil must open from the in-repo editor with no external design runtime or PATH setup.
- [ ] Decide whether Git/Node are bundled or explicit beta prerequisites.
- [ ] Start ND offline and confirm startup/recovery behavior is understandable.
- [ ] Confirm no accidental dependency on the source checkout, pnpm store, Cargo target, or developer PATH.

#### 2B. Installed-app E2E

Run against the packaged artifact:

- [ ] Create company + project.
- [ ] Assign provider/model + coding engine.
- [ ] PM creates work.
- [ ] Worker edits a fixture project.
- [ ] Machine verification runs.
- [ ] Independent review passes.
- [ ] Git/result is visible.
- [ ] Close ND completely.
- [ ] Reopen and verify company/project/tasks/assignments/evidence survive.

Negative cases:

- [ ] cancel a running task;
- [ ] kill ND Core mid-task and reopen;
- [ ] unavailable engine;
- [ ] provider down / no network;
- [ ] corrupted primary organization state;
- [ ] rejected approval;
- [ ] missing credential;
- [ ] merge conflict.

**Exit:** source-build success is no longer the only proof.

---

### Phase 3 — Close the remaining reliability gaps

Keep this focused; do not add unrelated features.

- [x] Explicit HTTP 429 / rate-limit transient classification + regression test added.
- [x] Windows forced-nd-core-crash descendant cleanup is required by `beta:automated`; restart reconciliation remains covered by existing organization recovery/effect-journal tests.
- [ ] Human network disconnect/reconnect drill on the packaged RC.
- [ ] Human invalid/unwritable data-directory / disk-full-style drill on the packaged RC.
- [x] Real Electron browser runtime spike covers cookie set/read/clear + a real download and is now required by `beta:automated`.
- [x] MCP child-failure containment test proves a broken child does not corrupt the control plane and a repaired next request works; interactive-session UX remains a Human check.
- [ ] Workflow-template UI create/edit/rerun: disable/mark experimental for beta if this surface is not fully exposed/tested.
- [x] Soak harness continuously checks renderer liveness, process count and memory growth; a real 24-hour run is still required.
- [x] Settings → About → Copy diagnostics E2E added with clipboard privacy assertions.

**Exit:** every beta-exposed subsystem has at least one failure-path proof.

---

### Phase 4 — Real-world beta matrix

Run the RC like a real user, not only a test fixture.

Minimum matrix:

- [x] **3 companies × 2 projects each** deterministic E2E harness implemented; Human/live RC execution still required.
- [ ] At least 2 different provider/model routes.
- [ ] At least 2 coding engines where locally available.
- [ ] Parallel work in at least 2 projects at the same time.
- [ ] Switch companies/projects while work remains active.
- [ ] Restart ND during the run.
- [ ] Create at least one rework/reviewer-fail path.
- [ ] Create at least one Git conflict/refusal path.
- [ ] Use the Quick Launcher (global popup and in-app) for at least one real task and one note capture.
- [ ] Install/activate one user-authored extension package and perform one governed native action (wallpaper).

For each scenario record: PASS / FAIL, app commit, artifact hash/name, provider/engine, and any issue number.

**Exit:** ≥95% repeated scenario pass rate and no P0/P1 core defect.

---

### Phase 5 — 24-hour soak

The dedicated `e2e:beta:soak` harness is implemented. Run it on the RC machine for 24 hours; the final gate rejects evidence below 1440 minutes.

Check:

- [ ] memory growth;
- [ ] CPU while idle;
- [ ] stuck/orphan workers;
- [ ] duplicate task execution;
- [ ] stale leases;
- [ ] zombie CLI/sidecar/browser-host processes;
- [ ] corrupted or missing organization state;
- [ ] journal/recovery errors;
- [ ] UI becoming progressively slower.

Take diagnostics at start, midpoint, and end.

**Exit:** no P0/P1 issue and no unexplained progressive degradation.

---

### Phase 6 — Private Beta release decision

Before sending the build to beta users, run the single automated release gate on Windows:

```sh
corepack pnpm beta:automated
```

Then require real Chrome Companion, clean-machine packaged E2E, the 24-hour soak, Human scenarios, and finally:

```sh
corepack pnpm beta:gate -- docs/qa/beta-three-layer-evidence-<rc>.json
```

Release only when:

- [ ] 0 P0.
- [ ] 0 known P1 in the core workflow.
- [ ] ≥95% repeated E2E/real-world pass rate.
- [ ] security/scope blockers in Phase 1 are closed.
- [ ] packaged clean-machine journey passes.
- [ ] rollback/recovery instructions exist.
- [ ] supported OS/providers/engines and known limitations are written for testers.

If a non-core feature is the only failing area, disable it for the beta rather than delaying the whole core release.

## Public Beta follow-up

These are **not required for a small supervised hand-delivered beta**, but are required before broad public distribution:

1. [ ] Restore `.github-bk/` → `.github/` and record runner-attested Windows release evidence from [blocked-0004](../tasks/blocked-0004-windows-release-validation.md).
2. [ ] Windows code signing / trusted installer.
3. [ ] Update channel with staged-update verification.
4. [ ] Prove previous-version rollback while preserving company/project/user state.
5. [ ] Publish supported OS/provider/engine matrix and beta limitations.

## Explicit non-blockers for the first beta

- Rust decision kernel becoming the default — keep the current stable default until separately promoted.
- Broader non-coding company templates.
- Extra engine adapters beyond the beta-supported matrix.
- Arbitrary Chrome-extension parity beyond the documented Browser Companion/built-in browser contract.
- Normalized cross-domain action policy beyond what is required for the beta-exposed actions; broader normalization remains pre-GA.

## Release evidence folder

For each RC, keep one evidence record under `docs/qa/` containing:

- RC commit + artifact name/hash;
- exact commands and pass/fail;
- clean-machine result;
- installed-app E2E result;
- real-world matrix result;
- soak result;
- known limitations;
- P0/P1 issue list;
- final **GO / NO-GO** decision made by the human release owner.

The detailed per-area coverage and open gaps remain authoritative in [beta-release-gate.md](beta-release-gate.md).
