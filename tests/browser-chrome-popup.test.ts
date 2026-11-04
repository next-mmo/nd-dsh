import { describe, expect, it } from 'vitest'
import {
  BROWSER_CHROME_POPUP_GUTTER,
  asBrowserChromePopupAction,
  asBrowserChromePopupAnchor,
  asBrowserChromePopupModel,
  asBrowserChromePopupOpenRequest,
  asBrowserChromePopupSize,
  browserChromePopupActionDismisses,
  browserChromePopupBounds,
} from '../src/shared/browser-chrome-popup.js'

describe('browser-chrome-popup shared contracts and layout', () => {
  it('parses valid anchors and clamps invalid numbers', () => {
    const anchor = asBrowserChromePopupAnchor({ x: 100, y: 50, width: 30, height: 28 })
    expect(anchor).toEqual({ x: 100, y: 50, width: 30, height: 28 })

    expect(() => asBrowserChromePopupAnchor('invalid')).toThrow()
  })

  it('parses and validates sizes', () => {
    const size = asBrowserChromePopupSize({ width: 320, height: 240 })
    expect(size).toEqual({ width: 320, height: 240 })
  })

  it('parses extensions model', () => {
    const model = asBrowserChromePopupModel({
      kind: 'extensions',
      theme: 'dark',
      developerMode: true,
      canManage: true,
      extensions: [
        {
          id: 'ext-1',
          title: 'AdBlock',
          subtitle: 'Active',
          enabled: true,
          canOpen: false,
        },
      ],
    })
    expect(model.kind).toBe('extensions')
    if (model.kind === 'extensions') {
      expect(model.extensions).toHaveLength(1)
      expect(model.extensions[0]?.id).toBe('ext-1')
      expect(model.theme).toBe('dark')
    }
  })

  it('parses profiles model', () => {
    const model = asBrowserChromePopupModel({
      kind: 'profiles',
      theme: 'light',
      canManage: false,
      profiles: [
        {
          id: 'p-1',
          name: 'Work',
          color: '#ff0000',
          tabCount: 5,
          isDefault: false,
          active: true,
        },
      ],
    })
    expect(model.kind).toBe('profiles')
    if (model.kind === 'profiles') {
      expect(model.profiles[0]?.name).toBe('Work')
      expect(model.theme).toBe('light')
    }
  })

  it('parses actions and identifies dismiss behavior', () => {
    const toggleAction = asBrowserChromePopupAction({ type: 'extension-toggle', id: 'test', enabled: true })
    expect(browserChromePopupActionDismisses(toggleAction)).toBe(false)

    const openAction = asBrowserChromePopupAction({ type: 'extension-open', id: 'test' })
    expect(browserChromePopupActionDismisses(openAction)).toBe(true)

    const settingsAction = asBrowserChromePopupAction({ type: 'open-settings' })
    expect(browserChromePopupActionDismisses(settingsAction)).toBe(true)
  })

  it('parses full open request', () => {
    const request = asBrowserChromePopupOpenRequest({
      anchor: { x: 500, y: 35, width: 28, height: 28 },
      model: {
        kind: 'extensions',
        theme: 'dark',
        developerMode: false,
        canManage: true,
        extensions: [],
      },
    })
    expect(request.anchor.x).toBe(500)
    expect(request.model.kind).toBe('extensions')
  })

  it('calculates popup bounds positioned below anchor with gutter', () => {
    const anchor = { x: 800, y: 35, width: 30, height: 27 }
    const card = { width: 320, height: 200 }
    const content = { width: 1200, height: 800 }

    const bounds = browserChromePopupBounds(anchor, card, content)
    // card is right-aligned to anchor right edge: 800 + 30 = 830, cardX = 830 - 320 = 510
    // with gutter: x = 510 - 14 = 496, width = 320 + 28 = 348
    // y below: anchor.y + anchor.height + 6 = 35 + 27 + 6 = 68
    // with gutter: y = 68 - 14 = 54, height = 200 + 28 = 228
    expect(bounds.x).toBe(510 - BROWSER_CHROME_POPUP_GUTTER)
    expect(bounds.y).toBe(68 - BROWSER_CHROME_POPUP_GUTTER)
    expect(bounds.width).toBe(320 + BROWSER_CHROME_POPUP_GUTTER * 2)
    expect(bounds.height).toBe(200 + BROWSER_CHROME_POPUP_GUTTER * 2)
  })

  it('flips popup above anchor when insufficient room below', () => {
    const anchor = { x: 800, y: 750, width: 30, height: 27 }
    const card = { width: 320, height: 200 }
    const content = { width: 1200, height: 800 }

    const bounds = browserChromePopupBounds(anchor, card, content)
    // below room is only 800 - (750 + 27 + 6) - 4 = 13px
    // above room is 750 - 6 - 4 = 740px -> flips above
    // cardY = anchor.y - gap - cardHeight = 750 - 6 - 200 = 544
    expect(bounds.y).toBe(544 - BROWSER_CHROME_POPUP_GUTTER)
  })
})
