import { EventEmitter } from 'node:events'
import { findProject } from './config.js'
import type { OpenSpecCli } from './openspec-cli.js'
import { buildChangeDetail, scanProject } from './scanner.js'
import { assertSafeId } from './security.js'
import type {
  ChangeDetail,
  HubConfig,
  PortfolioCard,
  ProjectSnapshot,
} from './types.js'
import { HttpError } from './types.js'

export interface SnapshotEvent {
  projectId: string
  updatedAt: string
  available: boolean
}

export class SnapshotCache {
  readonly events = new EventEmitter()
  private snapshots = new Map<string, ProjectSnapshot>()
  private inflight = new Map<string, Promise<ProjectSnapshot>>()
  private details = new Map<string, ChangeDetail>()

  constructor(
    private config: HubConfig,
    private cli: OpenSpecCli,
  ) {
    this.events.setMaxListeners(200)
  }

  async get(projectId: string): Promise<ProjectSnapshot> {
    const project = findProject(this.config, projectId)
    const cached = this.snapshots.get(projectId)
    if (cached) return cached
    return this.scan(project.id)
  }

  async refresh(projectId: string): Promise<ProjectSnapshot> {
    const project = findProject(this.config, projectId)
    this.details.clear()
    return this.scan(project.id)
  }

  async refreshAll(): Promise<ProjectSnapshot[]> {
    return Promise.all(this.config.projects.map((p) => this.refresh(p.id)))
  }

  private scan(projectId: string): Promise<ProjectSnapshot> {
    const existing = this.inflight.get(projectId)
    if (existing) return existing
    const project = findProject(this.config, projectId)
    const promise = scanProject(project, this.cli)
      .then((snapshot) => {
        this.snapshots.set(projectId, snapshot)
        this.details.clear()
        const event: SnapshotEvent = {
          projectId,
          updatedAt: snapshot.updatedAt,
          available: snapshot.available,
        }
        this.events.emit('updated', event)
        return snapshot
      })
      .finally(() => {
        this.inflight.delete(projectId)
      })
    this.inflight.set(projectId, promise)
    return promise
  }

  async changeDetail(projectId: string, changeId: string): Promise<ChangeDetail> {
    assertSafeId(changeId, 'change id')
    const snapshot = await this.get(projectId)
    if (!snapshot.available) {
      throw new HttpError(503, 'project-unavailable', snapshot.error ?? 'project is unavailable')
    }
    const summary = snapshot.changes.find((c) => c.id === changeId)
    if (!summary) throw new HttpError(404, 'unknown-change', 'change not found in this project')
    const key = `${projectId}/${changeId}`
    const cached = this.details.get(key)
    if (cached) return cached
    const project = findProject(this.config, projectId)
    const detail = await buildChangeDetail(project, summary)
    this.details.set(key, detail)
    return detail
  }

  async portfolio(): Promise<PortfolioCard[]> {
    const snapshots = await Promise.all(this.config.projects.map((p) => this.get(p.id)))
    return snapshots.map((s) => {
      const stageCounts: PortfolioCard['stageCounts'] = {
        draft: 0,
        'ready-for-review': 0,
        'in-implementation': 0,
        'ready-to-archive': 0,
        archived: 0,
      }
      for (const change of s.changes) stageCounts[change.stage] += 1
      return {
        id: s.id,
        name: s.name,
        available: s.available,
        ...(s.error !== undefined ? { error: s.error } : {}),
        updatedAt: s.updatedAt,
        schema: s.schema,
        totals: s.totals,
        validationStatus: s.validation.status,
        doctorHealthy: s.doctor.healthy,
        stageCounts,
      }
    })
  }

  // ND mode has no file watchers: the web view polls the portfolio and the
  // user can force a re-scan via openspec.refresh.
}