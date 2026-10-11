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
