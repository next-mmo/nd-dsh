# Phone Audio (`nd.phone-audio`)

Stream Windows 11 system playback audio (YouTube, games, browsers, music, Electron) to an Android phone browser over local Wi-Fi or USB tethering with low-latency WebRTC Opus audio. No separate Android APK, Bluetooth adapter, or external cloud server is required.

## Architecture

- **Capture (Windows)**: Electron `session.setDisplayMediaRequestHandler()` with Windows system audio loopback (`audio: 'loopback'` or `'loopbackWithMute'`) paired with `navigator.mediaDevices.getDisplayMedia()`, immediately stopping any video track so zero video frames are sent. Includes an optional virtual audio device fallback (e.g. VB-CABLE).
- **Signaling & Receiver Server (Main Process)**: Local-only HTTP + WebSocket (`ws`) server bound per active non-virtual local IPv4 interface (`Wi-Fi`, `USB Tethering`, `Ethernet`, and `127.0.0.1`), protected by a short-lived pairing token + 6-digit PIN and local-subnet validation.
- **Media Transport (WebRTC)**: Direct peer-to-peer local WebRTC audio track preferring stereo Opus (`ptime=10`), measured RTT/jitter stats, and automatic reconnection on transient Wi-Fi drops.
- **Mobile Receiver**: Responsive page served from Electron main process at `http://<local-ip>:<port>/?token=<token>`, respecting Android Chrome autoplay policies via explicit tap-to-play.
