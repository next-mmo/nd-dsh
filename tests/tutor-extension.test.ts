import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionPackageStore } from '../src/main/extensions/package-store.js'
import { InvocationStateStore } from '../src/main/extensions/invocation-state.js'
import { NativeHostRegistry } from '../src/main/extensions/native-host.js'
import { InvocationBroker, type NdOrganizationPort } from '../src/main/extensions/invocation-broker.js'
import { TutorStore } from '../src/main/extensions/tutor-store.js'
import {
  COURSES,
  SPRINGBOOT_COURSE_ID,
  LIVE_TEACHER_TOOLS,
  buildLiveLessonContext,
  calculateStats,
  getCourse,
  getDueReviews,
  getLesson,
  getNextDay,
} from '../extensions/nd-tutor/ui/tutor-core.js'
import { manifestPermissionIssues, validateNdExtensionManifest, type NdExtensionManifest } from '../src/shared/extension-package.js'
import { personalContext } from '../src/shared/nd-context.js'

const packagePath = fileURLToPath(new URL('../extensions/nd-tutor/', import.meta.url))
const manifestPath = new URL('../extensions/nd-tutor/nd-extension.json', import.meta.url)

async function loadManifest(): Promise<NdExtensionManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const result = validateNdExtensionManifest(parsed)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  return result.manifest
}

