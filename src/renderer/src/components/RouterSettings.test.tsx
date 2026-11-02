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
})
