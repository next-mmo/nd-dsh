/**
 * Shared fixed page helper for GPT Web and ND Translate. DOM nodes stay in-page.
 * Preserves markdown structures, generated/uploaded images, links, tables, and
 * code blocks while ignoring inactive hidden workspaces kept in the DOM by
 * ChatGPT's SPA router.
 */
export const CHATGPT_DOM_TURNS_SCRIPT = `
  const isHiddenChatGptNode = (el) => {
    if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return false;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.hidden || cur.getAttribute?.('aria-hidden') === 'true') return true;
      const style = window.getComputedStyle(cur);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      cur = cur.parentElement;
    }
    return false;
  };

  const serializeChatGptDomNode = (node) => {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';

    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'svg') return '';

    const className = typeof node.className === 'string' ? node.className : (node.getAttribute?.('class') || '');
    if (/\\b(?:sr-only|visually-hidden|turn-action-controls)\\b/i.test(className)) return '';
    if (node.hasAttribute?.('data-conversation-role')) return '';
    if (/^h[1-6]$/i.test(tag) && /^(?:You said|ChatGPT said):?$/i.test((node.textContent || '').trim())) return '';

    const mdCopy = node.getAttribute?.('data-markdown-copy');
    if (mdCopy === 'exclude') return '';

    if (node.getAttribute?.('data-code-block') === 'true' || mdCopy === 'code-block') {
      const header = node.querySelector?.('[data-markdown-copy="exclude"]');
      const langRaw = (header?.textContent || '').trim().split(/\\s+/)[0] || '';
      const lang = /^[a-zA-Z0-9_+-]+$/.test(langRaw) ? langRaw.toLowerCase() : '';
      const sourceEl = node.querySelector?.('[data-code-block-source="true"], code, pre');
      const codeText = (sourceEl?.textContent || '').replace(/\\r\\n/g, '\\n').trimEnd();
      return '\\n\\n\`\`\`' + lang + '\\n' + codeText + '\\n\`\`\`\\n\\n';
    }

    const hasNestedImg = Boolean(node.querySelector?.('img'));
    if (tag === 'button' && !hasNestedImg) return '';

    const classList = className.trim().split(/\\s+/);
    const isCaption = classList.includes('caption') || tag === 'figcaption';
    if (node.getAttribute?.('aria-hidden') === 'true' && !hasNestedImg && !isCaption) return '';

    const serializeChildren = (parent) => {
      let result = '';
      const children = parent.childNodes || [];
      for (let i = 0; i < children.length; i++) {
        result += serializeChatGptDomNode(children[i]);
      }
      return result;
    };

    if (tag === 'img') {
      const parentClass = typeof node.parentElement?.className === 'string'
        ? node.parentElement.className
        : (node.parentElement?.getAttribute?.('class') || '');
      let src = node.currentSrc || node.src || node.getAttribute?.('src') || node.getAttribute?.('data-src') || '';
      if (node.closest?.('[data-testid="chatgpt-citation"]') || /\\bFavicon-/i.test(parentClass) || /(?:faviconV2|google\\.com\\/s2\\/favicons)/i.test(src)) {
        return '';
      }
      if (src.startsWith('blob:') && node.complete && node.naturalWidth > 0 && typeof document !== 'undefined') {
        if (node.__ndCachedSrc === src && typeof node.__ndCachedDataUrl === 'string') {
          src = node.__ndCachedDataUrl;
        } else {
          try {
            const origSrc = src;
            const maxDim = 1280;
            let w = node.naturalWidth;
            let h = node.naturalHeight;
            if (w > maxDim || h > maxDim) {
              const scale = maxDim / Math.max(w, h);
              w = Math.max(1, Math.round(w * scale));
              h = Math.max(1, Math.round(h * scale));
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(node, 0, 0, w, h);
              let dataUrl = '';
              if (w * h > 262144) {
                dataUrl = canvas.toDataURL('image/webp', 0.85);
              }
              if (!dataUrl || !dataUrl.startsWith('data:image/')) {
                dataUrl = canvas.toDataURL('image/png');
              }
              if (dataUrl && dataUrl.startsWith('data:image/')) {
                src = dataUrl;
                node.__ndCachedSrc = origSrc;
                node.__ndCachedDataUrl = dataUrl;
              }
            }
          } catch {}
        }
      }
      const alt = (node.alt || node.getAttribute?.('alt') || node.getAttribute?.('title') || 'Image').trim();
      if (src && /^(?:https?:\\/\\/|data:image\\/|blob:)/i.test(src)) {
        const safeSrc = src.replace(/\\(/g, '%28').replace(/\\)/g, '%29');
        const cleanAlt = alt.replace(/[\\[\\]\\r\\n]/g, ' ').trim();
        const imgMd = '![' + cleanAlt + '](' + safeSrc + ')';
        const inAnchor = Boolean(node.closest?.('a[href]'));
        return inAnchor ? imgMd : '\\n\\n' + imgMd + '\\n\\n';
      }
      return '';
    }

    if (isCaption) {
      const text = serializeChildren(node).replace(/\\s+/g, ' ').trim();
      return text ? '\\n*' + text + '*\\n' : '';
    }

    if (tag === 'a') {
      const href = (node.href || node.getAttribute?.('href') || '').trim();
      const childText = serializeChildren(node).trim();
      if (!href || !/^https?:\\/\\//i.test(href)) return childText;
      const safeHref = href.replace(/\\(/g, '%28').replace(/\\)/g, '%29');

      const imgMatch = childText.match(/^!\\[([^\\]]*)\\]\\(([^)]+)\\)$/);
      if (imgMatch) {
        return '[![' + imgMatch[1] + '](' + imgMatch[2] + ')](' + safeHref + ')';
      }

      const imgPrefixMatch = childText.match(/^(!\\[[^\\]]*\\]\\([^)]+\\))\\s*(.*)$/);
      if (imgPrefixMatch) {
        const innerImg = imgPrefixMatch[1].match(/^!\\[([^\\]]*)\\]\\(([^)]+)\\)$/);
        const rest = imgPrefixMatch[2]?.trim();
        if (innerImg) {
          const linkedImg = '[![' + innerImg[1] + '](' + innerImg[2] + ')](' + safeHref + ')';
          if (!rest || rest.toLowerCase() === innerImg[1].toLowerCase()) return linkedImg;
          return linkedImg + ' [' + rest.replace(/[\\[\\]]/g, '') + '](' + safeHref + ')';
        }
      }

      if (childText) return '[' + childText.replace(/[\\[\\]]/g, '') + '](' + safeHref + ')';
      const title = (node.getAttribute?.('title') || '').trim();
      if (title) return '[' + title.replace(/[\\[\\]]/g, '') + '](' + safeHref + ')';
      return '';
    }

    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll?.('tr') || []);
      if (rows.length === 0) return serializeChildren(node);
      const mdRows = [];
      for (let r = 0; r < rows.length; r++) {
        const cells = Array.from(rows[r].querySelectorAll?.('th, td') || []);
        if (cells.length === 0) continue;
        const cellTexts = cells.map((c) => serializeChildren(c).replace(/\\s*\\n\\s*/g, ' ').replace(/\\|/g, '\\\\|').trim());
        mdRows.push('| ' + cellTexts.join(' | ') + ' |');
        if (r === 0) {
          mdRows.push('| ' + cells.map(() => '---').join(' | ') + ' |');
        }
      }
      return mdRows.length > 0 ? '\\n\\n' + mdRows.join('\\n') + '\\n\\n' : '';
    }

    if (tag === 'pre') {
      const codeEl = node.querySelector?.('code');
      const codeText = codeEl ? (codeEl.textContent || '') : (node.textContent || '');
      const codeClass = (codeEl && codeEl.className) || className || '';
      const langMatch = typeof codeClass === 'string' ? codeClass.match(/language-([a-zA-Z0-9_-]+)/) : null;
      const lang = langMatch ? langMatch[1] : '';
      return '\\n\\n\`\`\`' + lang + '\\n' + codeText.replace(/\\r\\n/g, '\\n').trimEnd() + '\\n\`\`\`\\n\\n';
    }

    if (tag === 'code') {
      const text = (node.textContent || '').replace(/\\r\\n/g, '\\n');
      return '\`' + text + '\`';
    }

    if (/^h[1-6]$/.test(tag)) {
      const level = Math.min(parseInt(tag.slice(1), 10) || 1, 3);
      const text = serializeChildren(node).trim();
      return text ? '\\n\\n' + '#'.repeat(level) + ' ' + text + '\\n\\n' : '';
    }

    if (tag === 'strong' || tag === 'b') {
      const text = serializeChildren(node).trim();
      return text ? '**' + text + '**' : '';
    }

    if (tag === 'em' || tag === 'i') {
      const text = serializeChildren(node).trim();
      return text ? '*' + text + '*' : '';
    }

    if (tag === 'ul' || tag === 'ol') {
      return '\\n' + serializeChildren(node) + '\\n';
    }

    if (tag === 'li') {
      const text = serializeChildren(node).trim();
      return text ? '\\n- ' + text : '';
    }

    if (tag === 'blockquote') {
      const text = serializeChildren(node).trim();
      return text ? '\\n> ' + text + '\\n' : '';
    }

    if (tag === 'p') {
      const text = serializeChildren(node).trim();
      return text ? '\\n\\n' + text + '\\n\\n' : '';
    }

    if (tag === 'br') return '\\n';
    if (tag === 'hr') return '\\n\\n---\\n\\n';
    if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'figure') {
      return '\\n' + serializeChildren(node) + '\\n';
    }

    return serializeChildren(node);
  };

  const serializeChatGptDomRoot = (root) => {
    if (!root) return '';
    if (!root.childNodes || root.childNodes.length === 0) {
      return (root.innerText || root.textContent || '').trim();
    }
    const raw = serializeChatGptDomNode(root);
    return raw
      .replace(/[ \\t]+/g, ' ')
      .replace(/ *\\n */g, '\\n')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();
  };

  const readChatGptDomTurns = ({ legacyFallback = false } = {}) => {
    let nodes = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"], [data-conversation-transcript] [data-message-role]'))
      .filter((el) => !isHiddenChatGptNode(el));
    const headingRoles = new Map();
    if (legacyFallback && !nodes.length) {
      nodes = Array.from(document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]'))
        .filter((el) => !isHiddenChatGptNode(el));
    }
    if (legacyFallback && !nodes.length) {
      const headings = Array.from(document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6, main [role="heading"]'))
        .filter((el) => !isHiddenChatGptNode(el));
      const roleHeadings = headings.filter(el => /^(You said|ChatGPT said):?$/.test(el.textContent?.trim() || ''));
      for (const heading of roleHeadings) {
        const hRole = heading.textContent.trim().startsWith('You said') ? 'user' : 'assistant';
        let root = heading.parentElement;
        let lastSingleRoot = null;
        let matched = false;
        while (root && roleHeadings.filter(el => root.contains(el)).length === 1) {
          lastSingleRoot = root;
          const text = root.innerText?.trim() || '';
          if ((text && text !== heading.textContent?.trim()) || root.querySelector?.('img, [data-testid="generated-image-gallery"]')) {
            nodes.push(root);
            headingRoles.set(root, hRole);
            matched = true;
            break;
          }
          root = root.parentElement;
        }
        if (!matched && lastSingleRoot) {
          const scope = lastSingleRoot.closest?.('[data-talvt-turn-state], [data-turn-key]');
          if (scope?.querySelector?.('img, [data-testid="generated-image-gallery"]')) {
            nodes.push(lastSingleRoot);
            headingRoles.set(lastSingleRoot, hRole);
          }
        }
      }
    }
    // Legacy turns can contain a transcript-role node. Keep the outer turn once.
    const outerNodes = nodes.filter((node) => !nodes.some((other) => other !== node && other.contains?.(node)));
    let scrolledPendingSlot = false;
    return outerNodes.flatMap((node) => {
      const messageRole = node.getAttribute('data-message-role');
      const declared = node.getAttribute('data-turn') || node.getAttribute('data-message-author-role') || messageRole;
      const owned = node.querySelector('[data-message-author-role], [data-message-role]');
      const ownedRole = owned?.getAttribute('data-message-author-role') || owned?.getAttribute('data-message-role');
      const role = declared || ownedRole || headingRoles.get(node);
      if (role !== 'user' && role !== 'assistant') return [];
      // An explicit turn role owns the turn even if a nested node claims another role.
      const root = owned && (!declared || ownedRole === role) ? owned : node;
      const turnScope = (role === 'assistant' && node.closest?.('[data-talvt-turn-state], [data-turn-key]')) || node;
      const copy = node.querySelector('button[data-testid="copy-turn-action-button"], button[aria-label="Copy response"]') !== null
        || (legacyFallback && (
          node.querySelector('button[aria-label="Copy"]') !== null
          || node.querySelector('button[aria-label="Copy image"]') !== null
          || (turnScope !== node && turnScope.querySelector?.('.turn-action-controls button[aria-label="Copy"], .turn-action-controls button[aria-label="Copy image"], button[data-testid="copy-turn-action-button"], button[aria-label="Copy response"]') !== null)
        ));
      const imageSlots = role === 'assistant'
        ? Array.from((turnScope.querySelectorAll?.('[data-testid="generated-image-gallery"], .group\\\\/generated-image-preview') || root.querySelectorAll?.('[data-testid="generated-image-gallery"], .group\\\\/generated-image-preview')) || [])
        : [];
      const imagesPending = imageSlots.some((slot) => {
        const img = slot.querySelector?.('img');
        const src = img ? (img.currentSrc || img.src || img.getAttribute?.('src') || img.getAttribute?.('data-src') || '') : '';
        if (!src || (img && img.complete === false)) {
          if (!scrolledPendingSlot) {
            scrolledPendingSlot = true;
            slot.scrollIntoView?.({ block: 'center' });
          }
          return true;
        }
        return false;
      });
      const transcriptRoot = root.getAttribute('data-message-role') ? root : messageRole ? node : undefined;
      const complete = role === 'assistant' && copy && !imagesPending && (!transcriptRoot || transcriptRoot.hasAttribute('data-message-complete'));
      let text = serializeChatGptDomRoot(root);
      if (role === 'assistant' && turnScope !== root && typeof turnScope.querySelectorAll === 'function') {
        const extraImgs = Array.from(turnScope.querySelectorAll('img')).filter((img) =>
          !root.contains?.(img)
          && !img.closest?.('[data-chatgpt-search-unit-key*=":user"], [data-content-search-unit-key*=":user"], [data-user-message-bubble], [data-message-author-role="user"], [data-turn="user"]')
        );
        for (const extraImg of extraImgs) {
          const extraMd = serializeChatGptDomNode(extraImg).trim();
          if (extraMd && !text.includes(extraMd)) {
            text = text ? extraMd + '\\n\\n' + text : extraMd;
          }
        }
      }
      return [{ node, root, role, complete, imagesPending, text }];
    });
  };
`

