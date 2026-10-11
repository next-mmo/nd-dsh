import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  WALLPAPER_LINKS_MAX,
  WALLPAPER_LINKS_SCHEMA,
  isPrivateHostname,
  parseWallpaperLinkUrl,
  parseWallpaperLinksBundle,
} from '../src/shared/wallpaper-links.js'
import {
  WallpaperLinkStore,
  addBundledWallpaperLink,
  bundledWallpaperLinksPath,
  bundledWallpaperLinksWithSource,
  collectionEntryId,
  downloadWallpaperImage,
  findCachedImage,
  linkIdForUrl,
  readWallpaperLinksBundle,
  removeBundledWallpaperLink,
  updateBundledWallpaperLink,
  validateCollectionFileRef,
  writeBundledCollections,
} from '../src/main/os/wallpaper-links.js'

/** A DNS answer that points at a public address, except loopback, which resolves truthfully. */
const publicDns = {
  lookup: async (hostname: string) => [{ address: hostname === '127.0.0.1' ? '127.0.0.1' : '93.184.216.34' }],
}

describe('wallpaper link URL validation', () => {
  it('accepts public https image links', () => {
    const url = parseWallpaperLinkUrl('https://example.com/images/wallpaper.jpg')
    expect(url.protocol).toBe('https:')
  })

  it('rejects non-https schemes and garbage', () => {
    for (const bad of [
      'http://example.com/a.jpg',
      'ftp://example.com/a.jpg',
      'file:///C:/Windows/a.jpg',
      'javascript:alert(1)',
      'not a url',
      '',
      '   ',
    ]) {
      expect(() => parseWallpaperLinkUrl(bad)).toThrow()
    }
  })

  it('rejects loopback, private, and .local hostnames', () => {
    for (const bad of [
      'https://localhost/a.jpg',
      'https://localhost:443/a.jpg',
      'https://sub.localhost/a.jpg',
      'https://127.0.0.1/a.jpg',
      'https://10.1.2.3/a.jpg',
      'https://172.16.0.9/a.jpg',
      'https://172.31.255.1/a.jpg',
      'https://192.168.1.10/a.jpg',
      'https://169.254.1.1/a.jpg',
      'https://0.0.0.0/a.jpg',
      'https://[::1]/a.jpg',
      'https://[fe80::1]/a.jpg',
      'https://[fd00::1]/a.jpg',
      'https://printer.local/a.jpg',
      'https://nas.internal/a.jpg',
      'https://[::ffff:192.168.0.1]/a.jpg',
    ]) {
      expect(() => parseWallpaperLinkUrl(bad), bad).toThrow(/private|local/i)
    }
  })

  it('rejects embedded credentials and non-standard ports', () => {
    expect(() => parseWallpaperLinkUrl('https://user:pass@example.com/a.jpg')).toThrow(/credentials/i)
    expect(() => parseWallpaperLinkUrl('https://example.com:8443/a.jpg')).toThrow(/port/i)
  })

  it('treats public addresses and hostnames as reachable', () => {
    expect(isPrivateHostname('example.com')).toBe(false)
    expect(isPrivateHostname('8.8.8.8')).toBe(false)
    expect(isPrivateHostname('172.32.0.1')).toBe(false)
    expect(isPrivateHostname('::1')).toBe(true)
  })
})

