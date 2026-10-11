import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { extname } from 'node:path'
import {
  ND_WEBVIEW_MAX_ASSET_FILE_BYTES,
  ND_WEBVIEW_URL_SCHEME,
  webviewAssetUrl,
} from '../../shared/extension-webview.js'
import type { ExtensionPackageStore } from './package-store.js'

const TOKEN_TTL_MS = 30 * 60 * 1000
const MAX_LIVE_TOKENS = 64
const TOKEN_BYTES = 24

const ASSET_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Strict CSP for package UI documents. Everything comes from the private
 * scheme or is inline style; there is no network, no fetch, and no frame
 * descendants. Script sources use the scheme form so the opaque-origin iframe
 * (sandboxed without allow-same-origin) can still load its own package files.
 */
const WEBVIEW_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `script-src ${ND_WEBVIEW_URL_SCHEME}:`,
  `style-src ${ND_WEBVIEW_URL_SCHEME}: 'unsafe-inline'`,
  `img-src ${ND_WEBVIEW_URL_SCHEME}: data: blob:`,
  `font-src ${ND_WEBVIEW_URL_SCHEME}:`,
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export interface NdWebViewResponse {
  status: number
  headers: Record<string, string>
  body?: Buffer
}

export interface ParsedWebviewAssetUrl {
  token: string
  packageId: string
  packagePath: string
}

interface IssuedToken {
  extensionId: string
  version: string
  expiresAt: number
}

/**
 * Token-scoped serving of installed package UI assets for `kind: 'web'`
 * views. Tokens are main-process secrets issued per dialog load, bound to one
 * installed package version, and time-limited; the resolver re-checks
 * snapshot containment, the file-type allowlist, and the size cap on every
 * request, so even a leaked token exposes only that package's static assets.
 */
export class ExtensionWebViewAssets {
  private tokens = new Map<string, IssuedToken>()

  constructor(
    private readonly packages: ExtensionPackageStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Issue a serving URL for one installed package's UI entry. */
  async issue(extensionId: string, entryPath: string): Promise<{ url: string; token: string } | undefined> {
    const record = await this.packages.record(extensionId)
    if (!record) return undefined
    this.prune()
    if (this.tokens.size >= MAX_LIVE_TOKENS) return undefined
    const token = randomBytes(TOKEN_BYTES).toString('hex')
    this.tokens.set(token, { extensionId, version: record.manifest.version, expiresAt: this.now() + TOKEN_TTL_MS })
    return { token, url: webviewAssetUrl(token, extensionId, entryPath) }
  }

  revoke(token: string): void {
    this.tokens.delete(token)
  }

  liveTokenCount(): number {
    this.prune()
    return this.tokens.size
  }

  /** Resolve a scheme request to a response; anything suspicious is a bare 404. */
  async respond(url: string): Promise<NdWebViewResponse> {
    const baseHeaders: Record<string, string> = {
      'content-security-policy': WEBVIEW_CONTENT_SECURITY_POLICY,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      // The iframe's origin is opaque (sandboxed without allow-same-origin), so
      // its CORS-mode module-script fetches need a wildcard ACAO to pass. Safe:
      // the scheme is app-private and token-gated, and no foreign web page can
      // fetch it (supportFetchAPI/corsEnabled are off for the scheme).
      'access-control-allow-origin': '*',
    }
    try {
      const resolved = await this.resolve(url)
      if (resolved) {
        return { status: 200, headers: { ...baseHeaders, 'content-type': resolved.contentType }, body: resolved.body }
      }
    } catch {
      // Fall through to the bare 404; never leak why a request failed.
    }
    return { status: 404, headers: { ...baseHeaders, 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('Not found') }
  }

  private async resolve(url: string): Promise<{ body: Buffer; contentType: string } | null> {
    const parsed = parseWebviewAssetUrl(url)
    if (!parsed) return null
    const issued = this.tokens.get(parsed.token)
    if (!issued || issued.expiresAt <= this.now()) {
      this.tokens.delete(parsed.token)
      return null
    }
    if (issued.extensionId !== parsed.packageId) return null
    const filePath = await this.packages.snapshotFileFor(parsed.packageId, issued.version, parsed.packagePath)
    if (!filePath) return null
    const contentType = ASSET_CONTENT_TYPES[extname(filePath).toLowerCase()]
    if (!contentType) return null
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size > ND_WEBVIEW_MAX_ASSET_FILE_BYTES) return null
    return { body: await fs.readFile(filePath), contentType }
  }

  private prune(): void {
    const now = this.now()
    for (const [token, issued] of this.tokens) {
      if (issued.expiresAt <= now) this.tokens.delete(token)
    }
  }
}

/**
 * Parse `nd-extension-ui://<token>/<packageId>/<package path>`. Returns null
 * for anything that is not exactly that shape: token must be lowercase hex,
 * the path must be non-empty with no traversal segments, and no backslashes.
 */
export function parseWebviewAssetUrl(rawUrl: string): ParsedWebviewAssetUrl | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${ND_WEBVIEW_URL_SCHEME}:`) return null
  const token = url.hostname.toLowerCase()
  if (!/^[0-9a-f]{48}$/.test(token)) return null
  const segments = url.pathname.replace(/^\/+/, '').split('/').map(decodeURIComponent)
  if (segments.length < 2) return null
  const [packageId, ...rest] = segments
  const packagePath = rest.join('/')
  if (!packageId || !packagePath) return null
  if (rest.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) return null
  return { token, packageId, packagePath }
}
