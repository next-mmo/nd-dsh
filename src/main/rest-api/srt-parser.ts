import type { SrtBlock } from '../../shared/rest-api.js'

export type { SrtBlock }

/**
 * Parses raw SRT string into structured SrtBlock array.
 * Robust against BOM, CRLF/LF newlines, omitted block indices, and multiline text.
 */
export function parseSrt(raw: string): SrtBlock[] {
  if (!raw || typeof raw !== 'string') return []
  const cleaned = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (!cleaned) return []

  const rawBlocks = cleaned.split(/\n\s*\n+/)
  const blocks: SrtBlock[] = []

  for (const rawBlock of rawBlocks) {
    const lines = rawBlock.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    if (lines.length === 0) continue

    let index = blocks.length + 1
    let timecode = ''
    let textLines: string[] = []

    const line0 = lines[0] ?? ''
    const line1 = lines[1] ?? ''

    if (/^\d+$/.test(line0) && lines.length >= 2 && line1.includes('-->')) {
      index = parseInt(line0, 10)
      timecode = line1
      textLines = lines.slice(2)
    } else if (line0.includes('-->')) {
      timecode = line0
      textLines = lines.slice(1)
    } else {
      const arrowIndex = lines.findIndex((l) => l.includes('-->'))
      if (arrowIndex >= 0) {
        const prevLine = lines[arrowIndex - 1]
        if (arrowIndex > 0 && prevLine && /^\d+$/.test(prevLine)) {
          index = parseInt(prevLine, 10)
        }
        timecode = lines[arrowIndex] ?? ''
        textLines = lines.slice(arrowIndex + 1)
      } else {
        textLines = lines
      }
    }

    const text = textLines.join('\n').trim()
    const speakerMatch = text.match(/^(\[[^\]]+\])/)
    const speakerTag = speakerMatch ? speakerMatch[1] : undefined

    blocks.push({
      index,
      timecode: timecode.trim(),
      text,
      ...(speakerTag ? { speakerTag } : {}),
    })
  }

  return blocks
}

/**
 * Serializes SrtBlock array back to standard, valid SRT format.
 */
export function formatSrt(blocks: SrtBlock[]): string {
  if (!blocks || blocks.length === 0) return ''
  return (
    blocks
      .map((b, i) => {
        const idx = b.index || i + 1
        const tc = b.timecode ? b.timecode : '00:00:00,000 --> 00:00:00,000'
        return `${idx}\n${tc}\n${b.text.trim()}`
      })
      .join('\n\n') + '\n'
  )
}

/**
 * Splits blocks into batches of size `batchSize` (default: 25).
 */
export function chunkSrtBlocks(blocks: SrtBlock[], batchSize = 25): SrtBlock[][] {
  const size = Math.max(1, batchSize)
  const chunks: SrtBlock[][] = []
  for (let i = 0; i < blocks.length; i += size) {
    chunks.push(blocks.slice(i, i + size))
  }
  return chunks
}

/**
 * Strips code fences and conversational filler from LLM response.
 */
export function cleanSrtResponse(response: string): string {
  if (!response || typeof response !== 'string') return ''
  let cleaned = response.trim()

  // 1. Strip markdown code fences if wrapped in ```srt ... ``` or ``` ... ```
  const codeBlockMatch = cleaned.match(/```(?:srt|subrip)?\s*([\s\S]*?)```/i)
  const fenced = codeBlockMatch?.[1]
  if (fenced && fenced.trim()) {
    cleaned = fenced.trim()
  } else {
    cleaned = cleaned.replace(/^```(?:srt|subrip)?\s*/i, '').replace(/```\s*$/i, '').trim()
  }

  // 2. Remove conversational preamble before the first SRT block
  const srtStartMatch = cleaned.match(/(?:^|\n)(\d+\s*\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}[\s\S]*)$/)
  const startMatched = srtStartMatch?.[1]
  if (startMatched) {
    cleaned = startMatched.trim()
  }

  return cleaned.trim()
}

/**
 * Merges raw translated response with original chunk, strictly preserving original
 * numbering, timecodes, and speaker tags even if LLM modified or omitted them.
 */
