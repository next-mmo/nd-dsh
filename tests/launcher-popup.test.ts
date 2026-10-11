import { beforeEach, describe, expect, it, vi } from 'vitest'

const { windows, loadURL } = vi.hoisted(() => ({ windows: [] as any[], loadURL: vi.fn(async () => undefined) }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    destroyed = false
    visible = false
    loading = true
    loadURL = loadURL
    setAlwaysOnTop = vi.fn()
    setVisibleOnAllWorkspaces = vi.fn()
    setBounds = vi.fn()
    focus = vi.fn()
    webContents = { getURL: () => 'file:///nd/index.html', isLoading: () => this.loading, send: vi.fn() }
    constructor() { super(); windows.push(this) }
    isDestroyed() { return this.destroyed }
    isVisible() { return this.visible }
    isMinimized() { return false }
    show() { this.visible = true }
    hide() { this.visible = false }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  return {
    BrowserWindow: Window,
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
  }
})

import { BrowserWindow } from 'electron'
import { createLauncherPopup } from '../src/main/launcher-popup.js'

describe('launcher popup lifecycle', () => {
  beforeEach(() => { windows.length = 0; loadURL.mockReset(); loadURL.mockResolvedValue(undefined) })

  function setup() {
    const main = new BrowserWindow()
    const controller = createLauncherPopup({ preloadPath: 'preload.cjs', getMainWindow: () => main })
    controller.toggle()
    return { main, controller, popup: windows[1] }
  }

  it('cancels opening when pressed twice before the renderer is ready', () => {
    const { controller, popup } = setup()
    controller.toggle()
    popup.loading = false
    popup.emit('ready-to-show')
    expect(popup.isVisible()).toBe(false)
    controller.toggle()
    expect(popup.isVisible()).toBe(true)
    controller.toggle()
    expect(popup.isVisible()).toBe(false)
  })

  it('honors a third press while loading without accumulating show callbacks', () => {
    const { controller, popup } = setup()
    controller.toggle()
    controller.toggle()
    expect(popup.listenerCount('ready-to-show')).toBe(1)
    popup.loading = false
    popup.emit('ready-to-show')
    expect(popup.isVisible()).toBe(true)
  })

  it('destroys the popup with its owner so no renderer outlives the IPC handlers', () => {
    const { main, controller, popup } = setup()
    main.destroy()
    expect(popup.isDestroyed()).toBe(true)
    expect(controller.window()).toBeNull()
    popup.emit('ready-to-show')
    controller.toggle()
    expect(windows).toHaveLength(2)
    expect(popup.isVisible()).toBe(false)
  })

  it('cancels pending show on dismissal and can dispose repeatedly', () => {
    const { controller, popup } = setup()
    controller.hide()
    popup.emit('ready-to-show')
    expect(popup.isVisible()).toBe(false)
    controller.dispose()
    controller.dispose()
    expect(controller.window()).toBeNull()
  })

  it('handles failed loading and allows a fresh retry', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const main = new BrowserWindow()
    const controller = createLauncherPopup({ preloadPath: 'preload.cjs', getMainWindow: () => main })
    loadURL.mockRejectedValueOnce(new Error('load failed'))
    controller.toggle()
    await Promise.resolve()
    expect(controller.window()).toBeNull()
    controller.toggle()
    expect(controller.window()).not.toBeNull()
    log.mockRestore()
    vi.restoreAllMocks()
  })
})
