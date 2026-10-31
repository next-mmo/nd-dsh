import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { safeStorage } from 'electron'
import type { TokenSaverAccountId, TokenSaverAccountState } from '../../shared/token-saver.js'
import {
  antigravityClientId,
  antigravityClientSecret,
  authorizeAntigravityAccount,
  googleAuthorizedUserPath,
  parseGoogleTokens,
  writeGoogleAuthorizedUserFile,
  type GoogleTokens,
} from '../google-oauth.js'
import { bundledResourceRoot, codexBinPath } from '../app-paths.js'
import { backgroundProcessEnvironment } from '../core/background-process-environment.js'

const CODEX_LOGIN_TIMEOUT_MS = 10 * 60_000
const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token'

interface AccountMetadataFile {
  version: 1
  antigravity?: {
    email?: string
    expiresAt: number
    scope?: string
    projectId?: string
  }
}

interface AccountSecretsFile {
  version: 1
  antigravity?: string
}

/**
 * Provider-account boundary for the Token Saver release.
 *
 * Codex remains entirely native: ND launches the pinned official Codex login
 * and never reads/copies its tokens. Antigravity is the only ND-managed OAuth
 * account; its access/refresh tokens are encrypted with Electron safeStorage.
 */
export class ProviderAccountService {
  private readonly metadataPath: string
  private readonly secretsPath: string
  private metadata: AccountMetadataFile = { version: 1 }
  private antigravityTokens: GoogleTokens | undefined
  private onChanged: (() => void) | undefined

  constructor(rootDir: string) {
    this.metadataPath = join(rootDir, 'provider-accounts.json')
    this.secretsPath = join(rootDir, 'provider-account-secrets.json')
    this.load()
  }

  setOnChanged(listener: (() => void) | undefined): void {
    this.onChanged = listener
  }

  accounts(): TokenSaverAccountState[] {
    const codexBin = codexBinPath()
    const codexConnected = codexAuthExists()
    const antigravity = this.metadata.antigravity
    const antigravityConnected = Boolean(this.antigravityTokens?.accessToken || this.antigravityTokens?.refreshToken)
    return [
      {
        id: 'codex',
        name: 'Codex',
        kind: 'native',
        available: Boolean(codexBin),
        connectable: Boolean(codexBin),
        connected: codexConnected,
        detail: codexConnected
          ? 'Uses Codex native ChatGPT authentication. ND never copies the Codex credential.'
          : codexBin
            ? 'Connect with the official Codex sign-in flow from inside ND.'
            : 'Codex runtime is not installed in this ND build.',
      },
      {
        id: 'antigravity',
        name: 'Antigravity',
        kind: 'oauth',
        available: true,
        connectable: true,
        connected: antigravityConnected,
        ...(antigravity?.email ? { email: antigravity.email } : {}),
        ...(antigravity?.expiresAt ? { expiresAt: antigravity.expiresAt } : {}),
        ...(antigravity?.projectId ? { projectId: antigravity.projectId } : {}),
        detail: antigravityConnected
          ? canPersistSecrets()
            ? 'OAuth tokens are stored with the operating-system protection exposed by Electron.'
            : 'Connected for this app session only because secure OS credential storage is unavailable.'
          : 'Browser sign-in. No API key or terminal setup required.',
      },
    ]
  }

  async connect(id: TokenSaverAccountId): Promise<void> {
    if (id === 'codex') await this.connectCodex()
    else await this.connectAntigravity()
    this.onChanged?.()
  }

  /** Email of the signed-in Antigravity account, when one exists. */
  antigravityEmail(): string | undefined {
    return this.metadata.antigravity?.email
  }

  /** Email only when a refresh token is loaded and can back a router account. */
  antigravityExportableEmail(): string | undefined {
    const email = this.metadata.antigravity?.email
    return email && this.antigravityTokens?.refreshToken ? email : undefined
  }

  /**
   * Export the signed-in Antigravity account as a Google authorized_user file
   * for the Router's antigravity lane. ND's OAuth token never leaves main.
   */
  exportAntigravityAuthorizedUser(rootDir: string): { email: string; adcPath: string } | undefined {
    const tokens = this.antigravityTokens
    const email = this.metadata.antigravity?.email
    if (!tokens?.refreshToken || !email) return undefined
    const adcPath = googleAuthorizedUserPath(rootDir, email)
    writeGoogleAuthorizedUserFile(adcPath, {
      clientId: antigravityClientId(),
      clientSecret: antigravityClientSecret(),
      refreshToken: tokens.refreshToken,
      email,
    })
    return { email, adcPath }
  }

  async disconnect(id: TokenSaverAccountId): Promise<void> {
    if (id === 'codex') await this.disconnectCodex()
    else this.disconnectAntigravity()
    this.onChanged?.()
  }

