import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

export type ApiStudioMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

const METHODS: readonly ApiStudioMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const MAX_WORKSPACE_BYTES = 2 * 1024 * 1024
const MAX_SPEC_BYTES = 4 * 1024 * 1024
const SPEC_CHUNK_CHARS = 120_000

export interface ApiStudioRow {
  id: string
  key: string
  value: string
  enabled: boolean
}

export interface ApiStudioVariable extends ApiStudioRow {
  secret: boolean
}

export interface ApiStudioAuth {
  type: 'none' | 'bearer' | 'basic' | 'apikey'
  token: string
  username: string
  password: string
  key: string
  value: string
  addTo: 'header' | 'query'
}

export interface ApiStudioBody {
  mode: 'none' | 'json' | 'text' | 'form' | 'multipart'
  text: string
  fields: ApiStudioRow[]
}

export interface ApiStudioRequest {
  id: string
  name: string
  method: ApiStudioMethod
  url: string
  pathVars: ApiStudioRow[]
  params: ApiStudioRow[]
  headers: ApiStudioRow[]
  body: ApiStudioBody
  auth: ApiStudioAuth
  specId?: string
  operationId?: string
}

export interface ApiStudioCollection {
  id: string
  name: string
  requests: ApiStudioRequest[]
}

export interface ApiStudioEnvironment {
  id: string
  name: string
  variables: ApiStudioVariable[]
}

export interface ApiStudioHistoryEntry {
  id: string
  at: number
  environmentId: string | null
  method: ApiStudioMethod
  url: string
  status: number
  statusText: string
  durationMs: number
  bytes: number
  request: ApiStudioRequest
}

export interface ApiStudioWorkspace {
  version: 1
  collections: ApiStudioCollection[]
  environments: ApiStudioEnvironment[]
  activeEnvironmentId: string | null
  history: ApiStudioHistoryEntry[]
}

export interface ApiStudioCipher {
  available(): boolean
  encrypt(plain: string): string
  decrypt(encoded: string): string
}

export interface ApiStudioWorkspaceSnapshot {
  workspace: ApiStudioWorkspace
  encrypted: boolean
  warning?: string
}

class LockedWorkspaceError extends Error {}

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'api-key',
])

export function emptyWorkspace(): ApiStudioWorkspace {
  const environment = { id: randomUUID(), name: 'Local', variables: [] }
  return {
    version: 1,
    collections: [],
    environments: [environment],
    activeEnvironmentId: environment.id,
    history: [],
  }
}

