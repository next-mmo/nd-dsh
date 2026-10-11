---
name: create-extension
description: Create, extend, or review ND Extensions (nd.extension/1 packages) in the nd-dsh repo — launcher commands, typed list/detail views, package-shipped web views (three.js/canvas/games), skills, tools, workflows, host methods, and delivery-model wiring (built-in vs on-demand Discover catalog vs fully external). Use whenever the user wants to build an ND extension, add a command or view to one, ship a game or custom-UI extension, decide between on-demand vs built-in, asks about the Discover catalog, nd-extension.json manifests, host methods, or extension packaging — even if they just say "make an extension" or "add this as a plugin/command".
---

# Create an ND Extension

ND extensions are declarative packages: one folder with an `nd-extension.json`
manifest. Contributions reference an allowlist of host methods; the broker is
the only execution boundary. **Default delivery is fully external, on demand** —
the package lives in git, ships zero bytes in the release, and users install it
when they want it. Do not stage anything into the app bundle unless the user
explicitly asks for catalog-wide availability.

## Read first (always)

1. `src/shared/extension-package.ts` — the authoritative contract: manifest
   types, `ND_EXTENSION_PERMISSIONS`, `ND_HOST_METHODS`, and the validator.
2. `docs/extensions/authoring.md` — the full authoring guide (§5 covers
   delivery models and web views).
3. The closest existing package, for tone and shape:
   - Typed list/detail view: `extensions/password-vault/`
   - Web view (package-shipped UI): `extensions/tic-tac-toe/`
   - Minimal starter: `examples/nd-extension-hello/`

## Step 1 — Pick the delivery model

| Model | Ships in release? | Found in Discover | Use when |
| --- | --- | --- | --- |
| **Fully external** (default) | No — zero impact | Dev builds only | Anything not explicitly product-core. Experiments, large assets, opt-in packages. |
| **On-demand staged** | Yes (+package size) | Every build, one-click Install | First-party extras small enough to ship for everyone (like Password Vault). |
| **Built-in** | Inside the app bundle | Always; cannot be uninstalled | Only when the behavior IS the product and must always exist (like Wallpaper Manager). |

Ask only if the user's intent is ambiguous between models; otherwise default to
fully external and say so in one sentence. Promotion between models later is a
small, reviewable diff (Step 5).

## Step 2 — Pick the contribution shapes

- **Command** (`contributions.commands`): the launcher entry point. Give it
  `keywords` for search, and `openViewId` to open a view. Every command needs a
  `host` even when `openViewId` means it never executes (pick the read-only
  host the view flow already uses).
- **View** — two kinds:
  - `list`/`detail` (default): ND renders rows from a host method. Use when
    structured data is enough. Requires `host`, `itemTitleKey`.
  - `web`: the package ships its own UI (`entry: "ui/index.html"`), rendered
    in a token-scoped cross-origin iframe with no Node and no network. Use
    only when ND's rendering cannot express the UI (games, canvases, bespoke
    tools). Requires an `entry`; `host`/`itemTitleKey` are not needed; ALL
    privileged operations must be declared as view `actions` — a web view
    without a named action executes nothing.
- **Skill / tool / workflow**: skills are instruction text, tools need an
  `mcp-stdio` `executable` block, workflows are project-only plugins. Rare;
  see authoring.md.

## Step 3 — Host methods: reuse or add

First try the existing allowlist in `ND_HOST_METHODS`
(`src/shared/extension-package.ts`). To add new ones, the full vertical is:

1. Permission in `ND_EXTENSION_PERMISSIONS` (name it `<domain>.read`/`.write`).
2. Descriptor in `ND_HOST_METHODS` — set `contexts` (usually
   `['personal']`) and `sensitive` honestly (`sensitive: true` forces an
   explicit grant for agent callers; a game scoreboard is not sensitive).
3. Handler via `host.register(...)` inside `registerNativeHostHandlers`
   (`src/main/extensions/nd-ipc.ts`) — `requirePersonalContext(context)` first
   when personal-only. The `missingNativeHostMethods` probe fails the build if
   any allowlisted method lacks a handler, so register everything you declare.
4. Validate inputs at the host (e.g. `asTicTacToeOutcome`), never trust bridge
   input passed through the broker.

## Step 4 — Scaffold the package

```text
extensions/<kebab-name>/
├── nd-extension.json      # protocol "nd.extension/1", apiVersion 1
├── README.md              # what it does, install steps, provenance
└── ui/                    # web views only: entry html + js (+ vendored libs)
```

