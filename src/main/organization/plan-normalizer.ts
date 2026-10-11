import type { ProjectPlanInput, TaskPriority } from '../../shared/organization.js'

type PlannedTask = ProjectPlanInput['milestones'][number]['tasks'][number]

const PRIORITIES = new Set<TaskPriority>(['low', 'medium', 'high', 'critical'])
const MAX_WORK_SCOPES = 32
const MAX_TITLE = 200

export interface NormalizedPlan {
  plan: ProjectPlanInput
  /** Every repair made to the model's plan, in plain language, for the activity log. */
  adjustments: string[]
}

/**
 * Turn a model-written plan into one ND can apply. Models routinely reference a
 * dependency by a slightly different title or by number, repeat a title, or omit
 * an optional field; rejecting the whole plan for that leaves the human with
 * nothing. Only a plan with no goal title or no tasks at all is unusable.
 */
export function normalizeProjectPlan(raw: unknown, options: { recoverRepeatedLists?: boolean } = {}): NormalizedPlan {
  const adjustments: string[] = []
  let input = (raw ?? {}) as Partial<ProjectPlanInput>
  if (options.recoverRepeatedLists) input = recoverRepeatedPlanTasks(input, adjustments)
  const goalTitle = text(input.goal?.title)
  if (!goalTitle) throw new Error('Invalid ND-DSH project plan: the goal needs a title')
  const goalDescription = text(input.goal?.description) || goalTitle

  const usedKeys = new Map<string, number>()
  const reservedKeys = new Set((Array.isArray(input.milestones) ? input.milestones : [])
    .flatMap((milestone) => Array.isArray(milestone?.tasks) ? milestone.tasks : [])
    .map((task) => titleKey(text(task?.title).slice(0, MAX_TITLE))))
  const flat: PlannedTask[] = []
  const milestones: ProjectPlanInput['milestones'] = []
  for (const [milestoneIndex, milestoneInput] of (Array.isArray(input.milestones) ? input.milestones : []).entries()) {
    const milestoneTitle = text(milestoneInput?.title) || `Milestone ${milestoneIndex + 1}`
    const tasks: PlannedTask[] = []
    for (const taskInput of Array.isArray(milestoneInput?.tasks) ? milestoneInput.tasks : []) {
      let title = text(taskInput?.title).slice(0, MAX_TITLE)
      if (!title) {
        adjustments.push(`Dropped an untitled task in "${milestoneTitle}".`)
        continue
      }
      const key = titleKey(title)
      const seen = usedKeys.get(key) ?? 0
      if (seen > 0) {
        let suffix = seen + 1
        let renamed: string
        do {
          const ending = ` (${suffix++})`
          renamed = `${title.slice(0, MAX_TITLE - ending.length)}${ending}`
        } while (usedKeys.has(titleKey(renamed)) || reservedKeys.has(titleKey(renamed)))
        adjustments.push(`Renamed duplicate task "${title}" to "${renamed}".`)
        title = renamed
      }
      usedKeys.set(key, seen + 1)
      usedKeys.set(titleKey(title), usedKeys.get(titleKey(title)) ?? 1)
      const task = normalizeTask(taskInput, title, adjustments)
      tasks.push(task)
      flat.push(task)
    }
    if (!tasks.length) {
      adjustments.push(`Dropped milestone "${milestoneTitle}" because it had no tasks.`)
      continue
    }
    milestones.push({ title: milestoneTitle, description: text(milestoneInput?.description) || milestoneTitle, tasks })
  }
  if (!flat.length) throw new Error('Invalid ND-DSH project plan: it contains no tasks')

  resolveDependencies(flat, adjustments)
  breakCycles(flat, adjustments)

  const memory = (Array.isArray(input.memory) ? input.memory : [])
    .filter((item) => text(item?.title) && text(item?.content))
    .map((item) => ({ title: text(item.title), content: text(item.content), ...(Array.isArray(item.tags) ? { tags: item.tags.filter((tag) => typeof tag === 'string') } : {}) }))

  return {
    plan: { goal: { title: goalTitle, description: goalDescription }, milestones, ...(memory.length ? { memory } : {}) },
    adjustments,
  }
}

/**
 * Only duplicated-list recovery opts into this repair. A model can deliberately
 * assign same-title or identical tasks in an ordinary plan; retain those by default.
 * Repeated complete task objects across recovered milestones belong to their final
 * milestone. Never infer equivalence from just a title, description or write scope.
 */
function recoverRepeatedPlanTasks(input: Partial<ProjectPlanInput>, adjustments: string[]): Partial<ProjectPlanInput> {
  if (!Array.isArray(input.milestones)) return input
  const locations = new Map<string, { owner: number; counts: Map<number, number> }>()
  const signature = (task: unknown): string | undefined => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return undefined
    return JSON.stringify(canonicalJson(task))
  }
  for (const [index, milestone] of input.milestones.entries()) {
    for (const task of Array.isArray(milestone?.tasks) ? milestone.tasks : []) {
      const key = signature(task)
      if (!key) continue
      let location = locations.get(key)
      if (!location) { location = { owner: index, counts: new Map() }; locations.set(key, location) }
      location.owner = index
      location.counts.set(index, (location.counts.get(index) ?? 0) + 1)
    }
  }
  const duplicates = new Map([...locations].filter(([, location]) => location.counts.size > 1 && [...location.counts.values()].every((count) => count === 1)))
  if (!duplicates.size) return input
  const tasks = input.milestones.flatMap((milestone) => Array.isArray(milestone?.tasks) ? milestone.tasks : [])
  const hasNumericDependency = tasks.some((task) => Array.isArray(task?.dependsOn) && task.dependsOn.some((reference) =>
    typeof reference === 'number' || typeof reference === 'string' && /^(?:task\s*#?|t|#)?\s*(\d+)$/i.test(reference.trim()),
  ))
  if (hasNumericDependency) throw new Error('Invalid ND-DSH project plan: repeated task lists contain numeric dependencies; use exact task titles so duplicate recovery cannot change their targets')
  let removed = 0
  const milestones = input.milestones.map((milestone, index) => {
    if (!Array.isArray(milestone?.tasks)) return milestone
    const remaining = milestone.tasks.filter((task) => {
      const key = signature(task)
      const duplicate = key ? duplicates.get(key) : undefined
      if (!duplicate || duplicate.owner === index) return true
      removed += 1
      return false
    })
    return { ...milestone, tasks: remaining }
  })
  adjustments.push(`Recovered ${removed} identical task(s) repeated across milestone lists; retained their final milestone ownership.`)
  return { ...input, milestones }
}

