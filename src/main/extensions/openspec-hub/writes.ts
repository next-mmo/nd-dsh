import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { SnapshotCache } from './cache.js'
import { findProject } from './config.js'
import { docRelPath } from './scanner.js'
import { assertSafeId, readProjectFile, safeJoin, tryReadProjectFile } from './security.js'
import type { TicketStore } from './tickets.js'
import type { ActionPayload, ActionPreview, DiffLine, HubConfig } from './types.js'
import { HttpError } from './types.js'

const MAX_WRITE_BYTES = 2 * 1024 * 1024
const CHECKBOX = /^(\s*-\s+\[)( |x|X)(\]\s+)(.*?)\r?$/

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** Minimal line diff: common prefix/suffix trimmed, bounded output. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const out: DiffLine[] = []
  for (let i = Math.max(0, start - 3); i < start; i += 1) out.push({ type: 'ctx', text: a[i] ?? '' })
  const removed = a.slice(start, endA)
  const added = b.slice(start, endB)
  for (const line of removed.slice(0, 100)) out.push({ type: 'del', text: line })
  if (removed.length > 100) out.push({ type: 'ctx', text: `… ${removed.length - 100} more removed lines` })
  for (const line of added.slice(0, 100)) out.push({ type: 'add', text: line })
  if (added.length > 100) out.push({ type: 'ctx', text: `… ${added.length - 100} more added lines` })
  for (let i = endA; i < Math.min(a.length, endA + 3); i += 1) out.push({ type: 'ctx', text: a[i] ?? '' })
  return out
}

/** Replace the body under a markdown heading, keeping the heading itself. */
export function replaceSection(markdown: string, section: string, body: string): string {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n'
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const wanted = section.trim()
  let index = -1
  let level = 0
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i] ?? '')
    if (heading?.[2] === wanted) {
      index = i
      level = (heading[1] ?? '#').length
      break
    }
  }
  if (index < 0) {
    throw new HttpError(404, 'section-not-found', `section "${wanted}" was not found in the document`)
  }
  let end = lines.length
  for (let i = index + 1; i < lines.length; i += 1) {
    const heading = /^(#{1,6})\s+/.exec(lines[i] ?? '')
    if (heading && (heading[1] ?? '#').length <= level) {
      end = i
      break
    }
  }
  const normalizedBody = body.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  const next = [...lines.slice(0, index + 1), '', ...normalizedBody.split('\n'), '', ...lines.slice(end)]
  return next.join(eol)
}

interface CheckboxMatch {
  index: number
  line: string
  done: boolean
}

function findCheckbox(lines: string[], text: string): CheckboxMatch {
  const wanted = text.trim()
  const matches: CheckboxMatch[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const m = CHECKBOX.exec(line)
    if (m?.[4] !== undefined && m[4].trim() === wanted) {
      matches.push({ index: i, line, done: m[2] !== ' ' })
    }
  }
  if (matches.length === 0) {
    throw new HttpError(404, 'item-not-found', 'no checklist/task item matches that text exactly')
  }
  if (matches.length > 1) {
    throw new HttpError(409, 'ambiguous-item', 'multiple items match that text; make the request more specific')
  }
  return matches[0] as CheckboxMatch
}

export function flipCheckbox(line: string, done: boolean): string {
  const m = CHECKBOX.exec(line)
  if (!m) throw new HttpError(409, 'stale-document', 'the item line changed shape')
  const cr = line.endsWith('\r') ? '\r' : ''
  return `${m[1]}${done ? 'x' : ' '}${m[3]}${m[4]}${cr}`
}

function changeTasksRelPath(summary: { id: string; archived: boolean }): string {
  return summary.archived
    ? `openspec/changes/archive/${summary.id}/tasks.md`
    : `openspec/changes/${summary.id}/tasks.md`
}

export interface WriteDeps {
  config: HubConfig
  cache: SnapshotCache
  tickets: TicketStore
  dataDir: string
}

/**
 * All repository mutations go through the same safeJoin scope as reads.
 * Previews are computed at proposal time; execution re-verifies the document
 * has not changed since (optimistic concurrency) and appends an audit entry.
 */
