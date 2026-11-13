# Phone Keyboard (`nd.phone-input`)

Use your Android phone as a wireless keyboard for this PC over local **Wi-Fi**,
**USB tethering**, or **wired LAN**. Type in **English or Khmer**, and dictate
with your phone keyboard's own voice input (Gboard, Samsung Keyboard, SwiftKey…).
Text is injected into the focused Windows app as real Unicode. No APK, no App
Store install, no cloud server, and nothing leaves your LAN.

## How it works

1. Install from **Settings → Extensions → Discover** (dev builds) or *Install
   from folder*, then activate it for **Personal**.
2. Open **Phone Keyboard** from the launcher (Ctrl+K) and press **Start
   Keyboard**.
3. Scan the QR code with your phone, or open the shown URL and enter the 6-digit
   pairing code.
4. On the phone page, tap the text box and type — or tap your keyboard's mic to
   dictate. Press **Send to PC** to type into the focused Windows app. Direct
   keys (Enter, Backspace, Tab, Esc, arrows, Home/End/Del) apply immediately.

Voice needs no speech recognition in ND: the phone keyboard transcribes locally
(or via its own provider) and the finished text arrives over the WebSocket. Any
language that keyboard supports works, including Khmer.

## Architecture

- **PC control panel** — a sandboxed `kind: "web"` view (`ui/index.html`) with
  ND light/dark theme parity. Privileged operations are declared view actions
  routed through the invocation broker (`phoneinput.*`).
- **Native service** — `src/main/extensions/phone-input-service.ts` runs the
  local HTTP + WebSocket server, QR/PIN pairing, LAN-only allowlist, and
  single-client policy. It reuses the proven Phone Audio transport helpers
  (`phone-audio-network.ts`, `phone-audio-qr.ts`).
- **Phone page** — `src/main/extensions/phone-input-page.ts` serves a
  self-contained keyboard page to the phone browser.
- **Injection** — the nd-core sidecar owns `input.text` (Win32 `SendInput` with
  `KEYEVENTF_UNICODE`, so Khmer U+1780–U+17FF arrives correctly) and `input.key`
  (named virtual keys). The desktop never synthesizes input itself; see
  `crates/nd-runtime/src/input.rs`.

The server is a native background job: it keeps serving while the tab is closed
and stops when the package is disabled, uninstalled, or updated. The optional
keep-alive tab only retains the control-panel UI.

## Security

- LAN-only: loopback, RFC1918, and USB-tethering ranges; public clients rejected.
- QR token + 6-digit PIN pairing, rate-limited (8 failures → 30 s lockout),
  timing-safe compares, 2-hour token TTL, one active phone at a time.
- `phoneinput.session.start` is a **sensitive** host method: agent callers need
  an explicit grant. Injection only runs for the paired, connected client.
- Text is capped at 2,000 characters per message; keys are an allowlist.

## Delivery

Fully external and on demand: the package ships **zero bytes** in the release
bundle. Dev builds install it from this folder; release users install it from
the separately published `nd-extension-catalog.json` (`pnpm ext:catalog`).

## Tests

- `tests/phone-input-extension.test.ts` — manifest, install/activate/uninstall,
  broker gating, web-view shape, and pure UI helpers.
- `tests/phone-input-server.test.ts` — headless HTTP/WS pairing, single client,
  injection acks, token rotation, shutdown.
- `crates/nd-runtime/src/input.rs` — key mapping, UTF-16 encoding, bounds.

## Provenance

First-party ND package. Transport pairing/QR/network code is shared with
`nd.phone-audio` (MIT, this repository). No vendored third-party libraries.