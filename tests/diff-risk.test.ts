import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assessDiffRisk,
  canAutoProceedWithRisk,
  parseGitNumstat,
  validateDiffRiskSelfReview,
} from '../src/shared/diff-risk.js'
import type { OrganizationSnapshot } from '../src/shared/organization.js'
import { OrganizationControlPlane } from '../src/main/organization/control-plane.js'

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('deterministic diff risk floor', () => {
  it('allows low risk only for narrow, small, exact doc/style/test diffs', () => {
    const risk = assessDiffRisk({
      files: ['docs/guide.md', 'src/styles/app.css', 'tests/sample.test.ts'],
      changedLines: 42,
      binary: false,
      fingerprint: 'fp-1',
      exact: true,
    })
    expect(risk.floor).toBe(1)
    expect(risk.score).toBe(1)
    expect(risk.level).toBe('low')
    expect(risk.requiresHumanReview).toBe(false)
    expect(risk.safeguards).toEqual([])
    expect(canAutoProceedWithRisk({
      risk,
      currentFingerprint: 'fp-1',
      verificationPassed: true,
      verificationFingerprint: 'fp-1',
    })).toBe(true)
  })

  it('prevents an agent self-review from lowering risk below the deterministic floor', () => {
    const risk = assessDiffRisk(
      {
        files: ['src/main/auth/oauth-client.ts'],
        changedLines: 12,
        binary: false,
        fingerprint: 'fp-auth',
        exact: true,
      },
      { score: 1, requiresHumanReview: false, reason: 'Tiny tweak' },
    )
    expect(risk.floor).toBeGreaterThanOrEqual(7)
    expect(risk.score).toBe(risk.floor)
    expect(risk.agentScore).toBe(1)
    expect(risk.level).toBe('high')
    expect(risk.requiresHumanReview).toBe(true)
    expect(canAutoProceedWithRisk({
      risk,
      currentFingerprint: 'fp-auth',
      verificationPassed: true,
    })).toBe(false)
  })

  it('allows an agent self-review to raise risk above the deterministic floor', () => {
    const risk = assessDiffRisk(
      {
        files: ['docs/release-notes.md'],
        changedLines: 10,
        fingerprint: 'fp-doc',
        exact: true,
      },
      { score: 6, requiresHumanReview: true, reason: 'Public breaking-change announcement needs product sign-off', factors: ['external-comms'] },
    )
    expect(risk.floor).toBe(1)
    expect(risk.score).toBe(6)
    expect(risk.level).toBe('high')
    expect(risk.requiresHumanReview).toBe(true)
    expect(risk.factors).toEqual(['external-comms'])
  })

  it('raises the floor for executable code, large diffs, binaries, and inexact fingerprints', () => {
    const appCode = assessDiffRisk({ files: ['src/app.ts'], changedLines: 15, fingerprint: 'fp-a', exact: true })
    expect(appCode.floor).toBe(4)
    expect(appCode.level).toBe('medium')

    const large = assessDiffRisk({ files: ['docs/a.md'], changedLines: 320, fingerprint: 'fp-b', exact: true })
    expect(large.floor).toBe(6)
    expect(large.level).toBe('high')

    const binary = assessDiffRisk({ files: ['assets/icon.png'], binary: true, fingerprint: 'fp-c', exact: true })
    expect(binary.floor).toBe(7)

    const inexact = assessDiffRisk({ files: ['docs/readme.md'], fingerprint: 'fp-d', exact: false })
    expect(inexact.floor).toBe(8)
    expect(inexact.requiresHumanReview).toBe(true)

    const missingSelfReview = assessDiffRisk(
      { files: ['docs/readme.md'], changedLines: 5, fingerprint: 'fp-e', exact: true },
      undefined,
      { requireSelfReview: true },
    )
    expect(missingSelfReview.score).toBe(10)
    expect(missingSelfReview.requiresHumanReview).toBe(true)
  })

  it('invalidates auto-proceed when the workspace or verification fingerprint drifts', () => {
    const risk = assessDiffRisk({
      files: ['docs/notes.md'],
      changedLines: 8,
      fingerprint: 'fp-original',
      exact: true,
    })
    expect(canAutoProceedWithRisk({
      risk,
      currentFingerprint: 'fp-changed',
      verificationPassed: true,
      verificationFingerprint: 'fp-changed',
    })).toBe(false)
    expect(canAutoProceedWithRisk({
      risk,
      currentFingerprint: 'fp-original',
      verificationPassed: true,
      verificationFingerprint: 'fp-older',
    })).toBe(false)
    expect(canAutoProceedWithRisk({
      risk,
      currentFingerprint: 'fp-original',
      verificationPassed: false,
      verificationFingerprint: 'fp-original',
    })).toBe(false)
  })

  it('parses git numstat output and validates self-review payloads', () => {
    expect(parseGitNumstat('12\t4\tsrc/a.ts\0-\t-\tassets/logo.png\0')).toEqual({
      changedLines: 16,
      binary: true,
    })
    expect(parseGitNumstat('5\t3\tdocs/a.md\n10\t0\tdocs/b.md\n')).toEqual({
      changedLines: 18,
      binary: false,
    })
    expect(validateDiffRiskSelfReview({ score: 3, requiresHumanReview: false, reason: 'Scoped UI tweak' })).toEqual({
      score: 3,
      requiresHumanReview: false,
      reason: 'Scoped UI tweak',
    })
    expect(validateDiffRiskSelfReview({ score: 0, requiresHumanReview: false, reason: 'Invalid score' })).toBeUndefined()
    expect(validateDiffRiskSelfReview({ score: 4, requiresHumanReview: 'yes', reason: 'Wrong bool' })).toBeUndefined()
    expect(validateDiffRiskSelfReview({ score: 4, requiresHumanReview: false, reason: '   ' })).toBeUndefined()
  })

  it('attaches deterministic diff risk to control-plane evidence receipts and preserves fingerprint binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nd-diff-risk-'))
    tempDirs.push(root)
    const now = Date.now()
    const snapshot: OrganizationSnapshot = {
      version: 1,
      activeCompanyId: 'company-1',
      activeProjectId: 'project-1',
      companies: [{ id: 'company-1', name: 'Acme', mission: 'Verify safely', autonomyLevel: 4, status: 'active', createdAt: now, updatedAt: now }],
      projects: [{ id: 'project-1', companyId: 'company-1', name: 'App', objective: 'Ship', workspacePath: root, status: 'active', repoUrls: [], teamIds: [], progress: 0, createdAt: now, updatedAt: now }],
      roles: [], teams: [], agents: [], skills: [], workflows: [], goals: [], milestones: [],
      tasks: [{
        id: 'task-1', companyId: 'company-1', projectId: 'project-1', title: 'Update OAuth callback',
        description: 'Adjust callback', status: 'review', priority: 'high', acceptanceCriteria: [], dependsOn: [], createdAt: now, updatedAt: now,
      }],
      memory: [], policies: [], activity: [],
      runs: [{
        id: 'run-review-1', companyId: 'company-1', projectId: 'project-1', taskId: 'task-1',
        kind: 'task-review', status: 'running', sessionId: 'sess-review-1', startedAt: now,
      }],
      coordination: [],
    }
    const store = {
      state: async () => structuredClone(snapshot),
      taskContext: async () => ({
        company: snapshot.companies[0]!,
        project: snapshot.projects[0]!,
        task: snapshot.tasks[0]!,
        role: undefined, agent: undefined, skills: [], memory: [], policies: [],
      }),
    }
    let currentFingerprint = 'fp-review-1'
    const control = new OrganizationControlPlane(
      join(root, 'control.json'),
      store as never,
      undefined,
      async () => ({
        fingerprint: currentFingerprint,
        exact: true,
        source: 'git',
        changedFiles: ['src/main/auth/session.ts'],
        gitHead: 'abc123',
        capturedAt: Date.now(),
      }),
    )

    await control.noteDispatch({ runId: 'run-review-1', sessionId: 'sess-review-1', projectId: 'project-1', taskId: 'task-1', kind: 'task-review' })
    const initial = (await control.state()).evidence[0]
    expect(initial?.risk?.level).toBe('high')
    expect(initial?.risk?.floor).toBe(7)
    expect(initial?.risk?.fingerprint).toBe('fp-review-1')

    const updated = await control.recordEvidenceRisk('task-1', { score: 2, requiresHumanReview: false, reason: 'Small change' }, { changedLines: 24 })
    expect(updated?.risk?.agentScore).toBe(2)
    expect(updated?.risk?.score).toBe(7)
    expect(updated?.risk?.changedLines).toBe(24)

    currentFingerprint = 'fp-mutated-after-review'
    const verified = await control.verifyEvidence('task-1')
    expect(verified?.status).toBe('stale')
    expect(verified?.risk?.fingerprint).toBe('fp-mutated-after-review')
  })
})
