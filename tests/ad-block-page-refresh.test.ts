import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { runInNewContext } from 'node:vm'
import { isYouTubePage, refreshAdBlockPage } from '../src/main/browser/ad-block-page-refresh.js'

function contents(url = 'https://www.youtube.com/watch?v=video') {
  const executeJavaScript = vi.fn().mockResolvedValueOnce({ time: 123, paused: true, muted: false, rate: 1.5, volume: 0.4 }).mockResolvedValue(undefined)
  const loadURL = vi.fn().mockResolvedValue(undefined)
  const getURL = vi.fn(() => url)
  const isDestroyed = vi.fn(() => false)
  return { executeJavaScript, loadURL, getURL, isDestroyed }
}

describe('ad block page refresh', () => {
  it.each(['https://www.youtube.com/watch?v=a', 'https://m.youtube.com/', 'https://www.youtube-nocookie.com/embed/a'])('recognizes %s', url => {
    expect(isYouTubePage(url)).toBe(true)
  })
  it.each(['https://youtube.com.example.org/', 'https://example.org/?youtube.com', 'file:///youtube.com', 'invalid'])('rejects %s', url => {
    expect(isYouTubePage(url)).toBe(false)
  })
  it('reloads YouTube and restores content position and playback preferences', async () => {
    const tab = contents()
    const video = { readyState: 1, duration: 200, currentTime: 0, muted: true, playbackRate: 1, volume: 1, pause: vi.fn(), play: vi.fn().mockResolvedValue(undefined) }
    const player = { classList: { contains: () => false }, querySelector: () => video }
    tab.executeJavaScript.mockReset()
      .mockResolvedValueOnce({ time: 123, paused: true, muted: false, rate: 1.5, volume: 0.4 })
      .mockImplementationOnce(script => runInNewContext(script, { document: { querySelector: () => player }, location: { href: tab.getURL() } }))
    await refreshAdBlockPage(tab as unknown as WebContents)
    expect(tab.loadURL).toHaveBeenCalledWith('https://www.youtube.com/watch?v=video')
    expect(tab.executeJavaScript).toHaveBeenCalledTimes(2)
    expect(video).toMatchObject({ currentTime: 123, muted: false, playbackRate: 1.5, volume: 0.4 })
    expect(video.pause).toHaveBeenCalledTimes(1)
    expect(video.play).not.toHaveBeenCalled()
  })
  it('does not disturb unrelated pages or destroyed tabs', async () => {
    const tab = contents('https://example.org/')
    await refreshAdBlockPage(tab as unknown as WebContents)
    expect(tab.loadURL).not.toHaveBeenCalled()
    tab.getURL.mockReturnValue('https://www.youtube.com/')
    tab.isDestroyed.mockReturnValue(true)
    await refreshAdBlockPage(tab as unknown as WebContents)
    expect(tab.executeJavaScript).not.toHaveBeenCalled()
  })
  it('does not overwrite a navigation that occurs while saving playback', async () => {
    const tab = contents()
    tab.executeJavaScript.mockReset().mockImplementationOnce(async () => {
      tab.getURL.mockReturnValue('https://example.org/')
      return { time: 123 }
    })
    await refreshAdBlockPage(tab as unknown as WebContents)
    expect(tab.loadURL).not.toHaveBeenCalled()
  })
  it('reloads an ad without restoring its position into the content video', async () => {
    const tab = contents()
    tab.executeJavaScript.mockReset().mockResolvedValue(null)
    await refreshAdBlockPage(tab as unknown as WebContents)
    expect(tab.loadURL).toHaveBeenCalledTimes(1)
    expect(tab.executeJavaScript).toHaveBeenCalledTimes(1)
  })
})
