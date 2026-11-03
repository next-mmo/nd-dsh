# OS Toolkit

`nd.os-toolkit` — schedule the Windows light and dark theme.

Windows 11 has no user-facing way to set your own day/night theme times, so this
package owns the schedule and applies it for you. It is delivered as a fully
external, on-demand package: it ships **zero bytes** in the ND release bundle and
is installed only when you ask for it.

## What it does

- **Day/night schedule.** Pick the time light mode starts and the time dark mode
  starts. Ranges that cross midnight work (`22:00` → `06:00`).
- **Manual actions.** `Light theme now`, `Dark theme now` and `Toggle the Windows
  theme` are launcher commands, so they are one Ctrl+K away with no panel open.
- **Two apply backends.**
  - *Native* — the nd-core sidecar writes `AppsUseLightTheme` and
    `SystemUsesLightTheme` under
    `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize` and
    broadcasts `WM_SETTINGCHANGE` with `ImmersiveColorSet` so Explorer repaints
    immediately. No third-party software required.
  - *PowerToys* — delegates to `PowerToys.LightSwitch.CLI.exe` when Light Switch
    is installed and enabled, so its own *Apply dark mode to* targets and Power
    Display monitor profiles are honored.
  - *Auto* (the default) picks PowerToys when it is usable and Native otherwise.
- **Repair on start and wake.** ND applies the correct theme when it launches and
  when the computer wakes, so a switch missed while ND was closed self-heals.

## Install

Development builds: **Settings → Extensions → Discover → OS Toolkit → Install**,
then activate it for **Personal**. Restart `pnpm dev` after any change to
`src/main/extensions/nd-ipc.ts` — the Electron main process does not hot-reload
IPC handlers.

Release builds: the package is published through the separate extension catalog
(`pnpm ext:catalog`) at an immutable Git revision, with per-file hashes and sizes.
It is never staged through `electron-builder.yml`.

## Why not just wrap PowerToys Light Switch

Light Switch already has a scheduler, but its CLI cannot drive one. Microsoft
documents that `schedule enable --mode` "uses the times, location, and offsets
already saved in Light Switch settings" — the times are only editable in the
PowerToys Settings UI. The CLI also exits `3` unless PowerToys is installed *and*
Light Switch is turned on, so it cannot serve a stock machine at all.

That is why ND owns the times and treats Light Switch as one optional apply
backend rather than the mechanism.

## Permissions

| Permission | Grants |
| --- | --- |
| `ostoolkit.read` | Read the current theme, probe the backends, read the schedule. |
| `ostoolkit.write` | Save the schedule, and change the Windows theme. |

`ostoolkit.theme.apply` is marked **sensitive**, so an agent caller always needs
an explicit grant before your desktop changes. The three read methods are not
sensitive, so an agent can report the current theme without a prompt.

## Limitations, stated plainly

- **The schedule only runs while ND is open.** It is an Electron main-process
  timer. A machine that is asleep at 19:00 and wakes at 21:00 with ND closed gets
  nothing until ND next starts. There is no Windows Scheduled Task and nothing is
  written outside ND's own `userData`. Startup and wake reconciliation bound the
  gap; they do not eliminate it.
- **`AppsUseLightTheme` only affects apps that honor it.** Legacy Win32 apps, some
  Electron apps and many games stay light regardless. Per-app theming is not
  something Windows exposes.
- **PowerToys manual override.** Applying a theme while Light Switch has its own
  schedule running creates a `manualOverride` in PowerToys that persists until its
  next scheduled change. The `lightSwitchSync` setting turns their schedule off to
  prevent this. If you re-enable it in PowerToys, both schedulers write the same
  key and the last writer wins — the studio shows Light Switch's schedule mode and
  override flag so this is never invisible.
- **Exit code 4 from Light Switch is ambiguous.** Microsoft documents that the
  change may still have been applied, and that the CLI never retries. ND reads
  `status` once before reporting rather than guessing, and never auto-retries a
  theme change.
- **HKCU only, no elevation.** A domain policy that locks `Personalize` surfaces as
  "Your organization manages the Windows theme", not as a raw error code.
- **Sunrise/sunset is not implemented.** There is no network-free source of
  location: `Windows.Devices.Geolocation` needs consent plus new native features,
  and a bundled ephemeris is a heavy dependency for one field. If it lands, the
  acceptable shape is a small solar-position function in `ui/schedule-core.js`
  plus explicit `latitude`/`longitude` settings — no network call.

## Layout

```
nd-extension.json      manifest: 4 commands, 1 web view, 8 settings
ui/index.html          studio markup and palette
ui/bridge.js           nd.webview/1 client
ui/schedule-core.js    pure schedule arithmetic (DOM-free, plain JS)
ui/schedule-core.d.ts  types for the above, so the repo can typecheck it
ui/studio.js           DOM and the 24-hour ring
```

`ui/schedule-core.js` is a deliberate duplicate of
`src/shared/os-toolkit-schedule.ts`. The frame is served only from the installed
package snapshot and cannot import from the app tree.
`tests/os-toolkit-schedule.test.ts` runs one shared case table against both files
and fails if they drift — that test is the only thing keeping them honest, so
change both together.

## Provenance

PowerToys Light Switch is Microsoft software, documented at
<https://learn.microsoft.com/en-us/windows/powertoys/light-switch>. ND does not
bundle, redistribute or modify it. This package only invokes
`PowerToys.LightSwitch.CLI.exe` if it is already installed, through `execFile`
with literal argument arrays — never a shell, never a caller-supplied path.
