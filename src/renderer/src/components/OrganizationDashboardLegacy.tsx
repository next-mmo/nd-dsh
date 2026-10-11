import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, MoreHorizontal, Trash2 } from 'lucide-react'
import type { CodingEngineDescriptor, ModelProvider, WorkspaceState } from '../../../shared/contracts'
import type { CapabilityAssignmentSnapshot, CapabilityDescriptor, CapabilityKind, CapabilityProviderStatus } from '../../../shared/capabilities'
import { DEFAULT_CAPABILITY_PROVIDER } from '../../../shared/capabilities'
import { ND_HARNESS_ENGINE_ID } from '../../../shared/coding-engines'
import type { OrganizationPolicyEffect, OrganizationRun, OrganizationRunReceipt, OrganizationSnapshot, OrganizationSubagentMode, OrganizationTask, ProjectRuntimeStatus, TaskPriority } from '../../../shared/organization'
import { DEFAULT_PROJECT_PORT } from '../../../shared/organization'
import { compareDeliveryTasks, taskInDeliveryScope } from '../../../shared/organization-delivery'
import { DeliveryMilestones } from './DeliveryMilestones'
import type { RepositoryBoardCard, RepositoryWorkflowPrd, RepositoryWorkflowTask, WorkflowProjectView } from '../../../shared/workflow-plugins'
import { projectRepositoryBoard, WORKFLOW_BOARD_COLUMNS } from '../../../shared/workflow-plugins'
import { Card as UiCard } from './ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Input } from './ui/input'
import { WorkflowIntegrationPanel } from './WorkflowIntegrationPanel'
import { cn } from '../lib/utils'

interface Props {
  workspace: WorkspaceState | null
  onOpenDeepSeek(): void
  /** Hands a prepared prompt to the agent console (prefills the chat). */
  onAskAgent?(prompt: string): void
  onError(message: string): void
}

type Section = 'overview' | 'work' | 'workforce' | 'knowledge'
type BoardStatus = 'ready' | 'in_progress' | 'review' | 'blocked' | 'completed'
const BOARD_STATUSES: BoardStatus[] = ['ready', 'in_progress', 'review', 'blocked', 'completed']

const orgButton = cn(
  'h-7 shrink-0 rounded-md border border-border-strong bg-secondary px-[9px] text-sm text-soft transition-colors',
  'hover:bg-accent hover:text-foreground',
  'disabled:pointer-events-none disabled:opacity-45',
)
const orgPrimaryButton = cn(
  'h-7 shrink-0 rounded-md border border-primary/30 bg-primary/10 px-[9px] text-sm font-medium text-primary transition-colors',
  'hover:bg-primary/[0.16]',
  'disabled:pointer-events-none disabled:opacity-45',
)
const orgInput = cn(
  'min-w-0 rounded-md border border-border-strong bg-background px-[9px] py-[7px] text-sm text-foreground outline-none',
  'focus:border-primary/40',
)
const CAPABILITY_SELECTS: Array<{ kind: CapabilityKind; label: string; title: string }> = [
  { kind: 'memory', label: 'Memory', title: 'Durable recall source used when this employee runs' },
  { kind: 'context', label: 'Context', title: 'How workspace understanding is gathered before this employee runs' },
]

