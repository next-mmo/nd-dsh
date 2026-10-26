import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import {
  BUILTIN_PROMPT_SHIELD_CATEGORIES,
  PROMPT_SHIELD_BLOCKED_PREFIX,
  PROMPT_SHIELD_CUSTOM_ID_RE,
  PROMPT_SHIELD_PREVIEW_LIMIT,
  defaultPromptShieldSettings,
  describePromptShieldCategories,
  emptyPromptShieldCounters,
  type PromptShieldAction,
  type PromptShieldBlockedPayload,
  type PromptShieldBuiltinId,
  type PromptShieldCounters,
  type PromptShieldCustomType,
  type PromptShieldOverride,
  type PromptShieldResult,
  type PromptShieldSettings,
  type PromptShieldState,
  type PromptShieldTestResult,
} from '../../shared/prompt-shield.js'
import { applyPromptShield, applyPromptShieldToPayload } from './detectors.js'

interface Snapshot {
  version: 1
  settings: PromptShieldSettings
  counters: PromptShieldCounters
}

const MAX_CUSTOM_TYPES = 20
const MAX_TEXT_CHARS = 100_000

/**
 * ND-owned prompt protection.
 *
 * Settings and counters stay on this machine; detections are reported by
 * category and count only, never by matched value. A blocked turn throws an
 * error carrying the masked preview and the review dialog payload.
 */
export class PromptShieldService {
  private settingsValue = defaultPromptShieldSettings()
  private countersValue = emptyPromptShieldCounters()
  private onChanged: ((state: PromptShieldState) => void) | undefined

  constructor(private readonly filePath: string) {
    this.load()
  }

  setOnChanged(listener: ((state: PromptShieldState) => void) | undefined): void {
    this.onChanged = listener
  }

  state(): PromptShieldState {
    return {
      settings: structuredClone(this.settingsValue),
      categories: describePromptShieldCategories(this.settingsValue),
      counters: structuredClone(this.countersValue),
    }
  }

  settings(): PromptShieldSettings {
    return structuredClone(this.settingsValue)
  }

  updateSettings(value: unknown): PromptShieldState {
    this.settingsValue = validateSettings(value, this.settingsValue, true)
    this.persist()
    return this.emit()
  }

  resetCounters(): PromptShieldState {
    this.countersValue = emptyPromptShieldCounters()
    this.persist()
    return this.emit()
  }

  /** Settings preview. Does not touch counters, and previews rules even when the master switch is off. */
  test(text: string): PromptShieldTestResult {
    if (typeof text !== 'string') throw new Error('Test text must be a string')
    if (text.length > MAX_TEXT_CHARS) throw new Error(`Test text exceeds the ${MAX_TEXT_CHARS} character limit`)
    const result = applyPromptShield(text, { ...this.settingsValue, enabled: true })
    return { findings: result.findings, blocked: result.blocked, masked: result.masked, text: result.text }
  }

  apply(text: string, override?: PromptShieldOverride): PromptShieldResult {
    const result = applyPromptShield(text, this.settingsValue, override)
    if (result.findings.length > 0) {
      this.countersValue.prompted += 1
      if (result.blocked) this.countersValue.blocked += 1
      this.countersValue.masked += result.masked
      for (const finding of result.findings) {
        this.countersValue.byCategory[finding.categoryId] = (this.countersValue.byCategory[finding.categoryId] ?? 0) + finding.count
      }
      this.persist()
      this.emit()
    }
    return result
  }

  applyToPayload(payload: unknown, override?: PromptShieldOverride): {
    payload: unknown
    findings: PromptShieldResult['findings']
    blocked: boolean
    masked: number
  } {
    const result = applyPromptShieldToPayload(payload, this.settingsValue, override)
    if (result.findings.length > 0) {
      this.countersValue.prompted += 1
      if (result.blocked) this.countersValue.blocked += 1
      this.countersValue.masked += result.masked
      for (const finding of result.findings) {
        this.countersValue.byCategory[finding.categoryId] = (this.countersValue.byCategory[finding.categoryId] ?? 0) + finding.count
      }
      this.persist()
      this.emit()
    }
    return result
  }

  blockedPayload(result: PromptShieldResult): PromptShieldBlockedPayload {
    const truncated = result.text.length > PROMPT_SHIELD_PREVIEW_LIMIT
    return {
      findings: result.findings,
      preview: truncated ? result.text.slice(0, PROMPT_SHIELD_PREVIEW_LIMIT) : result.text,
      previewTruncated: truncated,
    }
  }

