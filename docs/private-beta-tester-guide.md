# ND-DSH 0.1.1 private beta tester guide

This guide covers the Windows x64 portable private beta and the current feature
set. A candidate becomes ready for distribution only after the exact artifact
passes the [release gates](plan/beta-release-gate.md). A source-test pass does
not establish a packaged release pass.

## Install and first run

1. Obtain `ND-DSH-0.1.1-private-beta-x64.exe` and its recorded SHA-256 from the
   release owner. Compare the downloaded file with the recorded hash:

   ```powershell
   Get-FileHash -Algorithm SHA256 -LiteralPath '.\ND-DSH-0.1.1-private-beta-x64.exe'
   ```

2. Use a writable local folder and leave at least 8 GB free on the drive used
   for Windows temporary files while testing. Portable startup extracts its
   bundled runtimes before the app opens. This is a portable executable; there is no
   installer, automatic updater, or signed public distribution in this build.
   The ND launcher extracts one bundled compressed archive into a fresh
   temporary directory. Allow extraction to finish before judging startup.
3. Install Git and make it available to ND for project history, task worktrees,
   and source control. The package bundles ND Core, the ND runtime, ND Pencil,
   and browser tooling. Users do not install ND Pencil separately.
4. Start ND under the Windows account that will use it. Configure a provider
   and model in Settings. Keep API keys in the credential controls. Provider
   availability, authorization, quotas, and network access affect agent work.
5. Select an available engine in Settings. Additional engine CLIs may require
   their own installation and authentication. Project-specific builds and
   tests may require Node.js, a package manager, or another project toolchain;
   bundled runtime components do not supply every project dependency.
6. Start with a disposable Git project and supervised autonomy. Confirm its
   workspace and configured verification command before allowing agent edits.

Clean-machine installation and the supported Windows-version matrix must be
recorded against the release artifact. Development-machine success does not
establish those results. macOS and Linux are outside this Windows artifact's
release claim.

## ND Pencil acceptance

In a disposable project, open Design → ND Pencil, create a canvas, draw a
rectangle and add text, undo/redo once, save, close and reopen. Confirm the
edits are preserved in the project's `.op` design document and that no
separate design application, runtime install or account setup is required.
With ND Harness active, ask the agent to add or change a shape and confirm the
canvas updates while the chat remains visible. Import an older `.op` document
only in a disposable folder; confirm the migration report and the backup under
`.nd/design/.backups/`. For Build into App, inspect the active project's real
source diff and verification result before accepting the generated application.
A saved `.op` document alone is design intent.

## Before replacing a build

- Cancel active work, pause schedules, and exit ND normally. Keep the previous
  executable and its hash.
- Back up the complete ND user-data directory while ND is closed, and back up
  project repositories separately. Retain task worktrees if they hold pending
  or unmerged work. Use the user-data location reported by the application or
  the startup error/log; custom profiles can use a different directory.
- Treat the profile backup as private: it contains credentials and session
  data. Encrypted credentials may depend on the original Windows account.
- Company-state snapshots cover organization state; they do not replace a
  complete profile and project backup.

## Recover interrupted work

1. Reopen ND with the same Windows account and profile. Inspect the task's
   status, error, verification result, and source-control diff.
2. After a crash or interruption, inspect the workspace before retrying. If an
   effect is marked uncertain, reconcile the actual result before repeating it.
3. Resolve missing credentials, unavailable engines, provider errors, pending
   approvals, or failed verification before retrying the affected task.
4. For a merge conflict, preserve both the project and task worktree. Resolve
   the conflict and inspect the resulting diff before integration. Do not
   delete an unmerged worktree or reset a human checkout to make a test pass.
5. If an approval is waiting, confirm its intended action and workspace before
   answering. Do not grant broad permissions to work around a missing tool.

The organization store maintains `organization.json.bak` and attempts recovery
if the primary file cannot be loaded. If both copies fail, ND reports a load
error. Preserve the profile before attempting recovery; do not delete both
files or substitute sample organization data. Company snapshot restores are
applied on the next launch.

## Roll back the application

There is no release-level automatic rollback or guaranteed backward schema
compatibility in this beta. Exit ND and retain the current profile and project
state before testing an earlier executable. Test the earlier executable with a
copy of the pre-upgrade backup in a separate profile first. For a custom profile
in PowerShell, use an explicit absolute directory:

```powershell
$env:ND_DSH_USER_DATA_DIR = 'C:\ND-Beta\rollback-profile-copy'
& '.\previous-ND-DSH-private-beta-x64.exe'
```

Verify company/project state, credentials, history, and repository status before
resuming work. If recovery fails, stop and provide diagnostics to the release
owner. Keep the original profile and repositories intact.

## Current limitations

| Area | Beta boundary |
| --- | --- |
| Identity and credentials | One desktop profile is one trusted operator. Provider credentials are profile-wide, not isolated per company. |
| Engines | Availability and authentication remain engine-specific. ND Agent (Rust) stays behind its private selection flag; this release does not enable it by default. |
| Extensions | Native command/view permissions remain governed. An installed extension does not make every engine capable of executing it. |
| Browser | The embedded ND browser is the default agent surface. Real Chrome Companion permissions and toolbar capture need separate acceptance evidence. Extension compatibility depends on the APIs each package uses. |
| Workflow templates | Internal workflow mechanisms do not establish a user-facing template-authoring feature. |
| Scheduling | A successful dispatch does not establish successful task completion, verification, or review. Inspect the task outcome. |
| Delivery | A completed plan, scaffold, or produced artifact does not establish a usable application. Require its declared checks, independent review, and integration result. |
| Long sessions | Bounded tests do not establish overnight or 24-hour stability. Record the required soak before claiming it. |
| Distribution | Portable private beta only. No signed installer, update channel, or proven automatic rollback. |

## Report a problem

Include the exact artifact filename/hash, Windows version, engine/provider/model
names, the steps taken, expected and actual behavior, and whether restarting
changes the outcome. Settings' **Copy diagnostics** action supplies a diagnostic
summary. Startup logs are in the profile's `logs/nd-dsh.log` file.

Inspect diagnostics before sharing. Do not send API keys, credential stores,
whole profiles, session tokens, or private project content. Share screenshots,
logs, and task evidence only after checking their contents.
