import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { translatePageReadScript } from '../src/main/browser/translate-page-reader.js'
import type { NdTranslatePage } from '../src/shared/nd-translate.js'

function readGemini({ text = 'Hola mundo!', copy = true, stop = false, streaming = false, responsePresent = true, boxlessResponse = false, renderedChild = true } = {}): NdTranslatePage {
  const node = (label: string) => ({
    innerText: label,
    getAttribute: (attribute: string) => attribute === 'aria-label' ? label : null,
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
  })
  const buttons = [node('Copy prompt'), ...(copy ? [node('Copy')] : []), ...(stop ? [node('Stop response')] : [])]
  const response = { ...node(text),
    getBoundingClientRect: () => ({ width: boxlessResponse ? 0 : 20, height: boxlessResponse ? 0 : 20 }),
    children: boxlessResponse && renderedChild ? [node(text)] : [],
    parentElement: { querySelectorAll: () => streaming ? [node('Streaming')] : [] } }
  // The fixture records the actual output ancestor chain from the live signed-out
  // provider: MODEL-RESPONSE-CONTENT > ...MODEL-RESPONSE-TEXT > MESSAGE-CONTENT > .markdown.
  const document = {
    title: 'Traducción de Inglés a Español - Google Gemini',
    body: { innerText: `Hello world\n${text}\nCopy prompt` },
    querySelector: () => null,
    querySelectorAll: (selector: string) => {
      if (selector === 'button') return buttons
      if (selector === 'model-response-content message-content .markdown, .model-response-text message-content .markdown') return responsePresent ? [response] : []
      if (selector.includes('textarea')) return [node('Composer')]
      return []
    },
  }
  return runInNewContext(translatePageReadScript('gemini'), {
    location: new URL('https://gemini.google.com/app/observed-response'), document,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  }) as NdTranslatePage
}

function readChatGptAuth({ dialogVisible = true, credentialField = true, authControls = true } = {}): NdTranslatePage {
  const node = (label: string, visible = true) => ({
    innerText: label,
    getAttribute: (attribute: string) => attribute === 'aria-label' ? label : null,
    getBoundingClientRect: () => ({ width: visible ? 20 : 0, height: visible ? 20 : 0 }),
  })
  const dialog = {
    ...node('Authentication', dialogVisible),
    querySelectorAll: (selector: string) => {
      if (selector === 'button, a, [role="button"]') return authControls ? [node('Continue with phone'), node('Log in'), node('Close')] : [node('Close')]
      if (selector.startsWith('input[')) return credentialField ? [node('Phone number')] : []
      return []
    },
  }
  const document = {
    title: 'ChatGPT',
    body: { innerText: 'Translate: Log in. Continue with phone. Thinking...' },
    querySelector: () => null,
    querySelectorAll: (selector: string) => {
      if (selector === 'dialog, [role="dialog"], [aria-modal="true"]') return [dialog]
      if (selector.includes('textarea')) return [node('Existing background composer')]
      return []
    },
  }
  return runInNewContext(translatePageReadScript('chatgpt'), {
    location: new URL('https://chatgpt.com/'), document,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  }) as NdTranslatePage
}

function readChatGptTurn({ role = 'assistant', copy = true, stop = false, boxless = false, renderedChild = true, ownedRole = '', text = 'Hola mundo!', rootIsContent = false, nestedProse = false, siblingContent = false } = {}): NdTranslatePage {
  const node = (value: string, attributes: Record<string, string> = {}) => ({
    innerText: value, children: [] as unknown[],
    getAttribute: (attribute: string) => attributes[attribute] ?? null,
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
  })
  const copyButton = node('Copy', { 'data-testid': 'copy-turn-action-button' })
  const response = { ...node(text),
    getBoundingClientRect: () => ({ width: boxless ? 0 : 20, height: boxless ? 0 : 20 }),
    children: boxless && renderedChild ? [node(text)] : [],
    parentElement: { querySelectorAll: () => [] },
    contains: (candidate: unknown) => nestedProse && candidate === nested,
  }
  const nested = node('Last paragraph only')
  const sibling = node('Second response block')
  const content = {
    ...node(rootIsContent ? text : 'Thinking\n' + text + '\nLog in\nCreate account', ownedRole ? { 'data-message-author-role': ownedRole } : {}),
    matches: () => rootIsContent,
    contains: (candidate: unknown) => rootIsContent && candidate === nested,
    querySelectorAll: (selector: string) => selector === '.markdown, [data-message-content], [class~="prose"], [data-assistant-markdown]' ? rootIsContent ? nestedProse ? [nested] : [] : [response, ...(nestedProse ? [nested] : []), ...(siblingContent ? [sibling] : [])] : [],
  }
  const turn = {
    ...content,
    getAttribute: (attribute: string) => attribute === 'data-turn' ? role : null,
    querySelector: (selector: string) => selector === '[data-message-author-role], [data-message-role]' ? ownedRole ? content : null : selector === 'button[data-testid="copy-turn-action-button"], button[aria-label="Copy response"]' && copy ? copyButton : null,
    querySelectorAll: (selector: string) => selector === 'button' ? copy ? [copyButton] : [] : content.querySelectorAll(selector),
  }
  const document = {
    title: 'ChatGPT', querySelector: () => null,
    querySelectorAll: (selector: string) => {
      if (selector === '[data-testid^="conversation-turn-"], [data-conversation-transcript] [data-message-role]') return [turn]
      if (selector === 'button') return stop ? [node('Stop generating', { 'data-testid': 'stop-button' })] : []
      if (selector.includes('textarea')) return [node('Composer')]
      return []
    },
  }
  return runInNewContext(translatePageReadScript('chatgpt'), {
    location: new URL('https://chatgpt.com/c/observed'), document,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  }) as NdTranslatePage
}

