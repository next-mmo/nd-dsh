import { shell } from 'electron'
import { join } from 'node:path'
import type {
  BrowserCredentialSummary,
  BrowserExtensionInstallPreview,
  BrowserExtensionRecord,
  BrowserPlatformState,
  BrowserSelection,
  BrowserTabDescriptor,
} from '../../shared/browser-platform.js'
import type { BrowserCompanionService } from '../browser-companion/browser-companion-service.js'
import type { BrowserController } from '../browser/browser-controller.js'
import { BUILTIN_BROWSER_TARGET_ID } from '../browser/browser-controller.js'
import { BrowserCredentialVault } from '../browser/browser-credential-vault.js'
import { BrowserExtensionManager } from '../browser/browser-extension-manager.js'
import type { OrganizationStore } from '../organization/store.js'
import { BrowserAccessTokenStore } from './browser-access-tokens.js'
import { BrowserPolicyService } from './browser-policy-service.js'
import { BrowserTargetRouter } from './browser-target-router.js'
import { UnifiedBrowserTabLeaseStore } from './browser-tab-leases.js'

export class BrowserPlatformService {
  private readonly leases = new UnifiedBrowserTabLeaseStore()
  private readonly accessTokens = new BrowserAccessTokenStore()
  private readonly credentials: BrowserCredentialVault
  private readonly extensions: BrowserExtensionManager
  private readonly policy: BrowserPolicyService
  private readonly router: BrowserTargetRouter
  private onChanged: ((state: BrowserPlatformState) => void) | undefined
  private closed = false

  constructor(
    private readonly browser: BrowserController,
    private readonly companion: BrowserCompanionService,
    organizationStore: OrganizationStore,
    dataPath: string,
  ) {
    this.credentials = new BrowserCredentialVault(join(dataPath, 'browser-credentials.json'))
    this.extensions = new BrowserExtensionManager(
      browser.browserSession(),
      join(dataPath, 'browser-extensions.json'),
      () => { void this.emit() },
    )
    this.policy = new BrowserPolicyService(organizationStore, join(dataPath, 'browser-action-receipts.json'))
    this.router = new BrowserTargetRouter(
      browser,
      companion,
      this.leases,
      this.policy,
      this.credentials,
      this.accessTokens,
    )
    this.browser.setDownloadAuthorizationHandler(async (request) => {
      try {
        const { envelope, decision } = await this.policy.authorize(
          { source: 'agent', sessionId: request.sessionId },
          {
            operation: 'browser.download',
            action: 'file.download',
            targetId: BUILTIN_BROWSER_TARGET_ID,
            profileId: this.browser.profileId(),
            ...(request.tabId ? { tabId: request.tabId } : {}),
            ...(request.origin ? { origin: request.origin } : {}),
            detail: `${request.filename} ${request.url}`.slice(0, 2_000),
          },
        )
        await this.policy.complete(envelope, decision, true)
        return true
      } catch {
        return false
      }
    })
    this.policy.setOnChanged(() => { void this.emit() })
    this.router.setOnChanged(() => { void this.emit() })
    this.browser.setTabClosedListener((tabId) => {
      this.leases.releaseTab(BUILTIN_BROWSER_TARGET_ID, tabId)
      void this.emit()
    })
  }

  async initialize(): Promise<void> {
    await this.extensions.initialize()
    this.companion.setAgentDispatcher((method, params) => this.router.call(method, params, 'agent'))
    await this.emit()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.companion.setAgentDispatcher(undefined)
    this.browser.setDownloadAuthorizationHandler(undefined)
    this.browser.setTabClosedListener(undefined)
    this.policy.setOnChanged(undefined)
    this.router.setOnChanged(undefined)
    this.accessTokens.clear()
  }

  setListener(listener: ((state: BrowserPlatformState) => void) | undefined): void {
    this.onChanged = listener
    if (listener) void this.state().then(listener).catch(() => undefined)
  }

