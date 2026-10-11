# ND Mini Browser

**Status: M3 browser chrome.** An ND extension package (`nd.extension/1`, id
`nd.mini-browser`, formerly `nd.youtube-mini`) that keeps a **browser
dashboard alive like a browser tab**: open, switch, and close many REAL tabs
of the ND built-in browser from a persistent chrome, save quick links, and
quick-open addresses straight from the launcher.

The sandboxed iframe has no network access (ND's strict web-view CSP), so the
chrome never renders page content itself — every tab is a real tab of the ND
embedded browser (the canonical WebContentsView engine), created/activated/
closed through the platform. Because ND keep-alives opened web views, the
chrome stays mounted across dialog closes and app navigation, and the session
snapshot is durable: after an app restart the remembered tabs come back as
sleeping rows and resume by URL when you focus them.

The former YouTube Mini watch queue migrates into quick links automatically
(`userData/nd-youtube-mini/queue.json` → `nd-mini-browser/session.json`), so
nothing saved before the rename is lost.

## What this milestone declares

| Contribution | Kind | Host | Permission | What it does |
| --- | --- | --- | --- | --- |
| `mini-browser-open` | command | `minibrowser.session.list` | `minibrowser.read` | Launcher command **ND Mini Browser**; opens the chrome view without navigating |
| `mini-browser-open-url` | command | `minibrowser.tab.open` | `minibrowser.write` | Quick open: types an address, opens it as a real ND-browser tab — no chrome needed |
| `mini-browser-save-link` | command | `minibrowser.link.save` | `minibrowser.write` | Saves the typed address as a quick link |
| `mini-browser` | view (web) | — | actions below | The keep-alive chrome: tab session rows (live + sleeping), address bar, quick links |
| `mini-browser-quick-links` | view (list) | `minibrowser.link.list` | `minibrowser.read` | Schema-driven rows over the same durable links |

The chrome's actions are `session` / `open` / `activate` / `close` /
`link-save` / `link-remove`, backed by the `minibrowser.*` host methods
(`minibrowser.read`, `minibrowser.write` — personal context only,
non-sensitive where the data is a list of already-public links; agent callers
still need an explicit broker grant). The session is one atomic JSON file in
`userData/nd-mini-browser/session.json`; a corrupt file falls back to a fresh
session and a tab is never worth failing the view over.

Contexts: personal. The package declares no `executable` (nothing to trust at
activation) and no `settings`.

Opening a tab emits the browser-focus event with its owning context, so ND
surfaces the site in the **Personal** space's full-size browser pane, even while
a company or project is the active selection. A Personal-only package never
opens inside a company's or a project's workbench.

## What is deliberately not here yet

- **M4 — session I/O niceties**: duplicate-tab folding, pinned order, and a
  favicon cache. Rendering pages inside the keep-alive frame stays impossible
  by design (no network in the sandbox); ND's embedded browser remains the
  engine.
- **Ad blocking** remains an ND-browser platform milestone (request-level
  filtering), not something a package can fake.
## Layout

```
nd-mini-browser/
├── nd-extension.json        # nd.extension/1 manifest (id nd.mini-browser)
├── package.json             # verification chain: verify → typecheck, test, build
├── README.md
├── ui/                      # the keep-alive browser chrome (sandboxed, no network)
│   ├── index.html           # entry: queue console + CSP mirror
│   ├── chrome.js            # nd.webview/1 bridge client + chrome DOM wiring
│   ├── chrome-core.js       # pure session-model helpers (unit-testable)
│   └── chrome-core.d.ts
├── scripts/
│   ├── nd-contract.mjs      # shared manifest contract + credential-shape patterns
│   ├── typecheck.mjs        # JSON/contract checks + verification-wiring checks
│   └── build.mjs            # install-readiness checks (no artifacts: ND installs folders prebuilt)
└── test/
    └── smoke.test.mjs       # independent node:test assertions (the executable spec)
```

## Verification

Zero dependencies, Node 21+, no install step:

```bash
npm run verify     # or: pnpm verify
```

`verify` chains three scripts, each also runnable alone:

- `typecheck` — parses every JSON file, validates the manifest against the
  `nd.extension/1` contract this package relies on, and proves `package.json`
  wiring stays complete (all four scripts exist, `verify` chains them, every
  `scripts/*.mjs` file is reachable from a script).
- `test` — `node --test "test/*.test.mjs"`: the smoke test asserts protocol and
  id, declared command/view contributions, unique contribution ids, host
  allowlisting with permission coverage, context narrowing, the verification
  wiring itself, and that no shipped file contains a credential-shaped value.
- `build` — install readiness: required files present, no symlinks (the ND
  installer rejects them), no credential files, no secret-shaped values.

The authoritative check is the ND-DSH runtime validator; run it from the
repository root:

```bash
node scripts/validate-nd-extension.mjs extensions/nd-mini-browser
```

## Security

No credentials, API keys, passwords, or environment files are present in this
package, and verification fails if any shipped file starts to contain one.
