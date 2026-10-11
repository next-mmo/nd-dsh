/**
 * ND Ad Block - toolbar popup.
 *
 * Reports only what the extension can actually observe: which rule sets the
 * browser has enabled, how many rules they hold, how many ad breaks were ended
 * on the current page, and how many ad entries were stripped from YouTube's
 * data. There is no per-request counter because Chrome exposes rule-match
 * telemetry only to unpacked developer builds.
 */
const STORAGE_KEY = 'ndAdBlockTotals'

const text = (id, value) => {
  const node = document.getElementById(id)
  if (node) node.textContent = value
}

const readRuleCounts = async () => {
  const [enabled, rulesets] = await Promise.all([
    chrome.declarativeNetRequest.getEnabledRulesets(),
    Promise.resolve(chrome.runtime.getManifest().declarative_net_request?.rule_resources ?? []),
  ])
  let rules = 0
  for (const ruleset of rulesets) {
    if (!enabled.includes(ruleset.id)) continue
    try {
      const response = await fetch(chrome.runtime.getURL(ruleset.path))
      const parsed = await response.json()
      if (Array.isArray(parsed)) rules += parsed.length
    } catch {
      // A ruleset that cannot be read simply is not counted.
    }
  }
  return { enabled, rules }
}

const main = async () => {
  try {
    const { enabled, rules } = await readRuleCounts()
    const active = enabled.length > 0
    document.getElementById('dot')?.classList.toggle('off', !active)
    text('state', active ? 'On' : 'Off')
    text('rulesets', active ? enabled.join(', ') : 'none')
    text('rules', active ? String(rules) : '—')
  } catch (cause) {
    text('state', 'Unavailable')
    text('note', String(cause && cause.message ? cause.message : cause))
  }

  chrome.storage.local.get(STORAGE_KEY, (state) => {
    if (chrome.runtime.lastError) return
    const totals = state && state[STORAGE_KEY] ? state[STORAGE_KEY] : undefined
    // Two distinct numbers, never merged: ad breaks are what the user would
    // have sat through; stripped entries are placements removed from data.
    text('adBreaks', totals && totals.adBreaks ? String(totals.adBreaks) : '0')
    text('pruned', totals && totals.pruned ? String(totals.pruned) : '0')
  })

  text('note', 'Turn ND Ad Block off in Settings → Browser → Extensions.')
}

void main()
