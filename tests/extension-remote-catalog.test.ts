import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteExtensionCatalog } from '../src/main/extensions/remote-catalog.js'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'

const manifest = { protocol: 'nd.extension/1', id: 'nd.audit', name: 'Audit', description: 'Fixture', version: '1.0.0', apiVersion: 1,
  contexts: ['personal'], permissions: [], settings: [], contributions: { views: [{ id: 'main', title: 'Audit', kind: 'web', entry: 'ui/index.html', contexts: ['personal'] }] } }
const payloads: Record<string, string> = { 'nd-extension.json': JSON.stringify(manifest), 'ui/index.html': '<p>Fixture</p>' }
function entry() {
  return { manifest, revision: 'a'.repeat(40), directory: 'audit', files: Object.entries(payloads).map(([path, data]) => ({
    path, bytes: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex'),
  })) }
}
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function root() { const path = await mkdtemp(join(tmpdir(), 'nd-catalog-test-')); roots.push(path); return path }

describe('on-demand extension catalog', () => {
  it('does no network work until Discover and downloads only the selected package on Install', async () => {
    const request = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === 'https://example.test/catalog.json') return Response.json({ version: 1, packages: [entry()] })
      const key = Object.keys(payloads).find((path) => String(url).endsWith(`/${path}`))
      return new Response(key ? payloads[key] : '', { status: key ? 200 : 404 })
    }) as unknown as typeof fetch
    const catalog = new RemoteExtensionCatalog('https://example.test/catalog.json', request)
    expect(request).not.toHaveBeenCalled()
    await catalog.refresh()
    expect(request).toHaveBeenCalledTimes(1)
    expect(catalog.views(new Set())[0]).toMatchObject({ id: 'nd.audit', installed: false })
    const directory = await root()
    const packages = new ExtensionPackageStore(join(directory, 'packages'), async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    await catalog.install('nd.audit', packages, join(directory, 'downloads'))
    expect(request).toHaveBeenCalledTimes(3)
    expect(await packages.activeManifest('nd.audit')).toMatchObject({ id: 'nd.audit' })
    expect((await packages.record('nd.audit'))?.source).toMatchObject({ kind: 'remote', revision: 'a'.repeat(40) })
  })

  it('keeps compatible packages discoverable when the catalog includes a newer host API', async () => {
    const newer = { ...entry(), manifest: { ...manifest, id: 'nd.future', apiVersion: 99 } }
    const request = vi.fn(async () => Response.json({ version: 1, packages: [newer, entry()] })) as unknown as typeof fetch
    const catalog = new RemoteExtensionCatalog('https://example.test/catalog.json', request)
    await catalog.refresh()
    expect(catalog.views(new Set()).map((item) => item.id)).toEqual(['nd.audit'])
  })

  it('rejects a corrupt download without installing any package', async () => {
    const directory = await root()
    const request = vi.fn(async (url: string | URL | Request) => String(url).endsWith('catalog.json')
      ? Response.json({ version: 1, packages: [entry()] }) : new Response('corrupt')) as unknown as typeof fetch
    const catalog = new RemoteExtensionCatalog('https://example.test/catalog.json', request)
    const packages = new ExtensionPackageStore(join(directory, 'packages'))
    await expect(catalog.install('nd.audit', packages, join(directory, 'downloads'))).rejects.toThrow(/integrity|size limit/)
    expect(await packages.list()).toEqual([])
  })

  it.each(['../escape', '/absolute', 'C:/drive', 'ui/../escape', 'ui\\escape'])('rejects unsafe catalog paths: %s', async (path) => {
    const raw = entry(); raw.files[0]!.path = path
    const request = vi.fn(async () => Response.json({ version: 1, packages: [raw] })) as unknown as typeof fetch
    await expect(new RemoteExtensionCatalog('https://example.test/catalog.json', request).refresh()).rejects.toThrow(/Invalid catalog file/)
  })

  it('rejects an oversized catalog response before parsing it', async () => {
    const request = vi.fn(async () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024) } })) as unknown as typeof fetch
    await expect(new RemoteExtensionCatalog('https://example.test/catalog.json', request).refresh()).rejects.toThrow(/size limit/)
  })
})
