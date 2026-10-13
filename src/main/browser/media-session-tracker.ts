import type { WebContents } from 'electron'
import type { NdMediaMetadata, NdMediaSessionState } from '../../shared/media-session.js'

interface MediaTabRecord {
  tabId: string
  contents: WebContents
  playing: boolean
  /** 0 until the tab first played media; inactive tabs never surface. */
  lastActivityAt: number
  metadata: NdMediaMetadata | null
  refreshTimer: NodeJS.Timeout | null
  refreshPromise: Promise<void> | null
  revision: number
}

/** playPause result: what the page did, or 'none' when it has no media element. */
export type MediaPlayPauseResult = 'paused' | 'playing' | 'none'

const MEDIA_REFRESH_INTERVAL_MS = 1_000

const METADATA_SCRIPT = `(() => {
  const meta = navigator.mediaSession ? navigator.mediaSession.metadata : null;
  const els = Array.from(document.querySelectorAll('video, audio'));
  const active = els.find((el) => !el.paused && !el.ended) || els[0] || null;
  const artwork = meta && meta.artwork && meta.artwork.length
    ? (meta.artwork.find((entry) => entry && entry.src && /^https?:/.test(entry.src)) || meta.artwork.find((entry) => entry && entry.src))
    : null;
  return {
    title: (meta && meta.title) || (active && active.getAttribute && active.getAttribute('aria-label')) || document.title || '',
    artist: (meta && meta.artist) || '',
    album: (meta && meta.album) || '',
    artworkUrl: artwork && artwork.src ? artwork.src : '',
    playing: els.some((el) => !el.paused && !el.ended),
  };
})()`

const PLAY_PAUSE_SCRIPT = `(() => {
  const els = Array.from(document.querySelectorAll('video, audio'));
  const playing = els.filter((el) => !el.paused && !el.ended);
  if (playing.length) {
    playing.forEach((el) => { try { el.pause(); } catch (error) {} });
    return 'paused';
  }
  if (!els.length) return 'none';
  return Promise.all(els.map((el) => el.play().catch(() => undefined))).then(() => 'playing');
})()`

// Site adapters click the player's own transport buttons; anything else falls
// back to OS media keys, which Chromium-backed tabs and native players both honor.
const SITE_ADAPTER_SCRIPT = `(dir) => {
  const host = location.hostname.replace(/^www\\./, '');
  const adapters = [
    { hosts: ['music.youtube.com'], next: 'ytmusic-player-bar .next-button', prev: 'ytmusic-player-bar .previous-button' },
    { hosts: ['youtube.com'], next: '.ytp-next-button', prev: '.ytp-prev-button' },
    { hosts: ['open.spotify.com'], next: '[data-testid="next-button"]', prev: '[data-testid="previous-button"]' },
    { hosts: ['soundcloud.com'], next: '.playControls__next', prev: '.playControls__prev' },
  ];
  const match = adapters.find((entry) => entry.hosts.some((name) => host === name || host.endsWith('.' + name)));
  if (!match) return false;
  const el = document.querySelector(dir === 'next' ? match.next : match.prev);
  if (!el || typeof el.click !== 'function') return false;
  el.click();
  return true;
}`

/**
 * Watches every embedded browser tab for media playback and exposes the
 * OS-style transport the quick launcher drives: one now-playing session plus
 * play/pause and track skipping. Control is injected into the tab itself
 * (HTMLMediaElement toggle, then per-site transport buttons); when the page
 * offers nothing to press, the caller falls back to OS media keys.
 */
export class BrowserMediaTracker {
  private readonly records = new Map<string, MediaTabRecord>()

  constructor(private readonly onState: (state: NdMediaSessionState | null) => void) {}

  attach(tabId: string, contents: WebContents): void {
    const record: MediaTabRecord = {
      tabId, contents, playing: false, lastActivityAt: 0, metadata: null,
      refreshTimer: null, refreshPromise: null, revision: 0,
    }
    this.records.set(tabId, record)
    contents.on('media-started-playing', () => {
      record.playing = true
      record.lastActivityAt = Date.now()
      ++record.revision
      this.ensureRefreshTimer(record)
      void this.refreshRecord(record)
      this.emit()
    })
    contents.on('media-paused', () => {
      record.playing = false
      record.lastActivityAt = Date.now()
      ++record.revision
      this.ensureRefreshTimer(record)
      // A pause from an auxiliary player must not leave a still-playing page
      // paused in the launcher. Read the current media elements as well.
      void this.refreshRecord(record)
      this.emit()
    })
    contents.on('did-start-navigation', (details) => {
      // SPA history changes and iframe navigations do not replace the player.
      if (!details.isMainFrame || details.isSameDocument) return
      ++record.revision
      record.playing = false
      record.metadata = null
      record.lastActivityAt = 0
      this.clearRefreshTimer(record)
      this.emit()
    })
    contents.on('destroyed', () => {
      ++record.revision
      this.clearRefreshTimer(record)
      if (this.records.delete(tabId)) this.emit()
    })
  }

