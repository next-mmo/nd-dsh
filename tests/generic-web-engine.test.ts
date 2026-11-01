import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => tmpdir(),
  },
}))

import { GenericWebEngine } from '../src/main/engines/generic-web/generic-web-engine.js'
import { GENERIC_WEB_CONFIGS } from '../src/main/engines/generic-web/generic-web-configs.js'
import { CodingEngineRegistry } from '../src/main/engines/coding-engine-registry.js'
import {
  ARENA_WEB_ENGINE_ID,
  DUCK_WEB_ENGINE_ID,
  GROK_WEB_ENGINE_ID,
  META_WEB_ENGINE_ID,
  MISTRAL_WEB_ENGINE_ID,
  PERPLEXITY_WEB_ENGINE_ID,
  POE_WEB_ENGINE_ID,
  QWEN_WEB_ENGINE_ID,
  ZAI_WEB_ENGINE_ID,
} from '../src/shared/coding-engines.js'

describe('GenericWebEngine', () => {
  const supportedIds = [
    QWEN_WEB_ENGINE_ID,
    ZAI_WEB_ENGINE_ID,
    MISTRAL_WEB_ENGINE_ID,
    PERPLEXITY_WEB_ENGINE_ID,
    POE_WEB_ENGINE_ID,
    ARENA_WEB_ENGINE_ID,
    META_WEB_ENGINE_ID,
    DUCK_WEB_ENGINE_ID,
  ]

  it('defines all supported generic web configurations with valid properties', () => {
    for (const id of supportedIds) {
      const config = GENERIC_WEB_CONFIGS[id]
      expect(config).toBeDefined()
      if (!config) continue
      expect(config.engineId).toBe(id)
      expect(config.homeUrl).toMatch(/^https:\/\//)
      expect(config.origins.length).toBeGreaterThan(0)
      expect(config.models.length).toBeGreaterThan(0)
      expect(config.models.some((m) => m.id === 'default')).toBe(true)
    }
  })

  it('registers all 8 generic web engines plus Grok Web in CodingEngineRegistry', () => {
    process.env.ND_DSH_MANAGED_RUNTIME_ROOT = tmpdir()
    process.env.ND_DSH_ENGINE_BIN_ROOT = tmpdir()
    const mockStore = {
      all: async () => ({ agents: {}, defaults: {} }),
      resolve: async () => 'nd-harness',
      assign: async () => {},
    } as never
    const registry = new CodingEngineRegistry(mockStore)
    const list = registry.list()
    const engineIds = list.map((e) => e.id)

    expect(engineIds).toContain(GROK_WEB_ENGINE_ID)
    for (const id of supportedIds) {
      expect(engineIds).toContain(id)
      const descriptor = list.find((e) => e.id === id)
      expect(descriptor).toBeDefined()
      expect(descriptor?.available).toBe(true)
      expect(descriptor?.capabilities.browser).toBe(true)
      expect(descriptor?.capabilities.persistentSessions).toBe(true)
    }
  })

  it('manages sessions and mode settings cleanly in memory and storage', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'nd-generic-web-test-'))
    try {
      const storePath = join(tempDir, 'qwen-web-sessions.json')
      const mockBrowser = {
        state: () => ({ tabs: [], cdpPort: 9222 }),
        activeProfileId: () => 'default-profile',
        activeTabId: () => 'tab-1',
        createTab: async () => ({ id: 'tab-1' }),
        closeTab: async () => true,
        tabUrl: () => 'https://chat.qwen.ai/',
      } as never

      const mockWorkspace = {
        state: () => ({ root: tempDir }),
      } as never

      const qwenConfig = GENERIC_WEB_CONFIGS[QWEN_WEB_ENGINE_ID]
      expect(qwenConfig).toBeDefined()
      if (!qwenConfig) throw new Error('Qwen config missing')

      const engine = new GenericWebEngine({
        config: qwenConfig,
        browser: mockBrowser,
        workspace: mockWorkspace,
        storePath,
      })

      const models = await engine.listModels()
      expect(models.length).toBeGreaterThan(1)
      expect(models[0]?.id).toBe('default')

      const session = await engine.createSession({ title: 'Test Qwen Session' })
      expect(session.sessionId).toContain('qwen-web-')
      expect(engine.ownsSession(session.sessionId)).toBe(true)

      const summaries = engine.listSessions()
      expect(summaries.length).toBe(1)
      expect(summaries[0]?.title).toBe('Test Qwen Session')
      expect(summaries[0]?.engineId).toBe(QWEN_WEB_ENGINE_ID)

      const mode = engine.getModeSettings()
      expect(mode.mode).toBe('auto')
      const updated = engine.setModeSettings({ mode: 'cdp' })
      expect(updated.mode).toBe('cdp')

      await engine.deleteSession(session.sessionId)
      expect(engine.ownsSession(session.sessionId)).toBe(false)
      expect(engine.listSessions().length).toBe(0)

      await engine.close()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

