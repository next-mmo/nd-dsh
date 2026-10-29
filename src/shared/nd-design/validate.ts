import { importLegacyDesignDocument, isLegacyDesignDocument } from './legacy.js'
import {
  ND_DESIGN_FORMAT,
  ND_DESIGN_LIMITS,
  ND_DESIGN_VERSION,
  type DesignDocument,
  type DesignImageFit,
  type DesignMigrationReport,
  type DesignNode,
  type DesignNodeType,
  type DesignPage,
  type DesignPaint,
  type DesignStroke,
  type DesignTextAlign,
} from './model.js'

export interface ParsedDesignDocument {
  document: DesignDocument
  legacy: boolean
  report?: DesignMigrationReport
}

const NODE_TYPES = new Set<DesignNodeType>(['frame', 'group', 'rect', 'ellipse', 'line', 'text', 'image'])
const TEXT_ALIGNS = new Set<DesignTextAlign>(['left', 'center', 'right'])
const IMAGE_FITS = new Set<DesignImageFit>(['cover', 'contain', 'fill'])
const COLOR_PATTERN = /^(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([^)]*\)|transparent)$/i
const IMAGE_SOURCE_PATTERN = /\.(?:png|jpe?g|webp|gif|svg)$/i
const DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,/i

export function parseDesignDocument(raw: string): ParsedDesignDocument {
  if (textByteLength(raw) > ND_DESIGN_LIMITS.maxDocumentBytes) {
    throw new Error(`ND Pencil document exceeds the ${Math.floor(ND_DESIGN_LIMITS.maxDocumentBytes / 1024 / 1024)} MB limit`)
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('ND Pencil document is not valid JSON')
  }
  return parseDesignValue(value)
}

export function parseDesignValue(value: unknown): ParsedDesignDocument {
  if (!isRecord(value)) throw new Error('ND Pencil document must be a JSON object')
  if (value.format === ND_DESIGN_FORMAT) {
    if (value.version !== ND_DESIGN_VERSION) {
      throw new Error(`Unsupported ND Pencil document version: ${String(value.version)}`)
    }
    return { document: validateDesignDocument(value), legacy: false }
  }
  if (!isLegacyDesignDocument(value)) {
    throw new Error('This file is not an ND Pencil document')
  }
  const imported = importLegacyDesignDocument(value)
  return { document: validateDesignDocument(imported.document), legacy: true, report: imported.report }
}

export function validateDesignDocument(value: unknown): DesignDocument {
  if (!isRecord(value)) throw new Error('ND Pencil document must be an object')
  if (value.format !== ND_DESIGN_FORMAT) throw new Error(`Unsupported ND Pencil format: ${String(value.format)}`)
  if (value.version !== ND_DESIGN_VERSION) throw new Error(`Unsupported ND Pencil document version: ${String(value.version)}`)

  const document = structuredClone(value) as unknown as DesignDocument
  document.id = requiredString(document.id, 'document id', 128)
  document.name = requiredString(document.name, 'document name', 200)
  document.createdAt = requiredString(document.createdAt, 'document createdAt', 64)
  document.updatedAt = requiredString(document.updatedAt, 'document updatedAt', 64)

  if (!Array.isArray(document.pages) || document.pages.length === 0) throw new Error('ND Pencil document must have at least one page')
  if (document.pages.length > ND_DESIGN_LIMITS.maxPageCount) throw new Error('ND Pencil document has too many pages')
  if (!isRecord(document.nodes)) throw new Error('ND Pencil document nodes must be an object')

  const pageIds = new Set<string>()
  const pages: DesignPage[] = []
  for (const rawPage of document.pages) {
    if (!isRecord(rawPage)) throw new Error('ND Pencil page must be an object')
    const id = requiredString(rawPage.id, 'page id', 128)
    if (pageIds.has(id)) throw new Error(`Duplicate ND Pencil page id: ${id}`)
    pageIds.add(id)
    const children = stringArray(rawPage.children, `page ${id} children`, ND_DESIGN_LIMITS.maxNodes)
    pages.push({ id, name: requiredString(rawPage.name, 'page name', 200), children })
  }
  document.pages = pages

  const nodeEntries = Object.entries(document.nodes)
  if (nodeEntries.length > ND_DESIGN_LIMITS.maxNodes) {
    throw new Error(`ND Pencil document exceeds ${ND_DESIGN_LIMITS.maxNodes} nodes`)
  }

  const nodes: Record<string, DesignNode> = {}
  for (const [key, rawNode] of nodeEntries) {
    const node = normalizeNode(key, rawNode)
    nodes[node.id] = node
  }
  document.nodes = nodes

  const seen = new Set<string>()
  const visit = (id: string, _parentId: string | null, depth: number): void => {
    if (depth > ND_DESIGN_LIMITS.maxDepth) throw new Error(`ND Pencil document nesting exceeds ${ND_DESIGN_LIMITS.maxDepth} levels`)
    if (seen.has(id)) throw new Error(`ND Pencil node is referenced more than once: ${id}`)
    const node = nodes[id]
    if (!node) throw new Error(`ND Pencil node reference is missing: ${id}`)
    seen.add(id)
    if (node.type === 'frame' || node.type === 'group') {
      for (const childId of node.children ?? []) visit(childId, id, depth + 1)
    }
  }
  for (const page of pages) {
    for (const childId of page.children) visit(childId, null, 1)
  }
  for (const id of Object.keys(nodes)) {
    if (!seen.has(id)) throw new Error(`ND Pencil node is not attached to a page: ${id}`)
  }

  if (document.meta !== undefined) {
    const meta = normalizeMeta(document.meta)
    if (meta) document.meta = meta
    else delete document.meta
  }
  const serialized = JSON.stringify(document)
  if (textByteLength(serialized) > ND_DESIGN_LIMITS.maxDocumentBytes) {
    throw new Error(`ND Pencil document exceeds the ${Math.floor(ND_DESIGN_LIMITS.maxDocumentBytes / 1024 / 1024)} MB limit`)
  }
  return document
}

