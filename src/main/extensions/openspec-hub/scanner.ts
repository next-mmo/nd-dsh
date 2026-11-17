import { existsSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { OpenSpecCli } from './openspec-cli.js'
import {
  listSubdirs,
  projectFileExists,
  readProjectFile,
  tryReadProjectFile,
  walkProjectDir,
} from './security.js'
import type {
  ArtifactStatus,
  ChangeDelta,
  ChangeDetail,
  ChangeStage,
  ChangeSummary,
  ChecklistItem,
  DeltaFile,
  DocMeta,
  DoctorReport,
  ProjectConfig,
  ProjectSnapshot,
  Requirement,
  SpecDetail,
  TaskItem,
  ValidationItem,
  ValidationReport,
} from './types.js'
import { HttpError } from './types.js'

export function deriveStage(input: {
  archived: boolean
  artifactsDone: number
  artifactTotal: number
  completedTasks: number
  totalTasks: number
}): ChangeStage {
  if (input.archived) return 'archived'
  if (input.artifactTotal === 0 || input.artifactsDone < input.artifactTotal) return 'draft'
  if (input.completedTasks === 0) return 'ready-for-review'
  if (input.completedTasks >= input.totalTasks) return 'ready-to-archive'
  return 'in-implementation'
}

export function parseTasks(markdown: string): TaskItem[] {
  const items: TaskItem[] = []
  let section = ''
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading?.[1]) {
      section = heading[1].trim()
      continue
    }
    const task = /^\s*-\s+\[( |x|X)\]\s+(.*)$/.exec(line)
    if (task?.[2] !== undefined) {
      items.push({ text: task[2].trim(), done: task[1] !== ' ', section })
    }
  }
  return items
}

export function parseChecklist(markdown: string): ChecklistItem[] {
  return parseTasks(markdown)
}

const DELTA_HEADER = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/
const REQUIREMENT_HEADER = /^###\s+Requirement:\s*(.+)$/
const SCENARIO_HEADER = /^####\s+Scenario:\s*(.+)$/

