import {
  createDesignId,
  ND_DESIGN_LIMITS,
  nowIso,
  type DesignDocument,
  type DesignNode,
} from './model.js'
import { validateDesignDocument } from './validate.js'

export type DesignCommand =
  | { op: 'insert'; parentId: string | null; index?: number; node: DesignNode; nodes?: DesignNode[] }
  | { op: 'update'; id: string; patch: Record<string, unknown> }
  | { op: 'delete'; ids: string[] }
  | { op: 'reorder'; id: string; parentId?: string | null; index: number }
  | { op: 'group'; ids: string[]; name?: string }
  | { op: 'ungroup'; id: string }

export interface DesignRestoreEntry {
  rootId: string
  nodes: DesignNode[]
  parentId: string | null
  pageId: string
  index: number
}

export type DesignInternalCommand =
  | { op: '_restore-nodes'; entries: DesignRestoreEntry[] }
  | {
      op: '_restore-structure'
      pages?: Record<string, string[]>
      children?: Record<string, string[]>
      nodes?: DesignNode[]
      removeIds?: string[]
    }

export type DesignAnyCommand = DesignCommand | DesignInternalCommand

export interface DesignApplyResult {
  document: DesignDocument
  inverse: DesignAnyCommand[]
  changedIds: string[]
  createdIds: string[]
  deletedIds: string[]
}

const PATCH_KEYS = new Set([
  'name', 'x', 'y', 'width', 'height', 'opacity', 'visible', 'locked', 'clip',
  'fill', 'stroke', 'cornerRadius', 'text', 'fontFamily', 'fontSize', 'fontWeight',
  'lineHeight', 'letterSpacing', 'align', 'color', 'src', 'fit',
])

const PATCH_REJECT = new Set(['id', 'type', 'children'])

export function applyDesignCommands(document: DesignDocument, commands: DesignCommand[]): DesignApplyResult {
  if (!Array.isArray(commands) || commands.length === 0) throw new Error('ND Pencil command batch is empty')
  if (commands.length > ND_DESIGN_LIMITS.maxCommandsPerBatch) {
    throw new Error(`ND Pencil command batch exceeds ${ND_DESIGN_LIMITS.maxCommandsPerBatch} commands`)
  }
  if (new TextEncoder().encode(JSON.stringify(commands)).length > ND_DESIGN_LIMITS.maxBatchBytes) {
    throw new Error('ND Pencil command batch is too large')
  }
  for (const command of commands) {
    if (command.op.startsWith('_')) throw new Error('Internal ND Pencil commands are not accepted from clients')
  }
  return applyCommands(document, commands, true)
}

export function applyDesignHistoryCommands(document: DesignDocument, commands: DesignAnyCommand[]): DesignDocument {
  return applyCommands(document, commands, false).document
}