export class WriteService {
  constructor(private readonly deps: WriteDeps) {}

  async preview(payload: ActionPayload): Promise<ActionPreview> {
    switch (payload.kind) {
      case 'edit-doc':
        return this.previewDocEdit(payload)
      case 'toggle-checklist':
        return this.previewToggle(payload.projectId, docRelPath(payload.docId), payload.itemText, payload.done)
      case 'toggle-task': {
        const rel = await this.taskRelPath(payload.projectId, payload.changeId)
        return this.previewToggle(payload.projectId, rel, payload.taskText, payload.done)
      }
      case 'create-ticket':
        return {
          target: `new ticket in ${payload.projectId}`,
          summary: `Create ticket "${clip(payload.title, 80)}"`,
          before: '',
          after: JSON.stringify({ title: payload.title, description: payload.description ?? '', priority: payload.priority ?? 'medium', linkedChangeId: payload.linkedChangeId }, null, 2),
          diff: lineDiff('', JSON.stringify({ title: payload.title, priority: payload.priority ?? 'medium' }, null, 2)),
        }
      case 'update-ticket': {
        const ticket = this.deps.tickets.get(payload.projectId, payload.ticketId)
        if (!ticket) throw new HttpError(404, 'unknown-ticket', 'ticket not found')
        const after = { ...ticket, ...payload, kind: undefined }
        delete (after as { kind?: unknown }).kind
        return {
          target: `ticket ${ticket.id}`,
          summary: `Update ticket "${clip(ticket.title, 80)}"`,
          before: JSON.stringify(ticket, null, 2),
          after: JSON.stringify(after, null, 2),
          diff: lineDiff(JSON.stringify(ticket, null, 2), JSON.stringify(after, null, 2)),
        }
      }
    }
  }

  async execute(payload: ActionPayload, preview: ActionPreview): Promise<string> {
    let result: string
    switch (payload.kind) {
      case 'edit-doc':
        result = await this.executeDocEdit(payload, preview)
        break
      case 'toggle-checklist':
        result = await this.executeToggle(payload.projectId, docRelPath(payload.docId), payload.itemText, payload.done, preview)
        break
      case 'toggle-task': {
        const rel = await this.taskRelPath(payload.projectId, payload.changeId)
        result = await this.executeToggle(payload.projectId, rel, payload.taskText, payload.done, preview)
        break
      }
      case 'create-ticket': {
        const ticket = this.deps.tickets.create(payload.projectId, {
          title: payload.title,
          ...(payload.description !== undefined ? { description: payload.description } : {}),
          ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
          ...(payload.linkedChangeId !== undefined ? { linkedChangeId: payload.linkedChangeId } : {}),
        })
        result = `Created ticket ${ticket.id}: ${ticket.title}`
        break
      }
      case 'update-ticket': {
        const ticket = this.deps.tickets.update(payload.projectId, payload.ticketId, payload)
        result = `Updated ticket ${ticket.id} (${ticket.status})`
        break
      }
    }
    this.audit(payload, preview, result)
    return result
  }

  private async previewDocEdit(payload: Extract<ActionPayload, { kind: 'edit-doc' }>): Promise<ActionPreview> {
    const project = findProject(this.deps.config, payload.projectId)
    const rel = docRelPath(payload.docId)
    const current = tryReadProjectFile(project.path, rel)
    if (current === null && payload.mode !== 'append') {
      throw new HttpError(404, 'not-found', 'document does not exist; only append can create it')
    }
    const before = current ?? ''
    const after = applyDocEdit(before, payload)
    if (Buffer.byteLength(after, 'utf8') > MAX_WRITE_BYTES) {
      throw new HttpError(413, 'too-large', 'resulting document exceeds the write size limit')
    }
    const target = payload.mode === 'replace-section' ? `${rel} § ${payload.section}` : rel
    return {
      target,
      summary:
        payload.mode === 'append'
          ? `Append ${payload.content.length} chars to ${rel}`
          : payload.mode === 'replace'
            ? `Replace ${rel} (${before.length} → ${after.length} chars)`
            : `Replace section "${payload.section}" in ${rel}`,
      before,
      after,
      diff: lineDiff(before, after),
    }
  }

