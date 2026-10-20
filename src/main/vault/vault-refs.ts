/**
 * Secret-reference grammar for the secure ND vault CLI.
 *
 * References are inert strings. They never carry a value, and the broker is the
 * only component that resolves one into a command environment or an injected
 * file. Titles are accepted for convenience but must be unique; ids are the
 * stable form written by `nd-vault list --refs`.
 */

export const VAULT_REF_PREFIX = 'ndvault://'
export const VAULT_REF_FIELDS = ['secret', 'username', 'url', 'notes'] as const
export type VaultRefField = (typeof VAULT_REF_FIELDS)[number]

export interface VaultRef {
  /** Exact reference text, including the scheme. */
  raw: string
  /** Entry id or decoded title. */
  target: string
  field: VaultRefField
}

const MAX_REF_LENGTH = 512
const TEMPLATE_REF = /\{\{\s*(ndvault:\/\/[^}\s]+)\s*\}\}/g

export function isVaultRefField(value: string): value is VaultRefField {
  return (VAULT_REF_FIELDS as readonly string[]).includes(value)
}

/** Strict parse; returns undefined instead of guessing at a malformed ref. */
export function parseVaultRef(value: string): VaultRef | undefined {
  if (typeof value !== 'string' || value.length > MAX_REF_LENGTH) return undefined
  const trimmed = value.trim()
  if (!trimmed.startsWith(VAULT_REF_PREFIX)) return undefined
  const body = trimmed.slice(VAULT_REF_PREFIX.length)
  if (!body) return undefined
  const slash = body.lastIndexOf('/')
  let target = body
  let field: VaultRefField = 'secret'
  if (slash > 0) {
    const candidate = body.slice(slash + 1)
    if (isVaultRefField(candidate)) {
      field = candidate
      target = body.slice(0, slash)
    }
  }
  if (!target || target.includes('\0')) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(target)
  } catch {
    return undefined
  }
  if (!decoded.trim() || decoded.includes('\0') || decoded.length > MAX_REF_LENGTH) return undefined
  return { raw: trimmed, target: decoded, field }
}

export function formatVaultRef(entryId: string, field: VaultRefField = 'secret'): string {
  return `${VAULT_REF_PREFIX}${encodeURIComponent(entryId)}/${field}`
}

export interface VaultEnvEntry {
  key: string
  ref: VaultRef
}

export function extractTemplateRefs(template: string): VaultRef[] {
  const unique = new Map<string, VaultRef>()
  for (const match of template.matchAll(TEMPLATE_REF)) {
    const raw = match[1]
    if (!raw) continue
    const ref = parseVaultRef(raw)
    if (!ref) throw new Error(`Invalid vault reference in template: ${raw}`)
    unique.set(ref.raw, ref)
  }
  return [...unique.values()]
}

/** Replace `{{ ndvault://... }}` placeholders with resolved values. */
export function replaceTemplateRefs(template: string, values: ReadonlyMap<string, string>): string {
  return template.replace(TEMPLATE_REF, (whole, raw: string) => {
    const value = values.get(raw.trim())
    return value === undefined ? whole : value
  })
}
