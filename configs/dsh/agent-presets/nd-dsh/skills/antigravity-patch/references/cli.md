# Patch CLI

In ND or any universal coding agent, use `/antigravity-patch -h`, `/antigravity-patch status`, `/antigravity-patch apply`, `/antigravity-patch reset`, or `/antigravity-patch adopt`. In ND, the slash skill resolves automatically; in universal agents, load `.agents/skills/antigravity-patch`. The agent runs this directory's helper through its authorized execution tools; it must respect workspace/OS permissions. If those tools or external-app UI controls are unavailable, report that limit and provide commands for the user instead of claiming execution.

In the examples below, set `$skillDirectory` to the **Skill resource directory** provided by ND or the repository workspace path `.agents/skills/antigravity-patch` (ending in `skills/antigravity-patch`). Do not resolve it from another product's global home directory.

Run the bundled Python helper from any directory. Python 3.9+ and Node.js are required for applying recipes; Node checks the complete changed JavaScript entry. Live archive replacement is Windows-only. No extra Python packages are required.

```powershell
$patchCli = Join-Path $skillDirectory 'scripts/patch.py'
python $patchCli -h
python $patchCli apply -h
python $patchCli reset -h
python $patchCli status
python $patchCli apply --dry-run
python $patchCli apply
```

The default patch is `browser-annotate`; use `--patch browser-annotate` explicitly if desired. The bundled recipe is for **Antigravity 2.29.0**. Its exact vendor preload and implementation hashes are in `assets/browser-annotate/recipes.json`. The older `annotate.js` is retained as historical 2.28.2 source, not an automatic upgrade recipe. Other patches in separate packed entries survive; an altered preload needs a newly inspected compatible recipe.

## Adopt an existing patch into ND

```powershell
python $patchCli adopt --dry-run
python $patchCli adopt
# Observe the existing feature before recording actual UI checks:
python $patchCli confirm --validation "Describe the actual observed checks"
```

Adoption is for an exact known recipe already installed without ND's registry. It does not modify the live app, stop it, or read a different tool's state. It verifies the recipe, reconstructs the prior preload by removing that exact block, and builds an independent baseline while preserving unrelated packed entries. ND stores both snapshots under its own state directory. The reconstructed baseline is not claimed to be pristine vendor bytes. After adoption/confirmation, `reset` can remove that recognized patch. An unknown underlying preload is refused.

Before `apply`, save current work and quit Antigravity normally. The CLI refuses replacement while any `Antigravity.exe` process is running and never kills processes, launches the app, disables updates, or bypasses file locks. A repeated apply with matching registered bytes returns `already_applied` without restarting anything.

After an actual replacement, restart Antigravity and test the requested behavior, cancellation, drafts/attachments, and surviving patches. Record only actual observations:

```powershell
python $patchCli confirm --validation "Describe the actual UI checks performed here"
```

`confirm` is a lifecycle commit, not an approval request. It does not perform UI testing. When the agent is executing an authorized apply/reset, it should perform those UI checks and commit autonomously. If a check fails, recover the pending change with `reset` rather than falsely confirming it.

## Reset

```powershell
python $patchCli reset --dry-run
python $patchCli reset
# Restart and check the resulting app, then record actual checks:
python $patchCli confirm --validation "Describe the actual reset and surviving-feature checks"
```

Without a pending operation, reset restores the latest patch transaction's exact verified input. It retains earlier patches and registry fields. If that input contains an earlier unregistered annotation revision, the CLI refuses and the skill must reconstruct its history or remove the feature precisely. Reset is not a factory reset and does not touch conversations, settings, vendor backups, or unrelated app files.

To remove an earlier feature with later patches above it, use the skill's source-level removal workflow. The CLI refuses that full-archive restore. It also refuses unknown versions/hashes, corrupted backups, and external registry changes. There is no `--force` or automatic reapply switch.

## Dry runs and alternate installations

`--dry-run` verifies the inputs and reports before/after hashes without creating backups, registry files, stages, or locks, or changing the app. Read-only status includes packed-entry integrity, version/hash, registered patches, and unresolved transactions. It does not validate unpacked files or runtime behavior.

Global options go **before** the command:

```powershell
python $patchCli --archive 'D:\Apps\Antigravity\resources\app.asar' --state-dir 'D:\PatchBackups\Antigravity' status
```

Do not share a state directory between different installations. The standard state directory is `%LOCALAPPDATA%/ND/Patches/Antigravity/`.

## Interrupted operations

Every live replacement saves unique immutable `before.asar`/`after.asar` snapshots and a `transaction.json` in the persistent state directory. `pending.json` points at the active transaction before replacement; the CLI registry is committed only after UI verification. Original registry fields and previous-version history remain intact.

Run `status` first:

- Live hash matches pending **after**: replacement happened. Restart and test, then `confirm`, or run `reset` to undo it.
- Live hash matches pending **before**: replacement did not happen. `reset` cancels that pending attempt and removes only its hash-verified staged file. For an interrupted recovery, it restores the previous pending pointer so that original operation can be confirmed or undone.
- Live hash matches neither side, a legacy transaction is unresolved, or registry state changed: inspect the records before proceeding. Do not overwrite them or clear the pending marker to bypass the mismatch.

An interrupted process can leave `cli.lock`. Inspect its recorded PID and transaction state; remove only a stale lock after establishing that its process is no longer active. The CLI never automatically breaks a lock.

## Extending recipes

Inspect the installed source and actual UI before adding a version. Build on the verified current archive with `asar_tool.py`; retain sandboxing and ownership checks. Store reusable implementation code in skill assets, not app archives or machine-specific paths. Each recipe pins `id`, `revision`, `app_version`, `entry`, `entry_sha256`, `marker`, `block`, and `block_sha256`. Current CLI recipes append one exact block to one inspected packed entry; more complex edits use the skill workflow rather than pretending to fit this recipe type.
