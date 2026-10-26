import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROMPT_SHIELD_BLOCKED_PREFIX,
  defaultPromptShieldSettings,
  parsePromptShieldBlockedError,
  type PromptShieldSettings,
} from '../src/shared/prompt-shield.js'
import { applyPromptShield, applyPromptShieldToPayload, normalizePromptText } from '../src/main/prompt-shield/detectors.js'
import { PromptShieldService, promptShieldBlockedError } from '../src/main/prompt-shield/prompt-shield-service.js'

const API_KEY = 'sk-proj-abc123def456ghi789jkl012mno'
const GITHUB_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
const CARD = '4532015112830366'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

function settings(overrides: Partial<PromptShieldSettings> = {}): PromptShieldSettings {
  return { ...defaultPromptShieldSettings(), ...overrides }
}

function service(): { instance: PromptShieldService; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'nd-prompt-shield-'))
  const path = join(root, 'state.json')
  return { instance: new PromptShieldService(path), path }
}

describe('Prompt Shield detectors', () => {
  it('blocks API keys by default and never echoes the value', () => {
    const result = applyPromptShield(`Use this key: ${API_KEY}`, settings())
    expect(result.blocked).toBe(true)
    expect(result.findings).toEqual([{ categoryId: 'api_key', label: 'API keys', action: 'block', count: 1 }])
    expect(result.text).toContain('[ND-REDACTED:api_key]')
    expect(result.text).not.toContain('abc123def456')
  })

  it('detects GitHub tokens and PEM private keys', () => {
    const privateKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    const result = applyPromptShield(`${GITHUB_TOKEN}\n${privateKey}`, settings())
    expect(result.findings.map((finding) => finding.categoryId).sort()).toEqual(['api_key', 'private_key'])
    expect(result.blocked).toBe(true)
  })

  it('leaves documented placeholder values alone', () => {
    const result = applyPromptShield('export const key = "sk-test-placeholder"', settings())
    expect(result.findings).toEqual([])
    expect(result.blocked).toBe(false)
  })

  it('validates credit cards with Luhn and ignores published test numbers', () => {
    const real = applyPromptShield(`charge ${CARD}`, settings())
    expect(real.blocked).toBe(true)
    expect(real.findings[0]?.categoryId).toBe('credit_card')

    const invalid = applyPromptShield('order 4532015112830367', settings())
    expect(invalid.findings).toEqual([])

    const testCard = applyPromptShield('stripe test 4242 4242 4242 4242', settings())
    expect(testCard.findings).toEqual([])

    const timestamp = applyPromptShield('created 1759791300000', settings())
    expect(timestamp.findings).toEqual([])
  })

  it('masks JWTs and bearer tokens by default', () => {
    const result = applyPromptShield(`${JWT}\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz`, settings())
    expect(result.blocked).toBe(false)
    expect(result.findings.map((finding) => finding.categoryId)).toEqual(['jwt', 'bearer_token'])
    expect(result.text).toContain('Bearer [ND-REDACTED:bearer_token]')
    expect(result.text).not.toContain(JWT)
  })

  it('masks assignment values but skips environment references', () => {
    const masked = applyPromptShield('api_key = "Abc123Def456Ghi789"', settings())
    expect(masked.findings[0]?.categoryId).toBe('secret_assignment')
    expect(masked.text).toBe('api_key = "[ND-REDACTED:secret_assignment]"')

    const indirect = applyPromptShield('api_key = process.env.OPENAI_API_KEY', settings())
    expect(indirect.findings).toEqual([])
  })

  it('strips zero-width and bidi characters before detection', () => {
    const hidden = `sk-proj-abc\u200B123def456ghi789jkl012mno`
    expect(normalizePromptText(hidden)).toBe(API_KEY)
    const result = applyPromptShield(hidden, settings())
    expect(result.blocked).toBe(true)
  })

  it('applies custom regular expressions', () => {
    const result = applyPromptShield('employee EMP-123456', settings({
      custom: [{ id: 'custom_emp1234', label: 'Employee ID', pattern: 'EMP-\\d{6}', action: 'mask' }],
    }))
    expect(result.findings).toEqual([{ categoryId: 'custom_emp1234', label: 'Employee ID', action: 'mask', count: 1 }])
    expect(result.text).toBe('employee [ND-REDACTED:Employee ID]')
  })

  it('honours allow policies and one-turn overrides', () => {
    const allowed = applyPromptShield(API_KEY, settings({ actions: { api_key: 'allow' } }))
    expect(allowed.findings).toEqual([])

    const blocked = applyPromptShield(API_KEY, settings())
    expect(blocked.blocked).toBe(true)

    const masked = applyPromptShield(API_KEY, settings(), 'mask')
    expect(masked.blocked).toBe(false)
    expect(masked.masked).toBe(1)

    const bypass = applyPromptShield(API_KEY, settings(), 'allow')
    expect(bypass.text).toBe(API_KEY)
    expect(bypass.findings).toEqual([])
  })

  it('sanitizes OpenAI, Anthropic and Responses payload fields without mutating the input', () => {
    const payload = {
      model: 'test-model',
      instructions: `token ${GITHUB_TOKEN}`,
      messages: [
        { role: 'user', content: `key ${API_KEY}` },
        { role: 'user', content: [{ type: 'text', text: `card ${CARD}` }] },
        { role: 'tool', content: 'Bearer abcdefghijklmnopqrstuvwxyz' },
      ],
      input: [{ type: 'function_call_output', call_id: 'call-1', output: `jwt ${JWT}` }],
    }
    const result = applyPromptShieldToPayload(payload, settings())
    expect(result.blocked).toBe(true)
    expect(result.findings.map((finding) => finding.categoryId).sort()).toEqual([
      'api_key',
      'bearer_token',
      'credit_card',
      'jwt',
    ])

    const sanitized = result.payload as typeof payload
    expect(sanitized.instructions).toContain('[ND-REDACTED:api_key]')
    expect(sanitized.messages[0]?.content).toContain('[ND-REDACTED:api_key]')
    expect((sanitized.messages[1]?.content as Array<{ text: string }>)[0]?.text).toContain('[ND-REDACTED:credit_card]')
    expect(sanitized.input[0]?.output).toContain('[ND-REDACTED:jwt]')

    // The caller's payload is never mutated; a blocked request must not leak.
    expect(payload.messages[0]?.content).toContain(API_KEY)
    expect(payload.instructions).toContain(GITHUB_TOKEN)
  })

  it('leaves tool-call argument strings intact', () => {
    const payload = {
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'run', arguments: `{"token":"${API_KEY}"}` } }],
        },
      ],
    }
    const result = applyPromptShieldToPayload(payload, settings())
    expect(result.findings).toEqual([])
    expect(result.blocked).toBe(false)
  })
})

