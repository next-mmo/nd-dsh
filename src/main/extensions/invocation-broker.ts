import { randomUUID } from 'node:crypto'
import { asNdContext, contextKey, describeContext, type NdContext } from '../../shared/nd-context.js'
import {
  ndHostMethod,
  type NdCommandContribution,
  type NdContributionKind,
  type NdExtensionManifest,
  type NdHostMethod,
  type NdViewContribution,
  type NdWorkflowContribution,
} from '../../shared/extension-package.js'
import type { OrganizationSnapshot } from '../../shared/organization.js'
import type {
  NdAuditDecision,
  NdCallerKind,
  NdCommandView,
  NdExtensionsStateView,
  NdGrantScope,
  NdInvocationError,
  NdInvocationRequest,
  NdInvocationResult,
  NdPendingApprovalView,
  NdViewData,
  NdViewRow,
} from '../../shared/nd-invocations.js'
import type { InvocationStateStore } from './invocation-state.js'
import type { NativeHostRegistry, NdHostCallContext } from './native-host.js'
import type { ExtensionPackageStore } from './package-store.js'

/** Organization surface the broker needs; company/project relationships are validated here. */
export interface NdOrganizationPort {
  state(): Promise<Pick<OrganizationSnapshot, 'companies' | 'projects' | 'memory'>>
  /**
   * Organization action policy for one company. `deny` always wins, including
   * over a user's own request; `ask` is satisfied by an explicit user gesture
   * or an agent grant; a missing policy resolves to `ask` in the store.
   */
  policy?(companyId: string, action: string): Promise<'allow' | 'ask' | 'deny'>
}

interface PendingApproval {
  view: NdPendingApprovalView
  request: NdInvocationRequest
  input: Record<string, unknown>
}

interface RunCredential {
  token: string
  sessionId: string
  engineId: string
  context: NdContext
  allowed: NdHostMethod[]
  expiresAt: number
}

interface ResolvedContribution {
  kind: NdContributionKind
  id: string
  host: NdHostMethod
  startsAgent: boolean
  contexts: readonly string[]
  pluginId?: string
}

const RUN_CREDENTIAL_TTL_MS = 12 * 60 * 60 * 1_000

/**
 * One trusted invocation service for launcher actions, rendered views, and
 * agent gateways. Effective authorization is the intersection of package
 * activation, contribution context support, declared permissions, and — for
 * agent callers — an explicit grant. Deny wins everywhere, every call is
 * re-checked against live records, and caller arguments never manufacture
 * authority.
 */
export class InvocationBroker {
  private pending = new Map<string, PendingApproval>()
  private runs = new Map<string, RunCredential>()
  private onApprovalRequested: ((approval: NdPendingApprovalView) => void) | undefined

  constructor(private readonly deps: {
    packages: ExtensionPackageStore
    state: InvocationStateStore
    host: NativeHostRegistry
    organization: NdOrganizationPort
  }) {}

  setOnApprovalRequested(listener: ((approval: NdPendingApprovalView) => void) | undefined): void {
    this.onApprovalRequested = listener
  }

  /** Contributions available in one context for the launcher and management UI. */
  async commands(context: NdContext): Promise<NdCommandView[]> {
    const views: NdCommandView[] = []
    for (const manifest of await this.activeManifests()) {
      const activation = await this.deps.state.activation(manifest.id, context)
      if (!activation?.enabled) continue
      for (const command of manifest.contributions.commands) {
        if (!command.contexts.includes(context.kind)) continue
        views.push(commandView(manifest.id, command))
      }
      for (const workflow of manifest.contributions.workflows) {
        if (!workflow.contexts.includes(context.kind)) continue
        views.push(workflowOpenCommand(manifest.id, workflow))
      }
    }
    return views.sort((left, right) => left.title.localeCompare(right.title))
  }

  async stateView(): Promise<NdExtensionsStateView> {
    const [packages, activations, grants, audit] = await Promise.all([
      this.deps.packages.list(),
      this.deps.state.activations(),
      this.deps.state.grants(),
      this.deps.state.audit(),
    ])
    return {
      packages: packages.sort((left, right) => left.name.localeCompare(right.name)),
      activations,
      grants,
      audit,
      pendingApprovals: [...this.pending.values()].map((entry) => entry.view),
    }
  }

