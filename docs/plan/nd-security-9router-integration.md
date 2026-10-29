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
