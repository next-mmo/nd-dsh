import { describe, expect, it } from 'vitest'
import { annotatePresetRoster, blockPresetSelection, PRESET_BLOCK_REASON } from '../src/main/harness/harness-service.js'

describe('blockPresetSelection', () => {
  it('blocks a new session on the cordis preset', () => {
    const result = blockPresetSelection('session.create', { agentPreset: 'cordis' })

    expect(result).toEqual({ ok: false, error: { code: 'agent-preset/blocked', message: PRESET_BLOCK_REASON } })
  })

  it('allows new sessions on other presets', () => {
    expect(blockPresetSelection('session.create', { agentPreset: 'nd-dsh' })).toBeUndefined()
    expect(blockPresetSelection('session.create', { agentPreset: 'code' })).toBeUndefined()
  })

  it('allows sessions that name no preset (runtime default)', () => {
    expect(blockPresetSelection('session.create', {})).toBeUndefined()
    expect(blockPresetSelection('session.create', { cwd: 'C:/work' })).toBeUndefined()
  })

  it('blocks making cordis the default preset', () => {
    const result = blockPresetSelection('settings.update', { ns: 'agent-presets', patch: { default: 'cordis' } })

    expect(result).toEqual({ ok: false, error: { code: 'agent-preset/blocked', message: PRESET_BLOCK_REASON } })
  })

  it('allows other preset defaults and unrelated settings namespaces', () => {
    expect(blockPresetSelection('settings.update', { ns: 'agent-presets', patch: { default: 'code' } })).toBeUndefined()
    expect(blockPresetSelection('settings.update', { ns: 'ui-theme', patch: { preference: 'dark' } })).toBeUndefined()
  })

  it('allows unrelated gateway methods', () => {
    expect(blockPresetSelection('session.list', {})).toBeUndefined()
    expect(blockPresetSelection('session.history', { sessionId: 's-1' })).toBeUndefined()
  })
})

describe('annotatePresetRoster', () => {
  it('marks the cordis row blocked and leaves other rows untouched', () => {
    const result = annotatePresetRoster({
      ok: true,
      value: {
        presets: [
          { id: 'nd-dsh', isDefault: true },
          { id: 'cordis', isDefault: false },
        ],
      },
    })

    expect(result).toEqual({
      ok: true,
      value: {
        presets: [
          { id: 'nd-dsh', isDefault: true },
          { id: 'cordis', isDefault: false, blocked: true, blockedReason: PRESET_BLOCK_REASON },
        ],
      },
    })
  })

  it('passes through failed or malformed results unchanged', () => {
    const failed = { ok: false, error: { code: 'boom', message: 'no' } }
    expect(annotatePresetRoster(failed)).toBe(failed)
    expect(annotatePresetRoster({ ok: true, value: { presets: 'nope' } })).toEqual({ ok: true, value: { presets: 'nope' } })
  })

  it('returns the same result reference when no row is blocked', () => {
    const result = { ok: true, value: { presets: [{ id: 'nd-dsh' }] } }
    expect(annotatePresetRoster(result)).toBe(result)
  })
})
