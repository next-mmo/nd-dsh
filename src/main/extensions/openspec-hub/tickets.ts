import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { assertSafeId, SAFE_ID } from './security.js'
import type { Ticket, TicketInput, TicketPriority, TicketStatus } from './types.js'
import { HttpError } from './types.js'

const STATUSES: TicketStatus[] = ['open', 'in-progress', 'done']
const PRIORITIES: TicketPriority[] = ['low', 'medium', 'high']
const MAX_TITLE = 200
const MAX_DESCRIPTION = 8_000

export function validateTicketInput(input: TicketInput): Required<Omit<TicketInput, 'linkedChangeId'>> & { linkedChangeId?: string } {
  if (typeof input.title !== 'string' || input.title.trim().length === 0 || input.title.length > MAX_TITLE) {
    throw new HttpError(400, 'invalid-ticket', `title must be 1-${MAX_TITLE} characters`)
  }
  const description = input.description ?? ''
  if (typeof description !== 'string' || description.length > MAX_DESCRIPTION) {
    throw new HttpError(400, 'invalid-ticket', `description must be at most ${MAX_DESCRIPTION} characters`)
  }
  const status = input.status ?? 'open'
  if (!STATUSES.includes(status)) throw new HttpError(400, 'invalid-ticket', 'status is not recognized')
  const priority = input.priority ?? 'medium'
  if (!PRIORITIES.includes(priority)) throw new HttpError(400, 'invalid-ticket', 'priority is not recognized')
  const out: Required<Omit<TicketInput, 'linkedChangeId'>> & { linkedChangeId?: string } = {
    title: input.title.trim(),
    description,
    status,
    priority,
  }
  if (input.linkedChangeId !== undefined && input.linkedChangeId !== '') {
    assertSafeId(input.linkedChangeId, 'linked change id')
    out.linkedChangeId = input.linkedChangeId
  }
  return out
}

export type TicketPatch = Omit<Partial<TicketInput>, 'linkedChangeId'> & { linkedChangeId?: string | null }

/**
 * Per-project tickets live in the Hub's own data directory, never in the
 * registered product repositories. Writes are atomic (tmp + rename).
 */
export class TicketStore {
  constructor(private readonly dataDir: string) {}

  private file(projectId: string): string {
    assertSafeId(projectId, 'project id')
    return path.join(this.dataDir, 'tickets', `${projectId}.json`)
  }

  list(projectId: string): Ticket[] {
    const file = this.file(projectId)
    if (!existsSync(file)) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      throw new HttpError(500, 'ticket-store-corrupt', 'ticket store could not be read')
    }
    if (!Array.isArray(parsed)) {
      throw new HttpError(500, 'ticket-store-corrupt', 'ticket store is not an array')
    }
    return parsed.filter((t): t is Ticket => isTicket(t))
  }

  get(projectId: string, ticketId: string): Ticket | undefined {
    assertSafeId(ticketId, 'ticket id')
    return this.list(projectId).find((t) => t.id === ticketId)
  }

  create(projectId: string, input: TicketInput): Ticket {
    const validated = validateTicketInput(input)
    const now = new Date().toISOString()
    const ticket: Ticket = {
      id: `t-${randomBytes(4).toString('hex')}`,
      projectId,
      ...validated,
      createdAt: now,
      updatedAt: now,
    }
    const tickets = this.list(projectId)
    tickets.push(ticket)
    this.save(projectId, tickets)
    return ticket
  }

  update(projectId: string, ticketId: string, patch: TicketPatch): Ticket {
    const tickets = this.list(projectId)
    const index = tickets.findIndex((t) => t.id === ticketId)
    const existing = index >= 0 ? tickets[index] : undefined
    if (!existing) throw new HttpError(404, 'unknown-ticket', 'ticket not found')
    const merged: TicketInput = {
      title: patch.title ?? existing.title,
      description: patch.description ?? existing.description,
      status: patch.status ?? existing.status,
      priority: patch.priority ?? existing.priority,
    }
    const linked = patch.linkedChangeId === null ? undefined : (patch.linkedChangeId ?? existing.linkedChangeId)
    if (linked !== undefined) merged.linkedChangeId = linked
    const validated = validateTicketInput(merged)
    const updated: Ticket = {
      ...existing,
      ...validated,
      updatedAt: new Date().toISOString(),
    }
    if (validated.linkedChangeId !== undefined) updated.linkedChangeId = validated.linkedChangeId
    else delete updated.linkedChangeId
    tickets[index] = updated
    this.save(projectId, tickets)
    return updated
  }

  delete(projectId: string, ticketId: string): void {
    assertSafeId(ticketId, 'ticket id')
    const tickets = this.list(projectId)
    const next = tickets.filter((t) => t.id !== ticketId)
    if (next.length === tickets.length) throw new HttpError(404, 'unknown-ticket', 'ticket not found')
    this.save(projectId, next)
  }

  private save(projectId: string, tickets: Ticket[]): void {
    const file = this.file(projectId)
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify(tickets, null, 2)}\n`, 'utf8')
      renameSync(tmp, file)
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
    }
  }
}

function isTicket(value: unknown): value is Ticket {
  if (typeof value !== 'object' || value === null) return false
  const t = value as Record<string, unknown>
  return (
    typeof t.id === 'string' &&
    SAFE_ID.test(t.id) &&
    typeof t.projectId === 'string' &&
    typeof t.title === 'string' &&
    typeof t.description === 'string' &&
    STATUSES.includes(t.status as TicketStatus) &&
    PRIORITIES.includes(t.priority as TicketPriority) &&
    typeof t.createdAt === 'string' &&
    typeof t.updatedAt === 'string'
  )
}