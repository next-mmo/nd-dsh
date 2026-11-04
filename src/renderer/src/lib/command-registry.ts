import type { LauncherLiveItem, LauncherWorkspaceView } from '../../../shared/launcher-live.js'
import type { NdCommandView } from '../../../shared/nd-invocations.js'
import type { OrganizationSnapshot } from '../../../shared/organization.js'
import type { ContextOption } from './nd-context-model.js'
import { commandSearchText, describeContextForUi } from './nd-context-model.js'
import { compactLauncherText, recentLauncherProjects } from './quick-launcher-model.js'

export type LauncherCommandIcon =
  | 'task'
  | 'note'
  | 'agent'
  | 'chat'
  | 'run'
  | 'keepalive'
  | 'tab'
  | 'workspace'
  | 'context'
  | 'kanban'
  | 'capture-screen'
  | 'capture-tools'
  | 'clipboard'
  | 'link'
  | 'extension'
  | 'project'
  | 'company'

export interface LauncherCommandItem {
  id: string
  sourceId: string
  group: string
  icon: LauncherCommandIcon
  title: string
  searchText: string
  shortcut?: string
  /** Context switches stay open; normal actions close the launcher before running. */
  closeOnRun?: boolean
  run(): void | Promise<void>
}

export interface LauncherCommandSource {
  id: string
  group: string
  order: number
  commands(input: LauncherCommandRegistryInput): LauncherCommandItem[]
}

export interface LauncherCommandActions {
  selectContext(id: string): void | Promise<void>
  openLiveItem(item: LauncherLiveItem): void | Promise<void>
  openWorkspace(id: string): void | Promise<void>
  openKanban(): void | Promise<void>
  openAgent(): void | Promise<void>
  activateProject(projectId: string): void | Promise<void>
  switchCompany(companyId: string): void | Promise<void>
  createTask(text: string): void | Promise<void>
  quickNote(text: string): void | Promise<void>
  askAgent(text: string): void | Promise<void>
  captureScreen(): void | Promise<void>
  openCaptureTools(): void | Promise<void>
  captureClipboard(): void | Promise<void>
  captureUrl(url: string): void | Promise<void>
  runExtension(command: NdCommandView, typed: string): void | Promise<void>
}

export interface LauncherCommandRegistryInput {
  query: string
  organization: OrganizationSnapshot | null
  currentUrl?: string
  contexts: ContextOption[]
  activeContextId?: string
  extensionCommands: NdCommandView[]
  /** Everything alive the launcher can jump back into. */
  liveItems?: LauncherLiveItem[]
  workspaces?: LauncherWorkspaceView | null
  actions: LauncherCommandActions
}

/**
 * Small ActionSource-style registry inspired by Magibar/Raycast launchers.
 *
 * The launcher no longer owns one giant hard-coded list. Core, organization,
 * and extension sources all contribute the same command shape, making future
 * native extensions/widgets/search providers additive rather than requiring a
 * central launcher rewrite.
 */
export class LauncherCommandRegistry {
  private readonly sources = new Map<string, LauncherCommandSource>()

  constructor(sources: readonly LauncherCommandSource[] = []) {
    for (const source of sources) this.register(source)
  }

  register(source: LauncherCommandSource): this {
    if (this.sources.has(source.id)) throw new Error(`Launcher command source already registered: ${source.id}`)
    this.sources.set(source.id, source)
    return this
  }

  list(input: LauncherCommandRegistryInput): LauncherCommandItem[] {
    return [...this.sources.values()]
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .flatMap((source) =>
        source.commands(input).map((command) => ({
          ...command,
          sourceId: source.id,
          group: source.group,
        })),
      )
  }
}

function item(
  sourceId: string,
  group: string,
  command: Omit<LauncherCommandItem, 'sourceId' | 'group'>,
): LauncherCommandItem {
  return { ...command, sourceId, group }
}