describe('wallpaper links bundle parsing', () => {
  it('accepts a well-formed bundle and normalizes titles', () => {
    const bundle = parseWallpaperLinksBundle({
      schema: WALLPAPER_LINKS_SCHEMA,
      name: 'My set',
      links: [
        { url: 'https://example.com/a.jpg', title: 'A', thumb: 'https://cdn.example.com/a-small.jpg' },
        { url: 'https://example.com/b.jpg' },
      ],
    })
    expect(bundle.name).toBe('My set')
    expect(bundle.links).toHaveLength(2)
    expect(bundle.links[1]!.title).toBe('example.com')
    expect(bundle.links[0]!.thumb).toBe('https://cdn.example.com/a-small.jpg')
  })

  it('keeps a link whose thumb URL is invalid', () => {
    const bundle = parseWallpaperLinksBundle({
      schema: WALLPAPER_LINKS_SCHEMA,
      name: 'Broken thumbs',
      links: [
        { url: 'https://example.com/a.jpg', thumb: 'http://insecure.example.com/a.jpg' },
        { url: 'https://example.com/b.jpg', thumb: 'not a url' },
      ],
    })
    expect(bundle.links).toHaveLength(2)
    expect(bundle.links.every((seed) => seed.thumb === undefined)).toBe(true)
  })

  it('skips invalid entries instead of failing the whole bundle', () => {
    const bundle = parseWallpaperLinksBundle({
      schema: WALLPAPER_LINKS_SCHEMA,
      name: 'Mixed',
      links: [
        { url: 'https://example.com/good.jpg' },
        { url: 'http://example.com/insecure.jpg' },
        { url: 'https://127.0.0.1/private.jpg' },
        'not-an-object',
        {},
      ],
    })
    expect(bundle.links).toHaveLength(1)
    expect(bundle.links[0]!.url).toBe('https://example.com/good.jpg')
  })

  it('rejects wrong schemas and non-objects', () => {
    expect(() => parseWallpaperLinksBundle({ schema: 'other/1', links: [] })).toThrow(/format/i)
    expect(() => parseWallpaperLinksBundle('nope')).toThrow()
    expect(() => parseWallpaperLinksBundle({ schema: WALLPAPER_LINKS_SCHEMA })).toThrow(/links/i)
  })

  it('carries bundle categories through and normalizes them', () => {
    const bundle = parseWallpaperLinksBundle({
      schema: WALLPAPER_LINKS_SCHEMA,
      name: 'Categories',
      links: [
        { url: 'https://example.com/a.jpg', category: '  Nature  ' },
        { url: 'https://example.com/b.jpg', category: '' },
        { url: 'https://example.com/c.jpg', category: 42 },
      ],
    })
    expect(bundle.links[0]!.category).toBe('Nature')
    expect(bundle.links[1]!.category).toBeUndefined()
    expect(bundle.links[2]!.category).toBeUndefined()
  })

  it('parses curated collections as link-only, deduped and validated', () => {
    const bundle = parseWallpaperLinksBundle({
      schema: WALLPAPER_LINKS_SCHEMA,
      name: 'With collections',
      links: [],
      collections: [
        {
          id: 'col-1',
          name: 'Nature',
          entries: [
            { kind: 'link', ref: 'https://example.com/a.jpg', title: 'A' },
            { kind: 'link', ref: 'https://example.com/a.jpg', title: 'dup' },
            { kind: 'link', ref: 'http://insecure.example.com/b.jpg' },
            { kind: 'file', ref: 'C:/Users/someone/Pictures/x.jpg' },
            'garbage',
          ],
        },
        { name: '' },
        { name: 'Empty', entries: [] },
      ],
    })
    expect(bundle.collections).toHaveLength(2)
    expect(bundle.collections![0]!.name).toBe('Nature')
    expect(bundle.collections![0]!.entries).toHaveLength(1)
    expect(bundle.collections![0]!.entries[0]!.ref).toBe('https://example.com/a.jpg')
    expect(bundle.collections![1]!.name).toBe('Empty')
  })
})

