import { describe, expect, it } from 'vitest'
import {
  isGeminiConversationUrl,
  isGeminiPageUrl,
  parseGeminiConversationUrl,
  parseGeminiGemInput,
  sameGeminiUrl,
} from '../src/main/engines/gemini-web/gemini-project-binding.js'

describe('Gemini Web Gem parsing', () => {
  it.each([
    ['https://gemini.google.com/gem/1e5f6a7b8c9d', '1e5f6a7b8c9d'],
    ['https://gemini.google.com/gems/view/1e5f6a7b8c9d', '1e5f6a7b8c9d'],
    ['https://gemini.google.com/gems/connect/1e5f6a7b8c9d', '1e5f6a7b8c9d'],
    ['https://gemini.google.com/gems/1e5f6a7b8c9d', '1e5f6a7b8c9d'],
    ['/gem/1e5f6a7b8c9d', '1e5f6a7b8c9d'],
  ])('parses %s into a Gem descriptor', (input, id) => {
    expect(parseGeminiGemInput(input)).toEqual({
      gemRef: id,
      gemId: id,
      gemUrl: `https://gemini.google.com/gem/${id}`,
    })
  })

  it.each(['https://evil.com/gem/123', 'not a gem', '', 'https://gemini.google.com/gems/view?dest=create'])(
    'rejects %s',
    (input) => {
      expect(parseGeminiGemInput(input)).toBeNull()
    },
  )
})

describe('Gemini Web conversation URL parsing', () => {
  it('extracts chat ids from app conversations', () => {
    expect(parseGeminiConversationUrl('https://gemini.google.com/app/2f63e0a1-1234')).toEqual({ chatId: '2f63e0a1-1234' })
  })

  it('extracts gem ids from gem chats', () => {
    expect(parseGeminiConversationUrl('https://gemini.google.com/gem/1e5f6a7b8c9d')).toEqual({ gemId: '1e5f6a7b8c9d' })
  })

  it('rejects foreign or non-conversation URLs', () => {
    expect(parseGeminiConversationUrl('https://evil.com/app/123')).toBeNull()
    expect(parseGeminiConversationUrl('https://gemini.google.com/gems')).toBeNull()
    expect(parseGeminiConversationUrl('invalid')).toBeNull()
  })

  it('classifies page and conversation URLs', () => {
    expect(isGeminiPageUrl('https://gemini.google.com/app')).toBe(true)
    expect(isGeminiPageUrl('https://chatgpt.com/')).toBe(false)
    expect(isGeminiConversationUrl('https://gemini.google.com/app/abc')).toBe(true)
    expect(isGeminiConversationUrl('https://gemini.google.com/gem/abc')).toBe(true)
    expect(isGeminiConversationUrl('https://gemini.google.com/gems')).toBe(false)
  })

  it('compares conversations by origin and pathname', () => {
    expect(sameGeminiUrl('https://gemini.google.com/app/abc?hl=en', 'https://gemini.google.com/app/abc')).toBe(true)
    expect(sameGeminiUrl('https://gemini.google.com/app/abc', 'https://gemini.google.com/app/def')).toBe(false)
  })
})