  /**
   * Validate a context against trusted organization state. A caller supplying a
   * projectId that belongs to another company fails closed here, before any
   * contribution executes.
   */
  async resolveContext(context: NdContext): Promise<NdContext> {
    const parsed = asNdContext(context)
    if (parsed.kind === 'personal') return parsed
    const organization = await this.deps.organization.state()
    const company = organization.companies.find((item) => item.id === parsed.companyId)
    if (!company) throw new Error(`Unknown company for this ND context: ${parsed.companyId}`)
    if (parsed.kind === 'company') return parsed
    const project = organization.projects.find((item) => item.id === parsed.projectId)
    if (!project) throw new Error(`Unknown project for this ND context: ${parsed.projectId}`)
    if (project.companyId !== parsed.companyId) throw new Error('This project does not belong to the given company')
    return parsed
  }

  async invoke(request: NdInvocationRequest, options?: { credentialBacked?: boolean }): Promise<NdInvocationResult> {
    const startedAt = Date.now()
    const caller: NdCallerKind = request.caller === 'agent' ? 'agent' : 'user'
    const extensionId = typeof request.extensionId === 'string' ? request.extensionId.trim() : ''
    const contributionId = typeof request.contributionId === 'string' ? request.contributionId.trim() : ''
    const input = isRecord(request.input) ? request.input : {}
    const audit = (decision: NdAuditDecision, reason: string, extra?: { outcome?: 'ok' | 'failed'; host?: NdHostMethod; contextKey?: string }) =>
      this.deps.state.recordAudit({
        extensionId: extensionId || 'unknown',
        contributionId: contributionId || 'unknown',
        host: extra?.host ?? 'note.create',
        contextKey: extra?.contextKey ?? 'unknown',
        caller,
        decision,
        reason,
        ...(extra?.outcome ? { outcome: extra.outcome } : {}),
        durationMs: Date.now() - startedAt,
      }).catch(() => undefined)

    let context: NdContext
    try {
      context = await this.resolveContext(request.context)
    } catch (error) {
      await audit('denied', message(error))
      return failure('invalid', message(error))
    }
    const agentGrantKey = contextKey(context)

    const manifest = await this.deps.packages.activeManifest(extensionId)
    if (!manifest) {
      await audit('denied', 'unknown package', { contextKey: agentGrantKey })
      return failure('unavailable', `Extension package is not installed: ${extensionId}`)
    }
    // A view call may name one of the view's declared actions: the action's host
    // method runs, but it is still the same view contribution and the same
    // authorization path.
    const actionId = typeof input.action === 'string' ? input.action : undefined
    const contribution = resolveContribution(manifest, request.contributionKind, contributionId, actionId)
    if (!contribution) {
      await audit('denied', 'unknown contribution', { contextKey: agentGrantKey })
      return failure('invalid', `Unknown contribution ${contributionId} in ${extensionId}`)
    }
    const descriptor = ndHostMethod(contribution.host)!
    if (!(descriptor.contexts as readonly string[]).includes(context.kind)) {
      await audit('denied', `host method is not available in ${context.kind}`, { contextKey: agentGrantKey, host: contribution.host })
      return failure('denied', `“${descriptor.title}” is not available in ${describeContext(context)}.`)
    }
    if (!contribution.contexts.includes(context.kind)) {
      await audit('denied', `contribution is not available in ${context.kind}`, { contextKey: agentGrantKey, host: contribution.host })
      return failure('denied', `${manifest.name} is not available in ${describeContext(context)}.`)
    }
    if (!manifest.permissions.includes(descriptor.permission)) {
      await audit('denied', `missing permission ${descriptor.permission}`, { contextKey: agentGrantKey, host: contribution.host })
      return failure('denied', `${manifest.name} does not declare the ${descriptor.permission} permission`)
    }
    const activation = await this.deps.state.activation(extensionId, context)
    if (!activation?.enabled) {
      await audit('denied', 'package is not activated in this context', { contextKey: agentGrantKey, host: contribution.host })
      return failure('denied', `Activate ${manifest.name} for ${describeContext(context)} first.`)
    }
    if (context.kind !== 'personal' && this.deps.organization.policy) {
      // Deny wins over every user-level permission; a user gesture satisfies
      // "ask", while "allow" needs no further record.
      const effect = await this.deps.organization.policy(context.companyId, contribution.host).catch(() => 'ask' as const)
      if (effect === 'deny') {
        await audit('denied', 'organization policy denies this action', { contextKey: agentGrantKey, host: contribution.host })
        return failure('denied', `Company policy does not allow "${descriptor.title}".`)
      }
    }

    const settings = await this.deps.state.settingsFor(extensionId, context)
    const dispatchInput = { ...input, ...(contribution.pluginId ? { pluginId: contribution.pluginId } : {}) }

    if (caller === 'agent') {
      const grant = await this.deps.state.findGrant(extensionId, contribution.host, context)
      if (grant) {
        if (grant.scope === 'once') await this.deps.state.consumeGrant(grant.id)
      } else if (descriptor.sensitive || options?.credentialBacked !== true) {
        // Sensitive reads (screen, clipboard) always need an explicit grant,
        // even inside a supervised run. Other methods may ride the run's
        // permitted capabilities, which were authorized when the run started.
        const approval = this.createApproval({ manifest, contribution, context, input: dispatchInput, caller })
        await audit('approval-required', 'agent call requires an explicit grant', { contextKey: agentGrantKey, host: contribution.host })
        return {
          ok: false,
          error: { code: 'approval-required', message: `${manifest.name} needs your approval for ${descriptor.title}` },
          value: { approvalId: approval.view.approvalId },
        }
      }
    }

    return this.execute({
      manifest,
      contribution,
      context,
      input: dispatchInput,
      settings,
      caller,
      ...(typeof request.runId === 'string' ? { runId: request.runId.slice(0, 128) } : {}),
      audit,
    })
  }

