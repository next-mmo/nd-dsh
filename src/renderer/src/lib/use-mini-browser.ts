import { useEffect, useState } from 'react'

let miniBrowserActive = false
const listeners = new Set<(active: boolean) => void>()

export function setMiniBrowserActive(active: boolean): void {
  if (miniBrowserActive === active) return
  miniBrowserActive = active
  for (const listener of listeners) {
    listener(active)
  }
}

export function isMiniBrowserActive(): boolean {
  return miniBrowserActive
}

export function useMiniBrowserActive(): boolean {
  const [active, setActive] = useState(miniBrowserActive)
  useEffect(() => {
    listeners.add(setActive)
    return () => {
      listeners.delete(setActive)
    }
  }, [])
  return active
}
