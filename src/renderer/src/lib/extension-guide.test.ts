import { describe, expect, it } from 'vitest'
import { EXTENSION_GUIDE_SECTIONS, inlineRepoLinks } from './extension-guide'

const RESIDUAL_LINK = /\[[^\]\n]*\]\((?!https?:\/\/)[^)\s]*\)/g

describe('inlineRepoLinks', () => {
  it('drops a repo-relative target and keeps the label', () => {
    expect(inlineRepoLinks('See [`examples/nd-extension-hello`](../../examples/nd-extension-hello).'))
      .toBe('See `examples/nd-extension-hello`.')
    expect(inlineRepoLinks('[PRD 0006](../prd/0006-nd-extensions-and-personal-home.md)'))
      .toBe('PRD 0006')
  })

  it('rewrites every link on a line, including table rows', () => {
    const row = '| Example | [`a`](../../a) | [`b`](../../b) |'
    expect(inlineRepoLinks(row)).toBe('| Example | `a` | `b` |')
  })

  it('keeps http(s) links intact so MarkdownLite can still linkify them', () => {
    const text = '[docs](https://example.com/guide) and [local](./local.md)'
    expect(inlineRepoLinks(text)).toBe('[docs](https://example.com/guide) and local')
  })

  it('does not rewrite inside fenced code blocks', () => {
    const text = ['Prose [label](../path.md)', '```json', '{ "link": "[keep](../keep.md)" }', '```'].join('\n')
    expect(inlineRepoLinks(text)).toBe(['Prose label', '```json', '{ "link": "[keep](../keep.md)" }', '```'].join('\n'))
  })

  it('leaves plain text and bare brackets alone', () => {
    expect(inlineRepoLinks('No links here, just [brackets] and (parens).')).toBe('No links here, just [brackets] and (parens).')
  })
})

describe('bundled extension guide', () => {
  it('ships the overview and authoring sections with real content', () => {
    expect(EXTENSION_GUIDE_SECTIONS.map((section) => section.id)).toEqual(['overview', 'authoring'])
    for (const section of EXTENSION_GUIDE_SECTIONS) {
      expect(section.label.length).toBeGreaterThan(0)
      expect(section.text.length).toBeGreaterThan(1000)
    }
  })

  it('renders no literal repo-relative markdown links', () => {
    // MarkdownLite cannot linkify a relative target, so any survivor would show
    // up in the UI as raw "[label](../../path)" text.
    for (const section of EXTENSION_GUIDE_SECTIONS) {
      expect(section.text.match(RESIDUAL_LINK)).toEqual(null)
    }
  })

  it('keeps the headings and host-method table the guide is built from', () => {
    const authoring = EXTENSION_GUIDE_SECTIONS.find((section) => section.id === 'authoring')
    expect(authoring?.text).toContain('# Authoring ND extensions')
    expect(authoring?.text).toContain('## 3. The host methods v1 exposes')
    expect(authoring?.text).toContain('| `note.create` | `notes.write` |')
    expect(authoring?.text).toContain('os.wallpaper.applySelected')
  })
})
