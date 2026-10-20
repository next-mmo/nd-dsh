import { describe, expect, it, vi } from 'vitest'
import {
  BrowserAgentRunner,
  findCloseAttachmentElements,
  findComposerElement,
  findNewChatElement,
  findSendButtonElement,
  parseSemanticSnapshot,
  type BrowserAgentPort,
  type SemanticSnapshot,
} from '../src/main/browser/browser-agent.js'

describe('BrowserAgent semantic heuristics', () => {
  it('finds composer prioritizing contenteditable and prompt labels', () => {
    const snapshot: SemanticSnapshot = {
      revision: 1,
      url: 'https://gemini.google.com/app',
      elements: [
        { ref: '@e1', tag: 'input', type: 'text', name: 'Search chats' },
        { ref: '@e2', tag: 'div', editable: true, name: 'Ask Gemini', role: 'textbox' },
        { ref: '@e3', tag: 'input', type: 'password', sensitive: true },
      ],
    }
    const composer = findComposerElement(snapshot)
    expect(composer?.ref).toBe('@e2')
  })

  it('finds send button and ignores cancel/voice/disabled buttons', () => {
    const snapshot: SemanticSnapshot = {
      revision: 1,
      url: 'https://gemini.google.com/app',
      elements: [
        { ref: '@e1', role: 'button', name: 'Use microphone' },
        { ref: '@e2', role: 'button', name: 'Cancel send' },
        { ref: '@e3', role: 'button', name: 'Send prompt', disabled: false },
      ],
    }
    const send = findSendButtonElement(snapshot)
    expect(send?.ref).toBe('@e3')
  })

  it('finds stale close attachment buttons', () => {
    const snapshot: SemanticSnapshot = {
      revision: 1,
      url: 'https://gemini.google.com/app',
      elements: [
        { ref: '@e1', role: 'button', name: 'Close attachment' },
        { ref: '@e2', role: 'button', name: 'remove attachment' },
        { ref: '@e3', role: 'button', name: 'Submit' },
      ],
    }
    const buttons = findCloseAttachmentElements(snapshot)
    expect(buttons.map((b) => b.ref)).toEqual(['@e1', '@e2'])
  })

  it('finds new chat button', () => {
    const snapshot: SemanticSnapshot = {
      revision: 1,
      url: 'https://gemini.google.com/app',
      elements: [
        { ref: '@e1', role: 'button', name: 'Start a new chat' },
      ],
    }
    expect(findNewChatElement(snapshot)?.ref).toBe('@e1')
  })
})

describe('BrowserAgentRunner Observe-Act-Verify loop', () => {
  it('executes a step with observe, act, and verify', async () => {
    let revision = 1
    const snapshot: SemanticSnapshot = {
      revision,
      url: 'https://gemini.google.com/app',
      elements: [
        { ref: '@e1', role: 'button', name: 'Send' },
      ],
    }
    const port: BrowserAgentPort = {
      semanticSnapshot: vi.fn(async () => ({ ...snapshot, revision: revision++ })),
      click: vi.fn(async () => ({ ok: true })),
      fill: vi.fn(async () => ({ ok: true })),
      press: vi.fn(async () => ({ ok: true })),
      scroll: vi.fn(async () => ({ ok: true })),
    }

    const runner = new BrowserAgentRunner({
      port,
      tabId: 'tab-1',
      allowedOrigins: ['https://gemini.google.com'],
    })

    const receipt = await runner.runStep({
      name: 'click-send',
      plan: (obs) => ({ kind: 'click', ref: obs.snapshot.elements[0]!.ref }),
      verify: (after, before) => after.revision > before.revision,
    })

    expect(receipt.step).toBe('click-send')
    expect(receipt.action).toEqual({ kind: 'click', ref: '@e1' })
    expect(port.click).toHaveBeenCalledWith('tab-1', '@e1', 1)
  })

  it('re-observes on STALE_BROWSER_REFERENCE and succeeds', async () => {
    let callCount = 0
    let revision = 1
    const port: BrowserAgentPort = {
      semanticSnapshot: vi.fn(async () => ({
        revision: revision++,
        url: 'https://gemini.google.com/app',
        elements: [{ ref: `@e${revision}`, role: 'button', name: 'Send' }],
      })),
      click: vi.fn(async () => {
        callCount++
        if (callCount === 1) {
          const err = new Error('Page changed after the snapshot; take a fresh snapshot before acting')
          ;(err as Error & { code?: string }).code = 'STALE_BROWSER_REFERENCE'
          throw err
        }
        return { ok: true }
      }),
      fill: vi.fn(async () => ({ ok: true })),
      press: vi.fn(async () => ({ ok: true })),
      scroll: vi.fn(async () => ({ ok: true })),
    }

    const runner = new BrowserAgentRunner({
      port,
      tabId: 'tab-1',
      allowedOrigins: ['https://gemini.google.com'],
    })

    const receipt = await runner.runStep({
      name: 'click-send-retry',
      pollMs: 25,
      plan: (obs) => ({ kind: 'click', ref: obs.snapshot.elements[0]!.ref }),
    })

    expect(receipt.attempts).toBe(2)
    expect(port.click).toHaveBeenCalledTimes(2)
  })

  it('captures visual recovery screenshot when step fails after multiple attempts', async () => {
    const port: BrowserAgentPort = {
      semanticSnapshot: vi.fn(async () => ({
        revision: 1,
        url: 'https://gemini.google.com/app',
        elements: [],
      })),
      click: vi.fn(async () => ({ ok: true })),
      fill: vi.fn(async () => ({ ok: true })),
      press: vi.fn(async () => ({ ok: true })),
      scroll: vi.fn(async () => ({ ok: true })),
      screenshot: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,fake-screenshot' })),
    }

    const runner = new BrowserAgentRunner({
      port,
      tabId: 'tab-1',
      allowedOrigins: ['https://gemini.google.com'],
      visualRecovery: true,
    })

    const run = runner.runStep({
      name: 'find-hidden-element',
      maxAttempts: 2,
      pollMs: 25,
      plan: () => null,
    })

    await expect(run).rejects.toThrow(/could not complete step "find-hidden-element"/)
    await run.catch((err) => {
      expect(err.recoveryScreenshot).toBe('data:image/png;base64,fake-screenshot')
    })
  })

  it('rejects navigation outside allowedOrigins', async () => {
    const port: BrowserAgentPort = {
      semanticSnapshot: vi.fn(async () => ({
        revision: 1,
        url: 'https://evil.attacker.com/steal',
        elements: [],
      })),
      click: vi.fn(async () => ({ ok: true })),
      fill: vi.fn(async () => ({ ok: true })),
      press: vi.fn(async () => ({ ok: true })),
      scroll: vi.fn(async () => ({ ok: true })),
    }

    const runner = new BrowserAgentRunner({
      port,
      tabId: 'tab-1',
      allowedOrigins: ['https://gemini.google.com'],
    })

    await expect(runner.observe()).rejects.toThrow(/left the expected site/)
  })
})
