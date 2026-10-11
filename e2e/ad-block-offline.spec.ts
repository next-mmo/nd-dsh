/// <reference lib="dom" />
import { expect, test } from '@playwright/test'
import { closeApp, launchApp } from './fixtures.js'

const FIXTURE_URL = 'https://www.youtube.com/watch?v=nd-offline-fixture'
const PAYLOAD = { playerResponse: { videoDetails: { videoId: 'nd-offline-fixture' }, adPlacements: [{}], playerAds: [{}], adSlots: [{}] } }
const HTML = `<!doctype html><html><body>
  <div id="movie_player" class="html5-video-player"></div>
  <script>window.ytInitialPlayerResponse = ${JSON.stringify(PAYLOAD.playerResponse)};</script>
</body></html>`

test('ND filters page and navigation data and refreshes hooks on toggle and reload without live YouTube', async () => {
  const previous = process.env.ND_DSH_BROWSER_URL
  process.env.ND_DSH_BROWSER_URL = 'about:blank'
  const launched = await launchApp()
  const { app, page } = launched
  try {
    await page.getByLabel('ND-DSH navigation').getByRole('button', { name: 'Personal' }).click()
    await page.getByRole('tablist', { name: 'Personal panes' }).getByRole('button', { name: 'Browser' }).click()
    await expect(page.getByRole('region', { name: 'Personal browser' })).toBeVisible()
    const extension = await page.evaluate(async () => (await (window as any).ndDsh.browserPlatform.state()).extensions.find((r: any) => r.catalogId === 'nd-ad-block'))
    expect(extension.enabled).toBe(true)
    // Only the real ND WebContentsView is used. CDP fulfils test responses before
    // they reach the network, so neither credentials nor YouTube ad inventory
    // are required for these lifecycle assertions.
    const id = await app.evaluate(async ({ webContents, session }, input) => {
      const browserSession = session.fromPartition('persist:nd-dsh-browser')
      const tab = webContents.getAllWebContents().find(w => w.session === browserSession && w.getURL() === 'about:blank')!
      tab.debugger.attach('1.3')
      tab.debugger.on('message', (_event, method, params) => {
        if (method !== 'Fetch.requestPaused') return
        const url = new URL(params.request.url)
        const body = url.pathname === '/watch' ? input.html : url.pathname.startsWith('/youtubei/') ? input.payload : ''
        void tab.debugger.sendCommand('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: url.pathname === '/watch' ? 'text/html' : 'application/json' }],
          body: Buffer.from(body).toString('base64'),
        })
      })
      await tab.debugger.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
      await tab.loadURL(input.url)
      return tab.id
    }, { url: FIXTURE_URL, html: HTML, payload: JSON.stringify(PAYLOAD) })
    const snapshot = () => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript(`(async () => ({
      installed: window.__ndAdBlockInstalled === true,
      inlineAds: window.ytInitialPlayerResponse?.adPlacements?.length ?? 0,
      videoId: window.ytInitialPlayerResponse?.videoDetails?.videoId,
      fetchAds: (await (await fetch('/youtubei/v1/get_watch')).json()).playerResponse.adSlots?.length ?? 0,
    }))()`), id)
    await expect.poll(snapshot).toEqual({ installed: true, inlineAds: 0, videoId: 'nd-offline-fixture', fetchAds: 0 })
    await page.evaluate((id) => (window as any).ndDsh.browserPlatform.setExtensionEnabled(id, false), extension.id)
    await expect.poll(snapshot).toEqual({ installed: false, inlineAds: 1, videoId: 'nd-offline-fixture', fetchAds: 1 })
    await page.evaluate((id) => (window as any).ndDsh.browserPlatform.setExtensionEnabled(id, true), extension.id)
    await expect.poll(snapshot).toEqual({ installed: true, inlineAds: 0, videoId: 'nd-offline-fixture', fetchAds: 0 })
    await page.evaluate(() => (window as any).ndDsh.browserPlatform.reloadExtensions())
    await expect.poll(snapshot).toEqual({ installed: true, inlineAds: 0, videoId: 'nd-offline-fixture', fetchAds: 0 })
    await page.evaluate((id) => (window as any).ndDsh.browserPlatform.removeExtension(id), extension.id)
    await expect.poll(snapshot).toEqual({ installed: false, inlineAds: 1, videoId: 'nd-offline-fixture', fetchAds: 1 })
    await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.debugger.detach(), id)
  } finally {
    if (previous === undefined) delete process.env.ND_DSH_BROWSER_URL
    else process.env.ND_DSH_BROWSER_URL = previous
    await closeApp(launched)
  }
})
