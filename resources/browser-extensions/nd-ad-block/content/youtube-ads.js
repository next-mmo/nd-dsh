/**
 * ND Ad Block - YouTube ad neutralizer.
 *
 * Declarative network rules alone cannot remove YouTube's in-stream ads: the
 * player is handed ad placements inside its own player response, and the ad
 * media itself is served from the same video CDN as the content, so blocking
 * that host would break playback. Instead this script runs in the page's main
 * world at document_start and removes ad placements from the data YouTube hands
 * the player, before the player ever reads them.
 *
 * Every stage is defensive: a failure must leave playback untouched rather than
 * break the page, so each hook is isolated and silently gives up on error.
 */
(() => {
  'use strict'

  const host = location.hostname
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return
  if (window.__ndAdBlockInstalled) return
  window.__ndAdBlockInstalled = true

  // Fields that carry ad placements the player would otherwise schedule.
  const AD_KEYS = [
    'adPlacements',
    'playerAds',
    'adSlots',
    'adBreakHeartbeatParams',
    'adBreakParams',
    'adParams',
    'importantForAds',
  ]

  // Renderers that are promoted/sponsored rows in feeds and search results.
  const PROMOTED_RENDERERS = [
    'adSlotRenderer',
    'displayAdRenderer',
    'inFeedAdLayoutRenderer',
    'promotedSparklesTextSearchRenderer',
    'promotedSparklesWebRenderer',
    'promotedVideoRenderer',
    'searchPyvRenderer',
    'compactPromotedVideoRenderer',
  ]

  // Responses whose bodies are worth pruning.
  const API_PATHS = [
    // Watch-to-watch SPA navigation now combines player and next data here.
    // Missing this endpoint lets pre-roll/mid-roll placements reach the player
    // even when a direct page load is clean.
    '/youtubei/v1/get_watch',
    '/youtubei/v1/player',
    '/youtubei/v1/next',
    '/youtubei/v1/browse',
    '/youtubei/v1/search',
    '/youtubei/v1/reel/reel_watch_sequence',
    '/youtubei/v1/reel/reel_item_watch',
  ]

  const NODE_BUDGET = 40_000

  // Two different things, counted separately so the popup can never present one
  // as the other: ad placements stripped out of YouTube's data, and the ad
  // breaks the user would actually have had to sit through.
  let pruned = 0
  let adBreaks = 0

  const count = (n) => {
    pruned += n
  }

  /**
   * Removes ad placements and promoted renderers in place. Bounded by a node
   * budget so a pathological response cannot stall the page.
   */
  const prune = (root) => {
    if (!root || typeof root !== 'object') return root
    const queue = []
    const seen = new WeakSet()
    const enqueue = (node) => {
      if (!node || typeof node !== 'object' || seen.has(node) || queue.length >= NODE_BUDGET) return
      seen.add(node)
      queue.push(node)
    }
    enqueue(root)
    // Visit nearby player data before deeply nested recommendations. A large
    // feed must not consume the budget before the sibling player is cleaned.
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const node = queue[cursor]
      if (Array.isArray(node)) {
        let retained = 0
        for (let index = 0; index < node.length; index += 1) {
          const item = node[index]
          if (item && typeof item === 'object' && isPromoted(item)) {
            count(1)
            continue
          }
          node[retained++] = item
          enqueue(item)
        }
        node.length = retained
        continue
      }
      for (const key of AD_KEYS) {
        if (Object.prototype.hasOwnProperty.call(node, key)) {
          const value = node[key]
          const size = Array.isArray(value) ? value.length : 1
          delete node[key]
          if (size > 0) count(size)
        }
      }
      for (const key of Object.keys(node)) enqueue(node[key])
    }
    return root
  }

  const isPromoted = (node) => {
    for (const key of PROMOTED_RENDERERS) {
      if (Object.prototype.hasOwnProperty.call(node, key)) return true
    }
    return false
  }

  const matchesApi = (url) => {
    try {
      const parsed = new URL(url, location.href)
      return /^https?:$/.test(parsed.protocol)
        && /(^|\.)youtube(-nocookie)?\.com$/.test(parsed.hostname)
        && API_PATHS.includes(parsed.pathname)
    } catch {
      return false
    }
  }

  const pruneJsonText = (text) => {
    if (typeof text !== 'string' || text.length < 2) return undefined
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return undefined
    }
    const before = pruned
    try { prune(parsed) } catch { return undefined }
    if (pruned === before) return undefined
    try {
      return JSON.stringify(parsed)
    } catch {
      return undefined
    }
  }

  // 1. Player data YouTube inlines into the page before any request happens.
  for (const globalKey of ['ytInitialPlayerResponse', 'ytInitialData']) {
    let value
    try {
      value = window[globalKey]
      delete window[globalKey]
      Object.defineProperty(window, globalKey, {
        configurable: true,
        get() {
          return value
        },
        set(next) {
          value = next
          try { prune(value) } catch { /* Frozen data must still reach the player. */ }
        },
      })
      try { prune(value) } catch { /* Keep existing data if it cannot be edited. */ }
    } catch {
      // Non-configurable global: the fetch/XHR hooks still cover player data.
    }
  }

  // 2. fetch responses.
  try {
    const nativeFetch = window.fetch
    if (typeof nativeFetch === 'function') {
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : input && (input.url || input.href)
        const result = nativeFetch.call(this, input, init)
        if (!matchesApi(url)) return result
        return result.then((response) => {
          try {
            const clone = response.clone()
            return clone.text().then((text) => {
              const pruned = pruneJsonText(text)
              if (pruned === undefined) return response
              const headers = new Headers(response.headers)
              headers.delete('content-length')
              headers.delete('content-encoding')
              const cleaned = new Response(pruned, {
                status: response.status,
                statusText: response.statusText,
                headers,
              })
              // Reconstructed bodies otherwise lose these fetch semantics.
              const withMetadata = (body) => {
                for (const name of ['url', 'redirected', 'type']) {
                  Object.defineProperty(body, name, { value: response[name] })
                }
                const nativeClone = body.clone.bind(body)
                body.clone = () => withMetadata(nativeClone())
                return body
              }
              return withMetadata(cleaned)
            }).catch(() => response)
          } catch {
            return response
          }
        })
      }
    }
  } catch {
    // Leave fetch alone.
  }

  // 3. XHR responses, which is how the web player requests the player payload.
  try {
    const proto = XMLHttpRequest.prototype
    const nativeOpen = proto.open
    const states = new WeakMap()
    proto.open = function (method, url, ...rest) {
      const result = nativeOpen.call(this, method, url, ...rest)
      states.set(this, { url, cache: new Map() })
      return result
    }

    // Pruning happens on read, not on a readyState event. Pages normally set
    // `xhr.onreadystatechange` before calling send(), so a flag flipped by a
    // listener added inside send() would still be unset when the page reads the
    // payload, and the raw ad placements would reach the player.
    const clean = (xhr, raw) => {
      if (raw === null || raw === undefined || raw === '') return raw
      if (!matchesApi(states.get(xhr)?.url)) return raw
      if (typeof raw === 'string') {
        const pruned = pruneJsonText(raw)
        return pruned === undefined ? raw : pruned
      }
      if (typeof raw === 'object') {
        prune(raw)
        return raw
      }
      return raw
    }

    const wrap = (name) => {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name)
      if (!descriptor || typeof descriptor.get !== 'function') return
      Object.defineProperty(proto, name, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          const value = descriptor.get.call(this)
          try {
            // Repeated reads of the same payload reuse the first result.
            const state = states.get(this)
            const cached = state?.cache.get(name)
            if (cached && cached.raw === value) return cached.cleaned
            const cleaned = clean(this, value)
            state?.cache.set(name, { raw: value, cleaned })
            return cleaned
          } catch {
            return value
          }
        },
      })
    }
    wrap('responseText')
    wrap('response')
  } catch {
    // Leave XHR alone.
  }

  // 4. Last resort: if an ad still starts playing, end it. Covers the cases
  //    where YouTube bundles the ad into the media stream itself.
  const SKIP_SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button__text',
    '.ytp-ad-skip-button-container button',
    'button[id^="skip-button:"]',
  ]

  // The player's own playback state, so an ad can be rushed and silenced
  // without permanently changing how the user's video plays.
  let savedMuted
  let savedRate
  let savedVideo
  // Per ad break: what we already counted and which button we already pressed,
  // so repeated ticks cannot inflate the popup's total.
  let adBreakCounted = false
  let clickedSkip

  const currentVideo = () =>
    player()?.querySelector('video.html5-main-video, video')

  const player = () => document.querySelector('#movie_player, .html5-video-player')

  const adShowing = () => {
    const element = player()
    return Boolean(element && element.classList && element.classList.contains('ad-showing'))
  }

  const dismissAd = () => {
    try {
      if (!adShowing()) return
      // One count per ad break, whatever it took to end it, so the popup never
      // reports more ads than the user actually sat through.
      if (!adBreakCounted) {
        adBreakCounted = true
        adBreaks += 1
      }
      const video = currentVideo()
      if (video) {
        if (savedVideo && savedVideo !== video) {
          restorePlayback()
          adBreakCounted = true
        }
        if (savedMuted === undefined) {
          savedVideo = video
          savedMuted = video.muted
          savedRate = video.playbackRate
        }
        // An ad the user did not ask for should not be audible.
        video.muted = true
        // Seeking alone is not always honoured for an ad creative, but the
        // playback rate is, so the ad reaches its end quickly either way.
        try {
          video.playbackRate = 16
        } catch {
          // Ignore.
        }
        try {
          if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.5) {
            video.currentTime = video.duration
          }
        } catch {
          // Ignore.
        }
        if (video.paused) video.play().catch(() => undefined)
      }
      for (const selector of SKIP_SELECTORS) {
        const button = player()?.querySelector(selector)
        if (button && button.getClientRects().length > 0 && button !== clickedSkip && typeof button.click === 'function') {
          clickedSkip = button
          button.click()
          break
        }
      }
      const overlay = document.querySelector('.ytp-ad-overlay-close-button')
      if (overlay) overlay.click()
    } catch {
      // Ignore: playback must not be disturbed by a failed skip attempt.
    }
  }

  // Restores whatever the user had before the ad took over the player.
  const restorePlayback = () => {
    adBreakCounted = false
    clickedSkip = undefined
    if (savedMuted === undefined) return
    const video = savedVideo
    try {
      if (video) {
        video.muted = savedMuted
        video.playbackRate = savedRate && savedRate > 0 ? savedRate : 1
      }
    } catch {
      // Ignore.
    }
    savedMuted = undefined
    savedRate = undefined
    savedVideo = undefined
  }

  const tick = () => {
    if (adShowing()) dismissAd()
    else restorePlayback()
  }

  // Watching the player's class attribute dismisses an ad the moment it starts
  // rather than up to a poll interval later. The interval below stays as the
  // safety net for the window between page load and the player appearing, and
  // for players that get replaced by a navigation.
  let observed
  let observer
  const attach = () => {
    const element = player()
    if (!element || element === observed) return
    if (observer) observer.disconnect()
    observed = element
    try {
      observer = new MutationObserver(tick)
      observer.observe(element, { attributes: true, attributeFilter: ['class'] })
    } catch {
      // Ignore: the interval still covers this.
    }
    tick()
  }

  let timer
  const startWatching = () => {
    attach()
    if (timer !== undefined) return
    timer = setInterval(() => {
      attach()
      tick()
    }, 500)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startWatching, { once: true })
  }
  startWatching()

  // 5. Report the two real counts to the extension's isolated content script,
  //    which stores them for the toolbar popup. Nothing here is estimated: an
  //    ad break is counted only once it actually started and was ended.
  let reportedBreaks = -1
  let reportedPruned = -1
  setInterval(() => {
    if (adBreaks === reportedBreaks && pruned === reportedPruned) return
    reportedBreaks = adBreaks
    reportedPruned = pruned
    try {
      window.postMessage({ __ndAdBlock: 'report', adBreaks, pruned, url: location.href }, location.origin)
    } catch {
      // Ignore.
    }
  }, 2_000)
})()
