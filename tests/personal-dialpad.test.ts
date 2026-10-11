import { describe, expect, it } from 'vitest'
import { PERSONAL_DIALPAD_SITES, dialpadSiteLabel, dialpadTiles } from '../src/shared/personal-dialpad.js'

describe('Personal dialpad tiles', () => {
  it('opens on the built-in top sites', () => {
    const tiles = dialpadTiles([])
    expect(tiles.map((tile) => tile.title)).toEqual([
      'Google', 'YouTube', 'Gmail', 'Maps', 'Translate', 'Wikipedia', 'GitHub', 'X', 'Reddit',
    ])
    expect(tiles.every((tile) => tile.kind === 'site')).toBe(true)
    expect(tiles.every((tile) => tile.url.startsWith('https://'))).toBe(true)
  })

  it('puts the user\'s own links first', () => {
    const tiles = dialpadTiles([{ id: 'l1', url: 'https://news.ycombinator.com/', title: '' }])
    expect(tiles[0]).toMatchObject({ id: 'l1', title: 'news.ycombinator.com', kind: 'saved' })
    expect(tiles).toHaveLength(PERSONAL_DIALPAD_SITES.length + 1)
  })

  it('lets a saved link replace the built-in tile for the same address', () => {
    const tiles = dialpadTiles([{ id: 'l1', url: 'https://www.youtube.com/', title: 'Videos' }])
    const youtube = tiles.filter((tile) => /youtube\.com/i.test(tile.url))
    expect(youtube).toHaveLength(1)
    expect(youtube[0]).toMatchObject({ id: 'l1', title: 'Videos', kind: 'saved' })
    expect(tiles.some((tile) => tile.id === 'site:youtube')).toBe(false)
  })

  it('treats a trailing slash as the same address', () => {
    const tiles = dialpadTiles([{ id: 'l1', url: 'https://github.com', title: 'Code' }])
    expect(tiles.some((tile) => tile.id === 'site:github')).toBe(false)
  })

  it('keeps a path-bearing saved link separate from the site root', () => {
    const tiles = dialpadTiles([{ id: 'l1', url: 'https://www.google.com/maps/place/Rome', title: 'Rome' }])
    expect(tiles.some((tile) => tile.id === 'l1')).toBe(true)
    expect(tiles.some((tile) => tile.id === 'site:maps')).toBe(true)
  })
})

describe('dialpad labels', () => {
  it('prefers the typed title', () => {
    expect(dialpadSiteLabel('https://example.com/a', '  My page  ')).toBe('My page')
  })

  it('falls back to the host without www', () => {
    expect(dialpadSiteLabel('https://www.example.com/deep/path')).toBe('example.com')
    expect(dialpadSiteLabel('not a url')).toBe('not a url')
  })
})
