import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  BROWSER_PLATFORM_IPC,
  type BrowserExtensionInstallPreview,
  type BrowserSelection,
} from '../../shared/browser-platform.js'
import type { BrowserPlatformService } from './browser-platform-service.js'

export function registerBrowserPlatformIpc(
  window: BrowserWindow,
  service: BrowserPlatformService,
): () => void {
  const channels: string[] = []
  const handle = (channel: string, listener: (...args: unknown[]) => unknown | Promise<unknown>): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      assertTrustedSender(event, window)
      return listener(...args)
    })
    channels.push(channel)
  }

  handle(BROWSER_PLATFORM_IPC.state, () => service.state())
  handle(BROWSER_PLATFORM_IPC.createProfile, (name, color) =>
    service.createProfile(
      asString(name, 'Browser profile name', 64),
      optionalString(color, 16),
    ))
  handle(BROWSER_PLATFORM_IPC.selectProfile, (profileId) =>
    service.selectProfile(asString(profileId, 'Browser profile id', 64)))
  handle(BROWSER_PLATFORM_IPC.updateProfile, (profileId, value) => {
    const input = object(value, 'Browser profile update')
    return service.updateProfile(asString(profileId, 'Browser profile id', 64), {
      ...(input.name === undefined ? {} : { name: asString(input.name, 'Browser profile name', 64) }),
      ...(input.color === undefined ? {} : { color: asString(input.color, 'Browser profile color', 16) }),
    })
  })
  handle(BROWSER_PLATFORM_IPC.setDefaultProfile, (profileId) =>
    service.setDefaultProfile(asString(profileId, 'Browser profile id', 64)))
  handle(BROWSER_PLATFORM_IPC.deleteProfile, (profileId) =>
    service.deleteProfile(asString(profileId, 'Browser profile id', 64)))
  handle(BROWSER_PLATFORM_IPC.select, (value) => service.select(asSelection(value)))
  handle(BROWSER_PLATFORM_IPC.createTab, (targetId, url) =>
    service.createTab(optionalString(targetId, 512), optionalString(url, 16_384)))
  handle(BROWSER_PLATFORM_IPC.activateTab, (targetId, tabId) =>
    service.activateTab(asString(targetId, 'Browser target id', 512), asString(tabId, 'Browser tab id', 512)))
  handle(BROWSER_PLATFORM_IPC.closeTab, (targetId, tabId) =>
    service.closeTab(asString(targetId, 'Browser target id', 512), asString(tabId, 'Browser tab id', 512)))
  handle(BROWSER_PLATFORM_IPC.history, (targetId) => service.history(optionalString(targetId, 512)))
  handle(BROWSER_PLATFORM_IPC.clearData, (value) => {
    const input = object(value, 'Browser data clear request')
    return service.clearBrowserData({
      ...(optionalString(input.targetId, 512) ? { targetId: optionalString(input.targetId, 512) } : {}),
      ...(optionalString(input.origin, 4_096) ? { origin: optionalString(input.origin, 4_096) } : {}),
      ...(input.history === undefined ? {} : { history: Boolean(input.history) }),
    })
  })
  handle(BROWSER_PLATFORM_IPC.cancelDownload, (downloadId) =>
    service.cancelDownload(asString(downloadId, 'Download id', 512)))
  handle(BROWSER_PLATFORM_IPC.openDownload, (downloadId) =>
    service.openDownload(asString(downloadId, 'Download id', 512)))
  handle(BROWSER_PLATFORM_IPC.revealDownload, (downloadId) =>
    service.revealDownload(asString(downloadId, 'Download id', 512)))
  handle(BROWSER_PLATFORM_IPC.clearFinishedDownloads, () => service.clearFinishedDownloads())
  handle(BROWSER_PLATFORM_IPC.installExtension, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Load unpacked browser extension',
      properties: ['openDirectory'],
    })
    const path = result.filePaths[0]
    if (result.canceled || !path) return null
    const preview = await service.previewExtension(path)
    if (!await confirmExtensionInstall(window, preview)) return null
    return service.installExtension(path)
  })
  handle(BROWSER_PLATFORM_IPC.extensionEnabled, (extensionId, enabled) =>
    service.setExtensionEnabled(asString(extensionId, 'Extension id', 1_024), Boolean(enabled)))
  handle(BROWSER_PLATFORM_IPC.removeExtension, (extensionId) =>
    service.removeExtension(asString(extensionId, 'Extension id', 1_024)))
  handle(BROWSER_PLATFORM_IPC.reloadExtensions, () => service.reloadExtensions())
  handle(BROWSER_PLATFORM_IPC.developerMode, (enabled) => service.setDeveloperMode(Boolean(enabled)))
  handle(BROWSER_PLATFORM_IPC.browserUseEnabled, (enabled) => service.setBrowserUseEnabled(Boolean(enabled)))
  handle(BROWSER_PLATFORM_IPC.installCatalogExtension, async (catalogId) => {
    const id = asString(catalogId, 'Browser extension catalog id', 512)
    const item = (await service.state()).extensionCatalog.find((candidate) => candidate.id === id)
    if (!item) throw new Error('Unknown built-in browser extension catalog item')
    if (item.packagePolicy === 'reference-only') {
      throw new Error(
        `${item.name} is reference-only. Use Developer mode → Load unpacked to test a third-party folder without publisher verification.`,
      )
    }
    if (!item.bundleAvailable) throw new Error(`${item.name} is missing from this ND build.`)

    const preview = await service.previewCatalogExtension(id)
    if (!await confirmExtensionInstall(window, preview, `${item.name} · ${item.publisher}`)) return null
    return service.installCatalogExtension(id)
  })
  handle(BROWSER_PLATFORM_IPC.openCatalogExtension, (catalogId) =>
    service.openCatalogExtension(asString(catalogId, 'Browser extension catalog id', 512)))
  handle(BROWSER_PLATFORM_IPC.showExtensionPopup, (extensionId) =>
    service.showExtensionPopup(asString(extensionId, 'Browser extension id', 1_024)))
  handle(BROWSER_PLATFORM_IPC.closeExtensionPopup, () => service.closeExtensionPopup())
  handle(BROWSER_PLATFORM_IPC.saveCredential, (value) => {
    const input = object(value, 'Browser credential')
    return service.saveCredential({
      origin: asString(input.origin, 'Credential origin', 4_096),
      username: asString(input.username, 'Credential username', 512),
      password: asString(input.password, 'Credential password', 32_768, false),
      ...(optionalString(input.label, 256) ? { label: optionalString(input.label, 256) } : {}),
    })
  })
  handle(BROWSER_PLATFORM_IPC.removeCredential, (credentialId) =>
    service.removeCredential(asString(credentialId, 'Credential id', 512)))
  handle(BROWSER_PLATFORM_IPC.autofillCredential, (credentialId, targetId, tabId) =>
    service.autofillCredential(
      asString(credentialId, 'Credential id', 512),
      optionalString(targetId, 512),
      optionalString(tabId, 512),
    ))
  handle(BROWSER_PLATFORM_IPC.siteTools, (targetId, tabId) =>
    service.siteTools(optionalString(targetId, 512), optionalString(tabId, 512)))
  handle(BROWSER_PLATFORM_IPC.setSitePermission, (origin, permission, effect) => {
    if (effect !== 'allow' && effect !== 'deny') throw new Error('Browser permission effect must be allow or deny')
    return service.setSitePermission(
      asString(origin, 'Browser permission origin', 4_096),
      asString(permission, 'Browser permission', 128),
      effect,
    )
  })
  handle(BROWSER_PLATFORM_IPC.resolveApproval, (approvalId, allowed) =>
    service.resolveApproval(asString(approvalId, 'Browser approval id', 512), Boolean(allowed)))

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}

