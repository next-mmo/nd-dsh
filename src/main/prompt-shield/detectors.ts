import {
  BUILTIN_PROMPT_SHIELD_CATEGORIES,
  promptShieldCategoryAction,
  type PromptShieldBuiltinId,
  type PromptShieldCustomType,
  type PromptShieldFinding,
  type PromptShieldOverride,
  type PromptShieldResult,
  type PromptShieldSettings,
} from '../../shared/prompt-shield.js'

interface Replacement {
  text: string
  count: number
}

/** Published test PANs are not real cardholder data and stay readable for developers. */
const TEST_CARD_NUMBERS = new Set([
  '4012888888881881',
  '4111111111111111',
  '4222222222222',
  '4242424242424242',
  '5105105105105100',
  '5555555555554444',
  '30569309025904',
  '3530111333300000',
  '3566002020360505',
  '371449635398431',
  '378282246310005',
  '378734493671000',
  '38520000023237',
  '6011000990139424',
  '6011111111111117',
])

const PLACEHOLDER_VALUES = /placeholder|example|dummy|redacted|your[-_ ]?(?:api[-_ ]?)?key|x{6,}/i
const INDIRECT_VALUES = /(?:^[$<]|\$\{|\{\{|process\.env|os\.environ|env\[|env\.|%[A-Z0-9_]+%)/

const API_KEY_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:proj-|ant-(?:api\d+-)?|live-|test-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bpypi-[A-Za-z0-9_-]{20,}\b/g,
  /\bdckr_pat_[A-Za-z0-9_-]{20,}\b/g,
  /\bsbp_[A-Za-z0-9]{20,}\b/g,
  /\bshpat_[A-Za-z0-9]{20,}\b/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  /\bAC[a-f0-9]{32}\b/g,
]

const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const BEARER_PATTERN = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi
const CREDIT_CARD_PATTERN = /(?<![\dA-Za-z])(?:\d[ -]?){14,18}\d(?![\dA-Za-z])/g
const SECRET_ASSIGNMENT_PATTERN = /(\b[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|token|secret)\b\s*[:=]\s*)("?)([^\s"',;]{6,})\2/gi

const ZERO_WIDTH_AND_BIDI = /[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

export function normalizePromptText(text: string): string {
  return text.replace(ZERO_WIDTH_AND_BIDI, '').replace(CONTROL_CHARACTERS, '')
}

/** Placeholder written into the outbound prompt; the original value never leaves ND. */
export function redactionPlaceholder(categoryId: string, label?: string): string {
  const raw = (label ?? categoryId).replace(/[^A-Za-z0-9 _-]+/g, ' ').trim().slice(0, 40)
  return `[ND-REDACTED:${raw || categoryId}]`
}

function luhnValid(digits: string): boolean {
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

function maskApiKeys(text: string, placeholder: string): Replacement {
  let count = 0
  let next = text
  for (const pattern of API_KEY_PATTERNS) {
    next = next.replace(pattern, (match) => {
      if (PLACEHOLDER_VALUES.test(match)) return match
      count += 1
      return placeholder
    })
  }
  return { text: next, count }
}

function maskPrivateKeys(text: string, placeholder: string): Replacement {
  let count = 0
  const next = text.replace(PRIVATE_KEY_PATTERN, () => {
    count += 1
    return placeholder
  })
  return { text: next, count }
}

function maskCreditCards(text: string, placeholder: string): Replacement {
  let count = 0
  const next = text.replace(CREDIT_CARD_PATTERN, (match) => {
    const digits = match.replace(/[ -]/g, '')
    if (digits.length < 15 || digits.length > 19) return match
    if (!luhnValid(digits) || TEST_CARD_NUMBERS.has(digits)) return match
    count += 1
    return placeholder
  })
  return { text: next, count }
}

function maskJwts(text: string, placeholder: string): Replacement {
  let count = 0
  const next = text.replace(JWT_PATTERN, () => {
    count += 1
    return placeholder
  })
  return { text: next, count }
}

function maskBearerTokens(text: string, placeholder: string): Replacement {
  let count = 0
  const next = text.replace(BEARER_PATTERN, (_match, prefix: string) => {
    count += 1
    return `${prefix}${placeholder}`
  })
  return { text: next, count }
}

function maskSecretAssignments(text: string, placeholder: string): Replacement {
  let count = 0
  const next = text.replace(SECRET_ASSIGNMENT_PATTERN, (_match, prefix: string, quote: string, value: string) => {
    if (PLACEHOLDER_VALUES.test(value) || INDIRECT_VALUES.test(value)) return _match
    count += 1
    return `${prefix}${quote}${placeholder}${quote}`
  })
  return { text: next, count }
}

const BUILTIN_DETECTORS: Record<PromptShieldBuiltinId, (text: string, placeholder: string) => Replacement> = {
  api_key: maskApiKeys,
  private_key: maskPrivateKeys,
  credit_card: maskCreditCards,
  jwt: maskJwts,
  bearer_token: maskBearerTokens,
  secret_assignment: maskSecretAssignments,
}

function maskCustom(text: string, custom: PromptShieldCustomType, placeholder: string): Replacement {
  let pattern: RegExp
  try {
    pattern = new RegExp(custom.pattern, 'g')
  } catch {
    return { text, count: 0 }
  }
  let count = 0
  const next = text.replace(pattern, (match) => {
    if (match.length === 0) return match
    count += 1
    return placeholder
  })
  return { text: next, count }
}

function unchanged(text: string): PromptShieldResult {
  return { text, findings: [], blocked: false, masked: 0 }
}

/**
 * Detect sensitive values and apply the configured action.
 *
 * `override` is a single-turn decision from the review dialog:
 * - `mask` turns blocked categories into masked ones for this send.
 * - `allow` bypasses the shield for this send.
 * Categories explicitly set to `allow` always stay untouched.
 */
export function applyPromptShield(
  text: string,
  settings: PromptShieldSettings,
  override?: PromptShieldOverride,
): PromptShieldResult {
  if (override === 'allow') return unchanged(text)
  if (!settings.enabled && override !== 'mask') return unchanged(text)

  let next = settings.normalize ? normalizePromptText(text) : text
  const findings: PromptShieldFinding[] = []
  let masked = 0

  for (const category of BUILTIN_PROMPT_SHIELD_CATEGORIES) {
    const configured = promptShieldCategoryAction(settings, category.id)
    const action = override === 'mask' && configured === 'block' ? 'mask' : configured
    if (action === 'allow') continue
    const placeholder = redactionPlaceholder(category.id)
    const replaced = BUILTIN_DETECTORS[category.id](next, placeholder)
    if (replaced.count === 0) continue
    next = replaced.text
    findings.push({ categoryId: category.id, label: category.label, action, count: replaced.count })
    if (action === 'mask') masked += replaced.count
  }

  for (const custom of settings.custom) {
    const action = override === 'mask' && custom.action === 'block' ? 'mask' : custom.action
    if (action === 'allow') continue
    const placeholder = redactionPlaceholder(custom.id, custom.label)
    const replaced = maskCustom(next, custom, placeholder)
    if (replaced.count === 0) continue
    next = replaced.text
    findings.push({ categoryId: custom.id, label: custom.label, action, count: replaced.count })
    if (action === 'mask') masked += replaced.count
  }

  return { text: next, findings, blocked: findings.some((finding) => finding.action === 'block'), masked }
}

interface PayloadTotals {
  findings: Map<string, PromptShieldFinding>
  blocked: boolean
  masked: number
}

function mergeFindings(totals: PayloadTotals, findings: readonly PromptShieldFinding[]): void {
  for (const finding of findings) {
    const key = `${finding.categoryId}:${finding.action}`
    const existing = totals.findings.get(key)
    if (existing) existing.count += finding.count
    else totals.findings.set(key, { ...finding })
  }
}

function visitContent(node: unknown, sanitize: (text: string) => string): unknown {
  if (typeof node === 'string') return sanitize(node)
  if (Array.isArray(node)) return node.map((entry) => visitContent(entry, sanitize))
  if (!node || typeof node !== 'object') return node
  const block = { ...(node as Record<string, unknown>) }
  if (typeof block.text === 'string') block.text = sanitize(block.text)
  if (block.content !== undefined) block.content = visitContent(block.content, sanitize)
  if (block.type === 'function_call_output' && typeof block.output === 'string') block.output = sanitize(block.output)
  return block
}

/**
 * Sanitize the prompt-bearing fields of an OpenAI/Anthropic/Responses request
 * body. Tool-call argument strings are deliberately left alone: masking them
 * would corrupt replayable tool history, and their results already pass through
 * the content walker.
 */
export function applyPromptShieldToPayload(
  payload: unknown,
  settings: PromptShieldSettings,
  override?: PromptShieldOverride,
): { payload: unknown; findings: PromptShieldFinding[]; blocked: boolean; masked: number } {
  const totals: PayloadTotals = { findings: new Map(), blocked: false, masked: 0 }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { payload, findings: [], blocked: false, masked: 0 }
  }
  const sanitize = (text: string): string => {
    const result = applyPromptShield(text, settings, override)
    if (result.findings.length > 0) {
      mergeFindings(totals, result.findings)
      totals.blocked = totals.blocked || result.blocked
      totals.masked += result.masked
    }
    return result.text
  }

  const clone = structuredClone(payload) as Record<string, unknown>
  if (typeof clone.instructions === 'string') clone.instructions = sanitize(clone.instructions)
  if (typeof clone.prompt === 'string') clone.prompt = sanitize(clone.prompt)
  if (clone.system !== undefined) clone.system = visitContent(clone.system, sanitize)
  if (Array.isArray(clone.messages)) {
    clone.messages = clone.messages.map((message) => {
      if (!message || typeof message !== 'object') return message
      const entry = { ...(message as Record<string, unknown>) }
      if (entry.content !== undefined) entry.content = visitContent(entry.content, sanitize)
      return entry
    })
  }
  if (typeof clone.input === 'string') clone.input = sanitize(clone.input)
  else if (Array.isArray(clone.input)) clone.input = clone.input.map((entry) => visitContent(entry, sanitize))

  return { payload: clone, findings: [...totals.findings.values()], blocked: totals.blocked, masked: totals.masked }
}
