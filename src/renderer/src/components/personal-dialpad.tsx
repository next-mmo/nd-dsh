import type { ReactNode } from 'react'
import type { NdHomeLinkView } from '../../../shared/nd-invocations'
import { dialpadTiles, type DialpadTile } from '../../../shared/personal-dialpad'
import { cn } from '../lib/utils'

interface PersonalDialpadProps {
  links: NdHomeLinkView[]
  onOpen(url: string): void
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

/**
 * The Personal browser's new-tab page: ND's top sites plus the user's own links.
 *
 * It paints into the browser canvas while the active tab is blank and disappears
 * as soon as a site loads, so it needs no show/hide control of its own. Tiles are
 * the shared dialpad list, and everything here is Personal: saved links are
 * ND-managed personal records, never company or project memory.
 */
export function PersonalDialpad({ links, onOpen, onRemoveLink, onError }: PersonalDialpadProps): ReactNode {
  const tiles = dialpadTiles(links)

  const open = (tile: DialpadTile): void => {
    try {
      onOpen(tile.url)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="flex min-h-full w-full justify-center px-6 py-10" role="region" aria-label="Personal dialpad">
      {/* m-auto, not justify-center: when the tiles are taller than a short pane
          the margins collapse to zero and the first row stays reachable. */}
      <div className="m-auto flex w-full max-w-[640px] flex-col items-center gap-5">
        <h2 className="text-[15px] font-semibold text-strong">Dialpad</h2>
        <div className="flex flex-wrap justify-center gap-1" role="group" aria-label="Top sites">
          {tiles.map((tile) => (
            <div key={tile.id} className="group relative flex w-[96px] flex-col items-center">
              <button
                type="button"
                aria-label={tile.title}
                className="flex w-full flex-col items-center gap-2 rounded-xl px-2 py-3 text-left transition-colors hover:bg-accent"
                title={tile.url}
                onClick={() => open(tile)}
              >
                <span
                  aria-hidden="true"
                  className={cn('grid size-10 shrink-0 place-items-center rounded-full text-[15px] font-bold', tileTint(tile.url))}
                >
                  {tile.title.slice(0, 1).toUpperCase()}
                </span>
                <span className="w-full truncate text-center text-[11px] text-soft">{tile.title}</span>
              </button>
              {tile.kind === 'saved' ? (
                <button
                  type="button"
                  aria-label={`Remove ${tile.title} from the dialpad`}
                  title="Remove from the dialpad"
                  className="absolute right-1 top-1 hidden size-[18px] place-items-center rounded-full border border-border bg-surface-1 text-[11px] leading-none text-faint transition-colors hover:text-destructive group-hover:grid"
                  onClick={() => onRemoveLink(tile.id)}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <p className="text-[11px] text-faint">Star a site in the address bar to add it here.</p>
      </div>
    </div>
  )
}
