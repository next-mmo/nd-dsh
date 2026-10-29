import { resolve } from 'node:path'
import type { DesignCommand } from '../../shared/nd-design/index.js'
import type { DesignSessionService } from './design-session-service.js'

export interface DesignAgentRequest {
  sessionCwd: string
  action: string
  args: Record<string, unknown>
}

/**
 * The only mutation path from ND Agent into a live ND Pencil document. The
 * broker resolves the session and cwd; this class re-checks the project binding
 * so a worktree or another project can never edit the active canvas.
 */
export class DesignAgentTool {
  constructor(private readonly service: DesignSessionService) {}

  async call(request: DesignAgentRequest): Promise<unknown> {
    const projectRoot = this.service.projectRoot
    if (resolve(request.sessionCwd) !== resolve(projectRoot)) {
      throw new Error('ND Pencil can only be edited from an ND Agent session bound to the active project root')
    }
    const action = request.action
    switch (action) {
      case 'state':
        return this.service.agentState()
      case 'open': {
        const sync = await this.service.agentOpen(stringArg(request.args, 'path'))
        return summarize(sync)
      }
      case 'create': {
        const sync = await this.service.agentCreate(
          stringArg(request.args, 'path'),
          optionalString(request.args, 'name'),
        )
        return summarize(sync)
      }
      case 'apply': {
        const commands = commandArray(request.args)
        const result = this.service.agentApply(commands)
        return { ok: true, ...result }
      }
      case 'undo':
        return summarize(await this.service.agentUndo())
      case 'redo':
        return summarize(await this.service.agentRedo())
      case 'save':
        return { ok: true, state: await this.service.agentSave() }
      case 'export': {
        const format = request.args.format
        if (format !== 'spec' && format !== 'svg') throw new Error('ND Pencil export format must be spec or svg')
        const artifacts = await this.service.agentExport(format)
        return { ok: true, format, ...artifacts }
      }
      default:
        throw new Error('ND Pencil action must be state, open, create, apply, undo, redo, save, or export')
    }
  }
}

function summarize(sync: Awaited<ReturnType<DesignSessionService['agentOpen']>>): unknown {
  return {
    ok: true,
    state: sync.state,
    document: sync.document
      ? {
          id: sync.document.id,
          name: sync.document.name,
          revision: sync.state.revision,
          nodeCount: Object.keys(sync.document.nodes).length,
          pageChildren: sync.document.pages[0]?.children ?? [],
          migration: sync.document.meta?.migration,
        }
      : null,
  }
}

function commandArray(args: Record<string, unknown>): DesignCommand[] {
  const value = args.commands
  if (!Array.isArray(value) || value.length === 0) throw new Error('ND Pencil apply requires a non-empty commands array')
  if (value.length > 100) throw new Error('ND Pencil apply accepts at most 100 commands')
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('ND Pencil command must be an object')
    const op = (item as { op?: unknown }).op
    if (typeof op !== 'string' || !['insert', 'update', 'delete', 'reorder', 'group', 'ungroup'].includes(op)) {
      throw new Error('ND Pencil command op is invalid')
    }
  }
  return value as DesignCommand[]
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`ND Pencil ${key} must be a non-empty string`)
  return value.trim()
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 200) throw new Error(`ND Pencil ${key} must be a short string`)
  return value.trim() || undefined
}
