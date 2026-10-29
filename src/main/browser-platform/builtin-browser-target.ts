import type { BrowserTargetDescriptor } from '../../shared/browser-platform.js'
import {
  BUILTIN_BROWSER_TARGET_ID,
  type BrowserController,
} from '../browser/browser-controller.js'
import type { BrowserTarget } from './browser-target.js'

export class BuiltinBrowserTarget implements BrowserTarget {
  constructor(private readonly browser: BrowserController) {}

  descriptor(): BrowserTargetDescriptor {
    const state = this.browser.state()
    return {
      id: BUILTIN_BROWSER_TARGET_ID,
      kind: 'builtin',
      label: 'ND Browser',
      profileId: this.browser.profileId(),
      profileLabel: this.browser.profileLabel(),
      connected: true,
      visible: state.visible,
      capabilities: {
        tabs: true,
        semanticDom: true,
        screenshots: true,
        downloads: true,
        uploads: false,
        history: true,
        credentials: true,
        extensions: true,
        siteTools: true,
        backgroundControl: true,
      },
    }
  }

  async listTabs() {
    return this.browser.listTabs()
  }

  async openTab(url?: string) {
    return this.browser.createTab(url ?? 'about:blank', true)
  }

  async activateTab(tabId: string) {
    return this.browser.activateTab(tabId)
  }

  async closeTab(tabId: string) {
    return this.browser.closeTab(tabId)
  }

  async snapshot(tabId: string) {
    return this.browser.semanticSnapshot(tabId)
  }

  async navigate(tabId: string, url: string) {
    return this.browser.navigate(url, tabId)
  }

  async back(tabId: string) {
    return this.browser.back(tabId)
  }

  async forward(tabId: string) {
    return this.browser.forward(tabId)
  }

  async reload(tabId: string) {
    return this.browser.reload(tabId)
  }

  async click(tabId: string, ref: string, revision: number) {
    return this.browser.click(tabId, ref, revision)
  }

  async fill(tabId: string, ref: string, revision: number, text: string) {
    return this.browser.fill(tabId, ref, revision, text)
  }

  async press(tabId: string, ref: string, revision: number, key: string) {
    return this.browser.press(tabId, ref, revision, key)
  }

  async scroll(tabId: string, deltaX: number, deltaY: number) {
    return this.browser.scroll(tabId, deltaX, deltaY)
  }

  async waitFor(tabId: string, input: { text?: string; urlIncludes?: string; timeoutMs?: number }) {
    return this.browser.waitFor(tabId, input)
  }

  async screenshot(tabId: string) {
    return this.browser.screenshot(tabId)
  }

  async discoverSiteTools(tabId: string) {
    return this.browser.discoverSiteTools(tabId)
  }

  async callSiteTool(tabId: string, name: string, input: unknown) {
    return this.browser.callSiteTool(tabId, name, input)
  }

  async autofillCredential(tabId: string, username: string, password: string) {
    return this.browser.autofillCredential(tabId, username, password)
  }
}
