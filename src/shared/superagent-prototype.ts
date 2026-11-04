/** IPC channels and view models for the ND-managed Superagent research prototype. */
export const SUPERAGENT_PROTOTYPE_IPC = {
  status: 'superagent-prototype:status',
  install: 'superagent-prototype:install',
  start: 'superagent-prototype:start',
  stop: 'superagent-prototype:stop',
  open: 'superagent-prototype:open',
} as const

export type SuperagentPrototypePhase = 'not-installed' | 'installing' | 'stopped' | 'starting' | 'running' | 'error'

export interface SuperagentPrototypePrerequisites {
  git: boolean
  pnpm: boolean
  gh: boolean
}

export interface SuperagentPrototypeStatus {
  phase: SuperagentPrototypePhase
  checkoutPath: string
  stateDir: string
  profileDir: string
  logPath: string
  port: number
  panelUrl?: string
  prerequisites: SuperagentPrototypePrerequisites
  message?: string
  logTail: string[]
}

export interface SuperagentPrototypeDesktopApi {
  status(): Promise<SuperagentPrototypeStatus>
  install(): Promise<SuperagentPrototypeStatus>
  start(): Promise<SuperagentPrototypeStatus>
  stop(): Promise<SuperagentPrototypeStatus>
  open(): Promise<{ url?: string }>
}

export const SUPERAGENT_PROTOTYPE_REPOSITORY = 'https://github.com/deepseek-ai/dsh-superagent-prototype.git'
export const SUPERAGENT_PROTOTYPE_PROFILE = 'superagent'
export const SUPERAGENT_PROTOTYPE_DEFAULT_PORT = 3082

/**
 * The superagent profile config schema requires a POSIX-absolute `stateDir`.
 * A Windows drive path becomes a drive-root-relative path; the service starts
 * the child with a cwd on the same drive so the runtime resolves it back.
 */
export function toDshPosixPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/')
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(normalized)
  const withoutTrailing = (drive?.[2] ?? normalized).replace(/\/+$/, '')
  if (drive) return withoutTrailing || '/'
  if (withoutTrailing.startsWith('/')) return withoutTrailing || '/'
  throw new Error(`The DSH profile requires an absolute state directory, received ${JSON.stringify(value)}.`)
}

/** Profile overlay managed by ND; Install/Repair rewrites it on every run. */
export function buildSuperagentProfilePatch(options: { port: number; stateDir: string }): string {
  const stateDir = JSON.stringify(toDshPosixPath(options.stateDir))
  return [
    '# Managed by ND-DSH for the Superagent prototype. Install/Repair rewrites this file.',
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    `    port: ${String(options.port)}`,
    '- id: dsh-superagent',
    '  config:',
    `    stateDir: ${stateDir}`,
    '# ND routes models through Harness pi-ai and keeps the native DeepSeek adapter opt-in.',
    '- id: llm-pi-ai',
    '  config:',
    "    providers: !!js JSON.parse(process.env.ND_DSH_LLM_PROVIDERS_JSON ?? '{}')",
    '- id: agent-default-model',
    '  config:',
    "    provider: !!js process.env.ND_DSH_DEFAULT_PROVIDER ?? ''",
    "    model: !!js process.env.ND_DSH_DEFAULT_MODEL ?? ''",
    '- id: llm-deepseek',
    "  disabled: !!js process.env.ND_DSH_DEEPSEEK_ENABLED !== '1'",
    '# The prototype has no ND settings surface, so the native DeepSeek account stack stays off.',
    '- id: llm-deepseek-account',
    '  disabled: true',
    '- id: ui-settings-account',
    '  disabled: true',
    '- id: account-controller',
    '  disabled: true',
    '',
  ].join('\n')
}

/** Read the tokenized panel URL from the runtime's `dsh web:` startup banner. */
export function parseSuperagentPanelUrl(output: string): string | undefined {
  const match = /dsh web:\s*(https?:\/\/\S+)/.exec(output)
  if (!match?.[1]) return undefined
  try {
    const url = new URL(match[1])
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}