describe('wallpaper link store', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nd-wallpaper-links-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('adds, lists, dedupes by URL, and persists across instances', async () => {
    const path = join(dir, 'links.json')
    const store = new WallpaperLinkStore(path, () => 1_000)
    await store.initialize()
    const first = await store.add('https://example.com/a.jpg', 'Alpha')
    const duplicate = await store.add('https://example.com/a.jpg')
    expect(first.created).toBe(true)
    expect(duplicate.created).toBe(false)
    expect(duplicate.link.id).toBe(first.link.id)
    expect(store.list()).toHaveLength(1)

    await store.add('https://example.com/b.jpg', 'Beta')
    const reopened = new WallpaperLinkStore(path)
    await reopened.initialize()
    expect(reopened.list().map((link) => link.title)).toEqual(['Alpha', 'Beta'])
    expect(reopened.list().every((link) => link.source === 'user')).toBe(true)
  })

  it('records cache state and removes links', async () => {
    const store = new WallpaperLinkStore(join(dir, 'links.json'))
    await store.initialize()
    const { link } = await store.add('https://example.com/a.jpg', 'Alpha')
    const updated = await store.recordCache(link.id, { path: '/cache/a.jpg', size: 1234 })
    expect(updated?.cachedPath).toBe('/cache/a.jpg')
    const removal = await store.remove('missing-id')
    expect(removal.removed).toBe(false)
    const gone = await store.remove(link.id)
    expect(gone.removed).toBe(true)
    expect(gone.cachedPath).toBe('/cache/a.jpg')
    expect(store.list()).toHaveLength(0)
  })

  it('persists a thumb URL through add, export, and re-import', async () => {
    const path = join(dir, 'links.json')
    const store = new WallpaperLinkStore(path)
    await store.initialize()
    const { link } = await store.add('https://example.com/a.jpg', 'Alpha', undefined, 'https://cdn.example.com/a-small.jpg')
    expect(link.thumbUrl).toBe('https://cdn.example.com/a-small.jpg')

    const exported = store.exportBundle()
    expect(exported.links[0]!.thumb).toBe('https://cdn.example.com/a-small.jpg')

    const reopened = new WallpaperLinkStore(path)
    await reopened.initialize()
    expect(reopened.list()[0]!.thumbUrl).toBe('https://cdn.example.com/a-small.jpg')

    const other = new WallpaperLinkStore(join(dir, 'other.json'))
    await other.initialize()
    const summary = await other.importLinks(exported.links)
    expect(summary.added).toBe(1)
    expect(other.list()[0]!.thumbUrl).toBe('https://cdn.example.com/a-small.jpg')
  })

  it('imports bundle seeds without duplicating existing links', async () => {
    const store = new WallpaperLinkStore(join(dir, 'links.json'))
    await store.initialize()
    await store.add('https://example.com/a.jpg', 'Alpha')
    const summary = await store.importLinks([
      { url: 'https://example.com/a.jpg', title: 'Alpha again' },
      { url: 'https://example.com/new.jpg', title: 'New' },
    ])
    expect(summary.added).toBe(1)
    expect(summary.skipped).toBe(1)
  })

  it('enforces the maximum link count', async () => {
    const store = new WallpaperLinkStore(join(dir, 'links.json'))
    await store.initialize()
    for (let index = 0; index < WALLPAPER_LINKS_MAX; index += 1) {
      await store.add(`https://example.com/${index}.jpg`)
    }
    await expect(store.add('https://example.com/overflow.jpg')).rejects.toThrow(/full/i)
  })

  it('exports in the ND bundle format that imports back cleanly', async () => {
    const store = new WallpaperLinkStore(join(dir, 'links.json'))
    await store.initialize()
    await store.add('https://example.com/a.jpg', 'Alpha')
    await store.add('https://example.com/b.jpg', 'Beta')
    const exported = store.exportBundle()
    expect(exported.schema).toBe(WALLPAPER_LINKS_SCHEMA)
    const reparsed = parseWallpaperLinksBundle(exported)
    expect(reparsed.links.map((seed) => seed.url)).toEqual([
      'https://example.com/a.jpg',
      'https://example.com/b.jpg',
    ])
  })

  it('quarantines a corrupt store file instead of deleting it', async () => {
    const path = join(dir, 'links.json')
    await writeFile(path, '{ not json', 'utf8')
    const store = new WallpaperLinkStore(path)
    await store.initialize()
    expect(store.list()).toHaveLength(0)
    const files = await import('node:fs/promises').then((fs) => fs.readdir(dir))
    expect(files.some((name) => name.includes('.corrupt-'))).toBe(true)
  })
})

