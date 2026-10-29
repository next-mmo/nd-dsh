import { describe, expect, it } from 'vitest'
import { searchSettings, SETTINGS_SEARCH_ENTRIES } from '../src/renderer/src/lib/settings-search.js'

describe('settings search', () => {
  it('returns nothing for blank queries', () => {
    expect(searchSettings('   ')).toEqual([])
  })

  it('ranks title matches above keyword matches', () => {
    const results = searchSettings('chrome')
    expect(results[0]?.title).toBe('Browser companions (@Chrome)')
    expect(results.length).toBeGreaterThan(1)
  })

  it('jumps to the browser extensions surface', () => {
    const results = searchSettings('extensions')
    expect(results.some((entry) => entry.id === 'general-browser-extensions')).toBe(true)
  })

  it('jumps to the shortcuts surface from a hotkey query', () => {
    const results = searchSettings('hotkey')
    expect(results[0]?.id).toBe('general-shortcuts')
    expect(results[0]?.subTab).toBe('shortcuts')
  })

  it('jumps to ND Router sub-tabs', () => {
    const playground = searchSettings('playground')
    expect(playground.some((entry) => entry.id === 'router-playground' && entry.routerSubTab === 'playground')).toBe(true)
    const external = searchSettings('external api')
    expect(external.some((entry) => entry.id === 'router-external' && entry.routerSubTab === 'access')).toBe(true)
    const nineRouter = searchSettings('9router')
    expect(nineRouter.some((entry) => entry.id === 'router-9router' && entry.routerSubTab === 'nine-router')).toBe(true)
  })

  it('caps results to keep the dropdown scannable', () => {
    expect(searchSettings('e', 3).length).toBeLessThanOrEqual(3)
    expect(SETTINGS_SEARCH_ENTRIES.length).toBeGreaterThan(10)
  })
})
