import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import { validateNdExtensionManifest } from '../src/shared/extension-package.js'
import { STARTER_KIT_ROOT, starterKitFiles } from '../src/main/extensions/starter-kit.js'
import { createZipFile } from '../src/main/extensions/zip.js'

/** Reads a ZIP produced by createZipFile using its central directory. */
function readZip(archive: Buffer): Map<string, Buffer> {
  // Locate the end-of-central-directory record (comment is always empty here).
  const eocdOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(eocdOffset).toBeGreaterThan(0)
  const entryCount = archive.readUInt16LE(eocdOffset + 10)
  const centralOffset = archive.readUInt32LE(eocdOffset + 16)

  const entries = new Map<string, Buffer>()
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    expect(archive.readUInt32LE(cursor)).toBe(0x02014b50)
    const method = archive.readUInt16LE(cursor + 10)
    const crc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const uncompressedSize = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')

    expect(archive.readUInt32LE(localOffset)).toBe(0x04034b50)
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const payload = archive.subarray(dataStart, dataStart + compressedSize)

    const raw = method === 8 ? inflateRawSync(payload) : payload
    expect(raw.length).toBe(uncompressedSize)
    expect(crc32Of(raw)).toBe(crc)
    entries.set(name, raw)
    cursor += 46 + nameLength
  }
  return entries
}

function crc32Of(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

describe('extension starter kit zip', () => {
  it('produces a valid archive whose entries inflate back to the source files', () => {
    const files = starterKitFiles()
    const archive = createZipFile(files)
    const entries = readZip(archive)
    expect([...entries.keys()]).toEqual(files.map((file) => file.path))
    for (const file of files) {
      expect(entries.get(file.path)!.toString('utf8')).toBe(file.data)
    }
  })

  it('is byte-for-byte deterministic', () => {
    const first = createZipFile(starterKitFiles())
    const second = createZipFile(starterKitFiles())
    expect(first.equals(second)).toBe(true)
  })

  it('refuses entry paths that escape the archive root', () => {
    expect(() => createZipFile([{ path: '../evil.txt', data: 'x' }])).toThrow(/invalid zip entry/i)
    expect(() => createZipFile([{ path: 'a/../../evil.txt', data: 'x' }])).toThrow(/invalid zip entry/i)
    expect(() => createZipFile([{ path: 'C:\\evil.txt', data: 'x' }])).toThrow(/invalid zip entry/i)
    expect(() => createZipFile([{ path: 'ok/nested/file.txt', data: 'x' }])).not.toThrow()
  })

  it('compresses the text-heavy kit', () => {
    const files = starterKitFiles()
    const raw = files.reduce((total, file) => total + Buffer.byteLength(file.data, 'utf8'), 0)
    const archive = createZipFile(files)
    expect(archive.length).toBeLessThan(raw)
  })
})

describe('extension starter kit content', () => {
  const files = starterKitFiles()
  const byPath = new Map(files.map((file) => [file.path, file.data]))

  it('ships a manifest that passes the production validator untouched', () => {
    const manifest = JSON.parse(byPath.get(`${STARTER_KIT_ROOT}/nd-extension.json`)!)
    const validation = validateNdExtensionManifest(manifest)
    expect(validation.ok).toBe(true)
  })

  it('documents the full loop: install locally, iterate, git init', () => {
    const readme = byPath.get(`${STARTER_KIT_ROOT}/README.md`)!
    expect(readme).toContain('Install local')
    expect(readme).toContain('git init')
    expect(readme).toContain('nd-extension.json')
    expect(readme).toContain('permissions')
  })

  it('gitignores local credentials', () => {
    const gitignore = byPath.get(`${STARTER_KIT_ROOT}/.gitignore`)!
    expect(gitignore).toContain('.env')
  })
})