export function mergeTranslatedChunk(originalChunk: SrtBlock[], rawTranslation: string): SrtBlock[] {
  const cleaned = cleanSrtResponse(rawTranslation)
  const parsedTranslated = parseSrt(cleaned)

  // 1. Ideal case: parsed blocks count matches original length
  if (parsedTranslated.length === originalChunk.length) {
    return originalChunk.map((orig, i) => {
      const trans = parsedTranslated[i]
      let text = trans?.text.trim() ?? orig.text.trim()

      if (orig.speakerTag) {
        if (!text.startsWith(orig.speakerTag)) {
          if (/^\[[^\]]+\]/.test(text)) {
            text = text.replace(/^\[[^\]]+\]\s*/, `${orig.speakerTag} `)
          } else {
            text = `${orig.speakerTag} ${text}`
          }
        }
      }

      return {
        index: orig.index,
        timecode: orig.timecode,
        text,
        ...(orig.speakerTag ? { speakerTag: orig.speakerTag } : {}),
      }
    })
  }

  // 2. If parsed translated has some blocks
  if (parsedTranslated.length > 0) {
    return originalChunk.map((orig, i) => {
      const trans = parsedTranslated[i]
      if (trans && trans.text.trim()) {
        let text = trans.text.trim()
        if (orig.speakerTag && !text.startsWith(orig.speakerTag)) {
          if (/^\[[^\]]+\]/.test(text)) {
            text = text.replace(/^\[[^\]]+\]\s*/, `${orig.speakerTag} `)
          } else {
            text = `${orig.speakerTag} ${text}`
          }
        }
        return {
          index: orig.index,
          timecode: orig.timecode,
          text,
          ...(orig.speakerTag ? { speakerTag: orig.speakerTag } : {}),
        }
      }
      return orig
    })
  }

  // 3. Fallback: if translation output lines of dialogue without block structure
  const lines = cleaned.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !/^\d+$/.test(l) && !l.includes('-->'))
  if (lines.length === originalChunk.length) {
    return originalChunk.map((orig, i) => {
      let text = lines[i] ?? orig.text
      if (orig.speakerTag && !text.startsWith(orig.speakerTag)) {
        if (/^\[[^\]]+\]/.test(text)) {
          text = text.replace(/^\[[^\]]+\]\s*/, `${orig.speakerTag} `)
        } else {
          text = `${orig.speakerTag} ${text}`
        }
      }
      return {
        index: orig.index,
        timecode: orig.timecode,
        text,
        ...(orig.speakerTag ? { speakerTag: orig.speakerTag } : {}),
      }
    })
  }

  // Final fallback
  return originalChunk
}

/**
 * Builds the movie dubbing translation prompt following .agents/skills/dubbing-speaker-translate/SKILL.md
 */
export function buildDubbingPrompt(
  srtChunkText: string,
  targetLanguage = 'Khmer',
  customInstructions?: string,
): string {
  const customSection = customInstructions?.trim() ? `\nAdditional instructions:\n${customInstructions.trim()}\n` : ''

  return [
    `Translate the following subtitles into natural ${targetLanguage} suitable for professional movie dubbing.`,
    '',
    'Requirements:',
    '- Keep the exact SRT format unchanged.',
    '- Preserve subtitle numbering exactly.',
    '- Preserve all original timecodes exactly.',
    '- Keep all speaker tags such as [SPEAKER_00], [SPEAKER_01], [Alice], etc.',
    '- Do not remove, rename, translate, or reorder speaker tags.',
    `- Translate only the dialogue text into ${targetLanguage}.`,
    `- Make the ${targetLanguage} sound natural, emotional, conversational, and easy for voice actors to perform.`,
    '- Use short, smooth sentences that fit the subtitle timing.',
    '- Match the character tone, emotion, urgency, and relationship in each scene.',
    `- Prefer spoken ${targetLanguage} for dubbing, not stiff written ${targetLanguage}.`,
    `- Avoid overly formal ${targetLanguage} unless the character or scene requires it.`,
    '- Keep line length practical for subtitle timing and mouth movement.',
    `- If a line is already ${targetLanguage}, lightly improve naturalness only when needed.`,
    '- Do not add explanations, notes, markdown, code fences, or extra formatting.',
    '- Output ONLY valid SRT subtitles.',
    customSection,
    'Subtitles to translate:',
    srtChunkText.trim(),
  ].filter(Boolean).join('\n')
}
