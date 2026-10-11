import { describe, expect, it } from 'vitest'
import { withDefaultPreset } from '../src/main/harness/harness-service.js'

describe('withDefaultPreset', () => {
  it('rewrites an existing default row and reports the change', () => {
    const settings = [
      'ui-onboarding:',
      '  welcomeNoticeVersion: 2026-08-13.1',
      'agent-presets:',
      '  default: cordis',
      'ui-theme:',
      '  preference: system',
    ].join('\n')

    const { content, changed } = withDefaultPreset(settings, 'nd-dsh')

    expect(changed).toBe(true)
    expect(content).toContain('agent-presets:\n  default: nd-dsh')
    expect(content).not.toContain('default: cordis')
    expect(content).toContain('ui-theme:')
    expect(content).toContain('welcomeNoticeVersion: 2026-08-13.1')
  })

  it('leaves an already-correct file untouched', () => {
    const settings = 'agent-presets:\n  default: nd-dsh\n'

    const { content, changed } = withDefaultPreset(settings, 'nd-dsh')

    expect(changed).toBe(false)
    expect(content).toBe(settings)
  })

  it('appends the section when it is missing', () => {
    const { content, changed } = withDefaultPreset('ui-theme:\n  preference: system\n', 'nd-dsh')

    expect(changed).toBe(true)
    expect(content).toContain('ui-theme:\n  preference: system')
    expect(content).toContain('agent-presets:\n  default: nd-dsh')
  })

  it('inserts a default row into an existing section without one', () => {
    const settings = 'agent-presets:\n  enabled: true\nother:\n  value: 1\n'

    const { content, changed } = withDefaultPreset(settings, 'nd-dsh')

    expect(changed).toBe(true)
    expect(content).toBe('agent-presets:\n  default: nd-dsh\n  enabled: true\nother:\n  value: 1\n')
  })

  it('handles CRLF line endings', () => {
    const settings = 'agent-presets:\r\n  default: cordis\r\n'

    const { content, changed } = withDefaultPreset(settings, 'nd-dsh')

    expect(changed).toBe(true)
    expect(content).toBe('agent-presets:\r\n  default: nd-dsh\r\n')
  })

  it('accepts an empty file', () => {
    const { content, changed } = withDefaultPreset('', 'nd-dsh')

    expect(changed).toBe(true)
    expect(content).toBe('agent-presets:\n  default: nd-dsh\n')
  })
})