export function OrganizationDashboard({ workspace, onOpenDeepSeek, onAskAgent, onError }: Props) {
  const [state, setState] = useState<OrganizationSnapshot | null>(null)
  const [section, setSection] = useState<Section>('work')
  const [busy, setBusy] = useState<string | null>(null)
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  // Runs a human started from this screen: when one fails later (runs finish
  // asynchronously), the failure is raised here instead of only in Live runs.
  const [watchedRuns, setWatchedRuns] = useState<Record<string, string>>({})
  const [companyDraft, setCompanyDraft] = useState({ name: '', mission: '' })
  const [showCreateCompany, setShowCreateCompany] = useState(false)
  const [projectDraft, setProjectDraft] = useState({ name: '', objective: '', workspacePath: workspace?.root ?? '' })
  const [taskDraft, setTaskDraft] = useState({ title: '', description: '', priority: 'medium' as TaskPriority })
  const [columnDraft, setColumnDraft] = useState<{ status: BoardStatus; title: string; description: string } | null>(null)
  const [memoryDraft, setMemoryDraft] = useState({ title: '', content: '' })
  const [engines, setEngines] = useState<CodingEngineDescriptor[]>([])
  const [engineAssignments, setEngineAssignments] = useState<Record<string, string>>({})
  const [capabilityProviders, setCapabilityProviders] = useState<CapabilityDescriptor[]>([])
  const [capabilityAssignments, setCapabilityAssignments] = useState<CapabilityAssignmentSnapshot>({ version: 1, agents: {}, roles: {}, teams: {} })
  const [capabilityStatuses, setCapabilityStatuses] = useState<Record<string, CapabilityProviderStatus>>({})
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [runtime, setRuntime] = useState<ProjectRuntimeStatus | null>(null)
  const [runtimeDraft, setRuntimeDraft] = useState({ startCommand: '', testCommand: '', targetUrl: '', targetPort: '', healthCheckPath: '' })
  const [workflowView, setWorkflowView] = useState<WorkflowProjectView>({})
  const [showWorkflow, setShowWorkflow] = useState(false)
  const [repoTaskPath, setRepoTaskPath] = useState<string | null>(null)
  const [removeProjectId, setRemoveProjectId] = useState<string | null>(null)
  const [removalRuntime, setRemovalRuntime] = useState<ProjectRuntimeStatus | null>(null)

  useEffect(() => {
    let mounted = true
    const refreshProviders = (): void => {
      void window.ndDsh.providers.list()
        .then((loaded) => { if (mounted) setProviders(loaded) })
        .catch((cause) => onError(errorMessage(cause)))
    }
    refreshProviders()
    return () => { mounted = false }
  }, [onError, section])

  useEffect(() => {
    let mounted = true
    void window.ndDshOrganization.state().then((value) => { if (mounted) setState(value) }).catch((cause) => onError(errorMessage(cause)))
    const off = window.ndDshOrganization.onChanged(setState)
    return () => { mounted = false; off() }
  }, [onError])

  useEffect(() => {
    let mounted = true
    void Promise.all([window.ndDsh.engines.list(), window.ndDsh.engines.assignments(), window.ndDsh.capabilities.providers(), window.ndDsh.capabilities.assignments(), window.ndDsh.capabilities.statuses()])
      .then(([catalog, engineRouting, providers, assignments, statuses]) => {
        if (!mounted) return
        setEngines(catalog)
        setEngineAssignments(engineRouting)
        setCapabilityProviders(providers)
        setCapabilityAssignments(assignments)
        setCapabilityStatuses(statuses)
      })
      .catch((cause) => onError(errorMessage(cause)))
    const offAssignments = window.ndDsh.capabilities.onChanged((value) => { if (mounted) setCapabilityAssignments(value) })
    const offStatuses = window.ndDsh.capabilities.onStatusChanged((value) => { if (mounted) setCapabilityStatuses(value) })
    return () => { mounted = false; offAssignments(); offStatuses() }
  }, [onError])

  const company = useMemo(() => state?.companies.find((item) => item.id === state.activeCompanyId) ?? null, [state])
  const projects = useMemo(() => state?.projects.filter((item) => item.companyId === company?.id) ?? [], [state, company?.id])
  const project = useMemo(() => projects.find((item) => item.id === state?.activeProjectId) ?? projects[0] ?? null, [projects, state?.activeProjectId])
  const tasks = useMemo(() => state?.tasks.filter((item) => item.projectId === project?.id) ?? [], [state, project?.id])
  const milestones = useMemo(() => state?.milestones.filter((item) => item.projectId === project?.id).sort((a, b) => a.order - b.order) ?? [], [state, project?.id])
  const boardTasks = useMemo(() => tasks.filter((task) => project && (taskInDeliveryScope(task, project) || task.status === 'in_progress' || task.status === 'review')).sort(compareDeliveryTasks), [tasks, project])
  const otherTasks = useMemo(() => tasks.filter((task) => !boardTasks.some((visible) => visible.id === task.id)).sort(compareDeliveryTasks), [tasks, boardTasks])
  const editingTask = useMemo(() => state?.tasks.find((item) => item.id === editingTaskId) ?? null, [state, editingTaskId])
  const goals = useMemo(() => state?.goals.filter((item) => item.projectId === project?.id) ?? [], [state, project?.id])
  const agents = useMemo(() => state?.agents.filter((item) => item.companyId === company?.id) ?? [], [state, company?.id])
  const teams = useMemo(() => state?.teams.filter((item) => item.companyId === company?.id) ?? [], [state, company?.id])
  const roles = useMemo(() => state?.roles.filter((item) => item.companyId === company?.id) ?? [], [state, company?.id])
  const policies = useMemo(() => state?.policies.filter((item) => item.companyId === company?.id) ?? [], [state, company?.id])
  const memory = useMemo(() => state?.memory.filter((item) => item.companyId === company?.id && (!item.projectId || item.projectId === project?.id)) ?? [], [state, company?.id, project?.id])
  const runs = useMemo(() => state?.runs.filter((item) => item.companyId === company?.id && (!project || item.projectId === project.id)).slice(0, 8) ?? [], [state, company?.id, project])
  /** What ND would forget for a project: used to state the cost before removal. */
  const removalTarget = useMemo(() => {
    if (!removeProjectId || !state) return null
    const candidate = state.projects.find((item) => item.id === removeProjectId)
    if (!candidate) return null
    return {
      project: candidate,
      tasks: state.tasks.filter((item) => item.projectId === candidate.id).length,
      goals: state.goals.filter((item) => item.projectId === candidate.id).length,
      milestones: state.milestones.filter((item) => item.projectId === candidate.id).length,
      runs: state.runs.filter((item) => item.projectId === candidate.id).length,
      activeRuns: state.runs.filter((item) => item.projectId === candidate.id && item.status === 'running').length,
    }
  }, [removeProjectId, state])

  // Removal stops the project's live work, so the dialog says exactly what that is.
  useEffect(() => {
    if (!removeProjectId) {
      setRemovalRuntime(null)
      return
    }
    let mounted = true
    void window.ndDshOrganization.projectRuntime(removeProjectId)
      .then((status) => { if (mounted) setRemovalRuntime(status) })
      .catch(() => { if (mounted) setRemovalRuntime(null) })
    return () => { mounted = false }
  }, [removeProjectId])

  const removalStops = useMemo(() => {
    if (!removalTarget) return ''
    const parts: string[] = []
    if (removalTarget.activeRuns > 0) {
      parts.push(`${removalTarget.activeRuns} running run${removalTarget.activeRuns === 1 ? '' : 's'} will be cancelled first (session stopped, task worktree rolled back, employee released)`)
    }
    if (removalRuntime && removalRuntime.state !== 'stopped') {
      parts.push(`the ND-managed server${removalRuntime.port ? ` on port ${removalRuntime.port}` : ''} will be stopped`)
    }
    return parts.length > 0 ? `Stopping first: ${parts.join(', and ')}.` : 'Nothing is running for this project.'
  }, [removalTarget, removalRuntime])
  const activity = useMemo(() => state?.activity.filter((item) => item.companyId === company?.id && (!project || !item.projectId || item.projectId === project.id)).slice(0, 12) ?? [], [state, company?.id, project])
  // Repository cards project beside ND tasks but never merge into ND metrics.
  const repoBoard = useMemo(
    () => projectRepositoryBoard(workflowView?.snapshot, workflowView?.binding ? `repo:${workflowView.binding.pluginId}` : 'repo'),
    [workflowView],
  )
  // Clicked repository ticket -> full source record for the detail modal.
  const repoTaskDetail = useMemo(
    () => workflowView?.snapshot?.tasks.find((item) => item.sourcePath === repoTaskPath) ?? null,
    [workflowView?.snapshot, repoTaskPath],
  )
  const repoTasksByPath = useMemo(
    () => new Map((workflowView?.snapshot?.tasks ?? []).map((item) => [item.sourcePath, item])),
    [workflowView?.snapshot],
  )

  // Clicking a repository ticket opens the agent console with the task's
  // full context prefilled; the card menu holds detail/copy actions.
  const openRepoDetail = (task: RepositoryWorkflowTask): void => setRepoTaskPath(task.sourcePath)
  const openRepoChat = (task: RepositoryWorkflowTask): void => {
    if (onAskAgent) onAskAgent(buildRepoTaskPrompt(task))
    else setRepoTaskPath(task.sourcePath)
  }

  // Dev-server lifecycle state for the active project, kept live by the
  // main-process runtime service.
  useEffect(() => {
    return window.ndDshOrganization.onRuntimeChanged(setRuntime)
  }, [])

  useEffect(() => {
    if (!project) return
    setRuntimeDraft({
      startCommand: project.startCommand ?? '',
      testCommand: project.testCommand ?? '',
      targetUrl: project.targetUrl ?? '',
      targetPort: project.targetPort !== undefined ? String(project.targetPort) : '',
      healthCheckPath: project.healthCheckPath ?? '',
    })
    let mounted = true
    void window.ndDshOrganization.projectRuntime(project.id)
      .then((status) => { if (mounted) setRuntime(status) })
      .catch(() => undefined)
    return () => { mounted = false }
    // Reseed only when switching projects; snapshot refreshes must not clobber typing.
  }, [project?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Repository workflow mirror for the active project: main-process ownership
  // means the renderer only ever asks by company/project ids.
  useEffect(() => {
    if (!company || !project) {
      setWorkflowView({})
      return
    }
    const workflowPlugins = window.ndDshWorkflowPlugins
    if (!workflowPlugins || typeof workflowPlugins.snapshot !== 'function' || typeof workflowPlugins.onChanged !== 'function') {
      setWorkflowView({})
      return
    }
    let mounted = true
    const load = (): void => {
      void workflowPlugins.snapshot(company.id, project.id)
        .then((value) => { if (mounted) setWorkflowView(value ?? {}) })
        .catch(() => undefined)
    }
    load()
    const off = workflowPlugins.onChanged(() => load())
    return () => { mounted = false; off() }
  }, [company?.id, project?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const activeRuntime = runtime && (!project || runtime.projectId === project.id) ? runtime : null

  async function saveRuntimeSettings(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!project) return
    await action('runtime-save', async () => {
      await mutate({
        type: 'project.update',
        id: project.id,
        patch: {
          startCommand: runtimeDraft.startCommand,
          testCommand: runtimeDraft.testCommand,
          targetUrl: runtimeDraft.targetUrl,
          healthCheckPath: runtimeDraft.healthCheckPath,
          // Port 0 is not a valid port; the store clears the field instead of storing it.
          targetPort: runtimeDraft.targetPort.trim() ? Number(runtimeDraft.targetPort) : 0,
        },
      })
      const refreshed = await window.ndDshOrganization.projectRuntime(project.id).catch(() => null)
      if (refreshed) setRuntime(refreshed)
    })
  }

  async function openProjectTarget(): Promise<void> {
    if (!project || !activeRuntime?.targetUrl) return
    await action('runtime-open', () => window.ndDsh.browser.navigate(activeRuntime.targetUrl!))
  }

  async function controlRuntime(step: 'start' | 'stop' | 'restart'): Promise<void> {
    if (!project) return
    await action(`runtime-${step}`, async () => {
      if (step === 'stop') setRuntime(await window.ndDshOrganization.stopProjectRuntime(project.id))
      else {
        if (step === 'restart') await window.ndDshOrganization.stopProjectRuntime(project.id)
        setRuntime(await window.ndDshOrganization.startProjectRuntime(project.id))
      }
    })
  }

  async function selectProjectWorkspace(): Promise<void> {
    await action('workspace-select', async () => {
      await window.ndDsh.workspace.pick()
    })
  }

  async function pickProjectWorkspace(): Promise<void> {
    try {
      const picked = await window.ndDsh.workspace.pickPath()
      if (picked) setProjectDraft((value) => ({ ...value, workspacePath: picked }))
    } catch (cause) {
      onError(errorMessage(cause))
    }
  }

  useEffect(() => {
    if (!state) return
    const ids = Object.keys(watchedRuns)
    if (!ids.length) return
    const settled: string[] = []
    for (const id of ids) {
      const run = state.runs.find((item) => item.id === id)
      if (!run || run.status === 'running') continue
      settled.push(id)
      if (run.status === 'failed') onError(`${watchedRuns[id]} failed: ${run.error ?? 'no reason was reported.'}`)
    }
    if (settled.length) setWatchedRuns((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !settled.includes(id))))
  }, [state, watchedRuns, onError])

  async function startRun(label: string, fn: () => Promise<OrganizationRunReceipt | null>): Promise<void> {
    const receipt = await fn()
    if (receipt?.runId) setWatchedRuns((current) => ({ ...current, [receipt.runId]: label }))
  }

  function retryRun(run: OrganizationRun): Promise<void> {
    if (run.kind === 'pm-plan') return startRun('AI PM plan', () => window.ndDshOrganization.planProject(run.projectId))
    if (run.kind === 'task-review' && run.taskId) return startRun('AI review', () => window.ndDshOrganization.reviewTask(run.taskId!))
    if (run.taskId) return startRun('Task run', () => window.ndDshOrganization.runTask(run.taskId!))
    return startRun('Next run', () => window.ndDshOrganization.runNext(run.projectId))
  }

  async function action(key: string, fn: () => Promise<unknown>): Promise<void> {
    if (busy) return
    setBusy(key)
    try { await fn() } catch (cause) { onError(errorMessage(cause)) } finally { setBusy(null) }
  }

  async function mutate(value: Parameters<typeof window.ndDshOrganization.mutate>[0]): Promise<OrganizationSnapshot> {
    const next = await window.ndDshOrganization.mutate(value)
    setState(next)
    return next
  }

  async function createCompany(event: FormEvent): Promise<void> {
    event.preventDefault()
    await action('company', async () => {
      await mutate({ type: 'company.create', name: companyDraft.name, mission: companyDraft.mission })
      setCompanyDraft({ name: '', mission: '' })
      setShowCreateCompany(false)
    })
  }

  async function createProject(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!company) return
    await action('project', async () => {
      await mutate({ type: 'project.create', companyId: company.id, name: projectDraft.name, objective: projectDraft.objective, ...(projectDraft.workspacePath.trim() ? { workspacePath: projectDraft.workspacePath.trim() } : {}) })
      setProjectDraft({ name: '', objective: '', workspacePath: workspace?.root ?? '' })
    })
  }

  async function createTask(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!company || !project) return
    await action('task', async () => {
      await mutate({ type: 'task.create', companyId: company.id, projectId: project.id, ...(project.deliveryMilestoneId ? { milestoneId: project.deliveryMilestoneId } : {}), title: taskDraft.title, description: taskDraft.description, priority: taskDraft.priority, acceptanceCriteria: ['Requested outcome is implemented and verified.'] })
      setTaskDraft({ title: '', description: '', priority: 'medium' })
    })
  }

  /** Adds a task directly from a board column and lands it in that column. */
  async function createTaskInColumn(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!company || !project || !columnDraft) return
    const draft = columnDraft
    await action('task', async () => {
      const existingIds = new Set(state?.tasks.map((item) => item.id) ?? [])
      const next = await mutate({ type: 'task.create', companyId: company.id, projectId: project.id, ...(project.deliveryMilestoneId ? { milestoneId: project.deliveryMilestoneId } : {}), title: draft.title, description: draft.description, priority: 'medium', acceptanceCriteria: ['Requested outcome is implemented and verified.'] })
      if (draft.status !== 'ready') {
        const created = next.tasks.find((item) => !existingIds.has(item.id))
        if (created) await mutate({ type: 'task.update', id: created.id, patch: { status: draft.status } })
      }
      setColumnDraft(null)
    })
  }

  async function moveTask(task: OrganizationTask, direction: -1 | 1): Promise<void> {
    if (!project) return
    const scope = tasks.filter((item) => item.milestoneId === task.milestoneId).sort(compareDeliveryTasks)
    const column = scope.filter((item) => item.status === task.status)
    const neighbor = column[column.findIndex((item) => item.id === task.id) + direction]
    if (!neighbor) return
    const ids = scope.map((item) => item.id)
    const from = ids.indexOf(task.id), to = ids.indexOf(neighbor.id)
    ;[ids[from], ids[to]] = [ids[to]!, ids[from]!]
    await action('task-order', () => mutate({ type: 'task.reorder', projectId: project.id, ...(task.milestoneId ? { milestoneId: task.milestoneId } : {}), taskIds: ids }))
  }

  async function addMemory(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!company) return
    await action('memory', async () => {
      await mutate({ type: 'memory.add', companyId: company.id, ...(project ? { projectId: project.id } : {}), title: memoryDraft.title, content: memoryDraft.content, tags: ['manual'] })
      setMemoryDraft({ title: '', content: '' })
    })
  }

  const availableModels = useMemo(() => {
    return providers.filter((p) => p.enabled).flatMap((p) =>
      p.models.map((m) => ({
        value: `${p.id}:${m.id}`,
        label: `${p.name} · ${m.id}`,
        providerId: p.id,
        modelId: m.id,
      }))
    )
  }, [providers])

  async function assignAgentModel(agentId: string, value: string): Promise<void> {
    await action(`model-${agentId}`, async () => {
      if (value === 'default') {
        const agent = agents.find((a) => a.id === agentId)
        if (!agent) return
        const { providerId: _p, modelId: _m, ...rest } = agent
        setState(await window.ndDshOrganization.mutate({ type: 'agent.update', id: agentId, patch: { name: rest.name, roleId: rest.roleId, status: rest.status } }))
        return
      }
      const selected = availableModels.find((m) => m.value === value)
      if (selected) {
        await mutate({ type: 'agent.update', id: agentId, patch: { providerId: selected.providerId, modelId: selected.modelId } })
      }
    })
  }

  async function assignEngine(agentId: string, engineId: string): Promise<void> {
    await action(`engine-${agentId}`, async () => {
      setEngineAssignments(await window.ndDsh.engines.assign(agentId, engineId))
    })
  }

  async function assignCapability(agentId: string, kind: CapabilityKind, providerId: string): Promise<void> {
    await action(`capability-${kind}-${agentId}`, async () => {
      setCapabilityAssignments(await window.ndDsh.capabilities.assign('agent', agentId, kind, providerId))
    })
  }

  /** Options for one capability kind; unusable entries stay visible but disabled with their reason. */
  function capabilityOptions(kind: CapabilityKind): Array<{ id: string; name: string; usable: boolean; suffix: string; reason?: string }> {
    return capabilityProviders
      .filter((provider) => provider.kind === kind)
      .map((provider) => {
        const enabled = capabilityStatuses[provider.id]?.enabled ?? provider.integration === 'builtin'
        const usable = provider.available && enabled
        const reason = !provider.available
          ? provider.unavailableReason ?? `${provider.name} is not installed.`
          : usable
            ? undefined
            : `${provider.name} is disabled. Enable it in Settings → Capabilities after a passing verification.`
        const suffix = !provider.available ? ' (unavailable)' : enabled ? '' : ' (disabled)'
        return { id: provider.id, name: provider.name, usable, suffix, ...(reason !== undefined ? { reason } : {}) }
      })
  }

  if (!state) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center gap-3 bg-surface-0 text-muted-foreground">
        <div className="size-[34px] animate-spin rounded-full border border-border-strong border-t-primary" />
        Loading AI Company OS…
      </div>
    )
  }

  if (!company) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center bg-surface-0 p-[34px] text-center text-foreground">
        <span className="grid size-[60px] place-items-center rounded-[15px] border border-primary/30 bg-primary/10 text-[21px] font-extrabold text-primary">ND</span>
        <small className="mt-[13px] text-[12px] tracking-[0.14em] text-primary">AI COMPANY OPERATING SYSTEM</small>
        <h1 className="mx-auto mb-2 mt-3 max-w-[650px] text-[32px] font-bold">Build the organization, not another prompt chain.</h1>
        <p className="max-w-[660px] text-[15px]/[1.6] text-muted-foreground">Create a company and ND-DSH seeds an AI PM, builder, reviewer, researcher, teams, skills, workflow, memory boundary, and safety policies.</p>
        <form onSubmit={(event) => void createCompany(event)} className="mt-5 grid w-[min(540px,100%)] gap-[9px] rounded-[10px] border border-border-soft bg-sidebar p-[15px]">
          <input placeholder="Company name" value={companyDraft.name} onChange={(event) => setCompanyDraft((value) => ({ ...value, name: event.target.value }))} required className={orgInput} />
          <textarea placeholder="Company mission" value={companyDraft.mission} onChange={(event) => setCompanyDraft((value) => ({ ...value, mission: event.target.value }))} required className={cn(orgInput, 'min-h-[70px] resize-y')} />
          <button className={cn(orgPrimaryButton, 'h-9')} disabled={busy !== null}>Create AI company</button>
        </form>
      </div>
    )
  }

  const completed = tasks.filter((item) => item.status === 'completed').length
  const activeWorkers = agents.filter((item) => item.status === 'working' || item.status === 'reviewing').length
  const blockers = tasks.filter((item) => item.status === 'blocked').length
  const timeline = [
    { label: 'Planned', done: goals.length > 0 },
    { label: 'Ready', done: tasks.some((item) => item.status !== 'backlog') },
    { label: 'Building', done: tasks.some((item) => ['in_progress', 'review', 'completed'].includes(item.status)) },
    { label: 'Review', done: tasks.some((item) => ['review', 'completed'].includes(item.status)) },
    { label: 'Complete', done: tasks.length > 0 && tasks.every((item) => item.status === 'completed') },
  ]

  return <div className="grid h-full min-h-0 grid-rows-[auto_auto_auto_auto_minmax(0,1fr)] overflow-hidden bg-surface-0 text-foreground">
    <header className="flex items-center justify-end gap-[18px] border-b border-border-soft bg-sidebar px-4 py-3">
      <div className="flex flex-wrap items-center justify-end gap-[9px]">
        <button className={orgButton} onClick={() => setShowCreateCompany(true)}>+ New</button>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground" title="Autonomy level">
          Autonomy
          <Select value={String(company.autonomyLevel)} onValueChange={(value) => void action('autonomy', () => mutate({ type: 'company.update', id: company.id, patch: { autonomyLevel: Number(value) as 0 | 1 | 2 | 3 | 4 } }))}>
            <SelectTrigger className="h-7 w-[130px] rounded-md border-border-strong bg-secondary px-2 text-sm text-soft">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">0 Ask</SelectItem>
              <SelectItem value="1">1 Plan</SelectItem>
              <SelectItem value="2">2 Internal</SelectItem>
              <SelectItem value="3">3 Workflow</SelectItem>
              <SelectItem value="4">4 Autopilot</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground" title="In-ticket subagents only. Company teams, parallel tasks, and independent review are separate.">
          Subagents
          <Select
            value={company.subagentMode ?? 'auto'}
            onValueChange={(value) => void action('subagents', () => mutate({
              type: 'company.update',
              id: company.id,
              patch: { subagentMode: value as OrganizationSubagentMode },
            }))}
          >
            <SelectTrigger className="h-7 w-[96px] rounded-md border-border-strong bg-secondary px-2 text-sm text-soft">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              <SelectItem value="off">Off</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <button className={orgButton} onClick={onOpenDeepSeek}>Agent console</button>
        <button className={orgPrimaryButton} disabled={!project || busy !== null} onClick={() => project && void action('next', () => startRun('Next run', () => window.ndDshOrganization.runNext(project.id)))}>Run next</button>
      </div>
    </header>

    <Dialog open={showCreateCompany} onOpenChange={setShowCreateCompany}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Create AI company</DialogTitle>
          <DialogDescription>Seeds an AI PM, builder, reviewer, researcher, teams, skills, workflow, memory boundary, and safety policies for the new company.</DialogDescription>
        </DialogHeader>
        <form onSubmit={createCompany} className="grid gap-[9px]">
          <Input placeholder="Company name" value={companyDraft.name} onChange={(event) => setCompanyDraft((value) => ({ ...value, name: event.target.value }))} required autoFocus />
          <Input placeholder="Company mission" value={companyDraft.mission} onChange={(event) => setCompanyDraft((value) => ({ ...value, mission: event.target.value }))} required />
          <DialogFooter>
            <DialogClose asChild>
              <button type="button" className={orgButton} onClick={() => setShowCreateCompany(false)}>Cancel</button>
            </DialogClose>
            <button type="submit" className={orgPrimaryButton} disabled={busy !== null}>{busy === 'company' ? 'Creating…' : 'Create AI company'}</button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    {company && project ? (
      <WorkflowIntegrationPanel
        companyId={company.id}
        projectId={project.id}
        projectName={project.name}
        hasWorkspace={Boolean(project.workspacePath)}
        open={showWorkflow}
        onOpenChange={setShowWorkflow}
        onError={onError}
      />
    ) : null}

    {repoTaskDetail ? (
      <RepositoryTaskModal
        task={repoTaskDetail}
        snapshot={workflowView?.snapshot}
        onClose={() => setRepoTaskPath(null)}
      />
    ) : null}

    <Dialog open={removalTarget !== null} onOpenChange={(open) => { if (!open) setRemoveProjectId(null) }}>
      <DialogContent className="sm:max-w-[470px]">
        <DialogHeader>
          <DialogTitle>Remove project from ND?</DialogTitle>
          <DialogDescription>
            {removalTarget
              ? `ND will forget “${removalTarget.project.name}” and the records it owns for it: ${removalTarget.tasks} task${removalTarget.tasks === 1 ? '' : 's'}, ${removalTarget.milestones} milestone${removalTarget.milestones === 1 ? '' : 's'}, ${removalTarget.goals} goal${removalTarget.goals === 1 ? '' : 's'}, ${removalTarget.runs} run receipt${removalTarget.runs === 1 ? '' : 's'}, plus project-scoped memory, skills and workflows.`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <p className="m-0 text-xs/[1.5] text-muted-foreground">{removalStops}</p>
        <p className="m-0 text-xs/[1.5] text-muted-foreground">
          Files on disk are not changed
          {removalTarget?.project.workspacePath ? <> — <span className="font-mono">{removalTarget.project.workspacePath}</span> stays exactly as it is</> : null}
          , including task worktrees. Import the folder again any time to start a fresh project.
        </p>
        <DialogFooter>
          <DialogClose asChild>
            <button className={orgButton} type="button">Cancel</button>
          </DialogClose>
          <button
            type="button"
            className={cn(orgButton, 'border-destructive/45 text-destructive hover:bg-destructive/10 hover:text-destructive')}
            disabled={busy !== null}
            onClick={() => {
              const id = removalTarget?.project.id
              if (!id) return
              void action(`remove-project-${id}`, async () => {
                await mutate({ type: 'project.remove', id })
                setRemoveProjectId(null)
              })
            }}
          >
            Remove project
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <div className="flex min-h-[46px] items-stretch overflow-x-auto border-b border-border-soft bg-surface-1">
      <strong className="flex items-center px-3 text-xs tracking-[0.1em] text-faint">PROJECTS</strong>
      {projects.length === 0 ? (
        <span role="status" className="flex items-center px-3 text-sm text-faint">No projects yet — create one below</span>
      ) : null}
      {projects.map((item) => (
        <div
          key={item.id}
          className={cn(
            'group flex min-w-[140px] items-stretch border-l border-border-soft',
            item.id === project?.id ? 'bg-selected' : '',
          )}
        >
          <button
            className={cn(
              'flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-3 text-left text-muted-foreground transition-colors hover:bg-accent',
              item.id === project?.id ? 'text-foreground hover:bg-selected' : '',
            )}
            onClick={() => void action(`project-${item.id}`, () => mutate({ type: 'project.activate', id: item.id }))}
          >
            <span className="truncate text-[15px] font-semibold">{item.name}</span>
            <small className="text-xs text-faint">{item.progress}% · {item.status}</small>
          </button>
          <button
            type="button"
            className="flex w-6 shrink-0 items-center justify-center text-faint transition-colors hover:text-destructive"
            title={`Remove ${item.name} from ND`}
            aria-label={`Remove project ${item.name} from ND`}
            onClick={() => setRemoveProjectId(item.id)}
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
    <form className="grid grid-cols-[1fr_2fr_1.5fr_auto_auto] gap-[7px] border-b border-border-soft bg-secondary px-4 py-2" onSubmit={(event) => void createProject(event)}>
      <input placeholder="New project" value={projectDraft.name} onChange={(event) => setProjectDraft((value) => ({ ...value, name: event.target.value }))} required className={orgInput} />
      <input placeholder="Objective" value={projectDraft.objective} onChange={(event) => setProjectDraft((value) => ({ ...value, objective: event.target.value }))} required className={orgInput} />
      <button
        type="button"
        aria-label="Browse for workspace folder"
        title={projectDraft.workspacePath || 'Browse for the project workspace folder'}
        className={cn(orgInput, 'truncate text-left', projectDraft.workspacePath ? '' : 'text-faint')}
        onClick={() => void pickProjectWorkspace()}
      >
        {projectDraft.workspacePath || 'Browse for workspace folder…'}
      </button>
      <button type="button" className={orgButton} disabled={!workspace?.root || busy !== null} onClick={() => setProjectDraft((value) => ({ ...value, workspacePath: workspace?.root ?? '' }))}>Use open workspace</button>
      <button className={orgButton}>Add project</button>
    </form>
    <nav className="flex gap-1 border-b border-border-soft bg-secondary px-4 py-1.5">
      {(['overview', 'work', 'workforce', 'knowledge'] as const).map((item) => (
        <button
          key={item}
          className={cn(
            'h-7 rounded-md border border-transparent bg-transparent px-[9px] text-sm transition-colors',
            section === item ? 'border-primary/30 bg-primary/10 text-primary' : 'text-soft hover:bg-accent hover:text-foreground',
          )}
          onClick={() => setSection(item)}
        >
          {sectionLabel(item)}
        </button>
      ))}
    </nav>

    <main className="min-h-0 overflow-auto px-4 pt-3.5 pb-7">
      {section === 'overview' ? <>
        <div className="mb-2.5 grid grid-cols-2 gap-[9px] min-[1100px]:grid-cols-4">
          <Stat label="Project" value={`${project?.progress ?? 0}%`} detail={project?.objective ?? 'Create a project'} />
          <Stat label="Workforce" value={`${activeWorkers}/${agents.length}`} detail="active AI workers" />
          <Stat label="Tasks" value={`${completed}/${tasks.length}`} detail={`${blockers} blocked`} />
          <Stat label="Policy gates" value={`${policies.filter((item) => item.effect === 'ask').length}`} detail="require a human decision" />
        </div>
        <div className="mb-2.5 flex flex-wrap items-center gap-x-[7px] gap-y-1.5 rounded-[9px] border border-border-soft bg-sidebar px-[11px] py-2">
          <small className="mr-1 text-[10px] font-bold uppercase tracking-[0.12em] text-faint">Timeline</small>
          {timeline.map((step, index) => (
            <span key={step.label} className="flex items-center gap-[7px]">
              {index > 0 ? <span className="text-fainter">→</span> : null}
              <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-semibold', step.done ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border-strong bg-secondary text-faint')}>{step.label}</span>
            </span>
          ))}
        </div>
        <div className="mb-2.5 grid grid-cols-1 gap-2.5 min-[1100px]:grid-cols-2">
          <Card title="Goals" action={project ? <button className={orgButton} disabled={busy !== null} onClick={() => void action('plan', () => startRun('AI PM plan', () => window.ndDshOrganization.planProject(project.id)))}>AI PM plan</button> : undefined}>
            {goals.length ? goals.map((goal) => (
              <Row key={goal.id} left={<><strong className="truncate text-sm">{goal.title}</strong><small className="text-xs text-faint">{goal.status}</small></>} right={<span className="shrink-0 text-xs text-muted-foreground">{goal.progress}%</span>} />
            )) : <Empty text="Create a project and ask the AI PM to plan it." />}
          </Card>
          <Card title="Live runs">
            {runs.length ? runs.map((run) => (
              <div key={run.id} className="border-b border-border-soft py-2 last:border-b-0">
                <Row
                  left={<>
                    <strong className="truncate text-sm">{runKindLabel(run.kind)}</strong>
                    <small className="truncate text-xs text-faint">{run.status} · {run.engineId ?? 'engine'}{run.workspaceKind ? ` · ${run.workspaceKind}` : ''} · {short(run.sessionId)} · {clock(run.startedAt)}</small>
                  </>}
                  right={run.status === 'failed'
                    ? <button className={cn(orgButton, 'h-[22px] shrink-0 px-1.5 text-[11px]')} disabled={busy !== null} onClick={() => void action(`retry-${run.id}`, () => retryRun(run))}>Retry</button>
                    : run.status === 'running'
                      ? (
                        <span className="flex shrink-0 items-center gap-1.5">
                          <span className="text-xs font-semibold text-primary">running…</span>
                          <button className={cn(orgButton, 'h-[22px] px-1.5 text-[11px]')} disabled={busy !== null} onClick={() => void action(`cancel-${run.id}`, () => window.ndDshOrganization.cancelRun(run.id))}>Cancel</button>
                        </span>
                      )
                      : undefined}
                />
                {run.workspaceBranch || run.checkpointCommit || run.baselineCommit ? (
                  <div className="mt-1.5 flex flex-wrap gap-1 text-[10px] text-faint">
                    {run.workspaceBranch ? <code className="rounded border border-border-soft bg-secondary px-1.5 py-0.5" title={run.workspaceBranch}>{run.workspaceBranch}</code> : null}
                    {run.baselineCommit ? <code className="rounded border border-border-soft bg-secondary px-1.5 py-0.5">base {short(run.baselineCommit)}</code> : null}
                    {run.checkpointCommit ? <code className="rounded border border-primary/20 bg-primary/[0.06] px-1.5 py-0.5 text-primary">checkpoint {short(run.checkpointCommit)}</code> : null}
                  </div>
                ) : null}
                {run.error ? (
                  <p className="m-0 mt-1.5 max-h-[88px] overflow-auto whitespace-pre-wrap break-words rounded-[7px] border border-destructive/25 bg-destructive/[0.06] p-[7px] text-xs/[1.45] text-destructive" title={run.error}>
                    {run.error.length > 500 ? `${run.error.slice(0, 500)}…` : run.error}
                  </p>
                ) : null}
              </div>
            )) : <Empty text="PM, worker and reviewer runs appear here." />}
          </Card>
        </div>
        <div className="grid grid-cols-1 gap-2.5 min-[1100px]:grid-cols-2">
          <Card title={`Project runtime${project ? ` · ${project.name}` : ''}`}>
            {project ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em]', runtimeChipClass(activeRuntime?.state))}>
                    {activeRuntime?.state ?? 'stopped'}
                  </span>
                  {activeRuntime?.targetUrl ? <code className="min-w-0 truncate font-mono text-xs text-soft" title={activeRuntime.targetUrl}>{activeRuntime.targetUrl}</code> : null}
                  <div className="ml-auto flex shrink-0 gap-[7px]">
                    <button className={orgButton} disabled={busy !== null || !activeRuntime?.targetUrl} title={activeRuntime?.targetUrl ? undefined : 'Start the project or set a target URL first'} onClick={() => void openProjectTarget()}>Open in Browser</button>
                    {activeRuntime?.state === 'starting' || activeRuntime?.state === 'ready' ? (
                      <>
                        <button className={orgButton} disabled={busy !== null} onClick={() => void controlRuntime('restart')}>Restart</button>
                        <button className={orgButton} disabled={busy !== null} onClick={() => void controlRuntime('stop')}>Stop</button>
                      </>
                    ) : (
                      <button className={orgPrimaryButton} disabled={busy !== null} onClick={() => void controlRuntime('start')}>Start</button>
                    )}
                  </div>
                </div>
                {workspace?.binding === 'missing' || !project.workspacePath ? (
                  <div className="flex items-center justify-between gap-2 rounded-[7px] border border-warning/30 bg-warning/[0.06] px-[7px] py-1.5 text-xs text-warning">
                    <span>Link the project folder before running the app or checks.</span>
                    <button type="button" className={orgButton} disabled={busy !== null} onClick={() => void selectProjectWorkspace()}>Select workspace</button>
                  </div>
                ) : null}
                {activeRuntime?.lastError ? (
                  <p className="m-0 max-h-[110px] overflow-auto whitespace-pre-wrap break-words rounded-[7px] border border-destructive/25 bg-destructive/[0.06] p-[7px] text-xs/[1.45] text-destructive">
                    {activeRuntime.lastError.length > 600 ? `${activeRuntime.lastError.slice(0, 600)}…` : activeRuntime.lastError}
                  </p>
                ) : null}
                {activeRuntime?.validation?.length ? (
                  <ul className="m-0 list-none p-0 text-[11px]/[1.5] text-muted-foreground">
                    {activeRuntime.validation.map((line) => <li key={line}>· {line}</li>)}
                  </ul>
                ) : null}
                <form className="grid grid-cols-1 gap-[7px] min-[900px]:grid-cols-2" onSubmit={(event) => void saveRuntimeSettings(event)}>
                  <input placeholder="Start command (e.g. npm run dev)" value={runtimeDraft.startCommand} onChange={(event) => setRuntimeDraft((value) => ({ ...value, startCommand: event.target.value }))} className={orgInput} />
                  <input
                    placeholder="Test command — machine verification (e.g. npm test)"
                    title="ND runs this command as the hard verification gate for every task checkpoint. Leave empty to skip machine verification."
                    value={runtimeDraft.testCommand}
                    onChange={(event) => setRuntimeDraft((value) => ({ ...value, testCommand: event.target.value }))}
                    className={orgInput}
                  />
                  <input placeholder="Target URL — overrides port (e.g. http://localhost:3000)" value={runtimeDraft.targetUrl} onChange={(event) => setRuntimeDraft((value) => ({ ...value, targetUrl: event.target.value }))} className={orgInput} />
                  <input placeholder={`Target port (default ${DEFAULT_PROJECT_PORT})`} inputMode="numeric" value={runtimeDraft.targetPort} onChange={(event) => setRuntimeDraft((value) => ({ ...value, targetPort: event.target.value }))} className={orgInput} />
                  <input placeholder="Health-check path (/)" value={runtimeDraft.healthCheckPath} onChange={(event) => setRuntimeDraft((value) => ({ ...value, healthCheckPath: event.target.value }))} className={orgInput} />
                  <button className={orgButton}>Save runtime</button>
                </form>
              </div>
            ) : <Empty text="Create a project to configure its dev server and browser target." />}
          </Card>
          <Card title="Activity">
            {activity.length ? activity.map((item) => (
              <Row
                key={item.id}
                left={<><strong className="truncate font-mono text-xs">{item.type}</strong><small className="text-xs/[1.45] text-muted-foreground">{item.message}</small></>}
                right={<small className="shrink-0 text-[10px] text-faint">{clock(item.createdAt)}</small>}
              />
            )) : <Empty text="Workforce activity lands here as it happens." />}
          </Card>
        </div>
      </> : null}

      {section === 'work' ? <Card
        title={project ? `${project.name} work board` : 'Work board'}
        action={project ? (
          <div className="flex items-center gap-2">
            {workflowView?.snapshot?.stale ? (
              <span className="inline-flex items-center rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-warning" title={workflowView.snapshot.lastError ?? undefined}>
                repo stale
              </span>
            ) : null}
            {workflowView?.pluginMissing ? (
              <span className="inline-flex items-center rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-destructive">
                plugin missing
              </span>
            ) : null}
            {workflowView?.disconnected ? (
              <span className="inline-flex items-center rounded-full border border-border-strong bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-muted-foreground">
                workflow off
              </span>
            ) : null}
            <button className={orgButton} disabled={busy !== null} title="Ask the AI product manager to plan goals, milestones and tasks for this project" onClick={() => void action('plan', () => startRun('AI PM plan', () => window.ndDshOrganization.planProject(project.id)))}>AI PM plan</button>
            <button className={orgButton} onClick={() => setShowWorkflow(true)}>Workflow</button>
          </div>
        ) : undefined}
      >
        {project ? (
          <>
          <DeliveryMilestones key={project.id} project={project} milestones={milestones} goals={goals} tasks={tasks} busy={busy !== null}
            onMutate={async (mutation) => { let saved = false; await action('delivery', async () => { await mutate(mutation); setColumnDraft(null); saved = true }); return saved }} />
          <form className="mb-2 grid grid-cols-[1fr_2fr_1.5fr_auto] gap-[7px]" onSubmit={(event) => void createTask(event)}>
            <input placeholder="Task title" value={taskDraft.title} onChange={(event) => setTaskDraft((value) => ({ ...value, title: event.target.value }))} required className={orgInput} />
            <input placeholder="Required outcome" value={taskDraft.description} onChange={(event) => setTaskDraft((value) => ({ ...value, description: event.target.value }))} required className={orgInput} />
            <Select value={taskDraft.priority} onValueChange={(value) => setTaskDraft((current) => ({ ...current, priority: value as TaskPriority }))}>
              <SelectTrigger className="h-auto min-h-9 w-full rounded-md border-border-strong bg-background px-[9px] py-[7px] text-sm text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">low</SelectItem>
                <SelectItem value="medium">medium</SelectItem>
                <SelectItem value="high">high</SelectItem>
                <SelectItem value="critical">critical</SelectItem>
              </SelectContent>
            </Select>
            <button className={orgButton}>Add task</button>
          </form>
          </>
        ) : null}
        <div className="grid grid-cols-[repeat(6,minmax(160px,1fr))] gap-2 overflow-x-auto max-[1100px]:grid-cols-[repeat(6,220px)]">
          {(['backlog', ...BOARD_STATUSES] as const).map((status) => {
            const repoCards = status === 'backlog' || project?.deliveryMilestoneId ? [] : repoBoard[status] ?? []
            const draftStatus = status === 'backlog' ? null : status
            return (
              <section key={status} className="min-h-[300px] rounded-[7px] border border-border-soft bg-surface-0 p-2">
                <header className="mb-[7px] flex items-center justify-between text-xs font-bold uppercase text-muted-foreground">
                  <span>{status.replace('_', ' ')}</span>
                  <span className="flex items-center gap-1">
                    <b>{boardTasks.filter((item) => item.status === status).length}{repoCards.length ? <span className="font-normal normal-case text-faint">+{repoCards.length} repo</span> : null}</b>
                    {draftStatus ? (
                      <button
                        type="button"
                        aria-label={`Add a ${status.replace('_', ' ')} task`}
                        title={`Add a ${status.replace('_', ' ')} task`}
                        className="grid size-[18px] place-items-center rounded-[5px] border border-transparent text-faint transition-colors hover:border-border-strong hover:bg-secondary hover:text-foreground"
                        onClick={() => setColumnDraft((current) => current?.status === status ? null : { status: draftStatus, title: '', description: '' })}
                      >
                        +
                      </button>
                    ) : null}
                  </span>
                </header>
                {columnDraft?.status === status ? (
                  <form className="mb-[7px] flex flex-col gap-[5px]" onSubmit={(event) => void createTaskInColumn(event)}>
                    <input
                      autoFocus
                      required
                      placeholder="Task title"
                      aria-label="New task title"
                      value={columnDraft.title}
                      onChange={(event) => setColumnDraft((current) => current?.status === status ? { ...current, title: event.target.value } : current)}
                      className={orgInput}
                    />
                    <input
                      required
                      placeholder="Required outcome"
                      aria-label="New task required outcome"
                      value={columnDraft.description}
                      onChange={(event) => setColumnDraft((current) => current?.status === status ? { ...current, description: event.target.value } : current)}
                      className={orgInput}
                    />
                    <div className="flex items-center gap-[5px]">
                      <button className={orgPrimaryButton} disabled={busy !== null}>{busy === 'task' ? 'Adding…' : 'Add'}</button>
                      <button type="button" className={orgButton} onClick={() => setColumnDraft(null)}>Cancel</button>
                    </div>
                  </form>
                ) : null}
                {boardTasks.filter((item) => item.status === status).map((item) => (
                  <TaskCard
                    key={item.id}
                    task={item}
                    state={state}
                    busy={busy}
                    run={action}
                    startRun={startRun}
                    onEdit={() => setEditingTaskId(item.id)}
                    onMove={(direction) => void moveTask(item, direction)}
                    canMoveUp={boardTasks.filter((task) => task.status === status && task.milestoneId === item.milestoneId).findIndex((task) => task.id === item.id) > 0}
                    canMoveDown={boardTasks.filter((task) => task.status === status && task.milestoneId === item.milestoneId).at(-1)?.id !== item.id}
                  />
                ))}
                {repoCards.map((card) => {
              const task = repoTasksByPath.get(card.sourcePath)
              return (
                <RepositoryCard
                  key={card.key}
                  card={card}
                  task={task}
                  onOpenDetail={() => setRepoTaskPath(card.sourcePath)}
                  onOpenChat={() => { if (task) openRepoChat(task) }}
                />
              )
            })}
              </section>
            )
          })}
        </div>
        {otherTasks.length ? <details className="mt-3 rounded-md border border-border-soft p-3 text-xs">
          <summary className="cursor-pointer font-medium text-muted-foreground">Other work · {otherTasks.length} tasks</summary>
          <p className="my-2 text-faint">These tasks are outside the selected milestone. Select their milestone or All work to dispatch them.</p>
          <ul className="max-h-64 space-y-2 overflow-auto">
            {otherTasks.map((task) => <li key={task.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0"><strong>{task.title}</strong><span className="ml-2 text-faint">{milestones.find((item) => item.id === task.milestoneId)?.title ?? 'Unassigned'} · {task.status.replace('_', ' ')}</span></span>
              <button type="button" className={orgButton} onClick={() => setEditingTaskId(task.id)}>Edit</button>
            </li>)}
          </ul>
        </details> : null}
        {project?.deliveryMilestoneId && workflowView?.snapshot?.tasks.length ? <p className="mt-2 text-xs text-faint">Repository tickets have their own workflow. Select All work to view them alongside ND tasks.</p> : null}
        {!project?.deliveryMilestoneId && repoBoard.needs_attention.length ? (
          <div className="mt-2 rounded-[7px] border border-warning/25 bg-warning/[0.06] p-2">
            <header className="mb-[7px] text-xs font-bold uppercase text-warning">
              Repository · needs attention <b>{repoBoard.needs_attention.length}</b>
            </header>
            {repoBoard.needs_attention.map((card) => {
              const task = repoTasksByPath.get(card.sourcePath)
              return (
                <RepositoryCard
                  key={card.key}
                  card={card}
                  task={task}
                  onOpenDetail={() => setRepoTaskPath(card.sourcePath)}
                  onOpenChat={() => { if (task) openRepoChat(task) }}
                />
              )
            })}
            <p className="m-0 px-1 text-[11px] text-muted-foreground">
              Ambiguous repository records are never given an invented status. Resolve them in the repository, then refresh the integration.
            </p>
          </div>
        ) : null}
      </Card> : null}

      {section === 'workforce' ? <div className="mb-2.5 grid grid-cols-1 gap-2.5 min-[1100px]:grid-cols-2">
        <Card title="Teams">
          {teams.map((team) => (
            <Row key={team.id} left={<><strong className="truncate text-sm">{team.name}</strong><small className="text-xs text-faint">{team.purpose}</small></>} right={<span className="shrink-0 text-xs text-muted-foreground">{agents.filter((agent) => agent.teamId === team.id).length}</span>} />
          ))}
        </Card>
        <Card title="AI workers">
          {agents.map((agent) => {
            const engineId = engineAssignments[agent.id] ?? ND_HARNESS_ENGINE_ID
            const agentRole = roles.find((role) => role.id === agent.roleId)
            const rawModelValue = agent.providerId && agent.modelId
              ? `${agent.providerId}:${agent.modelId}`
              : agentRole?.providerId && agentRole?.modelId
                ? `${agentRole.providerId}:${agentRole.modelId}`
                : 'default'
            const activeModelValue = rawModelValue === 'default' || availableModels.some((m) => m.value === rawModelValue)
              ? rawModelValue
              : 'default'
            return (
              <Row
                key={agent.id}
                left={<><strong className="truncate text-sm">{agent.name}</strong><small className="text-xs text-faint">{agentRole?.name ?? 'Role'} · {agent.status}</small></>}
                right={
                  <div className="flex shrink-0 items-center gap-2">
                    <label title="LLM model assigned to this agent" className="flex items-center gap-1.5 text-[11px] text-faint">
                      Model
                      <Select value={activeModelValue} disabled={busy !== null} onValueChange={(value) => void assignAgentModel(agent.id, value)}>
                        <SelectTrigger className="h-7 w-[150px] rounded-md border-border-strong bg-secondary px-2 text-[11px] text-soft">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">Default route</SelectItem>
                          {availableModels.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </label>
                    <label title="Coding engine used when this employee executes an assigned task" className="flex items-center gap-1.5 text-[11px] text-faint">
                      Engine
                      <Select value={engineId} disabled={busy !== null} onValueChange={(value) => void assignEngine(agent.id, value)}>
                        <SelectTrigger className="h-7 w-[130px] rounded-md border-border-strong bg-secondary px-2 text-[11px] text-soft">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {engines.map((engine) => <SelectItem key={engine.id} value={engine.id} disabled={!engine.available}>{engine.name}{engine.available ? '' : ' (unavailable)'}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </label>
                    {CAPABILITY_SELECTS.map(({ kind, label, title }) => {
                      const value = capabilityAssignments.agents[agent.id]?.[kind] ?? DEFAULT_CAPABILITY_PROVIDER[kind]
                      return (
                        <label key={kind} title={title} className="flex items-center gap-1.5 text-[11px] text-faint">
                          {label}
                          <Select value={value} disabled={busy !== null} onValueChange={(next) => void assignCapability(agent.id, kind, next)}>
                            <SelectTrigger className="h-7 w-[130px] rounded-md border-border-strong bg-secondary px-2 text-[11px] text-soft">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {capabilityOptions(kind).map((option) => (
                                <SelectItem key={option.id} value={option.id} disabled={!option.usable} title={option.reason}>
                                  {`${option.name}${option.suffix}`}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </label>
                      )
                    })}
                  </div>
                }
              />
            )
          })}
        </Card>
        <Card title="Skills" wide>
          {state.skills.filter((skill) => skill.scope === 'builtin' || skill.companyId === company.id || skill.projectId === project?.id).map((skill) => (
            <div key={skill.id} className="mr-[7px] mb-[7px] inline-flex min-h-[78px] w-[calc(33.333%-7px)] flex-col gap-1 rounded-[7px] border border-border-soft bg-surface-0 p-2 align-top max-[1100px]:w-[calc(50%-7px)]">
              <small className="text-[11px] uppercase text-primary">{skill.scope}</small>
              <strong className="text-sm">{skill.name}</strong>
              <p className="m-0 text-xs/[1.45] text-muted-foreground">{skill.description}</p>
            </div>
          ))}
        </Card>
      </div> : null}

      {section === 'knowledge' ? <div className="mb-2.5 grid grid-cols-1 gap-2.5 min-[1100px]:grid-cols-2">
        <Card title="Memory">
          <form className="mb-2.5 grid grid-cols-[1fr_2fr_auto] gap-[7px]" onSubmit={(event) => void addMemory(event)}>
            <input placeholder="Decision or lesson" value={memoryDraft.title} onChange={(event) => setMemoryDraft((value) => ({ ...value, title: event.target.value }))} required className={orgInput} />
            <textarea placeholder="Durable context" value={memoryDraft.content} onChange={(event) => setMemoryDraft((value) => ({ ...value, content: event.target.value }))} required className={cn(orgInput, 'min-h-[34px] resize-y')} />
            <button className={orgButton}>Add</button>
          </form>
          {memory.slice().reverse().map((item) => (
            <div key={item.id} className="grid grid-cols-[1fr_auto] gap-1 border-b border-border-soft py-[9px] last:border-b-0">
              <strong className="truncate text-sm">{item.title}</strong>
              <small className="text-[11px] text-faint">{item.source}</small>
              <p className="col-span-full m-0 text-xs/[1.45] text-muted-foreground">{item.content}</p>
            </div>
          ))}
        </Card>
        <Card title="Policies">
          {policies.map((policy) => (
            <div key={policy.id} className="flex items-center justify-between gap-2.5 border-b border-border-soft py-2 last:border-b-0">
              <div className="flex min-w-0 flex-col gap-0.5">
                <strong className="truncate font-mono text-xs">{policy.action}</strong>
                <small className="truncate text-[11px] text-muted-foreground">{policy.description}</small>
              </div>
              <Select value={policy.effect} onValueChange={(value) => void action(`policy-${policy.id}`, () => mutate({ type: 'policy.set', companyId: company.id, action: policy.action, effect: value as OrganizationPolicyEffect, description: policy.description }))}>
                <SelectTrigger className="h-7 w-[74px] shrink-0 rounded-md border-border-strong bg-secondary px-2 text-[11px] text-soft">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="allow">ALLOW</SelectItem>
                  <SelectItem value="ask">ASK</SelectItem>
                  <SelectItem value="deny">DENY</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ))}
        </Card>
      </div> : null}
      {editingTask && state ? (
        <TaskEditDialog
          task={editingTask}
          state={state}
          onClose={() => setEditingTaskId(null)}
          onSave={async (patch) => {
            try {
              await mutate({ type: 'task.update', id: editingTask.id, patch })
            } catch (cause) {
              onError(errorMessage(cause))
              throw cause
            }
          }}
        />
      ) : null}
    </main>
  </div>
}

interface TaskCardProps {
  task: OrganizationTask
  state: OrganizationSnapshot
  busy: string | null
  run(key: string, fn: () => Promise<unknown>): Promise<void>
  startRun(label: string, fn: () => Promise<OrganizationRunReceipt | null>): Promise<void>
  onEdit(): void
  onMove?(direction: -1 | 1): void
  canMoveUp?: boolean
  canMoveDown?: boolean
}

function TaskCard({ task, state, busy, run, startRun, onEdit, onMove, canMoveUp, canMoveDown }: TaskCardProps) {
  const agent = state.agents.find((item) => item.id === task.assignedAgentId)
  const member = task.assignedMemberId ? state.members?.find((item) => item.id === task.assignedMemberId) : undefined
  const accountable = task.accountableMemberId ? state.members?.find((item) => item.id === task.accountableMemberId) : undefined
  const isHuman = task.assigneeKind === 'human' || Boolean(task.assignedMemberId && !task.assignedAgentId)
  const waitingOn = task.dependsOn
    .map((id) => state.tasks.find((item) => item.id === id))
    .filter((item): item is OrganizationTask => Boolean(item) && item!.status !== 'completed')
  const activeRun = state.runs.find((item) => item.taskId === task.id && item.status === 'running')
  const latestReview = state.runs
    .filter((item) => item.taskId === task.id && item.kind === 'task-review')
    .sort((left, right) => (right.completedAt ?? right.startedAt) - (left.completedAt ?? left.startedAt))[0]
  const latestExecution = state.runs
    .filter((item) => item.taskId === task.id && item.kind === 'task-execution')
    .sort((left, right) => (right.completedAt ?? right.startedAt) - (left.completedAt ?? left.startedAt))[0]
  // A previous failed review should remain actionable until a newer worker
  // attempt has produced fresh evidence. Do not label the first review after
  // successful rework as a retry merely because the history contains a fail.
  const reviewFailure = latestReview?.status === 'failed'
    && (!latestExecution || (latestReview.completedAt ?? latestReview.startedAt) > (latestExecution.completedAt ?? latestExecution.startedAt))
    ? latestReview
    : undefined
  const blockedReason = task.status !== 'blocked' || task.integrationState === 'conflict'
    ? undefined
    : task.blockedReason
      ?? (latestExecution?.status === 'failed' ? latestExecution.error : undefined)
      ?? task.reviewSummary
  return (
    <article className="mb-[7px] flex flex-col gap-1.5 rounded-[7px] border border-border-soft bg-sidebar p-[9px]">
      <div className="flex items-center gap-1.5 text-[11px] uppercase text-faint">
        <small>{task.priority}</small>
        {task.sourceScheduleId ? <small className="rounded border border-border-soft bg-secondary px-1 normal-case">recurring</small> : null}
        <button type="button" className="ml-auto rounded px-1 normal-case text-faint transition-colors hover:bg-secondary hover:text-foreground" onClick={onEdit}>Edit</button>
      </div>
      <strong className="text-sm">{task.title}</strong>
      {state.projects.find((project) => project.id === task.projectId)?.deliveryMilestoneId && task.milestoneId !== state.projects.find((project) => project.id === task.projectId)?.deliveryMilestoneId ? <small className="text-warning">Finishing outside selected milestone</small> : null}
      {task.milestoneId ? <small className="text-faint">{state.milestones.find((milestone) => milestone.id === task.milestoneId)?.title}</small> : null}
      {onMove && (task.status === 'backlog' || task.status === 'ready' || task.status === 'blocked') ? <div className="flex items-center gap-1 text-faint">
        <button type="button" aria-label={`Move ${task.title} earlier`} title="Move earlier in this milestone's queue" disabled={busy !== null || !canMoveUp} onClick={() => onMove(-1)} className="rounded p-1 hover:bg-secondary disabled:opacity-30"><ArrowUp className="size-3" /></button>
        <button type="button" aria-label={`Move ${task.title} later`} title="Move later in this milestone's queue" disabled={busy !== null || !canMoveDown} onClick={() => onMove(1)} className="rounded p-1 hover:bg-secondary disabled:opacity-30"><ArrowDown className="size-3" /></button>
        {task.queueOrder !== undefined ? <small>Queue {task.queueOrder + 1}</small> : null}
      </div> : null}
      <p className="m-0 text-xs/[1.45] text-muted-foreground">{task.description}</p>
      {waitingOn.length ? (
        <p className="m-0 text-[11px]/[1.4] text-faint" title={waitingOn.map((item) => item.title).join('\n')}>
          Waiting on: {waitingOn.slice(0, 3).map((item) => item.title).join(', ')}{waitingOn.length > 3 ? ` +${waitingOn.length - 3}` : ''}
        </p>
      ) : null}
      {blockedReason ? (
        <p className="m-0 max-h-[96px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-destructive/25 bg-destructive/[0.06] px-2 py-1 text-[11px]/[1.4] text-destructive" title={blockedReason}>
          {blockedReason.length > 300 ? `${blockedReason.slice(0, 300)}…` : blockedReason}
        </p>
      ) : null}
      {task.integrationState === 'conflict' ? (
        <p className="m-0 rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-[11px]/[1.4] text-warning" title={task.integrationSummary}>
          Integration conflict · task checkpoint preserved
        </p>
      ) : null}
      {task.status === 'review' && reviewFailure ? (
        <p className="m-0 rounded-md border border-warning/25 bg-warning/10 px-2 py-1 text-[11px]/[1.4] text-warning">
          Review needs retry{reviewFailure.error ? `: ${reviewFailure.error.slice(0, 220)}` : '.'}
        </p>
      ) : null}
      {latestExecution ? (
        <div className="flex flex-wrap gap-1 text-[10px] text-faint">
          {latestExecution.engineId ? <span className="rounded border border-border-soft bg-secondary px-1.5 py-0.5">{latestExecution.engineId}</span> : null}
          {latestExecution.workspaceKind ? <span className="rounded border border-border-soft bg-secondary px-1.5 py-0.5">{latestExecution.workspaceKind}</span> : null}
          {latestExecution.workspaceBranch ? <code className="max-w-full truncate rounded border border-border-soft bg-secondary px-1.5 py-0.5" title={latestExecution.workspaceBranch}>{latestExecution.workspaceBranch}</code> : null}
          {latestExecution.checkpointCommit ? <code className="rounded border border-primary/20 bg-primary/[0.06] px-1.5 py-0.5 text-primary">cp {short(latestExecution.checkpointCommit)}</code> : null}
        </div>
      ) : null}
      <footer className="flex items-center justify-between gap-1.5 text-[11px] text-faint">
        <span className="truncate" title={isHuman ? `Assigned to ${member?.displayName ?? 'Human member'}` : `Assigned to ${agent?.name ?? 'AI worker'}`}>
          {isHuman ? `👤 ${member?.displayName ?? 'Human member'}` : `🤖 ${agent?.name ?? 'AI worker'}`}
          {accountable && accountable.id !== member?.id ? ` · acc: ${accountable.displayName}` : ''}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {activeRun ? (
            <button className={cn(orgButton, 'h-[22px] px-1.5 text-[11px]')} disabled={busy !== null} title="Stop the agent working on this task" onClick={() => void run(`cancel-${activeRun.id}`, () => window.ndDshOrganization.cancelRun(activeRun.id))}>Cancel</button>
          ) : null}
          <TaskAction task={task} state={state} busy={busy} run={run} startRun={startRun} reviewRetry={Boolean(reviewFailure)} />
        </span>
      </footer>
    </article>
  )
}

function TaskAction({ task, state, busy, run, startRun, reviewRetry }: Pick<TaskCardProps, 'task' | 'state' | 'busy' | 'run' | 'startRun'> & { reviewRetry: boolean }) {
  const small = cn(orgButton, 'h-[22px] px-1.5 text-[11px]')
  const isHuman = task.assigneeKind === 'human' || Boolean(task.assignedMemberId && !task.assignedAgentId)

  if (isHuman) {
    if (task.status === 'ready') {
      return (
        <button
          className={small}
          disabled={busy !== null}
          onClick={() => void run(`task-start-${task.id}`, () => window.ndDshOrganization.mutate({ type: 'task.update', id: task.id, patch: { status: 'in_progress' } }))}
        >
          Start
        </button>
      )
    }
    if (task.status === 'in_progress') {
      return (
        <button
          className={small}
          disabled={busy !== null}
          onClick={() => {
            const memberId = task.assignedMemberId ?? state.members?.find((m) => m.companyId === task.companyId)?.id
            if (!memberId) return
            void run(`task-submit-${task.id}`, () => window.ndDshOrganization.mutate({
              type: 'task.submitWork',
              taskId: task.id,
              memberId,
              summary: 'Human work completed and submitted for review',
            }))
          }}
        >
          Submit
        </button>
      )
    }
    if (task.status === 'blocked') {
      return (
        <button
          className={small}
          disabled={busy !== null}
          onClick={() => void run(`task-unblock-${task.id}`, () => window.ndDshOrganization.mutate({ type: 'task.update', id: task.id, patch: { status: 'ready' } }))}
        >
          Unblock
        </button>
      )
    }
    if (task.status === 'review') {
      return <small className="shrink-0">{task.reviewerKind === 'human' ? 'in human review' : 'in review'}</small>
    }
    return <small className="shrink-0">{task.status.replace('_', ' ')}</small>
  }

  if (task.status === 'ready' || task.status === 'blocked') {
    return <button className={small} disabled={busy !== null} onClick={() => void run(`task-${task.id}`, () => startRun(`“${task.title}”`, () => window.ndDshOrganization.runTask(task.id)))}>{task.status === 'blocked' ? 'Retry' : 'Run'}</button>
  }
  if (task.status === 'review') {
    return (
      <button className={small} disabled={busy !== null || Boolean(task.reviewSessionId)} title="An independent AI reviewer checks the work against the acceptance criteria" onClick={() => void run(`review-${task.id}`, () => startRun(`AI review of “${task.title}”`, () => window.ndDshOrganization.reviewTask(task.id)))}>
        {task.reviewSessionId ? 'Reviewing…' : reviewRetry ? 'Retry AI review' : 'AI review'}
      </button>
    )
  }
  if (task.status === 'backlog') return <small className="shrink-0">{task.dependsOn.length ? 'waiting' : 'backlog'}</small>
  return <small className="shrink-0">{task.status.replace('_', ' ')}</small>
}

const EDITABLE_STATUSES: Array<OrganizationTask['status']> = ['backlog', 'ready', 'blocked']

/**
 * Human edit of an ND task. Status is limited to the states a person may set
 * directly; in-progress, review and completed are reached only through runs,
 * review and evidence so the board never claims work that did not happen.
 */
function TaskEditDialog({ task, state, onClose, onSave }: {
  task: OrganizationTask
  state: OrganizationSnapshot
  onClose(): void
  onSave(patch: Extract<Parameters<typeof window.ndDshOrganization.mutate>[0], { type: 'task.update' }>['patch']): Promise<void>
}) {
  const isHumanInitial = task.assigneeKind === 'human' || Boolean(task.assignedMemberId && !task.assignedAgentId)
  const [draft, setDraft] = useState({
    title: task.title,
    description: task.description,
    acceptance: task.acceptanceCriteria.join('\n'),
    priority: task.priority,
    status: task.status,
    assigneeKind: (task.assigneeKind ?? (isHumanInitial ? 'human' : 'agent')) as 'human' | 'agent',
    assignedAgentId: task.assignedAgentId ?? '',
    assignedMemberId: task.assignedMemberId ?? '',
    accountableMemberId: task.accountableMemberId ?? '',
    reviewerKind: (task.reviewerKind ?? (task.reviewerMemberId ? 'human' : 'agent')) as 'human' | 'agent',
    reviewerMemberId: task.reviewerMemberId ?? '',
    reviewerAgentId: task.reviewerAgentId ?? '',
    milestoneId: task.milestoneId ?? '',
  })
  const [saving, setSaving] = useState(false)
  const active = task.status === 'in_progress' || task.status === 'review'
  const agents = state.agents.filter((item) => item.companyId === task.companyId)
  const members = (state.members ?? []).filter((item) => item.companyId === task.companyId && item.status === 'active')
  const statusChoices = EDITABLE_STATUSES.includes(task.status) ? EDITABLE_STATUSES : [task.status]
  const testCommand = state.projects.find((item) => item.id === task.projectId)?.testCommand?.trim()

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    setSaving(true)
    try {
      const acceptanceCriteria = draft.acceptance.split('\n').map((line) => line.trim()).filter(Boolean)
      await onSave({
        title: draft.title,
        description: draft.description,
        acceptanceCriteria: acceptanceCriteria.length ? acceptanceCriteria : task.acceptanceCriteria,
        priority: draft.priority,
        assigneeKind: draft.assigneeKind,
        ...(draft.assigneeKind === 'agent'
          ? (draft.assignedAgentId ? { assignedAgentId: draft.assignedAgentId } : {})
          : (draft.assignedMemberId ? { assignedMemberId: draft.assignedMemberId } : {})),
        ...(draft.accountableMemberId ? { accountableMemberId: draft.accountableMemberId } : {}),
        reviewerKind: draft.reviewerKind,
        ...(draft.reviewerKind === 'human'
          ? (draft.reviewerMemberId ? { reviewerMemberId: draft.reviewerMemberId } : {})
          : (draft.reviewerAgentId ? { reviewerAgentId: draft.reviewerAgentId } : {})),
        ...(draft.status !== task.status ? { status: draft.status } : {}),
        ...(draft.milestoneId !== (task.milestoneId ?? '') ? { milestoneId: draft.milestoneId } : {}),
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[calc(100vh-32px)] max-w-[560px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit task</DialogTitle>
          <DialogDescription>
            {active ? 'An agent is working on this task; assignee and status change after the run ends.' : 'Changes apply to the board immediately.'}
          </DialogDescription>
        </DialogHeader>
        <section aria-label="Delivery verification" className="rounded-md border border-border-soft bg-secondary/40 p-2.5 text-xs text-muted-foreground">
          <strong className="text-foreground">Delivery verification</strong>
          {task.evidenceKind === 'artifact' ? <>
            <p className="mt-1">Required artifacts, relative to this task's workspace:</p>
            <ul className="mt-1 max-h-24 list-disc overflow-auto pl-4">
              {(task.artifactPaths ?? []).map((path) => <li key={path}><code className="break-all">{path}</code></li>)}
            </ul>
            <p className="mt-1">Every artifact must exist at its declared path before independent review.</p>
          </> : testCommand ? <>
            <p className="mt-1">Project test command: <code className="break-all">{testCommand}</code></p>
            <p className="mt-1">A failing check blocks delivery.</p>
          </> : <p className="mt-1">No project test command configured. Machine verification will be recorded as skipped.</p>}
        </section>
        <form className="flex flex-col gap-2" onSubmit={(event) => void save(event)}>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">Milestone
            <Select value={draft.milestoneId || 'unassigned'} disabled={saving || active} onValueChange={(value) => setDraft((current) => ({ ...current, milestoneId: value === 'unassigned' ? '' : value }))}>
              <SelectTrigger aria-label="Task milestone" className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="unassigned">Unassigned</SelectItem>
                {state.milestones.filter((item) => item.projectId === task.projectId).sort((a, b) => a.order - b.order).map((item) => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">Title
            <input required value={draft.title} onChange={(event) => setDraft((value) => ({ ...value, title: event.target.value }))} className={orgInput} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">Required outcome
            <textarea required rows={3} value={draft.description} onChange={(event) => setDraft((value) => ({ ...value, description: event.target.value }))} className={cn(orgInput, 'resize-y')} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">Acceptance criteria (one per line)
            <textarea rows={3} value={draft.acceptance} onChange={(event) => setDraft((value) => ({ ...value, acceptance: event.target.value }))} className={cn(orgInput, 'resize-y')} />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">Priority
              <Select value={draft.priority} onValueChange={(value) => setDraft((current) => ({ ...current, priority: value as TaskPriority }))}>
                <SelectTrigger className="h-8 rounded-md border-border-strong bg-background text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(['low', 'medium', 'high', 'critical'] as const).map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">Status
              <Select value={draft.status} disabled={active} onValueChange={(value) => setDraft((current) => ({ ...current, status: value as OrganizationTask['status'] }))}>
                <SelectTrigger className="h-8 rounded-md border-border-strong bg-background text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {statusChoices.map((value) => <SelectItem key={value} value={value}>{value.replace('_', ' ')}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">Assignee Type
              <Select value={draft.assigneeKind} disabled={active} onValueChange={(value) => setDraft((current) => ({ ...current, assigneeKind: value as 'human' | 'agent' }))}>
                <SelectTrigger className="h-8 rounded-md border-border-strong bg-background text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="agent">🤖 Agent</SelectItem>
                  <SelectItem value="human">👤 Human Member</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">Assignee
              {draft.assigneeKind === 'human' ? (
                <Select value={draft.assignedMemberId || 'none'} disabled={active} onValueChange={(value) => setDraft((current) => ({ ...current, assignedMemberId: value === 'none' ? '' : value }))}>
                  <SelectTrigger className="h-8 rounded-md border-border-strong bg-background text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {!draft.assignedMemberId ? <SelectItem value="none">Unassigned</SelectItem> : null}
                    {members.map((member) => <SelectItem key={member.id} value={member.id}>👤 {member.displayName}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                <Select value={draft.assignedAgentId || 'none'} disabled={active} onValueChange={(value) => setDraft((current) => ({ ...current, assignedAgentId: value === 'none' ? '' : value }))}>
                  <SelectTrigger className="h-8 rounded-md border-border-strong bg-background text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {!draft.assignedAgentId ? <SelectItem value="none">Unassigned</SelectItem> : null}
                    {agents.map((agent) => <SelectItem key={agent.id} value={agent.id}>🤖 {agent.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">Accountable Member
              <Select value={draft.accountableMemberId || 'none'} disabled={active} onValueChange={(value) => setDraft((current) => ({ ...current, accountableMemberId: value === 'none' ? '' : value }))}>
                <SelectTrigger className="h-8 rounded-md border-border-strong bg-background text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {members.map((member) => <SelectItem key={member.id} value={member.id}>👤 {member.displayName}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">Reviewer
              <Select
                value={draft.reviewerKind === 'human' ? (draft.reviewerMemberId ? `human:${draft.reviewerMemberId}` : 'none') : (draft.reviewerAgentId ? `agent:${draft.reviewerAgentId}` : 'default_agent')}
                disabled={active}
                onValueChange={(value) => {
                  if (value === 'none') {
                    setDraft((curr) => ({ ...curr, reviewerKind: 'human', reviewerMemberId: '' }))
                  } else if (value === 'default_agent') {
                    setDraft((curr) => ({ ...curr, reviewerKind: 'agent', reviewerAgentId: '', reviewerMemberId: '' }))
                  } else if (value.startsWith('human:')) {
                    setDraft((curr) => ({ ...curr, reviewerKind: 'human', reviewerMemberId: value.slice(6) }))
                  } else if (value.startsWith('agent:')) {
                    setDraft((curr) => ({ ...curr, reviewerKind: 'agent', reviewerAgentId: value.slice(6) }))
                  }
                }}
              >
                <SelectTrigger className="h-8 rounded-md border-border-strong bg-background text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="default_agent">🤖 AI Reviewer (Auto)</SelectItem>
                  {members.map((member) => <SelectItem key={`human:${member.id}`} value={`human:${member.id}`}>👤 {member.displayName} (Reviewer)</SelectItem>)}
                  {agents.map((agent) => <SelectItem key={`agent:${agent.id}`} value={`agent:${agent.id}`}>🤖 {agent.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
          </div>
          <DialogFooter>
            <DialogClose asChild><button type="button" className={orgButton}>Cancel</button></DialogClose>
            <button type="submit" className={orgPrimaryButton} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Read-only mirrored repository card. Clicking it opens the agent console
 * with the task's full context prefilled; the three-dot menu holds more
 * options (open detail, copy source path). It never offers Run, Retry,
 * Review, or lifecycle drag actions, and completion/acceptance labels stay
 * explicitly source-reported facts.
 */
function RepositoryCard({ card, task, onOpenDetail, onOpenChat }: {
  card: RepositoryBoardCard
  task?: RepositoryWorkflowTask | undefined
  onOpenDetail(): void
  onOpenChat(): void
}) {
  const hasTask = Boolean(task)
  return (
    <article
      className={cn(
        'mb-[7px] flex flex-col gap-1.5 rounded-[7px] border border-dashed border-border-strong bg-sidebar p-[9px] transition-colors',
        hasTask ? 'cursor-pointer hover:border-primary/40' : '',
      )}
      role={hasTask ? 'button' : undefined}
      tabIndex={hasTask ? 0 : undefined}
      title={hasTask ? 'Ask the agent to work on this repository task' : undefined}
      onClick={() => { if (hasTask) onOpenChat() }}
      onKeyDown={(event) => {
        if (!hasTask) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpenChat()
        }
      }}
    >
      <div className="flex items-center justify-between gap-1.5">
        <small className="text-[11px] uppercase tracking-[0.06em] text-faint">{card.lifecycle}{card.legacyArchive ? ' · archived' : ''}</small>
        <div className="flex shrink-0 items-center gap-1">
          <small className="rounded-full border border-border-strong bg-secondary px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-faint">repo</small>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Repository task options"
                className="grid size-[18px] place-items-center rounded-[5px] border border-transparent text-faint transition-colors hover:border-border-strong hover:bg-secondary hover:text-foreground"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <MoreHorizontal className="size-3.5" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[170px]">
              <DropdownMenuItem onSelect={() => { if (hasTask) onOpenChat() }}>Ask agent about this task</DropdownMenuItem>
              <DropdownMenuItem onSelect={onOpenDetail}>Open detail</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!task}
                onSelect={() => { if (task) void navigator.clipboard.writeText(task.sourcePath) }}
              >
                Copy source path
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <strong className="text-sm">{card.title}</strong>
      <code className="truncate font-mono text-[10px] text-faint" title={card.sourcePath}>{card.sourcePath}</code>
      {card.criteriaTotal > 0 ? (
        <small className="text-[11px] text-muted-foreground">Criteria {card.criteriaChecked}/{card.criteriaTotal} checked — checked boxes do not imply completion.</small>
      ) : null}
      <div className="flex flex-wrap gap-1">
        <span className="rounded-full border border-border-strong bg-secondary px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">source-reported</span>
        {card.hasEvidence ? <span className="rounded-full border border-info/30 bg-info/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-info">evidence</span> : null}
        {card.humanAcceptance
          ? <span className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-primary">accepted</span>
          : card.column === 'completed'
            ? <span className="rounded-full border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-warning">no acceptance record</span>
            : null}
      </div>
      {card.warnings.slice(0, 2).map((warning, index) => (
        <p key={`${card.key}-warning-${index}`} className="m-0 rounded-[5px] border border-warning/25 bg-warning/[0.08] px-[7px] py-1 text-[10px]/[1.4] text-warning">{warning}</p>
      ))}
    </article>
  )
}

/**
 * The agent has workspace access, so the prompt only links the source record
 * with '@' — the agent reads the task (and its linked PRD) from the repo.
 */
function buildRepoTaskPrompt(task: RepositoryWorkflowTask): string {
  const prdNote = task.prdRefs.length > 0 ? ' and its linked PRD' : ''
  return `@${task.sourcePath} work on this repository task from the ND workflow mirror. Read the task file${prdNote} in the workspace first and follow its conventions — checked criteria are not completion, and human acceptance must be recorded by a person.`
}

const repoDetailLabel = 'text-[10px] font-bold uppercase tracking-[0.1em] text-faint'
const repoDetailDesc = 'text-[11px]/[1.5] text-muted-foreground'
const repoDetailCode = 'break-all rounded-[5px] border border-border-soft bg-surface-0 px-[7px] py-[5px] font-mono text-[10px]/[1.5] text-soft'

function severityChipClass(severity: string): string {
  if (severity === 'error') return 'border-destructive/30 bg-destructive/[0.08] text-destructive'
  if (severity === 'warning') return 'border-warning/30 bg-warning/[0.08] text-warning'
  return 'border-border-strong bg-secondary text-muted-foreground'
}

/**
 * Full record for one mirrored repository ticket: everything the workflow
 * plugin reported, plus scan context. Read-only by design — edit the source
 * file in the repository, then refresh the integration.
 */
function RepositoryTaskModal({ task, snapshot, onClose }: { task: RepositoryWorkflowTask; snapshot: WorkflowProjectView['snapshot']; onClose(): void }) {
  const linkedPrds: Array<{ ref: string; prd?: RepositoryWorkflowPrd | undefined }> = task.prdRefs.map((ref) => ({
    ref,
    prd: snapshot?.prds.find((item) => item.key === ref || item.sourcePath.includes(ref)),
  }))
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{task.title}</DialogTitle>
          <DialogDescription>
            Read-only mirror of the repository task record. Edit the source file in the repository, then refresh the workflow integration.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-[11px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full border border-border-strong bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-faint">{task.lifecycle}</span>
            {task.displayStatus ? (
              <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-primary">{task.displayStatus.replace('_', ' ')}</span>
            ) : (
              <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-warning">ambiguous status</span>
            )}
            {task.archived ? <span className="rounded-full border border-border-strong bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-muted-foreground">archived</span> : null}
            {task.legacyArchive ? <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-warning">legacy archive name</span> : null}
          </div>

          <div className="grid gap-[5px]">
            <small className={repoDetailLabel}>Source record</small>
            <code className={repoDetailCode}>{task.sourcePath}</code>
            <small className={repoDetailDesc}>{task.key ? `Task number ${task.key}` : 'Unnumbered record — needs an explicit mapping before ND can act on it'}{task.contentHash ? ` · hash ${task.contentHash.slice(0, 24)}` : ''}</small>
          </div>

          {task.outcome ? (
            <div className="grid gap-[5px]">
              <small className={repoDetailLabel}>Outcome</small>
              <p className="m-0 text-xs/[1.55] text-foreground">{task.outcome}</p>
            </div>
          ) : null}

          {task.scope.length > 0 ? (
            <div className="grid gap-[5px]">
              <small className={repoDetailLabel}>Scope</small>
              <ul className="m-0 list-none space-y-1 p-0 text-xs/[1.5] text-muted-foreground">
                {task.scope.map((item, index) => <li key={`scope-${index}`}>· {item}</li>)}
              </ul>
            </div>
          ) : null}

          {task.criteria.length > 0 ? (
            <div className="grid gap-[5px]">
              <small className={repoDetailLabel}>Acceptance criteria ({task.criteria.filter((item) => item.checked).length}/{task.criteria.length} checked — not completion)</small>
              <ul className="m-0 list-none space-y-1 p-0 text-xs/[1.5]">
                {task.criteria.map((item, index) => (
                  <li key={`criteria-${index}`} className="flex items-start gap-1.5">
                    <span className={cn('mt-[3px] grid size-[13px] shrink-0 place-items-center rounded-[3px] border text-[9px] font-bold', item.checked ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border-strong bg-background text-transparent')}>✓</span>
                    <span className={item.checked ? 'text-foreground' : 'text-muted-foreground'}>{item.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-[7px] min-[560px]:grid-cols-2">
            <div className="grid gap-[5px] rounded-[7px] border border-border-soft bg-surface-0 p-[9px]">
              <small className={repoDetailLabel}>Evidence</small>
              {task.evidence || task.evidencePresent
                ? <p className="m-0 text-xs/[1.5] text-foreground">{task.evidence ?? 'Recorded (no excerpt in source)'}</p>
                : <p className="m-0 text-xs/[1.5] text-faint">Not recorded in the source.</p>}
            </div>
            <div className="grid gap-[5px] rounded-[7px] border border-border-soft bg-surface-0 p-[9px]">
              <small className={repoDetailLabel}>Human acceptance</small>
              {task.humanAcceptance || task.humanAcceptanceRecorded
                ? <p className="m-0 text-xs/[1.5] text-foreground">{task.humanAcceptance ?? 'Recorded (no excerpt in source)'}</p>
                : <p className="m-0 text-xs/[1.5] text-faint">Not recorded — acceptance is never implied by ND.</p>}
            </div>
          </div>

          {linkedPrds.length > 0 ? (
            <div className="grid gap-[5px]">
              <small className={repoDetailLabel}>Linked PRDs</small>
              {linkedPrds.map(({ ref, prd }) => (
                <div key={ref} className="rounded-[7px] border border-border-soft bg-surface-0 p-[9px]">
                  <div className="flex items-center justify-between gap-2">
                    <strong className="truncate text-xs">{prd?.title ?? `PRD ${ref}`}</strong>
                    {prd?.status ? <span className="shrink-0 rounded-full border border-border-strong bg-secondary px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.06em] text-muted-foreground">{prd.status}</span> : null}
                  </div>
                  {prd ? <code className={cn(repoDetailCode, 'mt-1 block')}>{prd.sourcePath}</code> : <small className={repoDetailDesc}>PRD file not found in this snapshot.</small>}
                  {prd && !prd.inIndex ? <small className={cn(repoDetailDesc, 'text-warning')}>Not listed in the PRD index.</small> : null}
                </div>
              ))}
            </div>
          ) : null}

          {task.diagnostics.length > 0 ? (
            <div className="grid gap-[5px]">
              <small className={repoDetailLabel}>Source diagnostics</small>
              {task.diagnostics.map((diagnostic, index) => (
                <div key={`diag-${index}`} className={cn('rounded-[7px] border px-[9px] py-[7px] text-[11px]/[1.5]', severityChipClass(diagnostic.severity))}>
                  <strong className="font-semibold">{diagnostic.code}</strong> — {diagnostic.message}
                </div>
              ))}
            </div>
          ) : null}

          {snapshot ? (
            <div className="grid gap-[5px]">
              <small className={repoDetailLabel}>Scan context</small>
              <small className={repoDetailDesc}>
                Scanned {new Date(snapshot.scannedAt).toLocaleString()}
                {snapshot.git.available ? ` · ${snapshot.git.branch ?? 'detached'} @ ${snapshot.git.head ? snapshot.git.head.slice(0, 10) : '?'}` : ' · git unavailable'}
                {snapshot.git.dirty ? ' · dirty worktree' : ''}
                {snapshot.stale ? ' · STALE' : ''}
              </small>
              {snapshot.lastError ? <small className={cn(repoDetailDesc, 'text-destructive')}>{snapshot.lastError}</small> : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <button type="button" className={orgButton}>Close</button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** List row with a two-line label block on the left and optional trailing control. */
function Row({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-[9px] border-b border-border-soft py-2 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-0.5">{left}</div>
      {right}
    </div>
  )
}

/**
 * Dashboard section card. Built on the shared shadcn Card shell; the className
 * overrides map it back onto ND tokens (sidebar surface, soft border, 9px
 * radius, no shadow/gap) so every call site keeps its exact look while picking
 * up data-slot="card" and the primitive's layout contract.
 */
function Card({ title, action, wide = false, children }: { title: string; action?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <UiCard
      className={cn(
        'gap-0 overflow-hidden rounded-[9px] border-border-soft bg-sidebar py-0 shadow-none',
        wide && 'col-span-full',
      )}
    >
      <header className="flex min-h-10 items-center justify-between border-b border-border-soft px-[11px]">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        {action}
      </header>
      <div className="px-[11px] py-[9px]">{children}</div>
    </UiCard>
  )
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="flex min-h-[78px] flex-col rounded-[9px] border border-border-soft bg-sidebar p-[11px]">
      <small className="text-[11px] uppercase tracking-[0.08em] text-faint">{label}</small>
      <strong className="mb-0.5 mt-[5px] truncate text-[28px] font-semibold">{value}</strong>
      <span className="truncate text-xs text-muted-foreground">{detail}</span>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="px-1 py-5 text-center text-sm text-faint">{text}</p>
}

function sectionLabel(value: Section): string { return value === 'workforce' ? 'Teams & Skills' : value === 'knowledge' ? 'Memory & Policies' : `${value[0]?.toUpperCase()}${value.slice(1)}` }
function short(value: string): string { return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value }
function clock(value: number): string { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
function runKindLabel(kind: OrganizationRun['kind']): string {
  if (kind === 'pm-plan') return 'AI PM plan'
  return kind === 'task-review' ? 'Independent review' : 'Builder execution'
}
function runtimeChipClass(state: ProjectRuntimeStatus['state'] | undefined): string {
  if (state === 'ready') return 'border-primary/30 bg-primary/10 text-primary'
  if (state === 'starting') return 'border-info/30 bg-info/10 text-info'
  if (state === 'unreachable') return 'border-destructive/30 bg-destructive/[0.08] text-destructive'
  return 'border-border-strong bg-secondary text-muted-foreground'
}
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
