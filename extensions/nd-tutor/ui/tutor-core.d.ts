export interface TutorLesson {
  day: number
  week: number
  topic: string
  focus: string
  objective: string
  khmerObjective?: string
  prerequisites: string
  diagnostic: string
  khmerDiagnostic?: string
  exercise: string
  hints: string[]
  solution: string
  failureCase: string
  rubric: string
  retrievalQuestions: string[]
}

export interface TutorWeek {
  week: number
  title: string
  focus: string
  days: number[]
}

export interface TutorCourse {
  id: string
  title: string
  tagline: string
  description: string
  category: string
  totalDays: number
  active: boolean
  weeks: TutorWeek[]
  lessons: TutorLesson[]
}

export interface QuickReferenceSection {
  id: string
  title: string
  items: string[]
}

export const SPRINGBOOT_COURSE_ID: string
export const SANDBOX_COMPOSE_YAML: string
export const SANDBOX_SEED_SQL: string
export const QUICK_REFERENCE_SECTIONS: QuickReferenceSection[]
export const COURSES: TutorCourse[]

export function getCourse(courseId: string): TutorCourse | undefined
export function getLesson(courseId: string, day: number): TutorLesson | undefined
export function calculateStats(courseId: string, progress: any): {
  totalDays: number
  completedDays: number
  percent: number
  avgScore: number
}
export function getDueReviews(reviews: any[], forDateStr?: string): any[]
export function getNextDay(courseId: string, progress: any): number

export interface LiveToolDeclaration {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

export const LIVE_TEACHER_TOOLS: LiveToolDeclaration[]

export function buildLiveLessonContext(input: {
  courseId: string
  day: number
  lang?: 'en' | 'km'
  scratchpad?: string
  dueReviewsCount?: number
}): string
