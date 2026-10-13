/**
 * ND Disk Cleaner — pure sunburst/layout helpers for the shipped web view.
 *
 * Runs inside ND's sandboxed iframe with no Node and no network. This module
 * holds no DOM and no bridge calls, so the exact artifact the UI runs is
 * unit-tested straight from the repository.
 *
 * Delivered tree nodes come from nd-core's pruned scan: `{ n, s, k, c?, count? }`
 * where `k` is 0 for a directory, 1 for a file, and 2 for the aggregate
 * "(other)" bucket of everything that did not fit. `k: 2` nodes are
 * informational only — they name no real path and are never actionable.
 */

/** Bytes as a compact human string: "812 B", "4.5 MB", "1.2 GB". */
export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0
  if (value < 1024) return `${Math.round(value)} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let size = value
  let unit = 'B'
  for (const candidate of units) {
    size /= 1024
    unit = candidate
    if (size < 1024) break
  }
  const decimals = size >= 100 ? 0 : size >= 10 ? 1 : 2
  return `${size.toFixed(decimals)} ${unit}`
}

/** Aggregate buckets report how many entries they hide. */
export function otherCount(node) {
  return node && node.k === 2 ? Math.max(0, node.count ?? 0) : 0
}

/** Only real files and directories name a path; aggregate buckets do not. */
export function isActionable(node) {
  return Boolean(node) && (node.k === 0 || node.k === 1)
}

/**
 * The absolute path of a delivered node, rebuilt from the scan root plus the
 * names walked down to it. The host re-validates every path it receives; this
 * is only how the frame names what the user pointed at.
 */
export function absolutePath(rootPath, names) {
  if (!rootPath || !Array.isArray(names) || names.length === 0) return null
  const root = String(rootPath).replace(/[/\\]+$/, '')
  return `${root}/${names.map((name) => String(name)).join('/')}`
}

function childList(node) {
  return node && Array.isArray(node.c) ? node.c : []
}

function segmentSum(segments) {
  return segments.reduce((total, segment) => total + segment.size, 0)
}

/**
 * Two concentric rings around the focus node: its children on the inner ring,
 * and those children's own children on the outer ring. Siblings tile their
 * parent's sweep exactly, proportional to size, so a chart never shows gaps —
 * whatever the parent carries beyond its delivered children is already inside
 * the "(other)" bucket nd-core delivers.
 *
 * Angles start at 12 o'clock and run clockwise. Returns flat segments with
 * absolute names so the caller can zoom, select, and rebuild paths.
 */
export function layoutArcs(focusNode, focusNames = []) {
  const segments = []
  const inner = childList(focusNode)
  const innerTotal = Math.max(1, segmentSum(inner.map((node) => ({ size: node.s }))))
  let angle = -Math.PI / 2
  for (const node of inner) {
    const sweep = (node.s / innerTotal) * Math.PI * 2
    const names = [...focusNames, node.n]
    segments.push({ node, names, depth: 0, startAngle: angle, endAngle: angle + sweep })
    angle += sweep
  }
  for (const parent of segments) {
    const outer = childList(parent.node)
    const outerTotal = Math.max(1, outer.reduce((total, node) => total + node.s, 0))
    const span = parent.endAngle - parent.startAngle
    let outerAngle = parent.startAngle
    for (const node of outer) {
      const sweep = (node.s / outerTotal) * span
      segments.push({
        node,
        names: [...parent.names, node.n],
        depth: 1,
        startAngle: outerAngle,
        endAngle: outerAngle + sweep,
      })
      outerAngle += sweep
    }
  }
  return segments
}

/** Normalize an angle into [base, base + 2π). */
function normalizeAngle(angle, base) {
  const twoPi = Math.PI * 2
  let value = angle
  while (value < base) value += twoPi
  while (value >= base + twoPi) value -= twoPi
  return value
}

/** The segment covering an angle at a ring depth, or null on a miss. */
export function hitTestArc(segments, angle, depth) {
  for (const segment of segments) {
    if (segment.depth !== depth) continue
    const value = normalizeAngle(angle, segment.startAngle)
    if (value >= segment.startAngle && value < segment.endAngle) return segment
  }
  return null
}

/**
 * The sortable list under the focus node: delivered children in size order,
 * each with the absolute path it can act on (null for aggregate buckets).
 */
export function childRows(focusNode, rootPath, focusNames) {
  return childList(focusNode).map((node) => ({
    name: node.n,
    size: node.s,
    kind: node.k === 2 ? 'other' : node.k === 1 ? 'file' : 'dir',
    count: otherCount(node),
    path: isActionable(node) ? absolutePath(rootPath, [...focusNames, node.n]) : null,
  }))
}

/** Resolve the node at a names path from the delivered root, or null. */
export function nodeAtPath(rootNode, names) {
  let node = rootNode
  for (const name of names) {
    node = childList(node).find((child) => child.n === name)
    if (!node) return null
  }
  return node
}

/**
 * Remove a delivered node at `names` from the local tree after the host
 * trashed it, subtracting its size from every ancestor so the chart's totals
 * stay honest without a rescan. Returns false when the node is not there.
 */
export function removeNodeAt(rootNode, names) {
  if (names.length === 0) return false
  const parentNames = names.slice(0, -1)
  const leafName = names[names.length - 1]
  const parent = nodeAtPath(rootNode, parentNames)
  if (!parent) return false
  const children = childList(parent)
  const index = children.findIndex((child) => child.n === leafName)
  if (index < 0) return false
  const [removed] = children.splice(index, 1)
  const delta = removed ? removed.s : 0
  let node = rootNode
  node.s = Math.max(0, node.s - delta)
  for (const name of parentNames) {
    node = childList(node).find((child) => child.n === name)
    if (!node) break
    node.s = Math.max(0, node.s - delta)
  }
  return true
}