  /** Approve a pending agent request: grant (once or remembered), then run it. */
  async approve(approvalId: string, remember = false): Promise<NdInvocationResult> {
    const pending = this.pending.get(approvalId)
    if (!pending) return failure('invalid', 'That approval request is no longer pending')
    this.pending.delete(approvalId)
    const manifest = await this.deps.packages.activeManifest(pending.request.extensionId)
    if (!manifest) return failure('unavailable', 'The extension package is no longer installed')
    // Resolve exactly like invoke() does: a view call may name one of its
    // actions in the input, and web views only exist through those actions.
    const pendingActionId = typeof pending.input.action === 'string' ? pending.input.action : undefined
    const contribution = resolveContribution(manifest, pending.request.contributionKind, pending.request.contributionId, pendingActionId)
    if (!contribution) return failure('invalid', 'The approved contribution no longer exists')
    await this.deps.state.addGrant({
      extensionId: pending.request.extensionId,
      host: contribution.host,
      context: pending.request.context,
      scope: remember ? 'remembered' : 'once',
    })
    return this.invoke({ ...pending.request, caller: 'agent', input: pending.input })
  }

  async deny(approvalId: string): Promise<void> {
    const pending = this.pending.get(approvalId)
    if (!pending) return
    this.pending.delete(approvalId)
    await this.deps.state.recordAudit({
      extensionId: pending.request.extensionId,
      contributionId: pending.request.contributionId,
      host: pending.view.host,
      contextKey: contextKey(pending.request.context),
      caller: 'agent',
      decision: 'denied',
      reason: 'user denied the request',
    }).catch(() => undefined)
  }

