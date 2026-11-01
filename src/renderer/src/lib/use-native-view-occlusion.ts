import { useLayoutEffect, useState } from 'react'

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

/** Native child views composite above DOM portals regardless of CSS z-index. */
export function useNativeViewOcclusion(): boolean {
  const [occluded, setOccluded] = useState(false)
  useLayoutEffect(() => {
    const update = () => setOccluded(document.querySelector(OVERLAY_SELECTOR) !== null)
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true })
    update()
    return () => observer.disconnect()
  }, [])
  return occluded
}