function applyCommands(document: DesignDocument, commands: DesignAnyCommand[], generateInverse: boolean): DesignApplyResult {
  const draft = structuredClone(document)
  const inverse: DesignAnyCommand[] = []
  const changedIds = new Set<string>()
  const createdIds = new Set<string>()
  const deletedIds = new Set<string>()

  for (const command of commands) {
    switch (command.op) {
      case 'insert': {
        const parent = resolveParent(draft, command.parentId)
        const index = clampIndex(command.index ?? parent.children.length, parent.children.length)
        const nodes = command.nodes ? command.nodes : [command.node]
        if (!nodes.some((node) => node.id === command.node.id)) throw new Error('ND Pencil insert nodes must include the root node')
        if (nodes.length === 1 && (command.node.children?.length ?? 0) > 0) {
          throw new Error('ND Pencil insert must include descendant nodes when inserting a container with children')
        }
        const inserted = insertFlat(draft, command.node.id, nodes, parent, index)
        for (const id of inserted) {
          createdIds.add(id)
          changedIds.add(id)
        }
        if (generateInverse) inverse.push({ op: 'delete', ids: [command.node.id] })
        break
      }
      case 'update': {
        if (!isRecord(command.patch)) throw new Error('ND Pencil update patch must be an object')
        const node = draft.nodes[command.id]
        if (!node) throw new Error(`ND Pencil node not found: ${command.id}`)
        const old: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(command.patch)) {
          if (PATCH_REJECT.has(key)) throw new Error(`ND Pencil update cannot change ${key}`)
          if (!PATCH_KEYS.has(key)) throw new Error(`ND Pencil update cannot change unknown field ${key}`)
          const record = node as unknown as Record<string, unknown>
          old[key] = record[key] === undefined ? null : structuredClone(record[key])
        }
        applyPatch(draft, node, command.patch)
        changedIds.add(node.id)
        if (node.children) {
          for (const id of collectSubtreeIds(draft, node.id)) changedIds.add(id)
        }
        if (generateInverse) inverse.push({ op: 'update', id: node.id, patch: old })
        break
      }
      case 'delete': {
        const requested = new Set(uniqueIds(command.ids))
        const roots = [...requested].filter((id) => !hasRequestedAncestor(draft, id, requested))
        const entries: DesignRestoreEntry[] = []
        for (const id of roots) {
          const node = draft.nodes[id]
          if (!node) continue
          const parent = findParent(draft, id)
          if (!parent) continue
          const ids = collectSubtreeIds(draft, id)
          entries.push({
            rootId: id,
            nodes: ids.map((nodeId) => structuredClone(draft.nodes[nodeId]!)).filter(Boolean),
            parentId: parent.parentId,
            pageId: parent.pageId,
            index: parent.index,
          })
          parent.siblings.splice(parent.index, 1)
          for (const removedId of ids) {
            delete draft.nodes[removedId]
            changedIds.add(removedId)
            deletedIds.add(removedId)
          }
        }
        entries.sort(compareRestoreEntries)
        if (generateInverse && entries.length > 0) inverse.push({ op: '_restore-nodes', entries })
        break
      }
      case 'reorder': {
        const node = draft.nodes[command.id]
        if (!node) throw new Error(`ND Pencil node not found: ${command.id}`)
        const from = findParent(draft, command.id)
        if (!from) throw new Error(`ND Pencil node has no parent: ${command.id}`)
        const target = resolveParent(draft, command.parentId === undefined ? from.parentId : command.parentId)
        if (isDescendant(draft, target.parentId ?? undefined, command.id)) throw new Error('ND Pencil cannot move a node into its own descendant')
        from.siblings.splice(from.index, 1)
        target.children.splice(clampIndex(command.index, target.children.length), 0, command.id)
        changedIds.add(command.id)
        if (generateInverse) inverse.push({ op: 'reorder', id: command.id, parentId: from.parentId, index: from.index })
        break
      }
      case 'group': {
        const ids = uniqueIds(command.ids)
        if (ids.length === 0) throw new Error('ND Pencil group requires at least one node')
        const parents = ids.map((id) => findParent(draft, id))
        if (parents.some((parent) => !parent)) throw new Error('ND Pencil group node not found')
        const first = parents[0]!
        if (parents.some((parent) => !parent || parent.parentId !== first.parentId || parent.pageId !== first.pageId)) {
          throw new Error('ND Pencil group requires nodes with the same parent')
        }
        const ordered = ids
          .map((id, index) => ({ id, parent: parents[index]! }))
          .sort((left, right) => left.parent.index - right.parent.index)
        const bounds = ordered.reduce(
          (acc, item) => {
            const node = draft.nodes[item.id]!
            return {
              x: Math.min(acc.x, node.x),
              y: Math.min(acc.y, node.y),
              right: Math.max(acc.right, node.x + node.width),
              bottom: Math.max(acc.bottom, node.y + node.height),
            }
          },
          { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, right: Number.NEGATIVE_INFINITY, bottom: Number.NEGATIVE_INFINITY },
        )
        const groupId = createDesignId('group')
        const group: DesignNode = {
          id: groupId,
          type: 'group',
          name: command.name?.trim() || 'Group',
          x: bounds.x,
          y: bounds.y,
          width: Math.max(0, bounds.right - bounds.x),
          height: Math.max(0, bounds.bottom - bounds.y),
          children: ordered.map((item) => item.id),
        }
        const parent = first
        const oldChildren = [...parent.siblings]
        parent.siblings.splice(0, parent.siblings.length, ...oldChildren.filter((id) => !ids.includes(id)))
        const groupIndex = Math.min(...ordered.map((item) => item.parent.index))
        parent.siblings.splice(clampIndex(groupIndex, parent.siblings.length), 0, groupId)
        draft.nodes[groupId] = group
        createdIds.add(groupId)
        changedIds.add(groupId)
        for (const id of ids) changedIds.add(id)
        if (generateInverse) {
          inverse.push({
            op: '_restore-structure',
            ...(parent.parentId ? { children: { [parent.parentId]: oldChildren } } : { pages: { [parent.pageId]: oldChildren } }),
            removeIds: [groupId],
          })
        }
        break
      }
      case 'ungroup': {
        const group = draft.nodes[command.id]
        if (!group || group.type !== 'group') throw new Error(`ND Pencil group not found: ${command.id}`)
        const parent = findParent(draft, command.id)
        if (!parent) throw new Error('ND Pencil group has no parent')
        const oldChildren = [...parent.siblings]
        const children = group.children ?? []
        parent.siblings.splice(parent.index, 1, ...children)
        delete draft.nodes[command.id]
        changedIds.add(command.id)
        for (const id of children) changedIds.add(id)
        if (generateInverse) {
          inverse.push({
            op: '_restore-structure',
            ...(parent.parentId ? { children: { [parent.parentId]: oldChildren } } : { pages: { [parent.pageId]: oldChildren } }),
            nodes: [structuredClone(group)],
          })
        }
        break
      }
      case '_restore-nodes': {
        const entries = [...command.entries].sort(compareRestoreEntries)
        for (const entry of entries) {
          if (entry.nodes.some((node) => draft.nodes[node.id])) throw new Error(`ND Pencil restore target already exists: ${entry.rootId}`)
          const parent = resolveParent(draft, entry.parentId, entry.pageId)
          insertFlat(draft, entry.rootId, entry.nodes, parent, clampIndex(entry.index, parent.children.length))
        }
        break
      }
      case '_restore-structure': {
        for (const node of command.nodes ?? []) {
          if (draft.nodes[node.id]) throw new Error(`ND Pencil restore target already exists: ${node.id}`)
          draft.nodes[node.id] = structuredClone(node)
        }
        for (const [pageId, children] of Object.entries(command.pages ?? {})) {
          const page = draft.pages.find((item) => item.id === pageId)
          if (!page) throw new Error(`ND Pencil page not found: ${pageId}`)
          page.children = [...children]
        }
        for (const [nodeId, children] of Object.entries(command.children ?? {})) {
          const node = draft.nodes[nodeId]
          if (!node || (node.type !== 'frame' && node.type !== 'group')) throw new Error(`ND Pencil container not found: ${nodeId}`)
          node.children = [...children]
        }
        for (const id of command.removeIds ?? []) delete draft.nodes[id]
        break
      }
      default:
        throw new Error(`Unknown ND Pencil command: ${(command as { op?: string }).op ?? 'unknown'}`)
    }
  }

  draft.updatedAt = nowIso()
  const validated = validateDesignDocument(draft)
  return {
    document: validated,
    inverse,
    changedIds: [...changedIds],
    createdIds: [...createdIds],
    deletedIds: [...deletedIds],
  }
}

