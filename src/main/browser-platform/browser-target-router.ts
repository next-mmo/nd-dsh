import { randomUUID } from 'node:crypto'
import type {
  BrowserExecutionScope,
  BrowserSelection,
  BrowserSiteToolDescriptor,
  BrowserTabDescriptor,
  BrowserTargetDescriptor,
} from '../../shared/browser-platform.js'
import type { BrowserCompanionService } from '../browser-companion/browser-companion-service.js'
import type { BrowserController } from '../browser/browser-controller.js'
import type { BrowserCredentialVault } from '../browser/browser-credential-vault.js'
import { BuiltinBrowserTarget } from './builtin-browser-target.js'
import { BrowserAccessTokenStore } from './browser-access-tokens.js'
import type { BrowserActionContext, BrowserPolicyService } from './browser-policy-service.js'
import { CompanionBrowserTarget, companionTargetId } from './companion-browser-target.js'
import type { BrowserTarget } from './browser-target.js'
import { UnifiedBrowserTabLeaseStore } from './browser-tab-leases.js'

export class BrowserTargetRouter {
  private selectionValue: BrowserSelection = { mode: 'auto' }
  private onChanged: (() => void) | undefined
  private readonly builtin: BuiltinBrowserTarget

  constructor(
    private readonly browser: BrowserController,
    private readonly companion: BrowserCompanionService,
    private readonly leases: UnifiedBrowserTabLeaseStore,
    private readonly policy: BrowserPolicyService,
    private readonly credentials: BrowserCredentialVault,
    private readonly accessTokens: BrowserAccessTokenStore,
  ) {
    this.builtin = new BuiltinBrowserTarget(browser)
  }

  setOnChanged(listener: (() => void) | undefined): void {
    this.onChanged = listener
  }

  selection(): BrowserSelection {
    return structuredClone(this.selectionValue)
  }

  async select(selection: BrowserSelection): Promise<void> {
    if (selection.mode === 'target') {
      if (!selection.targetId) throw new Error('Target selection requires targetId')
      await this.target(selection.targetId)
      this.selectionValue = { mode: 'target', targetId: selection.targetId }
    } else if (selection.mode === 'tab') {
      if (!selection.targetId || !selection.tabId) throw new Error('Tab selection requires targetId and tabId')
      const target = await this.target(selection.targetId)
      await this.requireTab(target, selection.tabId)
      this.selectionValue = { mode: 'tab', targetId: selection.targetId, tabId: selection.tabId }
    } else {
      this.selectionValue = { mode: 'auto' }
    }
    this.onChanged?.()
  }

  async targets(): Promise<BrowserTargetDescriptor[]> {
    const descriptors = [await this.builtin.descriptor()]
    for (const connection of await this.companion.connectedConnections()) {
      descriptors.push(new CompanionBrowserTarget(this.companion, connection).descriptor())
    }
    return descriptors
  }

  async tabs(targetId?: string): Promise<BrowserTabDescriptor[]> {
    if (targetId) return (await this.target(targetId)).listTabs()
    const targets = await this.targetInstances()
    return (await Promise.all(targets.map((target) => target.listTabs().catch(() => [])))).flat()
  }