  private emit(): PromptShieldState {
    const next = this.state()
    this.onChanged?.(next)
    return next
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object') return
      const record = parsed as Record<string, unknown>
      if (record.version !== 1) return
      this.settingsValue = validateSettings(record.settings, defaultPromptShieldSettings(), false)
      this.countersValue = validateCounters(record.counters)
    } catch {
      // First run or an unreadable snapshot falls back to safe defaults.
    }
  }

  private persist(): void {
    const snapshot: Snapshot = {
      version: 1,
      settings: this.settingsValue,
      counters: this.countersValue,
    }
    writeJsonAtomic(this.filePath, snapshot)
  }
}

export function promptShieldBlockedError(payload: PromptShieldBlockedPayload): Error {
  return new Error(`${PROMPT_SHIELD_BLOCKED_PREFIX}${JSON.stringify(payload)}`)
}

function validateSettings(value: unknown, fallback: PromptShieldSettings, strict: boolean): PromptShieldSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (strict) throw new Error('Prompt Shield settings must be an object')
    return structuredClone(fallback)
  }
  const record = value as Record<string, unknown>
  const actions: Partial<Record<PromptShieldBuiltinId, PromptShieldAction>> = {}
  if (record.actions !== undefined) {
    if (!record.actions || typeof record.actions !== 'object' || Array.isArray(record.actions)) {
      if (strict) throw new Error('Prompt Shield category actions must be an object')
    } else {
      const entries = record.actions as Record<string, unknown>
      for (const category of BUILTIN_PROMPT_SHIELD_CATEGORIES) {
        const action = entries[category.id]
        if (action === undefined) continue
        actions[category.id] = readAction(action, category.id, strict)
      }
    }
  }
  const custom = readCustomTypes(record.custom, strict)
  return {
    version: 1,
    enabled: typeof record.enabled === 'boolean' ? record.enabled : fallback.enabled,
    normalize: typeof record.normalize === 'boolean' ? record.normalize : fallback.normalize,
    actions,
    custom,
  }
}

function readCustomTypes(value: unknown, strict: boolean): PromptShieldCustomType[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    if (strict) throw new Error('Prompt Shield custom types must be an array')
    return []
  }
  if (value.length > MAX_CUSTOM_TYPES) {
    if (strict) throw new Error(`Prompt Shield allows at most ${MAX_CUSTOM_TYPES} custom types`)
    return []
  }
  const custom: PromptShieldCustomType[] = []
  const ids = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      if (strict) throw new Error('Prompt Shield custom type must be an object')
      continue
    }
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!PROMPT_SHIELD_CUSTOM_ID_RE.test(id) || ids.has(id)) {
      if (strict) throw new Error('Prompt Shield custom type has an invalid id')
      continue
    }
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    if (!label || label.length > 40) {
      if (strict) throw new Error('Prompt Shield custom type needs a label of at most 40 characters')
      continue
    }
    const pattern = typeof record.pattern === 'string' ? record.pattern.trim() : ''
    if (!pattern || pattern.length > 500) {
      if (strict) throw new Error('Prompt Shield custom type needs a pattern of at most 500 characters')
      continue
    }
    try {
      new RegExp(pattern)
    } catch {
      if (strict) throw new Error(`Prompt Shield pattern for "${label}" is not a valid regular expression`)
      continue
    }
    let action: PromptShieldAction
    try {
      action = readAction(record.action ?? 'mask', label, strict)
    } catch {
      continue
    }
    ids.add(id)
    custom.push({ id, label, pattern, action })
  }
  return custom
}

function readAction(value: unknown, label: string, strict: boolean): PromptShieldAction {
  if (value === 'block' || value === 'mask' || value === 'allow') return value
  if (strict) throw new Error(`Prompt Shield action for "${label}" must be block, mask or allow`)
  return 'mask'
}

function validateCounters(value: unknown): PromptShieldCounters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyPromptShieldCounters()
  const record = value as Record<string, unknown>
  const number = (key: string): number => {
    const raw = record[key]
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0
  }
  const byCategory: Record<string, number> = {}
  if (record.byCategory && typeof record.byCategory === 'object' && !Array.isArray(record.byCategory)) {
    for (const [key, raw] of Object.entries(record.byCategory as Record<string, unknown>)) {
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) byCategory[key] = Math.floor(raw)
    }
  }
  return { prompted: number('prompted'), blocked: number('blocked'), masked: number('masked'), byCategory }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temp, path)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* best effort */ }
    throw error
  }
}
