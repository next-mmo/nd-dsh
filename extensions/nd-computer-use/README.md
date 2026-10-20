# ND Computer Use

Read-only desktop observation for ND. The package is an external ND extension:
nothing here ships in the app bundle, and installing it never runs build
scripts.

## What it does

- Lists running apps that own a targetable top-level window.
- Reads one window at a time: a bounded screenshot plus an indexed
  accessibility tree (or a diff from the previous read).
- Element indexes are valid only for the state that produced them.
- `stateId` identifies the exact tree snapshot for a future action surface.

It deliberately does **not** click, type, press keys, scroll, drag, launch,
activate, or close anything.

## Permissions

- `computer.read` — read app window screenshots and accessibility trees.
  Personal context only. Window state is a sensitive read: agent callers need
  an explicit grant; a user's own gesture in this view authorizes the read.

## Limits

- Windows only. Other platforms fail closed with a clear error.
- Running apps only; installed-but-not-running apps are not enumerated.
- One screenshot per read (no transient menu/popup composite).
- At most 1,500 accessibility nodes, depth 24, 48k text characters.
- Screenshots are JPEG-encoded under 128 KiB so the whole state fits ND's
  262,144-character web-view bridge budget. If the text is unusually large the
  screenshot is dropped and `screenshotUnavailable` explains why.
- Minimized, elevated (UIPI), protected, or hung windows may return no
  screenshot. The tree is still attempted when available.
- The tree is ND's own compact format; it is not a byte-for-byte clone of any
  vendor's accessibility text.
- A Chromium app (ChatGPT, Chrome, Electron) may expose only a shallow tree on
  the first UIA read while it enables accessibility. Read once more if the tree
  looks incomplete; later reads are full.
- Window capture uses `PrintWindow(PW_RENDERFULLCONTENT)` with a `BitBlt`
  fallback. It was verified against an occluded Chromium window; Windows
  Graphics Capture is not used in this version.

## Implementation

All native work runs in `nd-core`:

- `computer.apps.list` — window enumeration and app grouping.
- `computer.app.state` — UIA tree walk, window capture, diff cache.
- `computer.session.reset` — clears the per-context diff cache (called when the
  extension is deactivated, updated, rolled back, or uninstalled).

The web view only renders the bounded result.
