import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExtensionDetailRows, openExtensionProviderTab } from './ExtensionPackages'
import type { NdViewData } from '../../../shared/nd-invocations'

const target = { extensionId: 'nd.translate', viewId: 'translator', context: { kind: 'personal' as const } }
const authorized: NdViewData = { ...target, title: 'ND Translate', kind: 'detail', rows: [], actions: [] }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
afterEach(() => vi.unstubAllGlobals())

describe('extension provider browser route', () => {
  it('rechecks the exact extension context before routing and then closes the current dialog', async () => {
    const loadView = vi.fn().mockResolvedValue(authorized)
    vi.stubGlobal('window', { ndDsh: { ndExtensions: { loadView } } })
    const open = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn()
    await openExtensionProviderTab(target, 'owned-tab', () => true, open, close)
    expect(loadView).toHaveBeenCalledWith('nd.translate', 'translator', { kind: 'personal' })
    expect(open).toHaveBeenCalledWith('owned-tab')
    expect(close).toHaveBeenCalledOnce()
  })

  it('cancels routing when the dialog closes or is replaced while authorization is pending', async () => {
    const pending = deferred<NdViewData>()
    vi.stubGlobal('window', { ndDsh: { ndExtensions: { loadView: () => pending.promise } } })
    let current = true
    const open = vi.fn()
    const close = vi.fn()
    const route = openExtensionProviderTab(target, 'owned-tab', () => current, open, close)
    current = false
    pending.resolve(authorized)
    await expect(route).rejects.toThrow('view was closed')
    expect(open).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('does not close a new dialog when an earlier provider route finishes', async () => {
    const pending = deferred<void>()
    vi.stubGlobal('window', { ndDsh: { ndExtensions: { loadView: vi.fn().mockResolvedValue(authorized) } } })
    let current = true
    const open = vi.fn().mockReturnValue(pending.promise)
    const close = vi.fn()
    const route = openExtensionProviderTab(target, 'owned-tab', () => current, open, close)
    await Promise.resolve()
    expect(open).toHaveBeenCalledOnce()
    current = false
    pending.resolve()
    await expect(route).rejects.toThrow('view was closed')
    expect(close).not.toHaveBeenCalled()
  })

  it.each([
    { ...authorized, extensionId: 'other.extension' },
    { ...authorized, viewId: 'other-view' },
    { ...authorized, context: { kind: 'company' as const, companyId: 'other-company' } },
  ])('rejects mismatched authorization results', async (value) => {
    vi.stubGlobal('window', { ndDsh: { ndExtensions: { loadView: vi.fn().mockResolvedValue(value) } } })
    const open = vi.fn()
    const close = vi.fn()
    await expect(openExtensionProviderTab(target, 'owned-tab', () => true, open, close)).rejects.toThrow('no longer available')
    expect(open).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('does not authorize or route an already closed dialog', async () => {
    const loadView = vi.fn()
    vi.stubGlobal('window', { ndDsh: { ndExtensions: { loadView } } })
    const open = vi.fn()
    const close = vi.fn()
    await expect(openExtensionProviderTab(target, 'owned-tab', () => false, open, close)).rejects.toThrow('view was closed')
    expect(loadView).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('keeps the dialog open when authorization is revoked or the browser tab cannot be opened', async () => {
    const loadView = vi.fn().mockRejectedValueOnce(new Error('Extension disabled')).mockResolvedValue(authorized)
    vi.stubGlobal('window', { ndDsh: { ndExtensions: { loadView } } })
    const open = vi.fn().mockRejectedValue(new Error('Browser tab closed'))
    const close = vi.fn()
    await expect(openExtensionProviderTab(target, 'owned-tab', () => true, open, close)).rejects.toThrow('Extension disabled')
    expect(open).not.toHaveBeenCalled()
    await expect(openExtensionProviderTab(target, 'owned-tab', () => true, open, close)).rejects.toThrow('Browser tab closed')
    expect(close).not.toHaveBeenCalled()
  })
})

import { detectExtensionCategory, extensionCategoryLabel } from '../../../shared/extension-package'

describe('extension package category filtering', () => {
  const samplePackages = [
    { id: 'nd.9router', name: '9Router', description: 'Local AI model gateway and proxy runtime', category: 'gateway-api' },
    { id: 'nd.api-studio', name: 'ND API Studio', description: 'HTTP API design and runner' },
    { id: 'nd.tic-tac-toe', name: '3D Tic-Tac-Toe', description: 'Play game on 3D board', category: 'games' },
    { id: 'nd.translate', name: 'ND Translate', description: 'Real-time text translation' },
    { id: 'nd.disk-cleaner', name: 'Disk Cleaner', description: 'Analyze disk space' },
    { id: 'nd.daily-essentials', name: 'Daily Essentials', description: 'Productivity notes and capture' },
  ]

  it('filters packages accurately by category chip selection', () => {
    const filterByCategory = (category: string) =>
      samplePackages.filter((pkg) => category === 'all' || detectExtensionCategory(pkg) === category)

    expect(filterByCategory('all')).toHaveLength(6)

    const gatewayPkgs = filterByCategory('gateway-api')
    expect(gatewayPkgs.map((p) => p.id)).toEqual(['nd.9router', 'nd.api-studio'])

    const gamesPkgs = filterByCategory('games')
    expect(gamesPkgs.map((p) => p.id)).toEqual(['nd.tic-tac-toe'])

    const aiPkgs = filterByCategory('ai')
    expect(aiPkgs.map((p) => p.id)).toEqual(['nd.translate'])

    const systemPkgs = filterByCategory('system')
    expect(systemPkgs.map((p) => p.id)).toEqual(['nd.disk-cleaner'])

    const toolsPkgs = filterByCategory('tools')
    expect(toolsPkgs.map((p) => p.id)).toEqual(['nd.daily-essentials'])
  })

  it('filters packages by both search query and category', () => {
    const filter = (query: string, category: string) => {
      const q = query.trim().toLowerCase()
      return samplePackages
        .filter((pkg) => !q || `${pkg.name} ${pkg.description} ${pkg.id}`.toLowerCase().includes(q))
        .filter((pkg) => category === 'all' || detectExtensionCategory(pkg) === category)
    }

    // "studio" in gateway-api
    expect(filter('studio', 'gateway-api').map((p) => p.id)).toEqual(['nd.api-studio'])
    // "studio" in games should be empty
    expect(filter('studio', 'games')).toHaveLength(0)
    // "game" in games
    expect(filter('game', 'games').map((p) => p.id)).toEqual(['nd.tic-tac-toe'])
  })
})

describe('extension detail rows', () => {
  it('renders status text without wallpaper thumbnail, preview, or apply controls', () => {
    const html = renderToStaticMarkup(createElement(ExtensionDetailRows, {
      extensionId: 'nd.9router',
      rows: [{
        id: 'row-0',
        title: '9Router installed (stopped)',
        body: 'Runtime is ready to start from ND Router or launcher.',
      }],
    }))
    expect(html).toContain('9Router installed (stopped)')
    expect(html).toContain('Runtime is ready to start from ND Router or launcher.')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('Preview')
    expect(html).not.toContain('>Apply<')
    expect(html).not.toContain('rows')
  })
})
