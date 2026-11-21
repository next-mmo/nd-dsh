# Rust migration handoff (2026-11-21)

Branch: `feat/rust-anything` off `dev`; no merge to `main`.

## Changes in this working pass

- Vendored the original MIT-licensed rust-anything agent skill and whole-app instructions in `.agents/skills/rust-anything/` (including upstream license).
- Added a fail-closed gate runner at `scripts/rust-anything-gate.mjs` and Node unit tests.
- Established the map, decisions and glossary as durable guardrails.
- Made no automatic change to production desktop runtime paths or user data.

## Verified / not verified

- Local `node --test tests/rust-anything-gate.test.mjs`: five harness tests passed in this session using a fake CLI, **not a rust-anything binary**.
- This execution container lacks the Rust toolchain, the rust-anything executable, the full checked-out repository and desktop E2E environment.
- No actual Rust-port unit passed a recorded `diff` or `gate`; no full desktop build or macOS/Windows packaged smoke run occurred. This is **incomplete** relative to the requested full migration.

## Resume checklist

1. Read `MAP.md`, `DECISIONS.md`, `GLOSSARY.md`, and the vendored rust-anything skill.
2. In a **disposable** branch checkout with local fixture data and empty provider credentials, install `cargo install rust-anything` and `rust-anything setup` (or official release binary) and run `rust-anything doctor`.
3. Run `rust-anything analyze . --whole-app -o rust/research/analyze-generated.md` and profile representative task workloads. Never profile live proprietary credentials.
4. Start with a measured, self-contained non-UI bottleneck; `bridge`, record fixtures, implement Rust `port.rs`, build, diff, fuzz, bench and gate.
5. Run `ND_RUST_ANYTHING_SANDBOX=1 corepack pnpm rust:gate` once recorded Rust port crates exist. Inspect output, note N/N, benchmark verdict and add cases.
6. Validate desktop: `corepack pnpm verify`, `typecheck`, `test`, `core:test`, `browser:host:test`, `build`, real Electron E2E and Windows/macOS packaging as supported.
7. Update this handoff and the unit ledger with real data, retain original fallback until gate passes; no cutover to main.
