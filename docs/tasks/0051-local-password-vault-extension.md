# TODO 0051 — Local password vault: on-demand extension with sidecar-owned encrypted storage

> Priority: P1
> Owner: ND extensions + nd-core sidecar
> Status: **implemented — local validation recorded 2026-10-07 (12 Rust vault unit tests incl. DPAPI roundtrip, 21 nd-core protocol contract tests, 8 desktop package/broker tests, 7 end-to-end Playwright steps green; packaged-build manual pass still open)**
> Depends on: [0036](0036-extension-invocation-and-permissions.md) (invocation broker), [0050](0050-sidecar-push-events-clipboard-history.md) (on-demand packaging pattern, sidecar module conventions)
> PRD: [0008 — Command Registry and Governed Native Extensions](../prd/0008-command-registry-native-extensions.md)
> Reference: 1Password — product inspiration only (a local-first password manager for ND). No 1Password code, SDK, service, or `op` CLI integration is used or shipped.

## Objective

Give ND a **local-first password vault**: store, search, reveal, copy, edit, and delete credentials without any cloud, account, or third-party service. The vault ships as an **on-demand-installable ND extension** (`Settings → Extensions → Available`), and the secure storage itself lives in the **nd-core sidecar** — the same architecture Clipboard History established in [0050](0050-sidecar-push-events-clipboard-history.md): manifest-only package, new governed host methods, main-process handlers, sidecar capability.

The user-facing name is *Password Vault* (`nd.password-vault`). It is intentionally an MVP; see §Deferred.

## Why storage belongs in the sidecar

- The sidecar already owns native-OS effects and secrets-adjacent primitives: wallpaper (`crates/nd-runtime/src/media.rs`), clipboard read/write/watch (`crates/nd-runtime/src/clipboard.rs`). Encryption-at-rest is the same class of work: small, auditable, dependency-light Rust.
- Desktop main-process secrets today are provider keys (`safeStorage`, `src/main/providers.ts`) and browser credentials (`src/main/browser/browser-credential-vault.ts`). Both encrypt *values*; the vault needs whole-file authenticated encryption plus search — a natural fit for AES-256-GCM over one envelope in Rust.
- Doing crypto in the renderer or in ad-hoc Node scripts would violate the platform rule that desktop capabilities arrive through narrow IPC contracts backed by the sidecar.

## Security invariants (must hold in every change)

1. **Local-only.** No network code path exists in the vault. The vault file and its key file live under the ND profile (`<userData>/nd-vault/vault.ndvault[.key]`); nothing syncs, nothing phones home.
2. **Encrypted at rest, OS-protected key.** One envelope file, AES-256-GCM (`crates/nd-runtime/src/vault.rs`), fresh 12-byte nonce per write, atomic temp+rename commits, unix mode `0600`. The 32-byte master key is random, generated on first use, and protected with Windows DPAPI (`CryptProtectData`, `CRYPTPROTECT_UI_FORBIDDEN`, user-scoped). The key file is **never silently recreated** — a new key would orphan existing entries without anyone noticing.
3. **Windows-first, fail closed.** Off-Windows the key protector errors clearly (same posture as `media.set-wallpaper`); there is no software fallback, because a key stored next to the ciphertext protects nothing.
4. **Metadata-only list.** `vault.list` returns id/title/username/url/updated rows — never `secret` or `notes`. Secrets cross the wire only through `vault.get` (and writes), which the broker marks **sensitive**: agent callers need an explicit grant (`approval-required`), remembered per host.
5. **Create/edit are user-only.** Typed input arrives through an ND-owned modal prompt (`src/main/extensions/vault-prompt.ts` — sandboxed, context-isolated, opaque-origin data URL, preload exposing exactly initial/submit/cancel). `vault.create`/`vault.update` refuse agent callers outright; changing the vault on ND's behalf is a user action.
6. **No secret leaks through the clipboard.** `vault.copy` prefers the sidecar's `clipboard.writeText`, which arms echo suppression (`crates/nd-runtime/src/clipboard.rs`), so Clipboard History can never record a vault secret. The in-process Electron fallback only exists when the sidecar is gone — and with it, any watcher.
7. **No secret logging.** Sidecar errors and audit records carry metadata only. Agent-side, `vault.list` is safe to expose; `vault.get`/`vault.copy` return content the agent can read — that is inherent to reading a secret, and it is why both are sensitive-gated.
8. **Bounded inputs.** Entry cap (500), per-field caps, NUL rejection, single-line title/username/url, absolute-path requirement, per-vault-path write locks so concurrent dispatch workers serialize load-modify-save.