/** Observed live transcript variant: OL > LI[data-message-role] > DIV[data-assistant-markdown] > P. */
function readChatGptTranscript({ role = 'assistant', markedComplete = true, copy = true, stop = false, nestedLegacyTurn = false } = {}): NdTranslatePage {
  const node = (text: string, attrs: Record<string, string> = {}) => ({
    innerText: text, children: [] as unknown[],
    getAttribute: (name: string) => attrs[name] ?? null,
    hasAttribute: (name: string) => name in attrs,
    getBoundingClientRect: () => ({ width: 44, height: 44 }),
  })
  const copyButton = node('Copy response', { 'aria-label': 'Copy response' })
  const paragraph = node('Hola mundo!')
  const response = {
    ...node('Hola mundo!\nSegunda línea.', { 'data-assistant-markdown': '' }),
    children: [paragraph], parentElement: { querySelectorAll: () => [] },
  }
  const turn = {
    ...node('Thinking\nHola mundo!\nSegunda línea.\nCopy response', { 'data-message-role': role, ...(markedComplete ? { 'data-message-complete': '' } : {}) }),
    querySelector: (selector: string) => selector.includes('button[') && copy ? copyButton : null,
    querySelectorAll: (selector: string) => selector === 'button' ? copy ? [copyButton] : [] : selector.includes('[data-assistant-markdown]') ? [response] : [],
  }
  const wrapper = { ...turn,
    getAttribute: (name: string) => name === 'data-turn' ? role : null,
    contains: (candidate: unknown) => candidate === turn,
    querySelector: (selector: string) => selector === '[data-message-author-role], [data-message-role]' ? turn : turn.querySelector(selector),
  }
  const document = { title: 'ChatGPT', querySelector: () => null,
    querySelectorAll: (selector: string) => {
      if (selector === '[data-testid^="conversation-turn-"], [data-conversation-transcript] [data-message-role]') return nestedLegacyTurn ? [wrapper, turn] : [turn]
      if (selector === 'button') return stop ? [node('Stop generating')] : []
      if (selector.includes('textarea')) return [node('Composer')]
      return []
    },
  }
  return runInNewContext(translatePageReadScript('chatgpt'), {
    location: new URL('https://chatgpt.com/c/observed-transcript'), document,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  }) as NdTranslatePage
}

