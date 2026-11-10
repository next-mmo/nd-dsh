import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

export type TutorLessonStatus = 'pending' | 'in_progress' | 'completed' | 'needs_retry'

export interface TutorLessonProgress {
  status: TutorLessonStatus
  score?: number
  notes?: string
  answer?: string
  startedAt?: string
  completedAt?: string
  lastAttemptAt?: string
}

export interface TutorReviewItem {
  id: string
  courseId: string
  day: number
  topic: string
  due: string // YYYY-MM-DD
  intervalDays: number
  status: 'pending' | 'passed' | 'failed'
  reviewedAt?: string
  note?: string
}

export interface TutorJournalEntry {
  id: string
  timestamp: string
  courseId: string
  day?: number
  message: string
}

export interface TutorCourseProgress {
  startedOn: string
  lastActiveDay: number
  days: Record<string, TutorLessonProgress>
  reviews: TutorReviewItem[]
  journal: TutorJournalEntry[]
  workspacePath?: string
}

export interface TutorProgressData {
  schema_version: 1
  activeCourseId: string
  courses: Record<string, TutorCourseProgress>
}

export interface TutorSaveProgressInput {
  action?: string
  courseId?: string
  day: number
  status: TutorLessonStatus
  score?: number
  notes?: string
  answer?: string
  journalMessage?: string
  workspacePath?: string
  topic?: string
}

export interface TutorReviewInput {
  action?: string
  courseId?: string
  reviewId: string
  result: 'passed' | 'failed'
  note?: string
}

export interface TutorResetInput {
  action?: string
  courseId?: string
}

export function asTutorLessonStatus(value: unknown): TutorLessonStatus {
  if (value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'needs_retry') {
    return value
  }
  return 'in_progress'
}

