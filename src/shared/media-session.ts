/** Now-playing metadata read out of a browser tab via the Media Session API. */
export interface NdMediaMetadata {
  title: string
  artist?: string
  album?: string
  /** http(s) artwork source when the page published one. */
  artworkUrl?: string
}

/**
 * The one media session the quick launcher transport row drives: the most
 * recently active browser tab that played media, playing or paused.
 */
export interface NdMediaSessionState {
  tabId: string
  playing: boolean
  title: string
  artist?: string
  album?: string
  artworkUrl?: string
  /** Bare hostname, e.g. "youtube.com". */
  site: string
  url: string
  updatedAt: number
}

/** OS media transport keys the sidecar can synthesize as a fallback. */
export type NdMediaKeyKind = 'play-pause' | 'next' | 'previous'
