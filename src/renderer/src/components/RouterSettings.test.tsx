import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RouterSettings } from './RouterSettings'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RouterSettings UI', () => {
  it('renders Add provider button in the Providers section', () => {
    vi.stubGlobal('window', {
      ndDshRouter: {
        state: vi.fn().mockResolvedValue({
          endpoint: 'http://127.0.0.1:8326',
          providers: [],
          combos: [],
          counters: { requests: 0, ok: 0, failed: 0 },
        }),
        usage: vi.fn().mockResolvedValue({
          requests: 0,
          ok: 0,
          failed: 0,
          avgLatencyMs: 0,
          byProvider: {},
        }),
        agyPolicy: vi.fn().mockResolvedValue({
          policy: {
            enabled: false,
            manualApprovalRequired: true,
            maxConcurrentJobs: 1,
            maxJobsPerHour: 2,
            maxJobsPerDay: 10,
            maxTokensPerDay: 200000,
            approvalTtlSecs: 600,
            maxRetries: 0,
            maxTimeoutSecs: 300,
          },
          locked: false,
          window: { startMs: 0, jobs: 0, limit: 2 },
          day: { startMs: 0, jobs: 0, jobsLimit: 10, tokens: 0, tokensLimit: 200000 },
          pendingApprovals: 0,
        }),
        agyUsage: vi.fn().mockResolvedValue({
          state: {
            policy: {
              enabled: false,
              manualApprovalRequired: true,
              maxConcurrentJobs: 1,
              maxJobsPerHour: 2,
              maxJobsPerDay: 10,
              maxTokensPerDay: 200000,
              approvalTtlSecs: 600,
              maxRetries: 0,
              maxTimeoutSecs: 300,
            },
            locked: false,
            window: { startMs: 0, jobs: 0, limit: 2 },
            day: { startMs: 0, jobs: 0, jobsLimit: 10, tokens: 0, tokensLimit: 200000 },
            pendingApprovals: 0,
          },
          summary: { total: 0, ok: 0, failed: 0, byCategory: {} },
          recent: [],
        }),
        safeMode: vi.fn().mockResolvedValue(false),
      },
    })

    const html = renderToStaticMarkup(
      <RouterSettings
        onError={() => undefined}
        subTab="providers"
      />
    )

    // The Providers section header has the "Add provider" button
    expect(html).toContain('Add provider')
    expect(html).toContain('0 providers')
  })

  it('renders the Antigravity safety controls in the Overview section', () => {
    vi.stubGlobal('window', {
      ndDshRouter: {
        state: vi.fn().mockResolvedValue({ providers: [], combos: [], counters: { requests: 0, ok: 0, failed: 0 } }),
        usage: vi.fn().mockResolvedValue({ requests: 0, ok: 0, failed: 0, avgLatencyMs: 0, byProvider: {} }),
        agyPolicy: vi.fn().mockResolvedValue(null),
        agyUsage: vi.fn().mockResolvedValue(null),
        safeMode: vi.fn().mockResolvedValue(false),
      },
    })

    const html = renderToStaticMarkup(<RouterSettings onError={() => undefined} subTab="overview" />)

    expect(html).toContain('Antigravity safety')
    expect(html).toContain('Consumer CLI lane')
    expect(html).toContain('Approve the next AGY request')
    expect(html).toContain('do not guarantee Google account safety')
  })

  it('renders sub-tabs with Playground but without External API in the navigation bar', () => {
    vi.stubGlobal('window', {
      ndDshRouter: {
        state: vi.fn().mockResolvedValue({ providers: [], combos: [], counters: { requests: 0, ok: 0, failed: 0 } }),
        usage: vi.fn().mockResolvedValue({ requests: 0, ok: 0, failed: 0, avgLatencyMs: 0, byProvider: {} }),
        agyPolicy: vi.fn().mockResolvedValue(null),
        agyUsage: vi.fn().mockResolvedValue(null),
        safeMode: vi.fn().mockResolvedValue(false),
      },
    })

    const html = renderToStaticMarkup(<RouterSettings onError={() => undefined} subTab="overview" />)

    // The nav should include Playground but NOT External API tab
    expect(html).toContain('Playground')
    expect(html).toContain('Providers')
    expect(html).toContain('Routes')
    expect(html).toContain('9Router')
    expect(html).toContain('Usage')

    // Inside the nav bar tab list, External API should not be present as a tab
    const navMatch = html.match(/<nav[^>]*role="tablist"[^>]*>([\s\S]*?)<\/nav>/)
    expect(navMatch).not.toBeNull()
    const navContent = navMatch ? navMatch[1] : ''
    expect(navContent).toContain('Playground')
    expect(navContent).not.toContain('External API')
  })
})
