import { describe, expect, it } from 'vitest'
import { codexChatGptModelMismatch, isCodexChatGptModelMismatch, normalizeCodexFailure } from '../src/shared/codex-errors.js'

const RAW_MISMATCH = 'Codex app-server request failed: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}}'

describe('Codex failure normalization', () => {
  it('extracts the model from the upstream ChatGPT-account rejection', () => {
    expect(codexChatGptModelMismatch(RAW_MISMATCH)).toEqual({ model: 'gpt-6.1-sol' })
    expect(isCodexChatGptModelMismatch(RAW_MISMATCH)).toBe(true)
  })

  it('replaces the raw envelope with a model-switch instruction', () => {
    const message = normalizeCodexFailure(RAW_MISMATCH)
    expect(message).toContain('Codex model “gpt-6.1-sol” is not available with a ChatGPT account.')
    expect(message).toContain('Choose a supported Codex model')
    expect(message).not.toContain('invalid_request_error')
    expect(isCodexChatGptModelMismatch(message)).toBe(true)
  })

  it('leaves unrelated failures untouched', () => {
    expect(normalizeCodexFailure('unauthorized')).toBe('unauthorized')
  })
})
