import { randomBytes } from 'node:crypto'
import type { SnapshotCache } from './cache.js'
import { findProject } from './config.js'
import { docRelPath } from './scanner.js'
import { assertSafeId, readProjectFile } from './security.js'
import type { TicketStore } from './tickets.js'
import { validateTicketInput } from './tickets.js'
import type {
  ActionPayload,
  AssistantEvent,
  HubConfig,
  PendingAction,
  RouterChatMessage,
  TicketPriority,
  TicketStatus,
} from './types.js'
import { HttpError } from './types.js'
import { clip, type WriteService } from './writes.js'

const MAX_ROUNDS = 4
const MAX_ACTIONS_PER_TURN = 4
const ACTION_TTL_MS = 10 * 60_000
const JOB_TTL_MS = 10 * 60_000
const MAX_JOBS = 20
const SYSTEM_BUDGET = 11_000
const HISTORY_BUDGET = 6_000
const READ_RESULT_BUDGET = 6_000
export const MAX_USER_MESSAGE = 4_000
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/

/** Transport-agnostic router surface; RouterClient and ND's playground both fit. */
export interface RouterChatPort {
  models(): Promise<string[]>
  chat(options: {
    messages: RouterChatMessage[]
    model: string
    signal?: AbortSignal
    onDelta?: (text: string) => void
  }): Promise<{ text: string }>
}

export interface AssistantDeps {
  config: HubConfig
  cache: SnapshotCache
  tickets: TicketStore
  writes?: WriteService
  writesEnabled: boolean
  router?: RouterChatPort
  defaultModel?: string
  activeProject?: { get(): string | null; set(projectId: string | null): void }
}

export interface ChatRequest {
  projectId?: string
  message: string
  history?: RouterChatMessage[]
  model?: string
}

export interface AssistantJob {
  id: string
  status: 'running' | 'done' | 'error'
  events: AssistantEvent[]
  createdAt: number
  expiresAt: number
}

interface ProtocolBlock {
  type: 'read' | 'action'
  body: string
}

export function extractBlocks(text: string): { blocks: ProtocolBlock[]; cleanText: string } {
  const pattern = /```hub-(read|action)[ \t]*\r?\n([\s\S]*?)```/g
  const blocks: ProtocolBlock[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    blocks.push({ type: match[1] as 'read' | 'action', body: (match[2] ?? '').trim() })
  }
  return { blocks, cleanText: text.replace(pattern, '').replace(/\n{3,}/g, '\n\n').trim() }
}

