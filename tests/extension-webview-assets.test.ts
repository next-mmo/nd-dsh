import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { ExtensionWebViewAssets, parseWebviewAssetUrl } from '../src/main/extensions/webview-assets.js'
import { webviewAssetUrl } from '../src/shared/extension-webview.js'

const packagePath = fileURLToPath(new URL('../extensions/tic-tac-toe/', import.meta.url))

describe('parseWebviewAssetUrl', () => {
  const token = 'a'.repeat(48)

  it('parses the token-scoped package URL shape', () => {
    expect(parseWebviewAssetUrl(`nd-extension-ui://${token}/nd.tic-tac-toe/ui/index.html`)).toEqual({
      token,
      packageId: 'nd.tic-tac-toe',
      packagePath: 'ui/index.html',
    })
  })

  it('rejects foreign schemes, malformed tokens, and traversal', () => {
    expect(parseWebviewAssetUrl(`https://${token}/nd.tic-tac-toe/ui/index.html`)).toBeNull()
    expect(parseWebviewAssetUrl(`nd-extension-ui://short/nd.tic-tac-toe/ui/index.html`)).toBeNull()
    expect(parseWebviewAssetUrl(`nd-extension-ui://${token}/nd.tic-tac-toe/ui/../..//nd-extension.json`)).toBeNull()
    expect(parseWebviewAssetUrl(`nd-extension-ui://${token}/nd.tic-tac-toe/ui\\game.js`)).toBeNull()
    expect(parseWebviewAssetUrl(`nd-extension-ui://${token}/nd.tic-tac-toe`)).toBeNull()
  })

  it('round-trips with webviewAssetUrl encoding', () => {
    const url = webviewAssetUrl(token, 'nd.tic-tac-toe', 'ui/index.html')
    expect(parseWebviewAssetUrl(url)?.packagePath).toBe('ui/index.html')
  })
})

describe('ExtensionWebViewAssets serving', () => {
  let root: string
  let packages: ExtensionPackageStore
  let assets: ExtensionWebViewAssets

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nd-webview-assets-'))
    packages = new ExtensionPackageStore(join(root, 'packages'))
    assets = new ExtensionWebViewAssets(packages)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const install = async (): Promise<void> => {
    await packages.installFromDirectory(packagePath, { expectId: 'nd.tic-tac-toe' })
  }

  it('serves the entry document and package scripts for a live token', async () => {
    await install()
    const issued = await assets.issue('nd.tic-tac-toe', 'ui/index.html')
    expect(issued).toBeDefined()

    const entry = await assets.respond(issued!.url)
    expect(entry.status).toBe(200)
    expect(entry.headers['content-type']).toContain('text/html')
    expect(entry.headers['content-security-policy']).toContain("default-src 'none'")
    expect(entry.body!.toString()).toContain('<title>3D Tic-Tac-Toe</title>')

    const script = await assets.respond(webviewAssetUrl(issued!.token, 'nd.tic-tac-toe', 'ui/game.js'))
    expect(script.status).toBe(200)
    expect(script.headers['content-type']).toContain('text/javascript')

    const three = await assets.respond(webviewAssetUrl(issued!.token, 'nd.tic-tac-toe', 'ui/vendor/three.module.js'))
    expect(three.status).toBe(200)
    expect(three.body!.length).toBeGreaterThan(100_000)
  })

  it('answers 404 for revoked, unknown, foreign-package, traversal, and disallowed-type requests', async () => {
    await install()
    const issued = await assets.issue('nd.tic-tac-toe', 'ui/index.html')
    const { token, url } = issued!

    expect((await assets.respond(url)).status).toBe(200)

    // Another package's id, even with a valid token, never resolves.
    const foreign = await assets.respond(webviewAssetUrl(token, 'nd.other', 'ui/index.html'))
    expect(foreign.status).toBe(404)

    // Path traversal is contained by the snapshot resolver.
    const escape = await assets.respond(webviewAssetUrl(token, 'nd.tic-tac-toe', 'ui/../../nd-extension.json'))
    expect(escape.status).toBe(404)

    // Types outside the asset allowlist are refused (README.md is documentation, not UI).
    const docs = await assets.respond(webviewAssetUrl(token, 'nd.tic-tac-toe', 'README.md'))
    expect(docs.status).toBe(404)

    assets.revoke(token)
    expect((await assets.respond(url)).status).toBe(404)
    expect((await assets.respond(webviewAssetUrl(token, 'nd.tic-tac-toe', 'ui/game.js'))).status).toBe(404)
  })

  it('binds tokens to the installed version and expires stale ones', async () => {
    await install()
    let clock = 1_000_000
    const timed = new ExtensionWebViewAssets(packages, () => clock)
    const issued = await timed.issue('nd.tic-tac-toe', 'ui/index.html')
    expect((await timed.respond(issued!.url)).status).toBe(200)

    clock += 31 * 60 * 1000
    expect((await timed.respond(issued!.url)).status).toBe(404)
  })
})
