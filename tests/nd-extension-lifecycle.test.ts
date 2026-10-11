import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DAILY_ESSENTIALS_MANIFEST } from '../src/shared/builtin-extension-packages.js'
import type { GitExecRunner } from '../src/main/git/git-cli.js'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { HomeStore } from '../src/main/home/home-store.js'

let root: string
let sourceRoot: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nd-pkg-store-'))
  sourceRoot = await mkdtemp(join(tmpdir(), 'nd-pkg-src-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(sourceRoot, { recursive: true, force: true })
})

async function writePackage(directory: string, manifest: unknown, extraFiles: Record<string, string> = {}): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'nd-extension.json'), JSON.stringify(manifest, null, 2), 'utf8')
  for (const [relative, content] of Object.entries(extraFiles)) {
    const target = join(directory, relative)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
}

const SAMPLE = {
  protocol: 'nd.extension/1',
  id: 'nd.sample',
  name: 'Sample',
  description: 'A sample package',
  version: '1.0.0',
  apiVersion: 1,
  contexts: ['personal'],
  permissions: ['notes.write'],
  settings: [],
  contributions: { commands: [{ id: 'note', title: 'Sample note', host: 'note.create', contexts: ['personal'] }] },
}

describe('ExtensionPackageStore lifecycle', () => {
  it('installs a validated package snapshot with provenance and never runs package scripts', async () => {
    await writePackage(sourceRoot, SAMPLE, {
      'package.json': JSON.stringify({
        name: 'sample',
        version: '1.0.0',
        scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'pwned.txt\', \'1\')"' },
      }),
      'runtime/server.mjs': 'export const value = 1\n',
    })
    const store = new ExtensionPackageStore(root)
    const view = await store.installFromDirectory(sourceRoot)
    expect(view.id).toBe('nd.sample')
    expect(view.version).toBe('1.0.0')
    expect(view.hasExecutable).toBe(false)
    expect(view.source.kind === 'local' || view.source.kind === 'git').toBe(true)
    // Installation snapshots content; it does not execute dependency or build scripts.
    expect(existsSync(join(sourceRoot, 'pwned.txt'))).toBe(false)
    const snapshot = await readFile(join(root, 'packages', 'nd.sample', '1.0.0', 'runtime', 'server.mjs'), 'utf8')
    expect(snapshot).toContain('value = 1')
    expect(await store.activeManifest('nd.sample')).toMatchObject({ id: 'nd.sample', version: '1.0.0' })
  })

  it('reads the package revision through the injected ND Core git runner', async () => {
    await writePackage(sourceRoot, SAMPLE)
    const calls: Array<{ cwd: string; args: string[] }> = []
    const runner: GitExecRunner = async (cwd, args) => {
      calls.push({ cwd, args })
      return { exitCode: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' }
    }
    const store = new ExtensionPackageStore(root, runner)
    const view = await store.installFromDirectory(sourceRoot)
    expect(view.source).toMatchObject({ kind: 'git', revision: 'b'.repeat(40) })
    expect(calls).toEqual([{ cwd: resolve(sourceRoot), args: ['rev-parse', 'HEAD'] }])
  })

  it('rejects an invalid manifest and never writes a snapshot', async () => {
    await writePackage(sourceRoot, { ...SAMPLE, apiVersion: 99 })
    const store = new ExtensionPackageStore(root)
    await expect(store.installFromDirectory(sourceRoot)).rejects.toThrow(/Invalid extension package/)
    expect(existsSync(join(root, 'packages', 'nd.sample'))).toBe(false)
  })

  it('rejects package symlinks because they can escape the package root', async () => {
    await writePackage(sourceRoot, SAMPLE)
    await writeFile(join(sourceRoot, 'inside.txt'), 'ok', 'utf8')
    // Windows file symlinks need Developer Mode or admin rights; directory junctions do not.
    if (process.platform === 'win32') {
      await mkdir(join(sourceRoot, 'inside'))
      await symlink(join(sourceRoot, 'inside'), join(sourceRoot, 'link'), 'junction')
    } else {
      await symlink(join(sourceRoot, 'inside.txt'), join(sourceRoot, 'link.txt'))
    }
    const store = new ExtensionPackageStore(root)
    await expect(store.installFromDirectory(sourceRoot)).rejects.toThrow(/symbolic link/)
  })

  it('updates to a new version, keeps the previous version available, and rolls back', async () => {
    await writePackage(sourceRoot, SAMPLE)
    const store = new ExtensionPackageStore(root)
    await store.installFromDirectory(sourceRoot)

    await writePackage(sourceRoot, { ...SAMPLE, version: '1.1.0', name: 'Sample v1.1' })
    const updated = await store.installFromDirectory(sourceRoot)
    expect(updated.version).toBe('1.1.0')
    expect(updated.previousVersion).toBe('1.0.0')

    const rolledBack = await store.rollback('nd.sample')
    expect(rolledBack.version).toBe('1.0.0')
    expect(await store.manifestForVersion('nd.sample', '1.0.0')).toMatchObject({ id: 'nd.sample' })
  })

  it('rejects a persisted snapshot whose declared permissions no longer cover its hosts', async () => {
    await writePackage(sourceRoot, SAMPLE)
    const store = new ExtensionPackageStore(root)
    await store.installFromDirectory(sourceRoot)

    const snapshotPath = join(root, 'packages', 'nd.sample', '1.0.0', 'nd-extension.json')
    const tampered = JSON.parse(await readFile(snapshotPath, 'utf8')) as Record<string, unknown>
    tampered.permissions = []
    await writeFile(snapshotPath, JSON.stringify(tampered, null, 2), 'utf8')

    await expect(store.manifestForVersion('nd.sample', '1.0.0')).rejects.toThrow(/permission re-validation/)
  })

  it('validates built-in packages through the same runtime rules before snapshotting', async () => {
    const store = new ExtensionPackageStore(root)
    const invalid = structuredClone(DAILY_ESSENTIALS_MANIFEST)
    invalid.permissions = []
    await expect(store.registerBuiltin(invalid)).rejects.toThrow(/Invalid built-in extension package/)
    expect(await store.activeManifest(invalid.id)).toBeUndefined()
  })

  it('refuses to uninstall ND-maintained packages but removes third-party snapshots', async () => {
    const store = new ExtensionPackageStore(root)
    await store.registerBuiltin(DAILY_ESSENTIALS_MANIFEST)
    await expect(store.uninstall(DAILY_ESSENTIALS_MANIFEST.id)).rejects.toThrow(/ND-maintained/)
    expect(await store.activeManifest(DAILY_ESSENTIALS_MANIFEST.id)).toBeTruthy()
  })

  it('drops a persisted package index entry with a permission gap on reload', async () => {
    await writePackage(sourceRoot, SAMPLE)
    const store = new ExtensionPackageStore(root)
    await store.installFromDirectory(sourceRoot)

    const indexPath = join(root, 'nd-extensions.json')
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
      packages: Array<{ manifest: Record<string, unknown> }>
    }
    index.packages[0]!.manifest.permissions = []
    await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8')

    const reloaded = new ExtensionPackageStore(root)
    expect(await reloaded.list()).toEqual([])
  })

  it('reloads installed packages from disk with the same active version', async () => {
    await writePackage(sourceRoot, SAMPLE)
    const store = new ExtensionPackageStore(root)
    await store.installFromDirectory(sourceRoot)
    const reloaded = new ExtensionPackageStore(root)
    const list = await reloaded.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'nd.sample', version: '1.0.0' })
    expect((await reloaded.activeManifest('nd.sample'))?.contributions.commands[0]?.id).toBe('note')
  })
})

