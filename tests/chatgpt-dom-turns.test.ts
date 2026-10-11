import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { CHATGPT_DOM_TURNS_SCRIPT } from '../src/main/browser/chatgpt-dom-turns.js'

describe('ChatGPT turn compatibility after integration with main', () => {
  it('retains accessible-heading fallback for the web engine without enabling it for translation', () => {
    const heading = { textContent: 'ChatGPT said:', parentElement: null as unknown }
    const turn = {
      innerText: 'ChatGPT said:\nThe response', parentElement: null,
      contains: (node: unknown) => node === heading,
      getAttribute: () => null,
      querySelector: (selector: string) => selector === 'button[aria-label="Copy"]' ? {} : null,
    }
    heading.parentElement = turn
    const document = { querySelectorAll: (selector: string) => selector.startsWith('main h1') ? [heading] : [] }
    const read = (legacyFallback: boolean) => runInNewContext(`(() => {
      ${CHATGPT_DOM_TURNS_SCRIPT}
      return readChatGptDomTurns({ legacyFallback }).map(({ role, complete, root }) => ({ role, complete, text: root.innerText }));
    })()`, { document, legacyFallback })
    expect(read(true)).toEqual([{ role: 'assistant', complete: true, text: 'ChatGPT said:\nThe response' }])
    expect(read(false)).toEqual([])
  })

  it('keeps transcript completion markers required even with generic Copy controls', () => {
    const turn = {
      getAttribute: (name: string) => name === 'data-message-role' ? 'assistant' : null,
      hasAttribute: () => false,
      querySelector: (selector: string) => selector === 'button[aria-label="Copy"]' ? {} : null,
    }
    const document = { querySelectorAll: () => [turn] }
    const result = runInNewContext(`(() => {
      ${CHATGPT_DOM_TURNS_SCRIPT}
      return readChatGptDomTurns({ legacyFallback: true }).map(({ role, complete }) => ({ role, complete }));
    })()`, { document })
    expect(result).toEqual([{ role: 'assistant', complete: false }])
  })
})
