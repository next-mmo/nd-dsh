import type { WebContents } from 'electron'

export function isYouTubePage(url: string): boolean {
  try {
    const parsed = new URL(url)
    return /^https?:$/.test(parsed.protocol) && /(^|\.)youtube(-nocookie)?\.com$/.test(parsed.hostname)
  } catch { return false }
}

// MAIN-world hooks survive extension removal. A fresh document is needed when
// ND toggles or updates the blocker; preserve the user's content position and
// playback preferences while discarding those old hooks.
export async function refreshAdBlockPage(contents: WebContents): Promise<void> {
  if (contents.isDestroyed() || !isYouTubePage(contents.getURL())) return
  const url = contents.getURL()
  const playback = await contents.executeJavaScript(`(() => {
    const player = document.querySelector('#movie_player, .html5-video-player');
    const video = player?.querySelector('video.html5-main-video, video');
    if (!video || player.classList.contains('ad-showing')) return null;
    return { time: video.currentTime, paused: video.paused, muted: video.muted,
      rate: video.playbackRate, volume: video.volume };
  })()`).catch(() => null)
  if (contents.isDestroyed()) return
  if (contents.getURL() !== url) return
  await contents.loadURL(url).catch(() => undefined)
  if (!playback || contents.isDestroyed() || contents.getURL() !== url) return
  await contents.executeJavaScript(`(async () => {
    const saved = ${JSON.stringify(playback)};
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (location.href !== ${JSON.stringify(url)}) return;
      const player = document.querySelector('#movie_player, .html5-video-player');
      const video = player?.querySelector('video.html5-main-video, video');
      if (video?.readyState >= 1 && !player.classList.contains('ad-showing')) {
        video.currentTime = Math.min(saved.time, Number.isFinite(video.duration) ? video.duration : saved.time);
        video.muted = saved.muted;
        video.playbackRate = saved.rate;
        video.volume = saved.volume;
        if (saved.paused) video.pause(); else await video.play().catch(() => undefined);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  })()`).catch(() => undefined)
}