Manifest skeleton (keep descriptions honest — they render in the UI):

```json
{
  "protocol": "nd.extension/1",
  "id": "nd.example",
  "name": "ND Example",
  "description": "What it does, stated plainly.",
  "version": "1.0.0",
  "apiVersion": 1,
  "contexts": ["personal"],
  "permissions": ["example.read"],
  "settings": [],
  "contributions": {
    "commands": [
      { "id": "open", "title": "ND Example", "keywords": ["example"],
        "host": "example.stats.get", "openViewId": "main", "contexts": ["personal"] }
    ],
    "views": [
      { "id": "main", "title": "ND Example", "kind": "web", "entry": "ui/index.html",
        "contexts": ["personal"],
        "actions": [ { "id": "get", "title": "Read data", "host": "example.stats.get" } ] }
    ]
  }
}
```

Validate immediately: `pnpm ext:validate extensions/<kebab-name>`.
Vendored libraries (like three.js) stay inside the package, note version +
license in the README, and are subject to the installer caps (8 MB/file,
24 MB total). Package scripts that the UI imports must be plain JavaScript
(.js, no TS annotations) so they run unbuilt in the frame and stay directly
unit-testable from the repo; add a `.d.ts` beside them for typecheck.

## Step 5 — Wire the delivery model

- **Fully external (default)**: add a **dev-only Discover entry** so
  developers get one-click install while packaged releases carry nothing:
  - `TIC_TAC_TOE_ID`-style id const + `xxxPackagePath()` helper in
    `nd-ipc.ts` (dev: `join(app.getAppPath(), 'extensions', '<name>')`),
  - `...(app.isPackaged ? [] : [{ id: XXX_ID, path: xxxPackagePath }])` in
    `AVAILABLE_PACKAGES`,
  - `...(app.isPackaged ? [] : [xxxCatalogView(state)])` in `stateView`,
  - an accent tile in `EXTENSION_ACCENTS` (`ExtensionPackages.tsx`).
  Do NOT touch `electron-builder.yml`.
- **Staged**: the same wiring WITHOUT the `app.isPackaged` gate, plus
  `electron-builder.yml` extraResources
  (`- from: extensions/<name> / to: nd-extensions/<id>`). Say the release-size
  cost out loud to the user.
- **Built-in**: move the manifest into
  `src/shared/builtin-extension-packages.ts` + `defaultActivationContexts`;
  uninstall is refused for built-ins.

## Step 6 — Tests (mirror the newest example)

- Unit: `tests/tic-tac-toe-extension.test.ts` is the template — manifest
  validation + permission derivation, install/activate/uninstall via a real
  `ExtensionPackageStore`, broker gating with stub `NativeHostRegistry`
  handlers (user ok, wrong context denied, agent → `approval-required` →
  approve → ok), web view `loadView` shape (`kind: "web"`, no host call,
  activation gate).
- Package logic: import the shipped `ui/*.js` module directly in a vitest file
  and test the artifact the game actually runs (win detection; minimax never
  loses).
- E2E: `e2e/tic-tac-toe.spec.ts` is the template — install via
  `installAvailable` (the Discover path), activate through the bridge, open
  from Ctrl+K, drive the game (keyboard 1–9), assert persisted state on disk.
- Web-view gotchas (each cost a debugging session — do not rediscover them):
  the app shell CSP needs `frame-src nd-extension-ui:`; asset responses need
  `access-control-allow-origin: *` (opaque/token origins always fail module
  CORS); do NOT put a `sandbox` attribute on the iframe (Chromium drops
  postMessage out of sandboxed non-special-scheme iframes); filter bridge
  messages by `event.origin` (not `event.source` — unreliable cross-origin);
  the frame must queue work until the host's `hello` handshake lands (an
  initial fetch always races the handshake); tokens are TTL-only — never
  revoke on effect cleanup (React StrictMode double-mounts effects in dev and
  would pull the token out from under the frame's asset loads, leaving the
  view stuck on its loading state); the frame's announce loop must retry
  forever with backoff (a host that mounts late must still connect).

## Step 7 — Verify before reporting done

```bash
pnpm ext:validate extensions/<name>
pnpm typecheck && pnpm test && pnpm build
npx playwright test e2e/<name>.spec.ts
```

For external packages, confirm `git diff` shows no `electron-builder.yml`
change (zero release impact). Never commit secrets; extension packages and
their fixtures are code-reviewed like any other source. Update
`docs/extensions/authoring.md` only when you changed the contract itself, not
per package.
