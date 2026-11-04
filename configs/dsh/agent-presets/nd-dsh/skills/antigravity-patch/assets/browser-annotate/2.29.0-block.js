
// AGY_TEMP_ANNOTATOR_V1
// Temporary local patch for Antigravity 2.29.0. No network requests or auto-send.
function installAntigravityAnnotator() {
  'use strict';
  if (window.__agyTempAnnotatorInstalled) return;
  window.__agyTempAnnotatorInstalled = true;
  const WORLD = 96137;
  let session = null;
  const visible = el => el.isConnected && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  const guestRun = (view, code) => window.electronNative.executeJavaScriptInIsolatedWorld(view.getWebContentsId(), WORLD, code);
  // 2.29 uses owned WebContentsViews. Observe the existing guest snapshots;
  // no new IPC or Node capability is exposed.
  const wcv = window.electronNative.wcvBrowser;
  const guests = new Map();
  wcv?.onGuestEvent(snap => {
    if (snap.tabKey && Number.isInteger(snap.webContentsId)) guests.set(snap.tabKey, snap);
    if (session?.view.tabKey === snap.tabKey && (snap.crashed || snap.url !== session.view.getURL())) close();
  });
  function activeGuest() {
    const active = new URL(location.href).searchParams.get('tab');
    const matches = [...guests.values()].filter(s => active && (s.tabKey === active || s.tabKey.endsWith(':' + active) || s.tabKey.endsWith('/' + active)));
    const selected = matches.length === 1 ? matches[0] : null;
    if (!selected) throw new Error('Browser identity is not ready. Reload the page, then try again.');
    const key = selected.tabKey;
    return {tabKey:key, getWebContentsId:()=>guests.get(key)?.webContentsId,
      getURL:()=>guests.get(key)?.url, get isConnected(){return new URL(location.href).searchParams.get('tab') === active;},
      getBoundingClientRect:()=>({width:1,height:1})};
  }


  function pickInGuest() {
    globalThis.__agyTempAnnotator?.cancel();
    return new Promise(resolve => {
      const root = document.createElement('div');
      root.setAttribute('data-agy-temp-annotator', '');
      root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:transparent;touch-action:none';
      const outline = document.createElement('div');
      outline.style.cssText = 'position:fixed;pointer-events:none;box-sizing:border-box;border:2px solid #4285f4;background:#4285f41a;border-radius:3px';
      const label = document.createElement('div');
      label.style.cssText = 'position:fixed;pointer-events:none;max-width:90vw;padding:5px 9px;color:white;background:#1a73e8;border-radius:4px;font:12px/1.4 system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      root.append(outline, label);
      document.documentElement.append(root);
      let start = null, target = null, done = false;
      const selector = el => {
        if (!el) return '';
        if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
        const parts = [];
        for (let n = el; n?.nodeType === 1 && parts.length < 7; n = n.parentElement) {
          let part = n.localName;
          if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
          if (n.parentElement) {
            const siblings = [...n.parentElement.children].filter(s => s.localName === n.localName);
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(n) + 1) + ')';
          }
          parts.unshift(part);
          if (document.querySelectorAll(parts.join(' > ')).length === 1) break;
        }
        return parts.join(' > ');
      };
      const at = e => {
        root.style.pointerEvents = 'none';
        let el = document.elementFromPoint(e.clientX, e.clientY);
        while (el?.shadowRoot?.elementFromPoint) {
          const child = el.shadowRoot.elementFromPoint(e.clientX, e.clientY);
          if (!child || child === el) break;
          el = child;
        }
        root.style.pointerEvents = 'auto';
        return el;
      };
      const box = r => ({x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height)});
      const draw = (r, name) => {
        Object.assign(outline.style, {left:r.x+'px', top:r.y+'px', width:r.width+'px', height:r.height+'px'});
        label.textContent = name;
        label.style.left = Math.max(4, Math.min(r.x, innerWidth-250))+'px';
        label.style.top = Math.max(4, r.y > 32 ? r.y-29 : r.y+r.height+3)+'px';
      };
      const area = e => ({x:Math.min(start.x,e.clientX), y:Math.min(start.y,e.clientY), width:Math.abs(start.x-e.clientX), height:Math.abs(start.y-e.clientY)});
      const stop = e => { e.preventDefault(); e.stopImmediatePropagation(); };
      const finish = result => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        window.removeEventListener('keydown', key, true);
        window.removeEventListener('pagehide', cancel);
        root.remove();
        delete globalThis.__agyTempAnnotator;
        // Swallow the synthetic click following pointerup, so selection never activates a link.
        window.addEventListener('click', stop, true);
        setTimeout(() => window.removeEventListener('click', stop, true), 250);
        resolve(result);
      };
      const cancel = () => finish(null);
      const key = e => { if (e.key === 'Escape') { stop(e); cancel(); } };
      root.addEventListener('pointermove', e => {
        stop(e);
        if (start && Math.hypot(start.x-e.clientX,start.y-e.clientY)>7) draw(area(e),'Area — release to comment');
        else { target = at(e); if (target) draw(target.getBoundingClientRect(), target.localName+' · '+selector(target)); }
      });
      root.addEventListener('pointerdown', e => {
        stop(e);
        if (e.button !== 0) return;
        start = {x:e.clientX,y:e.clientY}; target = at(e);
        root.setPointerCapture(e.pointerId);
      });
      root.addEventListener('pointerup', e => {
        stop(e);
        if (!start || e.button !== 0) return;
        const isArea = Math.hypot(start.x-e.clientX,start.y-e.clientY)>7;
        const el = target;
        if (!el) return cancel();
        const rect = isArea ? area(e) : el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const result = {
          kind:isArea?'area':'element', url:location.href, title:document.title,
          viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY}, rect:box(rect),
          selector:isArea?'':selector(el),
          element:el.localName, text:((el instanceof HTMLElement ? el.innerText : el.textContent)||el.getAttribute('aria-label')||el.getAttribute('alt')||'').trim().slice(0,700),
          styles:isArea?undefined:{font:style.font,color:style.color,background:style.backgroundColor,padding:style.padding,margin:style.margin,display:style.display}
        };
        finish(result);
      });
      root.addEventListener('contextmenu', e => {stop(e);cancel();});
      window.addEventListener('keydown', key, true);
      window.addEventListener('pagehide', cancel, {once:true});
      const timeout = setTimeout(cancel, 120000);
      globalThis.__agyTempAnnotator = {cancel};
      label.textContent = 'Click an element or drag an area · Esc cancels';
      label.style.left='12px'; label.style.top='12px';
    });
  }

  const style = document.createElement('style');
  style.textContent = `
    [data-agy-annotate-button][aria-pressed="true"] {color:#4285f4;background:#4285f41a}
    .agy-annotation-panel {position:fixed;right:18px;top:112px;z-index:2147483647;width:350px;max-width:calc(100vw - 36px);padding:16px;box-sizing:border-box;color:var(--foreground,#242424);background:var(--background,#fff);border:1px solid #8886;border-radius:12px;box-shadow:0 8px 32px #0003;font:13px/1.5 system-ui}
    .agy-annotation-panel h3 {font-size:15px;font-weight:600;margin:0 0 10px}
    .agy-annotation-panel pre {max-height:130px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 monospace;background:#8881;border-radius:6px;padding:8px;margin:0 0 12px;user-select:text}
    .agy-annotation-panel textarea {display:block;box-sizing:border-box;width:100%;min-height:100px;resize:vertical;max-height:35vh;border:1px solid #8887;border-radius:6px;padding:9px;color:inherit;background:transparent;font:13px/1.5 system-ui;outline-offset:2px}
    .agy-annotation-panel .agy-actions {display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
    .agy-annotation-panel button {font:inherit;border:1px solid #8886;border-radius:6px;padding:6px 12px;cursor:pointer}
    .agy-annotation-panel .agy-save {background:#1a73e8;color:white;border-color:#1a73e8}
    .agy-annotation-panel button:disabled {opacity:.45;cursor:default}
    .agy-annotation-panel small {display:block;margin-top:8px;opacity:.7}
  `;
  document.head.append(style);

  function close() {
    if (!session) return;
    const current = session;
    session = null;
    current.panel?.remove();
    if (current.view.tabKey) wcv.setOverlayActive(current.view.tabKey, false).catch(()=>{});
    current.button?.setAttribute('aria-pressed','false');
    guestRun(current.view, 'globalThis.__agyTempAnnotator?.cancel(); true').catch(()=>{});
  }
  function messagePanel(text, current) {
    const panel = document.createElement('section');
    panel.className='agy-annotation-panel';
    panel.setAttribute('role','dialog'); panel.setAttribute('aria-label','Inspect and annotate');
    const heading = document.createElement('h3'); heading.textContent=text;
    panel.append(heading); document.body.append(panel); current.panel=panel;
    if (current.view.tabKey) wcv.setOverlayActive(current.view.tabKey, true).catch(()=>{});
    return panel;
  }
  function draftText(pick, comment) {
    const detail = pick.kind==='element' ? `Element: ${pick.selector}\nText: ${pick.text}\nStyles: ${JSON.stringify(pick.styles)}` : `Area near: ${pick.element}\nNearby text: ${pick.text}`;
    return `Browser annotation (${pick.kind})\nPage: ${pick.url}\nViewport: ${pick.viewport.width} × ${pick.viewport.height}; scroll: ${pick.viewport.scrollX}, ${pick.viewport.scrollY}\nBounds in viewport: ${JSON.stringify(pick.rect)}\n${detail}\nRequested change: ${comment.trim()}`;
  }
  async function addToDraft(text) {
    const editor = [...document.querySelectorAll('[contenteditable="true"][aria-label="Message input"]')].find(visible);
    if (!editor) throw new Error('Open a conversation with a message input first.');
    editor.focus();
    const range=document.createRange(); range.selectNodeContents(editor); range.collapse(false);
    const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const clipboard=new DataTransfer();
    clipboard.setData('text/plain',(editor.textContent.trim()?'\n\n':'')+text+'\n');
    editor.dispatchEvent(new ClipboardEvent('paste',{clipboardData:clipboard,bubbles:true,cancelable:true}));
    // Lexical commits paste asynchronously; textContent also drops paragraph breaks.
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const normalize=value=>value.replace(/\s+/g,' ').trim();
    if (!normalize(editor.innerText).includes(normalize(text))) throw new Error('Could not add the annotation to the draft. Your comment is still here; copy it or retry.');
  }
  async function start(button, toolbar) {
    if (session) { close(); return; }
    const candidates=[...document.querySelectorAll('webview')].filter(visible);
    const region=toolbar.closest('[role="region"]');
    let view=candidates.find(v=>region?.contains(v)) || candidates.at(-1);
    try { if (!view) view=activeGuest(); } catch(error) { const current={button,view:{getWebContentsId:()=>0},panel:null}; session=current; const p=messagePanel('Annotation unavailable',current); const t=document.createElement('p');t.textContent=error.message;const b=document.createElement('button');b.textContent='Close';b.onclick=close;p.append(t,b);return; }
    const current={button,view,panel:null,conversation:location.pathname}; session=current;
    button.setAttribute('aria-pressed','true');
    try {
      if (view.tabKey) await wcv.elevate(view.tabKey, 'annotation', true);
      const pick=await guestRun(view,`(${pickInGuest.toString()})()`);
      if (session!==current) return;
      if (!pick) { close(); return; }
      const panel=messagePanel(pick.kind==='element'?'Annotate element':'Annotate area',current);
      const preview=document.createElement('pre');
      preview.textContent=(pick.selector||`Area: ${pick.rect.width} × ${pick.rect.height}`)+(pick.text?'\n'+pick.text:'');
      const input=document.createElement('textarea'); input.placeholder='What should change here?'; input.setAttribute('aria-label','Annotation comment');
      const checkLabel=document.createElement('label'); checkLabel.style.cssText='display:flex;align-items:center;gap:7px;margin-top:10px';
      const check=document.createElement('input');check.type='checkbox';check.checked=true;
      checkLabel.append(check,document.createTextNode('Attach page screenshot'));
      const note=document.createElement('small'); note.textContent='Adds to your draft. Review it, then send when ready.';
      const actions=document.createElement('div');actions.className='agy-actions';
      const cancel=document.createElement('button');cancel.textContent='Cancel';cancel.onclick=close;
      const save=document.createElement('button');save.className='agy-save';save.textContent='Add to chat';save.disabled=true;
      input.oninput=()=>save.disabled=!input.value.trim();
      save.onclick=async()=>{
        save.disabled=true;
        try {
          if ((view.tabKey && activeGuest().tabKey!==view.tabKey) || location.pathname!==current.conversation || !toolbar.isConnected || !visible(view) || view.getURL()!==pick.url) throw new Error('The conversation or browser tab changed. Select the element again.');
          await addToDraft(draftText(pick,input.value));
          if (check.checked) toolbar.click();
          close();
        } catch(error) {note.textContent=error.message;note.style.color='#d93025';save.disabled=false;}
      };
      panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();close();}else if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();if(!save.disabled)save.click();}});
      actions.append(cancel,save);panel.append(preview,input,checkLabel,note,actions);input.focus();
    } catch(error) {
      if (session!==current) return;
      const panel=messagePanel('Annotation unavailable',current);
      const text=document.createElement('p');text.textContent=error.message;
      const dismiss=document.createElement('button');dismiss.textContent='Close';dismiss.onclick=close;
      panel.append(text,dismiss);
    }
  }
  function mount() {
    document.querySelectorAll('[data-testid="webview-url-bar-screenshot"]').forEach(camera=>{
      const parent=camera.parentElement;
      if(parent.querySelector('[data-agy-annotate-button]'))return;
      const button=document.createElement('button');button.type='button';
      button.className=camera.className;
      button.setAttribute('data-agy-annotate-button','');button.setAttribute('aria-label','Inspect / Annotate');
      button.setAttribute('aria-pressed','false');button.title='Inspect / Annotate — click an element or drag an area';
      button.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3H4a1 1 0 0 0-1 1v5m12-6h5a1 1 0 0 1 1 1v5M3 15v5a1 1 0 0 0 1 1h5"/><path d="m10 10 4 11 2-5 5-2Z"/></svg>';
      button.onclick=()=>start(button,camera);parent.insertBefore(button,camera);
    });
  }
  let scheduled=false;
  new MutationObserver(()=>{if(!scheduled){scheduled=true;requestAnimationFrame(()=>{scheduled=false;mount();});}}).observe(document.body,{childList:true,subtree:true});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&session){e.preventDefault();close();}},true);
  mount();
}

window.addEventListener('DOMContentLoaded', () => {
    if (window.top !== window) return;
    electron_1.webFrame.executeJavaScript('(' + installAntigravityAnnotator.toString() + ')()')
      .catch(error => console.error('[Temporary annotator]', error));
}, { once: true });