export function parseActionPayload(raw: unknown): ActionPayload {
  if (typeof raw !== 'object' || raw === null) {
    throw new HttpError(400, 'invalid-action', 'action must be a JSON object')
  }
  const rec = raw as Record<string, unknown>
  const kind = rec.kind
  const projectId = rec.projectId
  if (typeof projectId !== 'string') throw new HttpError(400, 'invalid-action', 'action requires projectId')
  assertSafeId(projectId, 'project id')
  switch (kind) {
    case 'edit-doc': {
      const docId = rec.docId
      if (typeof docId !== 'string') throw new HttpError(400, 'invalid-action', 'edit-doc requires docId')
      docRelPath(docId)
      const mode = rec.mode
      if (mode !== 'append' && mode !== 'replace' && mode !== 'replace-section') {
        throw new HttpError(400, 'invalid-action', 'edit-doc mode must be append, replace, or replace-section')
      }
      const content = rec.content
      if (typeof content !== 'string' || content.length === 0 || content.length > 32_000) {
        throw new HttpError(400, 'invalid-action', 'edit-doc content must be 1-32000 characters')
      }
      const section = rec.section
      if (mode === 'replace-section' && (typeof section !== 'string' || section.trim().length === 0)) {
        throw new HttpError(400, 'invalid-action', 'replace-section requires a section heading')
      }
      return {
        kind,
        projectId,
        docId,
        mode,
        content,
        ...(typeof section === 'string' ? { section: section.trim() } : {}),
      }
    }
    case 'toggle-checklist': {
      const docId = rec.docId
      if (typeof docId !== 'string') throw new HttpError(400, 'invalid-action', 'toggle-checklist requires docId')
      docRelPath(docId)
      return { kind, projectId, docId, ...toggleFields(rec) }
    }
    case 'toggle-task': {
      const changeId = rec.changeId
      if (typeof changeId !== 'string') throw new HttpError(400, 'invalid-action', 'toggle-task requires changeId')
      assertSafeId(changeId, 'change id')
      const fields = toggleFields(rec)
      return { kind, projectId, changeId, taskText: fields.itemText, done: fields.done }
    }
    case 'create-ticket': {
      const validated = validateTicketInput({
        title: rec.title as string,
        ...(typeof rec.description === 'string' ? { description: rec.description } : {}),
        ...(rec.priority !== undefined ? { priority: rec.priority as TicketPriority } : {}),
        ...(typeof rec.linkedChangeId === 'string' ? { linkedChangeId: rec.linkedChangeId } : {}),
      })
      return {
        kind,
        projectId,
        title: validated.title,
        ...(validated.description ? { description: validated.description } : {}),
        ...(rec.priority !== undefined ? { priority: validated.priority } : {}),
        ...(validated.linkedChangeId ? { linkedChangeId: validated.linkedChangeId } : {}),
      }
    }
    case 'update-ticket': {
      const ticketId = rec.ticketId
      if (typeof ticketId !== 'string') throw new HttpError(400, 'invalid-action', 'update-ticket requires ticketId')
      assertSafeId(ticketId, 'ticket id')
      const patch: Extract<ActionPayload, { kind: 'update-ticket' }> = { kind, projectId, ticketId }
      if (rec.title !== undefined) patch.title = rec.title as string
      if (rec.description !== undefined) patch.description = rec.description as string
      if (rec.status !== undefined) patch.status = rec.status as TicketStatus
      if (rec.priority !== undefined) patch.priority = rec.priority as TicketPriority
      if (rec.linkedChangeId !== undefined) {
        patch.linkedChangeId = rec.linkedChangeId === null ? null : (rec.linkedChangeId as string)
      }
      if (Object.keys(patch).length <= 3) {
        throw new HttpError(400, 'invalid-action', 'update-ticket requires at least one field to change')
      }
      validateTicketInput({
        title: patch.title ?? 'placeholder',
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.linkedChangeId !== undefined && patch.linkedChangeId !== null
          ? { linkedChangeId: patch.linkedChangeId }
          : {}),
      })
      return patch
    }
    default:
      throw new HttpError(400, 'invalid-action', 'action kind is not recognized')
  }
}

function toggleFields(rec: Record<string, unknown>): { itemText: string; done: boolean } {
  const itemText = rec.itemText ?? rec.taskText
  if (typeof itemText !== 'string' || itemText.trim().length === 0 || itemText.length > 500) {
    throw new HttpError(400, 'invalid-action', 'toggle requires itemText (1-500 characters)')
  }
  if (typeof rec.done !== 'boolean') throw new HttpError(400, 'invalid-action', 'toggle requires a boolean done')
  return { itemText: itemText.trim(), done: rec.done }
}

export class AssistantEngine {
  private actions = new Map<string, PendingAction>()
  private jobs = new Map<string, AssistantJob>()

  constructor(private readonly deps: AssistantDeps) {}

  get writesEnabled(): boolean {
    return this.deps.writesEnabled
  }

  get configured(): boolean {
    return this.deps.router !== undefined
  }

  /** Stored default project, or null when unset or no longer registered. */
  getActiveProject(): string | null {
    const id = this.deps.activeProject?.get() ?? null
    return id && this.deps.config.projects.some((p) => p.id === id) ? id : null
  }

  setActiveProject(projectId: string | null): string | null {
    if (!this.deps.activeProject) {
      throw new HttpError(503, 'active-project-unavailable', 'active project store is not configured')
    }
    if (projectId === null || projectId === '') {
      this.deps.activeProject.set(null)
      return null
    }
    assertSafeId(projectId, 'project id')
    findProject(this.deps.config, projectId)
    this.deps.activeProject.set(projectId)
    return projectId
  }

  async models(): Promise<{ models: string[]; default: string | null }> {
    if (!this.deps.router) return { models: [], default: null }
    const models = await this.deps.router.models()
    const preferred = this.deps.defaultModel
    const fallback = preferred && models.includes(preferred) ? preferred : (models[0] ?? null)
    return { models, default: fallback }
  }

