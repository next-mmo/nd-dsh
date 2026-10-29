/**
 * ND Pencil document model, version 2.
 *
 * Coordinates are absolute page coordinates. Frames and groups are logical
 * containers only; moving a container applies the delta to its descendants in
 * the command reducer. Keeping the scene flat removes nested transform bugs
 * and keeps agent-authored documents easy to inspect and validate.
 */
export const ND_DESIGN_FORMAT = 'nd-pencil' as const
export const ND_DESIGN_VERSION = 2 as const
export const ND_DESIGN_EXTENSION = '.op'

export const ND_DESIGN_LIMITS = {
  maxNodes: 20_000,
  maxDocumentBytes: 10 * 1024 * 1024,
  maxDepth: 32,
  maxSubtreeNodes: 5_000,
  maxCommandsPerBatch: 100,
  maxBatchBytes: 2 * 1024 * 1024,
  maxPageCount: 50,
  maxTextLength: 100_000,
  maxAssetBytes: 8 * 1024 * 1024,
  maxDocumentAssetBytes: 32 * 1024 * 1024,
} as const

export type DesignNodeType = 'frame' | 'group' | 'rect' | 'ellipse' | 'line' | 'text' | 'image'
export type DesignTextAlign = 'left' | 'center' | 'right'
export type DesignImageFit = 'cover' | 'contain' | 'fill'

export interface DesignPaint {
  type: 'solid'
  color: string
}

export interface DesignStroke {
  color: string
  width: number
}

export interface DesignNode {
  id: string
  type: DesignNodeType
  name: string
  x: number
  y: number
  width: number
  height: number
  opacity?: number
  visible?: boolean
  locked?: boolean
  /** Frame/group only: ordered child node ids. */
  children?: string[]
  /** Frame only: clip children to the frame bounds. */
  clip?: boolean
  fill?: DesignPaint
  stroke?: DesignStroke
  cornerRadius?: number
  /** Text only. */
  text?: string
  fontFamily?: string
  fontSize?: number
  fontWeight?: number
  lineHeight?: number
  letterSpacing?: number
  align?: DesignTextAlign
  color?: string
  /** Image only: workspace-relative asset path or data URL. */
  src?: string
  fit?: DesignImageFit
}

export interface DesignPage {
  id: string
  name: string
  children: string[]
}

export interface DesignMigrationReport {
  from: 'openpencil-0.8.4'
  dropped: Record<string, number>
  approximate: string[]
}

export interface DesignDocumentMeta {
  migration?: DesignMigrationReport
}

export interface DesignDocument {
  format: typeof ND_DESIGN_FORMAT
  version: typeof ND_DESIGN_VERSION
  id: string
  name: string
  createdAt: string
  updatedAt: string
  pages: DesignPage[]
  nodes: Record<string, DesignNode>
  meta?: DesignDocumentMeta
}

export interface DesignDocumentSummary {
  format: typeof ND_DESIGN_FORMAT
  version: typeof ND_DESIGN_VERSION
  id: string
  name: string
  updatedAt: string
  pageCount: number
  nodeCount: number
  migration?: DesignMigrationReport
}

export function createDesignId(prefix = 'n'): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function createEmptyDesignDocument(name = 'Untitled design', width = 1440, height = 900): DesignDocument {
  const now = nowIso()
  const page: DesignPage = { id: createDesignId('page'), name: 'Page 1', children: [] }
  const frame: DesignNode = {
    id: createDesignId('frame'),
    type: 'frame',
    name: 'Frame 1',
    x: 0,
    y: 0,
    width,
    height,
    fill: { type: 'solid', color: '#ffffff' },
    stroke: { color: '#d4d4d8', width: 1 },
    children: [],
    clip: true,
  }
  page.children.push(frame.id)
  return {
    format: ND_DESIGN_FORMAT,
    version: ND_DESIGN_VERSION,
    id: createDesignId('doc'),
    name,
    createdAt: now,
    updatedAt: now,
    pages: [page],
    nodes: { [frame.id]: frame },
  }
}

export function designDocumentSummary(document: DesignDocument): DesignDocumentSummary {
  return {
    format: document.format,
    version: document.version,
    id: document.id,
    name: document.name,
    updatedAt: document.updatedAt,
    pageCount: document.pages.length,
    nodeCount: Object.keys(document.nodes).length,
    ...(document.meta?.migration ? { migration: document.meta.migration } : {}),
  }
}

export function isContainerNode(node: DesignNode): boolean {
  return node.type === 'frame' || node.type === 'group'
}

export function isTextNode(node: DesignNode): boolean {
  return node.type === 'text'
}

export function isImageNode(node: DesignNode): boolean {
  return node.type === 'image'
}

export function nodeBounds(node: DesignNode): { x: number; y: number; width: number; height: number } {
  return {
    x: node.x,
    y: node.y,
    width: Math.max(0, node.width),
    height: Math.max(0, node.height),
  }
}
