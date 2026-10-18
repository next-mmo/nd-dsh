import { describe, expect, it } from 'vitest'
import {
  parseGeminiSkillLinkInput,
  isGeminiConversationUrl,
  isGeminiPageUrl,
  parseGeminiConversationUrl,
  sameGeminiUrl,
} from '../src/main/engines/gemini-web/gemini-project-binding.js'

describe('Gemini Web conversation URL parsing (normal chats)', () => {
  it('extracts chat ids from app conversations', () => {
    expect(parseGeminiConversationUrl('https://gemini.google.com/app/fa5b05f3a25f7f76')).toEqual({ chatId: 'fa5b05f3a25f7f76' })
  })

  it('extracts chat ids from multi-account Google URLs (/u/0/app/...)', () => {
    expect(parseGeminiConversationUrl('https://gemini.google.com/u/0/app/fa5b05f3a25f7f76')).toEqual({ chatId: 'fa5b05f3a25f7f76' })
    expect(parseGeminiConversationUrl('https://gemini.google.com/u/1/app/fa5b05f3a25f7f76')).toEqual({ chatId: 'fa5b05f3a25f7f76' })
  })

  it('rejects foreign, legacy gems, or non-conversation URLs', () => {
    expect(parseGeminiConversationUrl('https://evil.com/app/fa5b05f3a25f7f76')).toBeNull()
    expect(parseGeminiConversationUrl('https://gemini.google.com/gem/1e5f6a7b8c9d')).toBeNull()
    expect(parseGeminiConversationUrl('https://gemini.google.com/gems')).toBeNull()
    expect(parseGeminiConversationUrl('https://gemini.google.com/gems/view')).toBeNull()
    expect(parseGeminiConversationUrl('invalid')).toBeNull()
  })

  it('classifies page and conversation URLs', () => {
    expect(isGeminiPageUrl('https://gemini.google.com/app')).toBe(true)
    expect(isGeminiPageUrl('https://chatgpt.com/')).toBe(false)
    expect(isGeminiConversationUrl('https://gemini.google.com/app/fa5b05f3a25f7f76')).toBe(true)
    expect(isGeminiConversationUrl('https://gemini.google.com/u/0/app/fa5b05f3a25f7f76')).toBe(true)
    expect(isGeminiConversationUrl('https://gemini.google.com/gem/1e5f6a7b8c9d')).toBe(false)
    expect(isGeminiConversationUrl('https://gemini.google.com/gems')).toBe(false)
  })

  it('compares conversations by origin and pathname, ignoring query strings and /u/0 prefixes', () => {
    expect(sameGeminiUrl('https://gemini.google.com/app/fa5b05f3a25f7f76?hl=en', 'https://gemini.google.com/app/fa5b05f3a25f7f76')).toBe(true)
    expect(sameGeminiUrl('https://gemini.google.com/u/0/app/fa5b05f3a25f7f76', 'https://gemini.google.com/app/fa5b05f3a25f7f76')).toBe(true)
    expect(sameGeminiUrl('https://gemini.google.com/app/fa5b05f3a25f7f76', 'https://gemini.google.com/app/other123')).toBe(false)
  })
})

describe('Gemini chat and skill link parsing', () => {
  it.each([
    'https://gemini.google.com/app/fa5b05f3a25f7f76',
    'https://gemini.google.com/app/fa5b05f3a25f7f76/',
    'https://gemini.google.com/app/fa5b05f3a25f7f76?hl=en',
    'https://gemini.google.com/app/fa5b05f3a25f7f76#chat',
    'https://gemini.google.com/u/0/app/fa5b05f3a25f7f76',
    'https://gemini.google.com/u/1/app/fa5b05f3a25f7f76',
    'gemini.google.com/app/fa5b05f3a25f7f76',
    '/app/fa5b05f3a25f7f76',
    'fa5b05f3a25f7f76',
  ])('accepts normal chat link %s', (input) => {
    expect(parseGeminiSkillLinkInput(input)).toEqual({
      gemRef: 'fa5b05f3a25f7f76',
      gemId: 'fa5b05f3a25f7f76',
      gemUrl: 'https://gemini.google.com/app/fa5b05f3a25f7f76',
    })
  })

  it.each([
    '',
    'https://gemini.google.com/app',
    'https://gemini.google.com/gem/1e5f6a7b8c9d',
    'https://gemini.google.com/gems',
    'https://gemini.google.com/gems/view/1e5f6a7b8c9d',
    'https://gemini.google.com/customize/skills',
    'https://evil.com/app/fa5b05f3a25f7f76',
    'not a link',
    'abc',
  ])('rejects non-chat or legacy Gem input %j', (input) => {
    expect(parseGeminiSkillLinkInput(input)).toBeNull()
  })
})