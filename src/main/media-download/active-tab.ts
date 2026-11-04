import type { BrowserTabDescriptor } from '../../shared/browser-platform.js'
import { canonicalYouTubeUrl, type YouTubePageRef } from '../../shared/youtube-download.js'
import { BUILTIN_BROWSER_TARGET_ID } from '../browser/browser-controller.js'

/**
 * Return the active YouTube page, never a background tab.
 *
 * Checks the active tab of the preferred target (or built-in browser first),
 * then falls back to any connected companion browser (e.g. Chrome) active tab.
 *
 * Reading only the tab the user has in front of them is the privacy boundary:
 * the extension cannot enumerate unrelated browsing just to find a video.
 */
export function activeYouTubePage(
  tabs: readonly BrowserTabDescriptor[],
  preferredTargetId?: string,
): YouTubePageRef | null {
  const activeTabs = tabs.filter((tab) => tab.active === true)
  if (activeTabs.length === 0) return null

  // 1. If an explicit target is preferred (e.g. active target selection), check it first.
  if (preferredTargetId) {
    const preferred = activeTabs.find((tab) => tab.targetId === preferredTargetId)
    if (preferred) {
      const ref = canonicalYouTubeUrl(preferred.url)
      if (ref) {
        const title = (preferred.title || '').replace(/\s+/g, ' ').trim().slice(0, 300)
        return { ...ref, title: title || `YouTube ${ref.videoId}` }
      }
    }
  }

  // 2. Check the built-in browser active tab.
  const builtin = activeTabs.find((tab) => tab.targetId === BUILTIN_BROWSER_TARGET_ID)
  if (builtin) {
    const ref = canonicalYouTubeUrl(builtin.url)
    if (ref) {
      const title = (builtin.title || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      return { ...ref, title: title || `YouTube ${ref.videoId}` }
    }
  }

  // 3. Fall back to any active companion tab (e.g. Google Chrome companion).
  for (const companion of activeTabs) {
    if (companion.targetId === BUILTIN_BROWSER_TARGET_ID || companion.targetId === preferredTargetId) continue
    const ref = canonicalYouTubeUrl(companion.url)
    if (ref) {
      const title = (companion.title || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      return { ...ref, title: title || `YouTube ${ref.videoId}` }
    }
  }

  return null
}
