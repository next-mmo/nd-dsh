import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NineRouterSettings } from './NineRouterSettings'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('NineRouterSettings UI', () => {
  it('drops install buttons and renders Set up in Extensions CTA when uninstalled', () => {
    vi.stubGlobal('window', {
      ndDshRouter: {
        nineRouterState: vi.fn().mockResolvedValue({
          installed: false,
          running: false,
          managed: true,
          trusted: false,
          signingKeyConfigured: false,
        }),
        state: vi.fn().mockResolvedValue({ providers: [], combos: [] }),
      },
    })

    const onNavigate = vi.fn()
    const html = renderToStaticMarkup(
      <NineRouterSettings
        onError={() => undefined}
        onNavigateToExtensions={onNavigate}
      />
    )

    // Install buttons are dropped from ND Router
    expect(html).not.toContain('Install signed 9Router')
    expect(html).not.toContain('Import local (unverified)')
    expect(html).not.toContain('Set initial password')

    // CTA to set up in extensions is rendered
    expect(html).toContain('Set up in Extensions')
    expect(html).toContain('Not installed')
    expect(html).toContain('Start')
    expect(html).toContain('Stop')
  })
})
