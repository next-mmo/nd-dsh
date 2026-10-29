import { safeStorage } from 'electron'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

interface PersistedExternalKey {
  version: 1
  /** safeStorage ciphertext, base64. Never a plaintext key. */
  key: string
}

export interface RouterKeyCipher {
  available(): boolean
  encrypt(value: string): string
  decrypt(value: string): string
}

export interface RouterExternalKeyValue {
  key: string
  persisted: boolean
}

export function defaultRouterKeyCipher(): RouterKeyCipher {
  return {
    available: () => {
      if (!safeStorage.isEncryptionAvailable()) return false
      // Linux may fall back to a plaintext "basic_text" backend; never use it.
      if (process.platform !== 'linux') return true
      const backend = safeStorage.getSelectedStorageBackend()
      return backend !== 'basic_text' && backend !== 'unknown'
    },
    encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  }
}

/**
 * Stable ND-generated credential for local apps that call ND Router directly.
 *
 * The provider/router keys stay in memory or in OS-backed encrypted storage;
 * this key only grants ND Router access and is never written in plaintext.
 */
export class RouterExternalKeyStore {
  private current: RouterExternalKeyValue | undefined

  constructor(
    private readonly filePath: string,
    private readonly cipher: RouterKeyCipher = defaultRouterKeyCipher(),
    private readonly log: (message: string) => void = (message) => console.warn(message),
  ) {}

  loadOrCreate(): RouterExternalKeyValue {
    if (this.current) return this.current
    const existing = this.readPersisted()
    this.current = existing ? { key: existing, persisted: true } : this.create()
    return this.current
  }

  reveal(): RouterExternalKeyValue {
    return this.loadOrCreate()
  }

  rotate(): RouterExternalKeyValue {
    this.current = this.create()
    return this.current
  }

  private create(): RouterExternalKeyValue {
    const key = `ndr_ext_${randomBytes(24).toString('base64url')}`
    if (!this.cipher.available()) {
      this.log('ND Router external API key is memory-only: OS-backed secure storage is unavailable.')
      return { key, persisted: false }
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
      const payload: PersistedExternalKey = { version: 1, key: this.cipher.encrypt(key) }
      try {
        writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 })
        renameSync(tmp, this.filePath)
      } finally {
        if (existsSync(tmp)) rmSync(tmp, { force: true })
      }
      if (process.platform !== 'win32') {
        try {
          chmodSync(this.filePath, 0o600)
        } catch {
          // Best effort; the file is already created with 0600 where supported.
        }
      }
      return { key, persisted: true }
    } catch (error) {
      this.log(`ND Router external API key could not be persisted: ${error instanceof Error ? error.message : String(error)}`)
      return { key, persisted: false }
    }
  }

  private readPersisted(): string | undefined {
    if (!existsSync(this.filePath)) return undefined
    if (!this.cipher.available()) return undefined
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PersistedExternalKey>
      if (parsed.version !== 1 || typeof parsed.key !== 'string' || !parsed.key) return undefined
      const key = this.cipher.decrypt(parsed.key)
      return key.trim() ? key : undefined
    } catch (error) {
      this.log(`ND Router external API key could not be read: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
}