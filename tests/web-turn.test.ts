import { describe, expect, it } from 'vitest'
import {
  canSwitchTransport,
  planWebTransports,
  WebTurnError,
  WebTurnProgress,
} from '../src/main/engines/web-turn.js'
import type { WebBrowserModeSettings } from '../src/shared/browser-modes.js'

describe('WebTurn planWebTransports', () => {
  const baseSettings: WebBrowserModeSettings = {
    mode: 'auto',
    agentFallback: false,
    visualRecovery: true,
  }

  it('orders extension then cdp for text turns in auto mode', () => {
    const plan = planWebTransports({
      settings: baseSettings,
      hasImages: false,
      available: { extension: true, cdp: true, browserAgent: true },
    })
    expect(plan.transports).toEqual(['extension', 'cdp'])
  })

  it('orders cdp first for image turns in auto mode', () => {
    const plan = planWebTransports({
      settings: baseSettings,
      hasImages: true,
      available: { extension: true, cdp: true, browserAgent: true },
    })
    expect(plan.transports).toEqual(['cdp', 'extension'])
  })

  it('includes browser-agent when agentFallback is enabled in auto mode', () => {
    const plan = planWebTransports({
      settings: { ...baseSettings, agentFallback: true },
      hasImages: false,
      available: { extension: true, cdp: true, browserAgent: true },
    })
    expect(plan.transports).toEqual(['extension', 'cdp', 'browser-agent'])
  })

  it('returns only the explicit mode when selected', () => {
    expect(planWebTransports({
      settings: { ...baseSettings, mode: 'cdp' },
      hasImages: false,
      available: { extension: true, cdp: true, browserAgent: true },
    }).transports).toEqual(['cdp'])

    expect(planWebTransports({
      settings: { ...baseSettings, mode: 'extension' },
      hasImages: true,
      available: { extension: true, cdp: true, browserAgent: true },
    }).transports).toEqual(['extension'])

    expect(planWebTransports({
      settings: { ...baseSettings, mode: 'browser-agent' },
      hasImages: false,
      available: { extension: true, cdp: true, browserAgent: true },
    }).transports).toEqual(['browser-agent'])
  })

  it('filters out unavailable transports and notes skipped reasons', () => {
    const plan = planWebTransports({
      settings: baseSettings,
      hasImages: false,
      available: { extension: false, cdp: true, browserAgent: true },
    })
    expect(plan.transports).toEqual(['cdp'])
    expect(plan.skipped).toEqual([
      { transport: 'browser-agent', reason: 'agent fallback disabled' },
      { transport: 'extension', reason: 'unavailable' },
    ])
  })
})

describe('WebTurn error classification and transport switching rules', () => {
  it('allows switching transport only when submission is none and error is a transport failure', () => {
    const progress = new WebTurnProgress('extension')
    progress.enter('open')

    const transportErr = progress.fail('transport-unavailable', 'Socket disconnected')
    expect(canSwitchTransport(transportErr)).toBe(true)

    const notSubmitted = progress.fail('not-submitted', 'Send button disabled')
    expect(canSwitchTransport(notSubmitted)).toBe(true)

    const layoutChanged = progress.fail('layout-changed', 'Composer missing')
    expect(canSwitchTransport(layoutChanged)).toBe(true)
  })

  it('NEVER allows switching transport for stop conditions', () => {
    const progress = new WebTurnProgress('extension')
    progress.enter('open')

    expect(canSwitchTransport(progress.fail('login-required', 'Sign in required'))).toBe(false)
    expect(canSwitchTransport(progress.fail('challenge', 'CAPTCHA challenge'))).toBe(false)
    expect(canSwitchTransport(progress.fail('rate-limited', 'Rate limit exceeded'))).toBe(false)
    expect(canSwitchTransport(progress.fail('page-busy', 'Gemini is still replying'))).toBe(false)
    expect(canSwitchTransport(progress.fail('wrong-page', 'User navigated away'))).toBe(false)
    expect(canSwitchTransport(progress.fail('cancelled', 'Turn cancelled'))).toBe(false)
  })

  it('NEVER allows switching transport when submission is uncertain or confirmed', () => {
    const progress = new WebTurnProgress('cdp')
    progress.enter('submit')
    progress.submission = 'uncertain'

    const err = progress.fail('submission-uncertain', 'CDP timed out while waiting for assistant')
    expect(canSwitchTransport(err)).toBe(false)

    progress.submission = 'confirmed'
    const errConfirmed = progress.fail('timeout', 'Turn timed out')
    expect(canSwitchTransport(errConfirmed)).toBe(false)
  })

  it('classifies unhandled exceptions as uncertain if enter submit occurred', () => {
    const progress = new WebTurnProgress('cdp')
    progress.enter('submit')
    progress.submission = 'uncertain'

    const classified = progress.classify(new Error('Connection reset by peer'))
    expect(classified.code).toBe('submission-uncertain')
    expect(classified.submission).toBe('uncertain')
    expect(canSwitchTransport(classified)).toBe(false)
  })
})
