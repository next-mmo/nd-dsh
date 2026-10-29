import { describe, expect, it } from 'vitest'
import { canonicalYouTubeUrl } from '../src/shared/youtube-download.js'

const ID = 'dQw4w9WgXcQ'

describe('canonicalYouTubeUrl', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`, `https://www.youtube.com/watch?v=${ID}`],
    [`https://youtube.com/watch?v=${ID}&list=PL123&index=4&t=30s`, `https://www.youtube.com/watch?v=${ID}`],
    [`https://m.youtube.com/watch?v=${ID}`, `https://www.youtube.com/watch?v=${ID}`],
    [`https://www.youtube.com/watch/?v=${ID}`, `https://www.youtube.com/watch?v=${ID}`],
    [`https://youtu.be/${ID}?si=tracking`, `https://www.youtube.com/watch?v=${ID}`],
    [`https://www.youtube.com/shorts/${ID}?feature=share`, `https://www.youtube.com/watch?v=${ID}`],
    [`https://www.youtube.com/live/${ID}/`, `https://www.youtube.com/watch?v=${ID}`],
    [`  https://youtu.be/${ID}  `, `https://www.youtube.com/watch?v=${ID}`],
  ])('accepts %s', (input, expected) => {
    expect(canonicalYouTubeUrl(input)).toEqual({
      url: expected,
      videoId: ID,
    })
  })

  it.each([
    'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/v/dQw4w9WgXcQ',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/channel/UC123',
    'https://www.youtube.com/@handle',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQextra',
    'https://www.youtube.com/watch',
    `https://www.youtube.com/watch?v=${ID}/extra`,
    `https://youtu.be/${ID}/extra`,
    `https://www.youtube.com/shorts/${ID}/extra`,
    'https://www.youtube.com/',
    'not a url',
    '',
  ])('rejects %s', (input) => {
    expect(canonicalYouTubeUrl(input)).toBeNull()
  })

  it('rejects non-string values', () => {
    expect(canonicalYouTubeUrl(undefined)).toBeNull()
    expect(canonicalYouTubeUrl(null)).toBeNull()
    expect(canonicalYouTubeUrl(123)).toBeNull()
    expect(canonicalYouTubeUrl({ url: `https://youtu.be/${ID}` })).toBeNull()
  })

  it('rejects control characters before URL parsing', () => {
    expect(canonicalYouTubeUrl(`https://youtu.be/${ID}\u0000extra`)).toBeNull()
    expect(canonicalYouTubeUrl(`https://youtu.be/${ID}\nextra`)).toBeNull()
  })
})
