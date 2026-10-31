import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { NINE_ROUTER_IPC } from '../../shared/nine-router.js'
import { ROUTER_IPC, type RouterPlaygroundInput, type RouterState } from '../../shared/router.js'
import type { NineRouterManagedRuntime } from './nine-router-managed.js'
import { NineRouterDashboard } from './nine-router-dashboard.js'
import { connectNineRouter, discoverNineRouterModels } from './nine-router-connector.js'
import { RouterGoogleAccounts } from './google-accounts.js'
import { ProviderAccountService } from '../token-saver/provider-account-service.js'
import type { RouterService } from './router-service.js'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>

export function registerRouterIpc(window: BrowserWindow, service: RouterService, managed?: NineRouterManagedRuntime): () => void {
  const dashboard = new NineRouterDashboard(window)
  const googleRoot = join(app.getPath('userData'), 'nd-router', 'google-oauth')
  const googleAccounts = new RouterGoogleAccounts(googleRoot)
  // Read-only reuse of the Token Saver's signed-in Antigravity account; the
  // exported file carries a refresh token and stays in ND's data directory.
  // Re-read on demand so a sign-in completed after app start is visible.
  const tokenSaverRoot = join(app.getPath('userData'), 'token-saver')
  const tokenSaverAccounts = (): ProviderAccountService => new ProviderAccountService(tokenSaverRoot)
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
  handle(ROUTER_IPC.deleteProvider, async (_event, providerId) => {
    const pid = id(providerId, 'Provider id')
    const state = await service.state()
    const provider = state.providers.find((entry) => entry.id === pid)
    if (provider) {
      const remaining = state.providers.filter((entry) => entry.id !== pid)
      for (const account of provider.accounts) {
        if (!account.envDir) continue
        const shared = remaining.some((entry) => entry.accounts.some((candidate) => candidate.envDir === account.envDir))
        if (!shared) {
          try { googleAccounts.removeManagedFile(account.envDir) } catch { /* best effort */ }
        }
      }
    }
    return service.deleteProvider(pid)
  })
  handle(ROUTER_IPC.saveAccount, (_event, input) => service.saveAccount(input as never))
  handle(ROUTER_IPC.deleteAccount, async (_event, providerId, accountId) => {
    const pid = id(providerId, 'Provider id')
    const aid = id(accountId, 'Account id')
    const state = await service.state()
    const account = state.providers.find((provider) => provider.id === pid)?.accounts.find((entry) => entry.id === aid)
    // Only files under ND's Google OAuth directory are ours to remove, and only
    // when no other provider still references the same credentials file.
    if (account?.envDir) {
      const shared = state.providers.some((provider) => provider.accounts.some((entry) => entry.id !== aid && entry.envDir === account.envDir))
      if (!shared) {
        try { googleAccounts.removeManagedFile(account.envDir) } catch { /* best effort; delete the account regardless */ }
      }
    }
    return service.deleteAccount(pid, aid)
  })
  handle(ROUTER_IPC.googleExisting, () => {
    const email = tokenSaverAccounts().antigravityExportableEmail()
    return email ? { email } : {}
  })
  handle(ROUTER_IPC.googleConnect, async (_event, providerId, mode) => {
    const pid = id(providerId, 'Provider id')
    const state = await service.state()
    const provider = state.providers.find((entry) => entry.id === pid)
    if (!provider) throw new Error('Provider not found')
    if (provider.kind !== 'antigravity') throw new Error('Google sign-in is available for the Antigravity provider')
    const connected = mode === 'existing'
      ? tokenSaverAccounts().exportAntigravityAuthorizedUser(googleRoot)
      : await googleAccounts.connect()
    if (!connected) throw new Error('ND has no signed-in Google account. Use Connect Google account instead.')
    const existing = provider.accounts.find((account) =>
      account.selector?.toLowerCase() === connected.email.toLowerCase()
      || account.label.toLowerCase() === connected.email.toLowerCase())
    let next: RouterState
    try {
      next = await service.saveAccount({
        providerId: pid,
        ...(existing ? { id: existing.id, priority: existing.priority } : {}),
        label: connected.email,
        kind: 'cli',
        selector: connected.email,
        envDir: connected.adcPath,
        isActive: true,
      })
    } catch (error) {
      // A fresh browser sign-in produced a new credentials file; do not leave it
      // behind when the account could not be recorded.
      if (mode !== 'existing') {
        try { googleAccounts.removeManagedFile(connected.adcPath) } catch { /* best effort */ }
      }
      throw error
    }
    const account = next.providers.find((entry) => entry.id === pid)?.accounts.find((entry) =>
      entry.selector?.toLowerCase() === connected.email.toLowerCase())
    return { state: next, email: connected.email, accountId: account?.id ?? existing?.id ?? '' }
  })
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
    // QA/automation seam in development only. The folder still has to pass the
    // full ND Security signature, inventory, and hash verification.
    const automatedSource = !app.isPackaged ? process.env.ND_9ROUTER_INSTALL_DIR?.trim() : undefined
    if (automatedSource) return managed.installFromDirectory(automatedSource)
    const result = await dialog.showOpenDialog(window, { title: 'Choose an ND-signed 9Router release folder', properties: ['openDirectory'] })
    return !result.canceled && result.filePaths[0]
      ? managed.installFromDirectory(result.filePaths[0])
      : managed.state()
  })
  handle(NINE_ROUTER_IPC.importUnverified, async () => {
    if (!managed) throw new Error('Managed 9Router unavailable')
    // Dev/QA seam: the folder still goes through detection, bounds, symlink
    // checks, copying, and hash pinning; only the publisher signature is absent.
    const automatedSource = !app.isPackaged ? process.env.ND_9ROUTER_IMPORT_DIR?.trim() : undefined
    if (automatedSource) return managed.importUnverified(automatedSource)
    const consent = await dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Import an unverified 9Router',
      message: 'ND cannot verify who built this local 9Router.',
      detail: 'The folder will be copied, hash-pinned, and launched as-is. ND does not verify a publisher signature; malicious code can access what your user account can reach and use network access. The import keeps its own dashboard credentials and does not receive ND-managed secrets. Continue only for a build you trust.',
      buttons: ['Cancel', 'Import unverified…'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (consent.response !== 1) return managed.state()
    const result = await dialog.showOpenDialog(window, { title: 'Choose a local 9Router folder (unverified)', properties: ['openDirectory'] })
    return !result.canceled && result.filePaths[0]
      ? managed.importUnverified(result.filePaths[0])
      : managed.state()
  })
  handle(NINE_ROUTER_IPC.prepare, (_event, password) => managed?.prepare(typeof password === 'string' ? password : '') ?? Promise.reject(new Error('Managed runtime unavailable')))
  handle(NINE_ROUTER_IPC.start, async () => {
    if (!managed) throw new Error('Managed runtime unavailable')
    const state = await managed.start()
    if (state.endpoint) {
      try {
        await service.syncNineRouterEndpoint(state.endpoint)
      } catch (error) {
        // The runtime is up; keep the old route target visible instead of
        // failing a successful start.
        console.warn('[9router] could not align the saved provider endpoint:', error)
      }
    }
    return state
  })
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
