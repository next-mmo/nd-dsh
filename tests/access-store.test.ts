import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value.split('').reverse().join(''), 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').split('').reverse().join(''),
  },
}))

import { AccessStore } from '../src/main/extensions/access-store.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempStore(): Promise<{ store: AccessStore; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'nd-access-'))
  roots.push(root)
  const path = join(root, 'accounts.json')
  return { store: new AccessStore(path), path }
}

const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const PASSWORD = 'abcd efgh ijkl mnop'

describe('AccessStore', () => {
  it('stores sealed secrets and lists metadata only', async () => {
    const { store, path } = await tempStore()
    const created = await store.create({
      email: 'Owner@Example.com',
      label: 'Personal',
      appPassword: PASSWORD,
      totpSecret: `otpauth://totp/Test?secret=${SEED}`,
    })

    expect(created.email).toBe('owner@example.com')
    expect(created.hasPassword).toBe(true)
    expect(created.hasTotp).toBe(true)
    expect(created).not.toHaveProperty('encryptedPassword')

    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0]).not.toHaveProperty('encryptedPassword')

    const secrets = await store.secrets(created.id)
    expect(secrets.appPassword).toBe(PASSWORD)
    expect(secrets.totpSecret).toBe(SEED)

    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain(PASSWORD)
    expect(raw).not.toContain(SEED)
  })

  it('updates label and rotates secrets', async () => {
    const { store } = await tempStore()
    const created = await store.create({ email: 'a@b.co', appPassword: 'first-secret' })
    const updated = await store.update(created.id, { label: 'Work', appPassword: 'second-secret' })
    expect(updated.label).toBe('Work')
    expect((await store.secrets(created.id)).appPassword).toBe('second-secret')
    expect(updated.hasTotp).toBe(false)
  })

  it('rejects duplicates, bad emails, and missing secrets', async () => {
    const { store } = await tempStore()
    await store.create({ email: 'a@b.co', appPassword: 'secret-one' })
    await expect(store.create({ email: 'A@B.CO', appPassword: 'secret-two' })).rejects.toThrow(/already has/i)
    await expect(store.create({ email: 'not-an-email', appPassword: 'secret' })).rejects.toThrow(/valid mailbox email/i)
    await expect(store.create({ email: 'c@d.co', appPassword: '' })).rejects.toThrow(/required/i)
    await expect(store.create({ email: 'c@d.co', appPassword: 'secret', totpSecret: 'nope!' })).rejects.toThrow(/Base32/i)
  })

  it('deletes accounts and their sealed secrets', async () => {
    const { store } = await tempStore()
    const created = await store.create({ email: 'a@b.co', appPassword: 'secret' })
    expect(await store.remove(created.id)).toBe(true)
    expect(await store.remove(created.id)).toBe(false)
    expect(await store.list()).toEqual([])
    await expect(store.secrets(created.id)).rejects.toThrow(/not found/i)
  })
})
