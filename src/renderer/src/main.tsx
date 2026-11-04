import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'

// Apply a best-effort system theme before the preload-backed theme service
// returns the user's persisted preference.
const initialTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
document.documentElement.dataset.theme = initialTheme
document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', initialTheme)
const root = ReactDOM.createRoot(document.getElementById('root')!)

function RuntimeUnavailable() {
  return (
    <main className="grid min-h-screen place-items-center p-8">
      <section className="max-w-[620px]">
        <small className="text-[11px] tracking-[0.12em] text-faint">ND-DSH · DESKTOP RUNTIME REQUIRED</small>
        <h1 className="mb-2 mt-2 text-2xl font-bold text-strong">ND runtime unavailable</h1>
        <p className="my-2 text-sm/[1.6] text-muted-foreground">
          This product shell requires the trusted Electron preload and organization runtime.
          ND-DSH no longer substitutes demo companies, fake workspaces, or mock agent sessions.
        </p>
        <p className="my-2 text-sm/[1.6] text-muted-foreground">Launch the ND-DSH desktop application or run the desktop development target.</p>
      </section>
    </main>
  )
}

function RuntimeFailure({ message }: { message: string }) {
  return (
    <main className="grid min-h-screen place-items-center p-8">
      <section className="max-w-[620px]" role="alert">
        <small className="text-[11px] tracking-[0.12em] text-destructive">ND-DSH · RENDERER ERROR</small>
        <h1 className="mb-2 mt-2 text-2xl font-bold text-strong">ND could not finish loading</h1>
        <p className="my-2 text-sm/[1.6] text-muted-foreground">
          Restart the desktop application. If this continues, include the message below with the beta report.
        </p>
        <pre className="mt-3 overflow-auto rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{message}</pre>
      </section>
    </main>
  )
}

class RendererErrorBoundary extends React.Component<React.PropsWithChildren, { message?: string }> {
  state: { message?: string } = {}

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown): void {
    console.error('ND renderer failed:', error)
  }

  render(): React.ReactNode {
    return this.state.message ? <RuntimeFailure message={this.state.message} /> : this.props.children
  }
}

async function boot(): Promise<void> {
  if (
    import.meta.env.DEV
    && (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '[::1]')
    && (typeof window.ndDsh === 'undefined' || typeof window.ndDshOrganization === 'undefined' || typeof window.ndDshExtensions === 'undefined')
  ) {
    // Vite serves these modules only from its development source graph. The
    // ignored runtime URLs keep preview fixtures out of production bundles.
    const previewModuleUrl = '/src/ui-preview.ts'
    const { installDevelopmentUiPreview } = await import(/* @vite-ignore */ previewModuleUrl) as typeof import('./ui-preview')
    installDevelopmentUiPreview()
    const extensionPreviewModuleUrl = '/src/ui-preview-extensions.ts'
    const { installDevelopmentExtensionPreview } = await import(/* @vite-ignore */ extensionPreviewModuleUrl) as typeof import('./ui-preview-extensions')
    installDevelopmentExtensionPreview()
  }
  if (typeof window.ndDsh === 'undefined' || typeof window.ndDshOrganization === 'undefined' || typeof window.ndDshExtensions === 'undefined') {
    root.render(<RuntimeUnavailable />)
    return
  }

  const isLauncher = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] === 'launcher'
  const RootView = isLauncher
    ? (await import('./LauncherPopupApp')).default
    : (await import('./App')).default

  root.render(
    <React.StrictMode>
      <RendererErrorBoundary>
        <RootView />
      </RendererErrorBoundary>
    </React.StrictMode>,
  )
}

void boot().catch((cause) => {
  const message = cause instanceof Error ? cause.message : String(cause)
  console.error('ND renderer boot failed:', cause)
  root.render(<RuntimeFailure message={message} />)
})
