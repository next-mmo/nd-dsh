import type { NdContext } from '../../../shared/nd-context.js'
import { contextKey } from '../../../shared/nd-context.js'
import type { NdCommandView } from '../../../shared/nd-invocations.js'
import type { OrganizationSnapshot } from '../../../shared/organization.js'

export interface ContextOption {
  id: string
  label: string
  detail: string
  context: NdContext
}

/** Personal first, then every company, then each company's projects. */
export function contextOptions(organization: OrganizationSnapshot | null): ContextOption[] {
  const options: ContextOption[] = [
    { id: 'personal', label: 'Personal', detail: 'Personal space', context: { kind: 'personal' } },
  ]
  for (const company of organization?.companies ?? []) {
    options.push({
      id: `company:${company.id}`,
      label: company.name,
      detail: 'Company',
      context: { kind: 'company', companyId: company.id },
    })
    for (const project of (organization?.projects ?? []).filter((item) => item.companyId === company.id)) {
      options.push({
        id: `project:${company.id}/${project.id}`,
        label: `${company.name} · ${project.name}`,
        detail: 'Project',
        context: { kind: 'project', companyId: company.id, projectId: project.id },
      })
    }
  }
  return options
}

/** The context implied by the app's current organization selection. */
export function currentContext(organization: OrganizationSnapshot | null): NdContext {
  const company = organization?.companies.find((item) => item.id === organization.activeCompanyId) ?? organization?.companies[0]
  if (!company) return { kind: 'personal' }
  const project = organization?.projects.find((item) => item.id === organization.activeProjectId && item.companyId === company.id)
  return project
    ? { kind: 'project', companyId: company.id, projectId: project.id }
    : { kind: 'company', companyId: company.id }
}

export function contextForOptionId(options: ContextOption[], id: string): NdContext | undefined {
  return options.find((option) => option.id === id)?.context
}

export function optionIdForContext(options: ContextOption[], context: NdContext): string | undefined {
  const key = contextKey(context)
  return options.find((option) => contextKey(option.context) === key)?.id
}

export function describeContextForUi(context: NdContext, organization: OrganizationSnapshot | null): string {
  if (context.kind === 'personal') return 'Personal'
  const company = organization?.companies.find((item) => item.id === context.companyId)
  if (context.kind === 'company') return company?.name ?? 'Company'
  const project = organization?.projects.find((item) => item.id === context.projectId)
  return project ? `${company?.name ?? 'Company'} · ${project.name}` : 'Project'
}

export type BrowserFocusView = 'personal' | 'agent'

/**
 * Where a browser tab opened by a context belongs. Personal browsing is
 * personal use, so it surfaces in the Personal space; a company or project tab
 * stays in the Agent workbench it was opened from. A tab never appears under
 * another context's chrome.
 */
export function browserFocusView(context: NdContext): BrowserFocusView {
  return context.kind === 'personal' ? 'personal' : 'agent'
}

export interface CommandRunPlan {
  input: Record<string, unknown>
  /** Set when the command cannot run with what the user typed. */
  missing?: string
}

/**
 * Deterministic mapping from one launcher command to its host-method input.
 * Agent-starting commands still require real text; note/search commands use
 * whatever the user typed, and the rest take no input at all.
 */
export function commandRunPlan(command: NdCommandView, typed: string): CommandRunPlan {
  const text = typed.trim()
  switch (command.host) {
    case 'note.create':
      return text ? { input: { text } } : { input: {}, missing: 'Type the note text first.' }
    case 'chat.ask':
      return text ? { input: { text } } : { input: {}, missing: 'Type what you want to ask ND.' }
    case 'note.search':
      return { input: text ? { query: text } : {} }
    case 'browser.search':
      return text ? { input: { query: text } } : { input: {}, missing: 'Type a search query first.' }
    case 'browser.openUrl':
      return { input: text ? { url: text } : {} }
    case 'browser.openExternal':
      return text ? { input: { url: text } } : { input: {}, missing: 'Type the address to open first.' }
    case 'os.openTarget': {
      const lowered = text.toLowerCase()
      const kind = /\b(app|application)\b/.test(lowered) ? 'app' : /\b(folder|directory)\b/.test(lowered) ? 'folder' : 'file'
      return { input: { kind } }
    }
    case 'workflow.refresh':
      return { input: {} }
    default:
      return { input: {} }
  }
}

/** Search text used by the launcher filter for one extension command. */
export function commandSearchText(command: NdCommandView): string {
  return [command.title, command.description ?? '', command.extensionId, ...command.keywords].join(' ').toLowerCase()
}
