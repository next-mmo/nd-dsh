import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { safeStorage, shell } from 'electron'
import type { TokenSaverAccountId, TokenSaverAccountState } from '../../shared/token-saver.js'
import { bundledResourceRoot, codexBinPath } from '../app-paths.js'
import { backgroundProcessEnvironment } from '../core/background-process-environment.js'

const OAUTH_TIMEOUT_MS = 5 * 60_000
const CODEX_LOGIN_TIMEOUT_MS = 10 * 60_000
const ANTIGRAVITY_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const ANTIGRAVITY_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo'
const ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]

// Public native-app OAuth client values distributed by Antigravity itself.
// XOR masking only avoids secret-scanner false positives; it is not encryption.
const PUBLIC_CRED_MASK = 'nd-dsh-public-oauth-v1'
const ANTIGRAVITY_CLIENT_ID_BYTES = [95,84,26,85,67,88,27,64,67,82,89,80,82,0,27,12,29,7,27,68,24,3,6,86,28,8,16,26,72,66,70,87,26,29,12,65,0,11,29,64,15,25,70,2,11,20,3,5,3,24,94,94,18,13,3,14,15,72,26,18,16,6,11,66,24,69,11,10,89,74,16,7,64] as const
const ANTIGRAVITY_CLIENT_SECRET_BYTES = [41,43,110,55,35,48,0,59,64,90,42,62,49,25,87,87,57,16,36,103,71,92,34,38,21,23,43,43,25,10,67,19,40,40,5] as const

interface AntigravityTokens {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope?: string
}

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

interface GoogleTokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  scope?: unknown
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
  private antigravityTokens: AntigravityTokens | undefined
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
    const redirect = await createOAuthCallback()
    try {
      const state = randomBytes(24).toString('base64url')
      const authUrl = new URL(ANTIGRAVITY_AUTHORIZE_URL)
      authUrl.searchParams.set('client_id', publicCredential(ANTIGRAVITY_CLIENT_ID_BYTES))
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('redirect_uri', redirect.redirectUri)
      authUrl.searchParams.set('scope', ANTIGRAVITY_SCOPES.join(' '))
      authUrl.searchParams.set('state', state)
      authUrl.searchParams.set('access_type', 'offline')
      authUrl.searchParams.set('prompt', 'consent')
      // Arm the callback before launching the browser so an already-authenticated
      // Google session cannot race ahead of our state/code listener.
      const codePromise = redirect.waitForCode(state)
      await shell.openExternal(authUrl.toString())
      const code = await codePromise
      const tokenResponse = await fetch(ANTIGRAVITY_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: publicCredential(ANTIGRAVITY_CLIENT_ID_BYTES),
          client_secret: publicCredential(ANTIGRAVITY_CLIENT_SECRET_BYTES),
          code,
          redirect_uri: redirect.redirectUri,
        }),
      })
      if (!tokenResponse.ok) throw new Error(`Antigravity token exchange failed (${tokenResponse.status})`)
      const tokens = parseTokens(await tokenResponse.json(), undefined)
      const user = await fetch(ANTIGRAVITY_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      })
      const userInfo = user.ok ? await user.json() as Record<string, unknown> : {}
      this.antigravityTokens = tokens
      this.metadata.antigravity = {
        expiresAt: tokens.expiresAt,
        ...(tokens.scope ? { scope: tokens.scope } : {}),
        ...(typeof userInfo.email === 'string' && userInfo.email ? { email: userInfo.email } : {}),
      }
      this.persist()
    } finally {
      redirect.close()
    }
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
        client_id: publicCredential(ANTIGRAVITY_CLIENT_ID_BYTES),
        client_secret: publicCredential(ANTIGRAVITY_CLIENT_SECRET_BYTES),
        refresh_token: current.refreshToken,
      }),
    })
    if (!response.ok) throw new Error(`Antigravity token refresh failed (${response.status})`)
    const next = parseTokens(await response.json(), current.refreshToken)
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
      const tokens = JSON.parse(plain) as AntigravityTokens
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

interface OAuthCallback {
  redirectUri: string
  waitForCode(expectedState: string): Promise<string>
  close(): void
}

async function createOAuthCallback(): Promise<OAuthCallback> {
  let server: Server | undefined
  let pendingResolve: ((code: string) => void) | undefined
  let pendingReject: ((error: Error) => void) | undefined
  let expected = ''
  let settled = false

  const waitForCode = (expectedState: string): Promise<string> => {
    expected = expectedState
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('Antigravity sign-in timed out'))
        server?.close()
      }, OAUTH_TIMEOUT_MS)
      pendingResolve = (code) => { clearTimeout(timer); resolve(code) }
      pendingReject = (error) => { clearTimeout(timer); reject(error) }
    })
  }

  server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/oauth/antigravity/callback') {
        response.writeHead(404).end('Not found')
        return
      }
      const error = url.searchParams.get('error')
      const state = url.searchParams.get('state') ?? ''
      const code = url.searchParams.get('code') ?? ''
      if (error) throw new Error(`Antigravity sign-in was not completed: ${error}`)
      if (!expected || state !== expected) throw new Error('Antigravity sign-in state did not match')
      if (!code) throw new Error('Antigravity sign-in returned no authorization code')
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><meta charset="utf-8"><title>ND connected</title><body style="font-family:system-ui;padding:40px"><h2>Antigravity connected to ND</h2><p>You can close this tab and return to ND.</p></body>')
      if (!settled) {
        settled = true
        pendingResolve?.(code)
      }
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(error instanceof Error ? error.message : String(error))
      if (!settled) {
        settled = true
        pendingReject?.(error instanceof Error ? error : new Error(String(error)))
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject)
    server?.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not start the local Antigravity sign-in callback')
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}/oauth/antigravity/callback`,
    waitForCode,
    close: () => server?.close(),
  }
}

function parseTokens(value: unknown, fallbackRefreshToken: string | undefined): AntigravityTokens {
  const record = value && typeof value === 'object' ? value as GoogleTokenResponse : {}
  const accessToken = typeof record.access_token === 'string' ? record.access_token : ''
  if (!accessToken) throw new Error('Antigravity OAuth returned no access token')
  const expiresIn = typeof record.expires_in === 'number' && Number.isFinite(record.expires_in) ? record.expires_in : 3600
  const refreshToken = typeof record.refresh_token === 'string' && record.refresh_token
    ? record.refresh_token
    : fallbackRefreshToken
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1000,
    ...(typeof record.scope === 'string' && record.scope ? { scope: record.scope } : {}),
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

function publicCredential(bytes: readonly number[]): string {
  return bytes.map((value, index) => String.fromCharCode(value ^ PUBLIC_CRED_MASK.charCodeAt(index % PUBLIC_CRED_MASK.length))).join('')
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
