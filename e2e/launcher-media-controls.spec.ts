/// <reference lib="dom" />

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './fixtures.js'

type RendererWindow = {
  ndDsh: {
    browser: { navigate(url: string): Promise<unknown> }
    window?: { toggleLauncherPopup?(): Promise<{ visible: boolean }> }
    media?: { state(): Promise<{ playing: boolean; title: string } | null> }
  }
}

const TRACK_TITLE = 'ND Media E2E Track'
const TRACK_ARTIST = 'ND Test Artist'

test.describe.configure({ mode: 'serial' })

let launched: LaunchedApp
let server: Server
let mediaUrl = ''
let origin = ''
const rendererErrors: string[] = []

/** 0.5s of silence: enough to play, loop, and pause; too small to hear. */
function silentWav(): Buffer {
  const sampleRate = 8000
  const samples = sampleRate / 2
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  return buffer
}

const PAGE_HTML = `<!doctype html><html><head><title>ND Media E2E</title></head><body>
<audio id="player" loop src="/tone.wav"></audio>
<button id="gesture" type="button">play</button>
<script>
  const player = document.getElementById('player');
  if ('mediaSession' in navigator && window.MediaMetadata) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ${JSON.stringify(TRACK_TITLE)},
      artist: ${JSON.stringify(TRACK_ARTIST)},
    });
  }
  // Muted autoplay is always allowed; unmute once playback actually started so
  // the session is audible like real media without needing a user gesture.
  player.play().catch(() => {
    player.muted = true;
    player.play().then(() => setTimeout(() => { player.muted = false; }, 400)).catch(() => {});
  });
  document.getElementById('gesture').addEventListener('click', () => { void player.play(); });
</script>
</body></html>`

async function playerPaused(): Promise<boolean | null> {
  return launched.app.evaluate(async ({ webContents }, target) => {
    const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().startsWith(target))
    if (!contents) return null
    const value = await contents.executeJavaScript(
      '(() => { const p = document.getElementById("player"); return p ? p.paused : null })()',
    ) as boolean | null
    return value
  }, mediaUrl)
}

test.beforeAll(async () => {
  const wav = silentWav()
  server = createServer((request, response) => {
    if (request.url === '/tone.wav') {
      response.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' })
      response.end(wav)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(PAGE_HTML)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  origin = `http://127.0.0.1:${address.port}`
  mediaUrl = `${origin}/media`
})

test.afterAll(async () => {
  await closeApp(launched)
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('the quick launcher popup shows an OS-style transport row for browser media', async () => {
  launched = await launchApp()
  const { page } = launched
  page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`)
  })

  await page.evaluate((url) => (window as unknown as RendererWindow).ndDsh.browser.navigate(url), mediaUrl)
  await expect.poll(async () => await playerPaused(), { timeout: 20_000 }).toBe(false)

  // Main-process state sees the session before any surface renders it.
  await expect.poll(async () => {
    const state = await page.evaluate(() => (window as unknown as RendererWindow).ndDsh.media?.state() ?? null)
    return state?.playing === true ? state.title : null
  }, { timeout: 15_000 }).toBe(TRACK_TITLE)

  const popupPromise = launched.app.waitForEvent('window')
  await page.evaluate(() => (window as unknown as RendererWindow).ndDsh.window?.toggleLauncherPopup?.())
  const popup = await popupPromise
  await expect.poll(() => popup.url()).toContain('#/launcher')

  const dialog = popup.getByRole('dialog', { name: 'ND Quick Launcher' })
  await expect(dialog).toBeVisible()
  const pauseButton = dialog.getByRole('button', { name: 'Pause' })
  await expect(pauseButton).toBeVisible({ timeout: 15_000 })
  await expect(dialog.getByText(TRACK_TITLE)).toBeVisible()
  await expect(dialog.getByText(new RegExp(TRACK_ARTIST))).toBeVisible()

  await pauseButton.click()
  const playButton = dialog.getByRole('button', { name: 'Play' })
  await expect(playButton).toBeVisible({ timeout: 10_000 })
  await expect.poll(async () => await playerPaused(), { timeout: 10_000 }).toBe(true)

  await playButton.click()
  await expect(dialog.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 10_000 })
  await expect.poll(async () => await playerPaused(), { timeout: 10_000 }).toBe(false)

  await popup.screenshot({ path: 'test-results/launcher-media-row.png' })

  expect(rendererErrors).toEqual([])
})