  /** Load one typed view through the same authorization path as any invocation. */
  async loadView(extensionId: string, viewId: string, context: NdContext): Promise<NdViewData> {
    const manifest = await this.deps.packages.activeManifest(extensionId)
    if (!manifest) throw new Error(`Extension package is not installed: ${extensionId}`)
    const view = manifest.contributions.views.find((item) => item.id === viewId)
    if (!view) throw new Error(`Unknown view ${viewId} in ${extensionId}`)
    if (!view.contexts.includes(context.kind)) throw new Error(`${manifest.name} views are not available in ${describeContext(context)}`)
    const actionViews = () => view.actions.map((action) => ({ id: action.id, title: action.title, host: action.host }))
    if (view.kind === 'web') {
      // A web view runs no data host: activation is the gate, and its UI talks
      // to host methods through the invoke path once it is actually open.
      const activation = await this.deps.state.activation(extensionId, context)
      if (!activation?.enabled) throw new Error(`Activate ${manifest.name} for ${describeContext(context)} first.`)
      return {
        extensionId,
        viewId: view.id,
        title: view.title,
        kind: 'web',
        context,
        rows: [],
        actions: actionViews(),
        ...(view.description ? { empty: view.description } : {}),
        ...(view.entry ? { webView: { entry: view.entry } } : {}),
      }
    }
    const workflow = view.host?.startsWith('workflow.') ? manifest.contributions.workflows[0] : undefined
    const result = await this.invoke({
      extensionId,
      contributionId: view.id,
      contributionKind: 'view',
      context,
      caller: 'user',
      input: workflow ? { pluginId: workflow.pluginId } : {},
    })
    if (!result.ok) throw new Error(result.error?.message ?? 'The view could not be loaded')
    const rows = toRows(result.value, view)
    return {
      extensionId,
      viewId: view.id,
      title: view.title,
      kind: view.kind,
      context,
      rows,
      actions: actionViews(),
      ...(view.refreshIntervalMs ? { refreshIntervalMs: view.refreshIntervalMs } : {}),
      ...(view.description ? { empty: view.description } : {}),
    }
  }

  // --- Agent run credentials -------------------------------------------------

  /**
   * Opaque run credentials bind a context, engine, and permitted capability set
   * to one supervised run. They expire at completion and stale or cross-context
   * calls fail closed.
   */
  mintRunCredential(input: {
    sessionId: string
    engineId: string
    context: NdContext
    allowed?: NdHostMethod[]
    ttlMs?: number
  }): { token: string; expiresAt: number; context: NdContext } {
    const token = `ndrun_${randomUUID().replaceAll('-', '')}`
    const expiresAt = Date.now() + (input.ttlMs ?? RUN_CREDENTIAL_TTL_MS)
    this.runs.set(token, {
      token,
      sessionId: input.sessionId,
      engineId: input.engineId,
      context: asNdContext(input.context),
      allowed: input.allowed ?? [],
      expiresAt,
    })
    return { token, expiresAt, context: asNdContext(input.context) }
  }

  redeemRunCredential(token: string): RunCredential | undefined {
    const record = this.runs.get(token)
    if (!record) return undefined
    if (record.expiresAt <= Date.now()) {
      this.runs.delete(token)
      return undefined
    }
    return record
  }

  revokeRunCredential(token: string): void {
    this.runs.delete(token)
  }

  revokeSessionCredentials(sessionId: string): void {
    for (const [token, record] of this.runs) {
      if (record.sessionId === sessionId) this.runs.delete(token)
    }
  }

  /** An agent call arriving through a run credential; the credential owns the context. */
  async invokeAsAgent(params: {
    token: string
    extensionId: string
    contributionId: string
    input: Record<string, unknown>
  }): Promise<NdInvocationResult> {
    const credential = this.redeemRunCredential(params.token)
    if (!credential) return failure('denied', 'This run credential is stale or unknown')
    const manifest = await this.deps.packages.activeManifest(params.extensionId)
    if (!manifest) return failure('unavailable', `Extension package is not installed: ${params.extensionId}`)
    // Executable `tool` contributions belong to the package MCP runtime.
    // They cannot be routed through NativeHostRegistry: resolveContribution()
    // uses a placeholder host for catalog typing, not an execution mapping.
    // Keep this bridge limited to deterministic native-host command/view
    // contributions until the dedicated MCP agent bridge is wired.
    if (manifest.contributions.tools.some((item) => item.id === params.contributionId)) {
      return failure('unavailable', 'Executable extension tools are not available through the ND native-host bridge yet')
    }
    const contribution = resolveContribution(manifest, 'command', params.contributionId)
      ?? resolveContribution(manifest, 'view', params.contributionId)
    if (!contribution) return failure('invalid', `Unknown contribution ${params.contributionId}`)
    if (credential.allowed.length > 0 && !credential.allowed.includes(contribution.host)) {
      return failure('denied', `${contribution.host} is outside this run's permitted capabilities`)
    }
    return this.invoke({
      extensionId: params.extensionId,
      contributionId: contribution.id,
      contributionKind: contribution.kind,
      context: credential.context,
      caller: 'agent',
      runId: credential.sessionId,
      input: params.input,
    }, { credentialBacked: true })
  }