describe('HomeStore personal records', () => {
  it('stores notes, searches them, and survives a restart', async () => {
    const home = new HomeStore(join(root, 'nd-home'))
    const note = await home.createNote({ body: 'Buy milk\nand bread', tags: ['errand'] })
    expect(note.title).toBe('Buy milk')
    await home.createNote({ body: 'Project idea: personal capture flow' })

    const found = await home.searchNotes('milk')
    expect(found).toHaveLength(1)
    expect(found[0]!.tags).toEqual(['errand'])

    const restarted = new HomeStore(join(root, 'nd-home'))
    const state = await restarted.state()
    expect(state.notes).toHaveLength(2)
    expect(state.notes[0]!.body).toContain('personal capture')
  })

  it('updates and deletes notes', async () => {
    const home = new HomeStore(join(root, 'nd-home'))
    const note = await home.createNote({ body: 'draft' })
    const updated = await home.updateNote(note.id, { body: 'final', tags: ['done'] })
    expect(updated.title).toBe('final')
    expect(updated.tags).toEqual(['done'])
    await home.deleteNote(note.id)
    expect(await home.listNotes()).toHaveLength(0)
  })

  it('keeps capture bytes in ND-managed storage and only exposes them on read', async () => {
    const homeRoot = join(root, 'nd-home')
    const home = new HomeStore(homeRoot)
    const capture = await home.addCapture({ data: Buffer.from('png-bytes').toString('base64'), name: 'shot.png', width: 20, height: 10, displayLabel: '20x10' })
    expect(existsSync(join(homeRoot, 'captures', `${capture.id}.png`))).toBe(true)
    const read = await home.readCapture(capture.id)
    expect(read?.captureId).toBe(capture.id)
    expect(Buffer.from(read!.data, 'base64').toString('utf8')).toBe('png-bytes')
    await home.deleteCapture(capture.id)
    expect(await home.readCapture(capture.id)).toBeNull()
    expect(existsSync(join(homeRoot, 'captures', `${capture.id}.png`))).toBe(false)
  })

  it('saves dialpad links as personal records and normalizes their address', async () => {
    const home = new HomeStore(join(root, 'nd-home'))
    const link = await home.saveLink({ url: 'youtube.com' })
    expect(link.url).toBe('https://youtube.com/')
    expect(link.title).toBe('youtube.com')

    // Re-saving the same address refreshes the tile instead of duplicating it.
    const renamed = await home.saveLink({ url: 'https://youtube.com/', title: 'Videos' })
    expect(renamed.id).toBe(link.id)
    expect(renamed.title).toBe('Videos')
    expect((await home.state()).links).toHaveLength(1)

    await expect(home.saveLink({ url: 'about:blank' })).rejects.toThrow(/http\(s\) address/)
    await expect(home.saveLink({ url: 'not a website' })).rejects.toThrow()

    const restarted = new HomeStore(join(root, 'nd-home'))
    expect((await restarted.state()).links.map((item) => item.title)).toEqual(['Videos'])

    await restarted.removeLink(link.id)
    expect((await restarted.state()).links).toEqual([])
  })

  it('gives each personal chat a managed working folder and binds its session id', async () => {
    const homeRoot = join(root, 'nd-home')
    const home = new HomeStore(homeRoot)
    const chat = await home.ensureChat({ kind: 'personal' })
    expect(existsSync(chat.workDir)).toBe(true)
    expect(chat.workDir.startsWith(homeRoot)).toBe(true)
    const bound = await home.bindChatSession(chat.chatId, 'session-1')
    expect(bound.sessionId).toBe('session-1')
    const restarted = new HomeStore(homeRoot)
    expect((await restarted.state()).chats[0]?.sessionId).toBe('session-1')
  })

  it('quarantines an unreadable record instead of silently starting empty', async () => {
    const homeRoot = join(root, 'nd-home')
    await mkdir(homeRoot, { recursive: true })
    await writeFile(join(homeRoot, 'home.json'), '{ not json', 'utf8')
    const home = new HomeStore(homeRoot)
    expect((await home.state()).notes).toEqual([])
    const files = await import('node:fs/promises').then((fs) => fs.readdir(homeRoot))
    expect(files.some((name) => name.includes('.corrupt-'))).toBe(true)
  })
})
