/** Pure helpers kept importable by Node tests and the sandboxed web view. */

export function selectionValue(appId, windowId) {
  return `${appId}\u0000${windowId}`
}

export function parseSelection(value) {
  if (typeof value !== 'string') return null
  const separator = value.indexOf('\u0000')
  if (separator <= 0 || separator === value.length - 1) return null
  return { app: value.slice(0, separator), windowId: value.slice(separator + 1) }
}

export function windowLabel(window, index) {
  const title = typeof window?.title === 'string' ? window.title.trim() : ''
  const suffix = window?.focused ? ' · focused' : window?.minimized ? ' · minimized' : ''
  return `${title || `Window ${index + 1}`}${suffix}`
}

export function describeState(state) {
  if (!state || typeof state !== 'object') return 'No state read yet.'
  const title = typeof state.window?.title === 'string' && state.window.title.trim()
    ? state.window.title.trim()
    : state.window?.id || 'Window'
  const mode = state.textMode === 'diff' ? 'diff' : state.textMode === 'full' ? 'full tree' : 'no text'
  const nodes = Number.isFinite(state.stats?.nodes) ? `${state.stats.nodes} nodes` : '0 nodes'
  const elapsed = Number.isFinite(state.stats?.elapsedMs) ? `${state.stats.elapsedMs} ms` : ''
  const diff = state.textMode === 'diff' && Number.isFinite(state.stats?.changed)
    ? `+${state.stats.added ?? 0} -${state.stats.removed ?? 0} ~${state.stats.changed}`
    : ''
  const truncated = state.stats?.truncated ? 'truncated' : ''
  const unavailable = state.screenshotUnavailable ? `screenshot unavailable (${state.screenshotUnavailable})` : ''
  return [title, mode, nodes, elapsed, diff, truncated, unavailable].filter(Boolean).join(' · ')
}

export function treeText(state) {
  if (!state?.accessibility) return state?.textMode === 'none' ? 'Accessibility text was not requested.' : 'No accessibility text is available for this window.'
  const tree = typeof state.accessibility.tree === 'string' ? state.accessibility.tree : ''
  const focused = typeof state.accessibility.focusedElement === 'string' ? state.accessibility.focusedElement.trim() : ''
  return [tree, focused ? `\nFocused: ${focused}` : ''].join('').trim() || 'The accessibility tree is empty.'
}

export function safeScreenshotUrl(state) {
  const url = state?.screenshots?.[0]?.url
  return typeof url === 'string' && url.startsWith('data:image/') ? url : ''
}
