import { describe, expect, it, vi } from 'vitest'
import {
  ElectronPageDriver,
  guardExpression,
  pageGuardFromMessage,
  type IsolatedTabHost,
} from '../src/main/browser/page-driver.js'
import { assertLoopbackSocketUrl } from '../src/main/browser/visible-cdp-connection.js'

describe('PageDriver origin guard', () => {
  it('wraps expressions with origin guard check', () => {
    const wrapped = guardExpression('1 + 1', ['https://gemini.google.com'])
    expect(wrapped).toContain('allowed.includes(location.origin)')
    expect(wrapped).toContain('ND_WRONG_PAGE:')
    expect(wrapped).toContain('1 + 1')
  })

  it('detects and parses wrong-page guard error', () => {
    const guardErr = pageGuardFromMessage('Error: ND_WRONG_PAGE:https://evil.com')
    expect(guardErr).toBeDefined()
    expect(guardErr?.origin).toBe('https://evil.com')
    expect(guardErr?.code).toBe('wrong-page')
  })
})

describe('assertLoopbackSocketUrl', () => {
  it('accepts loopback ws endpoints on matching port', () => {
    expect(assertLoopbackSocketUrl('ws://127.0.0.1:9222/devtools/page/ABC', 9222))
      .toBe('ws://127.0.0.1:9222/devtools/page/ABC')
    expect(assertLoopbackSocketUrl('ws://localhost:9222/devtools/page/ABC', 9222))
      .toBe('ws://localhost:9222/devtools/page/ABC')
  })

  it('rejects remote IPs or non-devtools URLs', () => {
    expect(() => assertLoopbackSocketUrl('ws://192.168.1.5:9222/devtools/page/ABC', 9222))
      .toThrow(/not on ND's loopback endpoint/)
    expect(() => assertLoopbackSocketUrl('http://127.0.0.1:9222/devtools/page/ABC', 9222))
      .toThrow(/not on ND's loopback endpoint/)
    expect(() => assertLoopbackSocketUrl('ws://127.0.0.1:9222/other/path', 9222))
      .toThrow(/not on ND's loopback endpoint/)
    expect(() => assertLoopbackSocketUrl('ws://127.0.0.1:8080/devtools/page/ABC', 9222))
      .toThrow(/not on ND's loopback endpoint/)
  })
})

describe('ElectronPageDriver', () => {
  it('executes in isolated tab host and returns value', async () => {
    const host: IsolatedTabHost = {
      evaluateInTab: vi.fn(async () => ({ ok: true, value: 42 })),
      tabUrl: vi.fn(() => 'https://gemini.google.com/app'),
      screenshot: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,abc' })),
    }
    const driver = new ElectronPageDriver(host, 'tab-1', ['https://gemini.google.com'])
    const res = await driver.evaluate<number>('21 * 2')
    expect(res).toBe(42)
    expect(host.evaluateInTab).toHaveBeenCalledTimes(1)
  })

  it('fails with tab-closed error when tabUrl is undefined', async () => {
    const host: IsolatedTabHost = {
      evaluateInTab: vi.fn(async () => { throw new Error('Render frame destroyed') }),
      tabUrl: vi.fn(() => undefined),
      screenshot: vi.fn(async () => ({ dataUrl: '' })),
    }
    const driver = new ElectronPageDriver(host, 'tab-1', ['https://gemini.google.com'])
    await expect(driver.evaluate('1 + 1')).rejects.toThrow(/tab for this turn was closed/)
  })
})