## What shipped

- **Rust** — `crates/nd-runtime/src/vault.rs` (`VaultRegistry`: list/get/create/update/delete, envelope crypto, DPAPI protector behind an internal `KeyProtector` trait, cross-platform mock protector for tests); dispatch arms `vault.list|get|create|update|delete` in `crates/nd-core/src/main.rs`; `vault` capability in `core.health`; `aes-gcm` + `rand` deps and the `Win32_Security_Cryptography` windows-sys feature.
- **Desktop** — `src/main/core/core-vault.ts` (`createCoreVault`); `vault.read`/`vault.write` permissions; six `vault.*` host methods (list, get, create, update, delete, copy) in `src/main/extensions/nd-ipc.ts`; the prompt window and its preload (`src/main/extensions/vault-prompt.ts`, `src/preload/vault-prompt.ts`, vite preload input `vault-prompt`); `coreVault` threaded `index.ts → registerIpc → registerNdExtensionIpc`.
- **Package** — `extensions/password-vault/` (`nd.extension/1`, Personal-only, `vault.read`/`vault.write`), added to the on-demand allowlist (`AVAILABLE_PACKAGES`), catalog view, and `electron-builder.yml` `nd-extensions/password-vault` staging. Not in `BUILTIN_EXTENSION_PACKAGES` — install and activation are always explicit user actions.
- **Tests** — Rust: roundtrip, search, no-secrets-in-list, tamper rejection, wrong-key rejection, validation, entry cap, cross-registry key persistence, DPAPI roundtrip + end-to-end (Windows). Desktop: `tests/password-vault-extension.test.ts` (manifest validation, install/activate/uninstall, broker gating incl. sensitive `approval-required` for agent callers, view-action → host routing, `createCoreVault` request mapping). E2E: `e2e/password-vault.spec.ts` drives the real launcher, prompt window, view dialog, and clipboard — install on demand, add via prompt, encrypted-at-rest assertion (secret absent from the file on disk), metadata-only listing, copy-to-clipboard, prefilled edit, cancel, delete. The spec waits for sidecar readiness (`waitForVaultReady`) because a vault create that races the sidecar spawn fails while `CoreClient` is still starting. E2E runs pointed `ND_DSH_CORE_BIN` at a sidecar built in a separate `target-e2e` cargo dir, so a running dev instance holding `target/debug/nd-core.exe` does not block testing.

## Known follow-up from 0050 discovered while building on it

The shipped `clipboard.history.list` host handler returns `{ watcherActive, items }`, but the broker's `toRows` (`src/main/extensions/invocation-broker.ts:537`) renders only plain arrays — so the Clipboard History view falls to its empty state even with entries. The vault list therefore returns a plain array, matching `process.list` and `toRows`. Clipboard History needs a one-line shape fix (or a `toRows` unwrap); it is deliberately **not** changed in this task.

## Deferred (explicitly out of scope for this MVP)

- Auto-lock timer and in-memory secret zeroization.
- Password generator and TOTP fields.
- Browser autofill / "open and fill" via the embedded browser.
- Import/export (1Password/Bitwarden CSV or JSON migration).
- macOS Keychain and Linux libsecret key protectors.
- Agent-side secret provisioning into engine environments (beyond the existing sensitive-grant read path).