function resolveParent(
  document: DesignDocument,
  parentId: string | null | undefined,
  pageId?: string,
): { parentId: string | null; pageId: string; children: string[]; siblings: string[] } {
  const page = pageId ? document.pages.find((item) => item.id === pageId) : document.pages[0]
  if (!page) throw new Error('ND Pencil document has no page')
  if (parentId === null || parentId === undefined) {
    return { parentId: null, pageId: page.id, children: page.children, siblings: page.children }
  }
  const node = document.nodes[parentId]
  if (!node) throw new Error(`ND Pencil parent not found: ${parentId}`)
  if (node.type !== 'frame' && node.type !== 'group') throw new Error(`ND Pencil parent is not a container: ${parentId}`)
  const children = node.children ?? (node.children = [])
  return { parentId, pageId: page.id, children, siblings: children }
}

function findParent(
  document: DesignDocument,
  id: string,
): { parentId: string | null; pageId: string; index: number; siblings: string[] } | null {
  for (const page of document.pages) {
    const index = page.children.indexOf(id)
    if (index >= 0) return { parentId: null, pageId: page.id, index, siblings: page.children }
  }
  for (const node of Object.values(document.nodes)) {
    if (node.type !== 'frame' && node.type !== 'group') continue
    const children = node.children ?? []
    const index = children.indexOf(id)
    if (index >= 0) {
      const page = document.pages.find((item) => isReachable(document, item.children, node.id)) ?? document.pages[0]
      if (!page) return null
      return { parentId: node.id, pageId: page.id, index, siblings: children }
    }
  }
  return null
}

