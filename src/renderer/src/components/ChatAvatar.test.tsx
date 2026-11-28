import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CHAT_AVATAR_TONES,
  ChatAvatar,
  chatAvatarMonogram,
  chatAvatarTone,
} from './ChatAvatar'

describe('chatAvatarMonogram', () => {
  it('takes the first two letters of the first word like room/agent badges', () => {
    expect(chatAvatarMonogram('Coupon launch')).toBe('CO')
    expect(chatAvatarMonogram('Shop_bot')).toBe('SH')
    expect(chatAvatarMonogram('Billing_bot')).toBe('BI')
    expect(chatAvatarMonogram('Mobile_bot')).toBe('MO')
  })

  it('combines single-character leading words with the next word', () => {
    expect(chatAvatarMonogram('A quick fix')).toBe('AQ')
    expect(chatAvatarMonogram('X-ray viewer')).toBe('XR')
  })

  it('uses fallbackName when the title is empty or a generic placeholder', () => {
    expect(chatAvatarMonogram('New chat', 'Codex')).toBe('CO')
    expect(chatAvatarMonogram('Untitled', 'Gemini')).toBe('GE')
    expect(chatAvatarMonogram('   ', 'ND Harness')).toBe('ND')
    expect(chatAvatarMonogram('   ')).toBe('ND')
  })

  it('strips leading symbols and emojis before extracting initials', () => {
    expect(chatAvatarMonogram('🚀 Launch prep')).toBe('LA')
    expect(chatAvatarMonogram('#42-fix-auth')).toBe('42')
  })
})

describe('chatAvatarTone', () => {
  it('maps seeds deterministically into the curated palette', () => {
    const first = chatAvatarTone('session-123')
    const second = chatAvatarTone('SESSION-123')
    expect(first).toEqual(second)
    expect(CHAT_AVATAR_TONES).toContain(first)
  })
})

describe('ChatAvatar component', () => {
  it('renders the monogram and status dot for idle and busy chats', () => {
    const idleHtml = renderToStaticMarkup(<ChatAvatar name="Shop_bot" seed="shop-1" status="idle" />)
    expect(idleHtml).toContain('>SH<')
    expect(idleHtml).toContain('data-avatar-status="idle"')
    expect(idleHtml).toContain('bg-success')

    const busyHtml = renderToStaticMarkup(<ChatAvatar name="Billing_bot" seed="billing-1" status="busy" />)
    expect(busyHtml).toContain('>BI<')
    expect(busyHtml).toContain('data-avatar-status="busy"')
    expect(busyHtml).toContain('bg-primary')
  })

  it('omits the status dot when status is none', () => {
    const roomHtml = renderToStaticMarkup(<ChatAvatar name="Coupon launch" status="none" />)
    expect(roomHtml).toContain('>CO<')
    expect(roomHtml).not.toContain('data-avatar-status')
  })
})
