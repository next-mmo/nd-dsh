# ND Video Gen (extension package)

A local short-form vertical (9:16) 3D video studio built as a fully external ND extension (`nd.extension/1`). It renders an original kinetic studio orb scene with [three.js](https://threejs.org), composites editorial hook and call-to-action typography directly onto every frame, and exports a playable `720×1280` WebM clip at ~30 FPS inside ND's sandboxed extension web view.

Install the package on demand in an ND app build that supports the Video Gen host actions.

## Install & Run (Install from folder)

1. Open ND **Settings → Extensions**.
2. Click **Install from folder…** and select this directory (`extensions/nd-video-gen`, containing `nd-extension.json`).
3. Activate **ND Video Gen** for **Personal**.
4. Open the Quick Launcher (`Cmd+K` / `Ctrl+K`), select **Personal** if a project is active, then search for and run **ND Video Gen**.
5. Choose a **Text model** from your active ND Router text API models, enter a brief, and click **Generate scene settings**. Review or edit the resulting hook, call to action, and palette, then click **Render video** and **Save**.

After adding a provider in **ND Router**, click **Refresh** in the studio. You can edit the scene and render locally without a model.

Validate the manifest any time from the repository root:

```bash
pnpm ext:validate extensions/nd-video-gen
```

## Features

- **Cinematic 9:16 Kinetic Orb template**: dark editorial studio palette, faceted obsidian-chrome core, dual glowing orbital rings, subtle light shards, procedural particle field, and smooth camera motion.
- **Burned-in editorial overlays**: editable **Hook** (up to 72 characters) and **Call to Action** (up to 36 characters) drawn directly onto the `720×1280` composite canvas so live preview and exported video match frame-for-frame.
- **Bounded duration**: `4s`, `6s` (default), or `8s` clip length.
- **Playback controls**: Play / Pause, Replay, and live timeline indicator; static paused views perform zero background GPU draws.
- **WebM export & Save**: composites WebGL + 2D text into a single `720×1280` canvas captured via `captureStream(30)` + `MediaRecorder` (`video/webm;codecs=vp9` / `vp8` fallback) with progress, Cancel, and local Blob **Save Video** download.

## Layout

| Path | Purpose |
| --- | --- |
| `nd-extension.json` | Extension manifest (`nd.extension/1`, Personal context, `web` view). |
| `ui/index.html` | Sandboxed web-view document (strict CSP, dark editorial studio UI). |
| `ui/studio-core.js` | Pure timeline, choreography, text-wrapping, codec, and filename helpers. |
| `ui/bridge.js` | `nd.webview/1` handshake, theme, and declared host actions. |
| `ui/app.js` | three.js scene, `720×1280` 2D composite + burn-in, `MediaRecorder` export, and `nd.webview/1` handshake. |
| `ui/vendor/three.module.js`, `ui/vendor/three.core.js`, `ui/vendor/LICENSE` | Vendored three.js pair and MIT license — never imported by the ND app shell. |

## three.js provenance

- Upstream: https://github.com/mrdoob/three.js — MIT license (included in `ui/vendor/LICENSE` from `three@0.186.1`).
- Vendored version: **0.186.1** (`build/three.module.js` + `build/three.core.js`, Copyright 2010-2026 Three.js Authors), aligned with `extensions/tic-tac-toe`. Replace both files and the license together when upgrading.

## Runtime & Security Model

- Runs in ND's cross-origin `nd-extension-ui://` iframe with strict CSP (`connect-src 'none'`, no Node, no network, no hidden browser windows).
- Generating scene settings sends the brief to the selected text API model through ND Router. ND applies validated text and a predefined palette to the local Three.js template.
- Preview, rendering, and export run locally in WebGL without a Python runtime.

## Future ND GPU + `uv` Boundary (Opt-in AI Clips)

The shipped WebGL studio runs completely self-contained in Chromium without Python or native ML dependencies. **ND GPU** currently has a standalone Apple MPS feasibility probe only and no shipped host interface yet.

If opt-in generative AI video clips are added in a future release, they will sit behind an explicit ND-managed boundary:

1. **No activation-time installs**: activating `ND Video Gen` will never download models or run `pip` / `uv` scripts.
2. **Brokered host contract**: any future AI render request would flow from the web view through declared `nd.extension/1` view actions to an ND main-process/sidecar host method with explicit context and size/timeout bounds.
3. **ND GPU + `uv` runtime ownership**: ND's capability/runtime layer—not the extension iframe—would manage an isolated `uv` Python environment and local MPS/GPU execution on opt-in user action, returning finished local clip assets back through ND's controlled asset path.

## Changelog

- **1.1.0** Adds text model selection and brief-based generation of editable overlays and a palette.
- **1.0.1**: Disable **Save** and guard its handler whenever rendered output is stale after text or duration edits (ignoring no-op edits/duration clicks), re-enabling after re-render.