describe('wallpaper image download', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nd-wallpaper-cache-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function pngResponse(body: Uint8Array, headers: Record<string, string> = {}): Response {
    return new Response(body as unknown as BodyInit, {
      status: 200,
      headers: { 'content-type': 'image/png', ...headers },
    })
  }
  it('downloads a supported image into the cache with the right extension', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const fetchImpl = vi.fn(async () => pngResponse(bytes))
    const result = await downloadWallpaperImage('https://example.com/pic.png', {
      cacheDir: dir,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...publicDns,
    })
    expect(result.size).toBe(bytes.byteLength)
    expect(result.path).toContain(linkIdForUrl('https://example.com/pic.png'))
    expect(result.path.endsWith('.png')).toBe(true)
    const written = await readFile(result.path)
    expect([...written]).toEqual([...bytes])
  })

  it('rejects unsupported content types and oversized declared lengths', async () => {
    const fetchImpl = vi.fn(async () => new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } }))
    await expect(downloadWallpaperImage('https://example.com/pic.svg', {
      cacheDir: dir,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...publicDns,
    })).rejects.toThrow(/not a supported image/i)

    const huge = new Response(new Uint8Array(8), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(128 * 1024 * 1024) },
    })
    await expect(downloadWallpaperImage('https://example.com/huge.png', {
      cacheDir: dir,
      fetchImpl: async () => huge,
      ...publicDns,
      maxBytes: 64 * 1024 * 1024,
    })).rejects.toThrow(/too large/i)
  })

  it('refuses to fetch hosts that resolve into private ranges', async () => {
    const fetchImpl = vi.fn(async () => pngResponse(new Uint8Array(4)))
    await expect(downloadWallpaperImage('https://example.com/pic.png', {
      cacheDir: dir,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookup: async () => [{ address: '192.168.1.1' }],
    })).rejects.toThrow(/private network/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('follows redirects while re-validating each hop', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://example.com/pic.png') {
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/real.png' } })
      }
      return pngResponse(new Uint8Array([1, 2, 3]))
    })
    const result = await downloadWallpaperImage('https://example.com/pic.png', {
      cacheDir: dir,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...publicDns,
    })
    expect(result.path.endsWith('.png')).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('refuses a redirect that lands on a private host', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://example.com/pic.png') {
        return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret.png' } })
      }
      return pngResponse(new Uint8Array([1, 2, 3]))
    })
    await expect(downloadWallpaperImage('https://example.com/pic.png', {
      cacheDir: dir,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...publicDns,
    })).rejects.toThrow(/private network/i)
    // The private hop is refused before any connection is attempted.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('wallpaper collections', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nd-wallpaper-collections-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates, lists, and deletes collections with unique names', async () => {
    const store = new WallpaperLinkStore(join(dir, 'links.json'))
    await store.initialize()
    const nature = await store.createCollection('Nature')
    expect(nature.name).toBe('Nature')
    expect(nature.entries).toHaveLength(0)
    await expect(store.createCollection('nature')).rejects.toThrow(/already exists/i)
    await expect(store.createCollection('   ')).rejects.toThrow(/name/i)
    expect(await store.deleteCollection(nature.id)).toEqual({ deleted: true })
    expect(await store.deleteCollection(nature.id)).toEqual({ deleted: false })
    expect(store.listCollections()).toHaveLength(0)
  })

  it('adds link and file entries, deduplicating by what they point at', async () => {
    const store = new WallpaperLinkStore(join(dir, 'links.json'))
    await store.initialize()
    const collection = await store.createCollection('Nature')
    const first = await store.addToCollection(collection.id, [
      { kind: 'link', ref: 'https://example.com/forest.jpg', title: 'Forest' },
      { kind: 'file', ref: join(dir, 'mountain.png'), title: 'Mountain' },
    ])
    expect(first.added).toBe(2)
    const duplicate = await store.addToCollection(collection.id, [
      { kind: 'link', ref: 'https://example.com/forest.jpg' },
      { kind: 'file', ref: join(dir, 'mountain.png') },
    ])
    expect(duplicate.added).toBe(0)
    expect(duplicate.skipped).toBe(2)
    const entries = store.findCollection(collection.id)!.entries
    expect(entries.map((entry) => entry.kind)).toEqual(['link', 'file'])
    expect(entries[1]!.id).toBe(collectionEntryId('file', join(dir, 'mountain.png')))
  })

  it('validates entry refs before saving', async () => {
    const store = new WallpaperLinkStore(join(dir, 'links.json'))
    await store.initialize()
    const collection = await store.createCollection('Mixed')
    await expect(store.addToCollection(collection.id, [
      { kind: 'link', ref: 'http://example.com/insecure.jpg' },
    ])).rejects.toThrow(/https/i)
    await expect(store.addToCollection(collection.id, [
      { kind: 'file', ref: 'relative/path.jpg' },
    ])).rejects.toThrow(/folders/i)
    await expect(store.addToCollection(collection.id, [
      { kind: 'file', ref: join(dir, 'notes.txt') },
    ])).rejects.toThrow(/supported/i)
    expect(validateCollectionFileRef(join(dir, 'ok.webp'))).toBe(join(dir, 'ok.webp'))
  })

  it('removes entries and purges removed links from every collection', async () => {
    const store = new WallpaperLinkStore(join(dir, 'links.json'))
    await store.initialize()
    const alpha = await store.add('https://example.com/a.jpg', 'Alpha')
    const one = await store.createCollection('One')
    const two = await store.createCollection('Two')
    await store.addToCollection(one.id, [{ kind: 'link', ref: alpha.link.url }])
    await store.addToCollection(two.id, [{ kind: 'link', ref: alpha.link.url }])
    expect(await store.removeFromCollection(one.id, collectionEntryId('link', alpha.link.url))).toEqual({ removed: true })
    expect(store.findCollection(one.id)!.entries).toHaveLength(0)
    await store.remove(alpha.link.id)
    expect(store.findCollection(two.id)!.entries).toHaveLength(0)
  })

  it('persists collections across store instances', async () => {
    const path = join(dir, 'links.json')
    const store = new WallpaperLinkStore(path)
    await store.initialize()
    const collection = await store.createCollection('Nature')
    await store.addToCollection(collection.id, [{ kind: 'file', ref: join(dir, 'a.jpg'), title: 'A' }])
    const reopened = new WallpaperLinkStore(path)
    await reopened.initialize()
    const restored = reopened.listCollections()
    expect(restored).toHaveLength(1)
    expect(restored[0]!.name).toBe('Nature')
    expect(restored[0]!.entries[0]!.title).toBe('A')
  })
})