/** Parse a change delta spec.md into structured operations/requirements/scenarios. */
export function parseDeltaMarkdown(spec: string, markdown: string): ChangeDelta[] {
  const deltas: ChangeDelta[] = []
  let current: ChangeDelta | null = null
  let req: Requirement | null = null
  let scenario: { name: string; lines: string[] } | null = null
  let textLines: string[] = []

  const flushScenario = (): void => {
    if (req && scenario) {
      req.scenarios.push({ name: scenario.name, rawText: scenario.lines.join('\n').trim() })
    }
    scenario = null
  }
  const flushRequirement = (): void => {
    flushScenario()
    if (req) {
      req.text = textLines.join('\n').trim()
      if (current) current.requirements.push(req)
    }
    req = null
    textLines = []
  }

  for (const line of markdown.split(/\r?\n/)) {
    const delta = DELTA_HEADER.exec(line)
    if (delta?.[1]) {
      flushRequirement()
      current = { spec, operation: delta[1], requirements: [] }
      deltas.push(current)
      continue
    }
    const requirement = REQUIREMENT_HEADER.exec(line)
    if (requirement?.[1]) {
      flushRequirement()
      req = { name: requirement[1].trim(), text: '', scenarios: [] }
      continue
    }
    const scenarioHeader = SCENARIO_HEADER.exec(line)
    if (scenarioHeader?.[1]) {
      flushScenario()
      scenario = { name: scenarioHeader[1].trim(), lines: [] }
      continue
    }
    if (scenario) {
      if (line.trim().length > 0) scenario.lines.push(line)
      continue
    }
    if (req && !/^#/.test(line)) {
      textLines.push(line)
    }
  }
  flushRequirement()
  return deltas
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function mapRequirements(raw: unknown): Requirement[] {
  if (!Array.isArray(raw)) return []
  const out: Requirement[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    if (!rec || typeof rec.name !== 'string') continue
    const scenarios = Array.isArray(rec.scenarios)
      ? rec.scenarios
          .map(asRecord)
          .filter((s): s is Record<string, unknown> => s !== null && typeof s.name === 'string')
          .map((s) => ({ name: s.name as string, rawText: typeof s.rawText === 'string' ? s.rawText : '' }))
      : []
    out.push({ name: rec.name, text: typeof rec.text === 'string' ? rec.text : '', scenarios })
  }
  return out
}

function mapValidation(result: { ok: boolean; json: unknown; stderr: string }): ValidationReport {
  const json = asRecord(result.json)
  if (!json || !Array.isArray(json.items)) {
    return {
      status: 'UNAVAILABLE',
      items: [],
      totals: { items: 0, passed: 0, failed: 0 },
      error: result.stderr.slice(0, 500) || 'openspec validate did not return JSON',
    }
  }
  const items: ValidationItem[] = []
  for (const rawItem of json.items) {
    const rec = asRecord(rawItem)
    if (!rec || typeof rec.id !== 'string') continue
    const issues = Array.isArray(rec.issues)
      ? rec.issues
          .map(asRecord)
          .filter((i): i is Record<string, unknown> => i !== null)
          .map((i) => ({
            level: typeof i.level === 'string' ? i.level : 'INFO',
            path: typeof i.path === 'string' ? i.path : '',
            message: typeof i.message === 'string' ? i.message : '',
          }))
      : []
    items.push({ id: rec.id, type: typeof rec.type === 'string' ? rec.type : 'unknown', valid: rec.valid === true, issues })
  }
  const summary = asRecord(json.summary)
  const totalsRaw = asRecord(summary?.totals)
  const totals = {
    items: typeof totalsRaw?.items === 'number' ? totalsRaw.items : items.length,
    passed: typeof totalsRaw?.passed === 'number' ? totalsRaw.passed : items.filter((i) => i.valid).length,
    failed: typeof totalsRaw?.failed === 'number' ? totalsRaw.failed : items.filter((i) => !i.valid).length,
  }
  return { status: totals.failed > 0 ? 'FAIL' : 'PASS', items, totals }
}

function mapDoctor(result: { ok: boolean; json: unknown }): DoctorReport {
  const json = asRecord(result.json)
  if (!json) return { available: false, healthy: false, messages: ['openspec doctor did not return JSON'] }
  const root = asRecord(json.root)
  const messages: string[] = []
  for (const key of ['status'] as const) {
    const top = json[key]
    const rootStatus = root?.[key]
    for (const list of [top, rootStatus]) {
      if (!Array.isArray(list)) continue
      for (const entry of list) {
        const rec = asRecord(entry)
        if (rec && typeof rec.message === 'string') messages.push(rec.message)
        else if (typeof entry === 'string') messages.push(entry)
      }
    }
  }
  return { available: true, healthy: root?.healthy === true, messages: [...new Set(messages)] }
}

const DOC_SOURCES: Array<{ id: string; title: string; kind: DocMeta['kind']; relPath: string }> = [
  { id: 'prd', title: 'PRD', kind: 'prd', relPath: 'docs/PRD.md' },
  { id: 'pm-brd', title: 'PM BRD', kind: 'brd', relPath: 'docs/PM_BRD.md' },
  { id: 'brd-sync-checklist', title: 'BRD Sync Checklist', kind: 'checklist', relPath: 'docs/BRD_SYNC_CHECKLIST.md' },
  { id: 'architecture', title: 'Architecture', kind: 'architecture', relPath: 'docs/ARCHITECTURE.md' },
  { id: 'api', title: 'API', kind: 'api', relPath: 'docs/API.md' },
  { id: 'roadmap', title: 'Roadmap', kind: 'roadmap', relPath: 'docs/ROADMAP.md' },
  { id: 'readme', title: 'README', kind: 'readme', relPath: 'README.md' },
  { id: 'agents', title: 'AGENTS', kind: 'agents', relPath: 'AGENTS.md' },
]

export function collectDocs(root: string): DocMeta[] {
  const docs: DocMeta[] = []
  for (const source of DOC_SOURCES) {
    if (projectFileExists(root, source.relPath)) docs.push({ ...source })
  }
  for (const file of walkProjectDir(root, 'docs/adr')) {
    if (!file.endsWith('.md')) continue
    const name = path.posix.basename(file, '.md')
    docs.push({ id: `adr/${name}`, title: `ADR: ${name}`, kind: 'adr', relPath: `docs/adr/${file}` })
  }
  return docs
}

export function docRelPath(docId: string): string {
  const fixed = DOC_SOURCES.find((d) => d.id === docId)
  if (fixed) return fixed.relPath
  const adr = /^adr\/([a-z0-9][a-z0-9-]{0,63})$/.exec(docId)
  if (adr?.[1]) return `docs/adr/${adr[1]}.md`
  throw new HttpError(400, 'invalid-id', 'doc id is not recognized')
}

function changeCapabilities(root: string, changeId: string, archived: boolean): string[] {
  const base = archived
    ? `openspec/changes/archive/${changeId}/specs`
    : `openspec/changes/${changeId}/specs`
  return listSubdirs(root, base)
}

function unavailableSnapshot(project: ProjectConfig, error: string): ProjectSnapshot {
  return {
    id: project.id,
    name: project.name,
    available: false,
    error,
    updatedAt: new Date().toISOString(),
    schema: null,
    ...(project.store ? { store: project.store } : {}),
    specs: [],
    changes: [],
    validation: { status: 'UNAVAILABLE', items: [], totals: { items: 0, passed: 0, failed: 0 }, error },
    doctor: { available: false, healthy: false, messages: [error] },
    docs: [],
    totals: { specs: 0, requirements: 0, scenarios: 0, activeChanges: 0, archivedChanges: 0, taskPercent: 0 },
  }
}

export async function scanProject(project: ProjectConfig, cli: OpenSpecCli): Promise<ProjectSnapshot> {
  if (!existsSync(project.path)) {
    return unavailableSnapshot(project, 'project path does not exist on the server')
  }
  if (!existsSync(path.join(project.path, 'openspec'))) {
    return unavailableSnapshot(project, 'no openspec/ directory at the project root')
  }

  let schema: string | null = null
  const configText = tryReadProjectFile(project.path, 'openspec/config.yaml')
  if (configText) {
    try {
      const parsed = parseYaml(configText) as { schema?: unknown } | null
      if (parsed && typeof parsed.schema === 'string') schema = parsed.schema
    } catch {
      schema = null
    }
  }

  const [specsResult, changesResult, validateResult, doctorResult] = await Promise.all([
    cli.listSpecs(project),
    cli.listAllChanges(project),
    cli.validateAll(project),
    cli.doctor(project),
  ])

  const specsJson = asRecord(specsResult.json)
  const specEntries = Array.isArray(specsJson?.specs) ? specsJson.specs.map(asRecord).filter((s): s is Record<string, unknown> => s !== null) : []

  const changesJson = asRecord(changesResult.json)
  const changeEntries = Array.isArray(changesJson?.changes) ? changesJson.changes.map(asRecord).filter((c): c is Record<string, unknown> => c !== null) : []

  const modifiedBy = new Map<string, string[]>()
  const changes: ChangeSummary[] = []
  for (const entry of changeEntries) {
    if (typeof entry.name !== 'string') continue
    const id = entry.name
    const archived = entry.archived === true
    const completedTasks = typeof entry.completedTasks === 'number' ? entry.completedTasks : 0
    const totalTasks = typeof entry.totalTasks === 'number' ? entry.totalTasks : 0
    const capabilities = changeCapabilities(project.path, id, archived)
    if (!archived) {
      for (const cap of capabilities) {
        const list = modifiedBy.get(cap) ?? []
        list.push(id)
        modifiedBy.set(cap, list)
      }
    }
    let artifacts: ArtifactStatus[] = []
    if (!archived) {
      const statusResult = await cli.status(project, id)
      const statusJson = asRecord(statusResult.json)
      if (Array.isArray(statusJson?.artifacts)) {
        artifacts = statusJson.artifacts
          .map(asRecord)
          .filter((a): a is Record<string, unknown> => a !== null && typeof a.id === 'string')
          .map((a) => ({ id: a.id as string, status: typeof a.status === 'string' ? a.status : 'unknown' }))
      }
    }
    const artifactsDone = artifacts.filter((a) => a.status === 'done').length
    const stage = deriveStage({ archived, artifactsDone, artifactTotal: artifacts.length, completedTasks, totalTasks })
    changes.push({
      id,
      archived,
      stage,
      artifacts,
      artifactsDone,
      artifactTotal: artifacts.length,
      completedTasks,
      totalTasks,
      taskPercent: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
      lastModified: typeof entry.lastModified === 'string' ? entry.lastModified : null,
      capabilities,
    })
  }

  const specs: SpecDetail[] = []
  for (const entry of specEntries) {
    if (typeof entry.id !== 'string') continue
    const id = entry.id
    const showResult = await cli.showSpec(project, id)
    const showJson = asRecord(showResult.json)
    const requirements = mapRequirements(showJson?.requirements)
    const markdown = tryReadProjectFile(project.path, `openspec/specs/${id}/spec.md`) ?? ''
    const scenarioCount = requirements.reduce((n, r) => n + r.scenarios.length, 0)
    specs.push({
      id,
      overview: typeof showJson?.overview === 'string' ? showJson.overview : '',
      requirementCount: requirements.length || (typeof entry.requirementCount === 'number' ? entry.requirementCount : 0),
      scenarioCount,
      requirements,
      markdown,
      modifiedBy: modifiedBy.get(id) ?? [],
    })
  }

  const active = changes.filter((c) => !c.archived)
  const taskTotals = active.reduce(
    (acc, c) => ({ done: acc.done + c.completedTasks, total: acc.total + c.totalTasks }),
    { done: 0, total: 0 },
  )
  const lastModified = changes
    .map((c) => c.lastModified)
    .filter((v): v is string => v !== null)
    .sort()
    .at(-1)

  return {
    id: project.id,
    name: project.name,
    available: true,
    updatedAt: lastModified ?? new Date().toISOString(),
    schema,
    ...(project.store ? { store: project.store } : {}),
    specs,
    changes,
    validation: mapValidation(validateResult),
    doctor: mapDoctor(doctorResult),
    docs: collectDocs(project.path),
    totals: {
      specs: specs.length,
      requirements: specs.reduce((n, s) => n + s.requirementCount, 0),
      scenarios: specs.reduce((n, s) => n + s.scenarioCount, 0),
      activeChanges: active.length,
      archivedChanges: changes.length - active.length,
      taskPercent: taskTotals.total > 0 ? Math.round((taskTotals.done / taskTotals.total) * 100) : 0,
    },
  }
}

export async function buildChangeDetail(
  project: ProjectConfig,
  summary: ChangeSummary,
): Promise<ChangeDetail> {
  const base = summary.archived
    ? `openspec/changes/archive/${summary.id}`
    : `openspec/changes/${summary.id}`
  const proposal = tryReadProjectFile(project.path, `${base}/proposal.md`)
  const design = tryReadProjectFile(project.path, `${base}/design.md`)
  const tasksMarkdown = tryReadProjectFile(project.path, `${base}/tasks.md`)
  const deltaFiles: DeltaFile[] = []
  const deltas: ChangeDelta[] = []
  for (const file of walkProjectDir(project.path, `${base}/specs`)) {
    if (!file.endsWith('.md')) continue
    const rel = `${base}/specs/${file}`
    const markdown = readProjectFile(project.path, rel)
    deltaFiles.push({ path: `specs/${file}`, markdown })
    const capability = file.split('/')[0] ?? 'unknown'
    deltas.push(...parseDeltaMarkdown(capability, markdown))
  }
  return {
    id: summary.id,
    summary,
    proposal,
    design,
    tasksMarkdown,
    tasks: tasksMarkdown ? parseTasks(tasksMarkdown) : [],
    deltas,
    deltaFiles,
  }
}