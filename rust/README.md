# ND-DSH Rust migration workspace

This folder follows the **rust-anything** whole-app/unit workflow for the **Rust-capable parts** of ND-DSH. The upstream skill (MIT) is vendored at `.agents/skills/rust-anything/SKILL.md` with `whole-app.md`. It is a behavior-proof tool, **not a source-to-Rust translator**; a coding agent still writes each Rust implementation.

Begin by reading `MAP.md` and `DECISIONS.md`. Rust is already used in `crates/nd-core`, `nd-runtime`, `nd-protocol`, `nd-router`, `nd-agent` and `nd-browser-host`; they are not counted as newly ported rust-anything units.

### Operator workflow

Run in an **isolated disposable clone with synthetic credentials/data only**, not an installed production profile:

```sh
cargo install rust-anything
rust-anything setup
rust-anything doctor
rust-anything analyze . --whole-app -o rust/research/analyze-generated.md
# For each approved/independent hot path, after reading generated analysis:
rust-anything bridge . <unit-id>
rust-anything record rust/<unit-crate>  # calls original code: may produce side effects
# Agent implements src/port.rs, then:
ND_RUST_ANYTHING_SANDBOX=1 corepack pnpm rust:gate
```

`rust:gate` scans recorded unit crates under `rust/` and executes `build -> diff -> bench -> gate`; it fails closed for unrecorded units or any mismatch and writes an **untracked** `rust/gate-report.json`. It deliberately does **not** auto-record side-effectful cases; `--record` is opt-in and still requires an isolated environment. `--fuzz-seconds 60` adds fresh fuzzing, and `--shadow` writes a drop-in only after gate passes.

```sh
corepack pnpm rust:gate:test
ND_RUST_ANYTHING_SANDBOX=1 corepack pnpm rust:gate -- --crate rust/<unit-crate>
```

Whole-app `app record/replay/lift` applies to standalone CLIs, servers, or libraries (e.g., a carefully isolated ND Cloud candidate), **not** to the entire Electron/Chromium/React desktop. Use normal ND verification and real E2E for every change. A zero-unit gate is **failure**, not success.

Source: https://github.com/erkamyaman/rust-anything (MIT). See the upstream warning about network/filesystem/DB effects during recording.
