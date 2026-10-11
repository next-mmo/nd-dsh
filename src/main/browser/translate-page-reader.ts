import type { NdTranslateProvider } from '../../shared/nd-translate.js'
import { CHATGPT_DOM_TURNS_SCRIPT } from './chatgpt-dom-turns.js'

/** Fixed, provider-specific page observation. No user text is interpolated as code. */
export function translatePageReadScript(provider: NdTranslateProvider): string {
  if (!['google', 'chatgpt', 'gemini'].includes(provider)) throw new Error('Unsupported translation provider')
  return `(() => {
    ${CHATGPT_DOM_TURNS_SCRIPT}
    const provider = ${JSON.stringify(provider)};
    const url = location.href;
    const expected = { google: 'https://translate.google.com', chatgpt: 'https://chatgpt.com', gemini: 'https://gemini.google.com' }[provider];
    const challenge = location.hostname === 'consent.google.com' || location.pathname.includes('/sorry/') || /verify you are human|checking your browser|just a moment/i.test(document.title) || Boolean(document.querySelector('#challenge-form, #captcha-form, .g-recaptcha, iframe[src*="challenges.cloudflare.com"]'));
    const loginRequired = location.hostname === 'accounts.google.com' || location.pathname.includes('/auth/');
    if (location.origin !== expected || challenge || loginRequired) return { url, challenge, loginRequired };
    const visible = (node) => node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none';
    const select = (selector, root = document) => Array.from(root.querySelectorAll(selector)).filter(visible);
    const label = (node) => (node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || '').trim();
    const buttons = select('button');
    const authAction = (node) => /^(?:(?:log|sign) in|create(?: an)? account|continue with (?:phone|email|google|apple|microsoft))(?:\\b|$)/i.test(label(node));
    // An authentication modal can cover a still-visible background composer.
    // Inspect only visible dialog controls/credential fields, never prompt text.
    const authDialog = provider !== 'google' && select('dialog, [role="dialog"], [aria-modal="true"]').some((dialog) => {
      const controls = select('button, a, [role="button"]', dialog);
      const credentialField = select('input[type="tel"], input[type="email"], input[type="password"], input[autocomplete="tel"], input[autocomplete="email"], input[autocomplete="username"], input[name*="phone" i], input[placeholder*="phone" i]', dialog).length > 0;
      const accountHeading = select('h1, h2, [role="heading"]', dialog).some((node) => /^(?:(?:log|sign) in|create(?: an)? account)(?:\\b|$)/i.test(label(node)));
      return controls.some(authAction) && (credentialField || accountHeading)
        || credentialField && accountHeading && controls.some((node) => /^continue$/i.test(label(node)));
    });
    if (authDialog) return { url, loginRequired: true };
    let text = '';
    let pending = false;
    let complete = provider === 'google';
    if (provider === 'google') {
      text = select('span[jsname="W297wb"]').map((node) => node.textContent || '').join(' ');
    } else {
      const assistantTurn = provider === 'chatgpt' ? readChatGptDomTurns().filter((turn) => turn.role === 'assistant').at(-1) : undefined;
      const selector = provider === 'chatgpt'
        ? '.markdown, [data-message-content], [class~="prose"], [data-assistant-markdown]'
        : 'model-response-content message-content .markdown, .model-response-text message-content .markdown';
      // A response wrapper may have no layout box (for example display:contents)
      // while its paragraphs remain rendered. Keep the check inside the known
      // assistant response; a prompt/body text match never supplies output.
      const responseRoot = provider === 'chatgpt' ? assistantTurn?.root : document;
      const candidates = [
        ...(provider === 'chatgpt' && responseRoot?.matches?.(selector) ? [responseRoot] : []),
        ...Array.from(responseRoot?.querySelectorAll(selector) || [])
      ].filter((node) => {
        const style = getComputedStyle(node);
        return style.visibility !== 'hidden' && style.display !== 'none'
          && (visible(node) || Array.from(node.children || []).some(visible));
      });
      // Keep complete outer content containers. Picking the final nested prose
      // node loses earlier paragraphs; joining nested matches duplicates text.
      const outerContent = candidates.filter((node) => !candidates.some((other) => other !== node && other.contains?.(node)));
      const response = outerContent.at(-1);
      text = provider === 'chatgpt'
        ? outerContent.map((node) => node.innerText || '').filter(Boolean).join('\\n\\n')
        : response?.innerText || '';
      // A stopped/stalled stream must not become success just because its text
      // stays unchanged. Both providers expose a Stop control during generation.
      pending = buttons.some((node) => /^stop(?:\\b|$)/i.test(label(node)) || node.getAttribute('data-testid') === 'stop-button' || node.getAttribute('data-test-id') === 'stop-button')
        || select('[data-is-streaming="true"], [data-is-generating="true"]', response?.parentElement || document).length > 0;
      if (response && provider === 'chatgpt') {
        complete = assistantTurn.complete && select('button', assistantTurn.node).some((node) => node.getAttribute('data-testid') === 'copy-turn-action-button' || label(node) === 'Copy response');
      } else if (response) {
        // Gemini's observed completed response has a Copy action; its prompt
        // toolbar says Copy prompt and must never certify an assistant response.
        complete = buttons.some((node) => /^copy(?: response)?$/i.test(label(node)));
      }
    }
    const editor = select('textarea, [contenteditable="true"], [role="textbox"]');
    const signIn = buttons.some(authAction) || select('a').some(authAction);
    if (text.length > 100000) return { url, error: 'The provider response is too long to return. Read the complete translation in the ND browser.' };
    return { url, text, pending, complete, loginRequired: provider !== 'google' && editor.length === 0 && signIn };
  })()`
}