export function serializeDesignDocument(document: DesignDocument): string {
  const serialized = `${JSON.stringify(document, null, 2)}\n`
  if (textByteLength(serialized) > ND_DESIGN_LIMITS.maxDocumentBytes) {
    throw new Error(`ND Pencil document exceeds the ${Math.floor(ND_DESIGN_LIMITS.maxDocumentBytes / 1024 / 1024)} MB limit`)
  }
  return serialized
}

export function isSafeImageSource(value: string): boolean {
  if (dataImageSource(value)) return textByteLength(value) <= ND_DESIGN_LIMITS.maxAssetBytes
  if (!value || value.length > 500) return false
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0') || value.includes('://')) return false
  if (/^[a-zA-Z]:/.test(value)) return false
  if (value.split('/').some((segment) => segment === '..')) return false
  return IMAGE_SOURCE_PATTERN.test(value)
}

export function isDataImageSource(value: string): boolean {
  return dataImageSource(value)
}

function dataImageSource(value: string): boolean {
  return DATA_IMAGE_PATTERN.test(value) && value.length > 32
}

function normalizeNode(key: string, value: unknown): DesignNode {
  if (!isRecord(value)) throw new Error(`ND Pencil node ${key} must be an object`)
  const id = requiredString(value.id, `node ${key} id`, 128)
  if (id !== key) throw new Error(`ND Pencil node map key ${key} does not match node id ${id}`)
  const type = value.type
  if (typeof type !== 'string' || !NODE_TYPES.has(type as DesignNodeType)) throw new Error(`ND Pencil node ${id} has an unsupported type`)
  const node: DesignNode = {
    id,
    type: type as DesignNodeType,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 200) : (type as string),
    x: finiteNumber(value.x, `node ${id} x`, -1_000_000, 1_000_000),
    y: finiteNumber(value.y, `node ${id} y`, -1_000_000, 1_000_000),
    width: finiteNumber(value.width, `node ${id} width`, 0, 1_000_000),
    height: finiteNumber(value.height, `node ${id} height`, 0, 1_000_000),
  }
  if (value.opacity !== undefined) node.opacity = finiteNumber(value.opacity, `node ${id} opacity`, 0, 1)
  if (value.visible === false) node.visible = false
  if (value.locked === true) node.locked = true

  if (type === 'frame' || type === 'group') {
    node.children = stringArray(value.children ?? [], `node ${id} children`, ND_DESIGN_LIMITS.maxNodes)
    if (type === 'frame' && value.clip === true) node.clip = true
  } else if (value.children !== undefined) {
    throw new Error(`ND Pencil node ${id} of type ${type} cannot have children`)
  }

  if (value.fill !== undefined) node.fill = paint(value.fill, `node ${id} fill`)
  if (value.stroke !== undefined) node.stroke = stroke(value.stroke, `node ${id} stroke`)
  if (value.cornerRadius !== undefined) node.cornerRadius = finiteNumber(value.cornerRadius, `node ${id} cornerRadius`, 0, 100_000)

  if (type === 'text') normalizeTextNode(node, value)
  else if (type === 'image') normalizeImageNode(node, value)
  else if (type === 'line' && node.stroke === undefined) node.stroke = { color: '#18181b', width: 1 }

  return node
}

