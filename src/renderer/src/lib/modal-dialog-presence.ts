import { useEffect, useState } from 'react'

const DIALOG_SELECTOR = '[data-slot="dialog-overlay"], [data-slot="dialog-content"]'

/**
 * Whether a Radix modal dialog is currently open. Radix portals dialogs to
 * document.body, so presence is tracked through DOM mutations instead of
 * threading React state through every dialog call site.
 */
export function useModalDialogOpen(): boolean {
  const [open, setOpen] = useState(() => !!document.querySelector(DIALOG_SELECTOR))

  useEffect(() => {
    const sync = (): void => setOpen(!!document.querySelector(DIALOG_SELECTOR))
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  return open
}
