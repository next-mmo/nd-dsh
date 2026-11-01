import { describe, expect, it } from 'vitest'

describe('use-native-view-occlusion selector logic', () => {
  it('excludes dialogs tagged with data-browser-dialog from occlusion', () => {
    const OVERLAY_SLOTS = [
      'popover-content',
      'select-content',
      'dropdown-menu-content',
      'dropdown-menu-sub-content',
      'alert-dialog-content',
    ]

    const OVERLAY_SELECTOR = [
      ...OVERLAY_SLOTS.map((slot) => `[data-slot="${slot}"]`),
      '[data-slot="dialog-content"]:not([data-browser-dialog="true"])',
    ].join(',')

    expect(OVERLAY_SELECTOR).toContain('[data-slot="dialog-content"]:not([data-browser-dialog="true"])')
    expect(OVERLAY_SELECTOR).toContain('[data-slot="popover-content"]')
  })
})
