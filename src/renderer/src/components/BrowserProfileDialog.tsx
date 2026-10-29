import { useEffect, useState, type FormEvent } from 'react'
import { BROWSER_PROFILE_COLORS } from '../../../shared/browser-platform'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { cn } from '../lib/utils'

const COLOR_NAMES: Record<string, string> = {
  '#4f7cff': 'Blue',
  '#12a594': 'Teal',
  '#e5484d': 'Red',
  '#f5a623': 'Amber',
  '#8e4ec6': 'Purple',
  '#46a758': 'Green',
  '#e93d82': 'Pink',
  '#65717b': 'Slate',
}

interface BrowserProfileDialogProps {
  open: boolean
  mode: 'create' | 'edit'
  initialName?: string | undefined
  initialColor?: string | undefined
  onSubmit(input: { name: string; color: string }): Promise<void> | void
  onClose(): void
}

/** Shared create/rename surface for Chrome-style browser profiles. */
export function BrowserProfileDialog({
  open,
  mode,
  initialName,
  initialColor,
  onSubmit,
  onClose,
}: BrowserProfileDialogProps) {
  const [name, setName] = useState(initialName ?? '')
  const [color, setColor] = useState(initialColor ?? BROWSER_PROFILE_COLORS[0])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(initialName ?? '')
    setColor(initialColor ?? BROWSER_PROFILE_COLORS[0])
    setBusy(false)
  }, [open, initialName, initialColor])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const cleanName = name.trim()
    if (!cleanName || busy) return
    setBusy(true)
    try {
      await onSubmit({ name: cleanName, color })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="sm:max-w-[420px]">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{mode === 'create' ? 'New browser profile' : `Edit ${initialName ?? 'browser profile'}`}</DialogTitle>
            <DialogDescription>
              Each profile keeps its own cookies, site data, history, permissions and saved sign-ins.
            </DialogDescription>
          </DialogHeader>
          <div className="my-4 space-y-3">
            <label className="block space-y-1.5">
              <span className="text-[10px] font-semibold text-muted-foreground">Name</span>
              <input
                aria-label="Browser profile name"
                autoFocus
                maxLength={40}
                placeholder="Work, Personal, Client…"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[11px] text-foreground outline-none focus:border-(--border-focus)"
              />
            </label>
            <div className="space-y-1.5">
              <span className="block text-[10px] font-semibold text-muted-foreground">Color</span>
              <div role="group" aria-label="Profile color" className="flex flex-wrap items-center gap-1.5">
                {BROWSER_PROFILE_COLORS.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    aria-label={COLOR_NAMES[swatch] ?? swatch}
                    aria-pressed={color === swatch}
                    title={COLOR_NAMES[swatch] ?? swatch}
                    className={cn(
                      'grid size-[24px] place-items-center rounded-full outline-none transition-shadow',
                      'focus-visible:ring-2 focus-visible:ring-(--border-focus)',
                      color === swatch ? 'ring-2 ring-foreground/70 ring-offset-2 ring-offset-background' : 'hover:ring-2 hover:ring-border-strong hover:ring-offset-1',
                    )}
                    style={{ backgroundColor: swatch }}
                    onClick={() => setColor(swatch)}
                  >
                    {color === swatch ? <span className="size-[7px] rounded-full bg-white" /> : null}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <button
                type="button"
                className="shrink-0 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-[10px] text-soft transition-colors hover:bg-accent hover:text-foreground"
              >
                Cancel
              </button>
            </DialogClose>
            <button
              type="submit"
              disabled={!name.trim() || busy}
              className="shrink-0 rounded-md border border-primary/40 bg-primary px-2.5 py-1.5 text-[10px] font-semibold text-primary-foreground transition-opacity disabled:opacity-45"
            >
              {mode === 'create' ? 'Create profile' : 'Save'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