describe('ND Tutor extension package', () => {
  it('validates as a Personal web-view and skill package with all declared permissions', async () => {
    const manifest = await loadManifest()
    expect(manifest.id).toBe('nd.tutor')
    expect(manifest.contexts).toEqual(['personal'])
    expect(manifest.permissions).toContain('tutor.read')
    expect(manifest.permissions).toContain('tutor.write')
    expect(manifest.permissions).toContain('clipboard.write')
    expect(manifest.permissions).toContain('chat.compose')
    expect(manifest.permissions).toContain('live.voice')
    expect(manifest.settings.map((s) => s.key)).toEqual(['liveModel', 'liveVoice'])
    expect(manifest.executable).toBeUndefined()
    expect(manifestPermissionIssues(manifest)).toEqual([])

    const [view] = manifest.contributions.views
    expect(view?.kind).toBe('web')
    expect(view?.entry).toBe('ui/index.html')
    expect(view?.host).toBeUndefined()
    expect(view?.actions.map((action) => [action.id, action.host])).toEqual([
      ['get-progress', 'tutor.progress.get'],
      ['save-progress', 'tutor.progress.save'],
      ['reset-progress', 'tutor.progress.reset'],
      ['copy', 'clipboard.write'],
      ['ask-coach', 'skill.compose'],
    ])
    expect(manifest.contributions.commands[0]?.openViewId).toBe('main')
    expect(manifest.contributions.skills.length).toBeGreaterThan(0)
    expect(manifest.contributions.skills[0]?.id).toBe('tutor-coach')
  })

  it('installs from its directory including all assets, activates, and uninstalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-tutor-test-'))
    try {
      const packages = new ExtensionPackageStore(root)
      const installed = await packages.installFromDirectory(packagePath, { expectId: 'nd.tutor' })
      expect(installed.id).toBe('nd.tutor')

      // All key UI and asset files must be in the snapshot
      for (const asset of [
        'ui/index.html',
        'ui/tutor.css',
        'ui/tutor.js',
        'ui/tutor-core.js',
        'ui/tutor-core.d.ts',
        'assets/compose.yaml',
        'assets/sql/seed_day01.sql',
      ]) {
        expect(await packages.snapshotFileFor('nd.tutor', installed.version, asset)).not.toBeNull()
      }

      const state = new InvocationStateStore(root)
      const personal = personalContext()
      expect(await state.activation('nd.tutor', personal)).toBeUndefined()
      await state.setActivation('nd.tutor', personal, true)
      expect((await state.activation('nd.tutor', personal))?.enabled).toBe(true)

      await packages.uninstall('nd.tutor')
      expect(await packages.record('nd.tutor')).toBeUndefined()
      expect(await packages.activeManifest('nd.tutor')).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  describe('TutorStore backend persistence', () => {
    let tmpDir: string
    let store: TutorStore

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'nd-tutor-store-'))
      store = new TutorStore(join(tmpDir, 'progress.json'))
    })

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    it('returns default initial progress', async () => {
      const result = await store.get()
      expect(result.activeCourseId).toBe(SPRINGBOOT_COURSE_ID)
      expect(result.courseProgress.days).toEqual({})
      expect(result.courseProgress.reviews).toEqual([])
      expect(result.courseProgress.journal).toEqual([])
    })

    it('records lesson attempt and schedules spaced reviews on completion with mastery score >= 70', async () => {
      const saveRes = await store.saveProgress({
        courseId: SPRINGBOOT_COURSE_ID,
        day: 1,
        status: 'completed',
        score: 85,
        answer: 'CREATE TABLE todos (...);',
        journalMessage: 'Understood NOT NULL vs blank strings.',
        topic: 'What makes a database row valid?',
      })

      expect(saveRes.courseProgress.days['1']?.status).toBe('completed')
      expect(saveRes.courseProgress.days['1']?.score).toBe(85)
      expect(saveRes.courseProgress.days['1']?.answer).toContain('CREATE TABLE')

      // Should automatically schedule 3 reviews (+1, +3, +7 days)
      expect(saveRes.courseProgress.reviews.length).toBe(3)
      expect(saveRes.courseProgress.reviews.map((r) => r.intervalDays)).toEqual([1, 3, 7])
      expect(saveRes.courseProgress.reviews.every((r) => r.day === 1 && r.status === 'pending')).toBe(true)

      // Journal entry must be logged
      expect(saveRes.courseProgress.journal.length).toBe(1)
      expect(saveRes.courseProgress.journal[0]?.message).toContain('Understood NOT NULL')

      // Persistence reload check
      const reloadedStore = new TutorStore(join(tmpDir, 'progress.json'))
      const loaded = await reloadedStore.get()
      expect(loaded.courseProgress.days['1']?.status).toBe('completed')
      expect(loaded.courseProgress.days['1']?.score).toBe(85)
    })

    it('does not schedule spaced reviews if score is under 70', async () => {
      const saveRes = await store.saveProgress({
        courseId: SPRINGBOOT_COURSE_ID,
        day: 2,
        status: 'needs_retry',
        score: 55,
      })

      expect(saveRes.courseProgress.days['2']?.status).toBe('needs_retry')
      expect(saveRes.courseProgress.reviews.length).toBe(0)
    })

    it('records review results and resets progress', async () => {
      await store.saveProgress({
        courseId: SPRINGBOOT_COURSE_ID,
        day: 1,
        status: 'completed',
        score: 90,
      })

      const state = await store.get()
      const reviewId = state.courseProgress.reviews[0]?.id
      expect(reviewId).toBeDefined()

      const reviewRes = await store.recordReview({
        courseId: SPRINGBOOT_COURSE_ID,
        reviewId: reviewId!,
        result: 'passed',
        note: 'Recalled correctly',
      })

      const updatedRev = reviewRes.courseProgress.reviews.find((r) => r.id === reviewId)
      expect(updatedRev?.status).toBe('passed')
      expect(updatedRev?.note).toBe('Recalled correctly')

      const resetRes = await store.reset({ courseId: SPRINGBOOT_COURSE_ID })
      expect(resetRes.courseProgress.days).toEqual({})
      expect(resetRes.courseProgress.reviews).toEqual([])
    })
  })

  describe('Tutor core curriculum logic', () => {
    it('contains all 28 Spring Boot curriculum lessons', () => {
      const course = getCourse(SPRINGBOOT_COURSE_ID)
      expect(course).toBeDefined()
      expect(course?.totalDays).toBe(28)
      expect(course?.lessons.length).toBe(28)

      for (let day = 1; day <= 28; day++) {
        const lesson = getLesson(SPRINGBOOT_COURSE_ID, day)
        expect(lesson, `Lesson ${day} must exist`).toBeDefined()
        expect(lesson?.day).toBe(day)
        expect(lesson?.topic).toBeTruthy()
        expect(lesson?.objective).toBeTruthy()
        expect(lesson?.exercise).toBeTruthy()
        expect(lesson?.hints.length).toBeGreaterThanOrEqual(2)
        expect(lesson?.solution).toBeTruthy()
      }
    })

    it('computes stats and review queues accurately', () => {
      const progress = {
        days: {
          '1': { status: 'completed', score: 80 },
          '2': { status: 'completed', score: 90 },
          '3': { status: 'in_progress' },
        },
        reviews: [
          { id: '1', day: 1, due: '2020-01-01', status: 'pending' },
          { id: '2', day: 1, due: '2099-01-01', status: 'pending' },
          { id: '3', day: 1, due: '2020-01-01', status: 'passed' },
        ],
      }

      const stats = calculateStats(SPRINGBOOT_COURSE_ID, progress)
      expect(stats.totalDays).toBe(28)
      expect(stats.completedDays).toBe(2)
      expect(stats.avgScore).toBe(85)
      expect(stats.percent).toBe(Math.round((2 / 28) * 100))

      const due = getDueReviews(progress.reviews, '2026-01-01')
      expect(due.length).toBe(1)
      expect(due[0]?.id).toBe('1')

      const next = getNextDay(SPRINGBOOT_COURSE_ID, progress)
      expect(next).toBe(3)
    })

    it('builds bounded live lesson context and teacher tool declarations', () => {
      expect(LIVE_TEACHER_TOOLS.map((t) => t.name)).toEqual(['show_hint', 'reveal_solution', 'record_score'])
      const enCtx = buildLiveLessonContext({
        courseId: SPRINGBOOT_COURSE_ID,
        day: 1,
        lang: 'en',
        scratchpad: 'CREATE TABLE todos (id bigint primary key);',
        dueReviewsCount: 2,
      })
      expect(enCtx).toContain('Day: 1 / 28')
      expect(enCtx).toContain('CREATE TABLE todos')
      expect(enCtx).toContain('Due Spaced Reviews: 2')
      expect(enCtx.length).toBeLessThanOrEqual(6500)

      const kmCtx = buildLiveLessonContext({
        courseId: SPRINGBOOT_COURSE_ID,
        day: 1,
        lang: 'km',
        scratchpad: 'x'.repeat(5000),
      })
      expect(kmCtx).toContain('Khmer (km)')
      expect(kmCtx.length).toBeLessThanOrEqual(6500)
    })
  })

  describe('Invocation broker integration', () => {
    let root: string
    let packages: ExtensionPackageStore
    let state: InvocationStateStore
    let hosts: NativeHostRegistry
    let broker: InvocationBroker
    let tutorStore: TutorStore

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'nd-tutor-broker-'))
      packages = new ExtensionPackageStore(root)
      state = new InvocationStateStore(root)
      hosts = new NativeHostRegistry()
      tutorStore = new TutorStore(join(root, 'progress.json'))

      hosts.register('tutor.progress.get', async (input) => {
        const courseId = typeof input.courseId === 'string' ? input.courseId : undefined
        return tutorStore.get(courseId)
      })
      hosts.register('tutor.progress.save', async (input) => {
        return tutorStore.saveProgress(input)
      })
      hosts.register('tutor.progress.reset', async (input) => {
        return tutorStore.reset(input)
      })
      hosts.register('clipboard.write', async (input) => {
        return { copied: input.text }
      })
      hosts.register('skill.compose', async (input) => {
        return { composed: input.request }
      })

      const org: NdOrganizationPort = {
        state: async () => ({ companies: [], projects: [], memory: [] }),
        policy: async () => 'allow',
      }
      broker = new InvocationBroker({ packages, state, host: hosts, organization: org })
      await packages.installFromDirectory(packagePath, { expectId: 'nd.tutor' })
      await state.setActivation('nd.tutor', personalContext(), true)
    })

    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    it('loads the web view metadata and executes actions through broker.invoke', async () => {
      const personal = personalContext()
      const view = await broker.loadView('nd.tutor', 'main', personal)
      expect(view).toMatchObject({ kind: 'web', extensionId: 'nd.tutor', viewId: 'main' })
      expect(view.webView?.entry).toBe('ui/index.html')

      const getRes = await broker.invoke({
        extensionId: 'nd.tutor',
        contributionId: 'main',
        contributionKind: 'view',
        context: personal,
        caller: 'user',
        input: { action: 'get-progress' },
      })

      expect(getRes.ok).toBe(true)
      if (getRes.ok) {
        const val = getRes.value as any
        expect(val.activeCourseId).toBe(SPRINGBOOT_COURSE_ID)
      }

      const saveRes = await broker.invoke({
        extensionId: 'nd.tutor',
        contributionId: 'main',
        contributionKind: 'view',
        context: personal,
        caller: 'user',
        input: {
          action: 'save-progress',
          day: 1,
          status: 'completed',
          score: 95,
          topic: 'What makes a database row valid?',
        },
      })

      expect(saveRes.ok).toBe(true)
      if (saveRes.ok) {
        const val = saveRes.value as any
        expect(val.courseProgress.days['1']?.status).toBe('completed')
        expect(val.courseProgress.days['1']?.score).toBe(95)
      }
    })
  })
})