async function confirmExtensionInstall(
  window: BrowserWindow,
  preview: BrowserExtensionInstallPreview,
  catalogLabel?: string,
): Promise<boolean> {
  const permissions = preview.permissions.length > 0
    ? preview.permissions.map((permission) => `• ${permission}`).join('\n')
    : 'No extension API or host permissions declared.'
  const compatibility = preview.compatibilityNotes.length > 0
    ? preview.compatibilityNotes.map((note) => `• ${note}`).join('\n')
    : 'No compatibility warnings detected for ND\'s documented Electron extension subset.'
  const detail = [
    catalogLabel ? `Catalog: ${catalogLabel}` : undefined,
    `Manifest: MV${preview.manifestVersion ?? '?'} · ${preview.status}`,
    '',
    'Requested permissions:',
    permissions,
    '',
    'Compatibility:',
    compatibility,
    '',
    `Source: ${preview.path}`,
  ].filter((line): line is string => line !== undefined).join('\n')

  const result = await dialog.showMessageBox(window, {
    type: preview.status === 'compatible' ? 'question' : 'warning',
    buttons: ['Cancel', 'Load into ND browser'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Load browser extension into ND?',
    message: `${preview.name} ${preview.version}`,
    detail,
  })
  return result.response === 1
}

function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Rejected browser-platform IPC from an untrusted renderer frame')
  }
}

function asSelection(value: unknown): BrowserSelection {
  const input = object(value, 'Browser selection')
  if (input.mode !== 'auto' && input.mode !== 'target' && input.mode !== 'tab') {
    throw new Error('Browser selection mode must be auto, target, or tab')
  }
  return {
    mode: input.mode,
    ...(optionalString(input.targetId, 512) ? { targetId: optionalString(input.targetId, 512) } : {}),
    ...(optionalString(input.tabId, 512) ? { tabId: optionalString(input.tabId, 512) } : {}),
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return asString(value, 'Value', max)
}

function asString(value: unknown, label: string, max: number, trim = true): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const result = trim ? value.trim() : value
  if (!result || result.length > max) throw new Error(`${label} is invalid`)
  return result
}