function canonicalJson(value: unknown, depth = 0): unknown {
  if (depth > 128) throw new Error('Invalid ND-DSH project plan: task signature exceeds the nesting limit')
  if (Array.isArray(value)) return value.map((item) => canonicalJson(item, depth + 1))
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalJson((value as Record<string, unknown>)[key], depth + 1)
    return sorted
  }
  return value
}

function normalizeTask(input: Partial<PlannedTask> | undefined, title: string, adjustments: string[]): PlannedTask {
  const task: PlannedTask = { title, description: text(input?.description) || title }
  const priority = typeof input?.priority === 'string' ? input.priority.toLowerCase() as TaskPriority : undefined
  if (priority && PRIORITIES.has(priority)) task.priority = priority
  const criteria = stringList(input?.acceptanceCriteria)
  if (criteria.length) task.acceptanceCriteria = criteria
  const dependsOn = Array.isArray(input?.dependsOn)
    ? input.dependsOn.map((value) => typeof value === 'number' ? String(value) : value).filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : []
  if (dependsOn.length) task.dependsOn = dependsOn
  if (text(input?.role)) task.role = text(input?.role)
  const workScopes = stringList(input?.workScopes).filter((value) => value.length <= 512 && !/[\u0000-\u001f]/.test(value))
  if (workScopes.length > MAX_WORK_SCOPES) adjustments.push(`Kept the first ${MAX_WORK_SCOPES} work scopes of "${title}".`)
  if (workScopes.length) task.workScopes = workScopes.slice(0, MAX_WORK_SCOPES)
  const artifactPaths = stringList(input?.artifactPaths)
  if (input?.evidenceKind === 'artifact') {
    if (artifactPaths.length) {
      task.evidenceKind = 'artifact'
      task.artifactPaths = artifactPaths
    } else {
      adjustments.push(`"${title}" declared artifact evidence without paths; it will be verified as code.`)
    }
  } else if (input?.evidenceKind === 'code') {
    task.evidenceKind = 'code'
  }
  return task
}

/**
 * Map each dependency to a planned task's exact title: by normalized title, by
 * 1-based task number ("3", "task 3", "T3"), or by a unique partial title match.
 * Anything else is dropped rather than left to block a task forever.
 */
function resolveDependencies(tasks: PlannedTask[], adjustments: string[]): void {
  const byKey = new Map(tasks.map((task) => [titleKey(task.title), task]))
  for (const task of tasks) {
    if (!task.dependsOn?.length) continue
    const resolved: string[] = []
    for (const reference of task.dependsOn) {
      const target = byKey.get(titleKey(reference))
        ?? byNumber(tasks, reference)
        ?? byPartialTitle(tasks, reference)
      if (!target) {
        adjustments.push(`Removed unknown dependency "${reference}" from "${task.title}".`)
        continue
      }
      if (target === task) {
        adjustments.push(`Removed a self-dependency from "${task.title}".`)
        continue
      }
      if (!resolved.includes(target.title)) resolved.push(target.title)
    }
    if (resolved.length) task.dependsOn = resolved
    else delete task.dependsOn
  }
}

function byNumber(tasks: PlannedTask[], reference: string): PlannedTask | undefined {
  const match = /^(?:task\s*#?|t|#)?\s*(\d+)$/i.exec(reference.trim())
  if (!match) return undefined
  return tasks[Number(match[1]) - 1]
}

function byPartialTitle(tasks: PlannedTask[], reference: string): PlannedTask | undefined {
  const key = titleKey(reference)
  if (key.length < 4) return undefined
  const candidates = tasks.filter((task) => {
    const taskKey = titleKey(task.title)
    return taskKey.includes(key) || key.includes(taskKey)
  })
  return candidates.length === 1 ? candidates[0] : undefined
}

/** Drop the edge that closes a cycle, in declaration order, so every task can eventually run. */
function breakCycles(tasks: PlannedTask[], adjustments: string[]): void {
  const byTitle = new Map(tasks.map((task) => [task.title, task]))
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (task: PlannedTask): void => {
    state.set(task.title, 'visiting')
    for (const dependency of [...(task.dependsOn ?? [])]) {
      const target = byTitle.get(dependency)
      if (!target) continue
      const status = state.get(target.title)
      if (status === 'visiting') {
        task.dependsOn = task.dependsOn!.filter((value) => value !== dependency)
        if (!task.dependsOn.length) delete task.dependsOn
        adjustments.push(`Removed the dependency of "${task.title}" on "${dependency}" to break a cycle.`)
        continue
      }
      if (!status) visit(target)
    }
    state.set(task.title, 'done')
  }
  for (const task of tasks) if (!state.has(task.title)) visit(task)
}

function titleKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : []
}
