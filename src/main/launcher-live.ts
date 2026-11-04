import type { BrowserTabDescriptor } from '../shared/browser-platform.js'
import type {
  EngineSessionSummary,
  GatewayRpcResult,
  HarnessStatus,
  SessionSummary,
  WorkspaceRegistryView,
} from '../shared/contracts.js'
import {
  asLauncherKeepaliveReport,
  type LauncherKeepaliveView,
  type LauncherLiveItem,
  type LauncherLiveState,
} from '../shared/launcher-live.js'
import type { OrganizationSnapshot } from '../shared/organization.js'

interface HarnessSessionSource {
  status(): HarnessStatus
  gatewayRpc(method: string, payload?: unknown): Promise<GatewayRpcResult>
}

export interface LauncherLiveDependencies {
  engineSessions(): EngineSessionSummary[]
  harness: HarnessSessionSource
  organization(): Promise<OrganizationSnapshot>
  browserTabs(): Promise<BrowserTabDescriptor[]>
  workspaceRegistry(): Promise<WorkspaceRegistryView>
  workspaceRoot(): string
  now?(): number
}

const ORG_CACHE_MS = 3_000
const HARNESS_CACHE_MS = 1_500
const TABS_CACHE_MS = 1_000
const WORKSPACES_CACHE_MS = 5_000
const MAX_TAB_ITEMS = 12

function ttl<T>(ms: number, now: () => number, load: () => Promise<T>): () => Promise<T> {
  let value: T | undefined
  let at = 0
  let pending: Promise<T> | undefined
  return () => {
    if (value !== undefined && now() - at < ms) return Promise.resolve(value)
    if (pending) return pending
    pending = load()
      .then((next) => {
        value = next
        at = now()
        return next
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
}

function shortTitle(value: string | undefined, fallback: string): string {
  const title = value?.trim()
  return title ? title.slice(0, 160) : fallback
}

function harnessTitle(session: SessionSummary): string {
  const title = session.projections?.values?.title
  return shortTitle(typeof title === 'string' ? title : undefined, `Chat ${session.sessionId.slice(0, 8)}`)
}

function tabTitle(tab: BrowserTabDescriptor): string {
  const title = tab.title?.trim()
  if (title) return title.slice(0, 160)
  if (tab.url === 'about:blank') return 'New tab'
  try {
    const url = new URL(tab.url)
    return url.hostname || url.pathname || 'New tab'
  } catch {
    return 'New tab'
  }
}

/**
 * One snapshot of everything alive the launcher can jump back into. Harness
 * session listing boots the runtime, so it is only asked while the runtime is
 * already up; the rest are cheap in-memory reads with short TTLs.
 */
export function createLauncherLive(deps: LauncherLiveDependencies): {
  reportKeepalive(value: unknown): void
  state(): Promise<LauncherLiveState>
} {
  const now = deps.now ?? (() => Date.now())
  let keepaliveViews: LauncherKeepaliveView[] = []

  const organization = ttl(ORG_CACHE_MS, now, deps.organization)
  const workspaces = ttl(WORKSPACES_CACHE_MS, now, deps.workspaceRegistry)
  const tabs = ttl(TABS_CACHE_MS, now, () => deps.browserTabs().catch(() => []))
  const harnessSessions = ttl(HARNESS_CACHE_MS, now, async (): Promise<SessionSummary[]> => {
    const state = deps.harness.status().state
    // session.list boots the runtime; never start it just to draw the launcher.
    if (state !== 'ready' && state !== 'running') return []
    const result = await deps.harness.gatewayRpc('session.list', {}).catch(() => null)
    if (!result?.ok) return []
    const items = (result.value as { items?: unknown } | undefined)?.items
    if (!Array.isArray(items)) return []
    return items.filter((item): item is SessionSummary => Boolean(item)
      && typeof item === 'object'
      && typeof (item as SessionSummary).sessionId === 'string'
      && typeof (item as SessionSummary).updatedAt === 'number')
  })

  return {
    reportKeepalive(value: unknown): void {
      keepaliveViews = asLauncherKeepaliveReport(value)
    },

    async state(): Promise<LauncherLiveState> {
      const [org, harnessItems, tabItems, registry] = await Promise.all([
        organization(),
        harnessSessions(),
        tabs(),
        workspaces(),
      ])

      const runningRuns = org.runs
        .filter((run) => run.status === 'running')
        .sort((left, right) => right.startedAt - left.startedAt)
      const runSessionIds = new Set(runningRuns.map((run) => run.sessionId))
      const tasks = new Map(org.tasks.map((task) => [task.id, task]))

      const items: LauncherLiveItem[] = runningRuns.map((run) => {
        const task = run.taskId ? tasks.get(run.taskId) : undefined
        return {
          id: `run:${run.id}`,
          kind: 'run',
          title: shortTitle(task?.title, 'Agent run'),
          status: 'Agent',
          context: { kind: 'project', companyId: run.companyId, projectId: run.projectId },
          sessionId: run.sessionId,
          runId: run.id,
          updatedAt: run.startedAt,
        }
      })

      const chats: LauncherLiveItem[] = [
        ...deps.engineSessions()
          .filter((session) => session.running && session.archived !== true && !runSessionIds.has(session.sessionId))
          .map((session) => ({
            id: `chat:${session.sessionId}`,
            kind: 'chat' as const,
            title: shortTitle(session.title, `Chat ${session.sessionId.slice(0, 8)}`),
            status: 'Chat',
            sessionId: session.sessionId,
            updatedAt: session.updatedAt,
          })),
        ...harnessItems
          .filter((session) => session.running
            && session.archived !== true
            && session.parentSessionId === undefined
            && !runSessionIds.has(session.sessionId))
          .map((session) => ({
            id: `chat:${session.sessionId}`,
            kind: 'chat' as const,
            title: harnessTitle(session),
            status: 'Chat',
            sessionId: session.sessionId,
            updatedAt: session.updatedAt,
          })),
      ].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      items.push(...chats)

      for (const view of keepaliveViews) {
        items.push({
          id: `keepalive:${view.key}`,
          kind: 'keepalive',
          title: view.title.slice(0, 160),
          status: view.backgrounded ? 'Background' : 'Open',
          context: view.context,
          viewKey: view.key,
        })
      }

      for (const tab of tabItems.filter((entry) => entry.targetId === 'builtin').slice(0, MAX_TAB_ITEMS)) {
        items.push({
          id: `tab:${tab.id}`,
          kind: 'tab',
          title: tabTitle(tab),
          status: tab.active ? 'Active tab' : 'Tab',
          tabId: tab.id,
          url: tab.url,
        })
      }

      return {
        version: 1,
        items,
        workspace: {
          activeRoot: deps.workspaceRoot(),
          ...(registry.activeId ? { activeId: registry.activeId } : {}),
          saved: registry.items.map(({ id, name, root, lastOpenedAt }) => ({
            id,
            name,
            root,
            ...(lastOpenedAt !== undefined ? { lastOpenedAt } : {}),
          })),
        },
        updatedAt: now(),
      }
    },
  }
}
