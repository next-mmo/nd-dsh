/**
 * Unified Phone Link landing page served at `/` after scanning the single QR
 * code. One pairing token drives both tabs; the keyboard and audio pages load
 * as same-origin iframes and stay alive when switching tabs so audio keeps
 * playing while the user types.
 */

export interface PhoneLinkPageOptions {
  initialToken?: string
  error?: string
}

function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

export function renderPhoneLinkShellHtml(options: PhoneLinkPageOptions): string {
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
  <title>ND Phone Link</title>
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
      height: 100dvh;
      padding-top: env(safe-area-inset-top);
    }
    header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 10px 14px 6px;
    }
    header h1 { margin: 0; font-size: 16px; font-weight: 650; }
    header span { font-size: 12px; color: var(--muted); }
    nav {
      display: flex;
      gap: 8px;
      padding: 4px 14px 10px;
    }
    nav button {
      flex: 1;
      font: inherit;
      font-weight: 600;
      padding: 11px 10px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--muted);
      cursor: pointer;
    }
    nav button.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    #frames { position: relative; flex: 1; min-height: 0; }
    #frames iframe {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border: 0;
      display: none;
      background: var(--bg);
    }
    #frames iframe.active { display: block; }
    #pair {
      margin: 12px 14px;
      padding: 16px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    #pair p { margin: 0; font-size: 13px; color: var(--muted); }
    #code {
      font: inherit;
      color: var(--text);
      background: var(--card-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      width: 100%;
      letter-spacing: 0.3em;
      text-align: center;
      font-size: 20px;
    }
    #pairBtn {
      font: inherit;
      font-weight: 600;
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid var(--accent);
      background: var(--accent);
      color: #fff;
      cursor: pointer;
    }
    #pairBtn:disabled { opacity: 0.5; }
    #pairErr { color: var(--bad); font-size: 13px; min-height: 18px; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <header>
    <h1>ND Phone Link</h1>
    <span>Keyboard + Audio · local network only</span>
  </header>

  <section id="pair" hidden>
    <p>Enter the 6-digit pairing code shown in ND → Phone Link on your PC. One code pairs both the keyboard and the audio speaker.</p>
    <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" />
    <button id="pairBtn" type="button">Pair</button>
    <div id="pairErr"></div>
  </section>

  <nav id="tabs" hidden>
    <button id="tab-keyboard" class="active" type="button">Keyboard</button>
    <button id="tab-audio" type="button">Audio</button>
  </nav>

  <div id="frames" hidden>
    <iframe id="frame-keyboard" title="Phone Keyboard" allow="autoplay"></iframe>
    <iframe id="frame-audio" title="Phone Audio" allow="autoplay"></iframe>
  </div>

  <script>
    const BOOT = ${bootstrap};
    const STORAGE_KEY = 'nd-phone-link.token';
    const $ = (id) => document.getElementById(id);
    const pairView = $('pair'), tabsView = $('tabs'), framesView = $('frames');
    const keyboardFrame = $('frame-keyboard'), audioFrame = $('frame-audio');
    const tabKeyboard = $('tab-keyboard'), tabAudio = $('tab-audio');
    let token = BOOT.initialToken || '';
    let activeTab = 'keyboard';
    let audioLoaded = false;

    function readStoredToken() {
      try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
    }
    function storeToken(value) {
      try {
        if (value) localStorage.setItem(STORAGE_KEY, value);
        else localStorage.removeItem(STORAGE_KEY);
      } catch {}
    }
    function frameUrl(app) {
      return '/' + app + '?token=' + encodeURIComponent(token);
    }

    function showApp() {
      pairView.hidden = true;
      tabsView.hidden = false;
      framesView.hidden = false;
      keyboardFrame.src = frameUrl('keyboard');
      if (audioLoaded) audioFrame.src = frameUrl('audio');
      selectTab(activeTab);
    }

    function showPair(message) {
      tabsView.hidden = true;
      framesView.hidden = true;
      keyboardFrame.removeAttribute('src');
      audioFrame.removeAttribute('src');
      audioLoaded = false;
      pairView.hidden = false;
      if (message) $('pairErr').textContent = message;
    }

    function selectTab(tab) {
      activeTab = tab;
      if (tab === 'audio' && !audioLoaded) {
        audioLoaded = true;
        audioFrame.src = frameUrl('audio');
      }
      tabKeyboard.classList.toggle('active', tab === 'keyboard');
      tabAudio.classList.toggle('active', tab === 'audio');
      keyboardFrame.classList.toggle('active', tab === 'keyboard');
      audioFrame.classList.toggle('active', tab === 'audio');
    }

    async function pair() {
      const code = $('code').value.trim();
      if (!/^\\d{6}$/.test(code)) { $('pairErr').textContent = 'Enter the 6-digit code.'; return; }
      $('pairBtn').disabled = true;
      $('pairErr').textContent = '';
      try {
        const res = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
        const data = await res.json();
        if (!res.ok || !data.token) throw new Error(data.error || 'Pairing failed');
        token = data.token;
        storeToken(token);
        showApp();
      } catch (err) {
        $('pairErr').textContent = err.message || 'Pairing failed';
      } finally {
        $('pairBtn').disabled = false;
      }
    }

    // A tab page can re-pair on its own (e.g. after "New Code" on the PC);
    // adopt the fresh token so the sibling tab follows without a second scan.
    window.addEventListener('message', (event) => {
      if (event.origin !== location.origin) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.kind === 'nd-phone-link:paired' && typeof data.token === 'string' && data.token) {
        token = data.token;
        storeToken(token);
        if (pairView.hidden) {
          keyboardFrame.src = frameUrl('keyboard');
          if (audioLoaded) audioFrame.src = frameUrl('audio');
        } else {
          showApp();
        }
        return;
      }
      if (data.kind === 'nd-phone-link:unpaired') {
        token = '';
        storeToken('');
        showPair(data.reason || 'The PC stopped Phone Link. Start it again, then re-pair.');
      }
    });

    $('pairBtn').addEventListener('click', pair);
    $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') pair(); });
    tabKeyboard.addEventListener('click', () => selectTab('keyboard'));
    tabAudio.addEventListener('click', () => selectTab('audio'));

    if (!token) token = readStoredToken();
    if (BOOT.initialError) { showPair(BOOT.initialError); }
    else if (token) { storeToken(token); showApp(); }
    else { showPair(); }
  </script>
</body>
</html>`
}