import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8'),
  },
}))

import { BrowserCredentialVault } from '../src/main/browser/browser-credential-vault.js'
import { BrowserHistoryStore } from '../src/main/browser/browser-history-store.js'
import { BrowserPermissionStore } from '../src/main/browser/browser-permission-store.js'
import { BrowserProfileStore, browserProfilePartition } from '../src/main/browser-profiles/browser-profile-store.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nd-browser-profiles-'))
  roots.push(root)
  return root
}

describe('BrowserProfileStore', () => {
  it('seeds the default profile on the historical partition', async () => {
    const root = await tempRoot()
    const store = new BrowserProfileStore(join(root, 'browser-profiles.json'))
    await store.initialize()

    const profiles = await store.list()
    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({ id: 'default', name: 'Default' })
    expect(store.activeProfileId()).toBe('default')
    expect(store.defaultProfileId()).toBe('default')

    expect(browserProfilePartition('default')).toBe('persist:nd-dsh-browser')
    expect(browserProfilePartition('0b6a2f5e-1f47-4a33-9c5c-6f0a2c1f9d11'))
      .toBe('persist:nd-dsh-browser-0b6a2f5e-1f47-4a33-9c5c-6f0a2c1f9d11')
    expect(() => browserProfilePartition('bad id!')).toThrow(/invalid/i)
  })

  it('creates, renames, defaults, and deletes profiles durably', async () => {
    const root = await tempRoot()
    const path = join(root, 'browser-profiles.json')
    const store = new BrowserProfileStore(path)
    await store.initialize()

    const work = await store.create('Work')
    expect(work.id).toMatch(/^[0-9a-f-]{36}$/)
    await expect(store.create('work')).rejects.toThrow(/already exists/i)

    await store.update(work.id, { name: 'Client', color: '#12a594' })
    await store.setDefault(work.id)
    await store.setActive(work.id)

    const reopened = new BrowserProfileStore(path)
    await reopened.initialize()
    expect(reopened.activeProfileId()).toBe(work.id)
    expect(reopened.defaultProfileId()).toBe(work.id)
    expect(await reopened.get(work.id)).toMatchObject({ name: 'Client', color: '#12a594' })
    expect(reopened.profileName(work.id)).toBe('Client')

    await expect(reopened.remove('default')).rejects.toThrow(/cannot be deleted/i)
    await reopened.remove(work.id)
    expect(reopened.activeProfileId()).toBe('default')
    expect(reopened.defaultProfileId()).toBe('default')
    expect((await reopened.list()).map((profile) => profile.id)).toEqual(['default'])
  })

  it('quarantines an unreadable profile file instead of overwriting it', async () => {
    const root = await tempRoot()
    const path = join(root, 'browser-profiles.json')
    await writeFile(path, '{ not json', 'utf8')

    const store = new BrowserProfileStore(path)
    await store.initialize()
    expect((await store.list()).map((profile) => profile.id)).toEqual(['default'])

    const files = await readdir(root)
    expect(files.some((name) => name.startsWith('browser-profiles.json.corrupt-'))).toBe(true)
  })
})

describe('profile-scoped browser data', () => {
  it('keeps history and site permissions isolated per profile', async () => {
    const root = await tempRoot()
    const history = new BrowserHistoryStore(join(root, 'history.json'))
    await history.record({ targetId: 'builtin', tabId: 'a', url: 'https://a.test/', title: 'A', profileId: 'default' })
    await history.record({ targetId: 'builtin', tabId: 'b', url: 'https://b.test/', title: 'B', profileId: 'work' })
    expect((await history.list('builtin', 'default')).map((entry) => entry.title)).toEqual(['A'])
    expect((await history.list('builtin', 'work')).map((entry) => entry.title)).toEqual(['B'])

    const permissions = new BrowserPermissionStore(join(root, 'permissions.json'))
    await permissions.initialize()
    await permissions.set('https://a.test', 'notifications', 'allow', 'default')
    expect(permissions.effect('https://a.test', 'notifications', 'default')).toBe('allow')
    expect(permissions.effect('https://a.test', 'notifications', 'work')).toBe('deny')
    expect(permissions.list('work')).toEqual([])
    await permissions.clear(undefined, 'default')
    expect(permissions.list('default')).toEqual([])
  })

  it('normalizes pre-profile history and permissions into the default profile', async () => {
    const root = await tempRoot()
    const historyPath = join(root, 'history.json')
    await writeFile(historyPath, JSON.stringify({
      version: 1,
      entries: [{ id: 'legacy', targetId: 'builtin', tabId: 't', url: 'https://legacy.test/', title: 'Legacy', visitedAt: 1 }],
    }), 'utf8')
    const history = new BrowserHistoryStore(historyPath)
    expect((await history.list('builtin', 'default')).map((entry) => entry.id)).toEqual(['legacy'])

    const permissionPath = join(root, 'permissions.json')
    await writeFile(permissionPath, JSON.stringify({
      version: 1,
      permissions: [{ origin: 'https://legacy.test', permission: 'notifications', effect: 'allow', updatedAt: 1 }],
    }), 'utf8')
    const permissions = new BrowserPermissionStore(permissionPath)
    await permissions.initialize()
    expect(permissions.effect('https://legacy.test', 'notifications', 'default')).toBe('allow')
    expect(permissions.list('default')).toHaveLength(1)
  })

  it('keeps saved credentials inside the profile that saved them', async () => {
    const root = await tempRoot()
    const vault = new BrowserCredentialVault(join(root, 'credentials.json'))
    await vault.save({ origin: 'https://a.test', username: 'default-user', password: 'secret-1' }, 'default')
    await vault.save({ origin: 'https://a.test', username: 'work-user', password: 'secret-2' }, 'work')

    expect((await vault.list('default')).map((item) => item.username)).toEqual(['default-user'])
    expect((await vault.list('work')).map((item) => item.username)).toEqual(['work-user'])

    const workCredential = (await vault.list('work'))[0]!
    await expect(vault.secret(workCredential.id, undefined, 'default'))
      .rejects.toThrow(/different browser profile/i)
    expect((await vault.secret(workCredential.id, 'https://a.test', 'work')).password).toBe('secret-2')

    expect(await vault.removeProfile('work')).toBe(1)
    expect(await vault.list('work')).toEqual([])
  })
})
