import { DEFAULT_BROWSER_PROFILE_ID } from '../../shared/browser-platform.js'
import type { BrowserController } from '../browser/browser-controller.js'

/**
 * The identity a new web chat binds to: an explicit lane choice, otherwise the
 * profile the user is browsing as right now.
 */
export function createdProfileId(browser: BrowserController, explicit: string | undefined): string | undefined {
  return explicit ?? browser.activeProfileId?.()
}

/**
 * The profile a chat's browser tab must live in. A recorded identity wins when
 * its profile still exists; chats saved before browser profiles existed fall
 * back to the default profile, which still owns their historical sign-ins.
 */
export function sessionProfileId(browser: BrowserController, stored: string | undefined): string {
  if (stored && (browser.profileExists?.(stored) ?? true)) return stored
  return browser.defaultProfileId?.() ?? DEFAULT_BROWSER_PROFILE_ID
}
