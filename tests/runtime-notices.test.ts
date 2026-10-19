import { describe, expect, it } from 'vitest'
import { describeAgentError, ipcFailureMessage } from '../src/renderer/src/lib/runtime-notices.js'

describe('runtime failure notices', () => {
  it('keeps an unknown message verbatim', () => {
    const text = 'Something entirely unexpected happened'
    expect(describeAgentError(text, null)).toBe(text)
  })

  it('names the failing route and explains bare upstream envelopes', () => {
    const described = describeAgentError('Provider returned error', { provider: 'openrouter', model: 'stealth/ox-alpha' })
    expect(described.startsWith('Provider returned error')).toBe(true)
    expect(described).toContain('Failing route: openrouter / stealth/ox-alpha')
    expect(described).toContain('model provider’s servers')
    expect(described).toContain('not from ND tools')
  })

  it('classifies credential rejections with a settings pointer', () => {
    const described = describeAgentError('Invalid API key for openrouter', null)
    expect(described).toContain('rejected authentication')
    expect(described).toContain('Model settings')
  })

  it('classifies quota exhaustion as an account limit', () => {
    const described = describeAgentError('Request failed: insufficient_quota', null)
    expect(described).toContain('quota or billing limit')
  })

  it('classifies context overflow without upstream wording', () => {
    const described = describeAgentError('This model’s maximum context length is 65536 tokens', null)
    expect(described).toContain('context window')
  })

  it('classifies transport failures as connectivity problems', () => {
    const described = describeAgentError('TypeError: fetch failed', { provider: 'omniroute', model: 'local' })
    expect(described).toContain('could not reach the model server')
    expect(described).toContain('Failing route: omniroute / local')
  })

  it('explains Codex account/model mismatches without recommending re-login', () => {
    const described = describeAgentError(
      'Codex app-server request failed: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}}',
      null,
    )
    expect(described).toContain('not a sign-in failure')
    expect(described).toContain('will repeat it')
    expect(described).toContain('Native model')
    expect(described).toContain('supported Codex model')
    expect(described).toContain('does not serve')
    expect(described).toContain('overrides it for this chat')
  })

  it('strips Electron IPC wrappers from user-facing notifications', () => {
    expect(ipcFailureMessage("Error invoking remote method 'harness:run': Error: Codex model “gpt-6.1-sol” is unavailable"))
      .toBe('Codex model “gpt-6.1-sol” is unavailable')
    expect(ipcFailureMessage('plain failure')).toBe('plain failure')
  })
})
