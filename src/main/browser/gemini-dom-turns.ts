/**
 * Shared fixed page helper for Gemini Web chat turns. DOM nodes stay in-page.
 * Gemini renders user queries inside `user-query-content` and assistant
 * responses inside `model-response-content` / `model-response-text`; markdown
 * text lives in a nested `.markdown` node. Response completeness is signalled
 * by the Copy action inside the assistant response.
 */
export const GEMINI_DOM_TURNS_SCRIPT = `
  const readGeminiDomTurns = () => {
    const nodeSelector = 'user-query-content, model-response-content, model-response-text';
    const candidates = Array.from(document.querySelectorAll(nodeSelector));
    const roots = candidates.filter((node) => !candidates.some((other) => other !== node && other.contains?.(node)));
    const turns = [];
    for (const node of roots) {
      const role = node.tagName.toLowerCase().startsWith('user') ? 'user' : 'assistant';
      const markdown = node.querySelector('.markdown, [data-test-id="response-content"], .model-response-text');
      const copyButton = node.querySelector('button[aria-label*="Copy" i], [data-test-id="copy-response-button"]');
      const complete = role === 'assistant' && copyButton !== null;
      const textRoot = markdown instanceof HTMLElement ? markdown : node;
      const text = textRoot.innerText?.trim() || '';
      if (text) turns.push({ node, root: textRoot, role, complete });
    }
    return turns;
  };
`
