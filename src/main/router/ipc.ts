import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { NINE_ROUTER_IPC } from '../../shared/nine-router.js'
import { ROUTER_IPC, type RouterPlaygroundInput } from '../../shared/router.js'
import type { NineRouterManagedRuntime } from './nine-router-managed.js'
import { NineRouterDashboard } from './nine-router-dashboard.js'
import { connectNineRouter, discoverNineRouterModels } from './nine-router-connector.js'
import type { RouterService } from './router-service.js'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>

export function registerRouterIpc(window: BrowserWindow, service: RouterService, managed?: NineRouterManagedRuntime): () => void {
  const dashboard = new NineRouterDashboard(window)
  const channels: string[] = []
  const handle = (channel: string, listener: Handler): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        throw new Error('Rejected ND Router IPC from untrusted renderer')
      }
      return listener(event, ...args)
    })
    channels.push(channel)
  }

  handle(ROUTER_IPC.state, () => service.state())
  handle(ROUTER_IPC.saveProvider, (_event, input) => service.saveProvider(input as never))
  handle(ROUTER_IPC.deleteProvider, (_event, providerId) => service.deleteProvider(id(providerId, 'Provider id')))
  handle(ROUTER_IPC.saveAccount, (_event, input) => service.saveAccount(input as never))
  handle(ROUTER_IPC.deleteAccount, (_event, providerId, accountId) => (
    service.deleteAccount(id(providerId, 'Provider id'), id(accountId, 'Account id'))
  ))
  handle(ROUTER_IPC.saveCombo, (_event, input) => service.saveCombo(input as never))
  handle(ROUTER_IPC.deleteCombo, (_event, comboId) => service.deleteCombo(id(comboId, 'Combo id')))
  handle(ROUTER_IPC.testProvider, (_event, providerId) => service.testProvider(id(providerId, 'Provider id')))
  handle(ROUTER_IPC.usage, () => service.usage())
  handle(ROUTER_IPC.resetUsage, () => service.resetUsage())
  handle(ROUTER_IPC.externalKeyState, () => service.externalKeyState())
  handle(ROUTER_IPC.revealExternalKey, () => service.revealExternalKey())
  handle(ROUTER_IPC.rotateExternalKey, () => service.rotateExternalKey())
  handle(ROUTER_IPC.playgroundStart, (_event, input) => {
    service.playgroundStart(input as RouterPlaygroundInput, (event) => {
      if (!window.isDestroyed()) window.webContents.send(ROUTER_IPC.playgroundEvent, event)
    })
  })
  handle(ROUTER_IPC.playgroundStop, (_event, requestId) => {
    service.playgroundStop(id(requestId, 'Request id'))
  })

  handle(NINE_ROUTER_IPC.state, () => managed?.state() ?? Promise.reject(new Error('Managed 9Router unavailable')))
  handle(NINE_ROUTER_IPC.discover, (_event, input) => discoverNineRouterModels(input as never))
  handle(NINE_ROUTER_IPC.connect, (_event, input) => connectNineRouter(service, input as never))
  handle(NINE_ROUTER_IPC.pickInstall, async () => {
    if (!managed) throw new Error('Managed 9Router unavailable')
    const result = await dialog.showOpenDialog(window, { title: 'Choose an ND-signed 9Router release folder', properties: ['openDirectory'] })
    return !result.canceled && result.filePaths[0]
      ? managed.installFromDirectory(result.filePaths[0])
      : managed.state()
  })
  handle(NINE_ROUTER_IPC.prepare, (_event, password) => managed?.prepare(typeof password === 'string' ? password : '') ?? Promise.reject(new Error('Managed runtime unavailable')))
  handle(NINE_ROUTER_IPC.start, () => managed?.start() ?? Promise.reject(new Error('Managed runtime unavailable')))
  handle(NINE_ROUTER_IPC.stop, () => managed?.stop() ?? Promise.reject(new Error('Managed runtime unavailable')))
  handle(NINE_ROUTER_IPC.dashboardOpen, (_event, url) => {
    if (typeof url !== 'string') throw new Error('Invalid 9Router URL')
    return dashboard.open(url)
  })
  handle(NINE_ROUTER_IPC.dashboardBounds, (_event, bounds) => dashboard.bounds(bounds as never))
  handle(NINE_ROUTER_IPC.dashboardClose, () => dashboard.close())

  return () => {
    dashboard.close()
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 128) throw new Error(`${label} is invalid`)
  return trimmed
}