describe('shipped ND wallpaper bundle', () => {
  it('exists, parses, and contains only valid public https links', async () => {
    const path = bundledWallpaperLinksPath({ appPath: fileURLToPath(new URL('..', import.meta.url)) })
    const raw = await readFile(path, 'utf8')
    const links = bundledWallpaperLinksWithSource(raw)
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link.source).toBe('bundle')
      expect(link.id.startsWith('bundle-')).toBe(true)
      expect(() => parseWallpaperLinkUrl(link.url)).not.toThrow()
      // Curated entries ship cover thumbs so the Discovery grid shows artwork
      // before any full-size download.
      expect(link.thumbUrl, link.url).toMatch(/^https:\/\//)
      expect(() => parseWallpaperLinkUrl(link.thumbUrl!)).not.toThrow()
    }
  })

  it('writes cache files only under the configured cache directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nd-wallpaper-cache-'))
    try {
      await mkdir(dir, { recursive: true })
      const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
      const result = await downloadWallpaperImage('https://example.com/pic.jpg', {
        cacheDir: dir,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...publicDns,
      })
      expect(result.path.startsWith(dir)).toBe(true)

      // A second look must find the cached copy without any network call.
      const cached = await findCachedImage(dir, 'https://example.com/pic.jpg')
      expect(cached?.path).toBe(result.path)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('ND bundle curation (dev-only edits)', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nd-wallpaper-bundle-'))
    file = join(dir, 'nd-bundles', 'wallpaper-links.json')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('starts from an empty document when the bundle file is missing', async () => {
    const bundle = await readWallpaperLinksBundle(file)
    expect(bundle.schema).toBe(WALLPAPER_LINKS_SCHEMA)
    expect(bundle.links).toEqual([])
  })

  it('adds, updates and removes entries on disk', async () => {
    let bundle = await addBundledWallpaperLink(file, { url: 'https://example.com/a.jpg', title: 'A', category: ' nature ' })
    expect(bundle.links).toHaveLength(1)
    expect(bundle.links[0]!.category).toBe('nature')

    bundle = await addBundledWallpaperLink(file, { url: 'https://example.com/b.jpg', thumb: 'https://cdn.example.com/b-small.jpg' })
    expect(bundle.links).toHaveLength(2)
    expect(bundle.links[1]!.thumb).toBe('https://cdn.example.com/b-small.jpg')

    // The document on disk is the interchange format, categories included.
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    expect(onDisk.schema).toBe(WALLPAPER_LINKS_SCHEMA)
    expect(onDisk.links).toHaveLength(2)
    expect(onDisk.links[0].category).toBe('nature')

    bundle = await updateBundledWallpaperLink(file, 'https://example.com/a.jpg', { title: 'Renamed', category: '' })
    expect(bundle.links[0]!.title).toBe('Renamed')
    expect(bundle.links[0]!.category).toBeUndefined()

    const gone = await removeBundledWallpaperLink(file, 'https://example.com/b.jpg')
    expect(gone.removed).toBe(true)
    expect(gone.bundle.links).toHaveLength(1)

    const missing = await removeBundledWallpaperLink(file, 'https://example.com/never-there.jpg')
    expect(missing.removed).toBe(false)
  })

  it('refuses duplicates, invalid URLs and unknown edits', async () => {
    await addBundledWallpaperLink(file, { url: 'https://example.com/a.jpg' })
    await expect(addBundledWallpaperLink(file, { url: 'https://example.com/a.jpg' })).rejects.toThrow(/already/i)
    await expect(addBundledWallpaperLink(file, { url: 'http://insecure.example.com/a.jpg' })).rejects.toThrow(/https/i)
    await expect(addBundledWallpaperLink(file, { url: 'https://127.0.0.1/private.jpg' })).rejects.toThrow(/private/i)
    await expect(updateBundledWallpaperLink(file, 'https://example.com/nope.jpg', { title: 'X' })).rejects.toThrow(/no longer exists/i)
  })

  it('mirrors collections into the bundle document as link-only seeds', async () => {
    await addBundledWallpaperLink(file, { url: 'https://example.com/a.jpg', title: 'A' })
    const mirrored = await writeBundledCollections(file, [
      {
        id: 'col-1',
        name: 'Nature',
        createdAt: 1,
        entries: [
          { id: 'e-1', kind: 'link', ref: 'https://example.com/a.jpg', title: 'A', addedAt: 0 },
          // File entries must not ship: they are meaningless on another machine.
          { id: 'e-2', kind: 'file', ref: 'C:/Users/someone/Pictures/x.jpg', title: 'local', addedAt: 0 },
        ],
      },
    ])
    expect(mirrored.collections).toHaveLength(1)
    expect(mirrored.collections![0]!.entries).toHaveLength(1)
    expect(mirrored.collections![0]!.entries[0]!.kind).toBe('link')

    const roundTrip = await readWallpaperLinksBundle(file)
    expect(roundTrip.collections![0]!.name).toBe('Nature')
    expect(roundTrip.collections![0]!.entries[0]!.ref).toBe('https://example.com/a.jpg')
    // Links survive the collection mirror untouched.
    expect(roundTrip.links).toHaveLength(1)
  })
})