function normalizeTextNode(node: DesignNode, value: Record<string, unknown>): void {
  node.text = requiredString(value.text, `node ${node.id} text`, ND_DESIGN_LIMITS.maxTextLength, true)
  node.fontFamily = optionalString(value.fontFamily, `node ${node.id} fontFamily`, 200) ?? 'Inter'
  node.fontSize = value.fontSize === undefined ? 16 : finiteNumber(value.fontSize, `node ${node.id} fontSize`, 1, 512)
  node.fontWeight = value.fontWeight === undefined ? 400 : finiteNumber(value.fontWeight, `node ${node.id} fontWeight`, 100, 900)
  node.lineHeight = value.lineHeight === undefined ? 1.3 : finiteNumber(value.lineHeight, `node ${node.id} lineHeight`, 0.5, 4)
  node.letterSpacing = value.letterSpacing === undefined ? 0 : finiteNumber(value.letterSpacing, `node ${node.id} letterSpacing`, -10, 100)
  node.align = value.align === undefined || value.align === 'left' ? 'left' : textAlign(value.align, `node ${node.id} align`)
  node.color = value.color === undefined ? '#18181b' : color(value.color, `node ${node.id} color`)
}

function normalizeImageNode(node: DesignNode, value: Record<string, unknown>): void {
  node.src = requiredString(value.src, `node ${node.id} src`, 8 * 1024 * 1024)
  if (!isSafeImageSource(node.src)) throw new Error(`ND Pencil image ${node.id} must use a workspace-relative image asset`)
  node.fit = value.fit === undefined ? 'cover' : imageFit(value.fit, `node ${node.id} fit`)
}

function paint(value: unknown, label: string): DesignPaint {
  if (!isRecord(value) || value.type !== 'solid') throw new Error(`${label} must be a solid paint`)
  return { type: 'solid', color: color(value.color, `${label} color`) }
}

function stroke(value: unknown, label: string): DesignStroke {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return {
    color: color(value.color, `${label} color`),
    width: finiteNumber(value.width, `${label} width`, 0, 100),
  }
}

function color(value: unknown, label: string): string {
  if (typeof value !== 'string' || !COLOR_PATTERN.test(value.trim())) throw new Error(`${label} must be a CSS color`)
  return value.trim()
}

function textAlign(value: unknown, label: string): DesignTextAlign {
  if (typeof value !== 'string' || !TEXT_ALIGNS.has(value as DesignTextAlign)) throw new Error(`${label} is invalid`)
  return value as DesignTextAlign
}

function imageFit(value: unknown, label: string): DesignImageFit {
  if (typeof value !== 'string' || !IMAGE_FITS.has(value as DesignImageFit)) throw new Error(`${label} is invalid`)
  return value as DesignImageFit
}

function normalizeMeta(value: unknown): DesignDocument['meta'] {
  if (!isRecord(value)) return undefined
  const migration = value.migration
  if (!isRecord(migration)) return undefined
  const dropped: Record<string, number> = {}
  if (isRecord(migration.dropped)) {
    for (const [key, count] of Object.entries(migration.dropped)) {
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) dropped[key.slice(0, 80)] = Math.floor(count)
    }
  }
  const approximate = Array.isArray(migration.approximate)
    ? migration.approximate.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 300)).slice(0, 100)
    : []
  return {
    migration: {
      from: 'openpencil-0.8.4',
      dropped,
      approximate,
    },
  }
}

function requiredString(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (!allowEmpty && !trimmed) throw new Error(`${label} cannot be empty`)
  if (value.length > max) throw new Error(`${label} is too long`)
  return value
}

function optionalString(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, label, max, true)
}

function stringArray(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  if (value.length > max) throw new Error(`${label} has too many entries`)
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || !item || item.length > 128) throw new Error(`${label} contains an invalid id`)
    if (seen.has(item)) throw new Error(`${label} contains a duplicate id: ${item}`)
    seen.add(item)
    result.push(item)
  }
  return result
}

function finiteNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number between ${min} and ${max}`)
  }
  return value
}

function textByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
