import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { BrowserPlatformService } from '../../browser-platform/browser-platform-service.js'
import { BUILTIN_BROWSER_TARGET_ID } from '../../browser/browser-controller.js'
import type { CoreClient } from '../../core/core-client.js'
import type { DesignAgentTool } from '../../design/design-agent-tool.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import { sessionInWorkspace } from '../../workspace/path-utils.js'
import type { NativeToolRequest, NdNativeEngine } from './nd-native-engine.js'

export type NativeExtensionInvoker = (request: {
  sessionId: string
  cwd: string
  worktree: boolean
  extensionId: string
  contributionId: string
  input: Record<string, unknown>
}) => Promise<unknown>

export interface NativeToolBrokerOptions {
  core: Pick<CoreClient, 'request'>
  browser: Pick<BrowserPlatformService, 'callAgent' | 'issueSessionAccess'>
  workspace: Pick<WorkspaceService, 'state'>
  ownsWorktree(cwd: string): boolean
  engine(): Pick<NdNativeEngine, 'listSessions'>
}

/** The Rust worker proposes actions; this trusted host resolves its session and
 * workspace binding before crossing any ND service boundary. */
export class NdNativeToolBroker {
  private extensionInvoker: NativeExtensionInvoker | undefined
  private designAgent: DesignAgentTool | undefined

  constructor(private readonly options: NativeToolBrokerOptions) {}

  setExtensionInvoker(invoker: NativeExtensionInvoker | undefined): void {
    this.extensionInvoker = invoker
  }

  setDesignAgentTool(tool: DesignAgentTool | undefined): void {
    this.designAgent = tool
  }

  /** An intent without a terminal receipt may already have reached the host.
   * Mark it uncertain at startup and never dispatch it again. */
  async reconcile(): Promise<number> {
    const latest = new Map<string, { state: string; sessionId: string | undefined; name: string | undefined }>()
    let afterSeq = 0
    for (;;) {
      const page = await this.options.core.request<{
        records: Array<{ seq: number; kind: string; state: string; resourceId?: string; idempotencyKey?: string; data?: { name?: string } }>
        truncated: boolean
      }>('effectJournal.replay', { afterSeq, limit: 1000 }, 15_000)
      for (const record of page.records) {
        afterSeq = record.seq
        if (record.kind === 'nd-agent.tool' && record.idempotencyKey) {
          latest.set(record.idempotencyKey, { state: record.state, sessionId: record.resourceId, name: record.data?.name })
        }
      }
      if (!page.truncated || page.records.length === 0) break
    }
    let reconciled = 0
    for (const [idempotencyKey, record] of latest) {
      if (record.state !== 'intent') continue
      await this.options.core.request('effectJournal.append', {
        kind: 'nd-agent.tool', state: 'uncertain', idempotencyKey,
        ...(record.sessionId ? { resourceId: record.sessionId } : {}),
        data: { ...(record.name ? { name: record.name } : {}), recovery: 'interrupted-before-receipt' },
      }, 5_000)
      reconciled += 1
    }
    return reconciled
  }

