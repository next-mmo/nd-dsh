/**
 * Shared fixed page helper for Gemini Web chat turns. DOM nodes stay in-page.
 * Gemini renders user queries inside `user-query-content` and assistant
 * responses inside `model-response-content` / `model-response-text`; markdown
 * text lives in a nested `.markdown` node. Response completeness is signalled
 * by the Copy action inside the assistant response.
 *
 * Turn serialization preserves markdown structures, images, links, and code
 * blocks so rich multimedia responses from Gemini Web render accurately in ND.
 */
export const GEMINI_DOM_TURNS_SCRIPT = `
  const serializeGeminiDomNode = (node) => {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';

    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'svg') return '';

    const className = typeof node.className === 'string' ? node.className : (node.getAttribute?.('class') || '');
    if (/\\b(?:cdk-visually-hidden|screen-reader-user-query-label|sr-only)\\b/i.test(className)) return '';

    const hasNestedImg = Boolean(node.querySelector?.('img'));
    if (tag === 'button' && !hasNestedImg) return '';

    const classList = className.trim().split(/\\s+/);
    const isCaption = classList.includes('caption') || classList.includes('hero-caption');
    if (node.getAttribute?.('aria-hidden') === 'true' && !hasNestedImg && !isCaption) return '';

    const serializeChildren = (parent) => {
      let result = '';
      const children = parent.childNodes || [];
      for (let i = 0; i < children.length; i++) {
        result += serializeGeminiDomNode(children[i]);
      }
      return result;
    };

    if (tag === 'img') {
      let src = node.currentSrc || node.src || node.getAttribute?.('src') || node.getAttribute?.('data-src') || '';
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
      if (src.startsWith('blob:')) return '';
      const alt = (node.alt || node.getAttribute?.('alt') || node.getAttribute?.('title') || '')
        .replace(/(?:,\\s*AI generated)+$/i, '')
        .trim();
      if (src && /^(?:https?:\\/\\/|data:image\\/)/i.test(src)) {
        const safeSrc = src.replace(/\\(/g, '%28').replace(/\\)/g, '%29');
        const rawAlt = alt.replace(/[\\[\\]\\r\\n]/g, ' ').replace(/\\s+/g, ' ').trim();
        const cleanAlt = rawAlt.length > 120 ? rawAlt.slice(0, 117).trimEnd() + '...' : rawAlt;
        const imgMd = '![' + (cleanAlt || 'Generated image') + '](' + safeSrc + ')';
        const fullUriEl = node.closest?.('[data-full-size-image-uri]');
        const fullUri = (fullUriEl?.getAttribute?.('data-full-size-image-uri') || '').trim();
        const inAnchor = Boolean(node.closest?.('a[href]'));
        if (!inAnchor && fullUri && /^https?:\\/\\//i.test(fullUri)) {
          const safeFullUri = fullUri.replace(/\\(/g, '%28').replace(/\\)/g, '%29');
          return '\\n\\n[' + imgMd + '](' + safeFullUri + ')\\n\\n';
        }
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
    if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'single-image' || tag === 'response-element') {
      return '\\n' + serializeChildren(node) + '\\n';
    }

    return serializeChildren(node);
  };

  const serializeGeminiDomRoot = (root) => {
    if (!root) return '';
    if (!root.childNodes || root.childNodes.length === 0) {
      return (root.innerText || root.textContent || '').trim();
    }
    const raw = serializeGeminiDomNode(root);
    return raw
      .replace(/[ \\t]+/g, ' ')
      .replace(/ *\\n */g, '\\n')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();
  };

  const readGeminiDomTurns = () => {
    const nodeSelector = 'user-query-content, model-response-content, model-response-text';
    const candidates = Array.from(document.querySelectorAll(nodeSelector));
    const roots = candidates.filter((node) => !candidates.some((other) => other !== node && other.contains?.(node)));
    const turns = [];
    let scrolledPendingSlot = false;
    for (const node of roots) {
      const role = node.tagName.toLowerCase().startsWith('user') ? 'user' : 'assistant';
      const markdown = node.querySelector('.markdown, [data-test-id="response-content"], .model-response-text');
      const textRoot = markdown instanceof HTMLElement ? markdown : node;
      const responseScope = (role === 'assistant' && node.closest?.('model-response, response-container, .response-container')) || node;
      const copyButton = responseScope.querySelector?.('copy-button button, button[aria-label*="Copy" i], [data-test-id="copy-response-button"]')
        || node.querySelector?.('button[aria-label*="Copy" i], [data-test-id="copy-response-button"]');
      const ariaBusy = textRoot.getAttribute?.('aria-busy') === 'true' || node.querySelector?.('[aria-busy="true"]') !== null;
      const imageSlots = Array.from((node.querySelectorAll?.('single-image, generated-image, .attachment-container.search-images') || textRoot.querySelectorAll?.('single-image, generated-image, .attachment-container.search-images')) || []);
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
      const complete = role === 'assistant' && copyButton !== null && !ariaBusy && !imagesPending;
      let text = serializeGeminiDomRoot(textRoot);
      if (textRoot !== node && typeof node.querySelectorAll === 'function') {
        const extraImgs = Array.from(node.querySelectorAll('img')).filter((img) => !textRoot.contains?.(img));
        for (const extraImg of extraImgs) {
          const extraMd = serializeGeminiDomNode(extraImg).trim();
          if (extraMd && !text.includes(extraMd)) {
            text = text ? text + '\\n\\n' + extraMd : extraMd;
          }
        }
      }
      if (text) turns.push({ node, root: textRoot, role, complete, imagesPending, text });
    }
    return turns;
  };
`
