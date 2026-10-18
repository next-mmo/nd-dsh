import { describe, expect, it } from 'vitest'
import type { NdContext } from '../../../shared/nd-context'
import type { NdViewData } from '../../../shared/nd-invocations'
import type { OrganizationSnapshot } from '../../../shared/organization'
import { extensionKeepAliveContextLabel, extensionViewKey, type ExtensionKeepAliveView } from './extension-view-keepalive'

const organization = {
  companies: [{ id: 'c1', name: 'Acme' }],
  projects: [{ id: 'p1', companyId: 'c1', name: 'Site' }],
} as unknown as OrganizationSnapshot

function view(context: NdContext): ExtensionKeepAliveView {
  const data: NdViewData = {
    extensionId: 'nd.mini-browser',
    viewId: 'mini-browser',
    context,
    title: 'Mini Browser',
    kind: 'web',
    rows: [],
    actions: [],
  }
  return { key: extensionViewKey(data), data }
}

describe('keep-alive view identity', () => {
  it('keys the same view separately per context', () => {
    const personal = view({ kind: 'personal' })
    const project = view({ kind: 'project', companyId: 'c1', projectId: 'p1' })
    expect(personal.key).not.toBe(project.key)
    expect(personal.key).toBe('nd.mini-browser:mini-browser:personal')
    expect(project.key).toBe('nd.mini-browser:mini-browser:project:c1/p1')
  })

  it('names the context a running view belongs to, not the app selection', () => {
    expect(extensionKeepAliveContextLabel(view({ kind: 'personal' }), organization)).toBe('Personal')
    expect(extensionKeepAliveContextLabel(view({ kind: 'project', companyId: 'c1', projectId: 'p1' }), organization)).toBe('Acme · Site')
  })
})

// These exercise disposal decisions, without mounting a browser or iframe.
import { afterEach, beforeEach, vi } from 'vitest'
import { admitKeepAliveView, closeKeepAliveView, dockKeepAliveView, lookupKeepAliveView, pruneKeepAliveViews, reconcileExtensionKeepAlive, resetKeepAliveForReload } from './extension-view-keepalive'
import type { NdExtensionsStateView } from '../../../shared/nd-invocations'

const ids = ['nd.one', 'nd.two', 'nd.three']
function runtimeState(backgroundExtensionIds: string[] = [], maxBackgroundViews = 4): NdExtensionsStateView {
  return {
    packages: ids.map((id) => ({ id, version: '1.0.0' })) as NdExtensionsStateView['packages'],
    activations: ids.map((id) => ({ extensionId: id, contextKey: 'personal', context: { kind: 'personal' }, enabled: true, settings: {}, updatedAt: 1 })),
    grants: [], audit: [], pendingApprovals: [],
    runtimePolicy: { backgroundExtensionIds, maxBackgroundViews, idleTimeoutMinutes: 1 },
  }
}
function data(id: string): NdViewData { return { ...view({ kind: 'personal' }).data, extensionId: id, webView: { entry: 'ui/index.html', version: '1.0.0', url: `nd-extension-ui://${id}/ui/index.html`, token: `tok-${id}` } } }

