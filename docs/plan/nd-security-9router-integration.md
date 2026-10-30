# ND Security + 9Router — staged integration (DEV, draft)

Status: **Security foundation only; NOT installed, enabled, verified or production ready.** Work is staged on \`dev\`. No change to \`main\`.

## Goal

- First-party \`nd.security\` built-in, registered at application startup and enforced **outside** the renderer/extension permissions.
- Require an authentic, ND-approved signed release for any ND-managed 9Router binary before copying, starting or updating.
- Supervise a dedicated 9Router runtime using Rust \`nd-core\` and open its local dashboard in a protected visible ND Browser \`WebContentsView\` dock in the ND Router page.
- Fetch the gateway's authenticated \`/v1/models\` list and connect its model IDs to the existing Rust ND Router, preserving native routes.
- Never trust third-party process health or unsigned SHA-256 lists as a publisher attestation.

## Actual work in this commit

- A fail-closed, reusable Ed25519 release-manifest verifier with explicit publisher trust policy, immutable source metadata, full payload inventory, bounded file sizes, path and symlink restrictions, SBOM and attestation presence, and SHA-256 verification.
- Tests for valid approved releases, manipulated payload, wrong signing key, and dangerous manifest paths.
- No untrusted runtime execution, downloader, process spawning, settings installation button or registered security promise is introduced by this commit.

## Unverified local import (2026-10-31, DEV)

`ND Router → 9Router → Import local (unverified)` is a deliberate, consented path for a 9Router build the user already has. It is **not** a publisher attestation and does not satisfy the production signed-release gate.

- The user confirms a warning dialog; ND then copies the chosen folder, refuses symlinks, non-regular files, path escapes and size/count limit violations, and stores a SHA-256 inventory digest with `verification: 'unverified'` and `trusted: false`.
- Before every start ND re-inventories the copied tree and refuses to launch if any file changed. The import keeps its own dashboard credentials; ND deliberately does not inject `JWT_SECRET`, `API_KEY_SECRET`, `MACHINE_ID_SALT` or an initial password.
- Accepted layouts: a release folder with `release-manifest.json` (`runtimeEntry`, `serverEntry`, optional `workingDirectory`) plus its bundled runtime, or the npm 9Router package layout (`app/server.js` / `app/custom-server.js`) run with an installed Node.
- Dev/QA seam: `ND_9ROUTER_IMPORT_DIR` (unpackaged builds only) skips the picker, not the checks.
- Live evidence 2026-10-31: imported npm `9router` 0.5.75, started, `/api/health` returned `{ok:true}`, the embedded dashboard opened in ND at the allocated loopback port, and Stop terminated it. `tests/nine-router-managed-install.test.ts` covers package and manifest imports, tamper refusal, and absence of ND-managed secrets.

Production managed install still requires the gates below: an ND-pinned publisher key in signed builds and a reviewed, signed release artifact.

## Saved connection visibility (2026-10-31, DEV)

- The 9Router panel reads the live Router state and shows `Connected · N models`, the `9R:` route count and `Key saved in ND`; the gateway key stays in the core secret store and is never rendered.
- Connecting no longer clears the key input; it stays masked for the session, and later visits show the saved-key state instead of an empty, unexplained form.
- Starting the managed runtime aligns the saved 9Router provider's base URL to the runtime's newly allocated loopback port. No `apiKey` is sent, so the core keeps the stored secret.
- `Test saved connection` uses the stored secret. A 9Router 404 for missing provider credentials is reported as "reachable with the saved key, but this model has no credentials", never as a bad key.

## Production gates **not yet implemented**

1. Pin an ND-owned publisher public key in signed ND desktop builds. **No key is provisioned in this branch**, so installation must remain unavailable.
2. Review 9Router fork source, dependency graph, license, vulnerability and malware findings; produce approved signed runtime artifacts for Windows/macOS/Linux with bundled Node and an SBOM. Never assume a scan makes software fully safe.
3. Implement a bounded verified downloader and safe atomic quarantine/staging/rollback. A manifest digest alone does NOT authenticate an attacker-controlled source.
4. Wire the security enforcement into all code-execution installation paths: \`ExtensionPackageStore\`, \`RemoteExtensionCatalog\`, browser extensions, MCP executable installers and managed runtimes. Deny installs when enforcement unavailable. Avoid presenting a protection UI until gate coverage is demonstrably complete.
5. Add a core-owned, non-disableable \`nd.security\` builtin identity/UI, audit receipts, permission review and remediation. A UI-only extension must never be treated as the security boundary.
6. Implement a managed 9Router supervisor with sandbox capability checks, loopback origin validation, strong runtime secrets, no shell invocation, exact artifact re-verification before launch, and bounded restart.
7. Add a dedicated protected browser administration profile and visible same-page dock. Restrict navigation, permissions, preload, popups, service workers and cross-origin OAuth; provide a user-approved external browser fallback if required.
8. Discover 9Router models using the gateway API key, preserve slash-separated model IDs, block recursive ND <-> 9Router loops, use explicit user consent for external (non-attested) gateways.
9. Add tests for all bypass paths, malicious artifact swaps, tamper-after-check, live streaming and tool invocation, OAuth, unusual ports, token leaks, package update rollback and packaged Windows smoke tests.

## Git policy

\`main\` is not a merge target. Use \`feat/*\` for subsequent implementation and review into \`dev\`; all further changes must preserve \`main\` untouched.

## Verification limits

Reviewed source and repository structure using GitHub API, including ND Router, existing extension installer, browser controller, and 9Router fork. **No CLI or test/build actions were run at the user's request.** Do not claim the feature works until app wiring and CI are validated.