const typedSource: LauncherCommandSource = {
  id: 'core.typed',
  group: 'Use what you typed',
  order: 10,
  commands(input) {
    const text = input.query.trim()
    if (!text) return []
    return [
      item(this.id, this.group, {
        id: 'create-task',
        icon: 'task',
        title: `Create task · ${compactLauncherText(text)}`,
        searchText: `task ${text}`,
        shortcut: 'Task',
        run: () => input.actions.createTask(text),
      }),
      item(this.id, this.group, {
        id: 'quick-note',
        icon: 'note',
        title: `Quick note · ${compactLauncherText(text)}`,
        searchText: `note ${text}`,
        shortcut: 'Note',
        run: () => input.actions.quickNote(text),
      }),
      item(this.id, this.group, {
        id: 'ask-agent',
        icon: 'agent',
        title: `Ask agent · ${compactLauncherText(text)}`,
        searchText: `ask agent ${text}`,
        shortcut: 'Agent',
        run: () => input.actions.askAgent(text),
      }),
    ]
  },
}

/**
 * Everything alive right now: running chats and agent runs, retained extension
 * views, and open browser tabs. Selecting a row jumps back to it.
 */
const activeSource: LauncherCommandSource = {
  id: 'core.active',
  group: 'Active',
  order: 15,
  commands(input) {
    return (input.liveItems ?? []).map((live) => {
      const contextLabel = live.context ? describeContextForUi(live.context, input.organization) : ''
      return item(this.id, this.group, {
        id: live.id,
        icon: live.kind === 'chat' ? 'chat' : live.kind === 'run' ? 'run' : live.kind === 'keepalive' ? 'keepalive' : 'tab',
        title: live.title,
        searchText: ['active', 'running', live.kind, live.title, live.status, live.url ?? '', contextLabel].join(' ').toLowerCase(),
        shortcut: live.status,
        run: () => input.actions.openLiveItem(live),
      })
    })
  },
}

const contextSource: LauncherCommandSource = {
  id: 'core.context',
  group: 'Context',
  order: 20,
  commands(input) {
    return input.contexts.map((option) =>
      item(this.id, this.group, {
        id: option.id,
        icon: 'context',
        title: option.label,
        searchText: `context ${option.label} ${option.detail}`,
        shortcut: option.id === input.activeContextId ? 'Active' : option.detail,
        closeOnRun: false,
        run: () => input.actions.selectContext(option.id),
      }),
    )
  },
}

/** Pinned workspace folders; selecting one opens that folder as the workspace. */
const workspaceSource: LauncherCommandSource = {
  id: 'core.workspaces',
  group: 'Workspaces',
  order: 25,
  commands(input) {
    const workspace = input.workspaces
    if (!workspace) return []
    return workspace.saved.map((saved) => {
      const active = saved.id === workspace.activeId || saved.root === workspace.activeRoot
      return item(this.id, this.group, {
        id: saved.id,
        icon: 'workspace',
        title: saved.name,
        searchText: `workspace folder ${saved.name} ${saved.root}`.toLowerCase(),
        shortcut: active ? 'Active' : 'Workspace',
        run: () => input.actions.openWorkspace(saved.id),
      })
    })
  },
}

const quickActionsSource: LauncherCommandSource = {
  id: 'core.quick-actions',
  group: 'Quick actions',
  order: 30,
  commands(input) {
    return [
      item(this.id, this.group, {
        id: 'open-kanban',
        icon: 'kanban',
        title: 'Open Kanban',
        searchText: 'open kanban work board tasks',
        shortcut: 'Board',
        run: input.actions.openKanban,
      }),
      item(this.id, this.group, {
        id: 'open-agent',
        icon: 'agent',
        title: 'Ask Agent',
        searchText: 'ask agent chat workbench',
        shortcut: 'Agent',
        run: input.actions.openAgent,
      }),
    ]
  },
}

