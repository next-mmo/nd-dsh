import { describe, expect, it } from 'vitest'
import {
  buildDubbingPrompt,
  chunkSrtBlocks,
  cleanSrtResponse,
  formatSrt,
  mergeTranslatedChunk,
  parseSrt,
} from '../src/main/rest-api/srt-parser.js'

describe('SRT Parser & Dubbing Translation Engine', () => {
  const sampleSrt = `1
00:00:02,140 --> 00:00:18,170
[SPEAKER_00] 已经走了爹爹爹你醒醒爹你醒醒我给你拿药了大夫说了大夫说吃药就能好爹我给你拿药

2
00:00:18,170 --> 00:00:19,980
[SPEAKER_02] 大`

  it('parses standard SRT with speaker tags', () => {
    const blocks = parseSrt(sampleSrt)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!).toEqual({
      index: 1,
      timecode: '00:00:02,140 --> 00:00:18,170',
      text: '[SPEAKER_00] 已经走了爹爹爹你醒醒爹你醒醒我给你拿药了大夫说了大夫说吃药就能好爹我给你拿药',
      speakerTag: '[SPEAKER_00]',
    })
    expect(blocks[1]!).toEqual({
      index: 2,
      timecode: '00:00:18,170 --> 00:00:19,980',
      text: '[SPEAKER_02] 大',
      speakerTag: '[SPEAKER_02]',
    })
  })

  it('handles UTF-8 BOM and Windows CRLF line endings', () => {
    const bomCrlf = '\uFEFF1\r\n00:00:01,000 --> 00:00:03,000\r\n[Alice] Hello\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\n[Bob] Hi Alice\r\n'
    const blocks = parseSrt(bomCrlf)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.speakerTag).toBe('[Alice]')
    expect(blocks[1]?.speakerTag).toBe('[Bob]')
    expect(blocks[0]?.text).toBe('[Alice] Hello')
  })

  it('formats blocks back to standard SRT', () => {
    const blocks = parseSrt(sampleSrt)
    const formatted = formatSrt(blocks)
    expect(formatted.trim()).toBe(sampleSrt.trim())
  })

  it('chunks SRT blocks correctly according to batchSize', () => {
    const blocks = [
      { index: 1, timecode: '00:00:01,000 --> 00:00:02,000', text: 'One' },
      { index: 2, timecode: '00:00:02,000 --> 00:00:03,000', text: 'Two' },
      { index: 3, timecode: '00:00:03,000 --> 00:00:04,000', text: 'Three' },
      { index: 4, timecode: '00:00:04,000 --> 00:00:05,000', text: 'Four' },
      { index: 5, timecode: '00:00:05,000 --> 00:00:06,000', text: 'Five' },
    ]
    const chunks = chunkSrtBlocks(blocks, 2)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]!).toHaveLength(2)
    expect(chunks[1]!).toHaveLength(2)
    expect(chunks[2]!).toHaveLength(1)
  })

  it('cleans markdown fences and conversational preamble from LLM response', () => {
    const responseWithFences = `Here is the translation:

\`\`\`srt
1
00:00:02,140 --> 00:00:18,170
[SPEAKER_00] ឪពុក! ឪពុក! ភ្ញាក់ឡើងទៅ!

2
00:00:18,170 --> 00:00:19,980
[SPEAKER_02] លោកគ្រូ
\`\`\`

Hope this helps!`

    const cleaned = cleanSrtResponse(responseWithFences)
    const blocks = parseSrt(cleaned)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.text).toBe('[SPEAKER_00] ឪពុក! ឪពុក! ភ្ញាក់ឡើងទៅ!')
    expect(blocks[1]?.text).toBe('[SPEAKER_02] លោកគ្រូ')
  })

  it('merges translated chunk strictly preserving original numbering, timecodes, and speaker tags', () => {
    const originalBlocks = parseSrt(sampleSrt)
    // Suppose the LLM translated without speaker tags or slightly modified timecode
    const llmOutput = `1
00:00:02,000 --> 00:00:18,000
ឪពុក! ឪពុក! ភ្ញាក់ឡើងទៅ!

2
00:00:18,000 --> 00:00:19,000
លោកគ្រូ`

    const merged = mergeTranslatedChunk(originalBlocks, llmOutput)
    expect(merged).toHaveLength(2)
    // Numbering preserved
    expect(merged[0]?.index).toBe(1)
    expect(merged[1]?.index).toBe(2)
    // Original timecode strictly preserved!
    expect(merged[0]?.timecode).toBe('00:00:02,140 --> 00:00:18,170')
    expect(merged[1]?.timecode).toBe('00:00:18,170 --> 00:00:19,980')
    // Original speaker tag retained and re-prepended!
    expect(merged[0]?.text).toBe('[SPEAKER_00] ឪពុក! ឪពុក! ភ្ញាក់ឡើងទៅ!')
    expect(merged[1]?.text).toBe('[SPEAKER_02] លោកគ្រូ')
  })

  it('builds dubbing prompt adhering to dubbing-speaker-translate SKILL instructions', () => {
    const prompt = buildDubbingPrompt(sampleSrt, 'Khmer')
    expect(prompt).toContain('Translate the following subtitles into natural Khmer suitable for professional movie dubbing.')
    expect(prompt).toContain('Keep the exact SRT format unchanged.')
    expect(prompt).toContain('Preserve subtitle numbering exactly.')
    expect(prompt).toContain('Preserve all original timecodes exactly.')
    expect(prompt).toContain('Keep all speaker tags such as [SPEAKER_00], [SPEAKER_01], [Alice], etc.')
    expect(prompt).toContain('Do not remove, rename, translate, or reorder speaker tags.')
    expect(prompt).toContain('Output ONLY valid SRT subtitles.')
    expect(prompt).toContain(sampleSrt.trim())
  })
})
