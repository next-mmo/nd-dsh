import { describe, expect, it } from 'vitest'
import { NATIVE_VIEW_OVERLAY_SELECTOR } from './use-native-view-occlusion'

describe('use-native-view-occlusion selector logic', () => {
  it('excludes dialogs tagged with data-browser-dialog and popovers tagged with data-browser-overlay from occlusion', () => {
    expect(NATIVE_VIEW_OVERLAY_SELECTOR).toContain('[data-slot="dialog-content"]:not([data-browser-dialog="true"])')
    expect(NATIVE_VIEW_OVERLAY_SELECTOR).toContain('[data-slot="popover-content"]:not([data-browser-overlay="true"])')
  })
})
