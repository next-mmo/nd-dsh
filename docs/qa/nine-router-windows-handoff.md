# ND Security + 9Router — Windows local handoff test

**Status:** implementation code staged for Windows testing, **not yet validated by this conversation**. ND's signed 9Router release does **not yet exist** and production publisher keys are not pinned, so the managed install button intentionally stays disabled. Do not bypass signature or hash verification to run an unsigned executable.

## Before starting

- Windows 11 on a local developer machine
- Your own checked-out ND-DSH \`dev\` branch in VS Code; open only after reviewing differences
- Installed Node 24, pnpm 11 and the Rust toolchain required by this repository
- An independently installed and configured 9Router instance at \`http://127.0.0.1:20128\` for the external-connection test (not launched by ND)
- A *gateway API key* generated in 9Router, not an OAuth token or account password

## Local validation (run on your machine only)

Use VS Code's integrated test/build tasks or execute these in its terminal if your local policy permits:
\`\`\`text
pnpm typecheck
pnpm test
pnpm core:test
pnpm build
pnpm verify
\`\`\`
Capture the first failure and report the exact filename/line number. None of these commands have been run by the assistant.

## UI acceptance test (no system-browser navigation)

1. Launch ND-DSH on the local \`dev\` build.
2. Open Settings → Extensions and confirm \`ND Security\` is a built-in, active extension. Attempt to disable it: the main-process API must reject the request.
3. Open Settings → ND Router → 9Router integration.
4. Verify managed installation shows **signing key not provisioned** and cannot be launched from an unsigned folder.
5. Start your **existing** 9Router independently, create a gateway key in its dashboard, and enter \`http://127.0.0.1:20128/v1\`.
6. Press Discover models: verify the exact upstream model IDs appear, including those with slashes.
7. Press Connect to ND Router. Verify ND Router combos starting with \`9R:\` appear, test the model in a normal ND chat session, and confirm the original native routes still work.
8. Press Open dashboard inside ND. Check the dashboard is in ND Router's page, not a new Chrome tab. Verify login and provider setup; ensure browser extensions and regular ND browser cookies are not shared.
9. Change the URL to a non-loopback insecure \`http://\` endpoint or a URL containing embedded credentials: ND must reject it.
10. Stop 9Router and retry model discovery. The error must be surfaced without crashing ND. Start it again and retry.
11. Exit Settings: the embedded dashboard must disappear and its process/session must not leave a privileged ND IPC bridge.

## Security regression tests to add to release CI

- Executable external ND extension install is rejected without an approved signed release.
- Unsigned remote extension catalog cannot install an executable or bypass ND Security by direct IPC.
- Every other install route (Chromium extensions, downloaded tools, MCP executables, optional sidecars) is governed by the same mandatory security policy.
- Tampered signed release, altered publisher key, malicious symlink, path traversal, unexpected files: hard failure.
- Permission bypass and browser navigation to unexpected origins or local services: rejected.
- Managed process must use nd-core, never a shell command, and must stop on app close.
- Verify publisher key and signed update manifest before installing; re-verify after staging and immediately before execution.
- Release on Windows needs real packaged smoke, update, rollback and process-leak tests.

## Known gaps / release blockers

- **No signed release of the 9Router fork and no ND production signing key.** One-click managed runtime install is disabled until these are provisioned and reviewed.
- Managed browser denies popups and cross-origin navigation, so OAuth providers requiring their own browser may require an explicit external sign-in fallback.
- ND Security currently blocks external executable ND packages and unsigned remote catalog installs, but **other installer families have not yet been proved guarded**. Do not describe the product as comprehensively protected.
- No code was executed on your device by ChatGPT; a local build and E2E run are still required.
