import { BrowserWindow, screen, type Display } from 'electron'
import { IPC } from '../shared/contracts.js'
import type { NdContext } from '../shared/nd-context.js'
import type { LauncherHandoffTarget } from '../shared/quick-launcher.js'

const LAUNCHER_POPUP_WIDTH = 900
const LAUNCHER_POPUP_HEIGHT = 720

export interface LauncherPopupController {
  /** Raycast-style: hidden → show, visible → hide. */
  toggle(): void
  hide(): void
  dispose(): void
  /** Hide the popup, bring the full app window forward, and forward the picked action. */
  handoff(target: LauncherHandoffTarget, text?: string, context?: NdContext): void
  /** The popup window when it exists; used to admit its renderer to trusted desktop IPC. */
  window(): BrowserWindow | null
}

/**
 * Owns the frameless launcher popup window: a second sandboxed renderer on the
 * same preload and bundle under #/launcher that draws only the quick launcher
 * card. Created lazily on first toggle so a user who never touches the global
 * shortcut pays nothing for it.
 */
export function createLauncherPopup(options: {
  preloadPath: string
  getMainWindow: () => BrowserWindow | undefined
}): LauncherPopupController {
  const { preloadPath, getMainWindow } = options
  let popup: BrowserWindow | null = null
  let pendingShow = false
  let owner: BrowserWindow | undefined

  const dispose = (): void => {
    pendingShow = false
    owner?.removeListener('closed', dispose)
    owner = undefined
    const target = popup
    popup = null
    if (target && !target.isDestroyed()) target.destroy()
  }

  const ensureWindow = (): BrowserWindow | null => {
    if (popup && !popup.isDestroyed()) return popup
    const main = getMainWindow()
    if (!main || main.isDestroyed()) return null
    const currentUrl = main.webContents.getURL()
    if (!currentUrl) return null
    popup = new BrowserWindow({
      width: LAUNCHER_POPUP_WIDTH,
      height: LAUNCHER_POPUP_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    const target = popup
    owner = main
    main.once('closed', dispose)
    target.once('ready-to-show', () => {
      if (popup === target && pendingShow && !target.isDestroyed()) {
        pendingShow = false
        showPopup(target)
      }
    })
    popup.setAlwaysOnTop(true, 'floating')
    popup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    void popup.loadURL(`${currentUrl.split('#')[0]}#/launcher`).catch((cause) => {
      if (popup !== target) return
      console.error('ND Quick Launcher could not load:', cause)
      dispose()
    })
    popup.on('closed', () => {
      if (popup === target) {
        popup = null
        pendingShow = false
        owner?.removeListener('closed', dispose)
        owner = undefined
      }
    })
    // Focus leaving the popup (click into another app) dismisses it, like
    // Raycast. Hide instead of destroy so the next toggle reuses the surface.
    popup.on('blur', () => {
      if (popup === target && !target.isDestroyed() && target.isVisible()) hidePopupWindow(target)
    })
    return popup
  }

  const displayForPopup = (): Display => {
    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    } catch {
      return screen.getPrimaryDisplay()
    }
  }

  const showPopup = (target: BrowserWindow): void => {
    const { x, y, width, height } = displayForPopup().workArea
    // The card is inset from the window edges so its CSS shadow has room to
    // paint on the transparent window instead of being clipped at the border.
    const popupWidth = Math.min(LAUNCHER_POPUP_WIDTH, Math.max(360, width - 24))
    const popupHeight = Math.min(LAUNCHER_POPUP_HEIGHT, Math.max(320, height - 24))
    target.setBounds({
      x: Math.round(x + (width - popupWidth) / 2),
      y: Math.round(y + Math.max(0, (height - popupHeight) / 3)),
      width: popupWidth,
      height: popupHeight,
    })
    // The surface keeps the palette mounted and primes it (cleared query,
    // opacity zero) as soon as the previous reveal hides. The window can
    // therefore appear already at its entrance keyframe: this event only
    // starts the animation, so no stale full-size frame is ever painted.
    target.webContents.send(IPC.windowLauncherPopupShowEvent)
    target.show()
    target.focus()
  }

  /**
   * Hiding is synchronous and the surface is told afterwards, while it is
   * invisible. That gives the renderer the whole closed interval to clear its
   * query and re-prime the entrance instead of paying for it on reveal.
   */
  const hidePopupWindow = (target: BrowserWindow): void => {
    if (target.isDestroyed()) return
    target.hide()
    if (!target.webContents.isDestroyed()) target.webContents.send(IPC.windowLauncherPopupHideEvent)
  }

  const toggle = (): void => {
    if (pendingShow || (popup && !popup.isDestroyed() && popup.isVisible())) {
      hide()
      return
    }
    const ensured = ensureWindow()
    if (!ensured) return
    if (ensured.webContents.isLoading()) {
      pendingShow = true
      return
    }
    showPopup(ensured)
  }

  const hide = (): void => {
    pendingShow = false
    if (popup && !popup.isDestroyed()) hidePopupWindow(popup)
  }

  const handoff = (target: LauncherHandoffTarget, text?: string, context?: NdContext): void => {
    hide()
    const main = getMainWindow()
    if (!main || main.isDestroyed()) return
    if (main.isMinimized()) main.restore()
    main.show()
    main.setAlwaysOnTop(true)
    main.focus()
    main.setAlwaysOnTop(false)
    main.webContents.send(IPC.windowLauncherHandoffEvent, target, text, context)
  }

  return {
    toggle,
    hide,
    dispose,
    handoff,
    window: () => (popup && !popup.isDestroyed() ? popup : null),
  }
}
