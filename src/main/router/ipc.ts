import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { ROUTER_IPC } from '../../shared/router.js'
import type { RouterService } from './router-service.js'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>

export function registerRouterIpc(window: BrowserWindow, service: RouterService): () => void {
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

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 128) throw new Error(`${label} is invalid`)
  return trimmed
}
