/**
 * ND Ad Block - report bridge.
 *
 * Runs in the extension's isolated world on YouTube pages. The main-world
 * neutralizer cannot reach extension APIs, so it posts its real removal count
 * here and this script stores the total for the toolbar popup.
 */
const STORAGE_KEY = 'ndAdBlockTotals'

window.addEventListener('message', (event) => {
  const payload = event.data
  if (!event.source || event.source !== window) return
  if (!payload || payload.__ndAdBlock !== 'report') return
  const adBreaks = Number(payload.adBreaks)
  const pruned = Number(payload.pruned)
  if (!Number.isFinite(adBreaks) && !Number.isFinite(pruned)) return

  try {
    chrome.storage.local.get(STORAGE_KEY, (state) => {
      if (chrome.runtime.lastError) return
      const stored = state && state[STORAGE_KEY] ? state[STORAGE_KEY] : {}
      // Counts restart on every page load, so the stored value keeps the
      // highest a single page reached rather than a running sum.
      const totals = {
        adBreaks: Math.max(Number(stored.adBreaks) || 0, Number.isFinite(adBreaks) ? adBreaks : 0),
        pruned: Math.max(Number(stored.pruned) || 0, Number.isFinite(pruned) ? pruned : 0),
        lastUrl: typeof payload.url === 'string' ? payload.url.slice(0, 500) : (stored.lastUrl ?? ''),
        lastReportedAt: Date.now(),
      }
      chrome.storage.local.set({ [STORAGE_KEY]: totals })
    })
  } catch {
    // Reporting is best effort and must never disturb the page.
  }
})
