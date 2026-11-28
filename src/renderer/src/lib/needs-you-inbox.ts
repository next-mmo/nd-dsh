import type { OrganizationManagementAttentionItem } from '../../../shared/organization-control.js'
import type { OrganizationSnapshot } from '../../../shared/organization.js'
import type { AskQuestion } from '../../../shared/chat-types.js'
import { runtimePromptContext } from './runtime-prompt-context.js'

export type NeedsYouGroupBy = 'newest' | 'agent' | 'project'

export interface NeedsYouApprovalItem {
  kind: 'approval'
  id: string
  sessionId: string
  rpcId: string
  approvalId: string
  toolName: string
  reason?: string
  callId?: string
  action?: string
  createdAt: number
}

export interface NeedsYouQuestionItem {
  kind: 'question'
  id: string
  sessionId: string
  rpcId: string
  questions: AskQuestion[]
  createdAt: number
}

export interface NeedsYouOrganizationItem {
  kind: 'gate' | 'action' | 'failed-run' | 'stale-evidence'
  id: string
  sourceId: string
  companyId: string
  projectId?: string
  taskId?: string
  title: string
  detail: string
  createdAt: number
}

export type NeedsYouItem =
  | NeedsYouApprovalItem
  | NeedsYouQuestionItem
  | NeedsYouOrganizationItem

export interface NeedsYouPresentation {
  item: NeedsYouItem
  badge: string
  title: string
  summary: string
  agentName: string
  projectName: string
  companyName?: string
  taskTitle?: string
  workspace?: string
  sessionId?: string
  createdAt: number
}

export interface NeedsYouGroup {
  key: string
  label: string
  items: NeedsYouPresentation[]
}

export function orgAttentionToNeedsYou(items: readonly OrganizationManagementAttentionItem[]): NeedsYouOrganizationItem[] {
  return items.map((item) => ({
    kind: item.kind,
    id: `org:${item.kind}:${item.id}`,
    sourceId: item.id,
    companyId: item.companyId,
    ...(item.projectId ? { projectId: item.projectId } : {}),
    ...(item.taskId ? { taskId: item.taskId } : {}),
    title: item.title,
    detail: item.detail,
    createdAt: item.createdAt,
  }))
}

export function presentNeedsYouItem(
  item: NeedsYouItem,
  organization: OrganizationSnapshot | null,
): NeedsYouPresentation {
  if (item.kind === 'approval' || item.kind === 'question') {
    const context = runtimePromptContext(item.sessionId, organization)
    const badge = item.kind === 'approval' ? 'APPROVAL' : 'QUESTION'
    const title = item.kind === 'approval'
      ? item.toolName
      : (item.questions[0]?.question ?? 'Agent requested input')
    const summary = item.kind === 'approval'
      ? (item.reason ?? item.action ?? 'Approve or reject this tool request.')
      : (item.questions[0]?.detail ?? (item.questions.length > 1 ? `${item.questions.length} questions waiting for your answer.` : 'Waiting for your response.'))
    return {
      item,
      badge,
      title,
      summary,
      agentName: context.worker ?? 'Active agent',
      projectName: context.project ?? 'Interactive chat',
      ...(context.company ? { companyName: context.company } : {}),
      ...(context.task ? { taskTitle: context.task } : {}),
      ...(context.workspace ? { workspace: context.workspace } : {}),
      sessionId: item.sessionId,
      createdAt: item.createdAt,
    }
  }

  const company = organization?.companies.find((entry) => entry.id === item.companyId)
  const project = item.projectId
    ? organization?.projects.find((entry) => entry.id === item.projectId && entry.companyId === item.companyId)
    : undefined
  const task = item.taskId
    ? organization?.tasks.find((entry) => entry.id === item.taskId)
    : undefined
  const agent = task?.assignedAgentId
    ? organization?.agents.find((entry) => entry.id === task.assignedAgentId)
    : undefined
  const latestRun = item.taskId
    ? organization?.runs
        .filter((run) => run.taskId === item.taskId)
        .sort((a, b) => b.startedAt - a.startedAt)[0]
    : undefined

  const badgeMap: Record<NeedsYouOrganizationItem['kind'], string> = {
    gate: 'GATE',
    action: 'ACTION',
    'failed-run': 'FAILED',
    'stale-evidence': 'STALE',
  }

  return {
    item,
    badge: badgeMap[item.kind],
    title: item.title,
    summary: item.detail,
    agentName: agent?.name ?? (company?.name ?? 'Organization'),
    projectName: project?.name ?? (company?.name ?? 'Company'),
    ...(company?.name ? { companyName: company.name } : {}),
    ...(task?.title ? { taskTitle: task.title } : {}),
    ...(project?.workspacePath ? { workspace: project.workspacePath } : {}),
    ...(latestRun?.sessionId ? { sessionId: latestRun.sessionId } : {}),
    createdAt: item.createdAt,
  }
}

/**
 * Group and sort Needs You items. Live runtime prompts (approval/question) stay
 * ordered ahead of older background organization items inside "newest" when
 * timestamps tie, and every group sorts newest-first.
 */
export function groupNeedsYouItems(
  items: readonly NeedsYouItem[],
  organization: OrganizationSnapshot | null,
  groupBy: NeedsYouGroupBy,
): NeedsYouGroup[] {
  const presented = items
    .map((item) => presentNeedsYouItem(item, organization))
    .sort((a, b) => {
      const timeDelta = b.createdAt - a.createdAt
      if (timeDelta !== 0) return timeDelta
      const aLive = a.item.kind === 'approval' || a.item.kind === 'question' ? 1 : 0
      const bLive = b.item.kind === 'approval' || b.item.kind === 'question' ? 1 : 0
      return bLive - aLive
    })

  if (presented.length === 0) return []
  if (groupBy === 'newest') {
    return [{ key: 'all', label: 'All waiting', items: presented }]
  }

  const buckets = new Map<string, NeedsYouPresentation[]>()
  for (const entry of presented) {
    const label = groupBy === 'agent' ? entry.agentName : entry.projectName
    const key = label.toLowerCase()
    const list = buckets.get(key)
    if (list) list.push(entry)
    else buckets.set(key, [entry])
  }

  return Array.from(buckets.entries()).map(([key, entries]) => ({
    key,
    label: groupBy === 'agent' ? entries[0]!.agentName : entries[0]!.projectName,
    items: entries,
  }))
}

export function selectNextNeedsYouId(items: readonly NeedsYouItem[], currentId: string | null): string | null {
  if (items.length === 0) return null
  if (currentId && items.some((item) => item.id === currentId)) return currentId
  return items[0]!.id
}

export function formatRelativeAge(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1_440)}d`
}
