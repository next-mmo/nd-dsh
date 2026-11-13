/**
 * Self-contained phone-browser keyboard page (Android Chrome, iOS Safari)
 * served over local HTTP from the Electron main process. No APK, no App Store
 * install, no cloud, and no microphone/camera permission: voice dictation uses
 * the phone keyboard's own mic (Gboard etc.), so any language that keyboard
 * supports — English, Khmer — works without ND running speech recognition.
 */

export interface PhoneInputPageOptions {
  initialToken?: string
  error?: string
}

function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

export function renderPhoneInputPageHtml(options: PhoneInputPageOptions): string {
  const bootstrap = safeJsonForHtml({
    initialToken: options.initialToken ?? '',
    initialError: options.error ?? '',
  })

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
  <meta name="color-scheme" content="light dark" />
  <title>ND Phone Keyboard</title>
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
        --card-2: #f6f7f9;
        --border: rgba(30, 30, 35, 0.09);
        --text: #1d1d1f;
        --muted: #6e6e73;
        --accent: #007aff;
        --ok: #248a3d;
        --warn: #b25000;
        --bad: #d70015;
      }
    }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body { margin: 0; height: 100%; }
    body {
      background: var(--bg);
      color: var(--text);
      font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      padding: max(12px, env(safe-area-inset-top)) 12px max(12px, env(safe-area-inset-bottom));
      gap: 12px;
    }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
    h1 { font-size: 17px; margin: 0 0 4px; }
    p.sub { margin: 0; color: var(--muted); font-size: 13px; }
    .row { display: flex; gap: 8px; align-items: center; }
    .grow { flex: 1; }
    input, textarea, button {
      font: inherit; color: var(--text); background: var(--card-2);
      border: 1px solid var(--border); border-radius: 8px;
    }
    input { padding: 12px; width: 100%; letter-spacing: 0.3em; text-align: center; font-size: 20px; }
    textarea {
      width: 100%; min-height: 96px; padding: 12px; resize: vertical;
      font-size: 17px; line-height: 1.5;
    }
    button { padding: 12px 14px; cursor: pointer; font-weight: 600; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button:disabled { opacity: 0.5; cursor: default; }
    .keys { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .keys button { padding: 14px 6px; font-size: 14px; font-weight: 600; }
    .pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted);
      background: var(--card-2); border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
    .dot.ok { background: var(--ok); }
    .dot.bad { background: var(--bad); }
    .hint { font-size: 12.5px; color: var(--muted); }
    .err { color: var(--bad); font-size: 13px; min-height: 18px; }
    .hidden { display: none !important; }
    .counter { font-size: 12px; color: var(--muted); text-align: right; }
    footer { margin-top: auto; text-align: center; color: var(--muted); font-size: 11.5px; }
  </style>
</head>
<body>
  <section id="pair" class="card hidden">
    <h1>Pair with ND</h1>
    <p class="sub">Enter the 6-digit code shown in ND → Phone Keyboard.</p>
    <div style="height:12px"></div>
    <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" />
    <div style="height:10px"></div>
    <button id="pairBtn" class="primary" style="width:100%">Pair</button>
    <div style="height:8px"></div>
    <div id="pairErr" class="err"></div>
  </section>

  <section id="board" class="hidden" style="display:flex;flex-direction:column;gap:12px;flex:1">
    <div class="row">
      <h1 class="grow" style="margin:0">Phone Keyboard</h1>
      <span class="pill"><span id="dot" class="dot"></span><span id="status">Connecting…</span></span>
    </div>

    <div class="card" style="flex:1;display:flex;flex-direction:column;gap:10px">
      <textarea id="buffer" placeholder="Type here, or tap your keyboard's mic to dictate — English / ខ្មែរ" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
      <div class="row">
        <button id="send" class="primary grow">Send to PC</button>
        <button id="clear">Clear</button>
      </div>
      <div class="counter"><span id="sent">0</span> chars sent</div>
      <div id="boardErr" class="err"></div>
    </div>

    <div class="card">
      <p class="hint" style="margin:0 0 10px">Direct keys go to the PC immediately. Voice: tap the mic on your phone keyboard (Gboard) — it dictates in any language it supports.</p>
      <div class="keys">
        <button data-key="enter">Enter ⏎</button>
        <button data-key="backspace">⌫ Back</button>
        <button data-key="tab">Tab</button>
        <button data-key="escape">Esc</button>
        <button data-key="left">←</button>
        <button data-key="up">↑</button>
        <button data-key="down">↓</button>
        <button data-key="right">→</button>
        <button data-key="home">Home</button>
        <button data-key="end">End</button>
        <button data-key="delete">Del</button>
        <button id="focus">⌨ Focus</button>
      </div>
    </div>
  </section>

  <footer>ND Phone Keyboard · local network only · nothing leaves your LAN</footer>

  <script>
    const BOOT = ${bootstrap};
    const $ = (id) => document.getElementById(id);
    const pairView = $('pair'), boardView = $('board');
    const buffer = $('buffer'), statusEl = $('status'), dot = $('dot');
    const sentEl = $('sent'), boardErr = $('boardErr'), pairErr = $('pairErr');
    let token = BOOT.initialToken || '';
    let ws = null, reconnectTimer = null, attempts = 0, pingTimer = null;
    let charsSent = 0, pendingId = 0;
    const pending = new Map();

    function showBoard() { pairView.classList.add('hidden'); boardView.classList.remove('hidden'); }
    function showPair(msg) { boardView.classList.add('hidden'); pairView.classList.remove('hidden'); if (msg) pairErr.textContent = msg; }
    function setStatus(text, tone) { statusEl.textContent = text; dot.className = 'dot' + (tone ? ' ' + tone : ''); }
    function setErr(msg) { boardErr.textContent = msg || ''; }

    async function pair() {
      const code = $('code').value.trim();
      if (!/^\\d{6}$/.test(code)) { pairErr.textContent = 'Enter the 6-digit code.'; return; }
      $('pairBtn').disabled = true; pairErr.textContent = '';
      try {
        const res = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Pairing failed');
        token = data.token;
        showBoard(); connect();
      } catch (err) {
        pairErr.textContent = err.message || 'Pairing failed';
      } finally { $('pairBtn').disabled = false; }
    }

    function connect() {
      if (!token) { showPair(); return; }
      showBoard();
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(proto + '://' + location.host + '/ws?token=' + encodeURIComponent(token));
      ws.onopen = () => {
        attempts = 0; setStatus('Connected', 'ok'); setErr('');
        send({ type: 'client-hello', userAgent: navigator.userAgent });
        buffer.focus();
        pingTimer = setInterval(() => send({ type: 'ping', t: performance.now() }), 5000);
      };
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'pong' && typeof msg.t === 'number') {
          setStatus('Connected · ' + Math.max(0, Math.round(performance.now() - msg.t)) + ' ms', 'ok');
        } else if (msg.type === 'ack') {
          const settle = pending.get(msg.id);
          if (settle) { pending.delete(msg.id); settle(msg); }
        } else if (msg.type === 'server-stop') {
          setStatus('Stopped', 'bad'); setErr(msg.reason || 'Stopped on the PC.');
          token = ''; cleanup(); showPair(msg.reason || 'Start Phone Keyboard again on the PC.');
        }
      };
      ws.onclose = (ev) => {
        cleanup();
        if (ev.code === 4003 || ev.code === 4001) { setStatus('Disconnected', 'bad'); return; }
        setStatus('Reconnecting…', 'bad');
        attempts += 1;
        const delay = Math.min(8000, 500 * Math.pow(2, Math.min(attempts, 4)));
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
    }

    function cleanup() {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    }

    function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

    function request(obj) {
      return new Promise((resolve) => {
        const id = ++pendingId;
        const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: false, error: 'Timed out' }); } }, 8000);
        pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
        send(Object.assign({ id }, obj));
      });
    }

    async function sendBuffer() {
      const text = buffer.value;
      if (!text) { buffer.focus(); return; }
      $('send').disabled = true; setErr('');
      const res = await request({ type: 'text', text });
      $('send').disabled = false;
      if (res.ok) { charsSent += text.length; sentEl.textContent = String(charsSent); buffer.value = ''; buffer.focus(); }
      else setErr(res.error || 'Could not type on the PC.');
    }

    async function sendKey(key) {
      setErr('');
      const res = await request({ type: 'key', key });
      if (!res.ok) setErr(res.error || 'Key failed.');
    }

    $('pairBtn').addEventListener('click', pair);
    $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') pair(); });
    $('send').addEventListener('click', sendBuffer);
    $('clear').addEventListener('click', () => { buffer.value = ''; buffer.focus(); });
    $('focus').addEventListener('click', () => buffer.focus());
    document.querySelectorAll('[data-key]').forEach((btn) => {
      btn.addEventListener('click', () => sendKey(btn.getAttribute('data-key')));
    });
    buffer.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendBuffer(); }
    });

    if (BOOT.initialError) { showPair(BOOT.initialError); }
    else if (token) { showBoard(); connect(); }
    else { showPair(); }
  </script>
</body>
</html>`
}