# Rust migration decisions (ND-DSH)

## ADR-001: Rust where it improves ND; keep Electron and React
Status: accepted 2026-11-21
Context: ND-DSH is an Electron/React app with sandboxed preload, governed Chromium, coding-engine adapters and existing Rust crates.
Decision: Reuse the single nd-core Rust process. Port OS-facing ownership and bounded heavy processing where behavior and performance justify it. Keep all Electron/browser/UI primitives and compatibility adapters that cannot be replaced without loss.
Consequences: This is **not** a 100%-Rust desktop binary; it is a Rust-heavy hybrid product.

## ADR-002: Parity before native cutover
Status: accepted 2026-11-21
Context: State, agent outputs, cancellation, permissions, error messages, secrets and side effects are product contracts.
Decision: For each candidate use rust-anything analyze/profile, bridge, record, implement, build, diff, fuzz where appropriate, bench, gate and shadow/replay. Save real input cases and negative/error paths. Only switch after N/N recorded cases and the performance verdict support it.
Consequences: No blanket code translation or deleting the original on implementation alone.

## ADR-003: Never run record or replay on production
Status: accepted 2026-11-21
Context: rust-anything record/diff/gate executes original functions; network and DB effects may occur.
Decision: Require an isolated checkout, disposable data/database and no production credentials; use `ND_RUST_ANYTHING_SANDBOX=1` solely as an acknowledgement, not a technical sandbox. Never auto-run real provider calls or install extension scripts.
Consequences: Local-only evidence; production side effects are prohibited.

## ADR-004: Preserve storage and wire compatibility
Status: accepted 2026-11-21
Context: Existing organization.json, extension state, provider metadata, Chromium profiles and nd-core RPC are used by shipped desktop builds.
Decision: Preserve on-disk layouts, backups/recovery, message framing, version negotiation, request cancellation, sequence order and resource limits. Add reversible, versioned migrations only when all consumers and rollback paths are tested.
Consequences: A rewrite must not silently invalidate user data or old sessions.

## ADR-005: One reviewable feature branch, never main
Status: accepted 2026-11-21
Decision: Only work on `feat/rust-anything` based on `dev`; no merge to `main`. User asked to continue end-to-end without milestone approvals, but a failed gate is a blocker, not an approval to deploy unverified code.

## ADR-006: Target platforms and quality
Status: accepted 2026-11-21
Decision: Preserve Windows x64 packaging and macOS developer compatibility where supported. Keep one sidecar per desktop, strict stdio-only protocol, bounded queues, no unreviewed unsafe Rust, and no new GitHub Actions tests. Run pnpm verify/typecheck/test/core:test/build, browser-host tests, Electron E2E and performance checks on local machines before shipping.

## ADR-007: ND Cloud is not a desktop Rust-module rewrite
Status: accepted 2026-11-21
Decision: The Go ND Cloud pilot has a separate HTTP/server and local persistence compatibility surface. Use rust-anything whole-app recording, effects fixtures and HTTP replay before considering its Rust cutover. Do not silently replace its local Go binary or claim production readiness.
