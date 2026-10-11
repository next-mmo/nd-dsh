# ND 3D Tic-Tac-Toe (extension package)

An on-demand ND extension that ships its own UI: a 3D tic-tac-toe board rendered
with [three.js](https://threejs.org), played inside ND's sandboxed extension
web view. It is **not** bundled with the ND app — nothing here affects the
release download. Install it at runtime:

- **Dev builds**: it appears in **Settings → Extensions → Discover** (ND finds
  it in this repository) — click Install there.
- **Packaged builds**: it is not in Discover (the package is never staged into
  the release). Use **Settings → Extensions → Install from folder…** and
  choose this directory (the one containing `nd-extension.json`).

Then activate it for **Personal** and run **"Play 3D Tic-Tac-Toe"** from the
launcher (`Ctrl+K`).

## What it contributes

- Command `play` → opens the `board` view (`kind: "web"`, entry `ui/index.html`).
- View actions `record` / `reset` → the scoreboard host methods
  (`tictactoe.stats.record` / `tictactoe.stats.reset`), plus the read path
  `tictactoe.stats.get` as the view's data host.
- Scoreboard persistence lives main-side in `userData/nd-tic-tac-toe/stats.json`.

## Controls

- **Play**: click a cell — picking intersects the board plane, so it works from
  any camera angle — or press keys 1–9 in reading order (the faint digits on
  the board match).
- **View**: fixed. The camera sits at a near top-down angle so every cell is
  equally readable and clickable; there is no orbit, zoom, or preset switching
  to knock the board off-angle mid-game.

## Layout

| Path | Purpose |
| --- | --- |
| `nd-extension.json` | The manifest — the only executable-trust surface ND validates. |
| `ui/index.html` | Web-view entry document (strict CSP, dark theme chrome). |
| `ui/game.js` | three.js scene, plane-based cell picking, fixed camera, bridge client. |
| `ui/game-core.js` | Pure rules + minimax/easy AI. Unit-tested straight from the repo. |
| `ui/vendor/three.module.js`, `ui/vendor/three.core.js` | Vendored three.js — the app bundle never includes it. |

## three.js provenance

- Upstream: https://github.com/mrdoob/three.js — MIT license.
- Vendored version: **0.186.1** (`build/three.module.js` + `build/three.core.js`,
  Copyright 2010-2026 Three.js Authors). Replace both files together when
  upgrading; they are a pair (`three.module.js` re-exports `three.core.js`).

## Security model (what the frame can and cannot do)

- The iframe runs on a token-scoped private origin — unique per dialog load,
  cross-origin from the app and from every other package view: no cookies, no
  same-origin reads of the app, and no Node.
- Popups are denied by ND at the webContents level, and top-level navigation
  is blocked cross-origin by the same-origin policy.
- Assets are served over a private, token-scoped scheme with a strict CSP
  (`connect-src 'none'` — no network from the game).
- Scoreboard reads/writes are brokered host-method invocations; permissions and
  contexts are enforced by ND, not by this script.