beforeEach(() => reconcileExtensionKeepAlive({ ...runtimeState(), packages: [] }))
afterEach(() => { reconcileExtensionKeepAlive({ ...runtimeState(), packages: [] }); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('bounded extension backgrounds', () => {
  it('unloads on close by default', async () => {
    reconcileExtensionKeepAlive(runtimeState())
    const key = admitKeepAliveView(data('nd.one'))
    dockKeepAliveView(key, null)
    await Promise.resolve()
    expect(lookupKeepAliveView(key)).toBeUndefined()
  })

  it('retains opted-in views, evicts the oldest background, and releases idle views', async () => {
    reconcileExtensionKeepAlive(runtimeState(ids, 1))
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const first = admitKeepAliveView(data(ids[0]!))
    dockKeepAliveView(first, null)
    await Promise.resolve()
    expect(lookupKeepAliveView(first)).toBeDefined()
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const second = admitKeepAliveView(data(ids[1]!))
    dockKeepAliveView(second, null)
    await Promise.resolve()
    expect(lookupKeepAliveView(first)).toBeUndefined()
    expect(lookupKeepAliveView(second)).toBeDefined()
    pruneKeepAliveViews(62_000)
    expect(lookupKeepAliveView(second)).toBeUndefined()
  })

  it('closes live views after deactivation, uninstall, or version changes', () => {
    for (const change of ['disable', 'uninstall', 'update']) {
      const state = runtimeState(ids)
      reconcileExtensionKeepAlive(state)
      const key = admitKeepAliveView(data('nd.one'))
      if (change === 'disable') state.activations[0]!.enabled = false
      if (change === 'uninstall') state.packages = state.packages.slice(1)
      if (change === 'update') state.packages[0]!.version = '2.0.0'
      reconcileExtensionKeepAlive(state)
      expect(lookupKeepAliveView(key)).toBeUndefined()
      closeKeepAliveView(key)
    }
  })

  it('does not evict the foreground view or destroy it during a ref reattachment', async () => {
    reconcileExtensionKeepAlive(runtimeState([], 0))
    const key = admitKeepAliveView(data('nd.one'))
    dockKeepAliveView(key, null)
    dockKeepAliveView(key, {} as HTMLElement)
    await Promise.resolve()
    pruneKeepAliveViews(100_000)
    expect(lookupKeepAliveView(key)).toBeDefined()
  })

  it('persists keep-alive views across hard reload only while the extension remains active and opted-in', async () => {
    const store = new Map<string, string>()
    const loadView = vi.fn(async (extensionId: string, viewId: string, context: NdContext): Promise<NdViewData> => ({
      ...data(extensionId),
      viewId,
      context,
      webView: { entry: 'ui/index.html', version: '1.0.0', url: `nd-extension-ui://reloaded-${extensionId}/ui/index.html`, token: `reloaded-${extensionId}` },
    }))
    const closeWebView = vi.fn(async () => undefined)
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v) },
        removeItem: (k: string) => { store.delete(k) },
      },
      ndDsh: { ndExtensions: { loadView, closeWebView } },
    })

    const state = runtimeState(['nd.one', 'nd.two'], 2)
    reconcileExtensionKeepAlive(state)
    const keyOne = admitKeepAliveView(data('nd.one'))
    const keyTwo = admitKeepAliveView(data('nd.two'))
    dockKeepAliveView(keyOne, null)
    dockKeepAliveView(keyTwo, null)
    await Promise.resolve()

    // Simulate a hard reload: in-memory state clears while storage survives.
    resetKeepAliveForReload()
    expect(lookupKeepAliveView(keyOne)).toBeUndefined()
    expect(lookupKeepAliveView(keyTwo)).toBeUndefined()

    // Deactivate nd.two before boot reconciliation: only active nd.one should restore.
    state.activations[1]!.enabled = false
    reconcileExtensionKeepAlive(state)
    await Promise.resolve()
    await Promise.resolve()

    expect(loadView).toHaveBeenCalledTimes(1)
    expect(loadView).toHaveBeenCalledWith('nd.one', 'mini-browser', { kind: 'personal' })
    expect(lookupKeepAliveView(keyOne)?.webView?.token).toBe('reloaded-nd.one')
    expect(lookupKeepAliveView(keyTwo)).toBeUndefined()

    // Truly closing the restored tab clears persisted storage so a subsequent reload stays empty.
    closeKeepAliveView(keyOne)
    resetKeepAliveForReload()
    reconcileExtensionKeepAlive(state)
    await Promise.resolve()
    expect(loadView).toHaveBeenCalledTimes(1)
    expect(lookupKeepAliveView(keyOne)).toBeUndefined()
  })
})

