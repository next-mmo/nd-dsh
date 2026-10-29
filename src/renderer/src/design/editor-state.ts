import {
  createDesignId,
  type DesignDocument,
  type DesignNode,
} from '../../../shared/nd-design/index.js'
import type { DesignBounds, DesignPoint } from './viewport.js'
import { normalizeDragBounds } from './viewport.js'

export type DesignTool = 'select' | 'frame' | 'rect' | 'ellipse' | 'line' | 'text' | 'image' | 'hand'

export interface DesignLayerRow {
  node: DesignNode
  depth: number
  parentId: string | null
}

export function flattenDesignLayers(document: DesignDocument): DesignLayerRow[] {
  const rows: DesignLayerRow[] = []
  const visit = (id: string, depth: number, parentId: string | null): void => {
    const node = document.nodes[id]
    if (!node) return
    rows.push({ node, depth, parentId })
    for (const child of node.children ?? []) visit(child, depth + 1, id)
  }
  for (const id of document.pages[0]?.children ?? []) visit(id, 0, null)
  return rows
}

export function selectionDesignBounds(document: DesignDocument, ids: string[]): DesignBounds | null {
  const nodes = ids.map((id) => document.nodes[id]).filter((node): node is DesignNode => Boolean(node))
  if (nodes.length === 0) return null
  const bounds = nodes.map((node) => ({ x: node.x, y: node.y, width: node.width, height: node.height }))
  const minX = Math.min(...bounds.map((item) => item.x))
  const minY = Math.min(...bounds.map((item) => item.y))
  const maxX = Math.max(...bounds.map((item) => item.x + item.width))
  const maxY = Math.max(...bounds.map((item) => item.y + item.height))
  return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) }
}

export function selectionRoots(document: DesignDocument, ids: string[]): string[] {
  const selected = new Set(ids.filter((id) => Boolean(document.nodes[id])))
  return [...selected].filter((id) => {
    let current = parentDesignNode(document, id)
    while (current) {
      if (selected.has(current.id)) return false
      current = parentDesignNode(document, current.id)
    }
    return true
  })
}

export function parentDesignNode(document: DesignDocument, id: string): DesignNode | null {
  for (const node of Object.values(document.nodes)) {
    if (node.children?.includes(id)) return node
  }
  return null
}

export function descendantDesignIds(document: DesignDocument, id: string): string[] {
  const result: string[] = []
  const stack = [...(document.nodes[id]?.children ?? [])]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop()!
    if (seen.has(current)) continue
    seen.add(current)
    result.push(current)
    stack.push(...(document.nodes[current]?.children ?? []))
  }
  return result
}

export function createNodeForTool(tool: DesignTool, start: DesignPoint, end: DesignPoint): DesignNode | null {
  if (tool === 'text') {
    return {
      id: createDesignId('text'),
      type: 'text',
      name: 'Text',
      x: end.x,
      y: end.y,
      width: 240,
      height: 44,
      text: 'Text',
      fontFamily: 'Inter',
      fontSize: 18,
      fontWeight: 500,
      lineHeight: 1.3,
      letterSpacing: 0,
      align: 'left',
      color: '#18181b',
    }
  }
  if (tool === 'image') {
    return {
      id: createDesignId('image'),
      type: 'image',
      name: 'Image',
      x: end.x,
      y: end.y,
      width: 320,
      height: 200,
      src: '',
      fit: 'cover',
    }
  }
  const bounds = normalizeDragBounds(start, end)
  if (tool === 'line') {
    const x = start.x
    const y = start.y
    const width = Math.abs(end.x - start.x)
    const height = Math.abs(end.y - start.y)
    if (width < 1 && height < 1) return null
    return {
      id: createDesignId('line'),
      type: 'line',
      name: 'Line',
      x,
      y,
      width,
      height,
      stroke: { color: '#52525b', width: 2 },
    }
  }
  if (bounds.width < 1 || bounds.height < 1) return null
  if (tool === 'frame') {
    return {
      id: createDesignId('frame'),
      type: 'frame',
      name: 'Frame',
      ...bounds,
      fill: { type: 'solid', color: '#ffffff' },
      stroke: { color: '#d4d4d8', width: 1 },
      children: [],
      clip: true,
    }
  }
  if (tool === 'ellipse') {
    return {
      id: createDesignId('ellipse'),
      type: 'ellipse',
      name: 'Ellipse',
      ...bounds,
      fill: { type: 'solid', color: '#dbeafe' },
      stroke: { color: '#93c5fd', width: 1 },
    }
  }
  if (tool === 'rect') {
    return {
      id: createDesignId('rect'),
      type: 'rect',
      name: 'Rectangle',
      ...bounds,
      fill: { type: 'solid', color: '#e4e4e7' },
      stroke: { color: '#a1a1aa', width: 1 },
    }
  }
  return null
}

export function nextDesignName(document: DesignDocument, type: DesignNode['type']): string {
  const prefix = type === 'rect' ? 'Rectangle' : type === 'ellipse' ? 'Ellipse' : type === 'line' ? 'Line' : type === 'text' ? 'Text' : type === 'image' ? 'Image' : type === 'frame' ? 'Frame' : 'Group'
  let index = 1
  for (const node of Object.values(document.nodes)) {
    if (node.name === `${prefix} ${index}`) index += 1
  }
  return `${prefix} ${index}`
}

export function hexColor(value: string | undefined, fallback = '#ffffff'): string {
  if (!value) return fallback
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (!match) return fallback
  const hex = match[1]!
  return hex.length === 3
    ? `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toLowerCase()
    : `#${hex}`.toLowerCase()
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
}
