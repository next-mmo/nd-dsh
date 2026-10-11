import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type {
  OrganizationAccessRole,
  OrganizationApprovalVerdictKind,
  OrganizationMember,
  OrganizationSnapshot,
  OrganizationTask,
  TaskAssigneeKind,
} from '../../../shared/organization'
import { resolveMemberCapabilities } from '../../../shared/organization'
import type { OrganizationManagementProjection } from '../../../shared/organization-control'
import { cn } from '../lib/utils'
import { Card as UiCard } from './ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

interface Props {
  companyId: string
  projectId?: string
  onAskAgent?(prompt: string): void
  onError(message: string): void
}

const button = cn(
  'h-7 shrink-0 rounded-md border border-border-strong bg-secondary px-[9px] text-sm text-soft transition-colors',
  'hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-45',
)
const primaryButton = cn(
  'h-7 shrink-0 rounded-md border border-primary/30 bg-primary/10 px-[9px] text-sm font-medium text-primary transition-colors',
  'hover:bg-primary/[0.16] disabled:pointer-events-none disabled:opacity-45',
)
const input = cn(
  'min-w-0 rounded-md border border-border-strong bg-background px-[9px] py-[7px] text-sm text-foreground outline-none',
  'focus:border-primary/40',
)

export function OrganizationCollaborationCenter({ companyId, projectId, onAskAgent, onError }: Props) {
  const [state, setState] = useState<OrganizationSnapshot | null>(null)
  const [management, setManagement] = useState<OrganizationManagementProjection | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [activeMemberId, setActiveMemberId] = useState('')
  const [memberDraft, setMemberDraft] = useState<{ displayName: string; title: string; accessRole: OrganizationAccessRole }>({
    displayName: '',
    title: '',
    accessRole: 'contributor',
  })
  const [messageDraft, setMessageDraft] = useState<{ body: string; taskId: string; category: 'chat' | 'question' | 'reply' | 'status' | 'handoff' }>({
    body: '',
    taskId: '',
    category: 'chat',
  })
  const [decisionDraft, setDecisionDraft] = useState({ title: '', summary: '', rationale: '', taskId: '' })
  const [approvalTaskId, setApprovalTaskId] = useState('')
  const [approvalComment, setApprovalComment] = useState('')
  const [reassigningTaskId, setReassigningTaskId] = useState<string | null>(null)
  const [reassignTargetKind, setReassignTargetKind] = useState<TaskAssigneeKind>('human')
  const [reassignTargetId, setReassignTargetId] = useState('')
  const [reassignReason, setReassignReason] = useState('')
  const [submittingTaskId, setSubmittingTaskId] = useState<string | null>(null)
  const [submitSummary, setSubmitSummary] = useState('')
  const [submitCommit, setSubmitCommit] = useState('')

  useEffect(() => {
    let mounted = true
    void Promise.all([
      window.ndDshOrganization.state(),
      window.ndDshControl.management(projectId),
    ])
      .then(([next, managementState]) => {
        if (!mounted) return
        setManagement(managementState)
        setState(next)
        const first = (next.members ?? []).find((item) => item.companyId === companyId && item.status === 'active')
        if (first) setActiveMemberId((current) => current || first.id)
      })
      .catch((cause) => onError(errorMessage(cause)))
    const off = window.ndDshOrganization.onChanged((next) => {
      if (!mounted) return
      setState(next)
      setActiveMemberId((current) => {
        const activeStillExists = (next.members ?? []).some((item) => item.id === current && item.status === 'active')
        return activeStillExists
          ? current
          : (next.members ?? []).find((item) => item.companyId === companyId && item.status === 'active')?.id ?? ''
      })
    })
    const offControl = window.ndDshControl.onChanged(() => {
      void window.ndDshControl.management(projectId)
        .then((next) => { if (mounted) setManagement(next) })
        .catch((cause) => onError(errorMessage(cause)))
    })
    return () => { mounted = false; off(); offControl() }
  }, [companyId, onError, projectId])

  useEffect(() => {
    setApprovalTaskId('')
    setApprovalComment('')
    setMessageDraft((current) => ({ ...current, taskId: '' }))
    setDecisionDraft((current) => ({ ...current, taskId: '' }))
  }, [projectId])

  const project = state?.projects.find((item) => item.id === projectId && item.companyId === companyId)
  const members = useMemo(() => (state?.members ?? []).filter((item) => item.companyId === companyId), [state, companyId])
  const agents = useMemo(() => state?.agents.filter((item) => item.companyId === companyId) ?? [], [state, companyId])
  const tasks = useMemo(() => state?.tasks.filter((item) => item.projectId === projectId) ?? [], [state, projectId])
  const messages = useMemo(() => (state?.messages ?? []).filter((item) => item.projectId === projectId).slice().sort((a, b) => a.createdAt - b.createdAt), [state, projectId])
  const decisions = useMemo(() => (state?.decisions ?? []).filter((item) => item.projectId === projectId).slice().sort((a, b) => b.createdAt - a.createdAt), [state, projectId])
  const approvals = useMemo(() => (state?.approvalRequests ?? []).filter((item) => item.projectId === projectId).slice().sort((a, b) => b.createdAt - a.createdAt), [state, projectId])
  const activeMember = members.find((item) => item.id === activeMemberId && item.status === 'active')
  const mentioned = messages.filter((item) => activeMemberId && item.mentionActorIds.includes(activeMemberId))
  const pendingApprovals = approvals.filter((item) => item.status === 'pending').length
  const managementNeedsYou = management?.needsYou.length ?? 0
  const blockedTasks = tasks.filter((item) => item.status === 'blocked').length
  const reviewTasks = tasks.filter((item) => item.status === 'review').length
  const newSignals = management?.metrics.newSignals ?? 0
  const needsYou = pendingApprovals + managementNeedsYou + reviewTasks + blockedTasks + newSignals

  async function act(key: string, fn: () => Promise<unknown>): Promise<void> {
    if (busy) return
    setBusy(key)
    try { await fn() } catch (cause) { onError(errorMessage(cause)) } finally { setBusy(null) }
  }

  async function addMember(event: FormEvent): Promise<void> {
    event.preventDefault()
    await act('member-add', async () => {
      const next = await window.ndDshOrganization.mutate({
        type: 'member.create',
        companyId,
        displayName: memberDraft.displayName,
        accessRole: memberDraft.accessRole,
        ...(memberDraft.title.trim() ? { title: memberDraft.title } : {}),
      })
      const created = (next.members ?? []).find((item) => item.companyId === companyId && item.displayName === memberDraft.displayName.trim())
      if (created) setActiveMemberId(created.id)
      setMemberDraft({ displayName: '', title: '', accessRole: 'contributor' })
    })
  }

  async function postMessage(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!project || !activeMember) return
    const mentionActorIds = resolveMentions(messageDraft.body, members, agents)
    await act('message-add', async () => {
      await window.ndDshOrganization.mutate({
        type: 'collaboration.message.add',
        companyId,
        projectId: project.id,
        authorMemberId: activeMember.id,
        body: messageDraft.body,
        category: messageDraft.category,
        ...(messageDraft.taskId ? { taskId: messageDraft.taskId, kind: 'task' as const } : {}),
        ...(mentionActorIds.length ? { mentionActorIds } : {}),
      })
      setMessageDraft({ body: '', taskId: messageDraft.taskId, category: 'chat' })
    })
  }

  async function reassignTask(taskId: string): Promise<void> {
    if (!activeMember || !reassignTargetId) return
    await act(`task-reassign-${taskId}`, async () => {
      await window.ndDshOrganization.mutate({
        type: 'task.reassign',
        taskId,
        assignee: { kind: reassignTargetKind, id: reassignTargetId },
        changedByMemberId: activeMember.id,
        reason: reassignReason.trim() || 'Handoff to team member',
      })
      setReassigningTaskId(null)
      setReassignTargetId('')
      setReassignReason('')
    })
  }

  async function submitWork(taskId: string): Promise<void> {
    if (!activeMember) return
    await act(`task-submit-${taskId}`, async () => {
      await window.ndDshOrganization.mutate({
        type: 'task.submitWork',
        taskId,
        memberId: activeMember.id,
        summary: submitSummary.trim(),
        ...(submitCommit.trim() ? { checkpointCommit: submitCommit.trim() } : {}),
      })
      setSubmittingTaskId(null)
      setSubmitSummary('')
      setSubmitCommit('')
    })
  }

  async function startHumanTask(taskId: string): Promise<void> {
    await act(`task-start-${taskId}`, async () => {
      await window.ndDshOrganization.mutate({
        type: 'task.update',
        id: taskId,
        patch: { status: 'in_progress' },
      })
    })
  }

  async function addDecision(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!project || !activeMember) return
    await act('decision-add', async () => {
      await window.ndDshOrganization.mutate({
        type: 'decision.create',
        companyId,
        projectId: project.id,
        authorMemberId: activeMember.id,
        title: decisionDraft.title,
        summary: decisionDraft.summary,
        rationale: decisionDraft.rationale,
        ...(decisionDraft.taskId ? { taskId: decisionDraft.taskId } : {}),
      })
      setDecisionDraft({ title: '', summary: '', rationale: '', taskId: '' })
    })
  }

  async function requestApproval(): Promise<void> {
    if (!project || !activeMember || !approvalTaskId) return
    const task = tasks.find((item) => item.id === approvalTaskId)
    if (!task) return
    await act('approval-request', () => window.ndDshOrganization.mutate({
      type: 'approval.request',
      companyId,
      projectId: project.id,
      requesterMemberId: activeMember.id,
      taskId: task.id,
      targetKind: 'integration',
      targetId: task.id,
    }))
  }

  async function resolveApproval(id: string, verdict: OrganizationApprovalVerdictKind): Promise<void> {
    if (!activeMember) return
    await act(`approval-${id}-${verdict}`, async () => {
      await window.ndDshOrganization.mutate({
        type: 'approval.resolve',
        id,
        actorMemberId: activeMember.id,
        verdict,
        ...(approvalComment.trim() ? { comment: approvalComment.trim() } : {}),
      })
      setApprovalComment('')
    })
  }

  if (!projectId || !project) {
    return <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">Select a project to open team chat, decisions and approvals.</div>
  }

  return (
    <div className="grid grid-cols-1 gap-2.5 pb-8 min-[1180px]:grid-cols-[minmax(0,1.35fr)_minmax(340px,.65fr)]">
      <div className="grid min-w-0 gap-2.5">
        <CollabCard title="Project Chat" badge={`${messages.length} messages`}>
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border-soft bg-surface-0 p-2">
            <span className="text-xs text-faint">Acting locally as</span>
            <Select value={activeMemberId} onValueChange={setActiveMemberId}>
              <SelectTrigger className="h-8 w-[190px] border-border-strong bg-background"><SelectValue placeholder="Choose member" /></SelectTrigger>
              <SelectContent>{members.filter((item) => item.status === 'active').map((member) => <SelectItem key={member.id} value={member.id}>{member.displayName}</SelectItem>)}</SelectContent>
            </Select>
            <span className="text-[10px] text-faint">Local profile = attribution, not authentication.</span>
          </div>

          <div className="max-h-[330px] overflow-auto rounded-md border border-border-soft bg-surface-0 p-2">
            {messages.length ? messages.map((message) => {
              const { label: author, kind: authorKind } = authorKindLabel(message.author.id, members, agents)
              const task = message.taskId ? tasks.find((item) => item.id === message.taskId) : undefined
              return (
                <div key={message.id} className="border-b border-border-soft py-2 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="text-xs">{authorKind === 'agent' ? '🤖' : authorKind === 'human' ? '👤' : '⚙️'}</span>
                    <strong className="text-foreground">{author}</strong>
                    <span className="rounded border border-border-soft bg-secondary px-1 py-0.2 text-[9px] uppercase text-faint">{authorKind}</span>
                    {message.category && message.category !== 'chat' ? (
                      <span className="rounded border border-primary/25 bg-primary/10 px-1 py-0.2 font-mono text-[9px] uppercase text-primary">{message.category}</span>
                    ) : null}
                    {message.runId ? (
                      <span className="font-mono text-[9px] text-faint">run #{message.runId.slice(0, 8)}</span>
                    ) : null}
                    {task ? <span className="rounded border border-border-soft bg-secondary px-1.5 py-0.5 text-faint">{task.title}</span> : <span className="text-faint">project</span>}
                    <span className="ml-auto text-faint">{new Date(message.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="m-0 mt-1 whitespace-pre-wrap text-sm/[1.45] text-muted-foreground">{message.body}</p>
                </div>
              )
            }) : <Empty text="Start the project conversation. Team chat is durable project context, not an agent execution transcript." />}
          </div>

          <form className="mt-2 grid gap-2" onSubmit={(event) => void postMessage(event)}>
            <div className="grid grid-cols-[140px_110px_1fr] gap-2">
              <select className={input} value={messageDraft.taskId} onChange={(event) => setMessageDraft((current) => ({ ...current, taskId: event.target.value }))}>
                <option value="">Project chat</option>
                {tasks.map((task) => <option key={task.id} value={task.id}>Task · {task.title}</option>)}
              </select>
              <select className={input} value={messageDraft.category} onChange={(event) => setMessageDraft((current) => ({ ...current, category: event.target.value as any }))}>
                <option value="chat">Chat</option>
                <option value="question">Question</option>
                <option value="reply">Reply</option>
                <option value="status">Status</option>
                <option value="handoff">Handoff</option>
              </select>
              <input className={input} placeholder="Use @Member or @Agent names to mention…" value={messageDraft.body} onChange={(event) => setMessageDraft((current) => ({ ...current, body: event.target.value }))} required />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-faint">Chat, reactions and “looks good” never grant approval.</span>
              <button className={primaryButton} disabled={busy !== null || !activeMember}>Post</button>
            </div>
          </form>
        </CollabCard>

        <CollabCard title="Team Tasks & Mixed Handoffs" badge={`${tasks.length} tasks`}>
          <div className="max-h-[360px] overflow-auto rounded-md border border-border-soft bg-surface-0 p-2">
            {tasks.length ? tasks.map((task) => {
              const assigneeHuman = task.assignedMemberId ? members.find((m) => m.id === task.assignedMemberId) : undefined
              const assigneeAgent = task.assignedAgentId ? agents.find((a) => a.id === task.assignedAgentId) : undefined
              const accountable = task.accountableMemberId ? members.find((m) => m.id === task.accountableMemberId) : undefined
              const reviewerHuman = task.reviewerMemberId ? members.find((m) => m.id === task.reviewerMemberId) : undefined
              const reviewerAgent = task.reviewerAgentId ? agents.find((a) => a.id === task.reviewerAgentId) : undefined
              const lastHandoff = task.handoffs?.length ? task.handoffs[task.handoffs.length - 1] : undefined
              const isHumanAssignee = task.assigneeKind === 'human' || Boolean(task.assignedMemberId && !task.assignedAgentId)
              const isReassigning = reassigningTaskId === task.id
              const isSubmitting = submittingTaskId === task.id

              return (
                <div key={task.id} className="border-b border-border-soft py-2.5 last:border-b-0">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <strong className="text-xs text-foreground">{task.title}</strong>
                    <div className="flex items-center gap-1.5">
                      <span className="rounded border border-border-soft bg-secondary px-1.5 py-0.5 text-[10px] font-mono uppercase text-faint">{task.priority}</span>
                      <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase', task.status === 'completed' ? 'border border-primary/25 bg-primary/10 text-primary' : task.status === 'in_progress' ? 'border border-info/25 bg-info/10 text-info' : task.status === 'review' ? 'border border-warning/25 bg-warning/10 text-warning' : 'border border-border-soft bg-secondary text-faint')}>{task.status.replace('_', ' ')}</span>
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span>
                      Assignee: {isHumanAssignee ? <span className="font-medium text-foreground">👤 {assigneeHuman?.displayName ?? 'Human member'}</span> : assigneeAgent ? <span className="font-medium text-foreground">🤖 {assigneeAgent.name}</span> : <span className="text-faint">Unassigned</span>}
                    </span>
                    {accountable ? (
                      <span className="text-faint">· Accountable: <span className="text-foreground">👤 {accountable.displayName}</span></span>
                    ) : null}
                    {task.reviewerKind === 'human' && reviewerHuman ? (
                      <span className="text-faint">· Reviewer: <span className="text-foreground">👤 {reviewerHuman.displayName}</span></span>
                    ) : reviewerAgent ? (
                      <span className="text-faint">· Reviewer: <span className="text-foreground">🤖 {reviewerAgent.name}</span></span>
                    ) : null}
                  </div>
                  {lastHandoff ? (
                    <div className="mt-1 rounded bg-secondary/50 px-2 py-1 text-[10px] text-faint">
                      <span>Handoff: {lastHandoff.fromAssignee?.kind ?? 'agent'} ➔ {lastHandoff.toAssignee?.kind ?? 'human'}</span>
                      {lastHandoff.reason ? <span className="ml-1 text-soft">({lastHandoff.reason})</span> : null}
                      <span className="ml-auto float-right">{new Date(lastHandoff.timestamp).toLocaleTimeString()}</span>
                    </div>
                  ) : null}

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {isHumanAssignee && task.status === 'ready' ? (
                      <button className={primaryButton} disabled={busy !== null} onClick={() => void startHumanTask(task.id)}>Start work</button>
                    ) : null}
                    {isHumanAssignee && task.status === 'in_progress' ? (
                      <button className={primaryButton} disabled={busy !== null} onClick={() => { setSubmittingTaskId((curr) => curr === task.id ? null : task.id); setReassigningTaskId(null) }}>
                        {isSubmitting ? 'Cancel submit' : 'Submit work'}
                      </button>
                    ) : null}
                    <button className={button} disabled={busy !== null} onClick={() => { setReassigningTaskId((curr) => curr === task.id ? null : task.id); setSubmittingTaskId(null); setReassignTargetKind(isHumanAssignee ? 'agent' : 'human'); setReassignTargetId(isHumanAssignee ? (agents[0]?.id ?? '') : (members[0]?.id ?? '')) }}>
                      {isReassigning ? 'Cancel reassign' : 'Reassign / Handoff'}
                    </button>
                  </div>

                  {isSubmitting ? (
                    <div className="mt-2 grid gap-1.5 rounded-md border border-primary/20 bg-primary/[0.03] p-2">
                      <span className="text-xs font-medium text-foreground">Submit human work for review</span>
                      <input className={input} placeholder="Work summary / evidence notes (required)" value={submitSummary} onChange={(e) => setSubmitSummary(e.target.value)} required />
                      <input className={input} placeholder="Optional checkpoint commit / hash" value={submitCommit} onChange={(e) => setSubmitCommit(e.target.value)} />
                      <div className="flex justify-end gap-1.5">
                        <button type="button" className={button} onClick={() => setSubmittingTaskId(null)}>Cancel</button>
                        <button type="button" className={primaryButton} disabled={busy !== null || !submitSummary.trim()} onClick={() => void submitWork(task.id)}>Confirm submission</button>
                      </div>
                    </div>
                  ) : null}

                  {isReassigning ? (
                    <div className="mt-2 grid gap-1.5 rounded-md border border-border-strong bg-secondary/40 p-2">
                      <span className="text-xs font-medium text-foreground">Reassign task with audit trail</span>
                      <div className="grid grid-cols-[130px_1fr] gap-1.5">
                        <select className={input} value={reassignTargetKind} onChange={(e) => { const k = e.target.value as TaskAssigneeKind; setReassignTargetKind(k); setReassignTargetId(k === 'human' ? (members[0]?.id ?? '') : (agents[0]?.id ?? '')) }}>
                          <option value="human">👤 Human</option>
                          <option value="agent">🤖 Agent</option>
                        </select>
                        <select className={input} value={reassignTargetId} onChange={(e) => setReassignTargetId(e.target.value)}>
                          {reassignTargetKind === 'human'
                            ? members.filter((m) => m.status === 'active').map((m) => <option key={m.id} value={m.id}>{m.displayName} ({m.accessRole ?? 'contributor'})</option>)
                            : agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)
                          }
                        </select>
                      </div>
                      <input className={input} placeholder="Reason for handoff (e.g. Domain specialist or escalations)" value={reassignReason} onChange={(e) => setReassignReason(e.target.value)} />
                      <div className="flex justify-end gap-1.5">
                        <button type="button" className={button} onClick={() => setReassigningTaskId(null)}>Cancel</button>
                        <button type="button" className={primaryButton} disabled={busy !== null || !reassignTargetId} onClick={() => void reassignTask(task.id)}>Confirm reassign</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            }) : <Empty text="No project tasks found. Create tasks in the Company Workspace." />}
          </div>
        </CollabCard>

        <CollabCard title="Decisions" badge={`${decisions.filter((item) => item.status === 'active').length} active`}>
          <form className="grid gap-2" onSubmit={(event) => void addDecision(event)}>
            <div className="grid grid-cols-[1fr_180px] gap-2">
              <input className={input} placeholder="Decision title" value={decisionDraft.title} onChange={(event) => setDecisionDraft((current) => ({ ...current, title: event.target.value }))} required />
              <select className={input} value={decisionDraft.taskId} onChange={(event) => setDecisionDraft((current) => ({ ...current, taskId: event.target.value }))}>
                <option value="">Project-wide</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
              </select>
            </div>
            <input className={input} placeholder="Decision summary" value={decisionDraft.summary} onChange={(event) => setDecisionDraft((current) => ({ ...current, summary: event.target.value }))} required />
            <textarea className={cn(input, 'min-h-[64px] resize-y')} placeholder="Rationale / constraints" value={decisionDraft.rationale} onChange={(event) => setDecisionDraft((current) => ({ ...current, rationale: event.target.value }))} required />
            <button className={primaryButton} disabled={busy !== null || !activeMember}>Record durable decision</button>
          </form>
          <div className="mt-2 grid gap-2">
            {decisions.slice(0, 8).map((item) => <div key={item.id} className="rounded-md border border-border-soft bg-surface-0 p-2"><div className="flex items-center justify-between gap-2"><strong className="text-sm">{item.title}</strong><span className="text-[10px] uppercase text-faint">{item.status}</span></div><p className="m-0 mt-1 text-xs text-muted-foreground">{item.summary}</p><small className="mt-1 block text-faint">{item.rationale}</small></div>)}
            {!decisions.length ? <Empty text="Important product and architecture choices belong here instead of disappearing inside chat." /> : null}
          </div>
        </CollabCard>
      </div>

      <div className="grid content-start gap-2.5">
        <CollabCard title="Needs You" badge={String(needsYou)}>
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Pending approvals" value={pendingApprovals} />
            <Metric label="Mentions (history)" value={mentioned.length} />
            <Metric label="Control actions" value={managementNeedsYou} />
            <Metric label="Review tasks" value={reviewTasks} />
            <Metric label="Blocked tasks" value={blockedTasks} />
            <Metric label="New signals" value={newSignals} />
          </div>
          <p className="m-0 mt-2 text-[11px] text-faint">One local attention surface now combines collaboration, control-plane gates/actions, blocked work, reviews and automation/heartbeat signals.</p>
        </CollabCard>

        <CollabCard title="Explicit Approval">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <select className={input} value={approvalTaskId} onChange={(event) => setApprovalTaskId(event.target.value)}>
              <option value="">Choose checkpointed task…</option>
              {tasks.filter((task) => latestCheckpoint(task, state) && task.integrationState !== 'integrated').map((task) => <option key={task.id} value={task.id}>{task.title} · {latestCheckpoint(task, state)}</option>)}
            </select>
            <button className={primaryButton} disabled={busy !== null || !approvalTaskId || !activeMember} onClick={() => void requestApproval()}>Request</button>
          </div>
          <p className="m-0 mt-1 text-[10px] text-faint">Request integration approval before merge-back. It binds to the exact checkpoint; changed or already-integrated work fails closed because approval never pretends to undo code.</p>
          <input
            className={cn(input, 'mt-2 w-full')}
            placeholder="Approval note / reason (recommended for changes or rejection)"
            value={approvalComment}
            onChange={(event) => setApprovalComment(event.target.value)}
          />

          <div className="mt-2 grid gap-2">
            {approvals.slice(0, 8).map((item) => (
              <div key={item.id} className="rounded-md border border-border-soft bg-surface-0 p-2">
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-xs">{taskName(item.taskId, tasks)} · {item.targetKind}</strong>
                  <span className={cn('text-[10px] font-bold uppercase', item.status === 'approved' ? 'text-primary' : item.status === 'pending' ? 'text-warning' : 'text-destructive')}>{item.status.replace('_', ' ')}</span>
                </div>
                {item.targetRevision ? <p className="m-0 mt-1 font-mono text-[10px] text-faint">{item.targetKind === 'task-review' && state?.tasks.find((task) => task.id === item.taskId)?.humanSubmission ? 'submission' : 'checkpoint'} {item.targetRevision}</p> : null}
                {item.status === 'pending' ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button className={primaryButton} disabled={busy !== null || !activeMember} onClick={() => void resolveApproval(item.id, 'approve')}>Approve</button>
                    <button className={button} disabled={busy !== null || !activeMember} onClick={() => void resolveApproval(item.id, 'request_changes')}>Request changes</button>
                    <button className={cn(button, 'border-destructive/30 text-destructive')} disabled={busy !== null || !activeMember} onClick={() => void resolveApproval(item.id, 'reject')}>Reject</button>
                  </div>
                ) : null}
              </div>
            ))}
            {!approvals.length ? <Empty text="Checkpoint-bound human approvals appear here. Friendly chat never creates one." /> : null}
          </div>
        </CollabCard>

        <CollabCard title="Local Human Members" badge={String(members.filter((item) => item.status === 'active').length)}>
          <form className="grid gap-2" onSubmit={(event) => void addMember(event)}>
            <input className={input} placeholder="Display name" value={memberDraft.displayName} onChange={(event) => setMemberDraft((current) => ({ ...current, displayName: event.target.value }))} required />
            <div className="grid grid-cols-[1fr_110px_auto] gap-2">
              <input className={input} placeholder="Role / title (optional)" value={memberDraft.title} onChange={(event) => setMemberDraft((current) => ({ ...current, title: event.target.value }))} />
              <select className={input} value={memberDraft.accessRole} onChange={(event) => setMemberDraft((current) => ({ ...current, accessRole: event.target.value as OrganizationAccessRole }))}>
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="pm">PM</option>
                <option value="contributor">Contributor</option>
                <option value="reviewer">Reviewer</option>
                <option value="guest">Guest</option>
              </select>
              <button className={primaryButton} disabled={busy !== null}>Add</button>
            </div>
          </form>
          <div className="mt-2 grid gap-1.5">
            {members.map((member) => <MemberLine key={member.id} member={member} active={member.id === activeMemberId} onSelect={() => setActiveMemberId(member.id)} />)}
          </div>
        </CollabCard>

        <CollabCard title="Agent Handoff">
          <p className="m-0 text-xs/[1.45] text-muted-foreground">Collaboration chat stays durable and human-readable. Agent sessions remain execution transcripts with tools, subagents, files and browser actions.</p>
          {onAskAgent ? <button className={cn(primaryButton, 'mt-2')} onClick={() => onAskAgent(`Continue work for ${project.name}. Read the active project tasks, durable decisions and approval requirements before acting.`)}>Open Agent with project context</button> : null}
        </CollabCard>
      </div>
    </div>
  )
}

function CollabCard({ title, badge, children }: { title: string; badge?: string; children: ReactNode }) {
  return <UiCard className="min-w-0 rounded-lg border-border-soft bg-card p-3 shadow-none"><div className="mb-2 flex items-center justify-between gap-2"><h3 className="m-0 text-sm font-semibold">{title}</h3>{badge ? <span className="rounded-full border border-border-soft bg-secondary px-2 py-0.5 text-[10px] text-faint">{badge}</span> : null}</div>{children}</UiCard>
}

function MemberLine({ member, active, onSelect }: { member: OrganizationMember; active: boolean; onSelect(): void }) {
  const role = member.accessRole ?? 'contributor'
  const capabilities = resolveMemberCapabilities(member)
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn('flex items-center justify-between rounded-md border px-2 py-1.5 text-left', active ? 'border-primary/30 bg-primary/[0.06]' : 'border-border-soft bg-surface-0')}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <strong className="block truncate text-xs">{member.displayName}</strong>
          <span className={cn('rounded px-1.5 py-0.2 text-[9px] font-bold uppercase tracking-wide', roleBadgeClass(role))}>
            {role}
          </span>
        </div>
        <span className="text-[10px] text-faint">
          {member.title ?? 'Team member'} · {capabilities.size} cap{capabilities.size === 1 ? '' : 's'}
        </span>
      </div>
      <span className="text-[10px] uppercase text-faint">{member.status}</span>
    </button>
  )
}