  pendingApprovals(): NdPendingApprovalView[] {
    return [...this.pending.values()].map((entry) => entry.view)
  }

  private createApproval(params: {
    manifest: NdExtensionManifest
    contribution: ResolvedContribution
    context: NdContext
    input: Record<string, unknown>
    caller: NdCallerKind
  }): PendingApproval {
    const view: NdPendingApprovalView = {
      approvalId: randomUUID(),
      extensionId: params.manifest.id,
      contributionId: params.contribution.id,
      host: params.contribution.host,
      context: params.context,
      title: `${params.manifest.name}: ${ndHostMethod(params.contribution.host)!.title}`,
      requestedAt: Date.now(),
    }
    const pending: PendingApproval = {
      view,
      request: {
        extensionId: params.manifest.id,
        contributionId: params.contribution.id,
        contributionKind: params.contribution.kind,
        context: params.context,
        caller: params.caller,
        input: params.input,
      },
      input: params.input,
    }
    this.pending.set(view.approvalId, pending)
    this.onApprovalRequested?.(view)
    return pending
  }

  private async execute(params: {
    manifest: NdExtensionManifest
    contribution: ResolvedContribution
    context: NdContext
    input: Record<string, unknown>
    settings: Record<string, unknown>
    caller: NdCallerKind
    runId?: string
    audit: (decision: NdAuditDecision, reason: string, extra?: { outcome?: 'ok' | 'failed'; host?: NdHostMethod; contextKey?: string }) => Promise<void>
  }): Promise<NdInvocationResult> {
    const callContext: NdHostCallContext = {
      extensionId: params.manifest.id,
      contributionId: params.contribution.id,
      host: params.contribution.host,
      context: params.context,
      caller: params.caller,
      settings: params.settings,
      ...(params.runId ? { runId: params.runId } : {}),
    }
    try {
      const value = await this.deps.host.call(params.contribution.host, params.input, callContext)
      await params.audit('allowed', 'executed', { outcome: 'ok', host: params.contribution.host, contextKey: contextKey(params.context) })
      return { ok: true, value }
    } catch (error) {
      await params.audit('allowed', message(error), { outcome: 'failed', host: params.contribution.host, contextKey: contextKey(params.context) })
      return failure('failed', message(error))
    }
  }

  private async activeManifests(): Promise<NdExtensionManifest[]> {
    const packages = await this.deps.packages.list()
    const manifests: NdExtensionManifest[] = []
    for (const item of packages) {
      const manifest = await this.deps.packages.activeManifest(item.id)
      if (manifest) manifests.push(manifest)
    }
    return manifests
  }
}