describe('provider-specific translation DOM reader', () => {
  it('reads the observed transcript assistant role/markdown/completion variant with all blocks', () => {
    expect(readChatGptTranscript()).toMatchObject({ text: 'Hola mundo!\nSegunda línea.', complete: true, pending: false })
  })

  it('excludes transcript user turns and requires both marker and scoped Copy response', () => {
    expect(readChatGptTranscript({ role: 'user' })).toMatchObject({ text: '', complete: false })
    expect(readChatGptTranscript({ markedComplete: false })).toMatchObject({ complete: false })
    expect(readChatGptTranscript({ copy: false })).toMatchObject({ complete: false })
    expect(readChatGptTranscript({ stop: true })).toMatchObject({ pending: true })
  })

  it('deduplicates transcript nodes inside legacy turns without weakening completion markers', () => {
    expect(readChatGptTranscript({ nestedLegacyTurn: true })).toMatchObject({ text: 'Hola mundo!\nSegunda línea.', complete: true })
    expect(readChatGptTranscript({ nestedLegacyTurn: true, markedComplete: false })).toMatchObject({ complete: false })
  })
  it('uses GPT Web declared assistant turns without requiring a nested author-role node', () => {
    expect(readChatGptTurn()).toMatchObject({ text: 'Hola mundo!', complete: true, pending: false })
  })

  it('extracts only assistant content, excluding Thinking, upsells and controls', () => {
    expect(readChatGptTurn({ ownedRole: 'assistant' }).text).toBe('Hola mundo!')
  })

  it('reads a content-marked assistant root itself even without a nested markdown node', () => {
    expect(readChatGptTurn({ ownedRole: 'assistant', rootIsContent: true })).toMatchObject({ text: 'Hola mundo!', complete: true })
  })

  it('preserves full multi-paragraph output when nested prose also matches', () => {
    expect(readChatGptTurn({ text: 'First paragraph\nLast paragraph only', nestedProse: true }).text).toBe('First paragraph\nLast paragraph only')
    expect(readChatGptTurn({ ownedRole: 'assistant', rootIsContent: true, text: 'First paragraph\nLast paragraph only', nestedProse: true }).text).toBe('First paragraph\nLast paragraph only')
  })

  it('retains sibling content blocks without duplicating nested matches', () => {
    expect(readChatGptTurn({ nestedProse: true, siblingContent: true }).text).toBe('Hola mundo!\n\nSecond response block')
  })

  it('never accepts a user turn even with a misleading nested assistant author role', () => {
    expect(readChatGptTurn({ role: 'user', ownedRole: 'assistant' })).toMatchObject({ text: '', complete: false })
  })

  it('requires the latest assistant Copy completion action and no ongoing stream', () => {
    expect(readChatGptTurn({ copy: false })).toMatchObject({ text: 'Hola mundo!', complete: false })
    expect(readChatGptTurn({ stop: true })).toMatchObject({ pending: true })
  })

  it('preserves boxless GPT Web assistant content only when its children are rendered', () => {
    expect(readChatGptTurn({ boxless: true })).toMatchObject({ text: 'Hola mundo!', complete: true })
    expect(readChatGptTurn({ boxless: true, renderedChild: false })).toMatchObject({ text: '', complete: false })
  })
  it('reads the observed Gemini response chain and completed Copy action', () => {
    expect(readGemini()).toMatchObject({ text: 'Hola mundo!', complete: true, pending: false })
  })

  it('reads rendered assistant paragraphs when their response wrapper has no layout box', () => {
    expect(readGemini({ boxlessResponse: true })).toMatchObject({ text: 'Hola mundo!', complete: true })
    expect(readGemini({ boxlessResponse: true, renderedChild: false })).toMatchObject({ text: '', complete: false })
  })

  it('never extracts a prompt or body text when the provider response is absent', () => {
    expect(readGemini({ responsePresent: false })).toMatchObject({ text: '', complete: false })
  })

  it('does not treat Copy prompt as a completed assistant response', () => {
    expect(readGemini({ copy: false })).toMatchObject({ text: 'Hola mundo!', complete: false })
  })

  it('marks stable partial text pending while the actual Stop response control is visible', () => {
    expect(readGemini({ copy: false, stop: true })).toMatchObject({ text: 'Hola mundo!', pending: true, complete: false })
  })

  it('marks an explicitly streaming response pending even if a Copy action is present', () => {
    expect(readGemini({ streaming: true })).toMatchObject({ pending: true })
  })

  it('preserves long output and does not infer a challenge from translation words', () => {
    const text = 'Please verify you are human '.repeat(1_000)
    expect(readGemini({ text })).toMatchObject({ text, complete: true, loginRequired: false })
    expect(readGemini({ text }).challenge).toBeUndefined()
  })

  it('fails visibly on an oversized provider response instead of returning truncated success', () => {
    const page = readGemini({ text: 'a'.repeat(100_001) })
    expect(page.error).toContain('too long')
    expect(page.text).toBeUndefined()
  })

  it('reports the observed ChatGPT phone authentication modal despite its background composer', () => {
    expect(readChatGptAuth()).toMatchObject({ loginRequired: true })
    expect(readChatGptAuth().text).toBeUndefined()
  })

  it('ignores a hidden authentication dialog and sign-in words inside source text', () => {
    expect(readChatGptAuth({ dialogVisible: false })).toMatchObject({ loginRequired: false })
  })

  it('requires structural authentication controls and a credential field or account heading', () => {
    expect(readChatGptAuth({ authControls: false })).toMatchObject({ loginRequired: false })
    expect(readChatGptAuth({ credentialField: false })).toMatchObject({ loginRequired: false })
  })
})
