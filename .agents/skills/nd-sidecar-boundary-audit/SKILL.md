---
name: nd-sidecar-boundary-audit
description: Read-only audit of the nd-core Rust sidecar versus Electron/Node usage in nd-dsh. Enumerate the sidecar RPC surface from the nd-core dispatch arms, build a wired-versus-dormant matrix of core.request call sites, find jobs implemented in both Rust and Node or heavy work still owned by Node (git escapes, hashing, directory walks), and spot-check AGENTS.md invariants, ending in a severity-ordered file:line report without changing code. Use when checking for sidecar duplication, validating the no-duplication rule, auditing the Rust/TypeScript split after sidecar additions, or before a release.
---

# ND sidecar boundary audit

Map the nd-core Rust sidecar capability surface against Electron/Node usage in this repository, then report where the boundary holds and where it leaks. Keep the audit read-only; propose fixes and ask the user before implementing them.

Authority is this repository's `AGENTS.md` (performance work belongs in the Rust runtime, never implement one job in both Node and Rust, engine adapters and the browser surface are not sidecar work). Intended-split references when present: `docs/prd/0002-rust-sidecar-mvp-migration.md`, `docs/plan/agent-fast-path.md`.

## Evidence rules

- Production wiring is decided by the bootstrap in `src/main/index.ts` (`createWindow`), not by a TS file's existence. "Wired" means reachable from that bootstrap.
- Test seams are defaults or alternate constructors (`rawGitExecRunner`, raw `spawn`, in-process workspace filesystem, local permits). They are not violations; check what the bootstrap injects.
- `e2e/`, `benchmarks/`, and `src/main/perf/` harness code never decides production wiring.
- Only `CoreClient` request calls are nd-core wiring. Engine transports are out of scope: `wire.request` in `src/main/engines/codex/codex-wire.ts` and `src/main/engines/zcode/zcode-cli-engine.ts`, the gateway WebSocket in `src/main/dsh/gateway-client.ts`, and the `nd-agent` stdio server.

## Steps

### 1. Enumerate the Rust capability surface

- Read `crates/nd-core/src/main.rs`: every `"method.name" =>` dispatch arm is the authoritative RPC surface.
- Pair methods with implementations by listing `crates/nd-runtime/src/*.rs` (artifacts, cache, deadline, decision, dispatcher, effect_journal, evidence, git, metrics, process, revision, scheduler, search, session_journal, snapshot, terminal, windows_job, workspace).
- Note sibling crates: `nd-protocol` (wire framing), `nd-browser-host` (overlapped-pipe bridge), `nd-agent` (ND-native model/session server, separate stdio protocol).

### 2. Build the wired-versus-dormant matrix

- Grep `src/main` for `core.request` and `coreRequest` call sites; record method plus file:line.
- Read `src/main/core/core-client.ts` (`CONTROL_METHODS`) and the typed wrappers under `src/main/core/`: `core-workspace.ts`, `core-pty.ts`, `core-child-process.ts`, `core-session-journal.ts`, `core-worktree-git.ts`.
- Mark each Rust method wired (TS caller file:line) or dormant. Verify every dormant result per Pitfall 1 before reporting it.

### 3. Verify production wiring and fail-closed behavior

Read `createWindow` in `src/main/index.ts` and confirm:

- `core.start()` is awaited before services come up; startup fails closed when the bundled sidecar is missing.
- Injections present: `workspace.attachFileSystem(createCoreWorkspaceFileSystem(core))`, `createCorePtySpawner(core)`, `ExecutionCoordinator(core)`, `TaskWorktreeManager(coreWorktreeGit)`, verification runtime `runGit`, `effectJournal.configure`, and `coreGit = new GitCli({ core })` passed to `registerIpc` for workflow and package git.
- In-process implementations are labeled seams unless this bootstrap selects them.

### 4. Hunt Node-owned heavy work and duplicated jobs

- Grep `src/main` for `createHash`, `createReadStream`, `execFile`, `spawn`, `readdir`, `readFileSync`, and long-lived `setInterval` loops.
- For each hit, find the Rust counterpart in `crates/` (hashing → `evidence.rs`/`artifacts.rs`, git → `git.rs`, search → `search.rs`, snapshot → `snapshot.rs`), check the injectable seam's production argument, and flag only production Node execution of a job Rust owns, or unbounded/uninterruptible main-process work.

### 5. AGENTS.md spot-checks

- Renderer sandbox in `src/main/index.ts` `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Browser tools share `ND_DSH_AGENT_BROWSER_CONFIG` and `ND_DSH_AGENT_BROWSER_SESSION`; the embedded `WebContentsView` is canonical; no hidden automation browser.
- `.env*` ignored; no live keys in tests (dummy tokens only); downloaded or vendored binaries hash-validated.
- No engine-specific branching inside Rust crates.
- ND Pencil naming: `OpenPencil` strings confined to vendor, provenance, or selector contexts.

### 6. Report

- Capability matrix: Job | TS client file:line | Rust impl | wired/dormant.
- Findings ordered by severity; each with file:line, the boundary rule it breaks, and a recommendation.
- A not-duplication list (engine adapters, browser surfaces, harness polling, control-plane state, labeled seams) so later runs do not re-flag them.
- Proposed next steps; ask the user before implementing anything.

## Pitfalls

1. Minified or very long lines fake "dormant". ripgrep prints `[Omitted long matching line]` for matches on very long lines; the match still exists. `src/main/organization/fast-path.ts` is minified one-liners — the 2026-10-05 audit nearly reported `workspace.snapshot` as dormant until a direct read showed `core.request<any>('workspace.snapshot', …)` at `fast-path.ts:9`. Never declare a method unwired from a grep whose matches were omitted; Read the candidate file or re-grep with the exact token.
2. Distinguish transports; `wire.request` and gateway traffic are not nd-core wiring.
3. Do not flag labeled seams; check what `src/main/index.ts` injects before calling a default runner a violation.
4. Run greps from the repository root with absolute paths; a stray `cd` silently changes what later greps see.
5. E2E and benchmark harness code never decides production wiring.

## Calibration baseline (2026-10-05)

A correct run against the post-fix tree shows no dormant methods and these known-good wirings:

- Git fully delegated: `git/git-cli.ts` → `git.exec`/`git.status`/`git.log`; `workflow-git.ts` and `extensions/package-store.ts` route through injectable `GitExecRunner`, with the core-backed `coreGit` (`index.ts:449-450` → `ipc.ts`).
- Artifact fingerprinting via `workspace.fingerprint-artifacts` (`src/main/core/core-workspace.ts` → `crates/nd-runtime/src/artifacts.rs`).
- Search and revision compose inside `workspace.snapshot`, reachable from `fast-path.ts`.
- Residual known item: terminal recovery persistence (periodic native tails over RPC plus `terminals.json` rewrite) remains a documented deliberate duplicate for restart recovery; an optional future move.

If a run re-reports the pre-fix findings (Node hashing in `verification-evidence.ts`, direct `execFile('git')` in workflows), suspect stale evidence and re-verify before reporting.

## Verify the audit itself

- Every "wired" claim cites a bootstrap line; every "dormant" claim is backed by a direct Read or an exact-token grep with visible output.
- Every finding has file:line and a production-path argument; a not-duplication list exists.
- The tree is unchanged: no writes to repository source files; deliver the report in chat unless the user asks for a file.
