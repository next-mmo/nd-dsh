# ND-DSH coordination

Use the current root `AGENTS.md` as the authority for product and security requirements. This reference translates those requirements into team assignments; inspect the affected code before choosing file ownership.

## Ownership and dependencies

- Possible work groups include Electron orchestration in `src/main`, trusted bridges in `src/preload`, UI in `src/renderer`, Rust runtime work in `crates`, and focused validation in `tests` or `e2e`. Split only where the requested change supports independent progress.
- Assign one owner to shared contracts in `src/shared`, `crates/nd-protocol`, IPC registration, schemas, and central configuration. Agree on payloads, failure behavior, and authorization boundaries before dependent UI or adapter changes start.
- Keep ND organization state and control-plane decisions independent of coding engines. Workers implementing Codex or other engines should extend adapter contracts rather than branch organization state machines by engine. DeepSeek is a provider compatibility route.
- Keep DeepSeek Harness in its upstream-tracking runtime submodule/adapter. Do not delegate copying or patching its core. Coordinate bootstrap or `dsh:update` with other workers because runtime updates and builds share resources.

## Exclusive live resources

- Give one worker at a time ownership of a running ND app, embedded browser session, or open ND Pencil document. Other workers can inspect source, prepare changes, or verify independent contracts while that resource is in use.
- Agent browser work must use the canonical embedded `WebContentsView` with the shared `ND_DSH_AGENT_BROWSER_CONFIG` and `ND_DSH_AGENT_BROWSER_SESSION`. Do not launch hidden automation browsers for agent tasks. Preserve loopback-only CDP, context isolation, renderer sandboxing, and workspace-scoped policy.
- Keep desktop capabilities behind narrow IPC contracts. Renderer changes must fail closed when trusted preload is missing; never insert production demo companies or fake sessions to make a worker's UI check pass.
- Use ND Pencil terminology in product surfaces and preserve upstream attribution and its tested source pin. Stage the bundled engine under `resources/nd-pencil`; do not require a separate upstream installation or PATH setup. Preserve the managed engine's loopback, token, allowed-origin, sandbox, and network restrictions from `AGENTS.md`.
- Manipulate an open Freeform document through the controlled ND Pencil editor/MCP bridge. Serialize document operations and avoid concurrent filesystem writes to `.op` JSON. Building a concept should change the active project's real application source as a reviewable Git diff.

## Verification and delivery

- Workers run focused checks for their deliverables and return commands, outcomes, changed paths, and unresolved prerequisites. Use real environment credentials or explicit dummy tokens in tests; never copy live secrets into fixtures or reports.
- The integration owner shares valid results for unchanged code and runs checks for the combined change. Before publishing changes, run every required root gate: `pnpm verify`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Follow current repository instructions for any additional affected Rust, browser, packaged-runtime, or release checks.
- Prefix shell commands with RTK as instructed by the repository. If PATH resolves an unrelated executable, inspect command resolution and verify the intended RTK binary once; use that path for the session rather than repeatedly retrying rejected syntax.
- Preserve ignored `.env*` and runtime credentials. Inspect `git diff --staged` for secrets before any authorized commit. Report missing prerequisites and failing checks accurately; a focused check alone does not establish release readiness.