/** Redaction is enforced host-side too: the frame never gets to decide what is safe to persist. */
export function redactRequestForHistory(request: ApiStudioRequest): ApiStudioRequest {
  const auth = request.auth
  return {
    ...request,
    auth: {
      ...auth,
      token: '',
      password: '',
      value: '',
    },
    headers: request.headers.filter((header) => !SENSITIVE_HEADERS.has(header.key.trim().toLowerCase())),
    params: auth.type === 'apikey' && auth.addTo === 'query'
      ? request.params.map((param) => param.key === auth.key ? { ...param, value: '' } : param)
      : request.params,
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function list(value: unknown, label: string, max: number): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  if (value.length > max) throw new Error(`${label} must contain at most ${max} items`)
  return value
}

function text(value: unknown, label: string, max: number, fallback = ''): string {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  if (value.length > max) throw new Error(`${label} must be at most ${max} characters`)
  return value
}

function identifier(value: unknown, label: string): string {
  const id = text(value, label, 64)
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error(`${label} must be a simple identifier`)
  return id
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function method(value: unknown): ApiStudioMethod {
  const candidate = text(value, 'Request method', 16, 'GET').toUpperCase()
  if (!METHODS.includes(candidate as ApiStudioMethod)) throw new Error(`Unsupported request method: ${candidate}`)
  return candidate as ApiStudioMethod
}

function rows(value: unknown, label: string, max: number): ApiStudioRow[] {
  return list(value, label, max).map((item, index) => {
    const row = record(item, `${label}[${index}]`)
    return {
      id: identifier(row.id, `${label}[${index}].id`),
      key: text(row.key, `${label}[${index}].key`, 256),
      value: text(row.value, `${label}[${index}].value`, 8192),
      enabled: boolean(row.enabled, true),
    }
  })
}

function auth(value: unknown): ApiStudioAuth {
  const input = value === undefined ? {} : record(value, 'Request auth')
  const type = text(input.type, 'Auth type', 16, 'none')
  if (!['none', 'bearer', 'basic', 'apikey'].includes(type)) throw new Error(`Unsupported auth type: ${type}`)
  const addTo = input.addTo === 'query' ? 'query' : 'header'
  return {
    type: type as ApiStudioAuth['type'],
    token: text(input.token, 'Auth token', 8192),
    username: text(input.username, 'Auth username', 1024),
    password: text(input.password, 'Auth password', 8192),
    key: text(input.key, 'Auth key', 256),
    value: text(input.value, 'Auth value', 8192),
    addTo,
  }
}

function body(value: unknown): ApiStudioBody {
  const input = value === undefined ? {} : record(value, 'Request body')
  const mode = text(input.mode, 'Body mode', 16, 'none')
  if (!['none', 'json', 'text', 'form', 'multipart'].includes(mode)) throw new Error(`Unsupported body mode: ${mode}`)
  return {
    mode: mode as ApiStudioBody['mode'],
    // Bounded by the nd.webview/1 bridge message cap, not by the Rust body cap.
    text: text(input.text, 'Body text', 120_000),
    fields: rows(input.fields, 'Body fields', 100),
  }
}

export function sanitizeApiStudioRequest(value: unknown): ApiStudioRequest {
  return request(value, 'Request')
}

function request(value: unknown, label: string): ApiStudioRequest {
  const input = record(value, label)
  const specId = text(input.specId, `${label}.specId`, 64)
  const operationId = text(input.operationId, `${label}.operationId`, 256)
  return {
    id: identifier(input.id, `${label}.id`),
    name: text(input.name, `${label}.name`, 160, 'Untitled request'),
    method: method(input.method),
    url: text(input.url, `${label}.url`, 4096),
    pathVars: rows(input.pathVars, `${label}.pathVars`, 50),
    params: rows(input.params, `${label}.params`, 100),
    headers: rows(input.headers, `${label}.headers`, 100),
    body: body(input.body),
    auth: auth(input.auth),
    ...(specId ? { specId } : {}),
    ...(operationId ? { operationId } : {}),
  }
}

function collection(value: unknown, index: number): ApiStudioCollection {
  const input = record(value, `collections[${index}]`)
  return {
    id: identifier(input.id, `collections[${index}].id`),
    name: text(input.name, `collections[${index}].name`, 160, 'Untitled collection'),
    requests: list(input.requests, `collections[${index}].requests`, 500).map((item, itemIndex) =>
      request(item, `collections[${index}].requests[${itemIndex}]`)),
  }
}

function environment(value: unknown, index: number): ApiStudioEnvironment {
  const input = record(value, `environments[${index}]`)
  return {
    id: identifier(input.id, `environments[${index}].id`),
    name: text(input.name, `environments[${index}].name`, 160, 'Untitled environment'),
    variables: list(input.variables, `environments[${index}].variables`, 200).map((item, itemIndex) => {
      const row = record(item, `environments[${index}].variables[${itemIndex}]`)
      return {
        id: identifier(row.id, `environments[${index}].variables[${itemIndex}].id`),
        key: text(row.key, `environments[${index}].variables[${itemIndex}].key`, 128),
        value: text(row.value, `environments[${index}].variables[${itemIndex}].value`, 8192),
        enabled: boolean(row.enabled, true),
        secret: boolean(row.secret, false),
      }
    }),
  }
}

function historyEntry(value: unknown, index: number): ApiStudioHistoryEntry {
  const input = record(value, `history[${index}]`)
  const environmentId = text(input.environmentId, `history[${index}].environmentId`, 64)
  return {
    id: identifier(input.id, `history[${index}].id`),
    at: typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : Date.now(),
    environmentId: environmentId || null,
    method: method(input.method),
    url: text(input.url, `history[${index}].url`, 4096),
    status: typeof input.status === 'number' && Number.isFinite(input.status) ? input.status : 0,
    statusText: text(input.statusText, `history[${index}].statusText`, 128),
    durationMs: typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) ? input.durationMs : 0,
    bytes: typeof input.bytes === 'number' && Number.isFinite(input.bytes) ? input.bytes : 0,
    request: redactRequestForHistory(request(input.request, `history[${index}].request`)),
  }
}

/** Rebuild from validated fields; never persist an unknown-key passthrough. */
export function sanitizeWorkspace(value: unknown): ApiStudioWorkspace {
  const input = record(value, 'Workspace')
  const activeEnvironmentId = text(input.activeEnvironmentId, 'activeEnvironmentId', 64) || null
  const workspace: ApiStudioWorkspace = {
    version: 1,
    collections: list(input.collections, 'collections', 100).map(collection),
    environments: list(input.environments, 'environments', 50).map(environment),
    activeEnvironmentId,
    history: list(input.history, 'history', 100).map(historyEntry),
  }
  if (JSON.stringify(workspace).length > MAX_WORKSPACE_BYTES) {
    throw new Error('The API Studio workspace is too large to save')
  }
  return workspace
}

/**
 * One atomic JSON file in userData. When the OS keychain is available the
 * payload is encrypted through Electron safeStorage; otherwise the file is
 * written 0600 and the snapshot reports `encrypted: false` so the UI can warn.
 */
export class ApiStudioWorkspaceStore {
  private saveChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly cipher?: ApiStudioCipher,
  ) {}

  async read(): Promise<ApiStudioWorkspaceSnapshot> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { workspace: emptyWorkspace(), encrypted: this.cipherAvailable() }
      }
      throw error
    }
    try {
      const stored = record(JSON.parse(raw), 'Workspace file')
      const encrypted = stored.encrypted === true
      if (encrypted && !this.cipherAvailable()) {
        throw new LockedWorkspaceError('This workspace is encrypted with the OS keychain, which is unavailable right now')
      }
      const payload = text(stored.payload, 'Workspace payload', 8 * 1024 * 1024)
      const plain = encrypted ? this.cipher!.decrypt(payload) : payload
      return { workspace: sanitizeWorkspace(JSON.parse(plain)), encrypted }
    } catch (error) {
      if (error instanceof LockedWorkspaceError) throw error
      // Keep the unreadable file for recovery instead of overwriting user data.
      const backup = `${this.filePath}.corrupt-${Date.now()}`
      await fs.copyFile(this.filePath, backup).catch(() => undefined)
      return {
        workspace: emptyWorkspace(),
        encrypted: this.cipherAvailable(),
        warning: `The saved API Studio workspace could not be read (${error instanceof Error ? error.message : String(error)}). A copy was kept at ${backup}.`,
      }
    }
  }

  async write(value: unknown): Promise<{ encrypted: boolean; savedAt: number }> {
    const workspace = sanitizeWorkspace(value)
    const plain = JSON.stringify(workspace)
    const encrypted = this.cipherAvailable()
    if (!encrypted && await this.existingFileIsEncrypted()) {
      throw new Error('Refusing to replace an encrypted workspace while the OS keychain is unavailable')
    }
    const payload = encrypted ? this.cipher!.encrypt(plain) : plain
    const file = `${JSON.stringify({ version: 1, encrypted, payload })}\n`
    const operation = this.saveChain.catch(() => undefined).then(async () => {
      await fs.mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temp, file, { encoding: 'utf8', mode: 0o600 })
        await fs.rename(temp, this.filePath)
      } catch (cause) {
        await fs.rm(temp, { force: true }).catch(() => undefined)
        throw cause
      }
    })
    this.saveChain = operation
    await operation
    return { encrypted, savedAt: Date.now() }
  }

  private cipherAvailable(): boolean {
    try {
      return this.cipher?.available() === true
    } catch {
      return false
    }
  }

  private async existingFileIsEncrypted(): Promise<boolean> {
    try {
      const stored = record(JSON.parse(await fs.readFile(this.filePath, 'utf8')), 'Workspace file')
      return stored.encrypted === true
    } catch {
      return false
    }
  }
}

