import type { ReactNode } from 'react'
import type { NdHomeLinkView } from '../../../shared/nd-invocations'
import { dialpadTiles, type DialpadTile } from '../../../shared/personal-dialpad'
import { cn } from '../lib/utils'

interface PersonalDialpadProps {
  links: NdHomeLinkView[]
  /** Address of the tab the pane is showing, offered as "save this site". */
  currentUrl?: string | undefined
  busy?: boolean | undefined
  onOpen(url: string): void
  onSaveCurrent(): void
  onRemoveLink(id: string): void
  onError(message: string): void
}

const TILE_TINTS = [
  'bg-primary/12 text-primary',
  'bg-warning/15 text-warning',
  'bg-info/15 text-info',
  'bg-destructive/12 text-destructive',
]

/** Stable tint per site, so a tile keeps its colour between sessions. */
function tileTint(seed: string): string {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) % 997
  return TILE_TINTS[hash % TILE_TINTS.length] ?? TILE_TINTS[0]!
}

function isSavable(url: string | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url)
}

/**
 * The Personal browser's speed dial: ND's top sites plus the user's own links.
 *
 * It is the pane's new-tab surface, so it opens the site in a real ND browser
 * tab and gets out of the way — the same "the chrome hides itself while you
 * browse" behaviour the Mini Browser package uses. Everything here is Personal:
 * saving a link writes to ND-managed personal storage, never to a company or a
 * project record.
 */
export function PersonalDialpad({
  links,
  currentUrl,
  busy,
  onOpen,
  onSaveCurrent,
  onRemoveLink,
  onError,
}: PersonalDialpadProps): ReactNode {
  const tiles = dialpadTiles(links)
  const saved = tiles.filter((tile) => tile.kind === 'saved')
  const sites = tiles.filter((tile) => tile.kind === 'site')
  const savedAddresses = new Set(saved.map((tile) => tile.url))
  const canSave = isSavable(currentUrl) && !savedAddresses.has(currentUrl)

  const open = (tile: DialpadTile): void => {
    try {
      onOpen(tile.url)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="shrink-0 border-b border-border-soft bg-surface-0/60 px-3 py-2" role="region" aria-label="Personal dialpad">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold tracking-[0.1em] text-faint">DIALPAD</span>
        <button
          type="button"
          disabled={busy || !canSave}
          className="inline-flex items-center gap-1 rounded-md border border-border-strong bg-surface-1/50 px-2 py-1 text-[10px] text-soft transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
          title={canSave ? 'Save the site in this tab to your dialpad' : 'Open a site first'}
          onClick={onSaveCurrent}
        >
          + Save this site
        </button>
      </div>
      {saved.length > 0 ? (
        <div className="mb-2">
          <p className="mb-1 text-[10px] text-faint">Your links</p>
          <div className="flex flex-wrap gap-1.5">
            {saved.map((tile) => (
              <span key={tile.id} className="group inline-flex items-center gap-1 rounded-md border border-border-strong bg-surface-1/50 pl-1.5 pr-1 text-xs">
                <button type="button" className="py-1 text-soft transition-colors hover:text-foreground" onClick={() => open(tile)}>
                  {tile.title}
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${tile.title} from the dialpad`}
                  className="rounded px-0.5 text-[11px] leading-none text-faint transition-colors hover:bg-border-soft hover:text-destructive"
                  onClick={() => onRemoveLink(tile.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-6" role="group" aria-label="Top sites">
        {sites.map((tile) => (
          <button
            key={tile.id}
            type="button"
            aria-label={tile.title}
            className="flex items-center gap-2 rounded-lg border border-border-soft bg-surface-1/40 px-2 py-1.5 text-left transition-colors hover:border-border-strong hover:bg-surface-1"
            title={tile.url}
            onClick={() => open(tile)}
          >
            <span aria-hidden="true" className={cn('grid size-6 shrink-0 place-items-center rounded-md text-[11px] font-bold', tileTint(tile.url))}>
              {tile.title.slice(0, 1).toUpperCase()}
            </span>
            <span className="truncate text-xs text-soft">{tile.title}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
