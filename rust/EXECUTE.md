# One-pass Rust migration execution contract for a local coding agent

User goal: **continue through the whole feasible Rust migration without asking for phase-by-phase approvals**. Stop only for an actual safety/performance/parity blocker, user-only credential or deployment choice, or exhausted local environment. Do not say 100% complete until the evidence says so.

Repo: `next-mmo/nd-dsh`. Work only on `feat/rust-anything` (based on `dev`). Do not merge to `main`, rewrite `dev`, create unrequested PRs, or enable GitHub Actions tests.

## Before writing code

1. Read `AGENTS.md`, `rust/MAP.md`, `rust/DECISIONS.md`, `rust/GLOSSARY.md`, `rust/research/ownership.md`, and `.agents/skills/rust-anything/SKILL.md` + `whole-app.md`.
2. Confirm **real** Rust, Node 24+, pnpm 11, the full checkout, submodules and local desktop prerequisites. Diagnose missing toolchain using `rust-anything doctor`.
3. Use **disposable fixtures and test database** and remove production credentials/environment variables. Record and diff can write files, send HTTP requests and mutate databases.
4. Run `rust-anything analyze . --whole-app -o rust/research/analyze-generated.md` and profile representative workloads; write the observed hotpaths and dependency fit to `rust/MAP.md`. The desktop application itself is a hybrid, so do not attempt a pure-Rust Electron/browser/UI replacement.

## Continuous conversion loop

For every feasible independent non-UI unit, without a new approval checkpoint:

1. Identify the existing TS/Go source path and real entry point, first for low-risk/high-impact independent units. Preserve product contracts, error paths and every security boundary.
2. Run `rust-anything bridge . <unit-id>` or its supported language/adapter equivalent; include generated bridge only where native crossings are amortized.
3. Record original behavior with realistic and edge-case inputs. Add negative tests and externally visible effects. Fail safely on production/network dependencies.
4. Implement the Rust `src/port.rs` faithfully. **Do not change original behavior to make the diff pass.**
5. Run `record` (if necessary), `build`, `diff`, fuzz, `bench`, `gate`. Use `ND_RUST_ANYTHING_SANDBOX=1 corepack pnpm rust:gate` to verify all recorded units; inspect the report and benchmark verdict manually.
6. Only after green parity and acceptable latency/memory, wire a shadow adapter, verify with real Electron E2E and packaging tests, and switch that specific entry point. Keep the rollback. If slower or incompatible, keep the original and document why.
7. Update `rust/MAP.md` with every unit's real N/N case count, gate, benchmark and rollback, and `rust/HANDOFF.md` with the exact next step. Continue to next unit.

Use the pre-existing `nd-core` and `nd-runtime` crates instead of another daemon wherever possible. Port **data and execution**, not React, Chromium, context-isolated IPC, OS keystore or vendor-specific coding engines. Treat ND Cloud as its own standalone HTTP application requiring whole-app route/effect replay before cutover.

## Whole-product final gate

Run locally (not via GitHub Actions):

```sh
corepack pnpm verify
corepack pnpm typecheck
corepack pnpm test
corepack pnpm core:test
corepack pnpm browser:host:test
corepack pnpm build
corepack pnpm e2e
ND_RUST_ANYTHING_SANDBOX=1 corepack pnpm rust:gate
```

Also test Windows portable release, macOS where supported, startup and idle RAM/CPU, task throughput, concurrency, cancellation, native crash cleanup, permission boundaries, invalid secrets, organization datastore backup/restore and symlink traversal. Write reproducible performance baseline and before/after numbers.

**Definition of done:** all selected feasible units integrated or explicitly kept with measured reasons; every changed path passes original-behavior cases and safety tests; all existing supported product paths still work; recordings and replay are real (not mocked); no production data touched; no main merge. A fake/empty gate, a compile-only success, or a performance estimate cannot complete the task.