  notifyBrowserChanged(): void {
    void this.emit()
  }

  async notifyCompanionChanged(): Promise<void> {
    const connected = new Set((await this.companion.connectedConnections()).map((item) => `companion:${item.id}`))
    for (const lease of this.leases.list()) {
      if (lease.targetId.startsWith('companion:') && !connected.has(lease.targetId)) this.leases.release(lease.id)
    }
    await this.emit()
  }

  issueSessionAccess(sessionId: string): string {
    return this.accessTokens.issue(sessionId)
  }

  revokeSessionAccess(sessionId: string): void {
    this.accessTokens.revokeSession(sessionId)
    this.leases.releaseOwner(sessionId)
    void this.emit()
  }

  async callAgent(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.extensions.browserUseEnabled()
      && method !== 'browser.targets'
      && method !== 'browser.connections'
      && method !== 'browser.selection') {
      const explicitTarget = typeof params.targetId === 'string' ? params.targetId : undefined
      const selected = this.router.selection()
      const selectedTarget = selected.mode === 'target' || selected.mode === 'tab'
        ? selected.targetId
        : undefined
      const companionOnly = explicitTarget?.startsWith('companion:') === true
        || (!explicitTarget && selectedTarget?.startsWith('companion:') === true)
      if (!companionOnly) {
        throw new Error('Built-in browser agent control is disabled in Settings > Browser')
      }
    }
    return this.router.call(method, params, 'agent')
  }

  async state(): Promise<BrowserPlatformState> {
    const [targets, tabs, credentials, receipts] = await Promise.all([
      this.router.targets(),
      this.router.tabs().catch(() => []),
      this.credentials.list(),
      this.policy.recentReceipts(),
    ])
    return {
      targets,
      tabs,
      selection: this.router.selection(),
      leases: this.leases.list(),
      downloads: this.browser.listDownloads(),
      extensions: this.extensions.list(),
      extensionCatalog: this.extensions.catalog(),
      ...(this.browser.extensionPopupId() ? { extensionPopupId: this.browser.extensionPopupId() } : {}),
      browserUseEnabled: this.extensions.browserUseEnabled(),
      developerMode: this.extensions.developerMode(),
      credentials,
      sitePermissions: this.browser.sitePermissions(),
      approvals: this.policy.approvals(),
      receipts,
    }
  }

  async select(selection: BrowserSelection): Promise<BrowserPlatformState> {
    await this.router.select(selection)
    await this.emit()
    return this.state()
  }

  async createTab(targetId?: string, url?: string): Promise<BrowserTabDescriptor> {
    const result = await this.router.call('browser.openTab', {
      ...(targetId ? { targetId } : {}),
      ...(url ? { url } : {}),
    }, 'renderer') as { tab?: BrowserTabDescriptor }
    await this.emit()
    if (!result?.tab) throw new Error('Browser target did not create a tab')
    return result.tab
  }

  async activateTab(targetId: string, tabId: string): Promise<BrowserTabDescriptor> {
    const result = await this.router.call('browser.activateTab', { targetId, tabId }, 'renderer') as BrowserTabDescriptor
    await this.emit()
    return result
  }

  /** Live tab descriptors for one target (extension hosts mirror them as sessions). */
  async tabs(targetId?: string): Promise<BrowserTabDescriptor[]> {
    return this.router.tabs(targetId).catch(() => [])
  }

  async closeTab(targetId: string, tabId: string): Promise<boolean> {
    // A direct user close is authoritative: revoke any agent writer before
    // closing so an in-flight lane cannot keep ownership of a tab the user
    // explicitly removed.
    this.leases.releaseTab(targetId, tabId)
    const result = await this.router.call('browser.closeTab', {
      targetId,
      tabId,
      leaseId: this.manualLease(targetId, tabId),
    }, 'renderer')
    await this.emit()
    return result === true
  }

  async history(targetId = BUILTIN_BROWSER_TARGET_ID) {
    if (targetId !== BUILTIN_BROWSER_TARGET_ID) throw new Error('History is available only for the ND built-in browser')
    return this.browser.history(targetId)
  }

  async clearBrowserData(input: { targetId?: string | undefined; origin?: string | undefined; history?: boolean | undefined }): Promise<void> {
    const targetId = input.targetId ?? BUILTIN_BROWSER_TARGET_ID
    if (targetId !== BUILTIN_BROWSER_TARGET_ID) throw new Error('Browser-data clearing is available only for the ND built-in profile')
    await this.browser.clearBrowserData(input.origin, input.history !== false)
    await this.emit()
  }

  cancelDownload(downloadId: string): boolean {
    const canceled = this.browser.cancelDownload(downloadId)
    if (canceled) void this.emit()
    return canceled
  }

  async openDownload(downloadId: string): Promise<boolean> {
    const path = this.browser.downloadPath(downloadId)
    if (!path) return false
    return (await shell.openPath(path)) === ''
  }

  async revealDownload(downloadId: string): Promise<boolean> {
    const path = this.browser.downloadPath(downloadId)
    if (!path) return false
    shell.showItemInFolder(path)
    return true
  }

  clearFinishedDownloads(): number {
    const removed = this.browser.clearFinishedDownloads()
    if (removed > 0) void this.emit()
    return removed
  }

  async previewExtension(path: string): Promise<BrowserExtensionInstallPreview> {
    if (!this.extensions.developerMode()) {
      throw new Error('Enable Browser extension Developer mode before loading an unpacked extension')
    }
    return this.extensions.preview(path)
  }

  async installExtension(path: string): Promise<BrowserExtensionRecord> {
    if (!this.extensions.developerMode()) {
      throw new Error('Enable Browser extension Developer mode before loading an unpacked extension')
    }
    const record = await this.extensions.install(path)
    await this.emit()
    return record
  }

  async setExtensionEnabled(extensionId: string, enabled: boolean): Promise<BrowserExtensionRecord[]> {
    const adBlock = this.extensions.list().some(item => item.id === extensionId && item.catalogId === 'nd-ad-block')
    if (!enabled && this.browser.extensionPopupId() === extensionId) this.browser.closeExtensionPopup()
    const records = await this.extensions.setEnabled(extensionId, enabled)
    if (adBlock) await this.browser.refreshAdBlockPages()
    await this.emit()
    return records
  }

  async removeExtension(extensionId: string): Promise<BrowserExtensionRecord[]> {
    const adBlock = this.extensions.list().some(item => item.id === extensionId && item.catalogId === 'nd-ad-block')
    if (this.browser.extensionPopupId() === extensionId) this.browser.closeExtensionPopup()
    const records = await this.extensions.remove(extensionId)
    if (adBlock) await this.browser.refreshAdBlockPages()
    await this.emit()
    return records
  }

  async reloadExtensions(): Promise<BrowserExtensionRecord[]> {
    const adBlock = this.extensions.list().some(item => item.catalogId === 'nd-ad-block' && item.enabled)
    this.browser.closeExtensionPopup()
    const records = await this.extensions.reloadAll()
    if (adBlock) await this.browser.refreshAdBlockPages()
    await this.emit()
    return records
  }

  async setDeveloperMode(enabled: boolean): Promise<BrowserPlatformState> {
    await this.extensions.setDeveloperMode(enabled)
    await this.emit()
    return this.state()
  }

  async setBrowserUseEnabled(enabled: boolean): Promise<BrowserPlatformState> {
    await this.extensions.setBrowserUseEnabled(enabled)
    await this.emit()
    return this.state()
  }

  async previewCatalogExtension(catalogId: string): Promise<BrowserExtensionInstallPreview> {
    return this.extensions.previewCatalog(catalogId)
  }

  async installCatalogExtension(catalogId: string): Promise<BrowserExtensionRecord> {
    const record = await this.extensions.installCatalog(catalogId)
    if (catalogId === 'nd-ad-block' && record.enabled && !record.error) await this.browser.refreshAdBlockPages()
    await this.emit()
    return record
  }

  async openCatalogExtension(catalogId: string): Promise<BrowserTabDescriptor> {
    const item = this.extensions.catalog().find((candidate) => candidate.id === catalogId)
    if (!item) throw new Error('Unknown built-in browser extension catalog item')
    if (!item.storeUrl) throw new Error('This built-in extension does not have an external catalog listing')
    const tab = await this.browser.createTab(item.storeUrl, true)
    await this.router.select({ mode: 'tab', targetId: BUILTIN_BROWSER_TARGET_ID, tabId: tab.id })
    await this.emit()
    return tab
  }

  async showExtensionPopup(extensionId: string): Promise<BrowserPlatformState> {
    const extension = this.extensions.list().find((item) => item.id === extensionId)
    if (!extension) throw new Error('Built-in browser extension not found')
    if (!extension.enabled) throw new Error('Built-in browser extension is disabled')
    if (!extension.actionPopup) throw new Error('This extension does not declare action.default_popup')
    await this.browser.showExtensionPopup(extension.id, extension.actionPopup)
    await this.emit()
    return this.state()
  }

  async closeExtensionPopup(): Promise<BrowserPlatformState> {
    this.browser.closeExtensionPopup()
    await this.emit()
    return this.state()
  }

  async saveCredential(input: { origin: string; username: string; password: string; label?: string | undefined }): Promise<BrowserCredentialSummary> {
    const summary = await this.credentials.save(input)
    await this.emit()
    return summary
  }

  async removeCredential(credentialId: string): Promise<boolean> {
    const removed = await this.credentials.remove(credentialId)
    if (removed) await this.emit()
    return removed
  }

  async autofillCredential(
    credentialId: string,
    targetId = BUILTIN_BROWSER_TARGET_ID,
    tabId?: string,
  ): Promise<{ ok: true; credentialId: string; username: string }> {
    if (targetId !== BUILTIN_BROWSER_TARGET_ID) throw new Error('ND saved credentials are available only to the built-in browser')
    const activeTabId = tabId ?? this.browser.activeTabId()
    this.leases.releaseTab(targetId, activeTabId)
    const leaseId = this.manualLease(targetId, activeTabId)
    const result = await this.router.call('browser.autofill', {
      targetId,
      tabId: activeTabId,
      leaseId,
      credentialId,
    }, 'renderer') as { ok: true; credentialId: string; username: string }
    this.leases.release(leaseId)
    await this.emit()
    return result
  }

  async siteTools(targetId = BUILTIN_BROWSER_TARGET_ID, tabId?: string) {
    if (targetId !== BUILTIN_BROWSER_TARGET_ID) return []
    return this.browser.discoverSiteTools(tabId ?? this.browser.activeTabId())
  }

  async setSitePermission(origin: string, permission: string, effect: 'allow' | 'deny') {
    const record = await this.browser.setSitePermission(origin, permission, effect)
    await this.emit()
    return record
  }

  resolveApproval(approvalId: string, allowed: boolean): boolean {
    const resolved = this.policy.resolveApproval(approvalId, allowed)
    if (resolved) void this.emit()
    return resolved
  }

  private manualLease(targetId: string, tabId: string): string {
    const target = this.leases.list().find((lease) =>
      lease.targetId === targetId && lease.tabId === tabId && lease.ownerId === 'renderer')
    if (target) return target.id

    const profileId = targetId === BUILTIN_BROWSER_TARGET_ID
      ? this.browser.profileId()
      : `companion-profile:${targetId.replace(/^companion:/, '')}`
    return this.leases.acquire({
      ownerId: 'renderer',
      targetId,
      profileId,
      tabId,
    }).id
  }

  private async emit(): Promise<void> {
    if (this.closed || !this.onChanged) return
    this.onChanged(await this.state())
  }
}
