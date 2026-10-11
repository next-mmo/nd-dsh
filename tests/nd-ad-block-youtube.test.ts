import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve('resources/browser-extensions/nd-ad-block/content/youtube-ads.js'), 'utf8')

// The response shape used by YouTube's watch-to-watch navigation. Ads must be
// removed from nested player data without changing the actual video or feed.
const watchResponse = () => ({
  playerResponse: {
    videoDetails: { videoId: 'kjWPSOq5nlo', title: 'Video' },
    streamingData: { adaptiveFormats: [{ url: 'https://video.googlevideo.com/videoplayback' }] },
    adPlacements: [{ adPlacementRenderer: {} }],
    playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
    adSlots: [{ adSlotRenderer: {} }],
    adBreakHeartbeatParams: 'ad-heartbeat',
  },
  watchNextResponse: {
    contents: [{ adSlotRenderer: {} }, { videoRenderer: { videoId: 'next-video' } }],
  },
})

function harness(payload: unknown, initial: unknown = undefined, metadata: Record<string, unknown> = {}) {
  class Xhr {
    payload = payload
    open(_method: string, _url: string) {}
    get responseText() { return typeof this.payload === 'string' ? this.payload : JSON.stringify(this.payload) }
    get response() { return this.payload }
  }
  const requests: unknown[] = []
  const window = {
    ytInitialPlayerResponse: initial,
    fetch: async (input: unknown) => {
      requests.push(input)
      if (payload instanceof Error) throw payload
      const response = new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json', 'content-length': '9999', 'content-encoding': 'gzip' } })
      for (const [key, value] of Object.entries(metadata)) Object.defineProperty(response, key, { value })
      return response
    },
  }
  runInNewContext(source, {
    window,
    location: { hostname: 'www.youtube.com', href: 'https://www.youtube.com/watch?v=kjWPSOq5nlo', origin: 'https://www.youtube.com' },
    document: { readyState: 'complete', querySelector: () => null },
    XMLHttpRequest: Xhr,
    Response,
    Headers,
    URL,
    setInterval: () => 1,
  })
  return { window, Xhr, requests }
}

function expectCleanWatch(payload: ReturnType<typeof watchResponse>) {
  expect(payload.playerResponse).not.toHaveProperty('adPlacements')
  expect(payload.playerResponse).not.toHaveProperty('playerAds')
  expect(payload.playerResponse).not.toHaveProperty('adSlots')
  expect(payload.playerResponse).not.toHaveProperty('adBreakHeartbeatParams')
  expect(payload.playerResponse.videoDetails.videoId).toBe('kjWPSOq5nlo')
  expect(payload.playerResponse.streamingData.adaptiveFormats[0]?.url).toContain('googlevideo.com')
  expect(payload.watchNextResponse.contents).toEqual([{ videoRenderer: { videoId: 'next-video' } }])
}

