import { describe, expect, it } from 'vitest'
import { filterSessionsInProjectScope, isSessionInProjectScope, PERSONAL_PROJECT_ID } from '../src/shared/session-project-scope.js'

const sessionProjects = {
  'sess-plan-dfdf': 'project-dfdf',
  'sess-review-dfdf': 'project-dfdf',
  'sess-plan-ndf': 'project-ndf',
  'sess-engine-ndf': 'project-ndf',
  'sess-explicit-personal': PERSONAL_PROJECT_ID,
}

function session(sessionId: string, parentSessionId?: string, origin: 'subagent' | undefined = parentSessionId ? 'subagent' : undefined): { sessionId: string; parentSessionId?: string; origin?: 'subagent' } {
  return { sessionId, ...(parentSessionId ? { parentSessionId } : {}), ...(origin ? { origin } : {}) }
}

describe('isSessionInProjectScope', () => {
  it('shows everything when no project is active (standalone workspace)', () => {
    expect(isSessionInProjectScope('sess-plan-ndf', undefined, sessionProjects)).toBe(true)
    expect(isSessionInProjectScope('sess-personal', undefined, sessionProjects)).toBe(true)
  })

  it('scopes to Personal project: shows personal and unassigned chats, hides company project chats', () => {
    expect(isSessionInProjectScope('sess-explicit-personal', PERSONAL_PROJECT_ID, sessionProjects)).toBe(true)
    expect(isSessionInProjectScope('sess-personal', PERSONAL_PROJECT_ID, sessionProjects)).toBe(true)
    expect(isSessionInProjectScope('sess-plan-dfdf', PERSONAL_PROJECT_ID, sessionProjects)).toBe(false)
    expect(isSessionInProjectScope('sess-plan-ndf', PERSONAL_PROJECT_ID, sessionProjects)).toBe(false)
  })

  it('keeps sessions that belong to the active company project', () => {
    expect(isSessionInProjectScope('sess-review-dfdf', 'project-dfdf', sessionProjects)).toBe(true)
  })

  it('hides sessions attributed to another company project or personal', () => {
    expect(isSessionInProjectScope('sess-plan-ndf', 'project-dfdf', sessionProjects)).toBe(false)
    expect(isSessionInProjectScope('sess-explicit-personal', 'project-dfdf', sessionProjects)).toBe(false)
    expect(isSessionInProjectScope('sess-personal', 'project-dfdf', sessionProjects)).toBe(false)
  })
})

describe('filterSessionsInProjectScope', () => {
  it('filters listings strictly down to the active company project without personal leakage', () => {
    const items = ['sess-plan-dfdf', 'sess-personal', 'sess-plan-ndf', 'sess-engine-ndf', 'sess-explicit-personal'].map((sessionId) => session(sessionId))
    expect(filterSessionsInProjectScope(items, 'project-dfdf', sessionProjects).map((item) => item.sessionId)).toEqual([
      'sess-plan-dfdf',
    ])
  })

  it('filters listings to Personal project: includes personal and unassigned, excludes company project chats', () => {
    const items = ['sess-plan-dfdf', 'sess-personal', 'sess-plan-ndf', 'sess-explicit-personal'].map((sessionId) => session(sessionId))
    expect(filterSessionsInProjectScope(items, PERSONAL_PROJECT_ID, sessionProjects).map((item) => item.sessionId)).toEqual([
      'sess-personal',
      'sess-explicit-personal',
    ])
  })

  it('inherits project attribution for nested subagent sessions from their parent chain', () => {
    const items = [
      session('sess-plan-dfdf'),
      session('sess-child-dfdf', 'sess-plan-dfdf'),
      session('sess-grandchild-dfdf', 'sess-child-dfdf'),
      session('sess-plan-ndf'),
      session('sess-child-ndf', 'sess-plan-ndf'),
    ]
    expect(filterSessionsInProjectScope(items, 'project-dfdf', sessionProjects).map((item) => item.sessionId)).toEqual([
      'sess-plan-dfdf',
      'sess-child-dfdf',
      'sess-grandchild-dfdf',
    ])
  })

  it('returns the full listing unchanged when no project is active', () => {
    const items = ['sess-plan-dfdf', 'sess-plan-ndf'].map((sessionId) => session(sessionId))
    expect(filterSessionsInProjectScope(items, undefined, sessionProjects)).toEqual(items)
  })
})