function hasRequestedAncestor(document: DesignDocument, id: string, requested: Set<string>): boolean {
  let current = id
  const seen = new Set<string>()
  while (!seen.has(current)) {
    seen.add(current)
    const parent = findParent(document, current)
    if (!parent?.parentId) return false
    if (requested.has(parent.parentId)) return true
    current = parent.parentId
  }
  return false
}

function isReachable(document: DesignDocument, roots: string[], targetId: string): boolean {
  const stack = [...roots]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === targetId) return true
    if (seen.has(id)) continue
    seen.add(id)
    const node = document.nodes[id]
    if (node?.children) stack.push(...node.children)
  }
  return false
}

function isDescendant(document: DesignDocument, parentId: string | undefined, id: string): boolean {
  if (!parentId) return false
  if (parentId === id) return true
  const stack = [...(document.nodes[parentId]?.children ?? [])]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === id) return true
    if (seen.has(current)) continue
    seen.add(current)
    const node = document.nodes[current]
    if (node?.children) stack.push(...node.children)
  }
  return false
}

function insertFlat(
  document: DesignDocument,
  rootId: string,
  nodes: DesignNode[],
  parent: { children: string[]; parentId: string | null; pageId: string },
  index: number,
): string[] {
  if (nodes.length === 0) throw new Error('ND Pencil insert requires at least one node')
  if (nodes.length > ND_DESIGN_LIMITS.maxSubtreeNodes) throw new Error('ND Pencil inserted subtree is too large')
  const map = new Map<string, DesignNode>()
  for (const node of nodes) {
    if (document.nodes[node.id]) throw new Error(`ND Pencil node already exists: ${node.id}`)
    if (map.has(node.id)) throw new Error(`ND Pencil inserted subtree contains a duplicate node: ${node.id}`)
    map.set(node.id, structuredClone(node))
  }
  const root = map.get(rootId)
  if (!root) throw new Error(`ND Pencil inserted subtree is missing its root: ${rootId}`)
  for (const node of map.values()) {
    for (const childId of node.children ?? []) {
      if (!map.has(childId) && !document.nodes[childId]) {
        throw new Error(`ND Pencil inserted container references a missing child: ${childId}`)
      }
    }
  }
  const ids: string[] = []
  for (const [id, node] of map) {
    document.nodes[id] = node
    ids.push(id)
  }
  parent.children.splice(clampIndex(index, parent.children.length), 0, rootId)
  return ids
}

function applyPatch(document: DesignDocument, node: DesignNode, patch: Record<string, unknown>): void {
  const record = node as unknown as Record<string, unknown>
  let dx = 0
  let dy = 0
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'x' || key === 'y') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`ND Pencil ${key} must be a finite number`)
      if (key === 'x') dx = value - node.x
      else dy = value - node.y
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete record[key]
    else record[key] = structuredClone(value)
  }
  if ((node.type === 'frame' || node.type === 'group') && (dx !== 0 || dy !== 0)) {
    for (const childId of collectSubtreeIds(document, node.id)) {
      if (childId === node.id) continue
      const child = document.nodes[childId]
      if (!child) continue
      child.x += dx
      child.y += dy
    }
  }
}

function collectSubtreeIds(document: DesignDocument, rootId: string): string[] {
  const result: string[] = []
  const stack = [rootId]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
    const node = document.nodes[id]
    if (node?.children) stack.push(...node.children)
  }
  return result
}

function compareRestoreEntries(left: DesignRestoreEntry, right: DesignRestoreEntry): number {
  if (left.pageId !== right.pageId) return left.pageId.localeCompare(right.pageId)
  if (left.parentId !== right.parentId) return String(left.parentId).localeCompare(String(right.parentId))
  return left.index - right.index
}

function uniqueIds(ids: string[]): string[] {
  if (!Array.isArray(ids)) throw new Error('ND Pencil ids must be an array')
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]
}

function clampIndex(value: number, length: number): number {
  return Math.max(0, Math.min(Math.floor(value), length))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