export interface ApiStudioSaveChunk {
  complete: boolean
  received: number
  text?: string
}

/**
 * Reassembles a workspace that crossed the nd.webview/1 bridge in chunks.
 * The bridge drops frames over 262,144 characters, so the UI never sends a
 * workspace larger than one bounded chunk and never decides how the pieces
 * are ordered.
 */
export class ApiStudioWorkspaceSaveBuffer {
  private saves = new Map<string, { chunks: string[]; chars: number; updatedAt: number }>()

  constructor(
    private readonly maxChars = 2 * 1024 * 1024,
    private readonly ttlMs = 120_000,
    private readonly now: () => number = Date.now,
  ) {}

  append(saveId: string, offset: number, chunk: string, final: boolean): ApiStudioSaveChunk {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(saveId)) throw new Error('Save id must be a simple identifier')
    if (!Number.isFinite(offset) || offset < 0) throw new Error('Workspace save offset is invalid')
    const now = this.now()
    for (const [id, buffer] of this.saves) {
      if (now - buffer.updatedAt > this.ttlMs) this.saves.delete(id)
    }
    let buffer = this.saves.get(saveId)
    if (!buffer) {
      if (offset !== 0) throw new Error('Workspace save must start at offset 0')
      buffer = { chunks: [], chars: 0, updatedAt: now }
      this.saves.set(saveId, buffer)
    }
    if (offset !== buffer.chars) throw new Error('Workspace save chunks arrived out of order')
    buffer.chunks.push(chunk)
    buffer.chars += chunk.length
    buffer.updatedAt = now
    if (buffer.chars > this.maxChars) {
      this.saves.delete(saveId)
      throw new Error('The API Studio workspace is too large to save')
    }
    if (!final) return { complete: false, received: buffer.chars }
    this.saves.delete(saveId)
    return { complete: true, received: buffer.chars, text: buffer.chunks.join('') }
  }
}