const captureSource: LauncherCommandSource = {
  id: 'core.capture',
  group: 'Capture',
  order: 40,
  commands(input) {
    const commands: LauncherCommandItem[] = [
      item(this.id, this.group, {
        id: 'capture-screen',
        icon: 'capture-screen',
        title: 'Capture External Screen',
        searchText: 'capture external screen screenshot',
        shortcut: '3s',
        run: input.actions.captureScreen,
      }),
      item(this.id, this.group, {
        id: 'capture-tools',
        icon: 'capture-tools',
        title: 'External Capture Tools',
        searchText: 'external capture tools area annotate inspect',
        shortcut: 'Area · Annotate',
        run: input.actions.openCaptureTools,
      }),
      item(this.id, this.group, {
        id: 'capture-clipboard',
        icon: 'clipboard',
        title: 'Capture Clipboard',
        searchText: 'capture clipboard text paste',
        run: input.actions.captureClipboard,
      }),
    ]
    if (input.currentUrl) {
      const url = input.currentUrl
      commands.push(item(this.id, this.group, {
        id: 'capture-url',
        icon: 'link',
        title: 'Capture Current URL',
        searchText: `capture current url link ${url}`,
        shortcut: url,
        run: () => input.actions.captureUrl(url),
      }))
    }
    return commands
  },
}

const extensionSource: LauncherCommandSource = {
  id: 'extensions',
  group: 'Extensions',
  order: 50,
  commands(input) {
    const typed = input.query.trim()
    return input.extensionCommands.map((command) =>
      item(this.id, this.group, {
        id: `${command.extensionId}:${command.contributionId}`,
        icon: 'extension',
        title: command.title,
        searchText: `extension ${commandSearchText(command)}`,
        shortcut: command.extensionId.replace(/^nd\./, ''),
        run: () => input.actions.runExtension(command, typed),
      }),
    )
  },
}

const recentProjectsSource: LauncherCommandSource = {
  id: 'organization.recent-projects',
  group: 'Recent projects',
  order: 60,
  commands(input) {
    const companies = input.organization?.companies ?? []
    return recentLauncherProjects(input.organization?.projects ?? []).map((project) => {
      const company = companies.find((candidate) => candidate.id === project.companyId)
      return item(this.id, this.group, {
        id: project.id,
        icon: 'project',
        title: project.name,
        searchText: `project ${project.name} ${company?.name ?? ''} ${project.objective}`,
        shortcut: company?.name ?? 'Project',
        run: () => input.actions.activateProject(project.id),
      })
    })
  },
}

const companiesSource: LauncherCommandSource = {
  id: 'organization.companies',
  group: 'Companies',
  order: 70,
  commands(input) {
    const companies = input.organization?.companies ?? []
    const active = companies.find((candidate) => candidate.id === input.organization?.activeCompanyId) ?? companies[0]
    return companies.map((company) =>
      item(this.id, this.group, {
        id: company.id,
        icon: 'company',
        title: company.name,
        searchText: `company ${company.name} ${company.mission}`,
        shortcut: company.id === active?.id ? 'Active' : 'Switch',
        run: () => input.actions.switchCompany(company.id),
      }),
    )
  },
}

export const DEFAULT_LAUNCHER_COMMAND_REGISTRY = new LauncherCommandRegistry([
  typedSource,
  activeSource,
  contextSource,
  workspaceSource,
  quickActionsSource,
  captureSource,
  extensionSource,
  recentProjectsSource,
  companiesSource,
])

export function launcherCommandGroups(items: readonly LauncherCommandItem[]): Array<{ group: string; items: LauncherCommandItem[] }> {
  const groups = new Map<string, LauncherCommandItem[]>()
  for (const command of items) {
    const existing = groups.get(command.group)
    if (existing) existing.push(command)
    else groups.set(command.group, [command])
  }
  return [...groups].map(([group, commands]) => ({ group, items: commands }))
}
