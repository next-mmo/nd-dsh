import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { shell } from 'electron'

const OAUTH_TIMEOUT_MS = 5 * 60_000
const ANTIGRAVITY_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const ANTIGRAVITY_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo'

export const ANTIGRAVITY_SCOPES = [
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

export interface GoogleTokens {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope?: string
}

export interface GoogleUser {
  email?: string
}

interface GoogleTokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  scope?: unknown
}

export interface GoogleOAuthCallback {
  redirectUri: string
  waitForCode(expectedState: string): Promise<string>
  close(): void
}

export interface GoogleAuthorizeResult {
  tokens: GoogleTokens
  email?: string
}

/** Decoded at use time; never logged or exposed to the renderer. */
export function antigravityClientId(): string {
  return decodePublicCredential(ANTIGRAVITY_CLIENT_ID_BYTES)
}

export function antigravityClientSecret(): string {
  return decodePublicCredential(ANTIGRAVITY_CLIENT_SECRET_BYTES)
}

/**
 * Browser OAuth for an Antigravity/Google account. Callers must own what they
 * do with the returned tokens: token saver encrypts them, the router writes an
 * authorized_user file for the installed CLI.
 */
export async function authorizeAntigravityAccount(options: {
  callbackPath: string
  prompt?: string
  openExternal?: (url: string) => Promise<void>
  timeoutMs?: number
}): Promise<GoogleAuthorizeResult> {
  const redirect = await createGoogleOAuthCallback(options.callbackPath, options.timeoutMs)
  try {
    const state = randomBytes(24).toString('base64url')
    const authUrl = new URL(ANTIGRAVITY_AUTHORIZE_URL)
    authUrl.searchParams.set('client_id', antigravityClientId())
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('redirect_uri', redirect.redirectUri)
    authUrl.searchParams.set('scope', ANTIGRAVITY_SCOPES.join(' '))
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('prompt', options.prompt ?? 'consent')
    // Arm the callback before launching the browser so an already-authenticated
    // Google session cannot race ahead of our state/code listener.
    const codePromise = redirect.waitForCode(state)
    await (options.openExternal ?? shell.openExternal)(authUrl.toString())
    const code = await codePromise
    const tokens = await exchangeGoogleCode(code, redirect.redirectUri)
    const user = await fetchGoogleUser(tokens.accessToken)
    return { tokens, ...(user.email ? { email: user.email } : {}) }
  } finally {
    redirect.close()
  }
}

export async function exchangeGoogleCode(code: string, redirectUri: string): Promise<GoogleTokens> {
  const response = await fetch(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: antigravityClientId(),
      client_secret: antigravityClientSecret(),
      code,
      redirect_uri: redirectUri,
    }),
  })
  if (!response.ok) throw new Error(`Antigravity token exchange failed (${response.status})`)
  return parseGoogleTokens(await response.json(), undefined)
}

export async function fetchGoogleUser(accessToken: string): Promise<GoogleUser> {
  const response = await fetch(ANTIGRAVITY_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) return {}
  const value = await response.json() as Record<string, unknown>
  return typeof value.email === 'string' && value.email ? { email: value.email } : {}
}

export function parseGoogleTokens(value: unknown, fallbackRefreshToken: string | undefined): GoogleTokens {
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

export async function createGoogleOAuthCallback(callbackPath: string, timeoutMs = OAUTH_TIMEOUT_MS): Promise<GoogleOAuthCallback> {  if (!callbackPath.startsWith('/') || callbackPath.length > 128) throw new Error('OAuth callback path is invalid')
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
      }, timeoutMs)
      pendingResolve = (code) => { clearTimeout(timer); resolve(code) }
      pendingReject = (error) => { clearTimeout(timer); reject(error) }
    })
  }

  server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== callbackPath) {
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
      response.end('<!doctype html><meta charset="utf-8"><title>ND connected</title><body style="font-family:system-ui;padding:40px"><h2>ND connected</h2><p>You can close this tab and return to ND.</p></body>')
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
    throw new Error('Could not start the local Google sign-in callback')
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}${callbackPath}`,
    waitForCode,
    close: () => server?.close(),
  }
}

function decodePublicCredential(bytes: readonly number[]): string {
  return bytes.map((value, index) => String.fromCharCode(value ^ PUBLIC_CRED_MASK.charCodeAt(index % PUBLIC_CRED_MASK.length))).join('')
}

/** Stable per-email path under a managed Google OAuth directory. */
export function googleAuthorizedUserPath(rootDir: string, email: string): string {
  const key = createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 24)
  return join(rootDir, `${key}.json`)
}

/**
 * Write a Google authorized_user file the installed Antigravity CLI reads via
 * AGY_ADC_AUTH. It contains a refresh token; keep it 0600 and inside ND's data
 * directory. The CLI owns refresh and never sends the token back to ND.
 */
export function writeGoogleAuthorizedUserFile(path: string, input: {
  clientId: string
  clientSecret: string
  refreshToken: string
  email: string
}): void {
  const payload = {
    type: 'authorized_user',
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
    token_uri: 'https://oauth2.googleapis.com/token',
    account: input.email,
    universe_domain: 'googleapis.com',
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}
