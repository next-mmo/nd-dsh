# ND Emulator

Unified Android device and emulator management inside ND.

## Features

- **Device Manager** — Scan, connect, and manage physical Android devices and emulators via ADB
- **Emulators & Tools Hub** — Download, configure, and one-click connect to popular Android emulators (LDPlayer, BlueStacks, MuMu Player, NoxPlayer, Google AVD, Windows Subsystem for Android) and essential tools (scrcpy, Android SDK Platform-Tools)
- **Screen Mirroring** — Stream the device inside ND (embedded, with click/drag control) or open a native scrcpy window (external, full scrcpy control), with configurable bitrate, FPS, and codec
- **ADB Shell** — Integrated terminal for running ADB commands with autocomplete
- **Quick Actions** — Install APK, capture screenshots, record screen, push/pull files, view logcat
- **Agent Tasks** — ND agent can capture screenshots and verify UI state, run test suites, or execute install-and-test workflows

## Prerequisites

- **ADB** — Android Debug Bridge (`adb`) is used to communicate with devices. It can be installed via Android SDK Platform-Tools or package manager (`winget install Google.PlatformTools` on Windows, `brew install android-platform-tools` on macOS).
- **scrcpy** (optional, for screen mirroring) — Install from [scrcpy releases](https://github.com/Genymobile/scrcpy) (`winget install Genymobile.scrcpy` or `brew install scrcpy`).
- USB debugging must be enabled on connected physical Android devices.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| ADB binary path | `adb` | Path to the ADB binary |
| scrcpy binary path | `scrcpy` | Path to the scrcpy binary |
| Default mirror bitrate | `8` Mbps | Default bitrate for screen mirroring |
| Default max FPS | `60` | Default maximum FPS for mirroring |

## Permissions

- `emulator.read` — List devices, capture screenshots, read logcat
- `emulator.write` — Connect devices, execute ADB commands, install APKs, start/stop mirroring, send taps and swipes
- `browser.openExternal` — Open official download websites and setup guides for emulators and tools in the system browser

## Architecture

The extension uses a sandboxed web view (`nd.webview/1`) with no network or Node.js access.
All device operations flow through brokered host methods in the main process, which execute
ADB and scrcpy as child processes.

Embedded mirroring launches scrcpy borderless and off-screen, captures that window in the
main process, and serves it to the view as MJPEG over the private `nd-extension-ui` scheme.
Clicks and drags in the view are mapped to normalized device coordinates and sent as ADB
`input tap` / `input swipe`. External mirroring keeps the native scrcpy window and its full
mouse, multi-touch, and keyboard behavior.
