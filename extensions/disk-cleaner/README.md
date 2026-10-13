# ND Disk Cleaner

Scan a folder or drive to see what is using space: a zoomable sunburst of the
biggest items, a sortable list underneath it, **Reveal in Finder/Explorer**,
and **Move to Trash** behind a native confirm dialog.

This is an **ND extension** (`nd.extension/1`), delivered fully external and
installed on demand — nothing here ships in the app bundle.

## What it does

- **Volumes** — lists mounted volumes with capacity and free space (metadata
  only; no walk).
- **Scan** — one cancellable scan of a folder or volume at a time. The parallel
  walk, size aggregation, and result pruning run in the nd-core sidecar with
  live progress events; the packaged UI shows entry counts and bytes as they
  climb. Symlinks are skipped, hidden files are included, ignore files are not
  consulted (a disk audit must see the whole tree).
- **Sunburst + list** — click a ring or a row to zoom in; sizes reconcile
  exactly. Entries too small to chart fold into one `(other)` bucket that names
  how many items it hides; it is informational and not actionable.
- **Reveal** — opens the containing folder with the item selected.
- **Trash** — moves one item to the system trash after ND's own confirm dialog
  showing the full path. The host refuses filesystem roots and your home
  folder; nothing moves without the dialog.

Every privileged operation runs through brokered host methods
(`disk.volumes.list`, `disk.scan.start/status/cancel`, `disk.trash.move`,
`disk.reveal`) — the web view has no Node, no network, and no authority of its
own.

## Install

1. **From Discover (dev builds and release catalog):** Settings → Extensions →
   Available → *ND Disk Cleaner* → Install, then activate it for Personal.
2. **From a folder:** Settings → Extensions → *Install from folder* and pick
   this `extensions/disk-cleaner` directory.
3. Run **Open ND Disk Cleaner** from the launcher (Ctrl/Cmd+K).

Activation is per context (Personal only here); installation is availability,
not data access. Scanning and trashing are personal-context actions.

## Provenance

Inspired by [next-mmo/nde-disk-cleaner](https://github.com/next-mmo/nde-disk-cleaner)
(a Tauri 2 + Svelte disk analyzer, MIT), reimplemented against the ND
extension contract: its Rust parallel walk maps to nd-core's scan job, and its
Svelte sunburst maps to this package's sandboxed canvas UI. No upstream code is
vendored; `ui/` ships zero third-party libraries.

## Size budget note

Scan results are pruned in nd-core to fit the web-view bridge: the top 12
children per directory, truncated names, and a bounded node count that shrinks
automatically when a tree is unusually wide. A scan of a narrower folder shows
more detail per entry.

## Development

Validate the package any time:

```bash
pnpm ext:validate extensions/disk-cleaner
```

The pure UI logic (`ui/sunburst.js`) is unit-tested straight from the
repository in `tests/disk-cleaner-sunburst.test.ts`, and desktop coverage is in
`tests/disk-cleaner-extension.test.ts` and `e2e/disk-cleaner.spec.ts`.
