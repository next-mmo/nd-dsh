# Authoring ND extensions

Status: **v1 platform, implemented locally 2026-09-27 (PRD 0006)**; sandboxed
web views added 2026-10. Public marketplace publishing, renderer-code injection
outside the web-view contract, and an OS sandbox for external executables are
explicitly out of scope for v1.

An ND extension is one folder with an `nd-extension.json` manifest. It
contributes **tools, skills, commands, views, and workflows** that ND renders
and executes inside its own trusted surfaces. Extensions never inject renderer
code, and contributions only reach the allowlisted ND host methods listed in
[ND_HOST_METHODS](../../src/shared/extension-package.ts).

Launcher commands from installed/activated extensions are adapted into the same
ND Command Registry as core, company, and project commands. Extension authors
do not register launcher code or React components; they contribute command data
and the broker remains the execution boundary.

## 0. Two different things are both called "extensions"

ND has two unrelated capability classes, and their manifests are **not**
interchangeable. Validating one as the other fails.

| | **ND Extensions** (this guide) | **Agent capabilities** |
| --- | --- | --- |
| Contract | `src/shared/extension-package.ts` | `src/shared/extensions.ts` |
| Manifest | `nd-extension.json`, `protocol: "nd.extension/1"` | descriptor with `surface`, `enabled`, `engineRoutes`, `providerRoutes` |
| Surfaces in | Settings → **Extensions** | Settings → **Agent capabilities** |
| Contributes | tools, skills, commands, views, workflows that ND renders | memory, subagent, plugin, mcp, skill, command, hook routes for coding engines |
| Install path | *Install from folder* → managed snapshot | enable in place, no snapshot |
| Example | [`examples/nd-extension-hello`](../../examples/nd-extension-hello) | [`examples/extension-counter`](../../examples/extension-counter) |

`examples/extension-counter/nd-extension.example.json` is an **agent
capabilities** MCP descriptor despite its filename. It is not an
`nd.extension/1` manifest and `validate-nd-extension.mjs` rejects it.

## 1. Manifest

Copy [`examples/nd-extension-hello`](../../examples/nd-extension-hello) — a
complete package that validates, installs through *Install from folder*, and
runs from the launcher with no executable and no build step. Its
[README](../../examples/nd-extension-hello/README.md) walks through the install
and activation steps and lists the mistakes it is written to avoid.

The JSON Schema is at [`schema/nd-extension.schema.json`](../../schema/nd-extension.schema.json).
Point your editor at it for autocomplete, but treat
[`src/shared/extension-package.ts`](../../src/shared/extension-package.ts) as
authoritative: the runtime installer and `pnpm ext:validate` both execute those
rules, and the schema is maintained by hand alongside them.

```json
{
  "protocol": "nd.extension/1",
  "id": "com.example.standup",
  "name": "Standup Notes",
  "description": "Collect standup notes as ND notes.",
  "version": "1.0.0",
  "apiVersion": 1,
  "contexts": ["personal", "company"],
  "permissions": ["notes.read", "notes.write"],
  "contributions": {
    "commands": [
      { "id": "standup-add", "title": "Add standup note", "host": "note.create",
        "keywords": ["standup"], "contexts": ["personal", "company"] }
    ],
    "views": [
      { "id": "standup-notes", "title": "Standup notes", "kind": "list", "host": "note.search",
        "itemTitleKey": "title", "itemBodyKey": "body", "contexts": ["personal", "company"],
        "actions": [{ "id": "standup-open", "title": "Open", "host": "note.open" }] }
    ]
  }
}
```

This snippet validates as-is; check it any time by saving it as
`nd-extension.json` in a folder and running the validator on that folder. Note
that every contribution repeats `contexts` — see the known defect below for why
you should not rely on inheriting them.

Rules the validator enforces (all of them, with actionable messages):

- `protocol` must be `nd.extension/1` and `apiVersion` must be `1`.
- Contexts are `personal`, `company`, and `project`. A contribution may narrow
  the package's `contexts` but never widen them.
- Contribution ids are unique **package-wide, including view action ids** — a
  view action named `open` collides with a command named `open`. Ids use
  lowercase letters, numbers, dots, dashes, or underscores.
- Every host method used must appear in the allowlist, and the permission it
  needs must be declared in `permissions`.
- A command's `openViewId` must name a view contributed by the same package.
- A view's `refreshIntervalMs`, if set, is an integer from 2000 to 60000.
- Tool contributions require an `executable` (`mcp-stdio`) runtime. `env` maps
  child variable names to **parent environment-variable names** — secret values
  in a manifest are rejected.

