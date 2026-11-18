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
  'border-primary/25 bg-gradient-to-b from-primary/20 to-primary/10 text-primary',
  'border-amber-500/25 bg-gradient-to-b from-amber-500/20 to-amber-500/10 text-amber-700 dark:text-amber-400',
  'border-sky-500/25 bg-gradient-to-b from-sky-500/20 to-sky-500/10 text-sky-700 dark:text-sky-400',
  'border-rose-500/25 bg-gradient-to-b from-rose-500/20 to-rose-500/10 text-rose-700 dark:text-rose-400',
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
                className="flex w-full flex-col items-center gap-2 rounded-2xl px-2 py-3 text-left transition-all duration-150 hover:bg-accent/70 active:scale-[0.97]"
                title={tile.url}
                onClick={() => open(tile)}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'grid size-12 shrink-0 place-items-center rounded-[14px] border text-[16px] font-bold shadow-[0_4px_12px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.22)] transition-transform duration-150 group-hover:-translate-y-0.5',
                    tileTint(tile.url),
                  )}
                >
                  {tile.title.slice(0, 1).toUpperCase()}
                </span>
                <span className="w-full truncate text-center text-[11px] font-medium text-soft">{tile.title}</span>
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
