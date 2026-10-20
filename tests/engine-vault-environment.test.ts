import { afterEach, describe, expect, it } from 'vitest'
import { engineEnvironment, setEngineVaultEnvironmentProvider } from '../src/main/engines/agent-cli/agent-cli-support.js'

describe('engine environment vault provider', () => {
  afterEach(() => {
    setEngineVaultEnvironmentProvider(undefined)
  })

  it('merges the vault URL, token, and shim PATH without process.env mutation', () => {
    const previous = process.env.ND_DSH_VAULT_TOKEN
    setEngineVaultEnvironmentProvider(() => ({
      ND_DSH_VAULT_URL: 'http://127.0.0.1:4321',
      ND_DSH_VAULT_TOKEN: 'test-token',
      ND_DSH_VAULT_CLI: '/nd/scripts/nd-vault-cli.mjs',
      ND_DSH_VAULT_BIN: '/nd/bin',
      PATH: `/nd/bin${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
    }))
    const environment = engineEnvironment()
    expect(environment.ND_DSH_VAULT_URL).toBe('http://127.0.0.1:4321')
    expect(environment.ND_DSH_VAULT_TOKEN).toBe('test-token')
    expect(environment.ND_DSH_VAULT_CLI).toBe('/nd/scripts/nd-vault-cli.mjs')
    expect(environment.ND_DSH_VAULT_BIN).toBe('/nd/bin')
    expect(environment.PATH).toContain('/nd/bin')
    expect(process.env.ND_DSH_VAULT_TOKEN).toBe(previous)
  })

  it('keeps stripping ND control-plane variables from the inherited environment', () => {
    process.env.ND_DSH_TEST_CONTROL = '1'
    try {
      const environment = engineEnvironment()
      expect(environment.ND_DSH_TEST_CONTROL).toBeUndefined()
    } finally {
      delete process.env.ND_DSH_TEST_CONTROL
    }
  })
})
