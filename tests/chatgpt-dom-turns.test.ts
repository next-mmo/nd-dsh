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

  it('reads signed-out guest turns marked with data-message-role', () => {
    const makeTurn = (role: 'user' | 'assistant', text: string, complete: boolean) => ({
      innerText: text,
      childNodes: [],
      getAttribute: (name: string) => (name === 'data-message-role' ? role : null),
      hasAttribute: (name: string) => (name === 'data-message-complete' ? complete : false),
      querySelector: () => null,
      contains: () => false,
    })
    const user = makeTurn('user', 'You said:\n\nhi', false)
    const assistant = makeTurn('assistant', 'ChatGPT said:\n\nHello!', true)
    const document = {
      querySelectorAll: (selector: string) => (selector.startsWith('[data-testid^="conversation-turn-"]') ? [user, assistant] : []),
    }
    const result = runInNewContext(`(() => {
      ${CHATGPT_DOM_TURNS_SCRIPT}
      return readChatGptDomTurns({ legacyFallback: false }).map(({ role, complete, text }) => ({ role, complete, text }));
    })()`, { document })
    expect(result).toEqual([
      { role: 'user', complete: false, text: 'You said:\n\nhi' },
      { role: 'assistant', complete: true, text: 'ChatGPT said:\n\nHello!' },
    ])
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

  it('serializes generated image galleries (blob to data URL), code blocks, and strips citation favicons and hidden workspaces', () => {
    const blobImg = {
      nodeType: 1,
      tagName: 'IMG',
      src: 'blob:https://chatgpt.com/5817ff61-7876-4928-bd8a-057c7029832b',
      alt: 'Generated image 1',
      complete: true,
      naturalWidth: 64,
      naturalHeight: 64,
      childNodes: [],
      getAttribute: (k: string) => (k === 'alt' ? 'Generated image 1' : null),
      closest: () => null,
    }
    const previewButton = {
      nodeType: 1,
      tagName: 'BUTTON',
      childNodes: [blobImg],
      querySelector: (sel: string) => (sel === 'img' ? blobImg : null),
      getAttribute: () => null,
    }
    const editButton = {
      nodeType: 1,
      tagName: 'BUTTON',
      textContent: 'Edit',
      childNodes: [{ nodeType: 3, nodeValue: 'Edit' }],
      querySelector: () => null,
      getAttribute: () => null,
    }
    const gallery = {
      nodeType: 1,
      tagName: 'DIV',
      childNodes: [previewButton, editButton],
      querySelector: (sel: string) => (sel === 'img' ? blobImg : null),
      getAttribute: (k: string) => (k === 'data-testid' ? 'generated-image-gallery' : null),
    }
    const faviconImg = {
      nodeType: 1,
      tagName: 'IMG',
      src: 'https://t0.gstatic.com/faviconV2?url=https://ai.meta.com',
      alt: '',
      parentElement: { className: 'Favicon-xZwQNw size-3' },
      childNodes: [],
      getAttribute: () => null,
      closest: () => ({}),
    }
    const citationLink = {
      nodeType: 1,
      tagName: 'A',
      href: 'https://ai.meta.com/research',
      childNodes: [
        faviconImg,
        { nodeType: 3, nodeValue: 'Meta AI' },
      ],
      getAttribute: (k: string) => (k === 'href' ? 'https://ai.meta.com/research' : null),
      querySelector: (sel: string) => (sel === 'img' ? faviconImg : null),
    }
    const codeBlock = {
      nodeType: 1,
      tagName: 'DIV',
      childNodes: [],
      getAttribute: (k: string) => (k === 'data-code-block' ? 'true' : null),
      querySelector: (sel: string) => {
        if (sel === '[data-markdown-copy="exclude"]') return { textContent: 'Bash' }
        if (sel === '[data-code-block-source="true"], code, pre') return { textContent: 'git pull --ff-only\n' }
        return null
      },
    }
    const srHeading = {
      nodeType: 1,
      tagName: 'H4',
      className: 'sr-only',
      textContent: 'ChatGPT said:',
      hasAttribute: (k: string) => k === 'data-conversation-role',
      getAttribute: (k: string) => (k === 'class' ? 'sr-only' : null),
      childNodes: [{ nodeType: 3, nodeValue: 'ChatGPT said:' }],
    }
    const visibleTurn = {
      nodeType: 1,
      tagName: 'DIV',
      childNodes: [srHeading, gallery, citationLink, codeBlock],
      getAttribute: (k: string) => (k === 'data-turn' ? 'assistant' : null),
      querySelector: (sel: string) => (sel === 'button[aria-label="Copy image"]' ? {} : null),
      querySelectorAll: (sel: string) => (sel.includes('generated-image-gallery') ? [gallery] : []),
      contains: () => false,
    }
    const hiddenWorkspace = {
      nodeType: 1,
      tagName: 'DIV',
      hidden: false,
      style: { display: 'none', visibility: 'visible' },
      getAttribute: () => null,
      parentElement: null,
    }
    const hiddenTurn = {
      nodeType: 1,
      tagName: 'DIV',
      parentElement: hiddenWorkspace,
      style: { display: 'block', visibility: 'visible' },
      childNodes: [{ nodeType: 3, nodeValue: 'Stale turn from hidden workspace' }],
      getAttribute: (k: string) => (k === 'data-turn' ? 'assistant' : null),
      querySelector: () => ({}),
      contains: () => false,
    }
    const document = {
      querySelectorAll: (sel: string) => (sel.startsWith('[data-testid^="conversation-turn-"]') ? [hiddenTurn, visibleTurn] : []),
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return {
            width: 0,
            height: 0,
            getContext: () => ({ drawImage: () => {} }),
            toDataURL: () => 'data:image/png;base64,chatGptPosterPng',
          }
        }
        return {}
      },
    }
    const window = {
      getComputedStyle: (el: { style?: { display?: string; visibility?: string } }) => ({
        display: el.style?.display ?? 'block',
        visibility: el.style?.visibility ?? 'visible',
      }),
    }
    const result = runInNewContext(`(() => {
      ${CHATGPT_DOM_TURNS_SCRIPT}
      return readChatGptDomTurns({ legacyFallback: true }).map(({ role, complete, imagesPending, text }) => ({ role, complete, imagesPending, text }));
    })()`, { document, window })

    expect(result).toEqual([
      {
        role: 'assistant',
        complete: true,
        imagesPending: false,
        text: '![Generated image 1](data:image/png;base64,chatGptPosterPng)\n\n[Meta AI](https://ai.meta.com/research)\n\n```bash\ngit pull --ff-only\n```',
      },
    ])
  })
})

