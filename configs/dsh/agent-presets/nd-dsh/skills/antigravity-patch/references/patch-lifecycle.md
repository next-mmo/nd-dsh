# Patch lifecycle and coexistence

## Persistent state

Use `%LOCALAPPDATA%/Codex/Patches/Antigravity/` for this machine's register, backups, recipes, and validation records. Keep reusable instructions/code in the global skill. Do not include credentials, entire app bundles, chat contents, or transient port/CSRF data in skill resources.

The register tracks an archive hash chain. Its initial schema is:

```json
{
  "schema_version": 1,
  "app_version": "2.28.2",
  "archive": "<absolute installed app.asar path>",
  "active_sha256": "<installed hash>",
  "patches": [{
    "id": "browser-annotate", "revision": 1,
    "before_sha256": "<input hash>", "after_sha256": "<output hash>",
    "backup": "<immutable input snapshot>", "snapshot": "<immutable output snapshot>",
    "entries": ["dist/preload.js"], "source": "<persistent recipe>",
    "validation": "<actual checks performed>"
  }]
}
```

Preserve unknown fields when updating it; add timestamps and transaction fields as needed. A marker is not proof a feature works. Do not assume the first known baseline is pristine vendor code.

## Add or revise a patch

1. Verify archive integrity, version, and active hash. If no register exists, inventory existing markers/backups before establishing the baseline.
2. Build from current installed bytes. For a revision, precisely replace the existing block rather than append duplicate handlers. Assert expected anchors and match counts. Preserve unrelated packed entries, metadata, links, and unpacked files.
3. Verify the candidate, code syntax, and intended changed entries. Store immutable input/output snapshots. Record a pending transaction **before** live replacement so interruptions can be diagnosed.
4. Gracefully quit, recheck the live input hash, stage a unique candidate in resources, and replace on the same filesystem. Do not bypass file locks. Restart and test the result.
5. Commit the active hash after observing the installed result. Keep failures, pending transactions, and successful installations distinguishable. Preserve backup history.

If source changes after a candidate is built, rebuild. Use atomic manifest writes where possible. Inspect any outstanding transaction before starting another; after a crash compare the live hash with both recorded hashes to determine whether replacement happened.

## Removal

- **Latest transaction:** restore its verified input only if the live hash equals its output. Undoing a latest revision may restore an earlier revision, not remove the feature; describe this distinction.
- **Earlier feature with later patches:** a full restore would erase later work. Rebuild a compatible baseline with the desired remaining recipes, or precisely remove that feature's source block from the current archive. Test surviving patches and record a new transaction.
- **Hash mismatch:** investigate. Do not add a force switch that silently overwrites updates/unknown modifications.

## Updates and official feature arrival

Let official updates run normally. Inspect the new version and native support before porting a patch. Authorization for one patch does not authorize an unattended monitor or automatic reinstallation.

Inspect unknown modifications before treating a new archive as the new baseline. Re-evaluate hooks/APIs; loosen version constraints only after inspection and tests. Reapply only requested patches in a recorded order. Keep prior-version snapshots separate. If native support replaces a patch, retire it after checking behavior; never restore an old archive over the new official version.
