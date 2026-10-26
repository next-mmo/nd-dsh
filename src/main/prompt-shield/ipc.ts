import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { PROMPT_SHIELD_IPC } from '../../shared/prompt-shield.js'
import { PromptShieldService } from './prompt-shield-service.js'
import { setPromptShieldRuntime } from './prompt-shield-runtime.js'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>

export function registerPromptShieldIpc(window: BrowserWindow): () => void {
  const service = new PromptShieldService(join(app.getPath('userData'), 'prompt-shield', 'state.json'))
  setPromptShieldRuntime(service)
  const channels: string[] = []
  const handle = (channel: string, listener: Handler): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        throw new Error('Rejected Prompt Shield IPC from untrusted renderer')
      }
      return listener(event, ...args)
    })
    channels.push(channel)
  }

  service.setOnChanged((state) => {
    if (!window.isDestroyed()) window.webContents.send(PROMPT_SHIELD_IPC.changedEvent, state)
  })
  handle(PROMPT_SHIELD_IPC.state, () => service.state())
  handle(PROMPT_SHIELD_IPC.updateSettings, (_event, settings) => service.updateSettings(settings))
  handle(PROMPT_SHIELD_IPC.testText, (_event, text) => service.test(readText(text)))
  handle(PROMPT_SHIELD_IPC.resetCounters, () => service.resetCounters())

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
    service.setOnChanged(undefined)
    setPromptShieldRuntime(undefined)
  }
}

function readText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Prompt Shield test text must be a string')
  if (value.length > 100_000) throw new Error('Prompt Shield test text exceeds the 100,000 character limit')
  return value
}
