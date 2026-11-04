import { describe, expect, it, vi } from 'vitest'
import type { BrowserTabDescriptor } from '../src/shared/browser-platform.js'
import type { EngineSessionSummary, HarnessStatus, SessionSummary } from '../src/shared/contracts.js'
import type { OrganizationSnapshot } from '../src/shared/organization.js'
import { createLauncherLive, type LauncherLiveDependencies } from '../src/main/launcher-live.js'

const NOW = 1_000

function engineSession(overrides: Partial<EngineSessionSummary> = {}): EngineSessionSummary {
  return {
    sessionId: 'engine-1',
    engineId: 'codex-cli',
    title: 'Engine chat',
    createdAt: NOW - 10,
    updatedAt: NOW - 5,
    running: true,
    ...overrides,
  }
}

function harnessSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'harness-1',
    updatedAt: NOW - 6,
    running: true,
    blank: false,
    ...overrides,
  }
}

function tab(overrides: Partial<BrowserTabDescriptor> = {}): BrowserTabDescriptor {
  return {
    id: 'tab-1',
    targetId: 'builtin',
    profileId: 'builtin:default',
    title: 'Docs',
    url: 'https://example.com/docs',
    active: false,
    visible: true,
    ...overrides,
  }
}

function organization(overrides: Partial<OrganizationSnapshot> = {}): OrganizationSnapshot {
  return {
    runs: [],
    tasks: [],
    companies: [],
    projects: [],
    ...overrides,
  } as unknown as OrganizationSnapshot
}

function live(overrides: Partial<LauncherLiveDependencies> & {
  harnessState?: HarnessStatus['state']
  harnessItems?: SessionSummary[]
  org?: OrganizationSnapshot
  tabs?: BrowserTabDescriptor[]
} = {}) {
  const gatewayRpc = vi.fn(async () => ({
    ok: true,
    value: { items: overrides.harnessItems ?? [] },
  }))
  const dependencies: LauncherLiveDependencies = {
    engineSessions: () => overrides.engineSessions?.() ?? [],
    harness: {
      status: () => ({ state: overrides.harnessState ?? 'ready' } as HarnessStatus),
      gatewayRpc,
    },
    organization: async () => overrides.org ?? organization(),
    browserTabs: async () => overrides.tabs ?? [],
    workspaceRegistry: async () => overrides.workspaceRegistry
      ? await overrides.workspaceRegistry()
      : { version: 1, items: [] },
    workspaceRoot: () => 'C:/work/nd',
    now: () => NOW,
  }
  return { launcher: createLauncherLive(dependencies), gatewayRpc }
}

describe('createLauncherLive', () => {
  it('lists running agent runs first, then running chats without duplicating run sessions', async () => {
    const { launcher } = live({
      harnessState: 'running',
      harnessItems: [
        harnessSession({
          sessionId: 's-harness',
          updatedAt: NOW - 3,
          projections: { asOfSeq: 1, values: { title: 'Fix the sidebar' } },
        }),
        harnessSession({ sessionId: 's-run', updatedAt: NOW - 2 }),
        harnessSession({ sessionId: 's-child', parentSessionId: 's-harness', updatedAt: NOW - 1 }),
      ],
      engineSessions: () => [engineSession({ sessionId: 's-engine', title: 'Web chat' })],
      org: organization({
        runs: [{
          id: 'run-1',
          companyId: 'c1',
          projectId: 'p1',
          taskId: 't1',
          kind: 'execute',
          status: 'running',
          sessionId: 's-run',
          startedAt: NOW - 20,
        }],
        tasks: [{ id: 't1', title: 'Ship the launcher' }],
      } as unknown as OrganizationSnapshot),
    })

    const state = await launcher.state()

    expect(state.items.map((item) => item.id)).toEqual([
      'run:run-1',
      'chat:s-harness',
      'chat:s-engine',
    ])
    expect(state.items[0]).toMatchObject({
      kind: 'run',
      title: 'Ship the launcher',
      status: 'Agent',
      sessionId: 's-run',
      context: { kind: 'project', companyId: 'c1', projectId: 'p1' },
    })
    expect(state.items[1]).toMatchObject({ title: 'Fix the sidebar', status: 'Chat' })
    expect(state.items[2]).toMatchObject({ title: 'Web chat', status: 'Chat' })
  })

  it('never boots the harness just to list sessions', async () => {
    const { launcher, gatewayRpc } = live({ harnessState: 'stopped', harnessItems: [harnessSession()] })

    const state = await launcher.state()

    expect(gatewayRpc).not.toHaveBeenCalled()
    expect(state.items).toEqual([])
  })

  it('merges bounded keep-alive reports and drops malformed entries', async () => {
    const { launcher } = live()
    launcher.reportKeepalive([
      {
        key: 'nd.mini-browser:board:personal',
        extensionId: 'nd.mini-browser',
        viewId: 'board',
        title: 'Mini Browser',
        context: { kind: 'personal' },
        backgrounded: true,
      },
      { key: 'broken', extensionId: '', viewId: 'board', title: 'Broken', context: { kind: 'personal' }, backgrounded: false },
      {
        key: 'nd.youtube:player:personal',
        extensionId: 'nd.youtube',
        viewId: 'player',
        title: 'Player',
        context: { kind: 'personal' },
        backgrounded: false,
      },
    ])

    const state = await launcher.state()

    expect(state.items.map((item) => item.id)).toEqual([
      'keepalive:nd.mini-browser:board:personal',
      'keepalive:nd.youtube:player:personal',
    ])
    expect(state.items[0]).toMatchObject({ kind: 'keepalive', status: 'Background', viewKey: 'nd.mini-browser:board:personal' })
    expect(state.items[1]).toMatchObject({ status: 'Open' })
  })

  it('lists builtin browser tabs and saved workspaces', async () => {
    const tabs = [
      tab({ id: 'tab-active', title: 'Inbox', active: true }),
      tab({ id: 'tab-plain', title: '', url: 'about:blank' }),
      tab({ id: 'tab-other', targetId: 'companion' }),
    ]
    const { launcher } = live({
      tabs,
      workspaceRegistry: async () => ({
        version: 1,
        activeId: 'w1',
        items: [
          { id: 'w1', name: 'nd-dsh', root: 'C:/work/nd', addedAt: NOW },
          { id: 'w2', name: 'docs', root: 'C:/work/docs', addedAt: NOW },
        ],
      }),
    })

    const state = await launcher.state()

    expect(state.items.map((item) => item.id)).toEqual(['tab:tab-active', 'tab:tab-plain'])
    expect(state.items[0]).toMatchObject({ status: 'Active tab', tabId: 'tab-active' })
    expect(state.items[1]).toMatchObject({ title: 'New tab', status: 'Tab' })
    expect(state.workspace).toMatchObject({
      activeRoot: 'C:/work/nd',
      activeId: 'w1',
      saved: [
        { id: 'w1', name: 'nd-dsh', root: 'C:/work/nd' },
        { id: 'w2', name: 'docs', root: 'C:/work/docs' },
      ],
    })
  })
})
