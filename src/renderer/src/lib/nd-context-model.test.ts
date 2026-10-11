import { describe, expect, it } from 'vitest'
import type { NdContext } from '../../../shared/nd-context.js'
import type { OrganizationSnapshot } from '../../../shared/organization.js'
import { browserFocusView, contextOptions, currentContext, describeContextForUi } from './nd-context-model'

const personal: NdContext = { kind: 'personal' }
const company: NdContext = { kind: 'company', companyId: 'c1' }
const project: NdContext = { kind: 'project', companyId: 'c1', projectId: 'p1' }

const organization = {
  companies: [{ id: 'c1', name: 'Acme' }, { id: 'c2', name: 'Beta' }],
  projects: [{ id: 'p1', companyId: 'c1', name: 'Site' }],
  activeCompanyId: 'c1',
  activeProjectId: 'p1',
} as unknown as OrganizationSnapshot

describe('browser tab ownership', () => {
  it('presents Personal browsing in the Personal space', () => {
    expect(browserFocusView(personal)).toBe('personal')
  })

  it('keeps company and project browsing in the Agent workbench', () => {
    expect(browserFocusView(company)).toBe('agent')
    expect(browserFocusView(project)).toBe('agent')
  })
})

describe('context options', () => {
  it('lists Personal first, then companies, then their projects', () => {
    expect(contextOptions(organization).map((option) => option.id)).toEqual([
      'personal',
      'company:c1',
      'project:c1/p1',
      'company:c2',
    ])
  })

  it('falls back to Personal when no company exists yet', () => {
    const empty = { companies: [], projects: [] } as unknown as OrganizationSnapshot
    expect(currentContext(empty)).toEqual(personal)
    expect(contextOptions(empty)).toHaveLength(1)
  })

  it('describes each context in plain language', () => {
    expect(describeContextForUi(personal, organization)).toBe('Personal')
    expect(describeContextForUi(company, organization)).toBe('Acme')
    expect(describeContextForUi(project, organization)).toBe('Acme · Site')
  })
})