  /** One chat turn; events stream to the caller (SSE in standalone, job buffer in ND). */
  async chat(req: ChatRequest, emit: (event: AssistantEvent) => void, signal?: AbortSignal): Promise<void> {
    const router = this.deps.router
    if (!router) {
      emit({ type: 'error', code: 'assistant-unavailable', message: 'ND Router is not configured for the Hub. Set HUB_ROUTER_KEY (and HUB_ROUTER_URL if discovery fails).' })
      return
    }
    try {
      if (typeof req.message !== 'string' || req.message.trim().length === 0 || req.message.length > MAX_USER_MESSAGE) {
        throw new HttpError(400, 'invalid-message', `message must be 1-${MAX_USER_MESSAGE} characters`)
      }
      if (req.projectId !== undefined) {
        assertSafeId(req.projectId, 'project id')
        findProject(this.deps.config, req.projectId)
      }
      const { models, default: defaultModel } = await this.models()
      const model = req.model ?? defaultModel
      if (!model || !MODEL_PATTERN.test(model)) {
        throw new HttpError(400, 'invalid-model', 'choose a valid model/combo id')
      }
      if (models.length > 0 && !models.includes(model)) {
        throw new HttpError(400, 'unknown-model', 'model is not in the ND Router catalog')
      }
      const system = await this.buildSystemPrompt(req.projectId)
      const messages: RouterChatMessage[] = [
        { role: 'system', content: system },
        ...clipHistory(req.history),
        { role: 'user', content: req.message },
      ]
      let rounds = 0
      let finalText = ''
      const previews: Array<Promise<void>> = []
      for (;;) {
        rounds += 1
        const result = await router.chat({
          messages,
          model,
          ...(signal ? { signal } : {}),
          onDelta: (text) => emit({ type: 'delta', text }),
        })
        const { blocks, cleanText } = extractBlocks(result.text)
        finalText = cleanText
        for (const block of blocks.filter((b) => b.type === 'action').slice(0, MAX_ACTIONS_PER_TURN)) {
          previews.push(this.proposeAction(block.body, emit))
        }
        const read = blocks.find((b) => b.type === 'read')
        if (read && rounds < MAX_ROUNDS) {
          const outcome = await this.executeRead(read.body)
          emit({ type: 'read', target: outcome.target, ok: outcome.ok })
          messages.push({ role: 'assistant', content: clip(result.text, 4_000) })
          messages.push({ role: 'user', content: `hub-read result (${outcome.target}):\n${clip(outcome.text, READ_RESULT_BUDGET)}` })
          continue
        }
        break
      }
      // Action events must precede done: ND clients stop polling at done.
      await Promise.all(previews)
      emit({ type: 'done', text: finalText, model, rounds })
    } catch (error) {
      if (error instanceof HttpError) {
        emit({ type: 'error', code: error.code, message: error.message })
        return
      }
      emit({ type: 'error', code: 'assistant-failed', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Start a buffered job (ND extension ask/poll pattern). */
  ask(req: ChatRequest): { jobId: string } {
    this.pruneJobs()
    if (this.jobs.size >= MAX_JOBS) {
      const oldest = [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0]
      if (oldest) this.jobs.delete(oldest.id)
    }
    const job: AssistantJob = {
      id: `j-${randomBytes(4).toString('hex')}`,
      status: 'running',
      events: [],
      createdAt: Date.now(),
      expiresAt: Date.now() + JOB_TTL_MS,
    }
    this.jobs.set(job.id, job)
    const controller = new AbortController()
    void this.chat(req, (event) => {
      job.events.push(event)
      if (event.type === 'done') job.status = 'done'
      if (event.type === 'error') job.status = 'error'
    }, controller.signal).catch(() => {
      job.status = 'error'
    })
    return { jobId: job.id }
  }

  poll(jobId: string, since = 0): { status: AssistantJob['status']; events: AssistantEvent[]; next: number } {
    const job = this.jobs.get(jobId)
    if (!job) throw new HttpError(404, 'unknown-job', 'chat job not found or expired')
    const events = job.events.slice(since)
    return { status: job.status, events, next: job.events.length }
  }

  listActions(): PendingAction[] {
    this.pruneActions()
    return [...this.actions.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  async approve(actionId: string): Promise<PendingAction> {
    const action = this.requirePending(actionId)
    if (!this.deps.writes || !this.deps.writesEnabled) {
      throw new HttpError(403, 'writes-disabled', 'writes are not enabled on this Hub')
    }
    try {
      const result = await this.deps.writes.execute(action.payload, action.preview)
      action.status = 'approved'
      action.result = result
    } catch (error) {
      action.status = 'failed'
      action.result = error instanceof Error ? error.message : String(error)
      throw error
    }
    return action
  }

  reject(actionId: string): PendingAction {
    const action = this.requirePending(actionId)
    action.status = 'rejected'
    return action
  }

  private requirePending(actionId: string): PendingAction {
    this.pruneActions()
    const action = this.actions.get(actionId)
    if (!action) throw new HttpError(404, 'unknown-action', 'action not found or expired')
    if (action.status !== 'pending') throw new HttpError(409, 'action-resolved', `action is already ${action.status}`)
    return action
  }

  private proposeAction(body: string, emit: (event: AssistantEvent) => void): Promise<void> {
    if (!this.deps.writesEnabled || !this.deps.writes) {
      emit({ type: 'action-error', message: 'Writes are disabled on this Hub; the proposed action was ignored.' })
      return Promise.resolve()
    }
    let payload: ActionPayload
    try {
      payload = parseActionPayload(JSON.parse(body))
      findProject(this.deps.config, payload.projectId)
    } catch (error) {
      emit({ type: 'action-error', message: error instanceof Error ? error.message : 'invalid action block' })
      return Promise.resolve()
    }
    return this.deps.writes.preview(payload).then(
      (preview) => {
        const action: PendingAction = {
          id: `a-${randomBytes(4).toString('hex')}`,
          payload,
          preview,
          createdAt: Date.now(),
          expiresAt: Date.now() + ACTION_TTL_MS,
          status: 'pending',
        }
        this.actions.set(action.id, action)
        emit({ type: 'action', action })
      },
      (error: unknown) => {
        emit({ type: 'action-error', message: error instanceof Error ? error.message : 'preview failed' })
      },
    )
  }

  private async executeRead(body: string): Promise<{ target: string; ok: boolean; text: string }> {
    let req: Record<string, unknown>
    try {
      req = JSON.parse(body) as Record<string, unknown>
    } catch {
      return { target: 'invalid block', ok: false, text: 'hub-read block was not valid JSON' }
    }
    const kind = req.kind
    try {
      if (kind === 'portfolio') {
        const cards = await this.deps.cache.portfolio()
        return { target: 'portfolio', ok: true, text: JSON.stringify(cards) }
      }
      const projectId = req.projectId
      if (typeof projectId !== 'string') throw new HttpError(400, 'invalid-read', 'read requires projectId')
      assertSafeId(projectId, 'project id')
      const project = findProject(this.deps.config, projectId)
      if (kind === 'doc') {
        const docId = req.docId
        if (typeof docId !== 'string') throw new HttpError(400, 'invalid-read', 'doc read requires docId')
        const rel = docRelPath(docId)
        const markdown = readProjectFile(project.path, rel)
        return { target: `${projectId}/${rel}`, ok: true, text: markdown }
      }
      if (kind === 'spec') {
        const capability = req.capability
        if (typeof capability !== 'string') throw new HttpError(400, 'invalid-read', 'spec read requires capability')
        assertSafeId(capability, 'capability id')
        const snapshot = await this.deps.cache.get(projectId)
        const spec = snapshot.specs.find((s) => s.id === capability)
        if (!spec) throw new HttpError(404, 'unknown-spec', 'capability not found')
        return { target: `${projectId}/specs/${capability}`, ok: true, text: JSON.stringify(spec) }
      }
      if (kind === 'change') {
        const changeId = req.changeId
        if (typeof changeId !== 'string') throw new HttpError(400, 'invalid-read', 'change read requires changeId')
        const detail = await this.deps.cache.changeDetail(projectId, changeId)
        return { target: `${projectId}/changes/${changeId}`, ok: true, text: JSON.stringify(detail) }
      }
      if (kind === 'tickets') {
        const tickets = this.deps.tickets.list(projectId)
        return { target: `${projectId}/tickets`, ok: true, text: JSON.stringify(tickets) }
      }
      throw new HttpError(400, 'invalid-read', 'read kind is not recognized')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { target: `${String(kind)}`, ok: false, text: `read failed: ${message}` }
    }
  }

  private async buildSystemPrompt(projectId?: string): Promise<string> {
    const parts: string[] = [
      'You are the OpenSpec Hub assistant: you answer questions about spec-driven projects, manage tickets, and propose PRD/documentation edits.',
      'Answer in concise GitHub markdown. Cite project ids and file paths. Never invent spec content; read it first.',
      '',
      '## Tool protocol (plain text, works on every model lane)',
      'To read more context, emit ONE fenced block and stop; the result arrives as the next user message (max 3 reads per turn):',
      '```hub-read',
      '{"kind":"doc","projectId":"<id>","docId":"prd"}',
      '```',
      'Read kinds: portfolio (no other fields) | doc {projectId,docId} | spec {projectId,capability} | change {projectId,changeId} | tickets {projectId}.',
      'docIds: prd, pm-brd, brd-sync-checklist, architecture, api, roadmap, readme, agents, adr/<name>.',
    ]
    if (this.deps.writesEnabled) {
      parts.push(
        '',
        '## Proposing writes (the user approves each one in the UI; NEVER claim a write already happened)',
        'Emit fenced hub-action blocks (max 4 per turn). Kinds:',
        '```hub-action',
        '{"kind":"edit-doc","projectId":"<id>","docId":"prd","mode":"replace-section","section":"Goals","content":"new section body"}',
        '```',
        '- edit-doc: mode append | replace | replace-section (section = exact heading text; content = new body under that heading).',
        '- toggle-checklist: {"kind":"toggle-checklist","projectId":"<id>","docId":"brd-sync-checklist","itemText":"exact item text","done":true}',
        '- toggle-task: {"kind":"toggle-task","projectId":"<id>","changeId":"<change>","taskText":"exact task text","done":true}',
        '- create-ticket: {"kind":"create-ticket","projectId":"<id>","title":"...","description":"...","priority":"low|medium|high","linkedChangeId":"optional"}',
        '- update-ticket: {"kind":"update-ticket","projectId":"<id>","ticketId":"t-...","status":"open|in-progress|done", ...optional title/description/priority/linkedChangeId}',
        'itemText/taskText must match an existing line exactly and uniquely. After proposing, tell the user approval is pending.',
      )
    } else {
      parts.push('', 'Writes are DISABLED on this Hub. Do not emit hub-action blocks; explain that an operator must enable writes.')
    }
    parts.push('', '## Current context')
    const focused = projectId ?? this.getActiveProject()
    if (focused) {
      parts.push(await this.projectDigest(focused))
    } else {
      const cards = await this.deps.cache.portfolio()
      parts.push(JSON.stringify(cards.map((c) => ({
        id: c.id,
        name: c.name,
        available: c.available,
        totals: c.totals,
        validation: c.validationStatus,
        stages: c.stageCounts,
      }))))
      parts.push('Ask which project to focus on, or use hub-read for details.')
    }
    return clip(parts.join('\n'), SYSTEM_BUDGET)
  }

  private async projectDigest(projectId: string): Promise<string> {
    const snapshot = await this.deps.cache.get(projectId)
    if (!snapshot.available) {
      return `Project ${projectId} is unavailable: ${snapshot.error ?? 'unknown reason'}`
    }
    const digest = {
      id: snapshot.id,
      name: snapshot.name,
      totals: snapshot.totals,
      validation: snapshot.validation.status,
      specs: snapshot.specs.map((s) => ({
        id: s.id,
        overview: clip(s.overview, 300),
        requirements: s.requirements.map((r) => ({ name: r.name, scenarios: r.scenarios.map((sc) => sc.name) })),
        modifiedBy: s.modifiedBy,
      })),
      changes: snapshot.changes.filter((c) => !c.archived).map((c) => ({
        id: c.id,
        stage: c.stage,
        tasks: `${c.completedTasks}/${c.totalTasks}`,
        capabilities: c.capabilities,
      })),
      docs: snapshot.docs.map((d) => d.id),
      tickets: this.deps.tickets.list(projectId).map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority })),
    }
    const parts = [JSON.stringify(digest)]
    const project = findProject(this.deps.config, projectId)
    const prd = snapshot.docs.find((d) => d.id === 'prd')
    if (prd) {
      try {
        parts.push(`PRD excerpt:\n${clip(readProjectFile(project.path, prd.relPath), 2_500)}`)
      } catch {
        // Excerpt is best-effort.
      }
    }
    return parts.join('\n\n')
  }

  private pruneActions(): void {
    const now = Date.now()
    for (const action of this.actions.values()) {
      if (action.status === 'pending' && action.expiresAt <= now) action.status = 'expired'
    }
  }

  private pruneJobs(): void {
    const now = Date.now()
    for (const [id, job] of this.jobs) {
      if (job.expiresAt <= now) this.jobs.delete(id)
    }
  }
}

function clipHistory(history: RouterChatMessage[] | undefined): RouterChatMessage[] {
  if (!Array.isArray(history)) return []
  const valid = history
    .filter((m): m is RouterChatMessage =>
      Boolean(m) && typeof m === 'object' &&
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string')
    .slice(-6)
  let budget = HISTORY_BUDGET
  const out: RouterChatMessage[] = []
  for (const message of valid) {
    if (budget <= 0) break
    const content = clip(message.content, Math.min(1_500, budget))
    budget -= content.length
    out.push({ role: message.role, content })
  }
  return out
}