import { useSyncExternalStore } from 'react'

/**
 * The still of the embedded page shown in the browser pane while a DOM
 * overlay forces the native view hidden. One shared browser view means one
 * shared frame; the pane that is the active surface paints it.
 */
let frame: string | null = null
const listeners = new Set<() => void>()

export function setBrowserFrozenFrame(next: string | null): void {
  if (frame === next) return
  frame = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useBrowserFrozenFrame(): string | null {
  return useSyncExternalStore(subscribe, () => frame, () => null)
}
