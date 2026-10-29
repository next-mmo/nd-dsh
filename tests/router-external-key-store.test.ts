import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'kwallet',
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (value: Buffer) => Buffer.from(value).toString().replace(/^enc:/, ''),
  },
}))

import { RouterExternalKeyStore, type RouterKeyCipher } from '../src/main/router/external-key-store.js'

const cipher: RouterKeyCipher = {
  available: () => true,
  encrypt: (value) => Buffer.from(`enc:${value}`).toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').toString().replace(/^enc:/, ''),
}

describe('RouterExternalKeyStore', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nd-router-key-'))
    file = join(dir, 'external-key.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates, reloads and rotates an encrypted external key', () => {
    const store = new RouterExternalKeyStore(file, cipher)
    const first = store.loadOrCreate()
    expect(first.persisted).toBe(true)
    expect(first.key.startsWith('ndr_ext_')).toBe(true)
    const raw = readFileSync(file, 'utf8')
    expect(raw).toContain('"version":1')
    expect(raw).not.toContain(first.key)

    const reloaded = new RouterExternalKeyStore(file, cipher).loadOrCreate()
    expect(reloaded.key).toBe(first.key)
    expect(reloaded.persisted).toBe(true)

    const rotated = store.rotate()
    expect(rotated.key).not.toBe(first.key)
    expect(new RouterExternalKeyStore(file, cipher).loadOrCreate().key).toBe(rotated.key)
  })

  it('never writes plaintext when OS-backed storage is unavailable', () => {
    const unavailable: RouterKeyCipher = { available: () => false, encrypt: () => '', decrypt: () => '' }
    const store = new RouterExternalKeyStore(file, unavailable, () => undefined)
    const value = store.loadOrCreate()
    expect(value.persisted).toBe(false)
    expect(value.key.startsWith('ndr_ext_')).toBe(true)
    expect(existsSync(file)).toBe(false)
  })
})