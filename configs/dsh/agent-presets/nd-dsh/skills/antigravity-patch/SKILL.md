---
name: antigravity-patch
description: Create, extend, verify, or remove temporary local patches to the installed Google Antigravity desktop app. Use for Antigravity UI and integration modifications while preserving existing patches across changes and updates. Does not cover ordinary projects being developed inside Antigravity.
---

# Antigravity patches

Implement the requested local change with a reviewable patch, observed UI verification, and precise rollback. This skill does not authorize additional features, messages to agents, or changes to unrelated apps.

In ND, invoke `/antigravity-patch <request>` through the skill picker or composer. This directory is the repository-owned release bundle. Keep its references, helpers, assets, and recipe together as regular tracked files; do not link to a developer's global skill installation. After intentionally changing the annotation asset, review and update its recipe hash and run the bundled Python tests plus ND's bundled-skill integration test.

## Help, apply, reset, and adoption

Map `/antigravity-patch -h` (or `help`), `status`, `apply`, `reset`, and `adopt` to this resource directory's `scripts/patch.py`. Help is read-only. Read [references/cli.md](references/cli.md) for arguments and recovery. Resolve every helper, recipe, and reference relative to ND's supplied **Skill resource directory**, never a global skill installation.

The helper defaults to `%LOCALAPPDATA%/ND/Patches/Antigravity/`. It supports the inspected 2.29.0 browser-annotate recipe; new versions require inspection. Start with `status` and the requested command's `--dry-run`. Save active work and quit Antigravity normally before `apply` or `reset`. Neither command closes processes or bypasses file locks. After restarting, observe actual UI behavior and record it with `confirm --validation`; do not claim UI checks from code or archive tests.

For a known patch already installed by a different tool, use `adopt --dry-run` before `adopt`. Adoption verifies the exact implementation and underlying preload, saves an ND-owned reconstructed baseline and current snapshot, and leaves the app archive untouched. It does not read another tool's state or assume a pristine vendor archive. Observe the existing feature before confirming. Unknown preloads, patches above the requested patch, or hash mismatches require investigation rather than a forced reset.

## Establish the current state

- Locate the actual executable/resources; determine the version from the executable and archive package metadata. The known Windows archive is `%LOCALAPPDATA%/Programs/Antigravity/resources/app.asar`; discover rather than assume on other installations.
- Read `%LOCALAPPDATA%/ND/Patches/Antigravity/registry.json` and `pending.json` when present. Compare the active/pending hashes with the installed archive before changing anything. A mismatch may mean an update, another patch, or a partial transaction; investigate rather than overwrite.
- For browser, preload, or Electron shell work, read [references/antigravity-desktop.md](references/antigravity-desktop.md). The original findings concern 2.28.2; the pinned CLI recipe contains the UI-tested 2.29.0 WebContentsView port. Reinspect other versions.
- Before installation, rollback, or an upgrade, read [references/patch-lifecycle.md](references/patch-lifecycle.md).

## Implement the smallest integration

Prefer a supported extension point when it achieves the requested behavior; otherwise use a narrowly scoped local patch. Inspect relevant source and UI before choosing the hook. Use distinct patch IDs/markers, idempotent mounting, cleanup of listeners/overlays, and scope to the intended host window and active browser tab.

Retain sandboxing, context isolation, guest ownership checks, and permissions. Do not disable integrity enforcement, certificate validation, auto-updates, or other protections to make a patch load. If these protections prevent the integration, explain the concrete limitation and leave the working installation intact.

Use current library documentation according to the session's documentation-tool instructions when APIs need checking. Use the available computer-use workflow for actual app interaction. Do not hardcode prior window handles, local server ports, or transient DOM IDs.

In ND, runtime permissions and workspace scope remain authoritative. Use ND's governed visible browser tools for web work; do not launch a separate hidden browser. Inspecting the native Antigravity window requires an available authorized desktop-control capability. If ND does not provide it, report that UI verification is unavailable rather than claiming a live pass or bypassing policy. For installed-app writes outside the active workspace, use the normal scoped authorization mechanism.

## Preserve the patch stack

Build from the **verified current archive** so existing patches survive. Before live replacement, record a recoverable transaction with unique backup/staged paths, version, before/after hashes, touched entries, patch ID/revision, and source location. Keep backups outside skill assets and temporary chat workspaces.

`scripts/asar_tool.py` inspects, verifies, extracts a named packed entry, and builds a candidate without changing its source. Run `--help` for syntax. Building requires an exact version and source hash, updates file/block integrity, rejects unsupported entries, and refuses existing output. It deliberately does not install or manage processes.

All supporting files resolve from this skill's resource directory; no other coding product is required. The scripts use Python 3.9+ and its standard library; CLI apply/adopt requires Node.js for syntax validation. The annotation asset uses existing Electron/browser APIs. Check runtime availability rather than installing dependencies automatically. The older `scripts/build_browser_annotate.py` remains a candidate-only helper for 2.28.2; it is not a live installer or an upgrade recipe.

Never blindly restore `app.asar.orig` or an earlier patch's backup over a newer stack. Preserve existing vendor backups. Use the lifecycle reference to remove an earlier patch or upgrade the app.

## Verify and hand off

Check changed JavaScript syntax and archive integrity before installing. Gracefully quit for archive replacement, checking for active work and preserving any draft. A file-lock failure means close the app; do not force-write or repeatedly kill processes. Restart and confirm the requested behavior through actual UI, including a representative cancel/failure path and coexistence with relevant patches.

For chat-related changes, test draft/attachment behavior without sending messages. Preserve pre-existing user drafts; remove only test content you created. Wait for asynchronous UI commits before judging the result.

If startup or existing behavior fails, stop feature expansion, recover the exact pre-transaction state when its hashes still match, and report the observed problem. Retry only with new evidence. Distinguish live checks from code review and untested assumptions.

Report what is installed, usage, relevant limitations, checks, and rollback location. Official updates may replace temporary patches. Respect the host's skill-discovery/invocation policy; invoking this skill is not standing authorization to reapply old patches after every update.