Two rules the validator does **not** catch, because they depend on runtime data:

- `itemTitleKey` / `itemBodyKey` must match the fields the host method actually
  returns. `note.search` returns `{ id, title, body, updatedAt }`. Wrong keys
  render an empty list with no error.
- A host method's own context support still applies. `process.*` and
  `os.wallpaper.*` are Personal-only and `workflow.*` is project-only, so a
  contribution that names them in another context is rejected even when the
  package contexts allow it.

> **Known defect.** Omitting `contexts` on a contribution currently defaults it
> to `personal, company, project` rather than inheriting the package's contexts,
> so a package that declares fewer than all three and omits contribution
> contexts fails with "contribution contexts (…) must be declared in the
> package contexts". Until that is fixed, declare `contexts` explicitly on every
> contribution whenever your package is not all-contexts.
> `src/shared/extension-package.ts:324` is where the default is set.

## 2. Environments and contexts

There is no separate development runtime: extensions run against the same
manifests, the same validator, and the same invocation broker in development
and in the product.

- **Installation is global to your ND profile.** It is availability, not data
  access.
- **Activation is per context** (Personal, a company, or a project). A
  project-only package is unavailable in Personal, and vice versa.
- **Every invocation carries exactly one context.** ND derives actor,
  company/project membership, engine/provider identity, and workspace from
  trusted records; a contribution cannot widen its own authority, and IDs
  supplied by a caller are validated against organization state.

## 3. The host methods v1 exposes

