import { useState } from 'react'
import { Globe, Music2 } from 'lucide-react'
import type { NdMediaSessionState } from '../../../shared/media-session'

/** Keep broken remote artwork from leaving a broken-image glyph in the launcher. */
export function MediaArtwork({ media }: { media: NdMediaSessionState }) {
  const [artworkFailed, setArtworkFailed] = useState(false)
  const [faviconFailed, setFaviconFailed] = useState(false)
  let siteUrl: URL | undefined
  try {
    const parsed = new URL(media.url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') siteUrl = parsed
  } catch { /* A session without a website still gets a local media icon. */ }
  const hostname = siteUrl?.hostname.toLowerCase() ?? ''
  const youtube = hostname === 'youtu.be' || hostname === 'youtube.com' || hostname.endsWith('.youtube.com')
  const artworkUrl = media.artworkUrl?.startsWith('https://') ? media.artworkUrl : undefined
  const faviconUrl = siteUrl?.protocol === 'https:' ? new URL('/favicon.ico', siteUrl.origin).href : undefined

  if (artworkUrl && !artworkFailed) {
    return <img src={artworkUrl} alt="" referrerPolicy="no-referrer" className="size-8 shrink-0 rounded-md object-cover" onError={() => setArtworkFailed(true)} />
  }
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border-soft bg-surface-2 text-faint" aria-hidden="true">
      {youtube ? (
        <svg viewBox="0 0 24 24" className="size-6" focusable="false">
          <rect x="1" y="4" width="22" height="16" rx="5" fill="#ff0000" />
          <path d="m10 8 6 4-6 4z" fill="white" />
        </svg>
      ) : faviconUrl && !faviconFailed ? (
        <img src={faviconUrl} alt="" referrerPolicy="no-referrer" className="size-5 object-contain" onError={() => setFaviconFailed(true)} />
      ) : siteUrl ? <Globe className="size-4" /> : <Music2 className="size-4" />}
    </span>
  )
}
