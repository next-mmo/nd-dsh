import { describe, expect, it } from 'vitest'
import { parseMarkdownBlocks, tokenizeInline } from '../src/shared/markdown-lite.js'

describe('tokenizeInline', () => {
  it('returns a single text token for plain prose', () => {
    expect(tokenizeInline('just text')).toEqual([{ kind: 'text', text: 'just text' }])
  })

  it('splits code, bold, and italic tokens', () => {
    const tokens = tokenizeInline('run `pnpm test` for **all** *flakes*')
    expect(tokens).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'code', text: 'pnpm test' },
      { kind: 'text', text: ' for ' },
      { kind: 'bold', text: 'all' },
      { kind: 'text', text: ' ' },
      { kind: 'italic', text: 'flakes' },
    ])
  })

  it('tokenizes markdown and bare HTTP(S) links', () => {
    expect(tokenizeInline('[Open app](http://localhost:5174/) or https://example.com/docs.')).toEqual([
      { kind: 'link', text: 'Open app', url: 'http://localhost:5174/' },
      { kind: 'text', text: ' or ' },
      { kind: 'link', text: 'https://example.com/docs', url: 'https://example.com/docs' },
      { kind: 'text', text: '.' },
    ])
  })

  it('keeps URLs inside code literal and rejects unsupported schemes', () => {
    expect(tokenizeInline('`http://localhost:5174/` file:///tmp/x javascript:alert(1)')).toEqual([
      { kind: 'code', text: 'http://localhost:5174/' },
      { kind: 'text', text: ' file:///tmp/x javascript:alert(1)' },
    ])
  })

  it('tokenizes standalone markdown images', () => {
    expect(tokenizeInline('Here is ![Xiaomi Redmi Note 9](https://images.com/phone.jpg) phone')).toEqual([
      { kind: 'text', text: 'Here is ' },
      { kind: 'image', alt: 'Xiaomi Redmi Note 9', url: 'https://images.com/phone.jpg' },
      { kind: 'text', text: ' phone' },
    ])
  })

  it('tokenizes linked markdown images with click targets', () => {
    expect(tokenizeInline('[![Redmi](https://images.com/phone.jpg)](https://zdnet.com/article)')).toEqual([
      { kind: 'image', alt: 'Redmi', url: 'https://images.com/phone.jpg', linkUrl: 'https://zdnet.com/article' },
    ])
  })

  it('supports data:image and blob: image URLs', () => {
    expect(tokenizeInline('![generated](data:image/png;base64,iVBORw0KGgo) and ![cached](blob:https://gemini.google.com/123)')).toEqual([
      { kind: 'image', alt: 'generated', url: 'data:image/png;base64,iVBORw0KGgo' },
      { kind: 'text', text: ' and ' },
      { kind: 'image', alt: 'cached', url: 'blob:https://gemini.google.com/123' },
    ])
  })

  it('keeps bold markers literal inside inline code', () => {
    const tokens = tokenizeInline('`**not bold**`')
    expect(tokens).toEqual([{ kind: 'code', text: '**not bold**' }])
  })
})

describe('parseMarkdownBlocks', () => {
  it('parses fenced code with its language', () => {
    const blocks = parseMarkdownBlocks('```ts\nconst a = 1\n```')
    expect(blocks).toEqual([{ kind: 'code', language: 'ts', text: 'const a = 1' }])
  })

  it('treats an unclosed fence (streaming) as a code block to EOF', () => {
    const blocks = parseMarkdownBlocks('```js\nlet b = 2')
    expect(blocks).toEqual([{ kind: 'code', language: 'js', text: 'let b = 2' }])
  })

  it('groups consecutive bullets and ordered items', () => {
    const blocks = parseMarkdownBlocks('- one\n- two\n1. first\n2. second')
    expect(blocks).toEqual([
      { kind: 'bullet-list', items: ['one', 'two'] },
      { kind: 'ordered-list', items: ['first', 'second'] },
    ])
  })

  it('parses headings, quotes, and paragraphs', () => {
    const blocks = parseMarkdownBlocks('## Title\n> quoted line\nplain words\nmore words')
    expect(blocks).toEqual([
      { kind: 'heading', level: 2, text: 'Title' },
      { kind: 'quote', text: 'quoted line' },
      { kind: 'paragraph', text: 'plain words more words' },
    ])
  })

  it('stops a paragraph at a fence start so mixed content splits', () => {
    const blocks = parseMarkdownBlocks('text before\n```py\nprint(1)\n```')
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'text before' },
      { kind: 'code', language: 'py', text: 'print(1)' },
    ])
  })

  it('parses pipe tables into headers and rows', () => {
    expect(parseMarkdownBlocks('| Name | Status |\n| --- | :---: |\n| API | **ready** |\n| UI | pending |')).toEqual([
      { kind: 'table', headers: ['Name', 'Status'], rows: [['API', '**ready**'], ['UI', 'pending']] },
    ])
  })

  it('splits table immediately following prose without an empty line', () => {
    const input = 'Here are the results:\n| File | Status |\n| -- | :- |\n| main.ts | ok |'
    const blocks = parseMarkdownBlocks(input)
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'Here are the results:' },
      { kind: 'table', headers: ['File', 'Status'], rows: [['main.ts', 'ok']] },
    ])
  })

  it('pads missing cells in table rows to match header length', () => {
    const input = '| Col A | Col B | Col C |\n|---|---|---|\n| 1 | 2 |\n| 3 | 4 | 5 |'
    const blocks = parseMarkdownBlocks(input)
    expect(blocks).toEqual([
      { kind: 'table', headers: ['Col A', 'Col B', 'Col C'], rows: [['1', '2', ''], ['3', '4', '5']] },
    ])
  })
})
