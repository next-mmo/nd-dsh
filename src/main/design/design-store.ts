import { createHash } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ND_DESIGN_LIMITS, type DesignDocument } from '../../shared/nd-design/index.js'

const MAX_PATH_LENGTH = 4_096

export interface ResolvedDesignPath {
  relative: string
  absolute: string
}

/** Workspace-scoped file access for ND Pencil documents and assets. */
export class DesignStore {
  constructor(private root: string) {}

  setRoot(root: string): void {
    this.root = root
  }

  get projectRoot(): string {
    return this.root
  }

  resolveDocument(value: string, mode: 'open' | 'create'): ResolvedDesignPath {
    const relativePath = validateDocumentPath(value)
    const absolute = resolve(this.root, relativePath)
    if (!isInside(this.root, absolute) || absolute === resolve(this.root)) {
      throw new Error('ND Pencil document path must stay inside the active project')
    }
    return { relative: relativePath, absolute }
  }

  async assertOpenable(path: ResolvedDesignPath): Promise<void> {
    await assertNoSymlinkParents(this.root, dirname(path.absolute))
    let stats
    try {
      stats = await fs.lstat(path.absolute)
    } catch (cause) {
      if (isMissingFileError(cause)) throw new Error(`ND Pencil document does not exist: ${path.relative}`)
      throw cause
    }
    if (stats.isSymbolicLink()) throw new Error(`ND Pencil document cannot be a symbolic link: ${path.relative}`)
    if (!stats.isFile()) throw new Error(`ND Pencil document must be a regular file: ${path.relative}`)
    if (stats.size > ND_DESIGN_LIMITS.maxDocumentBytes) throw new Error('ND Pencil document is too large')
  }

  async prepareCreate(path: ResolvedDesignPath): Promise<void> {
    await assertNoSymlinkParents(this.root, dirname(path.absolute))
    try {
      await fs.mkdir(dirname(path.absolute), { recursive: true })
    } catch (cause) {
      throw new Error(`ND Pencil could not create the document directory: ${errorMessage(cause)}`)
    }
    await assertNoSymlinkParents(this.root, dirname(path.absolute))
    try {
      const stats = await fs.lstat(path.absolute)
      if (stats.isSymbolicLink()) throw new Error(`ND Pencil document cannot be a symbolic link: ${path.relative}`)
      throw new Error(`ND Pencil document already exists: ${path.relative}`)
    } catch (cause) {
      if (!isMissingFileError(cause)) throw cause
    }
  }

  async readDocument(path: ResolvedDesignPath): Promise<string> {
    const text = await fs.readFile(path.absolute, 'utf8')
    if (Buffer.byteLength(text, 'utf8') > ND_DESIGN_LIMITS.maxDocumentBytes) throw new Error('ND Pencil document is too large')
    return text
  }

  async writeDocument(path: ResolvedDesignPath, contents: string): Promise<void> {
    await atomicWrite(path.absolute, contents)
  }

  async sourceHash(path: ResolvedDesignPath): Promise<string | undefined> {
    try {
      const stats = await fs.lstat(path.absolute)
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`ND Pencil document is not a regular file: ${path.relative}`)
      return createHash('sha256').update(await fs.readFile(path.absolute)).digest('hex')
    } catch (cause) {
      if (isMissingFileError(cause)) return undefined
      throw cause
    }
  }

  hash(text: string): string {
    return createHash('sha256').update(text).digest('hex')
  }

  async backupLegacy(path: ResolvedDesignPath, raw: string): Promise<string> {
    const directory = join(this.root, '.nd', 'design', '.backups')
    await fs.mkdir(directory, { recursive: true })
    const stem = basename(path.relative).replace(/\.op$/i, '')
    const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8)
    const backupName = `${stem}.v084-${hash}.op`
    const absolute = join(directory, backupName)
    if (!isInside(this.root, absolute)) throw new Error('ND Pencil backup path escaped the active project')
    try {
      const existing = await fs.readFile(absolute, 'utf8')
      if (existing === raw) return toRelative(this.root, absolute)
    } catch (cause) {
      if (!isMissingFileError(cause)) throw cause
    }
    await atomicWrite(absolute, raw)
    return toRelative(this.root, absolute)
  }

  async importAsset(dataUrl: string, fileName?: string): Promise<{ path: string; dataUrl: string }> {
    const parsed = parseDataImage(dataUrl)
    if (parsed.bytes.length > ND_DESIGN_LIMITS.maxAssetBytes) {
      throw new Error(`ND Pencil images must be under ${Math.floor(ND_DESIGN_LIMITS.maxAssetBytes / 1024 / 1024)} MB`)
    }
    const directory = join(this.root, '.nd', 'design', 'assets')
    await fs.mkdir(directory, { recursive: true })
    const used = await directoryBytes(directory)
    if (used + parsed.bytes.length > ND_DESIGN_LIMITS.maxDocumentAssetBytes) {
      throw new Error('ND Pencil project assets exceed the 32 MB limit')
    }
    const hash = createHash('sha256').update(parsed.bytes).digest('hex')
    const extension = assetExtension(parsed.mime, fileName)
    const absolute = join(directory, `${hash}.${extension}`)
    try {
      await fs.access(absolute, fsConstants.F_OK)
    } catch {
      await fs.writeFile(absolute, parsed.bytes)
    }
    return { path: toRelative(this.root, absolute), dataUrl }
  }

  async assetDataUrls(document: DesignDocument): Promise<Record<string, string>> {
    const result: Record<string, string> = {}
    let total = 0
    for (const node of Object.values(document.nodes)) {
      if (node.type !== 'image' || !node.src) continue
      if (node.src.startsWith('data:image/')) {
        if (!(node.src in result) && total + node.src.length <= ND_DESIGN_LIMITS.maxDocumentAssetBytes * 1.4) {
          result[node.src] = node.src
          total += node.src.length
        }
        continue
      }
      if (node.src in result) continue
      const absolute = resolve(this.root, node.src)
      if (!isInside(this.root, absolute)) continue
      try {
        const stats = await fs.lstat(absolute)
        if (!stats.isFile() || stats.isSymbolicLink()) continue
        if (total + stats.size > ND_DESIGN_LIMITS.maxDocumentAssetBytes) continue
        const bytes = await fs.readFile(absolute)
        const mime = mimeForExtension(extname(absolute))
        if (!mime) continue
        result[node.src] = `data:${mime};base64,${bytes.toString('base64')}`
        total += bytes.length
      } catch {
        // A missing image is rendered as a placeholder until the user relinks it.
      }
    }
    return result
  }

  async writeBuildArtifacts(document: DesignDocument, spec: string, svg: string): Promise<{ specPath: string; svgPath: string }> {
    const stem = slug(document.name || 'design')
    const directory = join(this.root, '.nd', 'design', '.build', stem)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(join(directory, '.gitignore'), '*\n', 'utf8')
    await fs.writeFile(join(directory, 'spec.json'), spec, 'utf8')
    await fs.writeFile(join(directory, 'reference.svg'), svg, 'utf8')
    return {
      specPath: toRelative(this.root, join(directory, 'spec.json')),
      svgPath: toRelative(this.root, join(directory, 'reference.svg')),
    }
  }
}

