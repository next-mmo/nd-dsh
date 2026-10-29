import type { DesignDocument, DesignNode } from './model.js'
import { pageBounds } from './svg.js'

export interface DesignBuildSpec {
  kind: 'nd-pencil-build-spec'
  version: 2
  document: { id: string; name: string; updatedAt: string }
  page: { name: string; bounds: { x: number; y: number; width: number; height: number } }
  selection: string[]
  nodes: DesignSpecNode[]
  migratedFrom?: string
  dropped?: Record<string, number>
}

export interface DesignSpecNode {
  id: string
  parentId: string | null
  depth: number
  type: DesignNode['type']
  name: string
  x: number
  y: number
  width: number
  height: number
  opacity?: number
  visible?: boolean
  children?: string[]
  fill?: string
  stroke?: { color: string; width: number }
  cornerRadius?: number
  text?: string
  fontFamily?: string
  fontSize?: number
  fontWeight?: number
  lineHeight?: number
  align?: string
  color?: string
  src?: string
  fit?: string
}

export function buildDesignSpec(document: DesignDocument, selection: string[] = []): DesignBuildSpec {
  const page = document.pages[0]
  if (!page) throw new Error('ND Pencil document has no page')
  const nodes: DesignSpecNode[] = []
  const visit = (id: string, parentId: string | null, depth: number): void => {
    const node = document.nodes[id]
    if (!node || depth > 64) return
    nodes.push(specNode(node, parentId, depth))
    for (const child of node.children ?? []) visit(child, id, depth + 1)
  }
  for (const id of page.children) visit(id, null, 1)
  const migration = document.meta?.migration
  return {
    kind: 'nd-pencil-build-spec',
    version: 2,
    document: { id: document.id, name: document.name, updatedAt: document.updatedAt },
    page: { name: page.name, bounds: pageBounds(document) },
    selection: selection.filter((id) => Boolean(document.nodes[id])),
    nodes,
    ...(migration ? { migratedFrom: migration.from, dropped: migration.dropped } : {}),
  }
}

export function serializeDesignSpec(document: DesignDocument, selection: string[] = []): string {
  return `${JSON.stringify(buildDesignSpec(document, selection), null, 2)}\n`
}

function specNode(node: DesignNode, parentId: string | null, depth: number): DesignSpecNode {
  return {
    id: node.id,
    parentId,
    depth,
    type: node.type,
    name: node.name,
    x: round(node.x),
    y: round(node.y),
    width: round(node.width),
    height: round(node.height),
    ...(node.opacity !== undefined ? { opacity: node.opacity } : {}),
    ...(node.visible === false ? { visible: false } : {}),
    ...(node.children ? { children: [...node.children] } : {}),
    ...(node.fill ? { fill: node.fill.color } : {}),
    ...(node.stroke ? { stroke: { ...node.stroke } } : {}),
    ...(node.cornerRadius !== undefined ? { cornerRadius: node.cornerRadius } : {}),
    ...(node.text !== undefined ? { text: node.text.slice(0, 20_000) } : {}),
    ...(node.fontFamily ? { fontFamily: node.fontFamily } : {}),
    ...(node.fontSize !== undefined ? { fontSize: node.fontSize } : {}),
    ...(node.fontWeight !== undefined ? { fontWeight: node.fontWeight } : {}),
    ...(node.lineHeight !== undefined ? { lineHeight: node.lineHeight } : {}),
    ...(node.align ? { align: node.align } : {}),
    ...(node.color ? { color: node.color } : {}),
    ...(node.src ? { src: node.src.slice(0, 500) } : {}),
    ...(node.fit ? { fit: node.fit } : {}),
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