function roleBadgeClass(role: OrganizationAccessRole): string {
  switch (role) {
    case 'owner':
      return 'border border-purple-500/30 bg-purple-500/10 text-purple-400'
    case 'admin':
      return 'border border-blue-500/30 bg-blue-500/10 text-blue-400'
    case 'pm':
      return 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
    case 'reviewer':
      return 'border border-amber-500/30 bg-amber-500/10 text-amber-400'
    case 'guest':
      return 'border border-border-soft bg-secondary text-muted-foreground'
    case 'contributor':
    default:
      return 'border border-border-strong bg-secondary/80 text-foreground'
  }
}

function authorKindLabel(authorId: string, members: OrganizationMember[], agents: Array<{ id: string; name: string }>): { label: string; kind: 'human' | 'agent' | 'system' } {
  const member = members.find((item) => item.id === authorId)
  if (member) return { label: member.displayName, kind: 'human' }
  const agent = agents.find((item) => item.id === authorId)
  if (agent) return { label: agent.name, kind: 'agent' }
  return { label: 'System', kind: 'system' }
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-md border border-border-soft bg-surface-0 p-2"><strong className="block text-base">{value}</strong><span className="text-[10px] uppercase text-faint">{label}</span></div>
}

function Empty({ text }: { text: string }) {
  return <p className="m-0 rounded-md border border-dashed border-border-strong p-3 text-center text-xs text-faint">{text}</p>
}

function actorName(id: string, members: OrganizationMember[], agents: Array<{ id: string; name: string }>): string {
  return members.find((item) => item.id === id)?.displayName ?? agents.find((item) => item.id === id)?.name ?? 'System'
}

function taskName(id: string | undefined, tasks: OrganizationTask[]): string {
  return tasks.find((item) => item.id === id)?.title ?? 'Workspace action'
}

function latestCheckpoint(task: OrganizationTask, state: OrganizationSnapshot | null): string | undefined {
  return state?.runs.find((item) => item.taskId === task.id && item.checkpointCommit)?.checkpointCommit
}

function resolveMentions(body: string, members: OrganizationMember[], agents: Array<{ id: string; name: string }>): string[] {
  const normalized = body.toLowerCase()
  const candidates = [
    ...members.filter((item) => item.status === 'active').map((item) => ({ id: item.id, name: item.displayName })),
    ...agents,
  ]
  return candidates.filter((item) => normalized.includes(`@${item.name.toLowerCase()}`)).map((item) => item.id)
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