  async call(method: string, params: Record<string, unknown>, source: 'agent' | 'renderer' = 'agent'): Promise<unknown> {
    const context = this.context(params, source)

    if (method === 'browser.targets' || method === 'browser.connections') return this.targets()
    if (method === 'browser.selection') return this.selection()
    if (method === 'browser.select') {
      const selection = selectionFrom(params)
      await this.select(selection)
      return this.selection()
    }
    if (method === 'browser.tabs') {
      this.requireAgentSession(context, method)
      const targetId = await this.resolveTargetId(params)
      return this.tabs(targetId)
    }
    if (method === 'browser.attach') { 
      this.requireAgentSession(context, method)
      const { target, targetId, tabId, tab } = await this.resolveTargetAndTab(params)
      const descriptor = await target.descriptor()
      const scope = await this.policy.trustedScope(context)
      const ownerId = context.sessionId ?? `manual-agent:${randomUUID()}`
      const lease = this.leases.acquire({
        ownerId,
        targetId,
        profileId: descriptor.profileId,
        tabId,
        ...(scope ? { scope } : {}),
      })
      this.onChanged?.()
      return { lease, tab }
    }
    if (method === 'browser.detach') {
      this.requireAgentSession(context, method)
      const leaseId = requiredString(params.leaseId, 'leaseId')
      const released = context.source === 'renderer'
        ? this.leases.release(leaseId)
        : this.leases.releaseOwned(leaseId, context.sessionId!)
      if (released) this.onChanged?.()
      return { released }
    }
    if (method === 'browser.openTab') { 
      this.requireAgentSession(context, method)
      const target = await this.resolveTarget(params)
      const descriptor = await target.descriptor()
      const url = typeof params.url === 'string' && params.url.trim() ? params.url.trim() : 'about:blank'
      const { envelope, decision } = await this.policy.authorize(context, {
        operation: 'browser.openTab',
        targetId: descriptor.id,
        profileId: descriptor.profileId,
        ...(origin(url) ? { origin: origin(url) } : {}),
        detail: url,
      })
      try {
        const tab = await target.openTab(url)
        let lease
        if (source === 'agent') {
          const scope = await this.policy.trustedScope(context)
          lease = this.leases.acquire({
            ownerId: context.sessionId ?? `manual-agent:${randomUUID()}`,
            targetId: descriptor.id,
            profileId: descriptor.profileId,
            tabId: tab.id,
            ...(scope ? { scope } : {}),
          })
        }
        await this.policy.complete(envelope, decision, true)
        this.onChanged?.()
        return { tab, ...(lease ? { lease } : {}) }
      } catch (cause) {
        await this.policy.complete(envelope, decision, false, errorMessage(cause))
        throw cause
      }
    }
    if (method === 'browser.activateTab') { 
      this.requireAgentSession(context, method)
      const { target, targetId, tabId, tab } = await this.resolveTargetAndTab(params)
      const descriptor = await target.descriptor()
      return this.runAction(context, {
        operation: 'browser.activateTab',
        targetId,
        profileId: descriptor.profileId,
        tabId,
        origin: tab.origin,
      }, () => target.activateTab(tabId))
    }
    if (method === 'browser.closeTab') { 
      this.requireAgentSession(context, method)
      const { target, targetId, tabId, tab } = await this.resolveTargetAndTab(params)
      this.assertLease(params, targetId, tabId, context)
      const descriptor = await target.descriptor()
      const result = await this.runAction(context, {
        operation: 'browser.closeTab',
        targetId,
        profileId: descriptor.profileId,
        tabId,
        origin: tab.origin,
      }, () => target.closeTab(tabId))
      this.leases.releaseTab(targetId, tabId)
      this.onChanged?.()
      return result
    }
    if (method === 'browser.downloads') {
      this.requireAgentSession(context, method)
      const targetId = await this.resolveTargetId(params)
      if (targetId !== 'builtin') throw new Error('Download state is available only for the ND built-in browser')
      const descriptor = await this.builtin.descriptor()
      return this.runAction(context, {
        operation: 'browser.downloads',
        targetId,
        profileId: descriptor.profileId,
      }, async () => this.browser.listDownloads())
    }
    if (method === 'browser.cancelDownload') {
      this.requireAgentSession(context, method)
      const targetId = await this.resolveTargetId(params)
      if (targetId !== 'builtin') throw new Error('Download cancellation is available only for the ND built-in browser')
      const descriptor = await this.builtin.descriptor()
      const downloadId = requiredString(params.downloadId, 'downloadId')
      return this.runAction(context, {
        operation: 'browser.cancelDownload',
        action: 'file.download',
        targetId,
        profileId: descriptor.profileId,
        detail: downloadId,
      }, async () => ({ canceled: this.browser.cancelDownload(downloadId) }))
    }
    if (method === 'browser.credentials') {
      this.requireAgentSession(context, method)
      const targetId = await this.resolveTargetId(params)
      if (targetId !== 'builtin') throw new Error('ND credential metadata is available only for the built-in browser')
      const descriptor = await this.builtin.descriptor()
      return this.runAction(context, {
        operation: 'browser.credentials',
        action: 'credential.use',
        targetId,
        profileId: descriptor.profileId,
      }, () => this.credentials.list(this.browser.activeProfileId()))
    }
    if (method === 'browser.history') { 
      this.requireAgentSession(context, method)
      const targetId = await this.resolveTargetId(params)
      if (targetId !== 'builtin') throw new Error('History is available only for the ND built-in browser')
      const descriptor = await this.builtin.descriptor()
      return this.runAction(context, {
        operation: 'browser.history',
        targetId,
        profileId: descriptor.profileId,
      }, () => this.browser.history(targetId))
    }
    if (method === 'browser.autofill') { 
      this.requireAgentSession(context, method)
      const { target, targetId, tabId, tab } = await this.resolveTargetAndTab(params)
      this.assertLease(params, targetId, tabId, context)
      if (!target.autofillCredential) throw new Error('Selected browser target does not support ND credential autofill')
      const credentialId = requiredString(params.credentialId, 'credentialId')
      const currentOrigin = tab.origin ?? origin(tab.url)
      if (!currentOrigin) throw new Error('Credential autofill requires an http/https page')
      const secret = await this.credentials.secret(credentialId, currentOrigin, builtinProfileRecordId(tab))
      const descriptor = await target.descriptor()
      return this.runAction(context, {
        operation: 'browser.autofill',
        action: 'credential.use',
        targetId,
        profileId: descriptor.profileId,
        tabId,
        origin: currentOrigin,
        detail: secret.summary.username,
      }, async () => {
        await target.autofillCredential!(tabId, secret.summary.username, secret.password)
        return { ok: true, credentialId: secret.summary.id, username: secret.summary.username }
      })
    }

    const { target, targetId, tabId, tab } = await this.resolveTargetAndTab(params)
    const descriptor = await target.descriptor()

    if (method === 'browser.snapshot') {
      this.requireAgentSession(context, method)
      return this.runAction(context, {
        operation: 'browser.snapshot',
        targetId,
        profileId: descriptor.profileId,
        tabId,
        origin: tab.origin,
      }, () => target.snapshot(tabId))
    }
    if (method === 'browser.screenshot') {
      this.requireAgentSession(context, method)
      return this.runAction(context, {
        operation: 'browser.screenshot',
        targetId,
        profileId: descriptor.profileId,
        tabId,
        origin: tab.origin,
      }, () => target.screenshot(tabId))
    }
    if (method === 'browser.waitFor') {
      this.requireAgentSession(context, method)
      return this.runAction(context, {
        operation: 'browser.waitFor',
        targetId,
        profileId: descriptor.profileId,
        tabId,
        origin: tab.origin,
      }, () => target.waitFor(tabId, {
        ...(typeof params.text === 'string' ? { text: params.text } : {}),
        ...(typeof params.urlIncludes === 'string' ? { urlIncludes: params.urlIncludes } : {}),
        ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
      }))
    }
    if (method === 'browser.siteTools') {
      this.requireAgentSession(context, method)
      return this.runAction(context, {
        operation: 'browser.siteTools.list',
        targetId,
        profileId: descriptor.profileId,
        tabId,
        origin: tab.origin,
      }, () => target.discoverSiteTools(tabId))
    }
    if (method === 'browser.siteTool') { 
      this.requireAgentSession(context, method)
      this.assertLease(params, targetId, tabId, context)
      const name = requiredString(params.name, 'name')
      const tools = await target.discoverSiteTools(tabId)
      const tool = tools.find((item) => item.name === name)
      if (!tool) throw new Error('WebMCP site tool not found')
      return this.runAction(context, {
        operation: 'browser.siteTool',
        targetId,
        profileId: descriptor.profileId,
        tabId,
        origin: tool.origin ?? tab.origin,
        detail: toolDetail(tool),
        ...(tool.annotations?.consequentialHint ? { destructive: true, externality: 'external' } : {}),
      }, () => target.callSiteTool(tabId, name, params.input ?? {}))
    }

    this.requireAgentSession(context, method)
    this.assertLease(params, targetId, tabId, context)
    if (method === 'browser.navigate') {
      const url = requiredString(params.url, 'url')
      return this.runAction(context, {
        operation: 'browser.navigate',
        targetId,
        profileId: descriptor.profileId,
        tabId,
        ...(origin(url) ? { origin: origin(url) } : {}),
        detail: url,
      }, () => target.navigate(tabId, url))
    }
    if (method === 'browser.back') {
      return this.runAction(context, {
        operation: 'browser.navigate.back',
        action: 'browser.navigate',
        targetId,
        profileId: descriptor.profileId,
        tabId,
        origin: tab.origin,
      }, () => target.back(tabId))
    }
    if (method === 'browser.forward') {
      return this.runAction(context, {
        operation: 'browser.navigate.forward',
        action: 'browser.navigate',
        targetId,
        profileId: descriptor.profileId,
        tabId,
        origin: tab.origin,
      }, () => target.forward(tabId))
    }
    if (method === 'browser.reload') {
      return this.runAction(context, {
        operation: 'browser.navigate.reload',
        action: 'browser.navigate',
        targetId,
        profileId: descriptor.profileId,
        tabId,
        origin: tab.origin,
      }, () => target.reload(tabId))
    }
    if (method === 'browser.click') {
      const ref = requiredString(params.ref, 'ref')
      const revision = requiredInteger(params.revision, 'revision')
      const detail = await this.elementDetail(target, tabId, ref, revision)
      return this.runAction(context, {
        operation: 'browser.click',
        targetId,
        profileId: descriptor.profileId,
        tabId,
        origin: tab.origin,
        detail,
      }, () => target.click(tabId, ref, revision))
    }
    if (method === 'browser.fill') {
      const ref = requiredString(params.ref, 'ref')
      const revision = requiredInteger(params.revision, 'revision')
      const detail = await this.elementDetail(target, tabId, ref, revision)
      return this.runAction(context, {
        operation: 'browser.fill',
        targetId,
        profileId: descriptor.profileId,
        tabId,
        origin: tab.origin,
        detail,
      }, () => target.fill(
        tabId,
        ref,
        revision,
        String(params.text ?? '').slice(0, 100_000),
      ))
    }
    if (method === 'browser.press') {
      const ref = requiredString(params.ref, 'ref')
      const revision = requiredInteger(params.revision, 'revision')
      const key = requiredString(params.key, 'key')
      const detail = `${await this.elementDetail(target, tabId, ref, revision)} key:${key}`
      return this.runAction(context, {
        operation: 'browser.press',
        targetId,
        profileId: descriptor.profileId,
        tabId,
        origin: tab.origin,
        detail,
      }, () => target.press(tabId, ref, revision, key))
    }
    if (method === 'browser.scroll') {
      return this.runAction(context, {
        operation: 'browser.scroll',
        targetId,
        profileId: descriptor.profileId,
        tabId,
        origin: tab.origin,
      }, () => target.scroll(tabId, finite(params.deltaX), finite(params.deltaY)))
    }

    throw new Error(`Unknown unified browser method: ${method}`)
  }

