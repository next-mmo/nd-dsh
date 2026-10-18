/**
 * Minimal, dependency-free markdown block parser tuned for LLM chat output:
 * fenced code blocks, headings, bullet/ordered lists, blockquotes, and
 * paragraphs. Inline formatting (bold/italic/inline code) is tokenized for
 * the renderer; never HTML, so output is safe React nodes.
 */

export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; url: string }
  | { kind: 'image'; alt: string; url: string; linkUrl?: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }

export type MarkdownBlock =
  | { kind: 'code'; language: string; text: string }
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'bullet-list'; items: string[] }
  | { kind: 'ordered-list'; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'paragraph'; text: string }

const FENCE_OPEN = /^```(\w*)\s*$/
const HEADING = /^(#{1,3})\s+(.*)$/
const BULLET = /^[-*]\s+(.*)$/
const ORDERED = /^\d+[.)]\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

function tableCells(line: string): string[] {
  const trimmed = line.trim()
  const withoutOuterPipes = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const content = withoutOuterPipes.endsWith('|') ? withoutOuterPipes.slice(0, -1) : withoutOuterPipes
  return content.split('|').map((cell) => cell.trim())
}

function isTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false
  const headerLine = lines[index] ?? ''
  const sepLine = (lines[index + 1] ?? '').trim()
  if (!headerLine.includes('|') || !TABLE_SEPARATOR.test(sepLine)) return false
  const headers = tableCells(headerLine)
  const separatorCells = tableCells(sepLine)
  return headers.length > 0 && headers.length === separatorCells.length
}

const MARKDOWN_LINKED_IMAGE = /\[!\[([^\]\n]*)\]\(((?:https?:\/\/|data:image\/|blob:)[^\s)]+)\)\]\((https?:\/\/[^\s)]+)\)/y
const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(((?:https?:\/\/|data:image\/|blob:)[^\s)]+)\)/y
const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/y
const BARE_URL = /https?:\/\/[^\s<>()]+/y
const TRAILING_URL_PUNCTUATION = /[.,!?;:]+$/

function trimBareUrl(value: string): string {
  return value.replace(TRAILING_URL_PUNCTUATION, '')
}

function linkAt(text: string, cursor: number): { end: number; token: InlineToken } | undefined {
  const ch = text[cursor]
  if (ch === '[') {
    MARKDOWN_LINKED_IMAGE.lastIndex = cursor
    const linkedImg = MARKDOWN_LINKED_IMAGE.exec(text)
    if (linkedImg?.index === cursor) {
      return {
        end: cursor + linkedImg[0].length,
        token: { kind: 'image', alt: linkedImg[1]!, url: linkedImg[2]!, linkUrl: linkedImg[3]! },
      }
    }
    MARKDOWN_LINK.lastIndex = cursor
    const markdown = MARKDOWN_LINK.exec(text)
    if (markdown?.index === cursor) {
      return { end: cursor + markdown[0].length, token: { kind: 'link', text: markdown[1]!, url: markdown[2]! } }
    }
  } else if (ch === '!') {
    MARKDOWN_IMAGE.lastIndex = cursor
    const img = MARKDOWN_IMAGE.exec(text)
    if (img?.index === cursor) {
      return {
        end: cursor + img[0].length,
        token: { kind: 'image', alt: img[1]!, url: img[2]! },
      }
    }
  } else if (ch === 'h') {
    BARE_URL.lastIndex = cursor
    const bare = BARE_URL.exec(text)
    if (bare?.index === cursor) {
      const url = trimBareUrl(bare[0])
      if (url.length > 0) return { end: cursor + url.length, token: { kind: 'link', text: url, url } }
    }
  }
  return undefined
}

/** Tokenize one line's inline markdown: links, `code`, **bold**, *italic*. */
export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  // Scan left-to-right so code spans win over link-like text inside code.
  let cursor = 0
  let textStart = 0
  const flushText = (end: number): void => {
    if (textStart < end) tokens.push(...tokenizeEmphasis(text.slice(textStart, end)))
  }
  while (cursor < text.length) {
    if (text[cursor] === '`') {
      const end = text.indexOf('`', cursor + 1)
      if (end >= 0) {
        flushText(cursor)
        tokens.push({ kind: 'code', text: text.slice(cursor + 1, end) })
        cursor = end + 1
        textStart = cursor
        continue
      }
    }
    const link = linkAt(text, cursor)
    if (link) {
      flushText(cursor)
      tokens.push(link.token)
      cursor = link.end
      textStart = cursor
      continue
    }
    cursor++
  }
  flushText(text.length)
  return tokens.length > 0 ? tokens : [{ kind: 'text', text }]
}

