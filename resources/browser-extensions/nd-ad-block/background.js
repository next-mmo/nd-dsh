/**
 * ND Ad Block - rule set activation.
 *
 * Electron loads this package but does not honour `enabled: true` on the
 * declarative rule resources in the manifest, so the rule sets arrive disabled
 * and nothing is blocked. Enabling them here is what makes the shipped default
 * actually take effect. The call is idempotent and cheap, so it runs on every
 * worker start as well as on install.
 */
const RULESET_IDS = ['nd_ads', 'nd_youtube']

const activate = async () => {
  try {
    const enabled = await chrome.declarativeNetRequest.getEnabledRulesets()
    const missing = RULESET_IDS.filter((id) => !enabled.includes(id))
    if (missing.length === 0) return
    await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: missing })
  } catch {
    // Activation is retried on the next worker start.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void activate()
})

chrome.runtime.onStartup.addListener(() => {
  void activate()
})

void activate()