export function validateDocumentPath(value: string): string {
  if (typeof value !== 'string') throw new Error('ND Pencil path must be a string')
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_PATH_LENGTH) throw new Error('ND Pencil path is invalid')
  if (trimmed.includes('\0') || isAbsolute(trimmed)) throw new Error('ND Pencil path must be workspace-relative')
  if (!trimmed.toLowerCase().endsWith('.op')) throw new Error('ND Pencil documents must use the .op extension')
  const normalized = trimmed.replaceAll('\\', '/').replace(/^\.\//, '')
  if (!normalized || normalized.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new Error('ND Pencil path must stay inside the active project')
  }
  return normalized
}

async function assertNoSymlinkParents(root: string, directory: string): Promise<void> {
  const path = relative(resolve(root), resolve(directory))
  if (!path) return
  if (path.startsWith('..') || isAbsolute(path)) throw new Error('ND Pencil path escaped the active project')
  let current = resolve(root)
  for (const segment of path.split(sep)) {
    if (!segment) continue
    current = join(current, segment)
    try {
      const stats = await fs.lstat(current)
      if (stats.isSymbolicLink()) throw new Error(`ND Pencil path contains a symbolic link: ${current}`)
      if (!stats.isDirectory()) throw new Error(`ND Pencil parent is not a directory: ${current}`)
    } catch (cause) {
      if (isMissingFileError(cause)) return
      throw cause
    }
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temp = `${path}.nd-${process.pid}-${Date.now()}.tmp`
  await fs.writeFile(temp, contents, 'utf8')
  try {
    await fs.rename(temp, path)
  } catch (cause) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw cause
  }
}

async function directoryBytes(directory: string): Promise<number> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    let total = 0
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const stats = await fs.stat(join(directory, entry.name))
      total += stats.size
    }
    return total
  } catch (cause) {
    if (isMissingFileError(cause)) return 0
    throw cause
  }
}

function parseDataImage(dataUrl: string): { mime: string; bytes: Buffer } {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl)
  if (!match) throw new Error('ND Pencil image must be a base64 PNG, JPEG, WebP, GIF, or SVG')
  const mime = match[1]!.toLowerCase().replace('image/jpg', 'image/jpeg')
  const bytes = Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64')
  if (bytes.length === 0) throw new Error('ND Pencil image is empty')
  return { mime, bytes }
}

function assetExtension(mime: string, fileName?: string): string {
  const fromName = fileName ? extname(fileName).replace(/^\./, '').toLowerCase() : ''
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(fromName)) return fromName === 'jpeg' ? 'jpg' : fromName
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'image/svg+xml') return 'svg'
  return 'jpg'
}

function mimeForExtension(extension: string): string | undefined {
  switch (extension.toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.svg': return 'image/svg+xml'
    default: return undefined
  }
}

function slug(value: string): string {
  const result = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return result || 'design'
}

function toRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/')
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate))
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function isMissingFileError(cause: unknown): boolean {
  return Boolean(cause && typeof cause === 'object' && 'code' in cause && (cause as { code?: unknown }).code === 'ENOENT')
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