  /** Reconcile when opening a launcher, including a previously hidden popup. */
  async refresh(): Promise<NdMediaSessionState | null> {
    await Promise.all([...this.records.values()]
      .filter((record) => record.lastActivityAt > 0)
      .map((record) => this.refreshRecord(record)))
    return this.state()
  }

  /** The session the transport row shows, or null when nothing has played. */
  state(): NdMediaSessionState | null {
    const record = this.active()
    if (!record || record.contents.isDestroyed()) return null
    const url = record.contents.getURL()
    return {
      tabId: record.tabId,
      playing: record.playing,
      title: record.metadata?.title || record.contents.getTitle() || 'Media',
      ...(record.metadata?.artist ? { artist: record.metadata.artist } : {}),
      ...(record.metadata?.album ? { album: record.metadata.album } : {}),
      ...(record.metadata?.artworkUrl ? { artworkUrl: record.metadata.artworkUrl } : {}),
      site: siteOf(url),
      url,
      updatedAt: record.lastActivityAt,
    }
  }

  async playPause(): Promise<MediaPlayPauseResult> {
    const record = this.active()
    if (!record || record.contents.isDestroyed()) return 'none'
    const result = await record.contents.executeJavaScript(PLAY_PAUSE_SCRIPT, true).catch(() => 'none')
    if (result !== 'paused' && result !== 'playing') return 'none'
    ++record.revision
    await this.refreshRecord(record)
    return result
  }

  async skip(direction: 'next' | 'previous'): Promise<boolean> {
    const record = this.active()
    if (!record || record.contents.isDestroyed()) return false
    const handled = await record.contents
      .executeJavaScript(`((${SITE_ADAPTER_SCRIPT})(${JSON.stringify(direction)}))`, true)
      .catch(() => false)
    return handled === true
  }

  private active(): MediaTabRecord | undefined {
    const touched = [...this.records.values()].filter((record) => record.lastActivityAt > 0)
    const playing = touched.filter((record) => record.playing)
    const pool = playing.length ? playing : touched
    return pool.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
  }

  private ensureRefreshTimer(record: MediaTabRecord): void {
    if (record.refreshTimer) return
    // Media Session metadata can arrive late or change without another native
    // media-started-playing event. Keep one non-overlapping read per media tab.
    record.refreshTimer = setInterval(() => void this.refreshRecord(record), MEDIA_REFRESH_INTERVAL_MS)
    record.refreshTimer.unref()
  }

  private refreshRecord(record: MediaTabRecord): Promise<void> {
    if (record.refreshPromise) return record.refreshPromise
    if (record.contents.isDestroyed() || record.lastActivityAt === 0) return Promise.resolve()
    const read = async (): Promise<void> => {
      while (!record.contents.isDestroyed() && record.lastActivityAt > 0 && this.records.get(record.tabId) === record) {
        const revision = record.revision
        const value: unknown = await record.contents.executeJavaScript(METADATA_SCRIPT, true)
        if (record.contents.isDestroyed() || record.lastActivityAt === 0 || this.records.get(record.tabId) !== record) return
        // A media event or transport action can overtake a pending read. Take
        // another snapshot before resolving launcher state in that case.
        if (record.revision !== revision) continue
        if (!value || typeof value !== 'object') return
        const raw = value as Record<string, unknown>
        const metadata = asMetadata(value)
        let changed = JSON.stringify(metadata) !== JSON.stringify(record.metadata)
        if (typeof raw.playing === 'boolean' && record.playing !== raw.playing) {
          record.playing = raw.playing
          record.lastActivityAt = Date.now()
          changed = true
        }
        record.metadata = metadata
        if (changed) this.emit()
        return
      }
    }
    record.refreshPromise = read()
      .catch(() => undefined)
      .finally(() => { record.refreshPromise = null })
    return record.refreshPromise
  }

  private clearRefreshTimer(record: MediaTabRecord): void {
    if (record.refreshTimer) clearInterval(record.refreshTimer)
    record.refreshTimer = null
  }

  private emit(): void {
    this.onState(this.state())
  }
}

function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function asMetadata(value: unknown): NdMediaMetadata | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title) return null
  const metadata: NdMediaMetadata = { title }
  if (typeof raw.artist === 'string' && raw.artist.trim()) metadata.artist = raw.artist.trim()
  if (typeof raw.album === 'string' && raw.album.trim()) metadata.album = raw.album.trim()
  if (typeof raw.artworkUrl === 'string' && /^https?:/.test(raw.artworkUrl)) metadata.artworkUrl = raw.artworkUrl
  return metadata
}