  private async previewToggle(projectId: string, rel: string, text: string, done: boolean): Promise<ActionPreview> {
    const project = findProject(this.deps.config, projectId)
    const current = readProjectFile(project.path, rel)
    const lines = current.split('\n')
    const match = findCheckbox(lines, text)
    const nextLines = [...lines]
    nextLines[match.index] = flipCheckbox(match.line, done)
    const after = nextLines.join('\n')
    const windowBefore = lines.slice(Math.max(0, match.index - 2), match.index + 3).join('\n')
    const windowAfter = nextLines.slice(Math.max(0, match.index - 2), match.index + 3).join('\n')
    return {
      target: `${rel}: ${clip(text, 80)}`,
      summary: `${done ? 'Check' : 'Uncheck'} "${clip(text, 80)}" in ${rel}`,
      before: current,
      after,
      diff: lineDiff(windowBefore, windowAfter),
    }
  }

  private async executeDocEdit(payload: Extract<ActionPayload, { kind: 'edit-doc' }>, preview: ActionPreview): Promise<string> {
    const project = findProject(this.deps.config, payload.projectId)
    const rel = docRelPath(payload.docId)
    const current = tryReadProjectFile(project.path, rel) ?? ''
    if (current !== preview.before) {
      throw new HttpError(409, 'stale-document', 'the document changed since this edit was proposed; ask again')
    }
    const after = applyDocEdit(current, payload)
    if (Buffer.byteLength(after, 'utf8') > MAX_WRITE_BYTES) {
      throw new HttpError(413, 'too-large', 'resulting document exceeds the write size limit')
    }
    const abs = safeJoin(project.path, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    const postDirTarget = safeJoin(project.path, rel)
    writeFileSync(postDirTarget, after, 'utf8')
    await this.deps.cache.refresh(payload.projectId).catch(() => undefined)
    return `Wrote ${rel} (${payload.mode})`
  }

  private async executeToggle(projectId: string, rel: string, text: string, done: boolean, preview: ActionPreview): Promise<string> {
    const project = findProject(this.deps.config, projectId)
    const current = readProjectFile(project.path, rel)
    if (current !== preview.before) {
      throw new HttpError(409, 'stale-document', 'the file changed since this toggle was proposed; ask again')
    }
    const lines = current.split('\n')
    const match = findCheckbox(lines, text)
    if (match.done === done) return `"${clip(text, 80)}" is already ${done ? 'checked' : 'unchecked'}`
    lines[match.index] = flipCheckbox(match.line, done)
    writeFileSync(safeJoin(project.path, rel), lines.join('\n'), 'utf8')
    await this.deps.cache.refresh(projectId).catch(() => undefined)
    return `${done ? 'Checked' : 'Unchecked'} "${clip(text, 80)}" in ${rel}`
  }

  private async taskRelPath(projectId: string, changeId: string): Promise<string> {
    assertSafeId(changeId, 'change id')
    const snapshot = await this.deps.cache.get(projectId)
    const summary = snapshot.changes.find((c) => c.id === changeId)
    if (!summary) throw new HttpError(404, 'unknown-change', 'change not found in this project')
    return changeTasksRelPath(summary)
  }

  private audit(payload: ActionPayload, preview: ActionPreview, result: string): void {
    try {
      mkdirSync(this.deps.dataDir, { recursive: true })
      const entry = {
        ts: new Date().toISOString(),
        kind: payload.kind,
        projectId: payload.projectId,
        target: preview.target,
        result,
      }
      appendFileSync(path.join(this.deps.dataDir, 'audit.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      // Audit is best-effort; the write itself already succeeded.
    }
  }
}

function applyDocEdit(before: string, payload: Extract<ActionPayload, { kind: 'edit-doc' }>): string {
  if (payload.mode === 'replace') return payload.content
  if (payload.mode === 'replace-section') {
    if (!payload.section) throw new HttpError(400, 'invalid-action', 'replace-section requires a section heading')
    return replaceSection(before, payload.section, payload.content)
  }
  const separator = before.length === 0 || before.endsWith('\n') ? '' : '\n'
  const content = payload.content.endsWith('\n') ? payload.content : `${payload.content}\n`
  return before + separator + content
}