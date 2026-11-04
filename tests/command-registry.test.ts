import { describe, expect, it, vi } from 'vitest'
import type { OrganizationSnapshot } from '../src/shared/organization.js'
import {
  DEFAULT_LAUNCHER_COMMAND_REGISTRY,
  LauncherCommandRegistry,
  launcherCommandGroups,
  type LauncherCommandActions,
} from '../src/renderer/src/lib/command-registry.js'

const organization = {
  activeCompanyId: 'c1',
  activeProjectId: 'p1',
  companies: [
    { id: 'c1', name: 'Company One', mission: 'Ship one', updatedAt: 10 },
    { id: 'c2', name: 'Company Two', mission: 'Ship two', updatedAt: 9 },
  ],
  projects: [
    { id: 'p1', companyId: 'c1', name: 'Project One', objective: 'One', updatedAt: 30 },
    { id: 'p2', companyId: 'c2', name: 'Project Two', objective: 'Two', updatedAt: 20 },
  ],
} as unknown as OrganizationSnapshot

function actions(): LauncherCommandActions {
  return {
    selectContext: vi.fn(),
    openLiveItem: vi.fn(),
    openWorkspace: vi.fn(),
    openKanban: vi.fn(),
    openAgent: vi.fn(),
    activateProject: vi.fn(),
    switchCompany: vi.fn(),
    createTask: vi.fn(),
    quickNote: vi.fn(),
    askAgent: vi.fn(),
    captureScreen: vi.fn(),
    openCaptureTools: vi.fn(),
    captureClipboard: vi.fn(),
    captureUrl: vi.fn(),
    runExtension: vi.fn(),
  }
}

describe('LauncherCommandRegistry', () => {
  it('merges core, organization, and extension sources into one ordered registry', () => {
    const result = DEFAULT_LAUNCHER_COMMAND_REGISTRY.list({
      query: 'ship it',
      organization,
      currentUrl: 'https://example.com',
      contexts: [{ id: 'personal', label: 'Personal', detail: 'Personal', context: { kind: 'personal' } }],
      activeContextId: 'personal',
      extensionCommands: [{
        extensionId: 'nd.wallpaper-manager',
        contributionId: 'choose-wallpaper',
        title: 'Choose wallpaper',
        keywords: ['wallpaper'],
        contexts: ['personal'],
        startsAgent: false,
        host: 'os.wallpaper.chooseAndSet',
        permission: 'os.wallpaper.write',
      }],
      actions: actions(),
    })

    expect(result.map((item) => item.sourceId)).toEqual(expect.arrayContaining([
      'core.typed',
      'core.context',
      'core.quick-actions',
      'core.capture',
      'extensions',
      'organization.recent-projects',
      'organization.companies',
    ]))
    expect(result.find((item) => item.id === 'nd.wallpaper-manager:choose-wallpaper')?.group).toBe('Extensions')
    expect(result.find((item) => item.id === 'capture-url')?.shortcut).toBe('https://example.com')
    expect(result.find((item) => item.id === 'p1')?.group).toBe('Recent projects')
  })

  it('lists live items above context and saved workspaces below it', async () => {
    const callbacks = actions()
    const liveItem = {
      id: 'chat:s1',
      kind: 'chat' as const,
      title: 'Running fix',
      status: 'Chat',
      sessionId: 's1',
      updatedAt: 5,
    }
    const workspace = {
      activeRoot: 'C:/work/nd',
      activeId: 'w1',
      saved: [
        { id: 'w1', name: 'nd-dsh', root: 'C:/work/nd' },
        { id: 'w2', name: 'docs', root: 'C:/work/docs' },
      ],
    }
    const result = DEFAULT_LAUNCHER_COMMAND_REGISTRY.list({
      query: '',
      organization,
      contexts: [{ id: 'personal', label: 'Personal', detail: 'Personal', context: { kind: 'personal' } }],
      extensionCommands: [],
      liveItems: [liveItem],
      workspaces: workspace,
      actions: callbacks,
    })

    const groupOrder = launcherCommandGroups(result).map((group) => group.group)
    expect(groupOrder.filter((group) => group === 'Active' || group === 'Context' || group === 'Workspaces'))
      .toEqual(['Active', 'Context', 'Workspaces'])
    expect(launcherCommandGroups(result).find((group) => group.group === 'Workspaces')?.items).toHaveLength(2)
    expect(result.find((item) => item.id === 'chat:s1')?.shortcut).toBe('Chat')
    expect(result.find((item) => item.id === 'w1')?.shortcut).toBe('Active')
    expect(result.find((item) => item.id === 'w2')?.shortcut).toBe('Workspace')

    await result.find((item) => item.id === 'chat:s1')!.run()
    expect(callbacks.openLiveItem).toHaveBeenCalledWith(liveItem)
    await result.find((item) => item.id === 'w2')!.run()
    expect(callbacks.openWorkspace).toHaveBeenCalledWith('w2')
  })

  it('executes the action supplied by a source instead of embedding launcher behavior', async () => {
    const callbacks = actions()
    const command = DEFAULT_LAUNCHER_COMMAND_REGISTRY.list({
      query: '',
      organization,
      contexts: [],
      extensionCommands: [],
      actions: callbacks,
    }).find((item) => item.id === 'open-kanban')

    expect(command).toBeDefined()
    await command!.run()
    expect(callbacks.openKanban).toHaveBeenCalledOnce()
  })

  it('rejects duplicate source ids and groups commands without losing registry order', () => {
    const registry = new LauncherCommandRegistry()
    const source = { id: 'x', group: 'X', order: 1, commands: () => [] }
    registry.register(source)
    expect(() => registry.register(source)).toThrow(/already registered/)

    const groups = launcherCommandGroups([
      { id: 'a', sourceId: 'a', group: 'First', icon: 'agent', title: 'A', searchText: 'a', run: () => undefined },
      { id: 'b', sourceId: 'b', group: 'Second', icon: 'agent', title: 'B', searchText: 'b', run: () => undefined },
      { id: 'c', sourceId: 'c', group: 'First', icon: 'agent', title: 'C', searchText: 'c', run: () => undefined },
    ])
    expect(groups.map((group) => group.group)).toEqual(['First', 'Second'])
    expect(groups[0]!.items.map((item) => item.id)).toEqual(['a', 'c'])
  })
})
