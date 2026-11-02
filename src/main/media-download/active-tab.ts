import type { BrowserTabDescriptor } from '../../shared/browser-platform.js'
import { canonicalYouTubeUrl, type YouTubePageRef } from '../../shared/youtube-download.js'

/**
 * Return the active YouTube page, never a background tab.
 *
 * Reading only the tab the user has in front of them is the privacy boundary:
 * the extension cannot enumerate unrelated browsing just to find a video.
 */
export function activeYouTubePage(tabs: readonly BrowserTabDescriptor[]): YouTubePageRef | null {
  const active = tabs.find((tab) => tab.active === true)
  if (!active) return null
  const ref = canonicalYouTubeUrl(active.url)
  if (!ref) return null
  const title = (active.title || '').replace(/\s+/g, ' ').trim().slice(0, 300)
  return { ...ref, title: title || `YouTube ${ref.videoId}` }
}