describe('YouTube watch navigation ad blocking', () => {
  it.each([
    'https://www.youtube.com/youtubei/v1/get_watch?prettyPrint=false',
    '/youtubei/v1/get_watch?prettyPrint=false',
    new Request('https://www.youtube.com/youtubei/v1/get_watch?prettyPrint=false'),
    new URL('https://www.youtube.com/youtubei/v1/get_watch?prettyPrint=false'),
  ])('cleans combined watch fetch data for %s before the page reads it', async (input) => {
    const { window, requests } = harness(watchResponse())
    const response = await window.fetch(input)
    expectCleanWatch(await response.json())
    expect(requests).toEqual([input])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
  })

  it.each(['responseText', 'response'] as const)('cleans a watch XHR %s on the first read', (property) => {
    const { Xhr } = harness(watchResponse())
    const xhr = new Xhr()
    xhr.open('POST', '/youtubei/v1/get_watch?prettyPrint=false')
    const raw = xhr[property]
    expectCleanWatch(typeof raw === 'string' ? JSON.parse(raw) : raw)
    expect(xhr[property]).toBe(raw)
  })

  it('leaves unrelated requests unchanged', async () => {
    const payload = watchResponse()
    const { window, Xhr } = harness(payload)
    expect(await (await window.fetch('/youtubei/v1/log_event')).json()).toEqual(payload)
    const xhr = new Xhr()
    xhr.open('POST', '/youtubei/v1/log_event')
    expect(xhr.response).toBe(payload)
  })

  it('leaves a malformed watch response available to the page', async () => {
    const { window, Xhr } = harness('not json')
    // A failed/non-JSON endpoint must not turn into a broken fetch promise.
    const response = await window.fetch('/youtubei/v1/get_watch')
    expect(await response.text()).toBe('not json')
    const xhr = new Xhr()
    xhr.open('POST', '/youtubei/v1/get_watch')
    expect(xhr.responseText).toBe('not json')
  })

  it('cleans Shorts player responses', async () => {
    const { window } = harness(watchResponse())
    expectCleanWatch(await (await window.fetch('/youtubei/v1/reel/reel_item_watch')).json())
  })

  it('leaves unrelated hosts and lookalike paths untouched', async () => {
    const payload = watchResponse()
    const { window } = harness(payload)
    for (const url of ['https://example.com/youtubei/v1/get_watch', '/youtubei/v1/player_other', '/unrelated?next=/youtubei/v1/player']) {
      expect(await (await window.fetch(url)).json()).toEqual(payload)
    }
  })

  it('preserves and cleans inline player data already present at installation', () => {
    const initial = watchResponse().playerResponse
    const { window } = harness(null, initial)
    expect(window.ytInitialPlayerResponse).toBe(initial)
    expect(window.ytInitialPlayerResponse).not.toHaveProperty('adPlacements')
    expect(window.ytInitialPlayerResponse).toHaveProperty('videoDetails.videoId', 'kjWPSOq5nlo')
  })

  it('does not throw away frozen inline data or throw from the page assignment', () => {
    const initial = Object.freeze(watchResponse().playerResponse)
    const { window } = harness(null, initial)
    expect(window.ytInitialPlayerResponse).toBe(initial)
    expect(() => { window.ytInitialPlayerResponse = initial }).not.toThrow()
  })

  it('cleans player data before a large sibling feed exhausts the budget', async () => {
    const payload = watchResponse()
    const large = { playerResponse: payload.playerResponse, watchNextResponse: { contents: Array.from({ length: 45_000 }, () => ({ nested: { text: 'normal content' } })) } }
    const { window } = harness(large)
    const cleaned = await (await window.fetch('/youtubei/v1/get_watch')).json()
    expect(cleaned.playerResponse).not.toHaveProperty('adPlacements')
    expect(cleaned.playerResponse.videoDetails).toEqual(payload.playerResponse.videoDetails)
    expect(cleaned.watchNextResponse.contents).toHaveLength(45_000)
  })

  it('handles cyclic inline data without spending the budget on a cycle', () => {
    const initial = { self: null as unknown, playerResponse: watchResponse().playerResponse }
    initial.self = initial
    const { window } = harness(null, initial)
    expect(window.ytInitialPlayerResponse).toBe(initial)
    expect(initial.playerResponse).not.toHaveProperty('adPlacements')
  })

  it('forgets cached cleaning when an XHR is reopened for an unrelated request', () => {
    const { Xhr } = harness(watchResponse())
    const xhr = new Xhr()
    xhr.open('POST', '/youtubei/v1/get_watch')
    expect(JSON.parse(xhr.responseText)).not.toHaveProperty('playerResponse.adPlacements')
    xhr.open('POST', '/youtubei/v1/log_event')
    expect(JSON.parse(xhr.responseText)).toHaveProperty('playerResponse.adPlacements')
  })

  it('accepts URL objects in XHR and clears the cache for new responses', () => {
    const { Xhr } = harness(watchResponse())
    const xhr = new Xhr()
    xhr.open('POST', new URL('https://www.youtube.com/youtubei/v1/get_watch') as unknown as string)
    expectCleanWatch(JSON.parse(xhr.responseText))
    xhr.payload = { playerResponse: { videoDetails: { videoId: 'second' }, adSlots: [{}] } }
    xhr.open('POST', '/youtubei/v1/player')
    expect(JSON.parse(xhr.responseText)).toEqual({ playerResponse: { videoDetails: { videoId: 'second' } } })
  })

  it('preserves response metadata through repeated clones and drops stale body-size headers', async () => {
    const metadata = { url: 'https://www.youtube.com/youtubei/v1/get_watch', redirected: true, type: 'basic' }
    const { window } = harness(watchResponse(), undefined, metadata)
    const response = await window.fetch(metadata.url)
    for (const copy of [response, response.clone(), response.clone().clone()]) {
      expect(copy.url).toBe(metadata.url)
      expect(copy.redirected).toBe(true)
      expect(copy.type).toBe('basic')
      expect(copy.headers.has('content-length')).toBe(false)
      expect(copy.headers.has('content-encoding')).toBe(false)
      expectCleanWatch(await copy.json())
    }
  })

  it('propagates network failure instead of manufacturing a success', async () => {
    const error = new Error('network failed')
    const { window } = harness(error)
    await expect(window.fetch('/youtubei/v1/get_watch')).rejects.toBe(error)
  })
})

describe('YouTube fallback playback recovery', () => {
  function playerHarness() {
    const video = { muted: false, playbackRate: 1.5, currentTime: 0, duration: 18, paused: false, play: () => Promise.resolve() }
    let activeVideo = video
    let showing = true
    let clicks = 0
    const button = { getClientRects: () => [{}], click: () => { clicks += 1; showing = false } }
    const player = {
      classList: { contains: () => showing },
      querySelector: (selector: string) => selector.includes('video') ? activeVideo : selector === 'button[id^="skip-button:"]' ? button : null,
    }
    let tick = () => {}
    runInNewContext(source, {
      window: {},
      location: { hostname: 'www.youtube.com' },
      document: { readyState: 'complete', querySelector: (selector: string) => selector.includes('movie_player') ? player : null },
      MutationObserver: class { observe() {} disconnect() {} },
      setInterval: (callback: () => void, milliseconds: number) => { if (milliseconds === 500) tick = callback; return milliseconds },
    })
    return { video, tick: () => tick(), clicks: () => clicks, replace: (next: typeof video) => { activeVideo = next }, showAd: () => { showing = true } }
  }

  it('uses the current skip button and restores mute and speed after an ad ends', () => {
    const state = playerHarness()
    expect(state.clicks()).toBe(1)
    expect(state.video).toMatchObject({ muted: true, playbackRate: 16, currentTime: 18 })
    state.tick()
    state.tick()
    expect(state.video).toMatchObject({ muted: false, playbackRate: 1.5 })
    expect(state.clicks()).toBe(1)
  })

  it('restores the original video rather than applying its preferences to a replacement', () => {
    const state = playerHarness()
    const replacement = { ...state.video, muted: true, playbackRate: 1 }
    state.replace(replacement)
    state.tick()
    expect(state.video).toMatchObject({ muted: false, playbackRate: 1.5 })
    expect(replacement).toMatchObject({ muted: true, playbackRate: 1 })
  })
})
