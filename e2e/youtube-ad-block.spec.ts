/// <reference lib="dom" />
import { expect, test } from '@playwright/test'
import { closeApp, launchApp } from './fixtures.js'

// Opt in because this exercises the live site, its current API, and real ad
// inventory. Uses ND's canonical WebContentsView and no automation browser.
test.skip(process.env.ND_DSH_E2E_YOUTUBE !== '1', 'Set ND_DSH_E2E_YOUTUBE=1 to probe live YouTube')
test.setTimeout(120_000)

const VIDEO = process.env.ND_DSH_E2E_YOUTUBE_URL ?? 'https://www.youtube.com/watch?v=kjWPSOq5nlo'
const VIDEO_ID = new URL(VIDEO).searchParams.get('v')!
const PLAYER_STATE = `(() => {
  const player = document.querySelector('#movie_player');
  const response = player?.getPlayerResponse?.();
  const video = player?.querySelector('video.html5-main-video');
  return {
    installed: window.__ndAdBlockInstalled === true,
    videoId: response?.videoDetails?.videoId,
    adPlacements: response?.adPlacements?.length ?? 0,
    adSlots: response?.adSlots?.length ?? 0,
    playerAds: response?.playerAds?.length ?? 0,
    adShowing: player?.classList.contains('ad-showing') ?? false,
    time: video?.currentTime ?? 0,
    duration: video?.duration ?? 0,
  };
})()`

test('personal browser blocks ads on direct loads and watch-to-watch navigation', async () => {
  const launched = await launchApp()
  const { app, page } = launched
  try {
    await page.getByLabel('ND-DSH navigation').getByRole('button', { name: 'Personal' }).click()
    await page.getByRole('tablist', { name: 'Personal panes' }).getByRole('button', { name: 'Browser' }).click()
    await expect(page.getByRole('region', { name: 'Personal browser' })).toBeVisible()
    // Startup may still be loading the initial tab. Keep that navigation from
    // aborting the probe by using a new, visible tab in the same ND profile.
    await page.evaluate((url) => (window as any).ndDsh.browserPlatform.createTab('builtin', url), VIDEO)
    await expect.poll(async () => {
      const pages = await app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().filter(w => w.getURL().includes('youtube.com')).map(w => {
        const url = new URL(w.getURL())
        return { path: url.pathname, videoId: url.searchParams.get('v') }
      }))
      if (pages.some(page => page.path.startsWith('/sorry/'))) {
        throw new Error('YouTube requires traffic verification; live ad blocking could not be verified.')
      }
      return pages
    }, { timeout: 30_000 }).toContainEqual({ path: '/watch', videoId: VIDEO_ID })
    const tabId = await app.evaluate(({ webContents }, videoId) =>
      webContents.getAllWebContents().find(w => {
        try { const url = new URL(w.getURL()); return url.hostname === 'www.youtube.com' && url.pathname === '/watch' && url.searchParams.get('v') === videoId }
        catch { return false }
      })?.id, VIDEO_ID)
    expect(tabId).toBeDefined()

    const state = () => app.evaluate(({ webContents }, input) =>
      webContents.fromId(input.id)!.executeJavaScript(input.script), { id: tabId!, script: PLAYER_STATE })

    await expect.poll(async () => (await state()).videoId, { timeout: 30_000 }).toBe(VIDEO_ID)
    expect(await state()).toMatchObject({ installed: true, adPlacements: 0, adSlots: 0, playerAds: 0, adShowing: false })
    await app.evaluate(({ webContents }, id) => webContents.fromId(id)!
      .executeJavaScript(`document.querySelector('video.html5-main-video').play()`, true), tabId!)
    await expect.poll(async () => (await state()).time, { timeout: 20_000 }).toBeGreaterThan(0)
    const duration = (await state()).duration
    for (const fraction of [0.25, 0.6]) {
      const seekTime = Math.floor(duration * fraction)
      await app.evaluate(({ webContents }, input) => webContents.fromId(input.id)!
        .executeJavaScript(`document.querySelector('video.html5-main-video').currentTime = ${input.time}`, true),
      { id: tabId!, time: seekTime })
      await expect.poll(async () => (await state()).time, { timeout: 20_000 }).toBeGreaterThan(seekTime + 1)
      expect(await state()).toMatchObject({ videoId: VIDEO_ID, adPlacements: 0, adSlots: 0, playerAds: 0, adShowing: false })
      console.log('YouTube mid-video probe', JSON.stringify(await state()))
    }
    await expect.poll(() => app.evaluate(({ webContents }, input) => webContents.fromId(input.id)!
      .executeJavaScript(`Boolean([...document.querySelectorAll('a[href^="/watch?v="]')]
        .find(a => a.getBoundingClientRect().height > 0 && new URL(a.href).searchParams.get('v') !== ${JSON.stringify(input.videoId)}))`, true), { id: tabId!, videoId: VIDEO_ID }),
    { timeout: 30_000 }).toBe(true)

    // Click an actual recommendation so YouTube stays in the same document
    // and uses get_watch. A loadURL/reload would miss the original regression.
    const navigation = await app.evaluate(async ({ webContents }, input) => {
      const contents = webContents.fromId(input.id)!
      const paths: string[] = []
      contents.debugger.attach('1.3')
      contents.debugger.on('message', (_event, method, params) => {
        if (method === 'Network.requestWillBeSent') {
          const url = new URL(params.request.url)
          if (url.pathname.startsWith('/youtubei/')) paths.push(url.pathname)
        }
      })
      try {
        await contents.debugger.sendCommand('Network.enable')
        const url = await contents.executeJavaScript(`(() => {
          const next = [...document.querySelectorAll('a[href^="/watch?v="]')]
            .find(a => a.getBoundingClientRect().height > 0 && new URL(a.href).searchParams.get('v') !== ${JSON.stringify(input.videoId)});
          if (!next) throw new Error('No visible recommendation');
          next.click();
          return next.href;
        })()`, true)
        await new Promise(resolve => setTimeout(resolve, 15_000))
        return { url, paths }
      } finally {
        contents.debugger.detach()
      }
    }, { id: tabId!, videoId: VIDEO_ID })
    expect(navigation.paths).toContain('/youtubei/v1/get_watch')
    await expect.poll(async () => (await state()).videoId, { timeout: 20_000 })
      .toBe(new URL(navigation.url).searchParams.get('v'))
    const next = await state()
    expect(next).toMatchObject({ installed: true, adPlacements: 0, adSlots: 0, playerAds: 0, adShowing: false })
    expect(next.time).toBeGreaterThan(0)
    console.log('YouTube ad block live probe', JSON.stringify({ url: navigation.url, paths: navigation.paths, player: next }))
  } finally {
    await closeApp(launched)
  }
})