| Method | Permission | What it does |
| --- | --- | --- |
| `note.create` | `notes.write` | Save the note text in the selected context (Personal → ND Home, company/project → organization memory) |
| `note.search` | `notes.read` | List/search notes in the selected context |
| `note.open` / `note.delete` | `notes.read` / `notes.write` | Read or delete a note (personal notes only for delete, v1) |
| `capture.screen` | `capture.screen` | Capture a display (display under the pointer by default) and store it locally |
| `capture.area` | `capture.area` | Capture the rectangle the user selected in the ND overlay |
| `capture.list` / `capture.copy` / `capture.export` | `capture.read` | List captures, copy one to the clipboard, or export it through a save dialog |
| `clipboard.read` | `clipboard.read` | One explicit read that also saves the text as a note |
| `clipboard.write` | `clipboard.write` | Write text to the clipboard |
| `clipboard.history.list` / `.get` / `.pin` / `.delete` / `.clear` / `.copyAgain` | `clipboard.read` / `clipboard.write` | The ND Clipboard History package's local history surface; Personal only, and recording only ever runs behind the package's `recordHistory` opt-in |
| `accountmgt.accounts.list` / `.create` / `.update` / `.delete` | `accountmgt.read` / `accountmgt.write` | The Account Manager metadata store (service, email, mailbox/site links, status); Personal only. It never stores passwords or verification codes. |
| `browser.openUrl` / `browser.search` | `browser.navigate` | Navigate the visible embedded ND browser |
| `browser.openExternal` | `browser.openExternal` | Open an http(s) URL in the system browser |
| `browser.translate` | `browser.navigate` | Translate text in the ND browser (see §7 for providers and result states) |
| `browser.translate.history` / `browser.translate.history.clear` | `translate.history` | Read or clear translation history |
| `os.openTarget` | `os.launch` | Pick and open an app, file, or folder (user selection only; no shell strings) |
| `os.wallpaper.chooseAndSet` | `os.wallpaper.write` | Pick an image in an ND-owned native dialog and set it as the host desktop wallpaper; Personal only |
| `os.wallpaper.folders.list` / `add` / `remove` | `os.wallpaper.write` | Manage the linked wallpaper folders (multiple allowed; legacy single-folder setting is honored); Personal only |
| `os.wallpaper.playSources.set` | `os.wallpaper.write` | Choose what rotation plays: any mix of linked folders and collections (`folder:<path>` / `collection:<id>` refs); empty plays every linked folder; Personal only |
| `os.wallpaper.next` / `os.wallpaper.previous` / `os.wallpaper.random` | `os.wallpaper.write` | Play the rotation pool — the selected folders and collections — forward, backward, or randomly; Personal only, sensitive |
| `os.wallpaper.applySelected` | `os.wallpaper.write` | Apply the currently previewed selection; Personal only, sensitive |
| `os.wallpaper.preview` | `os.wallpaper.write` | Preview a library image without applying it; Personal only |
| `os.wallpaper.status` | `os.wallpaper.write` | Read the current wallpaper and library state; Personal only |
| `os.wallpaper.thumbnails` | `os.wallpaper.write` | Render library thumbnails for the rows currently on screen. Decoding runs in the nd-core sidecar, never in the desktop main process; Personal only |
| `os.wallpaper.links.list` | `os.wallpaper.write` | List the user's saved remote image links and the read-only ND-curated bundle; Personal only |
| `os.wallpaper.links.add` / `os.wallpaper.links.remove` | `os.wallpaper.write` | Save or remove a remote image link. Adding downloads the image first so only real, supported images are saved; Personal only |
| `os.wallpaper.links.apply` | `os.wallpaper.write` | Download (if needed) a linked image into the local cache and set it as the desktop wallpaper; Personal only, sensitive |
| `os.wallpaper.links.save` | `os.wallpaper.write` | Copy a curated bundle link into the user's own list without changing the wallpaper; Personal only |
| `os.wallpaper.links.next` / `os.wallpaper.links.random` | `os.wallpaper.write` | Play through the user's saved links in order or randomly, downloading missing images on the way; Personal only, sensitive |
| `os.wallpaper.collections.list` / `create` / `delete` | `os.wallpaper.write` | Manage named wallpaper collections (mixes of saved links and local folder images); Personal only |
| `os.wallpaper.collections.add` / `removeEntry` | `os.wallpaper.write` | Save images into one or more collections, or remove an entry; link refs must be valid https URLs, file refs absolute paths to supported images; Personal only |
| `os.wallpaper.collections.apply` / `next` / `random` | `os.wallpaper.write` | Play a collection: apply a specific entry, or walk it in order / randomly; Personal only, sensitive |
| `os.wallpaper.collections.rotate` | `os.wallpaper.write` | Solo a collection as the play source for rotation (toggling off returns to every linked folder); Personal only |
| `os.wallpaper.collections.preview` / `thumbnails` | `os.wallpaper.write` | Preview or thumbnail collection entries; decoding runs in the nd-core sidecar; Personal only |
| `os.wallpaper.links.preview` / `os.wallpaper.links.thumbnails` | `os.wallpaper.write` | Preview or thumbnail a linked image from the local cache; Personal only |
| `os.wallpaper.links.import` / `os.wallpaper.links.export` | `os.wallpaper.write` | Merge a wallpaper-links JSON bundle into the user's list, or export the user's links in the same bundle format; Personal only |
| `process.list` | `process.read` | List running processes in Personal with CPU and memory |
| `process.quit` / `process.forceQuit` | `process.quit` | Quit a selected process from a fresh ND-issued list handle; ND confirms each action and protects its own processes; Personal only |
| `disk.volumes.list` | `disk.read` | List mounted volumes with capacity and free space (metadata only); Personal only |
| `disk.scan.start` / `disk.scan.status` / `disk.scan.cancel` | `disk.read` | Run one cancellable disk-usage scan of a folder through the nd-core sidecar (parallel walk, size aggregation, a pruned result tree), watch live progress, or stop it; Personal only, sensitive |
| `disk.trash.move` | `disk.write` | Move one scanned item to the system trash after ND's own confirm dialog; filesystem roots and the home folder are refused; Personal only, sensitive |
| `disk.reveal` | `disk.read` | Reveal a scanned item in Finder/Explorer; Personal only |
| `chat.ask` | `chat.start` | Start an ND chat/agent turn from typed text |
| `workflow.list` / `workflow.refresh` | `workflow.read` | Read (or refresh) the project's repository task board through the existing read-only mirror |

Views are described, not coded: `host` loads the rows, `itemTitleKey` /
`itemBodyKey` name the fields to render, and `actions` run through the same
broker with the same authorization checks. A view's `description` is its
**empty-state message**, shown when the host method returns no rows — not
documentation. Compare `extensions/quit-process`, whose view description reads
"No processes are available. Refresh to try again."

### Settings

`settings` declares typed fields ND renders in the package's settings dialog.
Values are stored **per activation**, validated against the manifest, and
delivered to host methods on the invocation context.

Each handler decides whether to read them. Wallpaper Manager consumes `folder`,
`mode`, and `intervalMinutes`; the `note.*` handlers ignore settings entirely.
Declaring a setting that no handler in your package reads produces a field the
user can edit to no effect, so omit `settings` unless a host method you call
actually consumes it — which is why the sample manifest above has none.

