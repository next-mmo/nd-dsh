import type { EngineModelOption } from '../../../shared/contracts.js'
import {
  ARENA_WEB_ENGINE_ID,
  DUCK_WEB_ENGINE_ID,
  META_WEB_ENGINE_ID,
  MISTRAL_WEB_ENGINE_ID,
  PERPLEXITY_WEB_ENGINE_ID,
  POE_WEB_ENGINE_ID,
  QWEN_WEB_ENGINE_ID,
  ZAI_WEB_ENGINE_ID,
} from '../../../shared/coding-engines.js'

export interface GenericWebConfig {
  engineId: string
  name: string
  homeUrl: string
  origins: readonly string[]
  composerSelector?: string
  userTurnSelector?: string
  assistantTurnSelector?: string
  buttonSelector?: string
  stopButtonSelector?: string
  models: EngineModelOption[]
}

export const GENERIC_WEB_CONFIGS: Record<string, GenericWebConfig> = {
  [QWEN_WEB_ENGINE_ID]: {
    engineId: QWEN_WEB_ENGINE_ID,
    name: 'Qwen Web',
    homeUrl: 'https://chat.qwen.ai/',
    origins: ['https://chat.qwen.ai', 'https://qwen.ai', 'https://tongyi.aliyun.com'],
    models: [
      { id: 'default', name: 'Page default' },
      { id: 'qwen-max', name: 'Qwen Max' },
      { id: 'qwen-plus', name: 'Qwen Plus' },
      { id: 'qwen-turbo', name: 'Qwen Turbo' },
      { id: 'qwen-coder', name: 'Qwen Coder' },
    ],
  },
  [ZAI_WEB_ENGINE_ID]: {
    engineId: ZAI_WEB_ENGINE_ID,
    name: 'Z.ai Web',
    homeUrl: 'https://chat.z.ai/',
    origins: ['https://chat.z.ai', 'https://z.ai', 'https://zhipuai.cn'],
    models: [
      { id: 'default', name: 'Page default' },
      { id: 'glm-4-plus', name: 'GLM-4 Plus' },
      { id: 'glm-4-air', name: 'GLM-4 Air' },
      { id: 'glm-4-flash', name: 'GLM-4 Flash' },
    ],
  },
  [MISTRAL_WEB_ENGINE_ID]: {
    engineId: MISTRAL_WEB_ENGINE_ID,
    name: 'Mistral Web',
    homeUrl: 'https://chat.mistral.ai/',
    origins: ['https://chat.mistral.ai', 'https://mistral.ai'],
    models: [
      { id: 'default', name: 'Page default' },
      { id: 'mistral-large', name: 'Mistral Large' },
      { id: 'mistral-small', name: 'Mistral Small' },
      { id: 'codestral', name: 'Codestral' },
    ],
  },
  [PERPLEXITY_WEB_ENGINE_ID]: {
    engineId: PERPLEXITY_WEB_ENGINE_ID,
    name: 'Perplexity Web',
    homeUrl: 'https://www.perplexity.ai/',
    origins: ['https://www.perplexity.ai', 'https://perplexity.ai'],
    models: [
      { id: 'default', name: 'Page default' },
      { id: 'sonar', name: 'Sonar' },
      { id: 'sonar-pro', name: 'Sonar Pro' },
      { id: 'sonar-reasoning', name: 'Sonar Reasoning' },
    ],
  },
  [POE_WEB_ENGINE_ID]: {
    engineId: POE_WEB_ENGINE_ID,
    name: 'Poe Web',
    homeUrl: 'https://poe.com/',
    origins: ['https://poe.com', 'https://quora.com'],
    models: [
      { id: 'default', name: 'Page default' },
      { id: 'assistant', name: 'Assistant' },
      { id: 'web-search', name: 'Web Search' },
    ],
  },
  [ARENA_WEB_ENGINE_ID]: {
    engineId: ARENA_WEB_ENGINE_ID,
    name: 'Arena AI Web',
    homeUrl: 'https://arena.ai/',
    origins: ['https://arena.ai', 'https://chat.lmsys.org', 'https://lmarena.ai'],
    models: [
      { id: 'default', name: 'Page default' },
      { id: 'battle', name: 'Battle' },
      { id: 'side-by-side', name: 'Side by Side' },
      { id: 'direct-chat', name: 'Direct Chat' },
    ],
  },
  [META_WEB_ENGINE_ID]: {
    engineId: META_WEB_ENGINE_ID,
    name: 'Meta AI Web',
    homeUrl: 'https://www.meta.ai/',
    origins: ['https://www.meta.ai', 'https://meta.ai'],
    models: [
      { id: 'default', name: 'Page default' },
      { id: 'llama-3.3', name: 'Llama 3.3' },
      { id: 'imagine', name: 'Imagine' },
    ],
  },
  [DUCK_WEB_ENGINE_ID]: {
    engineId: DUCK_WEB_ENGINE_ID,
    name: 'Duck.ai Web',
    homeUrl: 'https://duck.ai/',
    origins: ['https://duck.ai', 'https://duckduckgo.com'],
    models: [
      { id: 'default', name: 'Page default' },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
      { id: 'claude-3-haiku', name: 'Claude 3 Haiku' },
      { id: 'llama-3.3-70b', name: 'Llama 3.3 70B' },
    ],
  },
}

export const GENERIC_WEB_ENGINE_IDS = Object.keys(GENERIC_WEB_CONFIGS)

export function isGenericWebEngineId(id: string): boolean {
  return id in GENERIC_WEB_CONFIGS
}