export interface ApiStudioSpecMeta {
  id: string
  name: string
  sourceUrl?: string
  bytes: number
  format: 'json' | 'yaml'
  importedAt: number
}

interface SpecIndex {
  version: 1
  specs: ApiStudioSpecMeta[]
}

/** Imported OpenAPI documents live beside the workspace, one raw file each. */
export class ApiStudioSpecStore {
  private saveChain: Promise<void> = Promise.resolve()

  constructor(private readonly root: string) {}

  async list(): Promise<ApiStudioSpecMeta[]> {
    const index = await this.readIndex()
    return [...index.specs].sort((left, right) => right.importedAt - left.importedAt)
  }

  async import(input: { text: string; name?: string; sourceUrl?: string; contentType?: string }): Promise<ApiStudioSpecMeta> {
    const raw = text(input.text, 'Specification', MAX_SPEC_BYTES)
    if (raw.trim().length === 0) throw new Error('The specification is empty')
    const id = randomUUID()
    const format = detectFormat(raw, input.contentType)
    if (format === 'json') {
      try {
        JSON.parse(raw)
      } catch (error) {
        throw new Error(`The pasted specification is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const sourceUrl = text(input.sourceUrl, 'Specification URL', 4096)
    const meta: ApiStudioSpecMeta = {
      id,
      name: text(input.name, 'Specification name', 160) || deriveName(sourceUrl) || 'OpenAPI specification',
      ...(sourceUrl ? { sourceUrl } : {}),
      bytes: Buffer.byteLength(raw, 'utf8'),
      format,
      importedAt: Date.now(),
    }
    await fs.mkdir(this.specDirectory(), { recursive: true, mode: 0o700 })
    await this.atomicWrite(this.specPath(id), raw)
    await this.updateIndex((index) => ({ version: 1, specs: [...index.specs.filter((item) => item.id !== id), meta] }))
    return meta
  }

  async text(id: string): Promise<{ meta: ApiStudioSpecMeta; text: string }> {
    const safeId = identifier(id, 'Specification id')
    const index = await this.readIndex()
    const meta = index.specs.find((item) => item.id === safeId)
    if (!meta) throw new Error('Imported specification not found')
    try {
      return { meta, text: await fs.readFile(this.specPath(safeId), 'utf8') }
    } catch {
      throw new Error('The imported specification file is missing')
    }
  }

  async readChunk(id: string, offset: number, length = SPEC_CHUNK_CHARS): Promise<{ chunk: string; nextOffset: number; done: boolean }> {
    const { text: full } = await this.text(id)
    const start = Number.isFinite(offset) ? Math.max(0, Math.min(full.length, Math.floor(offset))) : 0
    const size = Number.isFinite(length) ? Math.max(1, Math.min(SPEC_CHUNK_CHARS, Math.floor(length))) : SPEC_CHUNK_CHARS
    const end = Math.min(full.length, start + size)
    return { chunk: full.slice(start, end), nextOffset: end, done: end >= full.length }
  }

  async delete(id: string): Promise<boolean> {
    const safeId = identifier(id, 'Specification id')
    const index = await this.readIndex()
    if (!index.specs.some((item) => item.id === safeId)) return false
    await fs.rm(this.specPath(safeId), { force: true })
    await this.updateIndex((current) => ({ version: 1, specs: current.specs.filter((item) => item.id !== safeId) }))
    return true
  }

  private specDirectory(): string {
    return join(this.root, 'specs')
  }

  private specPath(id: string): string {
    return join(this.specDirectory(), `${id}.txt`)
  }

  private async readIndex(): Promise<SpecIndex> {
    try {
      const parsed = record(JSON.parse(await fs.readFile(join(this.specDirectory(), 'index.json'), 'utf8')), 'Specification index')
      return {
        version: 1,
        specs: list(parsed.specs, 'specs', 100).map((item, index) => {
          const entry = record(item, `specs[${index}]`)
          const format = entry.format === 'yaml' ? 'yaml' : 'json'
          const sourceUrl = text(entry.sourceUrl, `specs[${index}].sourceUrl`, 4096)
          return {
            id: identifier(entry.id, `specs[${index}].id`),
            name: text(entry.name, `specs[${index}].name`, 160),
            ...(sourceUrl ? { sourceUrl } : {}),
            bytes: typeof entry.bytes === 'number' && Number.isFinite(entry.bytes) ? entry.bytes : 0,
            format,
            importedAt: typeof entry.importedAt === 'number' && Number.isFinite(entry.importedAt) ? entry.importedAt : 0,
          }
        }),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, specs: [] }
      return { version: 1, specs: [] }
    }
  }

  private async updateIndex(update: (index: SpecIndex) => SpecIndex): Promise<void> {
    const next = update(await this.readIndex())
    await fs.mkdir(this.specDirectory(), { recursive: true, mode: 0o700 })
    await this.atomicWrite(join(this.specDirectory(), 'index.json'), JSON.stringify(next, null, 2))
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    const operation = this.saveChain.catch(() => undefined).then(async () => {
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temp, contents, { encoding: 'utf8', mode: 0o600 })
        await fs.rename(temp, path)
      } catch (cause) {
        await fs.rm(temp, { force: true }).catch(() => undefined)
        throw cause
      }
    })
    this.saveChain = operation
    await operation
  }
}

function detectFormat(raw: string, contentType?: string): 'json' | 'yaml' {
  const type = (contentType ?? '').toLowerCase()
  if (type.includes('yaml') || type.includes('yml')) return 'yaml'
  if (type.includes('json')) return 'json'
  const first = raw.trimStart()[0]
  return first === '{' || first === '[' ? 'json' : 'yaml'
}

function deriveName(sourceUrl: string): string {
  if (!sourceUrl) return ''
  try {
    const url = new URL(sourceUrl)
    const last = url.pathname.split('/').filter(Boolean).pop()
    return last ? decodeURIComponent(last).slice(0, 160) : url.hostname
  } catch {
    return ''
  }
}
