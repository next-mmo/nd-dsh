import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inlineTextAttachments, stageAttachments } from '../src/main/engines/attachment-delivery.js'
import { stripWorkspaceContext } from '../src/shared/workspace-context.js'

const text = (value: string): string => Buffer.from(value).toString('base64')

describe('stageAttachments', () => {
  it('writes files and staged images under the workspace and cleans the turn up', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'nd-attach-cwd-'))
    try {
      const staged = await stageAttachments(
        [{ data: text('hello'), mediaType: 'text/markdown', name: 'notes.md', relativePath: 'src/notes.md' }],
        [{ data: 'QUJD', mediaType: 'image/png', name: 'shot.png' }],
        cwd,
      )
      const notes = join(cwd, '.nd-dsh', 'attachments')
      expect(staged.suffix).toContain('<nd-attachments>')
      expect(staged.suffix).toContain('src/notes.md')
      expect(staged.suffix).toContain('image/png')
      expect(staged.suffix).toMatch(/\.nd-dsh\/attachments\/[^/]+\/src\/notes\.md/)
      const stagedRoot = (staged.suffix.match(/\.nd-dsh\/attachments\/[^/]+/)?.[0] ?? '').replaceAll('/', sep)
      expect(await readFile(join(cwd, stagedRoot, 'src', 'notes.md'), 'utf8')).toBe('hello')
      await staged.cleanup()
      await expect(stat(join(cwd, stagedRoot))).rejects.toThrow()
      expect((await stat(notes)).isDirectory()).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('falls back to absolute temp paths when there is no workspace', async () => {
    const staged = await stageAttachments([], [{ data: 'QUJD', mediaType: 'image/png', name: 'shot.png' }])
    try {
      expect(staged.suffix).toContain('image/png')
      expect(staged.suffix).toMatch(/nd-attachments-/)
    } finally {
      await staged.cleanup()
    }
  })
})

describe('inlineTextAttachments', () => {
  it('inlines text and reports binary files', () => {
    const result = inlineTextAttachments([
      { data: text('const value = 1'), mediaType: 'text/typescript', name: 'a.ts' },
      { data: text('%PDF-1.7'), mediaType: 'application/pdf', name: 'brief.pdf' },
    ])
    expect(result.suffix).toContain('const value = 1')
    expect(result.suffix).toContain('--- FILE: a.ts')
    expect(result.unsupported.map((file) => file.name)).toEqual(['brief.pdf'])
  })

  it('truncates a large text file and marks it', () => {
    const result = inlineTextAttachments([
      { data: text('x'.repeat(50_000)), mediaType: 'text/plain', name: 'big.txt' },
    ])
    expect(result.suffix).toContain('[attachment truncated at 48000 characters]')
    expect(result.suffix.length).toBeLessThan(50_000)
  })

  it('survives workspace-context stripping before a web engine prompt is sent', () => {
    const result = inlineTextAttachments([
      { data: text('The secret word is ORANGE.'), mediaType: 'text/markdown', name: 'secret.md' },
    ])
    expect(result.suffix).toContain('<attached-files>')
    const prompt = stripWorkspaceContext(`What is the secret word?\n\n${result.suffix}`)
    expect(prompt).toContain('The secret word is ORANGE.')
    expect(prompt).toContain('<attached-files>')
  })
})
