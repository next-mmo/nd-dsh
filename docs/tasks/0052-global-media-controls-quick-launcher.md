# TODO 0052 — OS-style media controls in the quick launcher

> Priority: high
> Owner: release
> Status: shipped (validated by `e2e/launcher-media-controls.spec.ts`)
> Depends on: built-in browser tabs (`browser-controller`), nd-core sidecar
> PRD: none — user request from the private beta

## Objective

Pausing or skipping music playing in ND's embedded browser meant reaching for
the OS flyout or the page's own player. The quick launcher popup — one global
shortcut away — should carry the same transport the OS shows: previous,
play/pause, next, plus what is playing.

## Why

The popup is ND's fastest surface: `Ctrl+Shift+Space` from anywhere. Media
playing in a browser tab is the one everyday thing the popup could not touch,
so every pause was a context switch out of ND.

## What shipped

- `src/main/browser/media-session-tracker.ts`: per-tab `media-started-playing`
  / `media-paused` tracking across every embedded browser tab, one active
  session (most recent playing tab, else most recent paused one), metadata
  read out of the page via `navigator.mediaSession` with `document.title`
  fallback.
- Transport controls injected into the playing tab: play/pause toggles the
  tab's `HTMLMediaElement`s; next/previous click per-site transport buttons
  (YouTube, YouTube Music, Spotify web, SoundCloud).
- `media.key` nd-core RPC (`crates/nd-runtime/src/media.rs`, Windows
  `keybd_event` with the extended-key flag): the fallback when the page offers
  no button to press, which also reaches media playing outside ND exactly like
  OS media keys do. Non-Windows is a hard error the desktop swallows.
- `media:*` IPC channels admitted to the launcher popup surface, preload
  `window.ndDsh.media`, and a now-playing row in `QuickLauncher` (artwork or
  music glyph, title, artist · site, SkipBack/Play/Pause/SkipForward).
- State is pushed to the main window and the popup, so pausing from the page
  updates the row without renderer polling.
- Playback and metadata are reconciled from the page once per second after a
  tab first plays, and when a launcher requests state. SPA history changes and
  iframe navigations preserve the session; a real main-document navigation
  clears it. This keeps YouTube Music's pause icon and track metadata current
  even when native playback notifications are missing or refer to another
  media element. Reads never overlap, and obsolete snapshots cannot restore a
  replaced document or overwrite a newer playback event.
- An independent System volume row stays visible even without a track. Its
  slider and mute toggle control the default OS output through nd-core
  `media.volume-state` / `media.volume-set` (Windows endpoint-volume COM and
  macOS CoreAudio). Open launchers refresh once a second to follow volume keys
  and output-device switches. Fixed-volume devices, missing sidecars, and
  unsupported platforms show an unavailable state; devices without a native
  mute property keep the slider available and disable the mute button.
- Slider writes are serialized and coalesced; volume adjustment preserves mute
  and macOS stereo balance. Volume keyboard gestures do not run launcher commands.

## Invariants

- The tracker never injects into a destroyed `WebContents`; every control call
  degrades to the OS key or a no-op instead of throwing into the popup.
- The popup surface keeps its admitted-channel rule: media channels go through
  `handleLauncherSurface`, never the trusted-only registrar.
- e2e never presses next/previous: their fallback synthesizes a real OS media
  key on the host, which would skip a developer's actual music.
- `e2e/launcher-system-volume.spec.ts` exercises the real native read and a
  same-level write; subsequent slider/mute gestures use test-only IPC fixtures.

## Deferred

- Seek bar on the media row.
- Native system volume on Linux.
- Windows GSMTC session enumeration (controlling a named app session, e.g.
  Spotify, with artwork) — the OS-key fallback covers control but not listing.
- macOS/Linux media-key fallbacks (`osascript`, `playerctl`).