The shape, taken from the shipped Wallpaper Manager:

```json
"settings": [
  { "key": "folder", "title": "Wallpaper folder", "type": "string", "default": "",
    "description": "Folder containing wallpapers. If empty, your system Pictures directory is used." },
  { "key": "intervalMinutes", "title": "Auto-rotate timer (minutes)", "type": "number", "default": 0,
    "description": "Change wallpaper automatically every N minutes (0 to disable)." }
]
```

`type` is `string`, `boolean`, or `number`; `default` must match it. Setting keys
match `^[A-Za-z][A-Za-z0-9._-]{0,63}$` and must be unique in the package.

## 4. Permissions, grants, and approval

- Declared permissions are a ceiling; activation is a second switch; a grant is
  the third.
- A **user** invocation is authorized by the explicit gesture (typing a command
  and running it, clicking a capture button, selecting an app in a picker).
- An **agent** invocation arrives through an opaque run credential bound to one
  context, engine, and permitted capability set. Sensitive reads
  (`capture.screen`, `capture.area`, `clipboard.read`) and sensitive OS effects
  such as `os.wallpaper.chooseAndSet` always require an explicit grant — remembered
  for routine use or granted once per action.
- Deny wins everywhere: an organization policy of `deny` blocks the action even
  for the user, and revoked grants, disabled activations, stale credentials, and
  cross-context calls fail closed.
- ND logs decision metadata (extension, host, context, caller, outcome) and
  never clipboard contents, screenshots, credentials, or run tokens.

## 5. Distribution and lifecycle

### Delivery models: core built-ins and external packages

New optional extensions are external and installed on demand. Their UI,
assets, vendored libraries, and package-specific logic stay in the package;
do not add them to `electron-builder.yml` or import their UI into the app shell.
Only product-core capabilities belong in `builtin-extension-packages.ts`.
Reusable native host contracts remain in ND and enforce authority on every call.

- Development Discover installs repository folders. Release builds fetch catalog
  metadata only when the user opens Discover, then download only the selected
  package after Install. Starting ND performs no catalog network requests.
- Run `pnpm ext:catalog` after committing extension sources. Release staging
  also generates `.release/nd-extension-catalog.json`. Upload this file as a
  separate asset of the dedicated `nd-extension-catalog` GitHub prerelease.
  This keeps catalog updates independent of app installer releases. Package files are fetched from the
  immutable Git revision recorded in that catalog, with per-file SHA-256 and
  size checks. The catalog and package folders are **not** part of the installer.
- The default metadata URL is the ND repository's dedicated
  `nd-extension-catalog` release asset, not the latest app release.
  `ND_EXTENSION_CATALOG_URL` is a trusted deployment/development override for
  the HTTPS metadata location; asset downloads remain restricted to the ND
  repository. A private or unpublished repository/release cannot serve anonymous
  downloads; users can still install from a folder while distribution is prepared.
- Normal release staging refuses dirty/uncommitted package sources. To publish
  an existing reviewed commit without including local work, use
  `pnpm ext:catalog --revision <commit> --packages <directory,directory>`. This
  reads manifests and file bytes directly from Git objects. Publishing
  metadata is a release step, not something extension installation does.
- Installation snapshots package files through `extensions.snapshot` in nd-core.
  Rust owns the bounded directory walk, copy, cancellation and atomic directory
  replacement; main owns manifest validation, activation and provenance. The
  in-process snapshotter is a unit-test seam, not a production fallback.
- Every file copied, including `node_modules`, is checked. Symlinks and
  non-regular files are refused. Limits are 5,000 entries, 8 MiB per file, and
  24 MiB per package. Asset serving separately verifies real-path containment.
- ND keeps the active and previous version; installing another update removes
  older snapshots. Rollback swaps the two retained versions.

### Background views and runtime budgets

Web views unload when the dialog closes by default. In Settings → Extensions →
Background extension limits, the user can allow individual packages to keep a
closed view alive, choose a maximum of 0–16 background views (default 4), and
choose an idle timeout of 1–20 minutes (default 5). Oldest background views are
released first when the limit is reached; foreground views are not evicted.
Expiry destroys the iframe and can discard unsaved UI state, so persist important
state through declared view actions. Only opened views consume a renderer heap;
installing a package does not start an iframe or executable.