  async refresh(): Promise<void> {
    await this.refreshAntigravity(false)
    this.onChanged?.()
  }

  private async connectCodex(): Promise<void> {
    const bin = codexBinPath()
    if (!bin) throw new Error('Codex runtime is not installed in this ND build')
    if (codexAuthExists()) return
    await runCodex(bin, ['login'])
    if (!codexAuthExists()) throw new Error('Codex sign-in finished but no native Codex account was detected')
  }

  private async disconnectCodex(): Promise<void> {
    const bin = codexBinPath()
    if (!bin) return
    await runCodex(bin, ['logout'])
  }

  private async connectAntigravity(): Promise<void> {
    const { tokens, email } = await authorizeAntigravityAccount({
      callbackPath: '/oauth/antigravity/callback',
    })
    this.antigravityTokens = tokens
    this.metadata.antigravity = {
      expiresAt: tokens.expiresAt,
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      ...(email ? { email } : {}),
    }
    this.persist()
  }

  private disconnectAntigravity(): void {
    this.antigravityTokens = undefined
    this.metadata = { version: 1 }
    this.persist()
  }

  private async refreshAntigravity(force: boolean): Promise<void> {
    const current = this.antigravityTokens
    if (!current?.refreshToken) return
    if (!force && current.expiresAt > Date.now() + 90_000) return
    const response = await fetch(ANTIGRAVITY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: antigravityClientId(),
        client_secret: antigravityClientSecret(),
        refresh_token: current.refreshToken,
      }),
    })
    if (!response.ok) throw new Error(`Antigravity token refresh failed (${response.status})`)
    const next = parseGoogleTokens(await response.json(), current.refreshToken)
    this.antigravityTokens = next
    this.metadata.antigravity = {
      ...(this.metadata.antigravity ?? { expiresAt: next.expiresAt }),
      expiresAt: next.expiresAt,
      ...(next.scope ? { scope: next.scope } : {}),
    }
    this.persist()
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.metadataPath, 'utf8')) as AccountMetadataFile
      if (parsed?.version === 1) this.metadata = parsed
    } catch {
      this.metadata = { version: 1 }
    }
    if (!canPersistSecrets()) return
    try {
      const parsed = JSON.parse(readFileSync(this.secretsPath, 'utf8')) as AccountSecretsFile
      if (parsed?.version !== 1 || !parsed.antigravity) return
      const plain = safeStorage.decryptString(Buffer.from(parsed.antigravity, 'base64'))
      const tokens = JSON.parse(plain) as GoogleTokens
      if (tokens?.accessToken && typeof tokens.expiresAt === 'number') this.antigravityTokens = tokens
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Could not load Antigravity OAuth tokens:', error)
    }
  }

  private persist(): void {
    writeJsonAtomic(this.metadataPath, this.metadata)
    if (!canPersistSecrets()) {
      try { rmSync(this.secretsPath, { force: true }) } catch { /* best effort */ }
      return
    }
    const payload: AccountSecretsFile = { version: 1 }
    if (this.antigravityTokens) {
      payload.antigravity = safeStorage.encryptString(JSON.stringify(this.antigravityTokens)).toString('base64')
    }
    writeJsonAtomic(this.secretsPath, payload)
  }
}

function codexAuthExists(): boolean {
  const base = process.env.CODEX_HOME?.trim()
    || (process.env.HOME ? join(process.env.HOME, '.codex') : process.env.USERPROFILE ? join(process.env.USERPROFILE, '.codex') : '')
  return Boolean(base) && existsSync(join(base, 'auth.json'))
}

function runCodex(bin: string, args: string[]): Promise<void> {
  const runAsNode = /\.[cm]?js$/i.test(bin)
  const preload = join(bundledResourceRoot(), 'scripts', 'nd-background-process.cjs')
  const nodePolicyArgs = process.platform === 'win32' ? ['--require', preload] : []
  const argv = runAsNode ? [process.execPath, ...nodePolicyArgs, bin, ...args] : [bin, ...args]
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  if (runAsNode) environment.ELECTRON_RUN_AS_NODE = '1'
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      env: backgroundProcessEnvironment(
        environment,
        preload,
      ),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    let settled = false
    const finishReject = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already stopped */ }
      finishReject(new Error('Codex sign-in timed out'))
    }, CODEX_LOGIN_TIMEOUT_MS)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { output += chunk })
    child.stderr?.on('data', (chunk: string) => { output += chunk })
    child.once('error', (error) => {
      clearTimeout(timer)
      finishReject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (code === 0) resolve()
      else reject(new Error(output.trim() || `Codex account command exited with code ${String(code)}`))
    })
  })
}

function canPersistSecrets(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform !== 'linux') return true
  const backend = safeStorage.getSelectedStorageBackend()
  return backend !== 'basic_text' && backend !== 'unknown'
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
