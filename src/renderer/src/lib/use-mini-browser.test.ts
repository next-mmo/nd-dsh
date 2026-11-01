import { describe, expect, it } from 'vitest'
import { isMiniBrowserActive, setMiniBrowserActive } from './use-mini-browser'

describe('use-mini-browser', () => {
  it('toggles mini browser active state and notifies listeners', () => {
    expect(isMiniBrowserActive()).toBe(false)
    setMiniBrowserActive(true)
    expect(isMiniBrowserActive()).toBe(true)
    setMiniBrowserActive(false)
    expect(isMiniBrowserActive()).toBe(false)
  })
})
