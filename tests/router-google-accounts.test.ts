import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'kwallet',
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (value: Buffer) => Buffer.from(value).toString().replace(/^enc:/, ''),
  },
  shell: { openExternal: vi.fn() },
}))

vi.mock('../src/main/google-oauth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/google-oauth.js')>()
  return { ...actual, authorizeAntigravityAccount: authorizeMock }
})

import { antigravityClientId } from '../src/main/google-oauth.js'
import { RouterGoogleAccounts } from '../src/main/router/google-accounts.js'
import { ProviderAccountService } from '../src/main/token-saver/provider-account-service.js'

const directories: string[] = []

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

beforeEach(() => {
  authorizeMock.mockReset()
})

describe('RouterGoogleAccounts', () => {
  it('writes an authorized_user credentials file for the agy CLI and reuses it per email', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-router-google-'))
    directories.push(root)
    authorizeMock.mockResolvedValue({
      email: 'User@Example.com',
      tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 },
    })
    const accounts = new RouterGoogleAccounts(root)

    const connected = await accounts.connect()
    expect(connected.email).toBe('User@Example.com')
    expect(connected.adcPath.startsWith(root)).toBe(true)
    expect(authorizeMock).toHaveBeenCalledWith(expect.objectContaining({
      callbackPath: '/oauth/google/callback',
      prompt: 'select_account consent',
    }))

    const record = JSON.parse(await readFile(connected.adcPath, 'utf8')) as Record<string, unknown>
    expect(record).toMatchObject({
      type: 'authorized_user',
      client_id: antigravityClientId(),
      refresh_token: 'refresh',
      account: 'User@Example.com',
    })
    expect(typeof record.client_secret).toBe('string')
    if (process.platform !== 'win32') {
      expect((await stat(connected.adcPath)).mode & 0o777).toBe(0o600)
    }

    const again = await accounts.connect()
    expect(again.adcPath).toBe(connected.adcPath)

    accounts.removeManagedFile(join(root, '..', 'outside-google-oauth.json'))
    expect(existsSync(connected.adcPath)).toBe(true)
    accounts.removeManagedFile(connected.adcPath)
    expect(existsSync(connected.adcPath)).toBe(false)
  })

  it('refuses a sign-in that returns no refresh token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-router-google-'))
    directories.push(root)
    authorizeMock.mockResolvedValue({
      email: 'user@example.com',
      tokens: { accessToken: 'access', expiresAt: Date.now() + 3_600_000 },
    })
    await expect(new RouterGoogleAccounts(root).connect()).rejects.toThrow(/refresh token/)
  })

  it('exports the signed-in Antigravity account for the router without a new browser flow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-router-google-export-'))
    directories.push(root)
    const service = new ProviderAccountService(root)
    ;(service as unknown as { antigravityTokens: unknown }).antigravityTokens = {
      accessToken: 'access',
      refreshToken: 'refresh-from-token-saver',
      expiresAt: Date.now() + 3_600_000,
    }
    ;(service as unknown as { metadata: unknown }).metadata = {
      version: 1,
      antigravity: { email: 'signed-in@example.com', expiresAt: Date.now() + 3_600_000 },
    }

    const exported = service.exportAntigravityAuthorizedUser(join(root, 'google-oauth'))
    expect(exported?.email).toBe('signed-in@example.com')
    const record = JSON.parse(await readFile(exported!.adcPath, 'utf8')) as Record<string, unknown>
    expect(record).toMatchObject({
      type: 'authorized_user',
      refresh_token: 'refresh-from-token-saver',
      account: 'signed-in@example.com',
    })
    expect(exported!.adcPath).toBe(join(root, 'google-oauth', `${createHash('sha256').update('signed-in@example.com').digest('hex').slice(0, 24)}.json`))
  })
})