function todayIsoDate(): string {
  const d = new Date()
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDaysIsoDate(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const DEFAULT_TUTOR_COURSE_ID = 'springboot-db-tutor'

function createEmptyCourseProgress(): TutorCourseProgress {
  return {
    startedOn: todayIsoDate(),
    lastActiveDay: 1,
    days: {},
    reviews: [],
    journal: [],
  }
}

function createDefaultData(): TutorProgressData {
  return {
    schema_version: 1,
    activeCourseId: DEFAULT_TUTOR_COURSE_ID,
    courses: {
      [DEFAULT_TUTOR_COURSE_ID]: createEmptyCourseProgress(),
    },
  }
}

/**
 * Durable learning progress store for ND Tutor.
 * Atomic JSON file persistence under userData, with optional sync to learner's
 * workspace folder (`<workspace>/learning/progress.json` and `journal.md`).
 */
export class TutorStore {
  private loaded = false
  private data: TutorProgressData = createDefaultData()
  private saveChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async get(courseId?: string): Promise<{
    activeCourseId: string
    courseProgress: TutorCourseProgress
    allCourses: Record<string, TutorCourseProgress>
  }> {
    await this.load()
    const active = courseId || this.data.activeCourseId || DEFAULT_TUTOR_COURSE_ID
    if (!this.data.courses[active]) {
      this.data.courses[active] = createEmptyCourseProgress()
    }
    return {
      activeCourseId: active,
      courseProgress: structuredClone(this.data.courses[active]),
      allCourses: structuredClone(this.data.courses),
    }
  }

  async saveProgress(rawInput: unknown): Promise<{
    activeCourseId: string
    courseProgress: TutorCourseProgress
  }> {
    await this.load()
    const input = (typeof rawInput === 'object' && rawInput !== null ? rawInput : {}) as Partial<TutorSaveProgressInput>

    const courseId = typeof input.courseId === 'string' && input.courseId.trim()
      ? input.courseId.trim()
      : this.data.activeCourseId || DEFAULT_TUTOR_COURSE_ID
    const day = typeof input.day === 'number' && Number.isFinite(input.day) && input.day > 0
      ? Math.floor(input.day)
      : 1
    const status = asTutorLessonStatus(input.status)
    const score = typeof input.score === 'number' && Number.isFinite(input.score)
      ? Math.max(0, Math.min(100, Math.floor(input.score)))
      : undefined
    const notes = typeof input.notes === 'string' ? input.notes.slice(0, 10_000) : undefined
    const answer = typeof input.answer === 'string' ? input.answer.slice(0, 50_000) : undefined
    const journalMessage = typeof input.journalMessage === 'string' && input.journalMessage.trim()
      ? input.journalMessage.trim().slice(0, 5_000)
      : undefined
    const topic = typeof input.topic === 'string' ? input.topic.trim().slice(0, 200) : `Day ${day}`

    this.data.activeCourseId = courseId
    if (!this.data.courses[courseId]) {
      this.data.courses[courseId] = createEmptyCourseProgress()
    }
    const course = this.data.courses[courseId]
    course.lastActiveDay = day

    if (typeof input.workspacePath === 'string' && input.workspacePath.trim()) {
      course.workspacePath = input.workspacePath.trim()
    }

    const dayKey = String(day)
    const existing = course.days[dayKey] ?? {
      status: 'pending',
      startedAt: new Date().toISOString(),
    }

    const nowIso = new Date().toISOString()
    const updated: TutorLessonProgress = {
      ...existing,
      status,
      lastAttemptAt: nowIso,
    }
    if (score !== undefined) updated.score = score
    if (notes !== undefined) updated.notes = notes
    if (answer !== undefined) updated.answer = answer
    if (status === 'completed' && !updated.completedAt) {
      updated.completedAt = nowIso
    }

    course.days[dayKey] = updated

    // Schedule spaced reviews on successful completion (score >= 70)
    if (status === 'completed' && (score === undefined || score >= 70)) {
      this.scheduleSpacedReviews(course, courseId, day, topic)
    }

    // Append journal entry if provided
    if (journalMessage) {
      const entry: TutorJournalEntry = {
        id: randomUUID(),
        timestamp: nowIso,
        courseId,
        day,
        message: journalMessage,
      }
      course.journal.unshift(entry)
      if (course.journal.length > 200) {
        course.journal.length = 200
      }
    }

    await this.persist()

    // Optional workspace mirror
    if (course.workspacePath) {
      await this.syncToWorkspace(course.workspacePath, course, courseId)
    }

    return {
      activeCourseId: courseId,
      courseProgress: structuredClone(course),
    }
  }

  async recordReview(rawInput: unknown): Promise<{
    activeCourseId: string
    courseProgress: TutorCourseProgress
  }> {
    await this.load()
    const input = (typeof rawInput === 'object' && rawInput !== null ? rawInput : {}) as Partial<TutorReviewInput>
    const courseId = typeof input.courseId === 'string' && input.courseId.trim()
      ? input.courseId.trim()
      : this.data.activeCourseId || DEFAULT_TUTOR_COURSE_ID
    const reviewId = typeof input.reviewId === 'string' ? input.reviewId.trim() : ''
    const result = input.result === 'passed' ? 'passed' : 'failed'
    const note = typeof input.note === 'string' ? input.note.slice(0, 1_000) : undefined

    const course = this.data.courses[courseId]
    if (course && reviewId) {
      const rev = course.reviews.find((r) => r.id === reviewId)
      if (rev) {
        rev.status = result
        rev.reviewedAt = new Date().toISOString()
        if (note) rev.note = note
      }
    }

    await this.persist()
    return {
      activeCourseId: courseId,
      courseProgress: structuredClone(course ?? createEmptyCourseProgress()),
    }
  }

  async reset(rawInput: unknown): Promise<{
    activeCourseId: string
    courseProgress: TutorCourseProgress
  }> {
    await this.load()
    const input = (typeof rawInput === 'object' && rawInput !== null ? rawInput : {}) as Partial<TutorResetInput>
    const courseId = typeof input.courseId === 'string' && input.courseId.trim()
      ? input.courseId.trim()
      : this.data.activeCourseId || DEFAULT_TUTOR_COURSE_ID

    this.data.courses[courseId] = createEmptyCourseProgress()
    await this.persist()

    return {
      activeCourseId: courseId,
      courseProgress: structuredClone(this.data.courses[courseId]),
    }
  }

  private scheduleSpacedReviews(course: TutorCourseProgress, courseId: string, day: number, topic: string): void {
    const intervals = [1, 3, 7]
    for (const interval of intervals) {
      const dueDate = addDaysIsoDate(interval)
      const exists = course.reviews.some(
        (r) => r.day === day && r.intervalDays === interval && (r.status === 'pending' || r.status === 'passed')
      )
      if (!exists) {
        course.reviews.push({
          id: randomUUID(),
          courseId,
          day,
          topic,
          due: dueDate,
          intervalDays: interval,
          status: 'pending',
        })
      }
    }
  }

  private async syncToWorkspace(workspacePath: string, course: TutorCourseProgress, courseId: string): Promise<void> {
    try {
      if (!existsSync(workspacePath)) return
      const learningDir = join(workspacePath, 'learning')
      await fs.mkdir(learningDir, { recursive: true })

      const workspaceJsonPath = join(learningDir, 'progress.json')
      const mirrorData = {
        schema_version: 1,
        track: courseId,
        started_on: course.startedOn,
        days: course.days,
        reviews: course.reviews,
      }
      await fs.writeFile(workspaceJsonPath, JSON.stringify(mirrorData, null, 2) + '\n', 'utf8')

      const journalMdPath = join(learningDir, 'journal.md')
      if (course.journal.length > 0) {
        const latest = course.journal[0]
        if (latest) {
          const line = `- ${latest.timestamp} — [Day ${latest.day ?? '?'}] ${latest.message}\n`
          await fs.appendFile(journalMdPath, line, 'utf8')
        }
      }
    } catch {
      // Non-fatal if workspace directory is unwritable
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const content = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(content) as Partial<TutorProgressData>
      if (parsed && parsed.schema_version === 1 && typeof parsed.courses === 'object') {
        this.data = {
          schema_version: 1,
          activeCourseId: parsed.activeCourseId || DEFAULT_TUTOR_COURSE_ID,
          courses: parsed.courses as Record<string, TutorCourseProgress>,
        }
      }
    } catch {
      // First run or missing file: keep default
    }
  }

  private async persist(): Promise<void> {
    this.saveChain = this.saveChain.then(async () => {
      const dir = dirname(this.filePath)
      await fs.mkdir(dir, { recursive: true })
      const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      const json = JSON.stringify(this.data, null, 2) + '\n'
      await fs.writeFile(tmpPath, json, 'utf8')
      await fs.rename(tmpPath, this.filePath)
    })
    return this.saveChain
  }
}
