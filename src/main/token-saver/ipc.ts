import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { TOKEN_SAVER_IPC, type TokenSaverAccountId } from '../../shared/token-saver.js'
import { registerNdGatewayIpc } from '../gateway/ipc.js'
import { ProviderStore } from '../providers.js'
import { ProviderAccountService } from './provider-account-service.js'
import { RtkManager } from './rtk-manager.js'
import { TokenSaverService } from './token-saver-service.js'
import { setTokenSaverRuntime } from './token-saver-runtime.js'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>

export function registerTokenSaverIpc(window: BrowserWindow, providers?: ProviderStore): () => void {
  const channels: string[] = []
  const root = join(app.getPath('userData'), 'token-saver')
  const accounts = new ProviderAccountService(root)
  const external = new RtkManager(root)
  const service = new TokenSaverService(join(root, 'state.json'), { accounts, external })
  const disposeGatewayIpc = registerNdGatewayIpc(window, () => providers ?? new ProviderStore(), service)
  setTokenSaverRuntime(service)

  const handle = (channel: string, listener: Handler): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        throw new Error('Rejected Token Saver IPC from untrusted renderer')
      }
      return listener(event, ...args)
    })
    channels.push(channel)
  }

  service.setOnChanged((state) => {
    if (!window.isDestroyed()) window.webContents.send(TOKEN_SAVER_IPC.changedEvent, state)
  })

  handle(TOKEN_SAVER_IPC.state, () => service.state())
  handle(TOKEN_SAVER_IPC.updateSettings, (_event, settings) => service.updateSettings(settings))
  handle(TOKEN_SAVER_IPC.resetCounters, () => service.resetCounters())
  handle(TOKEN_SAVER_IPC.detectExternalApps, () => service.detectExternalApps())
  handle(TOKEN_SAVER_IPC.runDemo, () => {
    if (!service.settings().ndEnabled || service.settings().mode === 'off') {
      throw new Error('Enable Save tokens in ND before running the demo')
    }
    const sample = [
      'ND Token Saver demo: synthetic tool output',
      ...Array.from({ length: 320 }, () => 'PASS src/demo-counter.test.ts'),
      ...Array.from({ length: 220 }, () => 'info: dependency already cached'),
      'Summary: 540 noisy lines generated for deterministic local testing.',
    ].join('\n')
    const result = service.optimize(sample, { kind: 'tool-output', maxChars: 8_000 })
    if (!result.changed || !result.recoveryRef) throw new Error('Token Saver demo did not produce a recoverable optimization')
    if (service.recover(result.recoveryRef) !== sample) throw new Error('Token Saver recovery verification failed')
    return result
  })
  handle(TOKEN_SAVER_IPC.connectAccount, (_event, id) => service.connectAccount(accountId(id)))
  handle(TOKEN_SAVER_IPC.disconnectAccount, (_event, id) => service.disconnectAccount(accountId(id)))
  handle(TOKEN_SAVER_IPC.refreshAccounts, () => service.refreshAccounts())

  void service.initialize().catch((error) => {
    console.warn('Token Saver external integration reconciliation failed:', error instanceof Error ? error.message : String(error))
  })

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
    service.setOnChanged(undefined)
    accounts.setOnChanged(undefined)
    disposeGatewayIpc()
    setTokenSaverRuntime(undefined)
  }
}

function accountId(value: unknown): TokenSaverAccountId {
  if (value === 'codex' || value === 'antigravity') return value
  throw new Error('Unsupported provider account')
}
