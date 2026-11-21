# Current-source ownership and risks

Source reviewed on branch `feat/rust-anything` (2026-11-21): `README.md`, `docs/architecture.md`, `AGENTS.md`, `package.json`, `Cargo.toml`, `crates/nd-core/Cargo.toml`, `src/main/core/core-client.ts`, `src/main/workspace/workspace-service.ts`, `src/main/workspace/suggest.ts`, `services/nd-cloud/README.md`.

- The desktop is React/Electron. Native browser, preload isolation, credential storage and rendering depend on Electron and should stay there.
- Rust already holds ND Core process, terminal, Git, workspace and scheduler RPC. Sending **every tiny JS function** across stdio would add serialization/IPC cost and violate the upstream guidance to batch hot loops.
- Workspace suggestion indexing already calls Rust `workspace.index` through the core filesystem API, but ranking is in JS. Moving ranking alone would transfer many entries per keystroke and is not a good unmeasured port.
- The ND Cloud pilot is currently an isolated Go HTTP app, not production tenancy or desktop sync. Its JSON disk recovery, authentication, owner/reviewer separation and HTTP status/error behavior are part of any eventual Rust rewrite.
- Native-state changes are especially risky around cancellation, retries, multi-agent workspace isolation and persistent metadata. Record error/effect paths and test migration/rollback with copies.

Upstream primary workflow: https://github.com/erkamyaman/rust-anything and https://github.com/erkamyaman/rust-anything/blob/main/skills/rust-anything/whole-app.md

This file is a **source-informed migration assessment**, not profiler output. No throughput or memory benchmark claim is made here.
