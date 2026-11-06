import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RouterCurlDialog } from './RouterCurlDialog'
import { ProcessLogsDrawer } from './ProcessLogsDrawer'

vi.mock('./ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogContent: ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={className}>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogClose: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RouterCurlDialog', () => {
  it('renders nothing when closed', () => {
    const html = renderToStaticMarkup(
      <RouterCurlDialog
        open={false}
        onClose={() => undefined}
        route="model:provider-123/gpt-4"
      />
    )
    expect(html).toBe('')
  })

  it('renders cURL dialog content with model name and loopback endpoint when open', () => {
    vi.stubGlobal('window', {
      ndDshRouter: {
        revealExternalKey: vi.fn().mockResolvedValue({
          endpoint: 'http://127.0.0.1:4000',
          key: 'ndr_ext_test_secret_key_123',
          persisted: true,
          safeMode: false,
        }),
      },
    })

    const html = renderToStaticMarkup(
      <RouterCurlDialog
        open={true}
        onClose={() => undefined}
        route="model:provider-3ca3f0c87399/default"
        endpoint="http://127.0.0.1:4000"
      />
    )

    expect(html).toContain('Playground Model cURL')
    expect(html).toContain('provider-3ca3f0c87399/default')
    expect(html).toContain('/v1/chat/completions')
    expect(html).toContain('curl http://127.0.0.1:4000/v1/chat/completions')
    expect(html).toContain('Copy cURL')
  })

  it('formats combo route correctly as model in cURL body', () => {
    const html = renderToStaticMarkup(
      <RouterCurlDialog
        open={true}
        onClose={() => undefined}
        route="combo:code-fast"
        endpoint="http://127.0.0.1:8326"
        currentPrompt="Write a hello world"
      />
    )

    expect(html).toContain('code-fast')
    expect(html).toContain('Write a hello world')
    expect(html).toContain('http://127.0.0.1:8326/v1/chat/completions')
    expect(html).toContain('Combo Route')
  })

  it('formats edge-tts route as /v1/audio/speech with voice and --output speech.mp3', () => {
    const html = renderToStaticMarkup(
      <RouterCurlDialog
        open={true}
        onClose={() => undefined}
        route="model:edge-tts/en-US-AriaNeural"
        endpoint="http://127.0.0.1:3130"
        currentPrompt="Hello Edge TTS"
      />
    )

    expect(html).toContain('TTS Audio Route')
    expect(html).toContain('http://127.0.0.1:3130/v1/audio/speech')
    expect(html).toContain('en-US-AriaNeural')
    expect(html).toContain('Hello Edge TTS')
    expect(html).toContain('--output speech.mp3')
  })
})

describe('ProcessLogsDrawer cURL button', () => {
  it('renders cURL button in the filter bar when onOpenCurl is provided', () => {
    const onOpenCurl = vi.fn()
    const html = renderToStaticMarkup(
      <ProcessLogsDrawer
        open={true}
        onClose={() => undefined}
        logs={[]}
        onClear={() => undefined}
        title="Playground Logs"
        subtitle="model:provider-3ca3f0c87399/default"
        onOpenCurl={onOpenCurl}
      />
    )

    expect(html).toContain('Playground Logs')
    expect(html).toContain('model:provider-3ca3f0c87399/default')
    expect(html).toContain('aria-label="View and copy cURL command"')
    expect(html).toContain('cURL')
  })

  it('does not render cURL button when onOpenCurl is omitted', () => {
    const html = renderToStaticMarkup(
      <ProcessLogsDrawer
        open={true}
        onClose={() => undefined}
        logs={[]}
        onClear={() => undefined}
        title="Process Logs"
      />
    )

    expect(html).not.toContain('aria-label="View and copy cURL command"')
  })
})