function tokenizeEmphasis(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  const pattern = /\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > cursor) tokens.push({ kind: 'text', text: text.slice(cursor, start) })
    cursor = start + match[0].length
    if (match[1] !== undefined) tokens.push({ kind: 'bold', text: match[1] })
    else if (match[2] !== undefined) tokens.push({ kind: 'italic', text: match[2] })
  }
  if (cursor < text.length) tokens.push({ kind: 'text', text: text.slice(cursor) })
  return tokens.length > 0 ? tokens : [{ kind: 'text', text }]
}

export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const fence = FENCE_OPEN.exec(line.trim())
    if (fence) {
      const language = fence[1] ?? ''
      const body: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        body.push(lines[i] ?? '')
        i++
      }
      i++ // consume closing fence (or EOF for a streaming open block)
      blocks.push({ kind: 'code', language, text: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line.trim())
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length as 1 | 2 | 3, text: heading[2]!.trim() })
      i++
      continue
    }
    const bullet = BULLET.exec(line.trim())
    if (bullet) {
      const items: string[] = []
      while (i < lines.length) {
        const match = BULLET.exec((lines[i] ?? '').trim())
        if (!match) break
        items.push(match[1]!.trim())
        i++
      }
      blocks.push({ kind: 'bullet-list', items })
      continue
    }
    const ordered = ORDERED.exec(line.trim())
    if (ordered) {
      const items: string[] = []
      while (i < lines.length) {
        const match = ORDERED.exec((lines[i] ?? '').trim())
        if (!match) break
        items.push(match[1]!.trim())
        i++
      }
      blocks.push({ kind: 'ordered-list', items })
      continue
    }
    const quote = QUOTE.exec(line.trim())
    if (quote) {
      const body: string[] = []
      while (i < lines.length) {
        const match = QUOTE.exec((lines[i] ?? '').trim())
        if (!match) break
        body.push(match[1]!.trim())
        i++
      }
      blocks.push({ kind: 'quote', text: body.join(' ') })
      continue
    }
    if (isTableStart(lines, i)) {
      const headers = tableCells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length) {
        const current = lines[i] ?? ''
        if (!current.trim() || !current.includes('|')) break
        const cells = tableCells(current)
        while (cells.length < headers.length) cells.push('')
        if (cells.length > headers.length) cells.length = headers.length
        rows.push(cells)
        i++
      }
      blocks.push({ kind: 'table', headers, rows })
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const paragraph: string[] = []
    while (i < lines.length) {
      const current = lines[i] ?? ''
      if (!current.trim()) break
      const trimmed = current.trim()
      if (
        FENCE_OPEN.test(trimmed) ||
        HEADING.test(trimmed) ||
        BULLET.test(trimmed) ||
        ORDERED.test(trimmed) ||
        QUOTE.test(trimmed) ||
        isTableStart(lines, i)
      ) break
      paragraph.push(trimmed)
      i++
    }
    const hasPipes = paragraph.some((l) => l.includes('|'))
    blocks.push({ kind: 'paragraph', text: hasPipes ? paragraph.join('\n') : paragraph.join(' ') })
  }
  return blocks
}
