import { createPortal } from 'react-dom'
import { CameraIcon, CrosshairIcon } from './Icons'
import { TitlebarIconButton } from './titlebar-icon-button'
import { useModalDialogOpen } from '../lib/modal-dialog-presence'

interface ModalInspectDockProps {
  hidden?: boolean
  pickDisabled?: boolean
  screenshotDisabled?: boolean
  onPickElement: () => void
  onScreenshot: () => void
}

// Radix modal dialogs dim and pointer-lock the whole window, which leaves the
// titlebar inspect controls dead while one is open (the overlay eats the click
// and dismisses the dialog instead). This dock portals above the dialog layer
// so element inspect and self screenshot can still be aimed at the dialog.
export function ModalInspectDock({
  hidden = false,
  pickDisabled = false,
  screenshotDisabled = false,
  onPickElement,
  onScreenshot,
}: ModalInspectDockProps) {
  const dialogOpen = useModalDialogOpen()

  if (hidden || !dialogOpen) return null
  const stopPointerDown = (event: { stopPropagation(): void }): void => event.stopPropagation()
  return createPortal(
    <div
      role="toolbar"
      aria-label="Inspect the open dialog"
      onPointerDown={stopPointerDown}
      className="pointer-events-auto fixed right-3 top-[46px] z-[300] flex items-center gap-1 rounded-md border border-border-strong bg-surface-1 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
    >
      <TitlebarIconButton
        title="Inspect an element in this app (Ctrl+Alt+E) — stays available while a dialog is open"
        disabled={pickDisabled}
        onClick={onPickElement}
      >
        <CrosshairIcon />
      </TitlebarIconButton>
      <TitlebarIconButton
        title="Screenshot this app including the open dialog (Ctrl+Alt+C)"
        disabled={screenshotDisabled}
        onClick={onScreenshot}
      >
        <CameraIcon />
      </TitlebarIconButton>
    </div>,
    document.body,
  )
}
