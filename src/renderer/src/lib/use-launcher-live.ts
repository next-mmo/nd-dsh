import { useEffect, useState } from 'react'
import type { LauncherLiveState } from '../../../shared/launcher-live.js'

const LIVE_POLL_MS = 1_500

/**
 * Polls the launcher's live snapshot while the palette is open. The popup
 * window is hidden rather than destroyed, so a hidden surface skips requests
 * and refreshes immediately when it becomes visible again.
 */
export function useLauncherLive(active: boolean): LauncherLiveState | null {
  const [state, setState] = useState<LauncherLiveState | null>(null)

  useEffect(() => {
    if (!active) return
    let disposed = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const refresh = async (): Promise<void> => {
      if (disposed || inFlight) return
      inFlight = true
      try {
        const next = await window.ndDsh.launcher?.live()
        if (!disposed && next) setState(next)
      } catch {
        // Live listing is best effort; the registry still works without it.
      } finally {
        inFlight = false
      }
    }

    const tick = (): void => {
      if (document.visibilityState === 'visible') void refresh()
      if (!disposed) timer = setTimeout(tick, LIVE_POLL_MS)
    }

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }

    tick()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active])

  return state
}