  async call(request: NativeToolRequest): Promise<unknown> {
    const session = this.options.engine().listSessions().find((item) => item.sessionId === request.sessionId)
    if (!session?.cwd || resolve(session.cwd) !== resolve(request.cwd)) {
      throw new Error('ND Agent tool request has no matching workspace-bound session')
    }
    const project = this.options.workspace.state().root
    if (!sessionInWorkspace(project, session.cwd) && !this.options.ownsWorktree(session.cwd)) {
      throw new Error('ND Agent session is outside the active project')
    }
    const args = request.arguments
    const receipt = randomUUID()
    await this.options.core.request('effectJournal.append', {
      kind: 'nd-agent.tool', state: 'intent', resourceId: request.sessionId,
      idempotencyKey: `nd-agent:${request.sessionId}:${receipt}`,
      data: { name: request.name, workspace: session.cwd },
    }, 5_000)
    let effectDispatched = false
    try {
      let result: unknown
      switch (request.name) {
        case 'nd_workspace_read':
          result = await this.options.core.request('workspace.read', {
            root: session.cwd, path: stringArg(args, 'path'), maxBytes: 1024 * 1024,
          }, 15_000)
          break
        case 'nd_workspace_list':
          result = await this.options.core.request('workspace.list', {
            root: session.cwd, path: stringArg(args, 'path'), maxEntries: 500,
          }, 15_000)
          break
        case 'nd_browser_call': {
          const method = stringArg(args, 'method')
          if (!method.startsWith('browser.')) throw new Error('ND Agent browser method is invalid')
          const params = recordArg(args, 'params')
          effectDispatched = true
          result = await this.options.browser.callAgent(method, {
            ...params,
            targetId: BUILTIN_BROWSER_TARGET_ID,
            accessToken: this.options.browser.issueSessionAccess(request.sessionId),
          })
          break
        }
        case 'nd_workspace_write': {
          const path = relativeWorkspacePath(session.cwd, args, 'path')
          if (path.toLowerCase().endsWith('.op')) {
            throw new Error('ND Agent must edit ND Pencil documents through nd_design; writing .op files with workspace tools is blocked')
          }
          const data = stringArg(args, 'data')
          effectDispatched = true
          result = await this.options.core.request('workspace.write', {
            root: session.cwd,
            path,
            data,
          }, 15_000)
          break
        }
        case 'nd_design': {
          if (!this.designAgent) throw new Error('ND Pencil design bridge is unavailable')
          const action = stringArg(args, 'action')
          effectDispatched = action !== 'state'
          result = await this.designAgent.call({
            sessionCwd: session.cwd,
            action,
            args,
          })
          break
        }
        case 'nd_git':
          result = await this.git(session.cwd, args, () => { effectDispatched = true })
          break
        case 'nd_extension_call':
          if (!this.extensionInvoker) throw new Error('ND extension policy bridge is unavailable')
          const extensionId = stringArg(args, 'extensionId')
          const contributionId = stringArg(args, 'contributionId')
          const input = args.input === undefined ? {} : recordArg(args, 'input')
          effectDispatched = true
          result = await this.extensionInvoker({
            sessionId: request.sessionId,
            cwd: session.cwd,
            worktree: this.options.ownsWorktree(session.cwd),
            extensionId,
            contributionId,
            input,
          })
          break
        case 'nd_shell':
          throw new Error('nd_shell is unavailable: a working directory is not an OS sandbox')
        default:
          throw new Error('Unknown ND Agent tool')
      }
      await this.finish(request, receipt, 'complete')
      return result
    } catch (error) {
      // Once a state-changing host request has been dispatched, a transport
      // failure cannot prove whether the effect committed. Record uncertainty
      // instead of "failed" so recovery never treats the action as replayable.
      await this.finish(request, receipt, effectDispatched ? 'uncertain' : 'failed').catch(() => undefined)
      throw error
    }
  }

  private async git(cwd: string, args: Record<string, unknown>, markEffectDispatched: () => void): Promise<unknown> {
    const operation = stringArg(args, 'operation')
    switch (operation) {
      case 'status':
        return this.options.core.request('git.status', { cwd }, 15_000)
      case 'log':
        return this.options.core.request('git.log', {
          cwd,
          limit: integerArg(args, 'limit', 20, 1, 100),
        }, 15_000)
      case 'diff': {
        const path = relativeWorkspacePath(cwd, args, 'path')
        return this.options.core.request('git.exec', {
          cwd,
          args: ['diff', '--', path],
          maxOutputBytes: 2 * 1024 * 1024,
        }, 30_000)
      }
      case 'add': {
        const paths = stringArrayArg(args, 'paths', 64)
          .map((path) => validateWorkspaceRelative(cwd, path))
        if (paths.length === 0) throw new Error('ND Agent Git add requires at least one path')
        markEffectDispatched()
        return this.options.core.request('git.exec', {
          cwd,
          args: ['add', '--', ...paths],
          maxOutputBytes: 1024 * 1024,
        }, 30_000)
      }
      default:
        throw new Error('ND Agent Git operation is not allowed')
    }
  }

  private async finish(request: NativeToolRequest, receipt: string, state: 'complete' | 'failed' | 'uncertain'): Promise<void> {
    await this.options.core.request('effectJournal.append', {
      kind: 'nd-agent.tool', state, resourceId: request.sessionId,
      idempotencyKey: `nd-agent:${request.sessionId}:${receipt}`,
      data: { name: request.name },
    }, 5_000)
  }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`ND Agent ${key} must be a string`)
  return value
}

function recordArg(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`ND Agent ${key} must be an object`)
  return value as Record<string, unknown>
}

function relativeWorkspacePath(root: string, args: Record<string, unknown>, key: string): string {
  return validateWorkspaceRelative(root, stringArg(args, key))
}

function validateWorkspaceRelative(root: string, value: string): string {
  if (value.includes('\0')) throw new Error('ND Agent workspace path contains an invalid byte')
  const target = resolve(root, value)
  if (!sessionInWorkspace(root, target) || target === resolve(root)) {
    throw new Error('ND Agent workspace path escapes the session root')
  }
  return value
}

function stringArrayArg(args: Record<string, unknown>, key: string, max: number): string[] {
  const value = args[key]
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`ND Agent ${key} must be a non-empty string array with at most ${max} entries`)
  }
  return value as string[]
}

function integerArg(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key]
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`ND Agent ${key} must be an integer between ${min} and ${max}`)
  }
  return value as number
}
