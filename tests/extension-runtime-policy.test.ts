import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BACKGROUND_EXTENSION_IDS,
  extensionOpensFullscreen,
  extensionRunsInBackground,
  normalizeExtensionRuntimePolicy,
  setBackgroundExtension,
  setExtensionFullscreen,
} from '../src/shared/extension-runtime-policy.js'

describe('profile-owned runtime budgets', () => {
  it('defaults to no explicit choices with bounded view/idle limits', () => {
    expect(normalizeExtensionRuntimePolicy(undefined)).toEqual({
      backgroundExtensionIds: [],
      backgroundDisabledExtensionIds: [],
      fullscreenDisabledExtensionIds: [],
      maxBackgroundViews: 4,
      idleTimeoutMinutes: 5,
    })
  })
  it('bounds invalid numeric values and deduplicates both choice lists', () => {
    expect(normalizeExtensionRuntimePolicy({
      backgroundExtensionIds: ['nd.one', 'nd.one', '../bad'],
      backgroundDisabledExtensionIds: ['nd.two', 'nd.two', '../bad'],
      fullscreenDisabledExtensionIds: ['nd.three', 'nd.three', '../bad'],
      maxBackgroundViews: 999,
      idleTimeoutMinutes: -5,
    })).toEqual({
      backgroundExtensionIds: ['nd.one'],
      backgroundDisabledExtensionIds: ['nd.two'],
      fullscreenDisabledExtensionIds: ['nd.three'],
      maxBackgroundViews: 16,
      idleTimeoutMinutes: 1,
    })
    expect(normalizeExtensionRuntimePolicy({ maxBackgroundViews: NaN }).maxBackgroundViews).toBe(4)
  })
})

describe('background run permission', () => {
  const policy = normalizeExtensionRuntimePolicy(undefined)

  it('keeps an ordinary extension off until the user asks for it', () => {
    expect(extensionRunsInBackground(policy, 'nd.tic-tac-toe')).toBe(false)
  })

  it('keeps ND live audio extensions on by default', () => {
    expect(DEFAULT_BACKGROUND_EXTENSION_IDS).toContain('nd.phone-audio')
    for (const id of DEFAULT_BACKGROUND_EXTENSION_IDS) expect(extensionRunsInBackground(policy, id)).toBe(true)
  })

  it('remembers an opt-out of an ND default across a reload', () => {
    const off = setBackgroundExtension(policy, 'nd.phone-audio', false)
    expect(extensionRunsInBackground(off, 'nd.phone-audio')).toBe(false)
    expect(extensionRunsInBackground(normalizeExtensionRuntimePolicy(off), 'nd.phone-audio')).toBe(false)
  })

  it('remembers an opt-in for an extension that is off by default', () => {
    const on = setBackgroundExtension(policy, 'nd.tic-tac-toe', true)
    expect(extensionRunsInBackground(on, 'nd.tic-tac-toe')).toBe(true)
    expect(extensionRunsInBackground(normalizeExtensionRuntimePolicy(on), 'nd.tic-tac-toe')).toBe(true)
  })

  it('lets the latest choice win in either direction', () => {
    const backOn = setBackgroundExtension(setBackgroundExtension(policy, 'nd.phone-audio', false), 'nd.phone-audio', true)
    expect(extensionRunsInBackground(backOn, 'nd.phone-audio')).toBe(true)
    expect(backOn.backgroundDisabledExtensionIds).toEqual([])
    const backOff = setBackgroundExtension(setBackgroundExtension(policy, 'nd.tic-tac-toe', true), 'nd.tic-tac-toe', false)
    expect(extensionRunsInBackground(backOff, 'nd.tic-tac-toe')).toBe(false)
    expect(backOff.backgroundExtensionIds).toEqual([])
  })

  it('leaves other extensions untouched when one is toggled', () => {
    const next = setBackgroundExtension(policy, 'nd.tic-tac-toe', true)
    expect(extensionRunsInBackground(next, 'nd.phone-audio')).toBe(true)
    expect(extensionRunsInBackground(next, 'nd.mini-browser')).toBe(false)
  })
})

describe('full-screen presentation default', () => {
  const policy = normalizeExtensionRuntimePolicy(undefined)

  it('opens every extension full screen until the user chooses windowed', () => {
    expect(extensionOpensFullscreen(policy, 'nd.tic-tac-toe')).toBe(true)
    expect(extensionOpensFullscreen(policy, 'nd.phone-audio')).toBe(true)
  })

  it('remembers a windowed choice across a reload, per extension', () => {
    const windowed = setExtensionFullscreen(policy, 'nd.disk-cleaner', false)
    expect(extensionOpensFullscreen(windowed, 'nd.disk-cleaner')).toBe(false)
    expect(extensionOpensFullscreen(normalizeExtensionRuntimePolicy(windowed), 'nd.disk-cleaner')).toBe(false)
    expect(extensionOpensFullscreen(windowed, 'nd.tutor')).toBe(true)
  })

  it('returns to full screen without disturbing background choices', () => {
    const mixed = setBackgroundExtension(setExtensionFullscreen(policy, 'nd.disk-cleaner', false), 'nd.disk-cleaner', true)
    const restored = setExtensionFullscreen(mixed, 'nd.disk-cleaner', true)
    expect(extensionOpensFullscreen(restored, 'nd.disk-cleaner')).toBe(true)
    expect(restored.fullscreenDisabledExtensionIds).toEqual([])
    expect(extensionRunsInBackground(restored, 'nd.disk-cleaner')).toBe(true)
  })
})