function resolveContribution(
  manifest: NdExtensionManifest,
  kind: NdContributionKind | undefined,
  contributionId: string,
  actionId?: string,
): ResolvedContribution | undefined {
  const contributionKind = kind ?? 'command'
  if (contributionKind === 'command') {
    const command = manifest.contributions.commands.find((item) => item.id === contributionId)
    return command ? { kind: 'command', id: command.id, host: command.host, startsAgent: command.startsAgent === true, contexts: command.contexts } : undefined
  }
  if (contributionKind === 'view') {
    // A call names the view ("board") and optionally one of its actions —
    // either split ("board" + input.action) or combined ("board:record", the
    // form stored in pending approvals and re-resolved by approve()).
    const separator = contributionId.indexOf(':')
    const viewId = separator === -1 ? contributionId : contributionId.slice(0, separator)
    const combinedAction = separator === -1 ? undefined : contributionId.slice(separator + 1)
    const view = manifest.contributions.views.find((item) => item.id === viewId)
    if (!view) return undefined
    const effectiveActionId = actionId ?? combinedAction
    const action = effectiveActionId ? view.actions.find((item) => item.id === effectiveActionId) : undefined
    if (combinedAction !== undefined && !action) return undefined
    if (action) {
      return { kind: 'view', id: `${view.id}:${action.id}`, host: action.host, startsAgent: false, contexts: view.contexts }
    }
    // A web view has no data host of its own; only named actions execute.
    if (!view.host) return undefined
    return { kind: 'view', id: view.id, host: view.host, startsAgent: false, contexts: view.contexts }
  }
  if (contributionKind === 'workflow') {
    const workflow = manifest.contributions.workflows.find((item) => item.id === contributionId)
    return workflow
      ? { kind: 'workflow', id: workflow.id, host: 'workflow.list', startsAgent: false, contexts: workflow.contexts, pluginId: workflow.pluginId }
      : undefined
  }
  if (contributionKind === 'tool') {
    const tool = manifest.contributions.tools.find((item) => item.id === contributionId)
    return tool ? { kind: 'tool', id: tool.id, host: 'note.create', startsAgent: false, contexts: tool.contexts } : undefined
  }
  const skill = manifest.contributions.skills.find((item) => item.id === contributionId)
  return skill ? { kind: 'skill', id: skill.id, host: 'note.search', startsAgent: false, contexts: skill.contexts } : undefined
}

function commandView(extensionId: string, command: NdCommandContribution): NdCommandView {
  const descriptor = ndHostMethod(command.host)!
  return {
    extensionId,
    contributionId: command.id,
    title: command.title,
    keywords: command.keywords ?? [],
    contexts: command.contexts,
    startsAgent: command.startsAgent === true,
    host: command.host,
    ...(command.openViewId ? { openViewId: command.openViewId } : {}),
    permission: descriptor.permission,
    ...(command.description ? { description: command.description } : {}),
  }
}

function workflowOpenCommand(extensionId: string, workflow: NdWorkflowContribution): NdCommandView {
  return {
    extensionId,
    contributionId: workflow.id,
    title: workflow.title,
    keywords: [workflow.pluginId],
    contexts: workflow.contexts,
    startsAgent: false,
    host: 'workflow.refresh',
    permission: 'workflow.read',
    ...(workflow.description ? { description: workflow.description } : {}),
  }
}

function toRows(value: unknown, view: NdViewContribution): NdViewRow[] {
  if (!Array.isArray(value) || !view.itemTitleKey) return []
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const title = record[view.itemTitleKey!]
    if (typeof title !== 'string' || !title.trim()) return []
    const body = view.itemBodyKey ? record[view.itemBodyKey] : undefined
    return [{
      id: typeof record.id === 'string' ? record.id : `row-${index}`,
      title: title.trim().slice(0, 512),
      ...(typeof body === 'string' && body.trim() ? { body: body.trim().slice(0, 4_000) } : {}),
      ...(typeof record.status === 'string' ? { meta: record.status.slice(0, 64) } : {}),
      ...(typeof record.thumbnail === 'string' ? { thumbnail: record.thumbnail } : {}),
      ...(typeof record.path === 'string' ? { path: record.path } : {}),
      ...(record.actionsDisabled === true ? { actionsDisabled: true } : {}),
      ...(record.sortValues && typeof record.sortValues === 'object' && !Array.isArray(record.sortValues)
        ? { sortValues: Object.fromEntries(Object.entries(record.sortValues).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))) }
        : {}),
    }]
  })
}

function failure(code: NdInvocationError['code'], text: string): NdInvocationResult {
  return { ok: false, error: { code, message: text } }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export type { RunCredential }
export type { NdGrantScope }
