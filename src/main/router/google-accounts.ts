import { rmSync } from 'node:fs'
import {
  antigravityClientId,
  antigravityClientSecret,
  authorizeAntigravityAccount,
  googleAuthorizedUserPath,
  writeGoogleAuthorizedUserFile,
} from '../google-oauth.js'
import { isInsideDirectory } from './local-release.js'

export interface RouterGoogleAccount {
  email: string
  /** Google authorized_user credentials file the agy CLI reads via AGY_ADC_AUTH. */
  adcPath: string
}

/**
 * Google OAuth accounts for the Router's Antigravity lane.
 *
 * The installed CLI performs model calls and refreshes the authorized_user
 * file. ND owns only the browser sign-in and the per-account credentials file;
 * the renderer never receives a token, and the file is written 0600 under ND's
 * router data directory.
 */
export class RouterGoogleAccounts {
  private connecting = false

  constructor(private readonly rootDir: string) {}

  async connect(): Promise<RouterGoogleAccount> {
    if (this.connecting) throw new Error('A Google sign-in is already in progress')
    this.connecting = true
    try {
      const { tokens, email } = await authorizeAntigravityAccount({
        callbackPath: '/oauth/google/callback',
        // Always show the account chooser: one provider may hold several Google accounts.
        prompt: 'select_account consent',
      })
      if (!email) throw new Error('Google did not return an account email')
      if (!tokens.refreshToken) {
        throw new Error('Google did not return a refresh token. Remove ND from your Google account’s third-party access, then connect again.')
      }
      const adcPath = googleAuthorizedUserPath(this.rootDir, email)
      writeGoogleAuthorizedUserFile(adcPath, {
        clientId: antigravityClientId(),
        clientSecret: antigravityClientSecret(),
        refreshToken: tokens.refreshToken,
        email,
      })
      return { email, adcPath }
    } finally {
      this.connecting = false
    }
  }

  /** Only files under ND's OAuth directory are ours to delete. */
  isManagedPath(path: string): boolean {
    return isInsideDirectory(this.rootDir, path)
  }

  removeManagedFile(path: string): void {
    if (!this.isManagedPath(path)) return
    rmSync(path, { force: true })
  }
}
