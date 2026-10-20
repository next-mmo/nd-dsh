import { describe, expect, it } from 'vitest'
import { asRunFiles, assertRunAttachmentBudget } from '../src/main/run-files.js'

const data = Buffer.from('hello').toString('base64')

describe('asRunFiles', () => {
  it('accepts base64 files and preserves a safe relative folder path', () => {
    expect(asRunFiles([{ data, mediaType: '', name: 'notes.md', relativePath: 'src\\docs\\notes.md' }])).toEqual([
      { data, mediaType: 'application/md', name: 'notes.md', relativePath: 'src/docs/notes.md' },
    ])
    expect(asRunFiles(undefined)).toBeUndefined()
  })

  it('rejects malformed data, names, and traversal paths', () => {
    expect(() => asRunFiles([])).toThrow('non-empty list')
    expect(() => asRunFiles([{ data: 'not base64!', mediaType: 'text/plain', name: 'a.txt' }])).toThrow('base64-encoded')
    expect(() => asRunFiles([{ data, mediaType: 'text/plain', name: ' ' }])).toThrow('short name')
    expect(() => asRunFiles([{ data, mediaType: 'text/plain', name: 'a.txt', relativePath: '../secret.txt' }])).toThrow('inside the selected folder')
    expect(() => asRunFiles([{ data, mediaType: 'text/plain', name: 'a.txt', relativePath: 'C:/secret.txt' }])).toThrow('inside the selected folder')
  })

  it('shares the 20-item ceiling and 25 MB budget with images', () => {
    const files = Array.from({ length: 21 }, () => ({ data: 'QQ==', mediaType: 'text/plain', name: 'a.txt' }))
    expect(() => assertRunAttachmentBudget(undefined, files)).toThrow('at most 20 items')
    expect(() => assertRunAttachmentBudget(
      [
        { data: 'Q'.repeat(20_000_000), mediaType: 'image/png', name: 'big-1.png' },
        { data: 'Q'.repeat(20_000_000), mediaType: 'image/png', name: 'big-2.png' },
      ],
      [{ data, mediaType: 'text/plain', name: 'a.txt' }],
    )).toThrow('25 MB')
    expect(() => assertRunAttachmentBudget(
      [{ data: 'QQ==', mediaType: 'image/png', name: 'a.png' }],
      [{ data, mediaType: 'text/plain', name: 'a.txt' }],
    )).not.toThrow()
  })
})