Deactivation, uninstall, and a version change release retained views. Tokens
are revoked when a view is released. Expired asset tokens cause a fresh load on
reopen. A view may have at most eight pending bridge actions. Native jobs such as
clipboard recording, wallpaper rotation, and reminders have their own activation
and setting controls; keeping an iframe alive is not required for those jobs.
External MCP calls continue to start their process on demand and close it after
the call, rather than keeping every installed runtime resident.

Registry lookup uses indexed package/activation records, a bounded context command
cache with mutation invalidation, and paged management cards. Use
`pnpm bench:extensions` to measure 10, 100, 1,000, and 5,000 installed packages;
it measures warmed registry enumeration, not whole-app CPU or RAM.

Package authors must also bound the work inside a running extension. Render
static canvas/WebGL views on changes, stop animation frames when hidden or
zero-sized, and animate only while something is changing. Dispose GPU geometry
and materials when replacing them. Avoid continuous polling: prefer events or
an explicit refresh, and prevent overlapping background jobs. Use nd-core for
heavy native work and keep synchronous CPU/filesystem work off the app's main
thread. Count/idle limits bound residency; they do not enforce a per-extension
CPU or memory quota. Check actual idle CPU, GPU activity, memory, and UI response
with representative active extensions before making whole-PC performance claims.

- **Validate**: `node scripts/validate-nd-extension.mjs <folder>` (or
  `pnpm ext:validate`). The folder form requires a file named exactly
  `nd-extension.json`; you can also pass a manifest path directly. Multiple
  targets are accepted, and `--builtins` validates the shipped packages.
- **Install**: Settings → Extensions → *Install from folder*, the **Discover**
  catalog, or hand a teammate a private Git checkout and install from that
  working copy. The dialog rejects a directory without `nd-extension.json`,
  and rejects symlinks and paths that escape the package root.
- End-to-end walkthrough — validate, install, activate, run — is in
  [`examples/nd-extension-hello/README.md`](../../examples/nd-extension-hello/README.md).
- Packages ship **prebuilt**. ND snapshots content, records source provenance
  (including the resolved Git revision when available), and never runs
  `npm install`, `postinstall`, or build scripts.
- **Update** installs a new version only after it validates and permission
  review; **rollback** returns to the previous version; **uninstall** revokes
  activation and grants while leaving your notes and captures untouched.
- Symbolic links inside a package are rejected, because a link can escape the
  package root. Package assets are also size-capped (8 MB per file, 24 MB
  total) so no package can smuggle unbounded content past the installer.

### Web views: packages that ship their own UI

A view with `kind: "web"` is the one place a package may ship UI code of its
own. ND renders the package's `entry` document (for example `ui/index.html`)
in an iframe whose origin is a **token-scoped private scheme** — unique per
dialog load, cross-origin from the app and from every other package view,
with no Node and no network. The frame's only reach into ND is the
`nd.webview/1` postMessage bridge, and every bridge request is routed through
the same broker invocation path as any other contribution call, so
permissions, contexts, and audit never depend on what the frame claims.
Serving is token-scoped: main issues a per-dialog token bound to the installed
version, re-checks snapshot containment, an asset-type allowlist, and the size
caps on every request, and revokes the token when its live view is released.

Rules for a web view:

- `entry` must be a relative `.html` path inside the package — no `..`, no
  absolute paths. Only the asset types in the serving allowlist (HTML, JS,
  CSS, JSON, common images and fonts) are delivered.
- Package assets are capped (8 MB per file, 24 MB total) at install time,
  alongside the existing symlink and file-count rejections.
- The UI's own CSP comes from ND (no `connect-src`, script only from the
  private scheme); mirror it in a `<meta>` tag for defense in depth.
- Privileged operations go through the bridge as view-action invocations
  (`{ action: '<id>', … }`), which the broker routes to the action's declared
  host method. A web view with no named action runs nothing.
- Announce `nd-webview:ready` only once your controls are bound. The host
  unhides the frame on that message, and an interaction that lands while the
  UI script is still loading is silently dropped — so `ready` must mean "the
  UI can accept input", not "the script started".
- `extensions/tic-tac-toe/` is the reference implementation: a three.js game
  whose scoreboard persistence is three ordinary host methods. Its game logic
  (`ui/game-core.js`) is unit-tested straight from the repository, and the
  package stays fully external — it is never staged into the app bundle. Dev
  builds install it from the repository folder; packaged builds install it from
  the separately published catalog or a local folder.

## 6. What v1 deliberately does not support

