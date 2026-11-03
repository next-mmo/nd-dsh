import { describe, expect, it } from 'vitest'
import { buildSuperagentProfilePatch, parseSuperagentPanelUrl, toDshPosixPath } from '../src/shared/superagent-prototype.js'

describe('Superagent prototype profile config', () => {
  it('maps Windows drive paths and POSIX paths to the DSH state-directory schema', () => {
    expect(toDshPosixPath('C:\\Users\\me\\AppData\\superagent')).toBe('/Users/me/AppData/superagent')
    expect(toDshPosixPath('/home/me/.dsh/state/superagent')).toBe('/home/me/.dsh/state/superagent')
    expect(toDshPosixPath('/home/me/.dsh/state/superagent/')).toBe('/home/me/.dsh/state/superagent')
    expect(() => toDshPosixPath('relative/state')).toThrow()
  })

  it('writes the panel port, POSIX state directory, and ND model route rows', () => {
    const patch = buildSuperagentProfilePatch({ port: 3082, stateDir: 'D:\\data\\superagent' })
    expect(patch).toContain('port: 3082')
    expect(patch).toContain('stateDir: "/data/superagent"')
    expect(patch).toContain('id: llm-pi-ai')
    expect(patch).toContain('id: agent-default-model')
    expect(patch).toContain('ND_DSH_LLM_PROVIDERS_JSON')
  })

  it('reads only loopback panel URLs from the runtime banner', () => {
    expect(parseSuperagentPanelUrl('dsh web: http://127.0.0.1:3082/?token=abc')).toBe('http://127.0.0.1:3082/?token=abc')
    expect(parseSuperagentPanelUrl('dsh web: http://localhost:3082/?token=abc')).toBe('http://localhost:3082/?token=abc')
    expect(parseSuperagentPanelUrl('dsh web: http://example.com:3082/?token=abc')).toBeUndefined()
    expect(parseSuperagentPanelUrl('no banner here')).toBeUndefined()
  })
})
