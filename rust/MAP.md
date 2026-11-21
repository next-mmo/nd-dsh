# ND-DSH Rust migration map

Status: **in progress; not behavior-gated as a whole app** (2026-11-21). Branch: `feat/rust-anything`, based on `dev`. No work here may merge into `main`.

## Goal and stop condition

Move feasible non-UI execution, data processing and infrastructure into the existing ND Rust workspace while preserving feature and on-disk/wire compatibility. Keep Electron, the sandboxed preload, Chromium `WebContentsView`, React renderer, native/vendor coding-engine protocols and other parts where Rust would make the experience worse or break supported contracts. Run the complete loop without artificial milestone approvals, but never mark a unit done until its `rust-anything gate` and applicable application replay pass.

The **entire Electron desktop is not a pure Rust CLI/HTTP app**, so `rust-anything app lift` must apply only to suitable standalone sub-apps, services or libraries. It cannot eliminate Electron while retaining this UI/browser architecture. Every source unit port requires measured parity and no performance regression; the final desktop must still pass its own tests.

## Existing native ownership (pre-existing, NOT claimed as new ports)

| Runtime | Existing module | Evidence |
| --- | --- | --- |
| Core process, terminal, process supervision, Git, workspace, scheduler | `crates/nd-core`, `crates/nd-runtime`, `crates/nd-protocol` | Rust workspace and existing core RPC |
| Agent runtime | `crates/nd-agent` | Rust workspace |
| Provider/router backend | `crates/nd-router` | Rust workspace |
| External browser companion host | `crates/nd-browser-host` | Rust workspace |

Existing Rust code needs the standard `core:test`, `browser:host:test` and desktop integration checks. It is not automatically evidence of rust-anything recordings or gates.

## Migration candidates (every entry OPEN until proven)

| Unit / boundary | Status | Rule |
| --- | --- | --- |
| Remaining high-volume, data-only `src/main` hot paths (profile first) | open | Prefer batching and one core RPC, not thousands of per-item crossings |
| Organization durable persistence and event/ledger processing | open | Snapshot compatibility, recovery, concurrent task and permission parity before cutover |
| Structured search/ranking, parsing and indexing not already in nd-core | open | Run real benchmarks; retain JS if faster or otherwise better |
| Filesystem/storage and child-process code still owned by Electron main | open | Move only with platform-specific behavior tests; do not create a second native daemon |
| Extension package verification/install paths | open | Preserve containment, symlink rejection, file caps and security boundaries |
| ND Cloud Go pilot (`services/nd-cloud`) | open / separate whole-app candidate | Local only; record routes, auth failures, tenant isolation, snapshot/recovery and effects against disposable fixtures before a Rust server cutover |
| Coding engines, provider SDKs and network adapters | evaluate per adapter | Keep vendor protocol-specific code and authentication where Rust cannot preserve behavior safely |

## Permanently KEEP outside Rust (by product contract)

- Electron app lifecycle, BrowserWindow/WebContentsView, native Chromium session/profile/extension APIs, CDP/permission control.
- React renderer, JSX, styling, xterm.js rendering, UI and preload's context-isolated IPC surface.
- Vendor-managed Harness, Codex and other CLI/app-server implementations; replaceable adapters can remain TypeScript where this is safer.
- ND Pencil upstream source and other pinned/vendor implementations, unless a separately approved compatibility port exists.
- OS-backed secret-storage APIs stay behind trusted Electron main. Rust must not receive credentials without an explicit narrow protocol and security review.

## Completion accounting

- rust-anything recorded ports passing `gate`: **0 confirmed in this branch**.
- Desktop production cutover: **not performed**.
- Full original-vs-Rust replay: **not run**.
- Baseline throughput, RAM, CPU, latency, Windows/macOS packaging: **not measured here**.
- The only added automated proof so far is verification-runner unit testing; do not mistake that for product parity.
- This file is a live ledger. Mark each unit done only with crate path, original file, recorded case count, diff N/N, gate result, benchmark verdict, and desktop regression evidence.
