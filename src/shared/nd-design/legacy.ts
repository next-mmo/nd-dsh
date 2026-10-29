import {
  createDesignId,
  createEmptyDesignDocument,
  ND_DESIGN_FORMAT,
  nowIso,
  type DesignDocument,
  type DesignMigrationReport,
  type DesignNode,
  type DesignNodeType,
} from './model.js'

interface LegacyImportResult {
  document: DesignDocument
  report: DesignMigrationReport
}

type UnknownRecord = Record<string, unknown>

const LEGACY_TYPE_MAP: Record<string, DesignNodeType | 'polygon' | 'drop'> = {
  frame: 'frame',
  group: 'group',
  rectangle: 'rect',
  rect: 'rect',
  ellipse: 'ellipse',
  line: 'line',
  text: 'text',
  image: 'image',
  polygon: 'polygon',
  icon_font: 'drop',
  path: 'drop',
  vector: 'drop',
  boolean: 'drop',
  component: 'drop',
  component_instance: 'drop',
  instance: 'drop',
}

const COLOR_PATTERN = /^(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([^)]*\)|transparent)$/i

export function isLegacyDesignDocument(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false
  if (value.format === ND_DESIGN_FORMAT) return false
  return Array.isArray(value.children) || typeof value.version === 'string'
}

export function importLegacyDesignDocument(value: UnknownRecord): LegacyImportResult {
  const dropped: Record<string, number> = {}
  const approximate: string[] = []
  const document = createEmptyDesignDocument(typeof value.name === 'string' && value.name.trim() ? value.name.trim() : 'Imported design')
  const page = document.pages[0]!
  page.children = []
  document.nodes = {}
  document.meta = {
    migration: {
      from: 'openpencil-0.8.4',
      dropped,
      approximate,
    },
  }

  const variables = isRecord(value.variables) ? value.variables : {}
  const images = isRecord(value.images) ? value.images : {}
  const children = Array.isArray(value.children) ? value.children : []
  const usedIds = new Set<string>()

  for (const child of children) {
    const imported = importNode(child, null, 0, 0, 0)
    if (imported) page.children.push(imported)
  }

  if (page.children.length === 0) {
    approximate.push('No nodes with explicit positions could be imported. The original file is preserved as a backup.')
  }
  document.updatedAt = nowIso()
  return { document, report: document.meta.migration! }

  function importNode(raw: unknown, parentId: string | null, parentX: number, parentY: number, depth: number): string | null {
    if (depth > 32) {
      drop('depth-limit')
      return null
    }
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      drop('invalid-node')
      return null
    }
    const type = LEGACY_TYPE_MAP[raw.type]
    if (!type) {
      drop(raw.type)
      return null
    }
    if (type === 'drop') {
      drop(raw.type)
      return null
    }
    if (type === 'polygon') {
      if (numberValue(raw.polygonCount) === 4) {
        // A four-sided polygon is a rectangle for v1 purposes.
        return importMappedNode(raw, 'rect', parentId, parentX, parentY, depth)
      }
      drop(raw.type)
      return null
    }
    return importMappedNode(raw, type, parentId, parentX, parentY, depth)
  }

  function importMappedNode(
    raw: UnknownRecord,
    type: DesignNodeType,
    parentId: string | null,
    parentX: number,
    parentY: number,
    depth: number,
  ): string | null {
    const isRoot = parentId === null
    const localX = numberValue(raw.x)
    const localY = numberValue(raw.y)
    if (!isRoot && (localX === undefined || localY === undefined)) {
      // Auto-layout children have no stored position. v1 has no auto-layout
      // engine, so importing them would place them at an invented coordinate.
      drop('auto-layout-child')
      return null
    }
    const rawWidth = sizingValue(raw.width)
    const rawHeight = sizingValue(raw.height)
    if (!isRoot && (rawWidth === undefined || rawHeight === undefined)) {
      drop('auto-layout-child')
      return null
    }

    let width = rawWidth ?? (type === 'text' ? 160 : 120)
    let height = rawHeight ?? (type === 'text' ? 24 : 80)
    const fontSize = numberValue(raw.fontSize) ?? 16
    const lineHeight = numberValue(raw.lineHeight) ?? 1.3
    const text = type === 'text' ? textValue(raw.content) : undefined
    if (type === 'text') {
      if (rawWidth === undefined || rawHeight === undefined) {
        const lines = text ? text.split('\n') : ['']
        const longest = Math.max(8, ...lines.map((line) => line.length))
        width = rawWidth ?? Math.min(1_200, Math.max(24, Math.ceil(longest * fontSize * 0.58)))
        height = rawHeight ?? Math.max(1, Math.ceil(lines.length * fontSize * lineHeight))
        approximate.push(`${typeof raw.name === 'string' ? raw.name : 'text'}: size estimated from font metrics`)
      }
    }

    const id = uniqueId(typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : createDesignId(type === 'frame' ? 'frame' : 'n'))
    const x = (isRoot ? localX ?? 0 : parentX + (localX ?? 0))
    const y = (isRoot ? localY ?? 0 : parentY + (localY ?? 0))
    const node: DesignNode = {
      id,
      type,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : type,
      x,
      y,
      width,
      height,
    }
    const opacity = numberValue(raw.opacity)
    if (opacity !== undefined) node.opacity = clamp(opacity, 0, 1)
    if (raw.visible === false) node.visible = false
    if (raw.locked === true) node.locked = true

    const fill = legacyFill(raw.fill, variables)
    if (fill) node.fill = fill
    else if (Array.isArray(raw.fill) && raw.fill.length > 0) drop('fill')

    const stroke = legacyStroke(raw.stroke, variables)
    if (stroke) node.stroke = stroke
    if (raw.clipContent === true || raw.clip === true) node.clip = true
    const radius = numberValue(raw.cornerRadius) ?? firstNumber(raw.cornerRadius)
    if (radius !== undefined) node.cornerRadius = clamp(radius, 0, 10_000)

    if (type === 'text') {
      node.text = text ?? (typeof raw.name === 'string' ? raw.name : 'Text')
      node.fontFamily = typeof raw.fontFamily === 'string' ? raw.fontFamily : 'Inter'
      node.fontSize = clamp(fontSize, 1, 512)
      node.fontWeight = clamp(numberValue(raw.fontWeight) ?? 400, 100, 900)
      node.lineHeight = clamp(lineHeight, 0.5, 4)
      node.letterSpacing = clamp(numberValue(raw.letterSpacing) ?? 0, -10, 100)
      node.align = raw.textAlign === 'center' || raw.textAlign === 'right' ? raw.textAlign : 'left'
      node.color = firstColor(fill) ?? '#18181b'
      delete node.fill
    }

    if (type === 'image') {
      const src = legacyImageSource(raw, images)
      if (!src) {
        drop('image-source')
        return null
      }
      node.src = src
      node.fit = raw.fit === 'contain' || raw.fit === 'fill' ? raw.fit : 'cover'
    }

    if (type === 'line' && node.stroke === undefined) {
      node.stroke = { color: '#18181b', width: 1 }
    }

    document.nodes[id] = node
    if (isRoot) return id

    if (!parentId) {
      delete document.nodes[id]
      drop('invalid-parent')
      return null
    }
    const parent = document.nodes[parentId]
    if (!parent || (parent.type !== 'frame' && parent.type !== 'group')) {
      delete document.nodes[id]
      drop('invalid-parent')
      return null
    }
    if (parent.children === undefined) parent.children = []
    parent.children.push(id)

    if (type === 'frame' || type === 'group') {
      const rawChildren = Array.isArray(raw.children) ? raw.children : []
      for (const child of rawChildren) importNode(child, id, x, y, depth + 1)
    }
    return id
  }

  function uniqueId(candidate: string): string {
    let id = candidate.slice(0, 128)
    let suffix = 2
    while (usedIds.has(id)) {
      id = `${candidate.slice(0, 120)}-${suffix}`
      suffix += 1
    }
    usedIds.add(id)
    return id
  }

  function drop(kind: string): void {
    dropped[kind] = (dropped[kind] ?? 0) + 1
  }
}

