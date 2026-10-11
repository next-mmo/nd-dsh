import type { ReactNode } from 'react'
import type { BrowserState } from '../../../shared/contracts'
import { BrowserIcon, GridIcon, SparkIcon } from './Icons'
import { BrowserPane } from './BrowserPane'
import { SurfaceErrorBoundary } from './surface-error-boundary'
import { cn } from '../lib/utils'

/** The two full-size panes of the Personal space, mirroring the Agent workbench. */
export type PersonalPane = 'records' | 'browser'

interface PersonalSurfaceProps {
  /** True while the app is presenting Personal; the browser pane only owns the native view then. */
  active: boolean
  pane: PersonalPane
  onPaneChange(pane: PersonalPane): void
  /** The speed dial above the browser pane. Collapsed while a site has the pane. */
  dialpad: ReactNode
  dialpadOpen: boolean
  onDialpadOpenChange(open: boolean): void
  state: BrowserState | null
  onSnapshot(result: string): void
  onError(message: string): void
  onOpenSettings(): void
  children: ReactNode
}

const paneTabClasses = (active: boolean): string =>
  cn(
    'flex h-6 shrink-0 items-center gap-[5px] rounded-[5px] border border-transparent px-2.5 text-xs whitespace-nowrap transition-colors [&_svg]:size-3',
    active
      ? 'border-primary/20 bg-primary/[0.06] text-primary'
      : 'text-faint hover:bg-accent hover:text-muted-foreground',
  )

/**
 * The Personal space: ND Home records and the ND browser as two full-size panes
 * behind a pane strip, exactly like the Agent workbench's Files/Browser pair.
 *
 * Personal is a place you can be, so it carries its own surfaces. A Personal
 * extension (the Mini Browser, for example) opens its tabs in this browser pane
 * at full size — never squeezed into a company's or a project's workbench. The
 * browser profile is shared app-wide, so the pane is labeled with its context
 * instead of inheriting whatever company or project is active.
 */
export function PersonalSurface({
  active,
  pane,
  onPaneChange,
  dialpad,
  dialpadOpen,
  onDialpadOpenChange,
  state,
  onSnapshot,
  onError,
  onOpenSettings,
  children,
}: PersonalSurfaceProps): ReactNode {
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-[3px] border-b border-border-soft bg-secondary px-2 py-1" role="tablist" aria-label="Personal panes">
        <button className={paneTabClasses(pane === 'records')} onClick={() => onPaneChange('records')}>
          <SparkIcon />
          <span>Records</span>
        </button>
        <button className={paneTabClasses(pane === 'browser')} onClick={() => onPaneChange('browser')}>
          <BrowserIcon />
          <span>Browser</span>
        </button>
        <button
          className={paneTabClasses(pane === 'browser' && dialpadOpen)}
          aria-pressed={pane === 'browser' && dialpadOpen}
          title="Show your dialpad — top sites and your own links"
          onClick={() => {
            onPaneChange('browser')
            onDialpadOpenChange(!dialpadOpen)
          }}
        >
          <GridIcon />
          <span>Dialpad</span>
        </button>
        <span className="ml-1 truncate text-[10px] text-faint">
          {pane === 'browser' ? 'Personal browsing — your own, not company work' : 'Notes, captures, and chats'}
        </span>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <section
          aria-hidden={pane !== 'records'}
          className={cn('h-full w-full min-h-0 min-w-0 overflow-hidden', pane === 'records' ? 'block' : 'hidden')}
        >
          {children}
        </section>
        <section
          aria-hidden={pane !== 'browser'}
          role="region"
          aria-label="Personal browser"
          className={cn('h-full w-full min-h-0 min-w-0 overflow-hidden', pane === 'browser' ? 'flex flex-col' : 'hidden')}
        >
          {dialpadOpen ? dialpad : null}
          <SurfaceErrorBoundary label="Personal browser" resetKey={`personal-browser:${state?.url ?? ''}`} onError={onError}>
            <BrowserPane
              active={active && pane === 'browser'}
              state={state}
              onSnapshot={onSnapshot}
              onError={onError}
              onOpenSettings={onOpenSettings}
            />
          </SurfaceErrorBoundary>
        </section>
      </div>
    </div>
  )
}
