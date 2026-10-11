import { afterEach, describe, expect, it, vi } from 'vitest'
import { openExtensionProviderTab } from './ExtensionPackages'
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
