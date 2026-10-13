import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { BrowserMediaTracker } from '../src/main/browser/media-session-tracker.js'

class MediaContents extends EventEmitter {
  snapshot = { title: 'Track one', artist: 'Artist', playing: true }
  destroyed = false
  executeJavaScript = vi.fn(async (_script: string, _gesture?: boolean): Promise<unknown> => ({ ...this.snapshot }))
  isDestroyed() { return this.destroyed }
  getURL() { return 'https://music.youtube.com/watch?v=track' }
  getTitle() { return 'YouTube Music' }
  close() { this.destroyed = true; this.emit('destroyed') }
}

function setup() {
  const onState = vi.fn()
  const tracker = new BrowserMediaTracker(onState)
  const contents = new MediaContents()
  tracker.attach('music', contents as unknown as WebContents)
  return { tracker, contents, onState }
}

describe('browser media state reconciliation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps playing metadata across SPA and subframe navigations', async () => {
    const { tracker, contents } = setup()
    contents.emit('media-started-playing')
    await tracker.refresh()
    for (const details of [
      { isMainFrame: true, isSameDocument: true },
      { isMainFrame: false, isSameDocument: false },
    ]) {
      contents.emit('did-start-navigation', details)
      expect(tracker.state()).toMatchObject({ playing: true, title: 'Track one', artist: 'Artist' })
    }
    contents.close()
  })

  it('reconciles auxiliary pause events with the page that is still playing', async () => {
    const { tracker, contents } = setup()
    contents.emit('media-started-playing')
    await tracker.refresh()
    contents.emit('media-paused')
    await tracker.refresh()
    expect(tracker.state()?.playing).toBe(true)
    contents.snapshot.playing = false
    contents.emit('media-paused')
    await tracker.refresh()
    expect(tracker.state()?.playing).toBe(false)
    contents.close()
  })

  it('follows late track metadata and playback changes without native events', async () => {
    const { tracker, contents, onState } = setup()
    expect(tracker.state()).toBeNull()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(contents.executeJavaScript).not.toHaveBeenCalled()
    contents.emit('media-started-playing')
    await tracker.refresh()
    contents.snapshot = { title: 'Track two', artist: 'Next artist', playing: true }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(tracker.state()).toMatchObject({ title: 'Track two', artist: 'Next artist', playing: true })
    contents.snapshot.playing = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(tracker.state()?.playing).toBe(false)
    contents.snapshot.playing = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(tracker.state()?.playing).toBe(true)
    const emissions = onState.mock.calls.length
    await vi.advanceTimersByTimeAsync(2_000)
    expect(onState).toHaveBeenCalledTimes(emissions)
    contents.close()
  })

  it('clears a replaced document and ignores its delayed snapshot', async () => {
    const { tracker, contents } = setup()
    let resolve!: (value: unknown) => void
    contents.executeJavaScript.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    contents.emit('media-started-playing')
    const pending = tracker.refresh()
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(tracker.state()).toBeNull()
    resolve({ title: 'Stale track', playing: true })
    await pending
    await vi.advanceTimersByTimeAsync(3_000)
    expect(tracker.state()).toBeNull()
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(1)
    contents.emit('media-started-playing')
    await tracker.refresh()
    expect(tracker.state()?.title).toBe('Track one')
    contents.close()
  })

  it('does not overlap reads and stops polling destroyed tabs', async () => {
    const { tracker, contents } = setup()
    let resolve!: (value: unknown) => void
    contents.executeJavaScript.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    contents.emit('media-started-playing')
    const pending = tracker.refresh()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(1)
    contents.close()
    resolve({ title: 'Stale track', playing: true })
    await pending
    await vi.advanceTimersByTimeAsync(5_000)
    expect(tracker.state()).toBeNull()
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(1)
  })

  it('rechecks an in-flight snapshot overtaken by a playback event', async () => {
    const { tracker, contents } = setup()
    let resolve!: (value: unknown) => void
    contents.executeJavaScript.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    contents.emit('media-started-playing')
    contents.snapshot.playing = false
    contents.emit('media-paused')
    const pending = tracker.refresh()
    resolve({ title: 'Old playing snapshot', playing: true })
    await pending
    expect(tracker.state()).toMatchObject({ title: 'Track one', playing: false })
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(2)
    contents.close()
  })

  it('recovers from an unavailable page without unhandled rejections', async () => {
    const { tracker, contents } = setup()
    contents.executeJavaScript.mockRejectedValueOnce(new Error('navigation destroyed execution context'))
    contents.emit('media-started-playing')
    await tracker.refresh()
    expect(tracker.state()?.playing).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(tracker.state()?.title).toBe('Track one')
    contents.close()
  })

  it('checks all media elements so a paused auxiliary element does not hide playback', async () => {
    const { tracker, contents } = setup()
    const elements = [{ paused: true, ended: false }, { paused: false, ended: false }]
    contents.executeJavaScript.mockImplementation(async (script) => runInNewContext(script, {
      navigator: { mediaSession: { metadata: { title: 'Actual song', artist: 'Singer' } } },
      document: { querySelectorAll: () => elements, title: 'YouTube Music' },
    }))
    contents.emit('media-started-playing')
    await tracker.refresh()
    expect(tracker.state()).toMatchObject({ playing: true, title: 'Actual song', artist: 'Singer' })
    elements[1]!.paused = true
    await tracker.refresh()
    expect(tracker.state()?.playing).toBe(false)
    contents.close()
  })
})
