/** Shared fixed page helper for GPT Web and ND Translate. DOM nodes stay in-page. */
export const CHATGPT_DOM_TURNS_SCRIPT = `
  const readChatGptDomTurns = ({ legacyFallback = false } = {}) => {
    let nodes = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"], [data-conversation-transcript] [data-message-role]'));
    const headingRoles = new Map();
    if (legacyFallback && !nodes.length) {
      nodes = Array.from(document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]'));
    }
    if (legacyFallback && !nodes.length) {
      const headings = Array.from(document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6, main [role="heading"]'));
      const roleHeadings = headings.filter(el => /^(You said|ChatGPT said):?$/.test(el.textContent?.trim() || ''));
      for (const heading of roleHeadings) {
        let root = heading.parentElement;
        while (root && roleHeadings.filter(el => root.contains(el)).length === 1) {
          const text = root.innerText?.trim() || '';
          if (text && text !== heading.textContent?.trim()) {
            nodes.push(root);
            headingRoles.set(root, heading.textContent.trim().startsWith('You said') ? 'user' : 'assistant');
            break;
          }
          root = root.parentElement;
        }
      }
    }
    // Legacy turns can contain a transcript-role node. Keep the outer turn once.
    const outerNodes = nodes.filter((node) => !nodes.some((other) => other !== node && other.contains?.(node)));
    return outerNodes.flatMap((node) => {
      const messageRole = node.getAttribute('data-message-role');
      const declared = node.getAttribute('data-turn') || node.getAttribute('data-message-author-role') || messageRole;
      const owned = node.querySelector('[data-message-author-role], [data-message-role]');
      const ownedRole = owned?.getAttribute('data-message-author-role') || owned?.getAttribute('data-message-role');
      const role = declared || ownedRole || headingRoles.get(node);
      if (role !== 'user' && role !== 'assistant') return [];
      // An explicit turn role owns the turn even if a nested node claims another role.
      const root = owned && (!declared || ownedRole === role) ? owned : node;
      const copy = node.querySelector('button[data-testid="copy-turn-action-button"], button[aria-label="Copy response"]') !== null
        || (legacyFallback && node.querySelector('button[aria-label="Copy"]') !== null);
      const transcriptRoot = root.getAttribute('data-message-role') ? root : messageRole ? node : undefined;
      const complete = role === 'assistant' && copy && (!transcriptRoot || transcriptRoot.hasAttribute('data-message-complete'));
      return [{ node, root, role, complete }];
    });
  };
`
