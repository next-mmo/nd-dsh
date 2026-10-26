export type PromptShieldAction = 'block' | 'mask' | 'allow'

/** One-turn decisions from the blocked-prompt review dialog. */
export type PromptShieldOverride = 'mask' | 'allow'

export type PromptShieldBuiltinId =
  | 'api_key'
  | 'private_key'
  | 'credit_card'
  | 'jwt'
  | 'bearer_token'
  | 'secret_assignment'

export interface PromptShieldCustomType {
  id: string
  label: string
  pattern: string
  action: PromptShieldAction
}

export interface PromptShieldSettings {
  version: 1
  enabled: boolean
  /** Strip zero-width and bidi control characters before detection. */
  normalize: boolean
  actions: Partial<Record<PromptShieldBuiltinId, PromptShieldAction>>
  custom: PromptShieldCustomType[]
}

export interface PromptShieldCategoryInfo {
  id: string
  label: string
  description: string
  defaultAction: PromptShieldAction
  action: PromptShieldAction
  builtin: boolean
  pattern?: string
}

/** A detection summary. Never carries the matched value. */
export interface PromptShieldFinding {
  categoryId: string
  label: string
  action: 'block' | 'mask'
  count: number
}

export interface PromptShieldResult {
  text: string
  findings: PromptShieldFinding[]
  blocked: boolean
  masked: number
}

export interface PromptShieldCounters {
  /** Prompts with at least one detection. */
  prompted: number
  blocked: number
  masked: number
  byCategory: Record<string, number>
}

export interface PromptShieldState {
  settings: PromptShieldSettings
  categories: PromptShieldCategoryInfo[]
  counters: PromptShieldCounters
}

export interface PromptShieldTestResult {
  findings: PromptShieldFinding[]
  blocked: boolean
  masked: number
  /** Text with detections replaced by placeholders. */
  text: string
}

export interface PromptShieldBlockedPayload {
  findings: PromptShieldFinding[]
  /** Masked copy of the outbound prompt, truncated for transport. */
  preview: string
  previewTruncated: boolean
}

export const PROMPT_SHIELD_IPC = {
  state: 'prompt-shield:state',
  updateSettings: 'prompt-shield:update-settings',
  testText: 'prompt-shield:test-text',
  resetCounters: 'prompt-shield:reset-counters',
  changedEvent: 'prompt-shield:changed',
} as const

export interface PromptShieldDesktopApi {
  state(): Promise<PromptShieldState>
  updateSettings(settings: PromptShieldSettings): Promise<PromptShieldState>
  testText(text: string): Promise<PromptShieldTestResult>
  resetCounters(): Promise<PromptShieldState>
  onChanged(listener: (state: PromptShieldState) => void): () => void
}

export const PROMPT_SHIELD_BLOCKED_PREFIX = 'ND_PROMPT_SHIELD_BLOCKED:'
export const PROMPT_SHIELD_PREVIEW_LIMIT = 4_000
export const PROMPT_SHIELD_CUSTOM_ID_RE = /^custom_[a-z0-9]{4,64}$/

interface BuiltinCategory {
  id: PromptShieldBuiltinId
  label: string
  description: string
  defaultAction: PromptShieldAction
}

export const BUILTIN_PROMPT_SHIELD_CATEGORIES: readonly BuiltinCategory[] = [
  {
    id: 'api_key',
    label: 'API keys',
    description: 'OpenAI, Anthropic, GitHub, AWS, Google, Slack, npm, Hugging Face and similar token shapes.',
    defaultAction: 'block',
  },
  {
    id: 'private_key',
    label: 'Private keys',
    description: 'PEM-encoded private key blocks.',
    defaultAction: 'block',
  },
  {
    id: 'credit_card',
    label: 'Credit cards',
    description: '13–19 digit numbers that pass the Luhn checksum. Published test numbers are ignored.',
    defaultAction: 'block',
  },
  {
    id: 'jwt',
    label: 'JSON Web Tokens',
    description: 'Three-part JWT values.',
    defaultAction: 'mask',
  },
  {
    id: 'bearer_token',
    label: 'Bearer tokens',
    description: 'Bearer credentials written in prompts or headers.',
    defaultAction: 'mask',
  },
  {
    id: 'secret_assignment',
    label: 'Secret assignments',
    description: 'Values assigned to password, token, secret or api_key fields.',
    defaultAction: 'mask',
  },
]

export function defaultPromptShieldSettings(): PromptShieldSettings {
  return {
    version: 1,
    enabled: true,
    normalize: true,
    actions: {},
    custom: [],
  }
}

export function emptyPromptShieldCounters(): PromptShieldCounters {
  return { prompted: 0, blocked: 0, masked: 0, byCategory: {} }
}

export function promptShieldCategoryAction(settings: PromptShieldSettings, id: string): PromptShieldAction {
  const builtin = BUILTIN_PROMPT_SHIELD_CATEGORIES.find((category) => category.id === id)
  if (builtin) return settings.actions[builtin.id] ?? builtin.defaultAction
  return settings.custom.find((category) => category.id === id)?.action ?? 'mask'
}

export function describePromptShieldCategories(settings: PromptShieldSettings): PromptShieldCategoryInfo[] {
  const builtin: PromptShieldCategoryInfo[] = BUILTIN_PROMPT_SHIELD_CATEGORIES.map((category) => ({
    id: category.id,
    label: category.label,
    description: category.description,
    defaultAction: category.defaultAction,
    action: settings.actions[category.id] ?? category.defaultAction,
    builtin: true,
  }))
  const custom: PromptShieldCategoryInfo[] = settings.custom.map((category) => ({
    id: category.id,
    label: category.label,
    description: 'Custom detection rule.',
    defaultAction: 'mask',
    action: category.action,
    builtin: false,
    pattern: category.pattern,
  }))
  return [...builtin, ...custom]
}

/** Parse a blocked-run error message produced by the main process. */
export function parsePromptShieldBlockedError(message: string): PromptShieldBlockedPayload | undefined {
  const index = message.indexOf(PROMPT_SHIELD_BLOCKED_PREFIX)
  if (index === -1) return undefined
  const raw = message.slice(index + PROMPT_SHIELD_BLOCKED_PREFIX.length).trim()
  try {
    const parsed = JSON.parse(raw) as Partial<PromptShieldBlockedPayload>
    if (!Array.isArray(parsed.findings)) return undefined
    return {
      findings: parsed.findings.filter((finding): finding is PromptShieldFinding => (
        Boolean(finding)
        && typeof finding.categoryId === 'string'
        && typeof finding.label === 'string'
        && (finding.action === 'block' || finding.action === 'mask')
        && typeof finding.count === 'number'
      )),
      preview: typeof parsed.preview === 'string' ? parsed.preview : '',
      previewTruncated: parsed.previewTruncated === true,
    }
  } catch {
    return undefined
  }
}
