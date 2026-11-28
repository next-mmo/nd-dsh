export type DiffRiskLevel = 'low' | 'medium' | 'high'

export interface DiffRiskSelfReview {
  score: number
  requiresHumanReview: boolean
  reason: string
  factors?: string[]
}

export interface DiffRiskFootprint {
  files: readonly string[]
  changedLines?: number | null
  binary?: boolean
  fingerprint: string
  exact: boolean
}

export interface OrganizationDiffRiskAssessment {
  score: number
  floor: number
  level: DiffRiskLevel
  agentScore: number | null
  requiresHumanReview: boolean
  reason: string
  factors: string[]
  safeguards: string[]
  files: string[]
  changedLines: number | null
  binary: boolean
  fingerprint: string
  assessedAt: number
}

export interface AssessDiffRiskOptions {
  /**
   * When true (for example, before unsupervised auto-merge/PR), a missing
   * agent self-review raises the floor to 10 so execution fails closed.
   */
  requireSelfReview?: boolean
  assessedAt?: number
}

const SENSITIVE_PATH_PATTERN = /(^|\/)([^/]*(?:auth|oauth|permission|policy|session|token|billing|payment|migration|database|deploy|secret|credential|vault)[^/]*|\.github|\.env[^/]*)(\/|\.|$)/i
const SENSITIVE_CONFIG_PATTERN = /\.(sql|ya?ml|properties|xml)$/i
const SENSITIVE_MANIFEST_PATTERN = /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.lock|[^/]*lockfile|dockerfile|server\.[^/]+)$/i
const NARROW_DOC_OR_STYLE_PATTERN = /\.(css|scss|sass|less|html|svg|md|txt)$/i
const NARROW_TEST_PATTERN = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i

/**
 * Parse `git diff --no-renames --numstat -z` (or newline-separated `--numstat`)
 * into total added+removed lines and whether any binary file changed.
 */
export function parseGitNumstat(output: string): { changedLines: number; binary: boolean } {
  const entries = output.includes('\0')
    ? output.split('\0')
    : output.split(/\r?\n/)
  let changedLines = 0
  let binary = false
  for (const raw of entries) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split('\t')
    if (parts.length < 2) continue
    const [added, removed] = parts
    if (added === '-' || removed === '-') {
      binary = true
      continue
    }
    const addedNum = Number(added)
    const removedNum = Number(removed)
    if (Number.isFinite(addedNum) && Number.isFinite(removedNum)) {
      changedLines += Math.max(0, addedNum) + Math.max(0, removedNum)
    }
  }
  return { changedLines, binary }
}

/** Validate an untrusted agent self-review object; invalid shapes return undefined. */
export function validateDiffRiskSelfReview(input: unknown): DiffRiskSelfReview | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  const score = record.score
  const requiresHumanReview = record.requiresHumanReview
  const reason = typeof record.reason === 'string' ? record.reason.trim() : ''
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 10) return undefined
  if (typeof requiresHumanReview !== 'boolean' || !reason) return undefined
  const factors = Array.isArray(record.factors)
    ? record.factors.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
    : undefined
  return {
    score,
    requiresHumanReview,
    reason: reason.slice(0, 500),
    ...(factors?.length ? { factors } : {}),
  }
}

/**
 * Deterministic risk floor layered over any agent self-review.
 *
 * Inspired by rex-desk's `assessRisk`: an agent can raise its own risk score
 * above the floor, never lower it beneath what the changed-file footprint
 * objectively touches, and every assessment binds to the exact workspace
 * fingerprint so later edits invalidate it.
 */
export function assessDiffRisk(
  footprint: DiffRiskFootprint,
  selfReview?: DiffRiskSelfReview,
  options: AssessDiffRiskOptions = {},
): OrganizationDiffRiskAssessment {
  const files = Array.from(
    new Set(
      footprint.files
        .map((file) => String(file).replace(/\\/g, '/').trim())
        .filter(Boolean),
    ),
  )
  const changedLines = typeof footprint.changedLines === 'number' && Number.isFinite(footprint.changedLines)
    ? Math.max(0, Math.round(footprint.changedLines))
    : null
  const binary = Boolean(footprint.binary)

  const safeguards: string[] = []
  let floor = 1
  const raise = (value: number, reason: string): void => {
    floor = Math.max(floor, value)
    safeguards.push(reason)
  }

  if (!footprint.exact) {
    raise(8, 'Exact Git workspace fingerprint was unavailable; human review is required.')
  }
  if (files.length === 0) {
    raise(5, 'No changed file footprint was recorded.')
  }
  if (files.some((file) => SENSITIVE_PATH_PATTERN.test(file) || SENSITIVE_CONFIG_PATTERN.test(file) || SENSITIVE_MANIFEST_PATTERN.test(file))) {
    raise(7, 'Security, data, dependencies, deployment, or server configuration changed.')
  }
  if (binary) {
    raise(7, 'Binary or compiled output changed and needs human inspection.')
  }
  if (files.length > 10 || (changedLines !== null && changedLines > 300)) {
    raise(6, 'Change spans more than 10 files or 300 added/removed lines.')
  } else if (files.length > 3 || (changedLines !== null && changedLines > 80)) {
    raise(4, 'Change exceeds the small-fix bound of 3 files and 80 added/removed lines.')
  }
  const narrowSurface = files.length > 0 && files.every(
    (file) => NARROW_DOC_OR_STYLE_PATTERN.test(file) || NARROW_TEST_PATTERN.test(file),
  )
  if (files.length > 0 && !narrowSurface) {
    raise(4, 'Executable application code changed; human review is required before unsupervised release.')
  }
  if (options.requireSelfReview && !selfReview) {
    raise(10, 'Agent did not submit a risk self-review.')
  }

  const score = selfReview ? Math.max(floor, selfReview.score) : floor
  const level: DiffRiskLevel = score <= 2 ? 'low' : score <= 5 ? 'medium' : 'high'
  const requiresHumanReview = Boolean(selfReview?.requiresHumanReview)
    || score > 2
    || !footprint.exact
    || (Boolean(options.requireSelfReview) && !selfReview)

  const reason = selfReview?.reason
    ?? (safeguards[0] ?? 'Small low-risk change within docs, styles, or tests.')

  return {
    score,
    floor,
    level,
    agentScore: selfReview ? selfReview.score : null,
    requiresHumanReview,
    reason,
    factors: (selfReview?.factors ?? []).slice(0, 20),
    safeguards,
    files,
    changedLines,
    binary,
    fingerprint: footprint.fingerprint,
    assessedAt: options.assessedAt ?? Date.now(),
  }
}

/**
 * Unsupervised low-risk continuation is permitted only when verification passed,
 * deterministic risk stayed low (score <= 2, no human review flag), and every
 * receipt binds to the exact current workspace fingerprint.
 */
export function canAutoProceedWithRisk(params: {
  risk?: OrganizationDiffRiskAssessment | null
  currentFingerprint: string
  verificationPassed: boolean
  verificationFingerprint?: string
}): boolean {
  const { risk, currentFingerprint, verificationPassed, verificationFingerprint } = params
  if (!verificationPassed || !risk || !currentFingerprint) return false
  if (risk.score > 2 || risk.requiresHumanReview) return false
  if (risk.fingerprint !== currentFingerprint) return false
  if (verificationFingerprint !== undefined && verificationFingerprint !== currentFingerprint) return false
  return true
}