function legacyFill(value: unknown, variables: UnknownRecord): DesignNode['fill'] | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item) || item.type !== 'solid') continue
      const color = resolveColor(item.color, variables)
      if (color) return { type: 'solid', color }
    }
    return undefined
  }
  const color = resolveColor(value, variables)
  return color ? { type: 'solid', color } : undefined
}

function legacyStroke(value: unknown, variables: UnknownRecord): DesignNode['stroke'] | undefined {
  if (!isRecord(value)) return undefined
  const fill = legacyFill(value.fill, variables)
  if (!fill) return undefined
  return { color: fill.color, width: clamp(numberValue(value.thickness) ?? 1, 0, 100) }
}

function resolveColor(value: unknown, variables: UnknownRecord, depth = 0): string | undefined {
  if (depth > 4) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('$')) {
      const variable = variables[trimmed.slice(1)]
      return resolveColor(variable, variables, depth + 1)
    }
    return COLOR_PATTERN.test(trimmed) ? trimmed : undefined
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const color = resolveColor(item, variables, depth + 1)
      if (color) return color
    }
    return undefined
  }
  if (isRecord(value)) {
    return resolveColor(value.value, variables, depth + 1)
  }
  return undefined
}

function firstColor(fill: DesignNode['fill'] | undefined): string | undefined {
  return fill?.color
}

function legacyImageSource(raw: UnknownRecord, images: UnknownRecord): string | undefined {
  const candidate = [raw.src, raw.url, raw.href, raw.image, raw.imageRef]
    .find((item) => typeof item === 'string' && item.trim()) as string | undefined
  if (!candidate) return undefined
  const value = candidate.trim()
  if (value.startsWith('$')) {
    const mapped = images[value.slice(1)]
    return typeof mapped === 'string' && mapped.startsWith('data:image/') ? mapped : undefined
  }
  if (value.startsWith('data:image/')) return value.length <= 8 * 1024 * 1024 ? value : undefined
  if (/^(https?:)?\/\//i.test(value)) return undefined
  if (value.startsWith('/') || value.includes('..') || value.includes('\\') || /^[a-zA-Z]:/.test(value)) return undefined
  return value
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 100_000)
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : isRecord(item) && typeof item.text === 'string' ? item.text : '')).join('').slice(0, 100_000)
  }
  if (isRecord(value) && typeof value.text === 'string') return value.text.slice(0, 100_000)
  return ''
}

function sizingValue(value: unknown): number | undefined {
  const number = numberValue(value)
  if (number !== undefined) return Math.max(0, number)
  return undefined
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

function firstNumber(value: unknown): number | undefined {
  if (Array.isArray(value)) return numberValue(value[0])
  return undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