describe('PromptShieldService', () => {
  it('persists settings and counters, counts detections, and keeps tests side-effect free', () => {
    const { instance, path } = service()
    expect(instance.state().settings.enabled).toBe(true)

    const blocked = instance.apply(`key ${API_KEY}`)
    expect(blocked.blocked).toBe(true)
    let state = instance.state()
    expect(state.counters.prompted).toBe(1)
    expect(state.counters.blocked).toBe(1)
    expect(state.counters.byCategory.api_key).toBe(1)

    const before = state.counters.prompted
    instance.test(`key ${API_KEY}`)
    expect(instance.state().counters.prompted).toBe(before)

    instance.updateSettings({ ...state.settings, actions: { api_key: 'mask' } })
    const masked = instance.apply(`key ${API_KEY}`)
    expect(masked.blocked).toBe(false)
    expect(masked.masked).toBe(1)

    const reloaded = new PromptShieldService(path)
    expect(reloaded.state().settings.actions.api_key).toBe('mask')
    expect(reloaded.state().counters.prompted).toBe(2)
    expect(reloaded.state().counters.masked).toBe(1)
  })

  it('previews saved rules even when the master switch is off', () => {
    const { instance } = service()
    instance.updateSettings({ ...instance.state().settings, enabled: false })
    expect(instance.test(`key ${API_KEY}`).findings).toHaveLength(1)
    expect(instance.apply(`key ${API_KEY}`).findings).toEqual([])
  })

  it('rejects invalid custom expressions and unknown actions', () => {
    const { instance } = service()
    const current = instance.state().settings
    expect(() => instance.updateSettings({
      ...current,
      custom: [{ id: 'custom_bad123', label: 'Bad', pattern: '(', action: 'mask' }],
    })).toThrow(/regular expression/)
    expect(() => instance.updateSettings({
      ...current,
      actions: { api_key: 'sometimes' },
    })).toThrow(/block, mask or allow/)
    expect(() => instance.updateSettings({
      ...current,
      custom: [{ id: 'not a valid id', label: 'Bad', pattern: 'abc', action: 'mask' }],
    })).toThrow(/invalid id/)
  })

  it('rounds a blocked error through the prefix used by the renderer', () => {
    const { instance } = service()
    const result = instance.apply(`key ${API_KEY}`)
    const error = promptShieldBlockedError(instance.blockedPayload(result))
    expect(error.message.startsWith(PROMPT_SHIELD_BLOCKED_PREFIX)).toBe(true)
    const parsed = parsePromptShieldBlockedError(`Error: ${error.message}`)
    expect(parsed?.findings[0]?.categoryId).toBe('api_key')
    expect(parsed?.preview).toContain('[ND-REDACTED:api_key]')
    expect(parsed?.preview).not.toContain('abc123def456')
  })
})