  private context(params: Record<string, unknown>, source: 'agent' | 'renderer'): BrowserActionContext {
    if (source === 'renderer') return { source }
    const accessToken = typeof params.accessToken === 'string' ? params.accessToken : undefined
    if (accessToken) {
      const sessionId = this.accessTokens.session(accessToken)
      if (!sessionId) throw new Error('Browser access token is invalid or expired')
      return { source, sessionId }
    }
    return { source }
  }

  private async runAction<T>(
    context: BrowserActionContext,
    input: Parameters<BrowserPolicyService['authorize']>[1],
    operation: () => Promise<T>,
  ): Promise<T> {
    const { envelope, decision } = await this.policy.authorize(context, input)
    if (context.source === 'agent'
      && context.sessionId
      && input.targetId === 'builtin'
      && input.tabId
      && canTriggerDownload(input.operation)) {
      this.browser.armAgentDownload(input.tabId, context.sessionId)
    }
    try {
      const result = await operation()
      await this.policy.complete(envelope, decision, true)
      return result
    } catch (cause) {
      await this.policy.complete(envelope, decision, false, errorMessage(cause))
      throw cause
    }
  }

  private async elementDetail(target: BrowserTarget, tabId: string, ref: string, revision: number): Promise<string> {
    const snapshot = await target.snapshot(tabId) as {
      revision?: unknown
      elements?: Array<{ ref?: unknown; name?: unknown; text?: unknown; href?: unknown; role?: unknown; type?: unknown }>
    }
    if (snapshot.revision !== revision) {
      throw new Error('STALE_BROWSER_REFERENCE: Page changed after the snapshot; take a fresh snapshot before acting')
    }
    const element = snapshot.elements?.find((item) => item.ref === ref)
    if (!element) throw new Error('STALE_BROWSER_REFERENCE: Element reference is stale; take a fresh snapshot')
    return [element.name, element.text, element.href, element.role, element.type]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' ')
      .slice(0, 2_000)
  }

  private requireAgentSession(context: BrowserActionContext, method: string): void {
    if (context.source === 'renderer') return
    if (!context.sessionId) {
      throw new Error(`${method} requires the opaque browser access token for the current ND session`)
    }
  }

  private assertLease(params: Record<string, unknown>, targetId: string, tabId: string, context: BrowserActionContext): void {
    const leaseId = requiredString(params.leaseId, 'leaseId')
    this.leases.assert(leaseId, targetId, tabId, context.sessionId)
  }

  private async resolveTarget(params: Record<string, unknown>): Promise<BrowserTarget> {
    const targetId = await this.resolveTargetId(params)
    return this.target(targetId)
  }

  private async resolveTargetAndTab(params: Record<string, unknown>): Promise<{
    target: BrowserTarget
    targetId: string
    tabId: string
    tab: BrowserTabDescriptor
  }> {
    const targetId = await this.resolveTargetId(params)
    const target = await this.target(targetId)
    const requestedTab = tabString(params.tabId)
      ?? (this.selectionValue.mode === 'tab' && this.selectionValue.targetId === targetId ? this.selectionValue.tabId : undefined)
    const tabs = await target.listTabs()
    const tab = requestedTab
      ? tabs.find((item) => item.id === requestedTab)
      : tabs.find((item) => item.active) ?? tabs[0]
    if (!tab) throw new Error('Selected browser target has no tabs')
    return { target, targetId, tabId: tab.id, tab }
  }

  private async resolveTargetId(params: Record<string, unknown>): Promise<string> {
    if (typeof params.targetId === 'string' && params.targetId.trim()) return params.targetId.trim()
    if (typeof params.connectionId === 'string' && params.connectionId.trim()) return companionTargetId(params.connectionId.trim())
    if (this.selectionValue.mode !== 'auto' && this.selectionValue.targetId) return this.selectionValue.targetId
    return 'builtin'
  }

  private async target(targetId: string): Promise<BrowserTarget> {
    if (targetId === 'builtin') return this.builtin
    if (targetId.startsWith('companion:')) {
      const connectionId = targetId.slice('companion:'.length)
      const connection = (await this.companion.connectedConnections()).find((item) => item.id === connectionId)
      if (!connection) throw new Error('Selected Chrome companion is not connected')
      return new CompanionBrowserTarget(this.companion, connection)
    }
    throw new Error('Unknown browser target')
  }

  private async targetInstances(): Promise<BrowserTarget[]> {
    const result: BrowserTarget[] = [this.builtin]
    for (const connection of await this.companion.connectedConnections()) {
      result.push(new CompanionBrowserTarget(this.companion, connection))
    }
    return result
  }

  private async requireTab(target: BrowserTarget, tabId: string): Promise<BrowserTabDescriptor> {
    const tab = (await target.listTabs()).find((item) => item.id === tabId)
    if (!tab) throw new Error('Browser tab not found')
    return tab
  }
}