- Arbitrary extension HTML/React panels or renderer DOM access outside the
  sandboxed web-view contract above.
- Executable lifecycle hooks; instruction-only hooks remain instructions.
- A second general-purpose JavaScript runtime, or running Raycast/VS Code
  packages unchanged.
- An OS sandbox for external MCP executables: they run with your desktop user's
  OS permissions, which activation details say explicitly. Executable trust is
  separate from ND API grants.
- Public marketplace publishing, review, billing, and automatic updates.

## 7. Example: the ND-maintained packages

`Daily Essentials`, `Wallpaper Manager`, and `Project Workflow` ship with ND and
use exactly these contracts. They are defined in
[`src/shared/builtin-extension-packages.ts`](../../src/shared/builtin-extension-packages.ts)
rather than as folders on disk, so they are readable as reference manifests
inline. Wallpaper Manager is the first native-host proving package: it is
Personal-only, permission-scoped, and the one package whose host methods
actually consume `settings`. Validate the built-ins any time with:

```bash
node scripts/validate-nd-extension.mjs --builtins
```

`Quit Processes` is an optional external package under
`extensions/quit-process`. It appears in Settings → Extensions → Available and
is installed only when selected, then activated for Personal separately. Its
command uses `openViewId` to open the process view from either launcher, and its
view uses `refreshIntervalMs` to refresh while open.

`ND Translate` is another optional external package under
`extensions/translate`. Install it from Settings → Extensions → Available,
activate the context where it will be used, then run ND Translate in the
launcher. It contributes manifest data to the native ND translator view;
packages cannot inject their own React or browser scripts. The translator UI
loads as a separate chunk and adds no third-party runtime dependency.

Its `browser.translate` host requires `browser.navigate` and accepts
`{ text, sourceLanguage, targetLanguage, provider }`. Providers are `google`
(default), `chatgpt`, and `gemini`; text is limited to 5,000 characters and the
target cannot be `auto`. Calls return `idle`, `translated`, `login-required`,
`challenge`, `error`, or `busy`. Only `translated` contains successful output.
Provider pages run in ND's sandboxed embedded browser. The extension requires
no API key; provider websites may require sign-in, verification, or consent.
Signed-out AI availability depends on device and region and must not be sold
as an unconditional promise.

Validate the package with `node scripts/validate-nd-extension.mjs
extensions/translate`. Desktop regression coverage is in
`e2e/nd-translate.spec.ts`; opt into external service smoke with
`ND_TRANSLATE_LIVE=1` and `ND_TRANSLATE_AI_LIVE=1`.

`ND 3D Tic-Tac-Toe` under `extensions/tic-tac-toe` is the reference for the
**fully external** delivery model and for web views: a three.js game that
ships its own UI (`kind: "web"`), stays out of the release bundle entirely, and
persists its scoreboard through three ordinary host methods
(`tictactoe.stats.get/record/reset`). Dev builds list it in the Discover
catalog; packaged users install it from a folder. Its pure game logic
(`ui/game-core.js`) is unit-tested directly from the repository, and desktop
coverage is in `e2e/tic-tac-toe.spec.ts`.

`ND Disk Cleaner` under `extensions/disk-cleaner` is the reference for heavy
native work behind a web view: the parallel disk-usage scan runs in the
nd-core sidecar (bounded, cancellable, progress events), while the package
ships only a sandboxed canvas UI whose privileged actions are
`disk.volumes.list`, `disk.scan.start/status/cancel`, `disk.trash.move`, and
`disk.reveal`. Its pure layout logic (`ui/sunburst.js`) is unit-tested
directly from the repository; desktop coverage is in
`tests/disk-cleaner-extension.test.ts` and `e2e/disk-cleaner.spec.ts`.

For the real model-backed coding autopilot scenario, build first and configure
the gitignored `.env.e2e`. In PowerShell, run:

```powershell
$env:ND_PM_SCENARIO = 'nd-translate'
node e2e/pm-fullstack.mjs
```

This creates a disposable ND Team
company with mission “Build ND super apps.” It asks the PM/workers to generate
an installable package from a host contract, checks overlapping execution and
real child sessions, then installs and translates with the generated package.
Before enabling Autopilot, the scenario selects **Deliver now → All work** in
the visible UI; the default first-milestone focus deliberately requires human
selection to advance. Code tasks pass the project's test command in isolated
worktrees, so tests that import another task's output depend on its integration.
There are no retry nudges or synthetic plans. A source-app scenario does not
establish packaged public-release readiness.
