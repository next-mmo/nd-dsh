/**
 * Self-contained responsive phone-browser receiver page (Android Chrome, iOS
 * Safari) served over local HTTP from the Electron main process. Requires no
 * APK, no App Store install, no cloud services, and no microphone/camera
 * permissions. Respects mobile autoplay policies by starting playback directly
 * inside the user's Connect/Play gesture, and re-negotiates when iOS suspends
 * the page on lock/background.
 */

export interface ReceiverPageOptions {
  initialToken?: string
  error?: string
}

function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

export function renderPhoneAudioReceiverHtml(options: ReceiverPageOptions): string {
  const bootstrap = safeJsonForHtml({
    initialToken: options.initialToken ?? '',
    initialError: options.error ?? '',
  })

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="color-scheme" content="light dark" />
  <title>ND Phone Audio Receiver</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0c0f;
      --card: #161922;
      --card-2: #1d212d;
      --border: rgba(255, 255, 255, 0.1);
      --text: #edf0f7;
      --muted: #98a2b3;
      --accent: #0a84ff;
      --ok: #30d158;
      --warn: #ff9f0a;
      --bad: #ff453a;
    }
    @media (prefers-color-scheme: light) {
      :root {
        color-scheme: light;
        --bg: #eef0f4;
        --card: #ffffff;
        --card-2: #f4f6fa;
        --border: rgba(20, 24, 33, 0.12);
        --text: #15171c;
        --muted: #5c6472;
        --accent: #007aff;
        --ok: #15803d;
        --warn: #b45309;
        --bad: #dc2626;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      justify-content: center;
      padding: 18px 14px 28px;
    }
    main {
      width: 100%;
      max-width: 440px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 650;
      letter-spacing: -0.02em;
    }
    .sub {
      margin: 2px 0 0;
      font-size: 12.5px;
      color: var(--muted);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid var(--border);
      background: var(--card-2);
      color: var(--muted);
      white-space: nowrap;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
    }
    .pill.ok { color: var(--ok); }
    .pill.warn { color: var(--warn); }
    .pill.bad { color: var(--bad); }
    .pill.accent { color: var(--accent); }
    .btn {
      appearance: none;
      border: 1px solid var(--border);
      background: var(--card-2);
      color: var(--text);
      font: inherit;
      font-size: 15px;
      font-weight: 600;
      border-radius: 11px;
      padding: 13px 16px;
      cursor: pointer;
      width: 100%;
      transition: opacity 0.15s ease, transform 0.08s ease;
    }
    .btn:active { transform: scale(0.99); }
    .btn:disabled { opacity: 0.45; cursor: default; }
    .btn.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    .btn.danger {
      color: var(--bad);
    }
    .row {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .meter-wrap {
      height: 10px;
      border-radius: 999px;
      background: var(--card-2);
      border: 1px solid var(--border);
      overflow: hidden;
    }
    .meter-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, var(--accent), var(--ok));
      transition: width 90ms linear;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .stat {
      background: var(--card-2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 9px 10px;
    }
    .stat-label {
      font-size: 11px;
      color: var(--muted);
    }
    .stat-val {
      margin-top: 3px;
      font-size: 14px;
      font-weight: 650;
      font-variant-numeric: tabular-nums;
    }
    .pin-input {
      width: 100%;
      background: var(--card-2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 14px;
      color: var(--text);
      font-size: 22px;
      font-weight: 650;
      letter-spacing: 0.25em;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }
    label.slider-label {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      font-weight: 500;
      color: var(--muted);
    }
    input[type="range"] {
      width: 100%;
      accent-color: var(--accent);
      height: 28px;
    }
    .msg {
      font-size: 13px;
      line-height: 1.45;
      color: var(--muted);
    }
    .msg.bad { color: var(--bad); }
    .msg.warn { color: var(--warn); }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <div class="top">
        <div>
          <h1>Phone Audio</h1>
          <p class="sub">Local PC-to-phone WebRTC audio speaker</p>
        </div>
        <span id="status-pill" class="pill"><span class="dot"></span><span id="status-text">Ready</span></span>
      </div>
      <div id="error-box" class="msg bad" hidden></div>
    </section>

    <section id="pair-card" class="card" hidden>
      <div class="msg">This page turns your phone into a wireless speaker for your PC. Enter the 6-digit pairing code shown on your Windows PC in ND.</div>
      <form id="pair-form" class="row" style="flex-direction:column;align-items:stretch;">
        <input id="pin-input" class="pin-input" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="000000" autocomplete="one-time-code" required />
        <button id="pair-btn" class="btn primary" type="submit">Pair Device</button>
      </form>
    </section>

    <section id="player-card" class="card" hidden>
      <button id="connect-btn" class="btn primary" type="button">Connect &amp; Play Audio</button>
      <button id="resume-btn" class="btn primary" type="button" hidden>Tap to Resume Audio Playback</button>

      <div class="row">
        <button id="play-pause-btn" class="btn" type="button" disabled>Pause</button>
        <button id="disconnect-btn" class="btn danger" type="button" disabled>Disconnect</button>
      </div>

      <div>
        <label class="slider-label" for="volume-slider">
          <span>Phone Volume</span>
          <strong id="volume-value">100%</strong>
        </label>
        <input id="volume-slider" type="range" min="0" max="100" value="100" />
      </div>

      <div>
        <div class="slider-label" style="margin-bottom:6px;">
          <span>Audio Activity</span>
          <span id="activity-label">Idle</span>
        </div>
        <div class="meter-wrap"><div id="meter-fill" class="meter-fill"></div></div>
      </div>

      <div class="stats">
        <div class="stat">
          <div class="stat-label">Latency (RTT)</div>
          <div id="stat-rtt" class="stat-val">—</div>
        </div>
        <div class="stat">
          <div class="stat-label">Jitter</div>
          <div id="stat-jitter" class="stat-val">—</div>
        </div>
        <div class="stat">
          <div class="stat-label">Codec</div>
          <div id="stat-codec" class="stat-val">Opus</div>
        </div>
      </div>

      <div class="msg">
        Plays through phone speaker, wired headset, or Bluetooth earphones connected to your phone. No microphone permission is used.
      </div>
      <div class="msg">
        Keep this page open while listening. Locking the phone or switching apps pauses playback; it resumes when you return, or tap the button above.
      </div>
      <div id="ios-hint" class="msg" hidden>
        iPhone / iPad: tap Connect &amp; Play once. iOS pauses web audio while the screen is locked or Safari is in the background; this page reconnects and resumes when you return. Share → Add to Home Screen gives an app-like icon.
      </div>
    </section>

    <audio id="remote-audio" playsinline autoplay></audio>
  </main>

  <script>
    (() => {
      const BOOT = ${bootstrap};
      const el = (id) => document.getElementById(id);
      const statusPill = el('status-pill');
      const statusText = el('status-text');
      const errorBox = el('error-box');
      const pairCard = el('pair-card');
      const pairForm = el('pair-form');
      const pinInput = el('pin-input');
      const playerCard = el('player-card');
      const connectBtn = el('connect-btn');
      const resumeBtn = el('resume-btn');
      const playPauseBtn = el('play-pause-btn');
      const disconnectBtn = el('disconnect-btn');
      const volumeSlider = el('volume-slider');
      const volumeValue = el('volume-value');
      const meterFill = el('meter-fill');
      const activityLabel = el('activity-label');
      const statRtt = el('stat-rtt');
      const statJitter = el('stat-jitter');
      const statCodec = el('stat-codec');
      const audioEl = el('remote-audio');
      const iosHint = el('ios-hint');
      const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (IS_IOS) iosHint.hidden = false;

      let token = BOOT.initialToken || '';
      let ws = null;
      let pc = null;
      let intentionalClose = false;
      let reconnectTimer = null;
      let reconnectAttempts = 0;
      let pingTimer = null;
      let statsTimer = null;
      let paused = false;
      let volume = 1;
      let hasConnected = false;
      let lastBytesReceived = 0;
      let lastLatencyMs = null;
      let lastJitterMs = null;
      let lastAudioLevel = 0;

      function setStatus(label, tone) {
        statusText.textContent = label;
        statusPill.className = 'pill' + (tone ? ' ' + tone : '');
      }

      function showError(msg) {
        if (!msg) {
          errorBox.hidden = true;
          errorBox.textContent = '';
          return;
        }
        errorBox.hidden = false;
        errorBox.textContent = msg;
      }

      function updateControls() {
        const hasSocket = ws && ws.readyState === WebSocket.OPEN;
        connectBtn.hidden = Boolean(hasSocket);
        playPauseBtn.disabled = !hasSocket;
        disconnectBtn.disabled = !hasSocket && !reconnectTimer;
        playPauseBtn.textContent = paused ? 'Resume' : 'Pause';
      }

      function cleanupPeer() {
        if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
        if (pc) {
          try { pc.onicecandidate = null; pc.ontrack = null; pc.oniceconnectionstatechange = null; pc.close(); } catch {}
          pc = null;
        }
        audioEl.srcObject = null;
        lastBytesReceived = 0;
        meterFill.style.width = '0%';
        activityLabel.textContent = 'Idle';
      }

      function cleanupSocket() {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        if (ws) {
          try { ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null; ws.close(1000, 'Client disconnect'); } catch {}
          ws = null;
        }
      }

      function sendWs(payload) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(payload));
        }
      }

      function applyAudioState() {
        audioEl.volume = volume;
        audioEl.muted = paused;
        if (!paused && audioEl.srcObject) {
          audioEl.play().then(() => {
            resumeBtn.hidden = true;
          }).catch(() => {
            resumeBtn.hidden = false;
          });
        }
        syncMediaSession();
        updateControls();
      }

      // Lock-screen / now-playing controls on iOS and Android. iOS still
      // suspends WebRTC while locked; the handlers let the user resume from
      // the lock screen once the page is awake again.
      function syncMediaSession() {
        if (!('mediaSession' in navigator)) return;
        try {
          if (typeof MediaMetadata === 'function' && !navigator.mediaSession.metadata) {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: 'Phone Audio',
              artist: 'ND-DSH · PC system audio',
              album: 'Local Wi-Fi / USB stream',
            });
          }
          navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
        } catch {}
      }

      function clearMediaSession() {
        if (!('mediaSession' in navigator)) return;
        try { navigator.mediaSession.playbackState = 'none'; } catch {}
      }

      async function setupPeerAndHandleOffer(sdp) {
        cleanupPeer();
        pc = new RTCPeerConnection({ iceServers: [] });

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            sendWs({
              type: 'ice-candidate',
              candidate: {
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
              },
            });
          }
        };

        pc.ontrack = (event) => {
          const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
          audioEl.srcObject = stream;
          applyAudioState();
          setStatus(paused ? 'Paused' : 'Playing', paused ? 'warn' : 'ok');
        };

        pc.oniceconnectionstatechange = () => {
          if (!pc) return;
          const st = pc.iceConnectionState;
          if (st === 'connected' || st === 'completed') {
            reconnectAttempts = 0;
            setStatus(paused ? 'Paused' : 'Playing', paused ? 'warn' : 'ok');
          } else if (st === 'disconnected') {
            setStatus('Reconnecting', 'warn');
          } else if (st === 'failed') {
            setStatus('Connection lost', 'bad');
            if (!intentionalClose) scheduleReconnect();
          }
        };

        await pc.setRemoteDescription({ type: 'offer', sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendWs({ type: 'sdp-answer', sdp: answer.sdp });

        statsTimer = setInterval(async () => {
          if (!pc) return;
          try {
            const report = await pc.getStats();
            let level = 0;
            let jitter = null;
            let bytes = lastBytesReceived;
            let codecLabel = 'Opus';
            report.forEach((entry) => {
              if (entry.type === 'inbound-rtp' && entry.kind === 'audio') {
                if (typeof entry.audioLevel === 'number') level = entry.audioLevel;
                if (typeof entry.jitter === 'number') jitter = Math.round(entry.jitter * 10000) / 10;
                if (typeof entry.bytesReceived === 'number') bytes = entry.bytesReceived;
              }
              if (entry.type === 'codec' && typeof entry.mimeType === 'string' && entry.mimeType.startsWith('audio/')) {
                codecLabel = entry.mimeType.replace('audio/', '').toUpperCase();
                if (entry.channels === 2) codecLabel += ' Stereo';
              }
            });
            const deltaBytes = bytes - lastBytesReceived;
            lastBytesReceived = bytes;
            if (level === 0 && deltaBytes > 0 && !paused) level = 0.18;
            lastAudioLevel = level;
            lastJitterMs = jitter;
            const pct = paused ? 0 : Math.min(100, Math.round(Math.pow(level, 0.55) * 100));
            meterFill.style.width = pct + '%';
            activityLabel.textContent = paused ? 'Paused' : (deltaBytes > 0 || level > 0.01 ? 'Receiving audio' : 'Silent');
            statJitter.textContent = jitter !== null ? jitter + ' ms' : '—';
            statCodec.textContent = codecLabel;
            sendWs({
              type: 'client-telemetry',
              paused,
              volume,
              audioLevel: level,
              latencyMs: lastLatencyMs,
              jitterMs: lastJitterMs,
            });
          } catch {}
        }, 500);
      }

      function scheduleReconnect() {
        if (intentionalClose || reconnectTimer || !token) return;
        const delay = Math.min(8000, 1000 * Math.pow(2, reconnectAttempts));
        reconnectAttempts += 1;
        setStatus('Reconnecting…', 'warn');
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectWebSocket();
        }, delay);
        updateControls();
      }

      function connectWebSocket() {
        if (!token) return;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        cleanupPeer();
        cleanupSocket();
        showError('');
        setStatus('Connecting…', 'accent');

        const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = wsProto + '//' + location.host + '/ws?token=' + encodeURIComponent(token);
        ws = new WebSocket(url);

        ws.onopen = () => {
          reconnectAttempts = 0;
          hasConnected = true;
          setStatus('Negotiating…', 'accent');
          sendWs({ type: 'client-hello', userAgent: navigator.userAgent });
          pingTimer = setInterval(() => {
            sendWs({ type: 'ping', t: performance.now() });
          }, 2000);
          updateControls();
        };

        ws.onmessage = async (event) => {
          let msg;
          try { msg = JSON.parse(event.data); } catch { return; }
          if (msg.type === 'sdp-offer' && typeof msg.sdp === 'string') {
            try {
              await setupPeerAndHandleOffer(msg.sdp);
            } catch (err) {
              showError('WebRTC setup failed: ' + (err && err.message ? err.message : String(err)));
              setStatus('Error', 'bad');
            }
            return;
          }
          if (msg.type === 'ice-candidate' && msg.candidate && pc) {
            try { await pc.addIceCandidate(msg.candidate); } catch {}
            return;
          }
          if (msg.type === 'pong' && typeof msg.t === 'number') {
            lastLatencyMs = Math.max(0, Math.round(performance.now() - msg.t));
            statRtt.textContent = lastLatencyMs + ' ms';
            return;
          }
          if (msg.type === 'server-stop') {
            intentionalClose = true;
            showError(msg.reason || 'Streaming stopped by desktop.');
            cleanupPeer();
            cleanupSocket();
            clearMediaSession();
            setStatus('Stopped', '');
            updateControls();
          }
        };

        ws.onerror = () => {
          setStatus('Connection error', 'bad');
        };

        ws.onclose = (ev) => {
          cleanupPeer();
          if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
          ws = null;
          if (ev.code === 4001) {
            intentionalClose = true;
            token = '';
            pairCard.hidden = false;
            playerCard.hidden = true;
            showError('Pairing token expired or invalid. Enter the current 6-digit code or rescan QR.');
            setStatus('Unauthorized', 'bad');
            updateControls();
            return;
          }
          if (ev.code === 4008) {
            intentionalClose = true;
            showError('Another phone is already connected. Disconnect it in ND first.');
            setStatus('Busy', 'warn');
            updateControls();
            return;
          }
          if (ev.code === 4003) {
            intentionalClose = true;
            showError('Disconnected by desktop.');
            setStatus('Disconnected', '');
            updateControls();
            return;
          }
          if (!intentionalClose) {
            scheduleReconnect();
          } else {
            setStatus('Disconnected', '');
            updateControls();
          }
        };
      }

      connectBtn.addEventListener('click', () => {
        intentionalClose = false;
        paused = false;
        // Unlock audio playback directly inside the user's tap gesture for
        // Android Chrome and iOS Safari autoplay policies.
        try {
          audioEl.muted = false;
          audioEl.volume = volume;
          const p = audioEl.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {}
        connectWebSocket();
      });

      resumeBtn.addEventListener('click', () => {
        paused = false;
        applyAudioState();
      });

      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.setActionHandler('play', () => {
            paused = false;
            applyAudioState();
            setStatus('Playing', 'ok');
          });
          navigator.mediaSession.setActionHandler('pause', () => {
            paused = true;
            applyAudioState();
            setStatus('Paused', 'warn');
          });
          navigator.mediaSession.setActionHandler('stop', () => {
            disconnectBtn.click();
          });
        } catch {}
      }

      // iOS suspends the page on lock/background and kills the peer connection.
      // On return, re-negotiate immediately instead of waiting out the backoff,
      // and re-attempt playback (a tap may still be required by autoplay rules).
      function handleReturnToForeground() {
        if (document.visibilityState === 'hidden') return;
        // Never auto-connect on first load: playback must start inside the
        // user's Connect tap to satisfy mobile autoplay policies.
        if (!hasConnected || intentionalClose || !token) return;
        const socketDead = !ws || ws.readyState !== WebSocket.OPEN;
        const ice = pc ? pc.iceConnectionState : 'closed';
        const peerDead = !pc || ice === 'failed' || ice === 'closed' || ice === 'disconnected';
        if (socketDead || peerDead) {
          reconnectAttempts = 0;
          connectWebSocket();
          return;
        }
        if (!paused) applyAudioState();
      }
      document.addEventListener('visibilitychange', handleReturnToForeground);
      window.addEventListener('pageshow', handleReturnToForeground);
      window.addEventListener('focus', handleReturnToForeground);

      playPauseBtn.addEventListener('click', () => {
        paused = !paused;
        applyAudioState();
        setStatus(paused ? 'Paused' : 'Playing', paused ? 'warn' : 'ok');
        sendWs({ type: 'client-telemetry', paused, volume, audioLevel: lastAudioLevel, latencyMs: lastLatencyMs, jitterMs: lastJitterMs });
      });

      disconnectBtn.addEventListener('click', () => {
        intentionalClose = true;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        sendWs({ type: 'client-disconnect' });
        cleanupPeer();
        cleanupSocket();
        clearMediaSession();
        setStatus('Disconnected', '');
        updateControls();
      });

      volumeSlider.addEventListener('input', () => {
        volume = Math.max(0, Math.min(1, Number(volumeSlider.value) / 100));
        volumeValue.textContent = Math.round(volume * 100) + '%';
        audioEl.volume = volume;
        sendWs({ type: 'client-telemetry', paused, volume, audioLevel: lastAudioLevel, latencyMs: lastLatencyMs, jitterMs: lastJitterMs });
      });

      pairForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        showError('');
        const code = (pinInput.value || '').trim();
        try {
          const res = await fetch('/api/pair', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code }),
          });
          const data = await res.json();
          if (!res.ok || !data.token) {
            showError(data.error || 'Invalid pairing code.');
            return;
          }
          token = data.token;
          pairCard.hidden = true;
          playerCard.hidden = false;
          setStatus('Paired — Tap Connect', 'accent');
          updateControls();
        } catch {
          showError('Could not reach the desktop server. Check Wi-Fi or USB tethering.');
        }
      });

      if (BOOT.initialError) showError(BOOT.initialError);
      if (token) {
        pairCard.hidden = true;
        playerCard.hidden = false;
        setStatus('Ready — Tap Connect', 'accent');
      } else {
        pairCard.hidden = false;
        playerCard.hidden = true;
        setStatus('Pairing required', '');
      }
      updateControls();
    })();
  </script>
</body>
</html>`
}
