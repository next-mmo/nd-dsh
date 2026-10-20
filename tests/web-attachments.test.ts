import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { discardWebImages, stageWebImages } from '../src/main/engines/web-attachments.js'

describe('web chat attachment staging', () => {
  it('materializes pasted images with sanitized names and real extensions', () => {
    const staged = stageWebImages([
      { data: Buffer.from('first').toString('base64'), mediaType: 'image/png', name: '../../shot one.png' },
      { data: Buffer.from('second').toString('base64'), mediaType: 'image/jpeg', name: '' },
    ])
    try {
      expect(staged.files).toHaveLength(2)
      expect(staged.files[0]).toMatch(/shot-one-1\.png$/)
      expect(staged.files[1]).toMatch(/pasted-image-2\.jpg$/)
      expect(readFileSync(staged.files[0]!, 'utf8')).toBe('first')
      expect(readFileSync(staged.files[1]!, 'utf8')).toBe('second')
    } finally {
      discardWebImages(staged)
    }
    expect(existsSync(staged.files[0]!)).toBe(false)
  })
})
