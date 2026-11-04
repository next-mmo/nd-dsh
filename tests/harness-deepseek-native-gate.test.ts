import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('DeepSeek native account gate', () => {
  it('keeps the whole native account stack behind the ND switch in the runtime overlay', async () => {
    const patch = (await readFile('configs/dsh/nd-dsh.patch.yml', 'utf8')).replace(/\r\n/g, '\n')
    for (const row of ['llm-deepseek-account', 'ui-settings-account', 'account-controller']) {
      const match = new RegExp(`- id: ${row}\\n\\s+disabled: (.+)\\n`).exec(patch)
      expect(match, `patch row ${row}`).not.toBeNull()
      expect(match?.[1]).toContain("process.env.ND_DSH_DEEPSEEK_NATIVE_ACCOUNT !== '1'")
    }
  })

  it('keeps the superagent prototype patch native-account free', async () => {
    const { buildSuperagentProfilePatch } = await import('../src/shared/superagent-prototype.js')
    const patch = buildSuperagentProfilePatch({ port: 1234, stateDir: 'C:\\state' })
    for (const row of ['llm-deepseek-account', 'ui-settings-account', 'account-controller']) {
      expect(patch).toContain(`- id: ${row}\n  disabled: true`)
    }
  })
})