function canTriggerDownload(operation: string): boolean {
  return operation === 'browser.navigate'
    || operation === 'browser.click'
    || operation === 'browser.press'
    || operation === 'browser.siteTool'
}

function selectionFrom(params: Record<string, unknown>): BrowserSelection {
  const mode = params.mode
  if (mode !== 'auto' && mode !== 'target' && mode !== 'tab') throw new Error('Browser selection mode is invalid')
  return {
    mode,
    ...(typeof params.targetId === 'string' && params.targetId.trim() ? { targetId: params.targetId.trim() } : {}),
    ...(tabString(params.tabId) ? { tabId: tabString(params.tabId)! } : {}),
  }
}

function tabString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return String(value)
  return undefined
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384) throw new Error(`Browser ${label} is required`)
  return value.trim()
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`Browser ${label} is invalid`)
  return value
}

function finite(value: unknown): number {
  const result = Number(value ?? 0)
  if (!Number.isFinite(result) || Math.abs(result) > 1_000_000) throw new Error('Browser numeric argument is invalid')
  return result
}

function origin(value: string): string | undefined {
  try {
    const parsed = new URL(value)
    return parsed.origin === 'null' ? undefined : parsed.origin
  } catch {
    return undefined
  }
}

function toolDetail(tool: BrowserSiteToolDescriptor): string {
  return [tool.name, tool.title, tool.description, tool.annotations?.consequentialHint ? 'consequential' : '']
    .filter(Boolean)
    .join(' ')
    .slice(0, 2_000)
}

/** Credentials belong to the profile that owns the tab, not the active one. */
function builtinProfileRecordId(tab: BrowserTabDescriptor): string | undefined {
  if (tab.targetId !== 'builtin' || !tab.profileId.startsWith('builtin:')) return undefined
  return tab.profileId.slice('builtin:'.length)
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
