import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_CAPS,
  ClipboardHistoryStore,
  MAX_HISTORY_TEXT_CHARS,
  capsFromSettings,
} from '../src/main/extensions/clipboard-history.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nd-clipboard-history-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A small valid PNG (1x1 red pixel) for image record tests. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function textFingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

describe('ClipboardHistoryStore', () => {
  it('records text with a content fingerprint and lists newest first', async () => {
    const store = new ClipboardHistoryStore(root)
    await store.record({ text: 'first copy' }, DEFAULT_CAPS, 1_000)
    await store.record({ text: 'second copy' }, DEFAULT_CAPS, 2_000)

    const entries = await store.list()
    expect(entries.map((entry) => entry.text)).toEqual(['second copy', 'first copy'])
    expect(entries[0]).toMatchObject({ kind: 'text', pinned: false, occurrences: 1 })
    expect(entries[0]!.fingerprint).toBe(textFingerprint('second copy'))
  })

  it('dedups re-copied text into the same entry with a bumped recency', async () => {
    const store = new ClipboardHistoryStore(root)
    await store.record({ text: 'same text' }, DEFAULT_CAPS, 1_000)
    await store.record({ text: 'other' }, DEFAULT_CAPS, 2_000)
    const again = await store.record({ text: 'same text' }, DEFAULT_CAPS, 3_000)

    const entries = await store.list()
    expect(entries).toHaveLength(2)
    expect(entries[0]!.text).toBe('same text')
    expect(again.occurrences).toBe(2)
    expect(again.id).toBe(entries[0]!.id)
  })

  it('stores image bytes as fingerprint-named files and keeps metadata in the index', async () => {
    const store = new ClipboardHistoryStore(root)
    const entry = await store.record(
      { fingerprint: 'abc123', pngBase64: TINY_PNG_BASE64, width: 1, height: 1 },
      DEFAULT_CAPS,
    )

    expect(entry.kind).toBe('image')
    expect(entry.imageFile).toBe('abc123.png')
    const imageBuffer = await store.readImageFile(entry)
    expect(imageBuffer).toBeDefined()
    expect(await readFile(join(root, 'images', 'abc123.png'))).toEqual(imageBuffer!)

    // The index itself carries no image bytes.
    const raw = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'))
    expect(JSON.stringify(raw)).not.toContain('iVBOR')
    expect((await stat(join(root, 'index.json'))).size).toBeLessThan(2_000)
  })

  it('dedups images by pixel fingerprint even when re-encoded', async () => {
    const store = new ClipboardHistoryStore(root)
    await store.record({ fingerprint: 'pix-1', pngBase64: TINY_PNG_BASE64, width: 1, height: 1 }, DEFAULT_CAPS, 1_000)
    // Same pixels, different encoder output — the fingerprint still matches.
    await store.record({ fingerprint: 'pix-1', pngBase64: 'AAAA', width: 1, height: 1 }, DEFAULT_CAPS, 2_000)

    const entries = await store.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.occurrences).toBe(2)
    expect(entries[0]!.lastCopiedAt).toBe(2_000)
    // The first stored bytes are kept; the re-encode did not overwrite them.
    expect(await readFile(join(root, 'images', 'pix-1.png'))).toEqual(await store.readImageFile(entries[0]!)!)
  })

  it('records a metadata-only image when the payload is too large to store', async () => {
    const store = new ClipboardHistoryStore(root)
    const entry = await store.record({ fingerprint: 'huge', tooLarge: true, width: 8_000, height: 4_000 }, DEFAULT_CAPS)
    expect(entry.kind).toBe('image')
    expect(entry.imageFile).toBeUndefined()
    expect(await store.readImageFile(entry)).toBeUndefined()
  })

  it('enforces per-kind caps while leaving pins exempt', async () => {
    const store = new ClipboardHistoryStore(root)
    const caps = { text: 3, image: 30, pinned: 25 }
    for (let index = 1; index <= 5; index += 1) {
      await store.record({ text: `copy ${index}` }, caps, index * 1_000)
    }
    let entries = await store.list()
    expect(entries.filter((entry) => entry.kind === 'text')).toHaveLength(3)
    // The oldest were trimmed.
    expect(entries.find((entry) => entry.text === 'copy 1')).toBeUndefined()
    expect(entries.find((entry) => entry.text === 'copy 5')).toBeDefined()

    // Pinning protects an entry from trimming.
    const pinned = await store.record({ text: 'pinned copy' }, caps, 9_000)
    await store.setPinned(pinned.id, true, caps)
    for (let index = 10; index <= 20; index += 1) {
      await store.record({ text: `copy ${index}` }, caps, index * 1_000)
    }
    entries = await store.list()
    expect(entries.find((entry) => entry.text === 'pinned copy')).toBeDefined()
  })

  it('refuses pins beyond the pinned cap', async () => {
    const store = new ClipboardHistoryStore(root)
    const caps = { text: 300, image: 30, pinned: 1 }
    const first = await store.record({ text: 'one' }, caps, 1_000)
    const second = await store.record({ text: 'two' }, caps, 2_000)
    await store.setPinned(first.id, true, caps)
    await expect(store.setPinned(second.id, true, caps)).rejects.toThrow(/Pinned cap/)
  })

  it('clear keeps pinned entries and deletes unpinned image files', async () => {
    const store = new ClipboardHistoryStore(root)
    const text = await store.record({ text: 'unpinned' }, DEFAULT_CAPS, 1_000)
    const image = await store.record({ fingerprint: 'img-1', pngBase64: TINY_PNG_BASE64, width: 1, height: 1 }, DEFAULT_CAPS, 2_000)
    const pinned = await store.record({ text: 'pinned' }, DEFAULT_CAPS, 3_000)
    await store.setPinned(pinned.id, true, DEFAULT_CAPS)

    const result = await store.clear()
    expect(result).toEqual({ cleared: 2, keptPinned: 1 })

    const entries = await store.list()
    expect(entries.map((entry) => entry.text)).toEqual(['pinned'])
    expect(existsSync(join(root, 'images', 'img-1.png'))).toBe(false)
    expect(text.id === image.id).toBe(false)
  })

  it('delete removes one entry and its orphaned image file', async () => {
    const store = new ClipboardHistoryStore(root)
    const entry = await store.record({ fingerprint: 'gone', pngBase64: TINY_PNG_BASE64, width: 1, height: 1 }, DEFAULT_CAPS)
    expect(await store.delete(entry.id)).toBe(true)
    expect(await store.delete(entry.id)).toBe(false)
    expect(await store.list()).toHaveLength(0)
    expect(existsSync(join(root, 'images', 'gone.png'))).toBe(false)
  })

  it('persists across instances and rejects corrupt indexes by starting empty', async () => {
    const store = new ClipboardHistoryStore(root)
    await store.record({ text: 'durable' }, DEFAULT_CAPS)
    const reopened = new ClipboardHistoryStore(root)
    expect((await reopened.list()).map((entry) => entry.text)).toEqual(['durable'])

    await writeFile(join(root, 'index.json'), 'not json at all', 'utf8')
    const recovered = new ClipboardHistoryStore(root)
    expect(await recovered.list()).toHaveLength(0)
  })

  it('rejects records with nothing recordable', async () => {
    const store = new ClipboardHistoryStore(root)
    await expect(store.record({}, DEFAULT_CAPS)).rejects.toThrow(/Nothing recordable/)
    await expect(store.record({ text: '   ' }, DEFAULT_CAPS)).rejects.toThrow(/Nothing recordable/)
  })

  it('bounds stored text and flags the truncation', async () => {
    const store = new ClipboardHistoryStore(root)
    const long = 'x'.repeat(MAX_HISTORY_TEXT_CHARS + 5_000)
    await store.record({ text: long, truncated: true }, DEFAULT_CAPS)
    const entries = await store.list()
    expect(entries[0]!.text).toHaveLength(MAX_HISTORY_TEXT_CHARS)
    expect(entries[0]!.truncated).toBe(true)
  })

  it('reads caps from activation settings with clamped bounds', () => {
    expect(capsFromSettings(undefined)).toEqual(DEFAULT_CAPS)
    expect(capsFromSettings({ textCap: 50, imageCap: 5, pinnedCap: 10 })).toEqual({ text: 50, image: 5, pinned: 10 })
    // Clamp absurd values instead of trusting them.
    expect(capsFromSettings({ textCap: 0, imageCap: 99_999, pinnedCap: -3 })).toEqual({ text: 1, image: 100, pinned: 1 })
    expect(capsFromSettings({ textCap: '300' })).toEqual(DEFAULT_CAPS)
  })
})
