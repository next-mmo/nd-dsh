import { webcrypto } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { manifestPermissionIssues, validateNdExtensionManifest, type NdExtensionManifest } from '../../shared/extension-package.js'
import type { NdAvailablePackageView } from '../../shared/nd-invocations.js'
import type { ExtensionPackageStore } from './package-store.js'

export const DEFAULT_EXTENSION_CATALOG_URL = 'https://github.com/zila-kh/nd-dsh/releases/download/nd-extension-catalog/nd-extension-catalog.json'
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_PACKAGE_BYTES = 24 * 1024 * 1024
interface CatalogFile { path: string; bytes: number; sha256: string; executable?: boolean }
interface CatalogEntry { manifest: NdExtensionManifest; revision: string; directory: string; files: CatalogFile[] }

/** Catalog metadata is fetched explicitly from Discover, never on startup.
 * Package files come from an immutable ND source revision only after Install. */
export class RemoteExtensionCatalog {
  private entries = new Map<string, CatalogEntry>()
  private loading: Promise<void> | undefined
  constructor(
    private readonly catalogUrl = DEFAULT_EXTENSION_CATALOG_URL,
    private readonly request: typeof fetch = fetch,
  ) {}

  views(installedIds: Set<string>): NdAvailablePackageView[] {
    return [...this.entries.values()].map(({ manifest }) => ({
      id: manifest.id, name: manifest.name, description: manifest.description,
      version: manifest.version, permissions: manifest.permissions,
      commands: manifest.contributions.commands.map((command) => ({ id: command.id, title: command.title })),
      installed: installedIds.has(manifest.id), available: true,
    }))
  }

  refresh(): Promise<void> {
    this.loading ??= this.load().finally(() => { this.loading = undefined })
    return this.loading
  }

  private async load(): Promise<void> {
    if (new URL(this.catalogUrl).protocol !== 'https:') throw new Error('Extension catalog requires HTTPS')
    const body = await this.readBounded(this.catalogUrl, 1024 * 1024, AbortSignal.timeout(15_000))
    const value = JSON.parse(Buffer.from(body).toString('utf8')) as { version?: unknown; packages?: unknown }
    if (value.version !== 1 || !Array.isArray(value.packages) || value.packages.length > 1_000) throw new Error('Invalid extension catalog')
    const entries = new Map<string, CatalogEntry>()
    for (const raw of value.packages) {
      const entry = raw as CatalogEntry
      const validated = validateNdExtensionManifest(entry.manifest)
      // New packages can require a newer host API. Keep compatible entries usable
      // when an older installed app reads the latest catalog.
      if (!validated.ok || manifestPermissionIssues(validated.manifest).length) continue
      if (!/^[a-f0-9]{40}$/.test(entry.revision) || !/^[a-z0-9-]+$/.test(entry.directory)
        || !Array.isArray(entry.files) || entry.files.length === 0 || entry.files.length > 5_000) throw new Error('Invalid catalog source')
      const paths = new Set<string>()
      let bytes = 0
      for (const file of entry.files) {
        if (!safePackagePath(file.path) || paths.has(file.path) || !Number.isSafeInteger(file.bytes)
          || file.bytes < 0 || file.bytes > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(file.sha256)
          || (file.executable !== undefined && typeof file.executable !== 'boolean')) throw new Error('Invalid catalog file')
        paths.add(file.path)
        bytes += file.bytes
      }
      if (bytes > MAX_PACKAGE_BYTES || !paths.has('nd-extension.json') || entries.has(validated.manifest.id)) throw new Error('Invalid catalog package size or identity')
      entries.set(validated.manifest.id, { ...entry, manifest: validated.manifest })
    }
    this.entries = entries
  }

  async install(_id: string, _packages: ExtensionPackageStore, _scratchRoot: string): Promise<void> {
    // An unsigned catalog cannot authorize runnable third-party packages.
    // Re-enable only after ND-pinned publisher signatures are verified.
    throw new Error('ND Security: remote extension catalog is not signed; installation is disabled')
  }

  private async readBounded(url: string, limit: number, signal: AbortSignal): Promise<ArrayBuffer> {
    const response = await this.request(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
    if (!response.ok || !response.body) throw new Error('Extension download is unavailable. Retry Discover or install from a folder.')
    if (Number(response.headers.get('content-length') ?? 0) > limit) {
      await response.body.cancel()
      throw new Error('Extension download exceeds its size limit')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > limit) throw new Error('Extension download exceeds its size limit')
        chunks.push(value)
      }
    } finally { await reader.cancel() }
    const result = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
    return result.buffer
  }
}

function safePackagePath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 1024 && !path.includes('\\') && !path.includes(':')
    && path.split('/').every((part) => part && part !== '.' && part !== '..' && part !== '.git' && !/[\x00-\x1f]/.test(part))
}
