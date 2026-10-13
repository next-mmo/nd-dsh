import { describe, expect, it } from 'vitest'
import { normalizeExtensionRuntimePolicy } from '../src/shared/extension-runtime-policy.js'

describe('profile-owned runtime budgets', () => {
  it('defaults to no background execution with bounded view/idle limits', () => {
    expect(normalizeExtensionRuntimePolicy(undefined)).toEqual({ backgroundExtensionIds: [], maxBackgroundViews: 4, idleTimeoutMinutes: 5 })
  })
  it('bounds invalid numeric values and deduplicates package opt-ins', () => {
    expect(normalizeExtensionRuntimePolicy({ backgroundExtensionIds: ['nd.one', 'nd.one', '../bad'], maxBackgroundViews: 999, idleTimeoutMinutes: -5 }))
      .toEqual({ backgroundExtensionIds: ['nd.one'], maxBackgroundViews: 16, idleTimeoutMinutes: 1 })
    expect(normalizeExtensionRuntimePolicy({ maxBackgroundViews: NaN }).maxBackgroundViews).toBe(4)
  })
})
