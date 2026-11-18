---
name: update-deepseek
description: Sync, build, and actually boot the latest vendored DeepSeek Harness in nd-dsh, and fix the "still old?" version skew where a stale published runtime shadows the vendored tree. Use when the user says update deepseek / dsh:update / vendor deepseek latest / still old, sees a red old version badge (e.g. v0.2.1-rc.3) next to Gateway, or hits agent-browser 10s bind timeouts after a harness update or dev restart.
---

# Update DeepSeek Harness

Sync the vendored Harness to upstream latest, build it, make the app boot it (not a stale shadow), restart dev cleanly, and verify with a PASS/FAIL gate.

## The trap: resolution order shadows the vendored tree

`harnessRoot()` (src/main/app-paths.ts:74) prefers, in order:
1. `ND_DSH_HARNESS_ROOT` env override
2. managed published install: `ND_DSH_MANAGED_RUNTIME_ROOT` or `%APPDATA%/nd-dsh/runtimes/dsh`
3. published install: `<repo>/.nd-dsh/runtime/dsh`
4. fallback: `vendor/deepseek-harness`

A candidate wins only if it has `node_modules/@deepseek-ai/dsh/lib/bin.js`. A leftover frozen-pin install at (2)/(3) therefore **shadows** the freshly synced vendored tree, so `dsh:update` alone never changes the running version. The UI badge reads `readHarnessVersion()` (src/main/harness/harness-service.ts:1065) from the resolved root, which is why it shows the old version.

## Procedure

1. **Sync** — `pnpm dsh:update` (fetch upstream master, detach, rewrite `vendor/deepseek-harness.json`). Refuses a dirty submodule; clean it first.
2. **Build** — `pnpm dsh:build` (host + client + web faces in the vendored tree). Required so the vendored fallback can boot; asserts `apps/cli/lib/bin.js`, client `lib/index.js` entries, and `apps/web/dist`.
3. **Gate** — `node .agents/skills/update-deepseek/scripts/check-runtime.mjs`. Expect `PASS`. On `FAIL` with a `shadow:` line, de-shadow (step 4).
4. **De-shadow** (only if a managed/published install pins an old version):
   - Preferred (beta-aligned, no network): move it aside reversibly, e.g. `mv .nd-dsh/runtime/dsh .nd-dsh/runtime/dsh.stale-<ver>`, so resolution falls to the built vendored tree. It is gitignored runtime state, not user work.
   - Alternative (keep a published runtime): clean reinstall, NOT incremental. `npm install --save-exact` over an old lock hits peer conflicts (cordis ~4.1.0). Remove `node_modules` + `package-lock.json` in that dir first, then install the new pins.
5. **Restart dev cleanly** — stop the dev task, then kill orphans before relaunching: `electron.exe`, `nd-core.exe`, the runtime `node` child, and `agent-browser-win32-x64.exe`. The agent-browser daemon inherits the CDP listening socket and keeps port 9922 bound after Electron dies. Confirm ports 5173/3118/9922 free, then `pnpm dev`.
6. **Verify** — check script `PASS`; the spawned runtime's command line loads `vendor/deepseek-harness/apps/cli/lib/bin.js`; gateway responds (HTTP 401 = alive, token-gated); badge shows the new version.

## Traps

- **Orphaned children block the next start.** Stopping `pnpm dev` leaves Electron/nd-core/runtime/daemon children holding ports. Always sweep them and re-check ports before relaunch.
- **Stale agent-browser daemon pid/port sidecars cause `agent-browser command timed out after 10000ms`.** Dead-daemon files in `%APPDATA%/nd-dsh/agent-browser-runtime/namespaces/nd-dsh/run/*.pid|.port` make every bind hang. The check script flags dead pids; remove the stale `nd-visible.*` sidecars, then re-trigger warmup via CDP `window.ndDsh.surface.set('dsh')` on the renderer (port 9922).
- **Cold first bind stalls even on a healthy tab.** The daemon's first `tab <id> --no-pin-tab` can exceed the 10s bind timeout (and even 60s) while it attaches; it leaves a daemon that warms seconds later. Pre-warm manually with the app's env (`AGENT_BROWSER_CONFIG/SOCKET_DIR/SESSION`): run `tab <about:blank-target> --no-pin-tab` (long window), then `get url --pin-tab` to confirm warm, then re-trigger `surface.set('dsh')` — the app bind then succeeds. A hung/unresponsive active tab (`tab is not responding`) also stalls bind; restart the app for a fresh tab. When driving CDP, put `expression/awaitPromise/returnByValue` inside `params`, else the evaluate silently never runs.
- **`dsh:update` ≠ runtime update.** It only moves the submodule gitlink; it neither builds nor de-shadows. Always follow with build + gate + clean restart.
- **Synced-but-unrebuilt tree boots broken.** After `dsh:update`, old `lib/` outputs and exports maps lag the new checkout: new client packages have no `lib/index.js` (`ERR_MODULE_NOT_FOUND ... dsh-client-ui-*` from `dsh-home/profiles/web`) and stale exports raise `ERR_PACKAGE_PATH_NOT_EXPORTED './brand'`. The gate reports these as `vendored client face incomplete`; `pnpm dsh:build` (install + clean + host + client + web) is the fix, not a relaunch.
- **Version badge is cosmetic proof only.** Authoritative proof is the spawned process command line (which `bin.js` it loaded) plus the check script.

## Resources

- `scripts/check-runtime.mjs` — read-only PASS/FAIL gate: resolved root + version vs vendored/pin, vendored boot artifacts, stale daemon pid advisory. Exit 0 = PASS.