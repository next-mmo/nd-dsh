# Hello Notes — minimal `nd.extension/1` sample

The smallest ND extension that does something real. Copy this folder to start
your own package.

It is **declarative only**: there is no executable, no build step, and no
JavaScript that ND runs. `nd-extension.json` describes contributions and ND
renders and executes them inside its own trusted surfaces.

| Contribution | Host method | Permission |
| --- | --- | --- |
| `hello-save` command | `note.create` | `notes.write` |
| `hello-open-notes` command | `note.search` (opens the view via `openViewId`) | `notes.read` |
| `hello-notes` list view | `note.search`, action → `note.open` | `notes.read` |
| `hello-notes-walkthrough` skill | none — instructions only | none |

## Validate

```bash
node scripts/validate-nd-extension.mjs examples/nd-extension-hello
```

Expected: `PASS ... example.hello-notes@1.0.0 (4 contributions, contexts: personal, company, project)`.
Or use `pnpm ext:validate`. The CLI runs the same rules as the runtime
installer, so a package that passes here cannot discover a second rule set at
install time.

## Install and activate

1. **Settings → Extensions → Install from folder**, then select this directory.
   The folder must contain a file named exactly `nd-extension.json`. ND copies
   the content into a managed snapshot, records provenance, and never runs
   `npm install`, `postinstall`, or a build script.
2. Activation is **per context** and separate from installation. Activate it for
   Personal, a company, or a project.
3. Press **Ctrl+K**, then run **Save a hello note** or **Open hello notes**.

Installing grants no data access by itself. Declared permissions are a ceiling,
activation is the second switch, and a per-action grant is the third.

## What to change first

- `id` — reverse-DNS style, matching `^[a-z0-9][a-z0-9._-]{1,127}$`.
- `permissions` — every host method you reference must have its permission
  declared here, or validation fails.
- `contributions` — swap `note.*` for another allowlisted host method from
  `ND_HOST_METHODS` in `src/shared/extension-package.ts`.

## Gotchas this sample avoids

- **Contribution ids are unique package-wide, including view action ids.** A
  view action named `open` collides with a command named `open`. This sample
  prefixes everything with `hello-`.
- **A view's `description` is its empty-state message**, not documentation. ND
  shows it when the host method returns no rows. Compare
  `extensions/quit-process`, whose view description reads "No processes are
  available. Refresh to try again."
- **`itemTitleKey` / `itemBodyKey` must match the host method's payload.**
  `note.search` returns `{ id, title, body, updatedAt }`, hence `title`/`body`.
  Wrong keys render an empty list, and validation will not catch it.
- **Declare `contexts` explicitly on every contribution if your package is not
  all-contexts.** Omitting `contexts` currently defaults a contribution to
  `personal, company, project` and then reports the extras as widening the
  package contexts. This sample declares all three at both levels so it is
  unaffected.
- **`settings` are omitted on purpose.** They are stored per activation and
  delivered to host methods, but each handler decides whether to read them; no
  `note.*` handler does. Wallpaper Manager is the live example that consumes
  `folder`, `mode`, and `intervalMinutes`.

## Adding an executable tool

Only `tools` contributions carry code, as an external `mcp-stdio` child process
that runs with your desktop user's OS permissions — unsandboxed. Executable
trust is granted separately from ND API grants. Adding a `tools` entry without a
top-level `executable` block fails validation.

There is no sample executable in this tree. Read `extensions/translate` and
`extensions/quit-process` for real ND-bundled packages, and see
[`docs/extensions/authoring.md`](../../docs/extensions/authoring.md) for the
full contract.

> Do not confuse this with `examples/extension-counter`, which is an **agent
> capabilities** MCP descriptor (`surface`, `enabled`, `engineRoutes`) for
> Settings → Agent capabilities. That is a different capability class defined in
> `src/shared/extensions.ts`, and it does not validate as an ND extension.
